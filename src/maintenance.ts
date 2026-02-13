import fs from "node:fs/promises";
import path from "node:path";

import { CONFIG } from "./config.js";
import { newId, safeSnippet } from "./domain.js";
import { log } from "./logger.js";
import { nowIso } from "./runtime.js";
import type { ArchiveStore, Store, StoreContext, MemoryItem } from "./types.js";

type CompactOptions = {
  maxItems?: number;
  archivePath?: string;
  summaryTitle?: string;
  summaryTags?: string[];
  summaryMaxEntries?: number;
  reason?: "auto" | "manual";
};

function resolveArchivePath(projectRoot: string, archivePath?: string): string {
  if (!archivePath || !archivePath.trim()) {
    archivePath = CONFIG.autoCompact?.archiveRelPath || ".ai/memory-archive.json";
  }
  return path.isAbsolute(archivePath)
    ? archivePath
    : path.join(projectRoot, archivePath);
}

async function ensureDirForFile(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function atomicWriteJson(filePath: string, obj: ArchiveStore): Promise<void> {
  await ensureDirForFile(filePath);
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

async function readArchiveFile(filePath: string, projectRoot: string): Promise<ArchiveStore> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as ArchiveStore;
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.items)) {
      return parsed;
    }
  } catch {
    // ignore
  }

  return {
    version: 1,
    projectRoot,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    items: [],
    revision: 0,
  };
}

function sortKey(item: MemoryItem): number {
  const candidate = item.lastUsedAt || item.updatedAt || item.createdAt;
  const t = Date.parse(candidate || "");
  return Number.isFinite(t) ? t : 0;
}

function relativeArchiveLabel(projectRoot: string, archivePath: string): string {
  try {
    const rel = path.relative(projectRoot, archivePath);
    return rel.startsWith("..") ? archivePath : rel || archivePath;
  } catch {
    return archivePath;
  }
}

export async function compactStoreInPlace(
  store: Store,
  ctx: StoreContext,
  options: CompactOptions = {},
): Promise<{ archived: number; archivePath?: string; summaryItemId?: string }> {
  const { projectRoot } = ctx;
  const cfg = CONFIG.autoCompact;
  const now = nowIso();

  const maxItems = Math.max(
    options.maxItems ?? cfg.maxItems ?? 0,
    0,
  );

  if (!maxItems) {
    return { archived: 0 };
  }

  const summaryTitle =
    options.summaryTitle ?? cfg.summaryTitle ?? "Archived context";
  const summaryTagsRaw = options.summaryTags ?? (cfg.summaryTag ? [cfg.summaryTag] : []);
  const summaryTags = Array.isArray(summaryTagsRaw)
    ? summaryTagsRaw.filter((t) => typeof t === "string" && t.trim())
    : [String(summaryTagsRaw)];
  const summaryMaxEntries = Math.max(
    options.summaryMaxEntries ?? cfg.summaryMaxEntries ?? 10,
    1,
  );
  const archivePath = resolveArchivePath(
    projectRoot,
    options.archivePath,
  );
  const reason = options.reason || "manual";
  const includeSummary = Boolean(summaryTitle);
  const reserveForSummary = includeSummary ? 1 : 0;
  const targetCount = Math.max(maxItems - reserveForSummary, 0);

  if (store.items.length <= targetCount) {
    return { archived: 0 };
  }

  const overflow = store.items.length - targetCount;
  const sortedByAge = [...store.items].sort(
    (a, b) => sortKey(a) - sortKey(b),
  );
  const itemsToArchive = sortedByAge.slice(0, overflow);
  const removalSet = new Set(itemsToArchive.map((it) => it.id));
  const survivors = store.items.filter((it) => !removalSet.has(it.id));

  store.items.length = 0;
  store.items.push(...survivors);

  const archive = await readArchiveFile(archivePath, projectRoot);
  archive.items.push(
    ...itemsToArchive.map((it) => ({
      ...it,
      archivedAt: now,
      archivedReason: reason,
    })),
  );
  archive.updatedAt = now;
  archive.revision = (archive.revision || 0) + 1;
  await atomicWriteJson(archivePath, archive);

  let summaryItemId = "";
  if (includeSummary) {
    const bulletSource = itemsToArchive.slice(-summaryMaxEntries);
    const bulletLines = bulletSource
      .map((it) => {
        const snippet = safeSnippet(it.content, 160) || "(no content)";
        const title = it.title || "(untitled)";
        return `- (${it.type || "note"}) ${title}: ${snippet}`;
      })
      .join("\n");
    const remaining = itemsToArchive.length - bulletSource.length;
    const moreLine = remaining > 0 ? `\n... (+${remaining} more)` : "";
    const archiveLabel = relativeArchiveLabel(projectRoot, archivePath);
    const summaryContent =
      `Archived ${itemsToArchive.length} older item(s) into ${archiveLabel} on ${now}.\n\n` +
      bulletLines +
      moreLine;

    const summaryItem: MemoryItem = {
      id: newId("mem"),
      type: "note",
      title: summaryTitle,
      content: summaryContent,
      tags: summaryTags,
      pinned: false,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
      source: reason === "auto" ? "auto-compact" : "compact",
    };
    summaryItemId = summaryItem.id;
    store.items.push(summaryItem);
  }

  log(
    `compacted ${itemsToArchive.length} item(s); archive: ${relativeArchiveLabel(
      projectRoot,
      archivePath,
    )}`,
  );

  return {
    archived: itemsToArchive.length,
    archivePath,
    summaryItemId,
  };
}

export async function autoCompactStore(
  store: Store,
  ctx: StoreContext,
): Promise<{ archived: number; archivePath?: string; summaryItemId?: string }> {
  const cfg = CONFIG.autoCompact;
  if (!cfg.enabled) return { archived: 0 };
  if (!cfg.maxItems || store.items.length <= cfg.maxItems) {
    return { archived: 0 };
  }
  return compactStoreInPlace(store, ctx, {
    maxItems: cfg.maxItems,
    archivePath: cfg.archiveRelPath,
    summaryTitle: cfg.summaryTitle,
    summaryTags: cfg.summaryTag ? [cfg.summaryTag] : [],
    summaryMaxEntries: cfg.summaryMaxEntries,
    reason: "auto",
  });
}
