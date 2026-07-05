import { CM, _togglePopover, cmEditor, currentProject, escapeAttr, escapeHtml, switchProject } from "editor";

// static/panels.js — TexLocal Phase 2 module split (v5.0.0-beta.2.0)
// Lifted verbatim from editor.js (CM-light cluster). Interim shared-scope:
// a classic <script defer>, NOT an ES module — shares editor.js's global
// scope (module-level state + the global CM adapter facade). Loads AFTER
// editor.js and BEFORE boot.js. CM6 note: touches CodeMirror only via CM.*

// ── SYMBOL PANEL ──────────────────────────────────────────────
const SYMBOL_CATEGORIES = [
  { name: "Greek α–ω", syms: [
    ["α","\\alpha"],["β","\\beta"],["γ","\\gamma"],["δ","\\delta"],
    ["ε","\\varepsilon"],["ζ","\\zeta"],["η","\\eta"],["θ","\\theta"],
    ["ι","\\iota"],["κ","\\kappa"],["λ","\\lambda"],["μ","\\mu"],
    ["ν","\\nu"],["ξ","\\xi"],["π","\\pi"],["ρ","\\rho"],
    ["σ","\\sigma"],["τ","\\tau"],["υ","\\upsilon"],["φ","\\varphi"],
    ["χ","\\chi"],["ψ","\\psi"],["ω","\\omega"],
  ]},
  { name: "Greek Γ–Ω", syms: [
    ["Γ","\\Gamma"],["Δ","\\Delta"],["Θ","\\Theta"],["Λ","\\Lambda"],
    ["Ξ","\\Xi"],["Π","\\Pi"],["Σ","\\Sigma"],["Υ","\\Upsilon"],
    ["Φ","\\Phi"],["Ψ","\\Psi"],["Ω","\\Omega"],
  ]},
  { name: "Operators", syms: [
    ["±","\\pm"],["∓","\\mp"],["×","\\times"],["÷","\\div"],
    ["·","\\cdot"],["∘","\\circ"],["∑","\\sum"],["∏","\\prod"],
    ["∫","\\int"],["∮","\\oint"],["√","\\sqrt{}"],["∂","\\partial"],
    ["∇","\\nabla"],["∞","\\infty"],["ℏ","\\hbar"],["ℓ","\\ell"],
  ]},
  { name: "Relations", syms: [
    ["≤","\\leq"],["≥","\\geq"],["≠","\\neq"],["≈","\\approx"],
    ["≡","\\equiv"],["∼","\\sim"],["≃","\\simeq"],["≅","\\cong"],
    ["∈","\\in"],["∉","\\notin"],["⊂","\\subset"],["⊃","\\supset"],
    ["⊆","\\subseteq"],["⊇","\\supseteq"],
    ["∀","\\forall"],["∃","\\exists"],
    ["∪","\\cup"],["∩","\\cap"],["∅","\\emptyset"],
  ]},
  { name: "Arrows", syms: [
    ["→","\\to"],["←","\\leftarrow"],["↔","\\leftrightarrow"],
    ["⇒","\\Rightarrow"],["⇐","\\Leftarrow"],["⇔","\\Leftrightarrow"],
    ["↦","\\mapsto"],["↑","\\uparrow"],["↓","\\downarrow"],
    ["↗","\\nearrow"],["↘","\\searrow"],["↙","\\swarrow"],["↖","\\nwarrow"],
    ["⇑","\\Uparrow"],["⇓","\\Downarrow"],["↕","\\updownarrow"],
  ]},
  { name: "Brackets", syms: [
    ["⌈","\\lceil"],["⌉","\\rceil"],["⌊","\\lfloor"],["⌋","\\rfloor"],
    ["〈","\\langle"],["〉","\\rangle"],
    ["|","\\|"],["‖","\\Vert"],
    ["(","\\left("],[")",  "\\right)"],
    ["{","\\{"],["}", "\\}"],
  ]},
  { name: "Misc", syms: [
    ["…","\\ldots"],["⋯","\\cdots"],["⋮","\\vdots"],["⋱","\\ddots"],
    ["ℜ","\\Re"],["ℑ","\\Im"],
    ["†","\\dagger"],["‡","\\ddagger"],
    ["§","\\S"],["¶","\\P"],["©","\\copyright"],
    ["°","^{\\circ}"],["′","^{\\prime}"],["″","^{\\prime\\prime}"],
    ["½","\\frac{1}{2}"],["⅓","\\frac{1}{3}"],
  ]},
];

let symActiveCat = 0;

// Build the inner grid only — used both for the initial render and for
// switching categories. The `#sym-cats` row of category buttons is
// rendered ONCE (in renderSymbolPanel) and never wiped, so a click on a
// cat button doesn't detach itself from the DOM mid-event. (See bugfix
// note below.)
function renderSymGrid() {
  const cat = SYMBOL_CATEGORIES[symActiveCat];
  document.getElementById("sym-grid").innerHTML = cat.syms.map(([s, c]) =>
    `<button class="sym-btn" data-cmd="${c.replace(/&/g,'&amp;').replace(/"/g,'&quot;')}" onclick="insertSymbol(this.dataset.cmd, event)">
       ${s}
     </button>`
  ).join("");
}

export function renderSymbolPanel() {
  const catsEl = document.getElementById("sym-cats");
  // Cat buttons are rendered once — selectSymCat will toggle .active
  // rather than wiping innerHTML. This avoids the bug where clicking a
  // cat button detached its own DOM node before the document-level
  // click handler ran, which then saw `panel.contains(e.target) === false`
  // and closed the whole panel.
  catsEl.innerHTML = SYMBOL_CATEGORIES.map((cat, i) =>
    `<button class="sym-cat-btn${i === symActiveCat ? " active" : ""}"
             data-cat-idx="${i}"
             onclick="selectSymCat(${i}, event)">${cat.name}</button>`
  ).join("");
  renderSymGrid();
}

export function selectSymCat(i, e) {
  // Belt-and-suspenders: if we ever DO replace these buttons, stop the
  // event from reaching the document close-handler.
  if (e) e.stopPropagation();
  symActiveCat = i;
  // Toggle .active in place — keeps every cat button attached to the DOM
  // so the click event's target stays valid through bubbling.
  document.querySelectorAll(".sym-cat-btn").forEach(btn => {
    btn.classList.toggle("active", Number(btn.dataset.catIdx) === i);
  });
  renderSymGrid();
}

export function insertSymbol(cmd, e) {
  // The same safety net as selectSymCat — and it also covers the case
  // where focus shifts to the editor after replaceSelection, which on
  // some browsers fires a synthetic click that bubbles to document.
  if (e) e.stopPropagation();
  const cursor = CM.getCursor();
  CM.replaceSelection(cmd);
  // if command ends with {} put cursor inside braces
  if (cmd.endsWith("{}")) {
    CM.setCursor({ line: cursor.line, ch: cursor.ch + cmd.length - 1 });
  }
  CM.focus();
}

// ── v3.2.2 — Environment templates ───────────────────────────
// Each item is { name, preview, snippet }. `snippet` may contain a
// single `|` placeholder marking where the cursor should land after
// insertion (the `|` is removed before insertion). Multi-line snippets
// embed actual newlines (CodeMirror handles indentation by mode).
const ENV_CATEGORIES = [
  { name: "Math", items: [
    { name: "equation", preview: "\\begin{equation} … \\end{equation}",
      snippet: "\\begin{equation}\n  |\n\\end{equation}\n" },
    { name: "equation*", preview: "unnumbered equation",
      snippet: "\\begin{equation*}\n  |\n\\end{equation*}\n" },
    { name: "align", preview: "\\begin{align} … &= … \\end{align}",
      snippet: "\\begin{align}\n  | &= \\\\\n  &= \n\\end{align}\n" },
    { name: "align*", preview: "unnumbered align",
      snippet: "\\begin{align*}\n  | &= \\\\\n  &= \n\\end{align*}\n" },
    { name: "gather", preview: "centred multi-line",
      snippet: "\\begin{gather}\n  |\n\\end{gather}\n" },
    { name: "split", preview: "split inside equation",
      snippet: "\\begin{split}\n  | &= \\\\\n  &= \n\\end{split}\n" },
    { name: "cases", preview: "piecewise definition",
      snippet: "\\begin{cases}\n  | & \\text{if } \\\\\n  & \\text{otherwise}\n\\end{cases}" },
    { name: "matrix",  preview: "( ⋯ ) matrix",
      snippet: "\\begin{matrix}\n  | & \\\\\n  & \n\\end{matrix}" },
    { name: "pmatrix", preview: "parenthesised matrix",
      snippet: "\\begin{pmatrix}\n  | & \\\\\n  & \n\\end{pmatrix}" },
    { name: "bmatrix", preview: "bracketed matrix",
      snippet: "\\begin{bmatrix}\n  | & \\\\\n  & \n\\end{bmatrix}" },
    { name: "vmatrix", preview: "determinant",
      snippet: "\\begin{vmatrix}\n  | & \\\\\n  & \n\\end{vmatrix}" },
  ]},
  { name: "Floats", items: [
    { name: "figure",       preview: "single figure with caption + label",
      snippet: "\\begin{figure}[H]\n  \\centering\n  \\includegraphics[width=0.8\\textwidth]{|}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}\n" },
    { name: "subfigure",    preview: "two side-by-side subfigures",
      snippet: "\\begin{figure}[H]\n  \\centering\n  \\begin{subfigure}[b]{0.45\\textwidth}\n    \\includegraphics[width=\\textwidth]{|}\n    \\caption{}\n    \\label{fig:a}\n  \\end{subfigure}\n  \\hfill\n  \\begin{subfigure}[b]{0.45\\textwidth}\n    \\includegraphics[width=\\textwidth]{}\n    \\caption{}\n    \\label{fig:b}\n  \\end{subfigure}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}\n" },
    { name: "table",        preview: "tabular with caption",
      snippet: "\\begin{table}[H]\n  \\centering\n  \\begin{tabular}{cc}\n    \\hline\n    | & \\\\\n    \\hline\n  \\end{tabular}\n  \\caption{}\n  \\label{tab:}\n\\end{table}\n" },
    { name: "wrapfigure",   preview: "text wraps around figure",
      snippet: "\\begin{wrapfigure}{r}{0.4\\textwidth}\n  \\centering\n  \\includegraphics[width=\\linewidth]{|}\n  \\caption{}\n  \\label{fig:}\n\\end{wrapfigure}\n" },
  ]},
  { name: "Lists", items: [
    { name: "itemize",     preview: "bullet list",
      snippet: "\\begin{itemize}\n  \\item |\n  \\item \n\\end{itemize}\n" },
    { name: "enumerate",   preview: "numbered list",
      snippet: "\\begin{enumerate}\n  \\item |\n  \\item \n\\end{enumerate}\n" },
    { name: "description", preview: "term–definition list",
      snippet: "\\begin{description}\n  \\item[|] \n  \\item[] \n\\end{description}\n" },
  ]},
  { name: "Theorem", items: [
    { name: "theorem", preview: "amsthm theorem",
      snippet: "\\begin{theorem}\n  |\n\\end{theorem}\n" },
    { name: "lemma",   preview: "amsthm lemma",
      snippet: "\\begin{lemma}\n  |\n\\end{lemma}\n" },
    { name: "corollary", preview: "amsthm corollary",
      snippet: "\\begin{corollary}\n  |\n\\end{corollary}\n" },
    { name: "proof",   preview: "proof environment",
      snippet: "\\begin{proof}\n  |\n\\end{proof}\n" },
    { name: "definition", preview: "amsthm definition",
      snippet: "\\begin{definition}\n  |\n\\end{definition}\n" },
    { name: "remark", preview: "amsthm remark",
      snippet: "\\begin{remark}\n  |\n\\end{remark}\n" },
  ]},
  { name: "Code", items: [
    { name: "verbatim", preview: "monospace, no LaTeX",
      snippet: "\\begin{verbatim}\n|\n\\end{verbatim}\n" },
    { name: "lstlisting", preview: "listings package code block",
      snippet: "\\begin{lstlisting}[language=Python]\n|\n\\end{lstlisting}\n" },
    { name: "minted",     preview: "minted package code block",
      snippet: "\\begin{minted}{python}\n|\n\\end{minted}\n" },
  ]},
];

let envActiveCat = 0;

function renderEnvPanel() {
  const cats = document.getElementById("env-cats");
  cats.innerHTML = ENV_CATEGORIES.map((c, i) =>
    `<button class="env-cat-btn${i === envActiveCat ? " active" : ""}"
             data-env-idx="${i}"
             onclick="selectEnvCat(${i}, event)">${c.name}</button>`
  ).join("");
  renderEnvList();
}
function renderEnvList() {
  const list = document.getElementById("env-list");
  const items = ENV_CATEGORIES[envActiveCat].items;
  list.innerHTML = items.map((it, i) =>
    `<div class="env-row" data-env-i="${i}" onclick="insertEnv(${envActiveCat}, ${i}, event)">
       <span class="env-name">${escapeHtml(it.name)}</span>
       <span class="env-preview">${escapeHtml(it.preview)}</span>
     </div>`
  ).join("");
}
export function selectEnvCat(i, e) {
  if (e) e.stopPropagation();
  envActiveCat = i;
  document.querySelectorAll(".env-cat-btn").forEach(btn => {
    btn.classList.toggle("active", Number(btn.dataset.envIdx) === i);
  });
  renderEnvList();
}
// Insert template: replace selection with snippet (minus `|`), then place
// cursor at the `|` position. Same trick the symbol panel uses but adapted
// for multi-line templates.
export function insertEnv(catIdx, itemIdx, e) {
  if (e) e.stopPropagation();
  const it = ENV_CATEGORIES[catIdx].items[itemIdx];
  if (!it) return;
  const snippet = it.snippet;
  const pipe    = snippet.indexOf("|");
  const cleaned = pipe >= 0 ? snippet.replace("|", "") : snippet;
  const cursor  = CM.getCursor();
  CM.replaceSelection(cleaned);
  if (pipe >= 0) {
    // Compute target cursor: walk `snippet[:pipe]` to count newlines
    // and trailing-line characters from the original cursor position.
    const pre   = snippet.slice(0, pipe);
    const lines = pre.split("\n");
    const tgt = lines.length === 1
      ? { line: cursor.line, ch: cursor.ch + lines[0].length }
      : { line: cursor.line + lines.length - 1, ch: lines[lines.length - 1].length };
    CM.setCursor(tgt);
  }
  CM.focus();
}
// v5.0.0-beta.0.0 — Popover
export function toggleEnvPanel(e){ _togglePopover(e, { panelId: "env-panel", btnId: "env-toggle-btn", width: 380, onOpen: renderEnvPanel }); }

// ── v4.4.0 — PACKAGE MANAGER ────────────────────────────────────
// Lists the \usepackage{} packages in the current document, lets you remove
// them, and suggests important packages you're not using yet — each added to
// the preamble with one click. Pure document editing (no MiKTeX install).
//
// Curated "important packages": the ones a thesis/article almost always wants.
// `line` overrides the default `\usepackage{name}` when sensible options help.
const _IMPORTANT_PACKAGES = [
  { name: "amsmath",    desc: "Core math: align, gather, \\text, \\dfrac" },
  { name: "amssymb",    desc: "Extra math symbols: \\mathbb, \\lesssim" },
  { name: "amsthm",     desc: "Theorem / proof environments" },
  { name: "graphicx",   desc: "\\includegraphics for figures" },
  { name: "hyperref",   desc: "Clickable links + PDF bookmarks (load late)" },
  { name: "cleveref",   desc: "Smart cross-refs \\cref (load after hyperref)" },
  { name: "booktabs",   desc: "Professional tables: \\toprule \\midrule" },
  { name: "geometry",   desc: "Page margins", line: "\\usepackage[margin=1in]{geometry}" },
  { name: "xcolor",     desc: "Colours: \\textcolor, \\color" },
  { name: "siunitx",    desc: "Units & numbers: \\SI, \\num" },
  { name: "microtype",  desc: "Subtle typographic polish" },
  { name: "babel",      desc: "Language & hyphenation", line: "\\usepackage[english]{babel}" },
  { name: "caption",    desc: "Customise figure/table captions" },
  { name: "subcaption", desc: "Sub-figures (subfigure env)" },
  { name: "enumitem",   desc: "Customisable lists" },
  { name: "float",      desc: "Precise [H] float placement" },
  { name: "listings",   desc: "Source-code listings" },
  { name: "bm",         desc: "Bold math: \\bm" },
  { name: "url",        desc: "Line-breakable \\url{}" },
  { name: "csquotes",   desc: "Context-sensitive quotes" },
];

// Extract package names from every \usepackage[..]{a,b,c} in the document.
function _usedPackages() {
  const used = new Set();
  const re = /\\usepackage\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
  const text = CM.getValue();
  let m;
  while ((m = re.exec(text))) {
    m[1].split(",").forEach(p => { const n = p.trim(); if (n) used.add(n); });
  }
  return used;
}

// v5.0.0-beta.0.0 — Popover
export function togglePackagePanel(e){ _togglePopover(e, { panelId: "package-panel", btnId: "package-toggle-btn", width: 380, onOpen: renderPackagePanel }); }

function renderPackagePanel() {
  const list = document.getElementById("package-list");
  if (!list) return;
  const used = _usedPackages();
  const usedArr = [...used].sort();

  const usedRows = usedArr.length
    ? usedArr.map(n => {
        const known = _IMPORTANT_PACKAGES.find(p => p.name === n);
        const desc  = known ? known.desc : "";
        return `<div class="pkg-row">
          <div class="pkg-info">
            <div class="pkg-name">${escapeHtml(n)}</div>
            ${desc ? `<div class="pkg-desc">${escapeHtml(desc)}</div>` : ""}
          </div>
          <span class="pkg-state" data-pkg="${escapeHtml(n)}"></span>
          <button class="pkg-btn remove" title="Remove \\usepackage{${escapeHtml(n)}}"
                  data-pkg="${escapeHtml(n)}" onclick="removePackage(this.dataset.pkg, event)">✕</button>
        </div>`;
      }).join("")
    : `<div class="pkg-empty">No \\usepackage lines found in this file.</div>`;

  // Suggestions = curated importants not already used.
  const suggestions = _IMPORTANT_PACKAGES.filter(p => !used.has(p.name));
  const suggRows = suggestions.length
    ? suggestions.map(p => `<div class="pkg-row">
          <div class="pkg-info">
            <div class="pkg-name">${escapeHtml(p.name)}</div>
            <div class="pkg-desc">${escapeHtml(p.desc)}</div>
          </div>
          <span class="pkg-state" data-pkg="${escapeHtml(p.name)}"></span>
          <button class="pkg-btn add" title="Add ${escapeHtml(p.line || ('\\usepackage{' + p.name + '}'))}"
                  data-pkg="${escapeHtml(p.name)}" onclick="addPackage(this.dataset.pkg, event)">＋</button>
        </div>`).join("")
    : `<div class="pkg-empty">You're already using all the suggested packages. 🎉</div>`;

  list.innerHTML =
    `<div class="pkg-section">In this document (${usedArr.length})</div>` + usedRows +
    `<div class="pkg-section">Suggested</div>` + suggRows;

  // Annotate each row with system install-state (kpsewhich) + an Install button
  // for missing packages. Async so the panel paints immediately.
  const names = [...new Set([...usedArr, ...suggestions.map(p => p.name)])];
  _refreshPackageInstallStatus(names);
}

// Session cache for install state. kpsewhich can be slow on MiKTeX (and the
// package DB may be locked), so we fetch once in the background, cache the
// result, and never block the panel — add/remove/install all work regardless.
const _pkgInstallCache = {};   // name -> bool (installed)
let   _pkgManager = null;      // manager label (e.g. "MiKTeX Console") or null
let   _pkgStatusFetching = false;

function _pkgStateHTML(name) {
  if (!(name in _pkgInstallCache)) return "";          // unknown → blank slot
  if (_pkgInstallCache[name])
    return `<span class="pkg-installed" title="Installed on this system">✓</span>`;
  if (_pkgManager)
    return `<button class="pkg-btn install" title="Not installed — open ${_pkgManager} to install"
                    onclick="openPackageManager(event)">📦</button>`;
  return `<span class="pkg-missing" title="Not installed">not installed</span>`;
}

function _applyPkgSlots() {
  document.querySelectorAll("#package-list .pkg-state").forEach(slot => {
    if (slot.dataset.pkg) slot.innerHTML = _pkgStateHTML(slot.dataset.pkg);
  });
}

// Show cached state immediately, then fetch only the names we don't know yet.
async function _refreshPackageInstallStatus(names) {
  _applyPkgSlots();
  const unknown = names.filter(n => !(n in _pkgInstallCache));
  if (!unknown.length || _pkgStatusFetching) return;
  _pkgStatusFetching = true;
  try {
    const d = await (await fetch("/api/packages/status", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names: unknown }),
    })).json();
    Object.assign(_pkgInstallCache, d.installed || {});
    _pkgManager = d.manager || null;
  } catch (_) { /* leave slots blank; panel still works */ }
  finally { _pkgStatusFetching = false; }
  _applyPkgSlots();
}

// Open the system's package-manager GUI (MiKTeX Console / TeX Live) so the
// user installs there — TexLocal doesn't shell the installer itself.
export async function openPackageManager(e) {
  if (e) e.stopPropagation();
  try {
    const d = await (await fetch("/api/packages/open-manager", { method: "POST" })).json();
    if (!d.ok && d.error) alert(d.error);
  } catch (_) { alert("Couldn't open the package manager."); }
}

// Insert a \usepackage line into the preamble: after the last existing
// \usepackage, else after \documentclass, else at the top. Never past
// \begin{document}.
export function addPackage(name, e) {
  if (e) e.stopPropagation();
  const pkg  = _IMPORTANT_PACKAGES.find(p => p.name === name);
  const line = (pkg && pkg.line) ? pkg.line : `\\usepackage{${name}}`;
  if (_usedPackages().has(name)) return;   // already there

  const lines = CM.getValue().split("\n");
  let insertAt = null, lastUse = -1, docClass = -1, beginDoc = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/\\begin\s*\{document\}/.test(lines[i])) { beginDoc = i; break; }
    if (/\\usepackage\b/.test(lines[i]))   lastUse  = i;
    if (/\\documentclass\b/.test(lines[i])) docClass = i;
  }
  if (lastUse >= 0)        insertAt = lastUse + 1;
  else if (docClass >= 0)  insertAt = docClass + 1;
  else                     insertAt = 0;
  if (insertAt > beginDoc) insertAt = beginDoc;   // stay in the preamble

  CM.replaceRange(line + "\n", { line: insertAt, ch: 0 });
  renderPackagePanel();
  CM.focus();
}

// Remove a package: delete its whole \usepackage line if it's the only name,
// otherwise drop just that name from the comma list.
export function removePackage(name, e) {
  if (e) e.stopPropagation();
  const lines = CM.getValue().split("\n");
  const re = /\\usepackage\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const names = m[1].split(",").map(s => s.trim()).filter(Boolean);
    if (!names.includes(name)) continue;
    CM.operation(() => {
      if (names.length === 1) {
        // Whole line goes (including its trailing newline).
        CM.replaceRange("", { line: i, ch: 0 },
                              { line: i + 1, ch: 0 });
      } else {
        const kept    = names.filter(n => n !== name);
        const newLine = lines[i].replace(/\{[^}]*\}/, "{" + kept.join(",") + "}");
        CM.replaceRange(newLine, { line: i, ch: 0 },
                              { line: i, ch: lines[i].length });
      }
    });
    break;
  }
  renderPackagePanel();
  CM.focus();
}

// ── v3.3.0 — Snippet library ────────────────────────────────────
// Type a trigger (e.g. `eq`) + Tab to expand it into a multi-line template
// with cursor placeholders. Tab cycles forward through placeholders; the
// `${0}` slot (if present) is the final cursor resting position. Esc and
// click-outside-the-snippet end the session early.
//
// Snippets are kept in two layers:
//   1. _DEFAULT_SNIPPETS — baked into the frontend, math + envs + physics
//      bias because the primary use case is Pol's QM/Rydberg thesis.
//   2. Project-local `.texlocal-snippets.json` — overlays the defaults,
//      can add new triggers OR shadow defaults. Loaded on switchProject.
//
// Placeholder syntax (parsed by _snippetExpand):
//   ${N}            — empty placeholder, position N in Tab order
//   ${N:default}    — placeholder with default text pre-selected
//   ${0}            — final cursor (always last in the cycle, no selection)
const _DEFAULT_SNIPPETS = {
  // Math environments — most-used during thesis writing
  "eq":     "\\begin{equation}\n  ${1}\n  \\label{eq:${2:label}}\n\\end{equation}\n${0}",
  "eq*":    "\\begin{equation*}\n  ${1}\n\\end{equation*}\n${0}",
  "al":     "\\begin{align}\n  ${1} &= ${2} \\\\\n  ${3} &= ${4}\n\\end{align}\n${0}",
  "al*":    "\\begin{align*}\n  ${1} &= ${2}\n\\end{align*}\n${0}",
  "gather": "\\begin{gather}\n  ${1} \\\\\n  ${2}\n\\end{gather}\n${0}",
  "split":  "\\begin{split}\n  ${1} &= ${2} \\\\\n      &= ${3}\n\\end{split}${0}",
  "cases":  "\\begin{cases}\n  ${1} & \\text{if } ${2} \\\\\n  ${3} & \\text{otherwise}\n\\end{cases}${0}",
  "bmat":   "\\begin{bmatrix}\n  ${1} & ${2} \\\\\n  ${3} & ${4}\n\\end{bmatrix}${0}",
  "pmat":   "\\begin{pmatrix}\n  ${1} & ${2} \\\\\n  ${3} & ${4}\n\\end{pmatrix}${0}",
  // Math operators
  "frac":   "\\frac{${1}}{${2}}${0}",
  "dfrac":  "\\dfrac{${1}}{${2}}${0}",
  "sqrt":   "\\sqrt{${1}}${0}",
  "sum":    "\\sum_{${1:i=1}}^{${2:N}} ${3}${0}",
  "int":    "\\int_{${1:0}}^{${2:\\infty}} ${3} \\, d${4:x}${0}",
  "prod":   "\\prod_{${1:i=1}}^{${2:N}} ${3}${0}",
  "lim":    "\\lim_{${1:n \\to \\infty}} ${2}${0}",
  "vec":    "\\vec{${1}}${0}",
  "hat":    "\\hat{${1}}${0}",
  "bar":    "\\bar{${1}}${0}",
  "tilde":  "\\tilde{${1}}${0}",
  "dot":    "\\dot{${1}}${0}",
  "ddot":   "\\ddot{${1}}${0}",
  "lr":     "\\left( ${1} \\right)${0}",
  "lrb":    "\\left[ ${1} \\right]${0}",
  "lrc":    "\\left\\{ ${1} \\right\\}${0}",
  // Floats
  "fig":    "\\begin{figure}[${1:htbp}]\n  \\centering\n  \\includegraphics[width=${2:0.8}\\linewidth]{${3:path}}\n  \\caption{${4}}\n  \\label{fig:${5}}\n\\end{figure}\n${0}",
  "tab":    "\\begin{table}[${1:htbp}]\n  \\centering\n  \\caption{${2}}\n  \\label{tab:${3}}\n  \\begin{tabular}{${4:lcc}}\n    \\toprule\n    ${5:Header} & ${6} & ${7} \\\\\n    \\midrule\n    ${0}\n    \\bottomrule\n  \\end{tabular}\n\\end{table}",
  // Lists
  "it":     "\\begin{itemize}\n  \\item ${1}\n  \\item ${2}\n\\end{itemize}\n${0}",
  "en":     "\\begin{enumerate}\n  \\item ${1}\n  \\item ${2}\n\\end{enumerate}\n${0}",
  // Sectioning
  "sec":    "\\section{${1}}\n\\label{sec:${2}}\n\n${0}",
  "ssec":   "\\subsection{${1}}\n\\label{sec:${2}}\n\n${0}",
  "sssec":  "\\subsubsection{${1}}\n\\label{sec:${2}}\n\n${0}",
  "ch":     "\\chapter{${1}}\n\\label{ch:${2}}\n\n${0}",
  // Cite/ref shorthand
  "cite":   "\\cite{${1}}${0}",
  "ref":    "\\ref{${1}}${0}",
  "eqref":  "\\eqref{${1}}${0}",
  "cref":   "\\cref{${1}}${0}",
  // Physics — quantum mechanics / Dirac notation (Pol's thesis area)
  "bra":    "\\bra{${1}}${0}",
  "ket":    "\\ket{${1}}${0}",
  "braket": "\\braket{${1}}{${2}}${0}",
  "expval": "\\expval{${1}}${0}",
  "pderiv": "\\frac{\\partial ${1}}{\\partial ${2}}${0}",
  "deriv":  "\\frac{d ${1}}{d ${2}}${0}",
  "comm":   "\\left[ ${1}, ${2} \\right]${0}",
  "ang":    "\\left\\langle ${1} \\right\\rangle${0}",
  // Generic
  "begin":  "\\begin{${1}}\n  ${2}\n\\end{${1}}${0}",
  "todo":   "\\todo{${1}}${0}",
};

let snippetsCache = Object.assign({}, _DEFAULT_SNIPPETS);
let _snippetSession = null;   // { markers: [{n, mark}], current: idx }

export async function loadSnippets() {
  // Reset to defaults first; project file (if any) overlays on top.
  // Doing it in this order means a project file that omits some defaults
  // does NOT lose those triggers — they still resolve. To intentionally
  // disable a default trigger, the project file should map it to "" and
  // _snippetTabHandler will treat empty bodies as no-op (falls through).
  snippetsCache = Object.assign({}, _DEFAULT_SNIPPETS);
  if (!currentProject) return;
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/snippets`);
    const d = await r.json();
    if (d && d.snippets && typeof d.snippets === "object") {
      Object.assign(snippetsCache, d.snippets);
    }
  } catch (_) {
    // network/parse fail — defaults still work
  }
}

// Tab key handler — three paths, checked in order:
//   (a) active snippet session → jump to next placeholder
//   (b) trigger word before cursor matches a snippet → expand
//   (c) default — insert 2 spaces (original Tab behaviour)
export function _snippetTabHandler(cm) {
  // (a) Continue existing session if cursor is inside the snippet bbox
  // and at least one upcoming placeholder still has a live range.
  if (_snippetSession && _snippetAdvance(cm)) return;

  // (b) Look for trigger word immediately before cursor.
  // Triggers may include `*` (eq*, al*) so the char class extends \w with *.
  if (!cm.getSelection()) {
    const cur  = cm.getCursor();
    const line = cm.getLine(cur.line);
    const m    = line.slice(0, cur.ch).match(/(\w[\w*]*)$/);
    if (m) {
      const trigger = m[1];
      const body    = snippetsCache[trigger];
      if (body) {
        const from = { line: cur.line, ch: cur.ch - trigger.length };
        _snippetExpand(cm, body, from, cur);
        return;
      }
    }
  }

  // (c) Default — insert 2 spaces matching pre-v3.3.0 behaviour.
  cm.replaceSelection("  ", "end");
}

// Replace the trigger word at [from..to] with the snippet body, resolving
// `${N}` and `${N:default}` placeholders. Placeholder text is inserted
// inline (the default if any), and a CodeMirror markText is created over
// each placeholder so the position survives subsequent edits. Tab cycles
// through markers in n-order; ${0} (if present) is the final landing slot.
function _snippetExpand(cm, body, from, to) {
  _snippetClear();   // drop any previous session

  // Walk body, collecting placeholder records as we build the plain text.
  const re = /\$\{(\d+)(?::([^}]*))?\}/g;
  let m, plain = "", lastIdx = 0;
  const phRecs = [];   // [{n, start, end}] indexes into `plain`
  while ((m = re.exec(body)) !== null) {
    plain += body.slice(lastIdx, m.index);
    const n   = parseInt(m[1], 10);
    const def = m[2] || "";
    const s   = plain.length;
    plain += def;
    phRecs.push({ n, start: s, end: plain.length });
    lastIdx = m.index + m[0].length;
  }
  plain += body.slice(lastIdx);

  // Apply the replacement as a single edit so CodeMirror gives us one
  // undo step + a coherent change event for downstream listeners (linter,
  // auto-save, outline). replaceRange returns nothing; we re-derive the
  // inserted text's coordinates by walking `plain`.
  cm.replaceRange(plain, from, to);

  // If no placeholders, just place cursor at the end of the insertion.
  if (!phRecs.length) {
    const endPos = _snippetWalkPos(plain, plain.length, from);
    cm.setCursor(endPos);
    return;
  }

  // Create marks for each placeholder.
  const markers = [];
  for (const p of phRecs) {
    const a = _snippetWalkPos(plain, p.start, from);
    const b = _snippetWalkPos(plain, p.end,   from);
    const mark = cm.markText(a, b, {
      className: "cm-snippet-placeholder",
      inclusiveLeft:  false,
      inclusiveRight: true,    // typing AT the right edge grows the placeholder
      clearWhenEmpty: false,   // keep zero-width markers around so Tab still finds them
    });
    markers.push({ n: p.n, mark });
  }
  // Sort by n; n=0 is the final landing slot (always last regardless of value).
  markers.sort((x, y) => {
    if (x.n === 0 && y.n !== 0) return 1;
    if (y.n === 0 && x.n !== 0) return -1;
    return x.n - y.n;
  });

  _snippetSession = { markers, current: -1 };
  _snippetAdvance(cm);
}

// Convert "char index `idx` within `text` starting at editor pos `from`"
// to {line, ch} by walking the text. Used to translate snippet-body offsets
// into post-insertion editor coordinates.
function _snippetWalkPos(text, idx, from) {
  let line = from.line, ch = from.ch;
  for (let i = 0; i < idx; i++) {
    if (text[i] === "\n") { line++; ch = 0; }
    else ch++;
  }
  return { line, ch };
}

// Advance to the next placeholder in the session; returns true if a jump
// happened, false if the session ended (caller can fall through to default
// Tab behaviour in that case).
function _snippetAdvance(cm) {
  if (!_snippetSession) return false;
  const s = _snippetSession;
  // Find next live placeholder after `current`. Skip any whose marker
  // has been lost (e.g. user deleted the surrounding line).
  while (true) {
    s.current++;
    if (s.current >= s.markers.length) { _snippetClear(); return false; }
    const range = s.markers[s.current].mark.find();
    if (range) {
      cm.setSelection(range.from, range.to);
      // If this is the ${0} slot, finish the session — the user is at
      // the final resting position and should not Tab again into the
      // snippet (next Tab is a plain "insert spaces").
      if (s.markers[s.current].n === 0) _snippetClear();
      return true;
    }
  }
}

function _snippetClear() {
  if (!_snippetSession) return;
  _snippetSession.markers.forEach(m => { try { m.mark.clear(); } catch (_) {} });
  _snippetSession = null;
}

// End session when cursor wanders outside the snippet's bounding box —
// otherwise a Tab pressed in unrelated code would teleport the cursor
// back into the old snippet, which is jarring. Tolerance: 1 line above/
// below the markers (allows e.g. Enter + indent without losing the session).
export function _initPanels() {
CM.on("cursorActivity", () => {
  if (!_snippetSession) return;
  const ranges = _snippetSession.markers
    .map(m => m.mark.find()).filter(Boolean);
  if (!ranges.length) { _snippetClear(); return; }
  let minLine = Infinity, maxLine = -Infinity;
  for (const r of ranges) {
    if (r.from.line < minLine) minLine = r.from.line;
    if (r.to.line   > maxLine) maxLine = r.to.line;
  }
  const cur = CM.getCursor();
  if (cur.line < minLine - 1 || cur.line > maxLine + 1) _snippetClear();
});
}

// Snippet panel — discovery surface listing every available trigger.
// Clicking a row pastes the body's resolved (placeholder-stripped) form
// at the cursor so users can preview what the trigger inserts without
// memorising it. The trigger+Tab path remains the primary UX.
function renderSnippetPanel() {
  const list = document.getElementById("snip-list");
  if (!list) return;
  const entries = Object.entries(snippetsCache)
    .filter(([_, body]) => body)            // skip disabled (empty body) entries
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (!entries.length) {
    list.innerHTML = '<div style="padding:14px;color:var(--muted);font-size:11px">No snippets defined.</div>';
    return;
  }
  // Preview: render placeholders as accent-tinted spans so the user sees
  // exactly where the cursor will land. Truncate long bodies in CSS.
  const renderBody = (body) => {
    return escapeHtml(body)
      .replace(/\$\{(\d+)(?::([^}]*))?\}/g, (_full, n, def) =>
        `<span class="ph">${escapeHtml(def || ("$" + n))}</span>`);
  };
  list.innerHTML = entries.map(([trig, body], i) =>
    `<div class="snip-row" data-idx="${i}" data-trig="${escapeAttr(trig)}">
       <div class="snip-trigger">${escapeHtml(trig)}</div>
       <div class="snip-body">${renderBody(body)}</div>
     </div>`
  ).join("");
  list.querySelectorAll(".snip-row").forEach(row => {
    row.addEventListener("click", e => {
      e.stopPropagation();
      const trig = row.dataset.trig;
      const body = snippetsCache[trig];
      if (!body) return;
      // Insert at cursor using the same expander as Tab — gives the user
      // the placeholder cycle even when invoked from the panel.
      const cur = CM.getCursor();
      _snippetExpand(cmEditor, body, cur, cur);
      document.getElementById("snippet-panel").classList.remove("open");
      CM.focus();
    });
  });
}

// v5.0.0-beta.0.0 — Popover
export function toggleSnippetPanel(e){ _togglePopover(e, { panelId: "snippet-panel", btnId: "snippet-toggle-btn", width: 380, onOpen: renderSnippetPanel }); }
