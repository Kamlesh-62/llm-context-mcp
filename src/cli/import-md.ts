import { readFile } from "node:fs/promises";
import path from "node:path";

import { newId, normalizeTags, validateType } from "../domain.js";
import { resolveAuthor } from "../identity.js";
import { findProjectRoot, nowIso } from "../runtime.js";
import { withStore } from "../storage.js";
import type { MemoryItem } from "../types.js";
import { classifyCandidate } from "../../hooks/dedup.js";

/**
 * Import a hand-written markdown memory file into the active store.
 *
 * The file format is a sequence of YAML-frontmatter blocks — a `---` fence
 * wrapping `key: value` lines, followed by a free-form markdown body — grouped
 * under `<!-- N. NAME -->` section banners. This is the shape produced by
 * earlier hand-curated `.ai/memory.md` files; nothing in this repo writes it,
 * so import is one-directional (md -> Store). Items land in whichever backend
 * is active (json or sqlite) because we go through `withStore`.
 */

/** One parsed markdown block, before it becomes a MemoryItem. */
export type ParsedItem = {
  type: string;
  title: string;
  content: string;
  tags: string[];
  created?: string;
  updated?: string;
  source?: string;
  /** The most recent `<!-- N. NAME -->` banner above this block, if any. */
  section?: string;
};

// A frontmatter key line: a single bare word, a colon, then the value.
// Body prose ("Member types (x):", "Backup table: y") never matches because
// the key token may not contain spaces.
const KEY_RE = /^([A-Za-z][\w-]*):\s*(.*)$/;
// Section banner: `<!-- 2. COMMISSION SYSTEM -->`.
const BANNER_RE = /^<!--\s*\d+\.\s*(.+?)\s*-->$/;

/**
 * Is line `idx` the opening `---` of a frontmatter fence? True only when the
 * next line is a frontmatter key — this is what distinguishes a real fence from
 * a bare `---` horizontal rule inside a markdown body (which is followed by
 * prose, a heading, or a table, never a `key:` line).
 */
function isFenceOpen(lines: string[], idx: number): boolean {
  return (
    lines[idx].trim() === "---" &&
    idx + 1 < lines.length &&
    KEY_RE.test(lines[idx + 1].trim())
  );
}

/** Parse `tags: [a, b, c]` (or `tags: a, b`) into a string array. */
function parseTagList(raw: string): string[] {
  return raw
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Split a markdown memory file into blocks. Robust against bare `---`
 * horizontal rules in item bodies (see {@link isFenceOpen}).
 */
export function parseMarkdownItems(text: string): ParsedItem[] {
  const lines = text.split(/\r?\n/);
  const items: ParsedItem[] = [];
  let section: string | undefined;
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    const banner = BANNER_RE.exec(trimmed);
    if (banner) {
      section = banner[1].trim();
      i++;
      continue;
    }

    if (!isFenceOpen(lines, i)) {
      i++;
      continue;
    }

    // Collect frontmatter key/value lines until the closing `---`.
    const fm: Record<string, string> = {};
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== "---") {
      const m = KEY_RE.exec(lines[j].trim());
      if (m) fm[m[1].toLowerCase()] = m[2].trim();
      j++;
    }
    if (j >= lines.length) {
      // No closing fence — malformed; treat the opening `---` as body and move on.
      i++;
      continue;
    }

    // Body runs from after the closing fence to the next fence, banner, or any
    // HTML-comment divider (`<!-- ==== -->` bars separate sections and are not
    // content in this format).
    const bodyStart = j + 1;
    let k = bodyStart;
    while (k < lines.length && !isFenceOpen(lines, k) && !lines[k].trim().startsWith("<!--")) {
      k++;
    }
    const content = lines.slice(bodyStart, k).join("\n").trim();

    items.push({
      type: fm.type ?? "note",
      title: fm.title ?? "",
      content,
      tags: fm.tags ? parseTagList(fm.tags) : [],
      created: fm.created,
      updated: fm.updated,
      source: fm.source,
      section,
    });
    i = k;
  }

  return items;
}

/** Slugify a section banner into a tag (e.g. "COMMISSION SYSTEM" -> "commission-system"). */
function sectionTag(section: string): string {
  return section
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Turn a parsed block into a MemoryItem (id regenerated, dates mapped). */
function toMemoryItem(
  parsed: ParsedItem,
  opts: { tagSections: boolean; source?: string; projectRoot: string },
): MemoryItem {
  const now = nowIso();
  const rawTags = [...parsed.tags];
  if (opts.tagSections && parsed.section) rawTags.push(sectionTag(parsed.section));

  const author = resolveAuthor(opts.projectRoot);
  const item: MemoryItem = {
    id: newId("mem"),
    type: validateType(parsed.type),
    title: parsed.title.trim(),
    content: parsed.content.trim(),
    tags: normalizeTags(rawTags),
    source: opts.source ?? parsed.source ?? "md-import",
    createdAt: parsed.created || now,
    updatedAt: parsed.updated || parsed.created || now,
    lastUsedAt: now,
    ...(author ? { author } : {}),
  };
  return item;
}

type ImportArgs = {
  file: string;
  projectRoot?: string;
  dryRun: boolean;
  tagSections: boolean;
  source?: string;
};

function parseArgs(argv: string[]): ImportArgs | { error: string } {
  const args: ImportArgs = { file: "", dryRun: false, tagSections: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--tag-sections") args.tagSections = true;
    else if ((a === "--project" || a === "-p") && argv[i + 1]) args.projectRoot = argv[++i];
    else if (a === "--source" && argv[i + 1]) args.source = argv[++i];
    else if (a.startsWith("-")) return { error: `Unknown flag: ${a}` };
    else if (!args.file) args.file = a;
    else return { error: `Unexpected argument: ${a}` };
  }
  if (!args.file) return { error: "Missing <file.md>. Example: import .ai/memory.md" };
  return args;
}

export async function runImport(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      [
        "Usage: context-bridge-mcp import <file.md> [--project <dir>] [--dry-run] [--tag-sections] [--source <s>]",
        "",
        "Import a YAML-frontmatter markdown memory file into the active store",
        "(json or sqlite). Re-running is safe — near-duplicate titles are skipped.",
        "",
        "  --dry-run        Parse and print what would be imported; write nothing.",
        "  --tag-sections   Add each block's `<!-- N. NAME -->` banner as a tag.",
        "  --source <s>     Override the `source` field on imported items.",
      ].join("\n"),
    );
    return 0;
  }

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 1;
  }

  const projectRoot = parsed.projectRoot || (await findProjectRoot());
  const filePath = path.resolve(projectRoot, parsed.file);

  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    console.error(`Failed to read ${filePath}: ${(err as Error).message}`);
    return 1;
  }

  const blocks = parseMarkdownItems(text).filter((b) => b.title && b.content);
  if (blocks.length === 0) {
    console.log(`No memory blocks found in ${filePath}. Nothing to import.`);
    return 0;
  }

  console.log(`\nImporting from ${filePath}`);
  console.log(`Project: ${projectRoot}`);
  console.log(`Parsed:  ${blocks.length} block(s)`);
  if (parsed.dryRun) console.log("Mode:    dry-run (no changes written)\n");
  else console.log("");

  let added = 0;
  let updated = 0;
  let skipped = 0;

  await withStore(async (st) => {
    for (const block of blocks) {
      const candidate = { title: block.title.trim(), type: validateType(block.type) };
      const decision = classifyCandidate(
        st.items.map((it) => ({ title: it.title, type: it.type })),
        candidate,
      );

      if (decision.action === "skip") {
        skipped++;
        continue;
      }

      const item = toMemoryItem(block, {
        tagSections: parsed.tagSections,
        source: parsed.source,
        projectRoot,
      });

      if (decision.action === "update") {
        const existing = st.items[decision.index];
        if (!parsed.dryRun) {
          existing.content = item.content;
          existing.tags = normalizeTags([...existing.tags, ...item.tags]);
          existing.updatedAt = nowIso();
        }
        updated++;
      } else {
        if (!parsed.dryRun) st.items.push(item);
        added++;
      }
    }
    // Commit only when something changed and this is not a dry run.
    return !parsed.dryRun && added + updated > 0;
  }, parsed.projectRoot ? { projectRoot } : undefined);

  const verb = parsed.dryRun ? "Would import" : "Imported";
  console.log(`${verb} ${added} new, updated ${updated}, skipped ${skipped} (duplicate title).`);
  if (!parsed.dryRun && added + updated > 0) {
    console.log(`\nInspect the result, then move to SQLite with:\n  context-bridge-mcp migrate --to sqlite --set-default`);
  }
  return 0;
}
