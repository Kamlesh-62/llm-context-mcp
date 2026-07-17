import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { findProjectRoot, nowIso } from "../runtime.js";
import { withStore } from "../storage.js";
import type { MemoryItem, Store } from "../types.js";

/**
 * Render project memory to a single self-contained HTML file and (optionally)
 * open it in the browser. Works for any backend — the store is loaded through
 * `withStore`, so json and sqlite render identically. This is the supported way
 * to *see* a sqlite store, which is otherwise an opaque binary file.
 *
 * The page has no external assets (inline CSS + JS, item data embedded as JSON),
 * so it works offline and can be shared as a plain file.
 */

/** HTML-escape text for safe interpolation into element content/attributes. */
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Serialize the item array for embedding in a `<script>` tag. `<` is escaped to
 * its unicode form so a `</script>` sequence inside any item's content cannot
 * break out of the tag. The client parses this back with JSON.parse and renders
 * every field via textContent, so no field is ever treated as HTML.
 */
function embedJson(items: MemoryItem[]): string {
  return JSON.stringify(items).replace(/</g, "\\u003c");
}

type ViewMeta = { projectRoot: string; backend: string; generatedAt: string };

export function renderHtml(store: Store, meta: ViewMeta): string {
  const items = [...store.items].sort((a, b) =>
    (b.updatedAt || "").localeCompare(a.updatedAt || ""),
  );
  const types = Array.from(new Set(items.map((i) => i.type))).sort();
  const typeOptions = types.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Memory — ${esc(path.basename(meta.projectRoot))}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background: #f6f7f9; color: #1a1a1a; }
  header { position: sticky; top: 0; z-index: 10; background: #fff; border-bottom: 1px solid #e2e4e8;
           padding: 12px 20px; }
  h1 { margin: 0 0 4px; font-size: 16px; }
  .meta { color: #6b7280; font-size: 12px; }
  .controls { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  input, select { padding: 6px 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px;
                  background: #fff; color: inherit; }
  input[type=search] { flex: 1; min-width: 180px; }
  main { padding: 16px 20px; max-width: 960px; margin: 0 auto; }
  .card { background: #fff; border: 1px solid #e2e4e8; border-radius: 8px; padding: 14px 16px;
          margin-bottom: 12px; }
  .card h2 { margin: 0 0 6px; font-size: 15px; }
  .badges { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; align-items: center; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #eef2ff; color: #3730a3; }
  .tag { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #f1f5f9; color: #475569; }
  .pin { background: #fef3c7; color: #92400e; }
  pre { margin: 0; white-space: pre-wrap; word-wrap: break-word; font: 12.5px/1.5 ui-monospace,
        SFMono-Regular, Menlo, monospace; background: #f8fafc; border: 1px solid #eef0f3;
        border-radius: 6px; padding: 10px; overflow-x: auto; }
  .dates { color: #9ca3af; font-size: 11px; margin-top: 8px; }
  .empty { color: #6b7280; text-align: center; padding: 40px; }
  #count { color: #6b7280; font-size: 12px; margin: 0 0 12px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1115; color: #e5e7eb; }
    header, .card { background: #171a21; border-color: #262a33; }
    .meta, .dates, #count, .empty { color: #9ca3af; }
    input, select { background: #0f1115; border-color: #303542; }
    .badge { background: #1e1b4b; color: #c7d2fe; }
    .tag { background: #1f2937; color: #cbd5e1; }
    .pin { background: #422006; color: #fde68a; }
    pre { background: #0f1115; border-color: #262a33; }
  }
</style>
</head>
<body>
<header>
  <h1>Project Memory</h1>
  <div class="meta">${esc(meta.projectRoot)} · backend: ${esc(meta.backend)} · ${items.length} item(s) · generated ${esc(meta.generatedAt)}</div>
  <div class="controls">
    <input id="q" type="search" placeholder="Search title, content, tags…" autocomplete="off">
    <select id="type"><option value="">All types</option>${typeOptions}</select>
  </div>
</header>
<main>
  <p id="count"></p>
  <div id="list"></div>
</main>
<script id="data" type="application/json">${embedJson(items)}</script>
<script>
  const ITEMS = JSON.parse(document.getElementById("data").textContent);
  const list = document.getElementById("list");
  const count = document.getElementById("count");
  const q = document.getElementById("q");
  const typeSel = document.getElementById("type");

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function render() {
    const term = q.value.trim().toLowerCase();
    const type = typeSel.value;
    list.textContent = "";
    let shown = 0;
    for (const it of ITEMS) {
      if (type && it.type !== type) continue;
      const hay = (it.title + " " + it.content + " " + (it.tags || []).join(" ")).toLowerCase();
      if (term && !hay.includes(term)) continue;
      shown++;

      const card = el("div", "card");
      card.appendChild(el("h2", null, it.title));

      const badges = el("div", "badges");
      badges.appendChild(el("span", "badge", it.type));
      if (it.pinned) badges.appendChild(el("span", "badge pin", "pinned"));
      for (const t of it.tags || []) badges.appendChild(el("span", "tag", t));
      card.appendChild(badges);

      card.appendChild(el("pre", null, it.content));

      const d = el("div", "dates",
        "created " + (it.createdAt || "?") + "  ·  updated " + (it.updatedAt || "?") +
        (it.source ? "  ·  " + it.source : "") +
        (it.author ? "  ·  " + it.author.name + (it.author.team ? " (" + it.author.team + ")" : "") : ""));
      card.appendChild(d);

      list.appendChild(card);
    }
    count.textContent = shown + " of " + ITEMS.length + " shown";
    if (shown === 0) list.appendChild(el("div", "empty", "No items match."));
  }

  q.addEventListener("input", render);
  typeSel.addEventListener("change", render);
  render();
</script>
</body>
</html>
`;
}

type ViewArgs = {
  projectRoot?: string;
  out?: string;
  open: boolean;
};

function parseArgs(argv: string[]): ViewArgs | { error: string } {
  const args: ViewArgs = { open: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--open") args.open = true;
    else if ((a === "--project" || a === "-p") && argv[i + 1]) args.projectRoot = argv[++i];
    else if (a === "--out" && argv[i + 1]) args.out = argv[++i];
    else return { error: `Unknown argument: ${a}` };
  }
  return args;
}

/** Open a file in the OS default app; best-effort, never throws. */
function openInBrowser(file: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [file], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignore — the file path is printed regardless
  }
}

export async function runView(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      [
        "Usage: context-bridge-mcp view [--project <dir>] [--out <file>] [--open]",
        "",
        "Render project memory (json or sqlite) to a self-contained HTML file.",
        "Default output: .ai/memory-view.html",
        "",
        "  --open   Open the generated file in your browser.",
        "  --out    Write to a specific path instead of the default.",
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

  let store: Store;
  let memoryFilePath: string;
  try {
    const result = await withStore(
      async () => false,
      parsed.projectRoot ? { projectRoot } : undefined,
    );
    store = result.store;
    memoryFilePath = result.memoryFilePath;
  } catch (err) {
    console.error(`Failed to read memory store: ${(err as Error).message}`);
    return 1;
  }

  const backend = memoryFilePath.endsWith(".sqlite") ? "sqlite" : "json";
  const html = renderHtml(store, { projectRoot, backend, generatedAt: nowIso() });

  const outPath = parsed.out
    ? path.resolve(projectRoot, parsed.out)
    : path.join(projectRoot, ".ai", "memory-view.html");
  await writeFile(outPath, html, "utf8");

  console.log(`Wrote ${store.items.length} item(s) to ${outPath}`);
  if (parsed.open) {
    openInBrowser(outPath);
    console.log("Opening in browser…");
  } else {
    console.log(`Open it with:\n  context-bridge-mcp view --open   (or open the file directly)`);
  }
  return 0;
}
