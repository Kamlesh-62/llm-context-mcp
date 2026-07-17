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
  const domains = Array.from(new Set(items.map((i) => i.domain).filter(Boolean))).sort();
  const domainOptions = domains
    .map((d) => `<option value="${esc(d)}">${esc(d)}</option>`)
    .join("");

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
  .dom { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #dcfce7; color: #166534; font-weight: 600; }
  .tag { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #f1f5f9; color: #475569; }
  .pin { background: #fef3c7; color: #92400e; }
  .toggle { display: inline-flex; border: 1px solid #d1d5db; border-radius: 6px; overflow: hidden; }
  .toggle button { border: 0; background: #fff; color: inherit; padding: 6px 12px; cursor: pointer; font: inherit; }
  .toggle button.active { background: #4f46e5; color: #fff; }
  #graph { display: none; }
  #graph.show { display: block; }
  #list.hide { display: none; }
  svg { width: 100%; height: 70vh; background: #fff; border: 1px solid #e2e4e8; border-radius: 8px; }
  svg text { font: 11px -apple-system, sans-serif; }
  .hub-label { font-weight: 700; font-size: 12px; }
  svg .node { cursor: pointer; }
  svg .edge { stroke: #cbd5e1; stroke-width: 1; }
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
    input, select, .toggle button { background: #0f1115; border-color: #303542; }
    .badge { background: #1e1b4b; color: #c7d2fe; }
    .dom { background: #052e16; color: #86efac; }
    .tag { background: #1f2937; color: #cbd5e1; }
    .pin { background: #422006; color: #fde68a; }
    .toggle { border-color: #303542; }
    .toggle button.active { background: #4f46e5; color: #fff; }
    pre { background: #0f1115; border-color: #262a33; }
    svg { background: #0f1115; border-color: #262a33; }
    svg text { fill: #cbd5e1; }
    svg .edge { stroke: #334155; }
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
    <select id="domain"><option value="">All domains</option>${domainOptions}</select>
    <span class="toggle">
      <button id="btnList" class="active" type="button">List</button>
      <button id="btnGraph" type="button">Graph</button>
    </span>
  </div>
</header>
<main>
  <p id="count"></p>
  <div id="list"></div>
  <div id="graph"><svg id="svg" viewBox="0 0 1000 700" preserveAspectRatio="xMidYMid meet"></svg></div>
</main>
<script id="data" type="application/json">${embedJson(items)}</script>
<script>
  const ITEMS = JSON.parse(document.getElementById("data").textContent);
  const SVGNS = "http://www.w3.org/2000/svg";
  const list = document.getElementById("list");
  const graph = document.getElementById("graph");
  const svg = document.getElementById("svg");
  const count = document.getElementById("count");
  const q = document.getElementById("q");
  const typeSel = document.getElementById("type");
  const domainSel = document.getElementById("domain");
  const btnList = document.getElementById("btnList");
  const btnGraph = document.getElementById("btnGraph");
  let mode = "list";

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function svgEl(tag, attrs, text) {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  }
  // Stable color per type (no randomness → same layout every render).
  function typeColor(t) {
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 360;
    return "hsl(" + h + ",55%,55%)";
  }

  function filtered() {
    const term = q.value.trim().toLowerCase();
    const type = typeSel.value;
    const dom = domainSel.value;
    return ITEMS.filter((it) => {
      if (type && it.type !== type) return false;
      if (dom && (it.domain || "") !== dom) return false;
      if (term) {
        const hay = (it.title + " " + it.content + " " + (it.tags || []).join(" ") + " " + (it.domain || "")).toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }

  function renderList(items) {
    list.textContent = "";
    for (const it of items) {
      const card = el("div", "card");
      card.appendChild(el("h2", null, it.title));
      const badges = el("div", "badges");
      badges.appendChild(el("span", "badge", it.type));
      if (it.domain) badges.appendChild(el("span", "dom", it.domain));
      if (it.pinned) badges.appendChild(el("span", "badge pin", "pinned"));
      for (const t of it.tags || []) badges.appendChild(el("span", "tag", t));
      card.appendChild(badges);
      card.appendChild(el("pre", null, it.content));
      card.appendChild(el("div", "dates",
        "created " + (it.createdAt || "?") + "  ·  updated " + (it.updatedAt || "?") +
        (it.source ? "  ·  " + it.source : "") +
        (it.author ? "  ·  " + it.author.name + (it.author.team ? " (" + it.author.team + ")" : "") : "")));
      list.appendChild(card);
    }
    if (items.length === 0) list.appendChild(el("div", "empty", "No items match."));
  }

  // Cluster graph: one hub per domain, items as satellites linked to their hub.
  // A true item-to-item edge graph arrives with the links[] model (Phase 3).
  function renderGraph(items) {
    svg.textContent = "";
    const W = 1000, H = 700, cx = W / 2, cy = H / 2;
    const groups = {};
    for (const it of items) (groups[it.domain || "(no domain)"] = groups[it.domain || "(no domain)"] || []).push(it);
    const names = Object.keys(groups).sort();
    const D = names.length || 1;
    const hubR = Math.min(W, H) * 0.32;

    const edges = svgEl("g", {});
    const nodes = svgEl("g", {});
    svg.appendChild(edges);
    svg.appendChild(nodes);

    names.forEach((name, gi) => {
      const ha = (2 * Math.PI * gi) / D - Math.PI / 2;
      const hx = D === 1 ? cx : cx + hubR * Math.cos(ha);
      const hy = D === 1 ? cy : cy + hubR * Math.sin(ha);
      const members = groups[name];

      // hub
      nodes.appendChild(svgEl("circle", { cx: hx, cy: hy, r: 7, fill: "#4f46e5", class: "node" }));
      const label = svgEl("text", { x: hx, y: hy - 12, "text-anchor": "middle", class: "hub-label" }, name + " (" + members.length + ")");
      nodes.appendChild(label);

      const n = members.length;
      const satR = Math.max(38, Math.min(120, 12 * Math.sqrt(n) + 26));
      members.forEach((it, j) => {
        const a = (2 * Math.PI * j) / Math.max(n, 1) - Math.PI / 2;
        const x = hx + satR * Math.cos(a);
        const y = hy + satR * Math.sin(a);
        edges.appendChild(svgEl("line", { x1: hx, y1: hy, x2: x, y2: y, class: "edge" }));
        const dot = svgEl("circle", { cx: x, cy: y, r: it.pinned ? 6 : 4.5, fill: typeColor(it.type), class: "node" });
        dot.appendChild(svgEl("title", {}, it.title + "  [" + it.type + "]"));
        dot.addEventListener("click", () => { q.value = it.title; setMode("list"); render(); });
        nodes.appendChild(dot);
      });
    });
  }

  function setMode(m) {
    mode = m;
    btnList.classList.toggle("active", m === "list");
    btnGraph.classList.toggle("active", m === "graph");
    graph.classList.toggle("show", m === "graph");
    list.classList.toggle("hide", m === "graph");
  }

  function render() {
    const items = filtered();
    count.textContent = items.length + " of " + ITEMS.length + " shown";
    if (mode === "graph") renderGraph(items);
    else renderList(items);
  }

  q.addEventListener("input", render);
  typeSel.addEventListener("change", render);
  domainSel.addEventListener("change", render);
  btnList.addEventListener("click", () => { setMode("list"); render(); });
  btnGraph.addEventListener("click", () => { setMode("graph"); render(); });
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
