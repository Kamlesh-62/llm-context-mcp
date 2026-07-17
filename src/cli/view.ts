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
  /* Graph canvas is a fixed ink console regardless of page theme — a memory
     "observatory": faint graph-paper dots + a soft indigo aurora up top. */
  .canvas {
    background:
      radial-gradient(1100px 520px at 50% -12%, rgba(99,110,240,0.12), transparent 62%),
      #0b0e14;
    background-image:
      radial-gradient(rgba(150,170,220,0.06) 1px, transparent 1.4px);
    background-size: 24px 24px;
    border: 1px solid #1c2438;
    border-radius: 16px;
    padding: 4px;
    overflow: hidden;
  }
  svg#svg { width: 100%; height: auto; display: block; }
  svg text { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; fill: #aeb8ca; }
  .cell-frame { fill: rgba(148,163,214,0.022); stroke: #212a41; stroke-width: 1; }
  .cell-title { fill: #d4dcec; font-size: 12.5px; font-weight: 600; letter-spacing: 0.16em; }
  .cell-count { fill: #61708f; font-size: 10.5px; letter-spacing: 0.08em; }
  .hub { fill: #5b6bf0; }
  .hub-ring { fill: none; stroke: #5b6bf0; stroke-width: 1; opacity: 0.35; }
  .hub-glow { fill: #5b6bf0; opacity: 0.13; }
  .spoke { stroke: rgba(160,175,220,0.08); stroke-width: 1; }
  .node { cursor: pointer; stroke: #0b0e14; stroke-width: 1.5; transition: stroke 0.1s; }
  .node:hover { stroke: #ffffff; }
  .link { stroke: #7c83ff; stroke-width: 1.6; opacity: 0.85; }
  .link-sup { stroke: #f2635e; stroke-width: 1.6; stroke-dasharray: 5 4; opacity: 0.85; }
  .stale { opacity: 0.26; }
  .legend {
    display: flex; flex-wrap: wrap; gap: 9px 16px; align-items: center; margin: 14px 4px 2px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
    letter-spacing: 0.04em; color: #7f8ca6;
  }
  .legend .sw { display: inline-flex; align-items: center; gap: 7px; }
  .legend .swatch { width: 9px; height: 9px; border-radius: 50%; }
  .legend .rule { width: 20px; border-top: 2px solid #7c83ff; }
  .legend .rule.sup { border-top-style: dashed; border-top-color: #f2635e; }
  .legend .sep { width: 1px; height: 12px; background: #2a3348; }
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
  <div id="graph">
    <div class="canvas"><svg id="svg" viewBox="0 0 1000 700" preserveAspectRatio="xMidYMid meet"></svg></div>
    <div class="legend" id="legend"></div>
  </div>
</main>
<script id="data" type="application/json">${embedJson(items)}</script>
<script>
  const ITEMS = JSON.parse(document.getElementById("data").textContent);
  const SVGNS = "http://www.w3.org/2000/svg";
  const TITLE_BY_ID = {};
  ITEMS.forEach((i) => { TITLE_BY_ID[i.id] = i.title; });
  const STALE = new Set();
  ITEMS.forEach((i) => (i.links || []).forEach((l) => { if (l.rel === "supersedes") STALE.add(l.to); }));
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
  // Deliberate hue per memory type — color IS the signal (see the legend).
  const TYPE_COLORS = {
    decision: "#f5b454", constraint: "#f2635e", architecture: "#8b7cf6",
    fact: "#4fc3d9", glossary: "#5bc49a", todo: "#f08a4b", note: "#8c9aae",
  };
  const TYPE_ORDER = ["decision", "constraint", "architecture", "fact", "glossary", "todo", "note"];
  function typeColor(t) { return TYPE_COLORS[t] || "#8c9aae"; }

  // Legend maps each present type to its color, plus the two edge styles.
  function buildLegend() {
    const legend = document.getElementById("legend");
    legend.textContent = "";
    const present = new Set(ITEMS.map((i) => i.type));
    const types = TYPE_ORDER.filter((t) => present.has(t));
    for (const t of present) if (!TYPE_ORDER.includes(t)) types.push(t);
    for (const t of types) {
      const sw = el("span", "sw");
      const dot = el("span", "swatch");
      dot.style.background = typeColor(t);
      sw.appendChild(dot);
      sw.appendChild(document.createTextNode(t));
      legend.appendChild(sw);
    }
    legend.appendChild(el("span", "sep"));
    const link = el("span", "sw"); link.appendChild(el("span", "rule")); link.appendChild(document.createTextNode("link"));
    const sup = el("span", "sw"); const r = el("span", "rule"); r.classList.add("sup"); sup.appendChild(r); sup.appendChild(document.createTextNode("supersedes"));
    legend.appendChild(link);
    legend.appendChild(sup);
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
      if (STALE.has(it.id)) badges.appendChild(el("span", "badge pin", "superseded"));
      for (const t of it.tags || []) badges.appendChild(el("span", "tag", t));
      card.appendChild(badges);
      card.appendChild(el("pre", null, it.content));
      if (it.links && it.links.length) {
        card.appendChild(el("div", "dates",
          "links: " + it.links.map((l) => l.rel + " → " + (TITLE_BY_ID[l.to] || l.to)).join("  ·  ")));
      }
      card.appendChild(el("div", "dates",
        "created " + (it.createdAt || "?") + "  ·  updated " + (it.updatedAt || "?") +
        (it.source ? "  ·  " + it.source : "") +
        (it.author ? "  ·  " + it.author.name + (it.author.team ? " (" + it.author.team + ")" : "") : "")));
      list.appendChild(card);
    }
    if (items.length === 0) list.appendChild(el("div", "empty", "No items match."));
  }

  // Constellation graph: each domain is a framed cell (label in a header chip,
  // never on the nodes), items orbit a glowing hub in concentric rings, and
  // typed item-to-item links are drawn in one overlay so they can cross cells.
  function renderGraph(items) {
    svg.textContent = "";
    const shown = new Set(items.map((it) => it.id));
    const stale = new Set();
    for (const it of items) for (const l of it.links || []) if (l.rel === "supersedes") stale.add(l.to);

    const groups = {};
    for (const it of items) (groups[it.domain || "(no domain)"] = groups[it.domain || "(no domain)"] || []).push(it);
    // Largest domains first so the eye lands on the dense clusters.
    const names = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length || a.localeCompare(b));

    // Grid of cells sized to the number of domains; canvas height grows by rows.
    const cols = names.length <= 1 ? 1 : names.length <= 4 ? 2 : 3;
    const rows = Math.ceil(names.length / cols);
    const W = 1000, cellW = W / cols, cellH = 300, pad = 14, headerH = 52;
    const H = rows * cellH;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);

    const frames = svgEl("g", {});
    const spokes = svgEl("g", {});
    const linkG = svgEl("g", {});
    const nodes = svgEl("g", {});
    svg.appendChild(frames);
    svg.appendChild(spokes);
    svg.appendChild(linkG);
    svg.appendChild(nodes);

    const pos = {}; // id -> {x,y}

    names.forEach((name, gi) => {
      const col = gi % cols, row = Math.floor(gi / cols);
      const x0 = col * cellW + pad, y0 = row * cellH + pad;
      const w = cellW - 2 * pad, h = cellH - 2 * pad;
      const members = groups[name];
      const n = members.length;

      frames.appendChild(svgEl("rect", { x: x0, y: y0, width: w, height: h, rx: 13, class: "cell-frame" }));
      frames.appendChild(svgEl("text", { x: x0 + 18, y: y0 + 28, class: "cell-title" }, name.toUpperCase()));
      frames.appendChild(svgEl("text", { x: x0 + 18, y: y0 + 44, class: "cell-count" }, n + (n === 1 ? " ITEM" : " ITEMS")));

      const cx = x0 + w / 2, cy = y0 + headerH + (h - headerH) / 2;
      nodes.appendChild(svgEl("circle", { cx: cx, cy: cy, r: 20, class: "hub-glow" }));
      nodes.appendChild(svgEl("circle", { cx: cx, cy: cy, r: 12, class: "hub-ring" }));
      nodes.appendChild(svgEl("circle", { cx: cx, cy: cy, r: 5, class: "hub" }));

      // Concentric rings so dense domains stay legible (no cramped pinwheel).
      const maxR = Math.min(w, h - headerH) / 2 - 16;
      const perRing = 11;
      const rings = Math.ceil(n / perRing);
      members.forEach((it, j) => {
        const ring = Math.floor(j / perRing);
        const inRing = Math.min(perRing, n - ring * perRing);
        const k = j % perRing;
        const rr = rings === 1 ? maxR * 0.86 : maxR * (0.46 + 0.54 * ((ring + 1) / rings));
        const a = (2 * Math.PI * k) / Math.max(inRing, 1) - Math.PI / 2 + ring * 0.42;
        const x = cx + rr * Math.cos(a), y = cy + rr * Math.sin(a);
        pos[it.id] = { x: x, y: y };
        spokes.appendChild(svgEl("line", { x1: cx, y1: cy, x2: x, y2: y, class: "spoke" }));
        const cls = "node" + (stale.has(it.id) ? " stale" : "");
        const dot = svgEl("circle", { cx: x, cy: y, r: it.pinned ? 6.5 : 5, fill: typeColor(it.type), class: cls });
        dot.appendChild(svgEl("title", {}, it.title + "  [" + it.type + "]" + (stale.has(it.id) ? "  (superseded)" : "")));
        dot.addEventListener("click", () => { q.value = it.title; setMode("list"); render(); });
        nodes.appendChild(dot);
      });
    });

    // Typed item-to-item links (one overlay, so cross-cell edges still draw).
    for (const it of items) {
      const p = pos[it.id];
      if (!p) continue;
      for (const l of it.links || []) {
        const target = pos[l.to];
        if (!target || !shown.has(l.to)) continue;
        const line = svgEl("line", {
          x1: p.x, y1: p.y, x2: target.x, y2: target.y,
          class: l.rel === "supersedes" ? "link-sup" : "link",
        });
        line.appendChild(svgEl("title", {}, it.title + " —[" + l.rel + "]→ " + l.to));
        linkG.appendChild(line);
      }
    }
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
  buildLegend();
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
