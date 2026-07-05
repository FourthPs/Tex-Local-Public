import { CM, _reloadCurrentFileFromDisk, currentFile, currentProject, escapeAttr, escapeHtml, saveTimer } from "editor";
import { openFile, saveCurrentFile } from "files";

// static/search.js — TexLocal Phase 2 module split (v5.0.0-beta.2.0)
// Lifted verbatim from editor.js (CM-light cluster). Interim shared-scope:
// a classic <script defer>, NOT an ES module — shares editor.js's global
// scope (module-level state + the global CM adapter facade). Loads AFTER
// editor.js and BEFORE boot.js. CM6 note: touches CodeMirror only via CM.*

// ── SEARCH ACROSS FILES ───────────────────────────────────────
export function toggleSearchPanel() {
  const panel = document.getElementById("search-panel");
  if (panel.classList.contains("open")) {
    hideSearchPanel();
  } else {
    panel.classList.add("open");
    setTimeout(() => document.getElementById("search-input").focus(), 60);
  }
}

export function hideSearchPanel() {
  document.getElementById("search-panel").classList.remove("open");
}

// v3.2.2 — Replace-mode toggle + project-wide replace-all.
export function toggleReplaceMode() {
  const row = document.getElementById("replace-row");
  const visible = row.style.display !== "none";
  row.style.display = visible ? "none" : "flex";
  if (!visible) setTimeout(() => document.getElementById("replace-input").focus(), 40);
}

export async function doReplaceAll() {
  if (!currentProject) { alert("Select a project first."); return; }
  const find    = document.getElementById("search-input").value;
  const replace = document.getElementById("replace-input").value;
  const regex   = document.getElementById("search-regex").checked;
  const caseS   = document.getElementById("search-case").checked;
  if (!find) {
    alert("Type something in the Find field first.");
    return;
  }
  // Hard guard: irreversible across many files. Show a confirm with
  // realistic stakes so the user can back out.
  const ok = confirm(
    `Replace ALL occurrences of:\n\n  ${find}\n\nwith:\n\n  ${replace}\n\n`
    + `across every .tex / .bib file in "${currentProject}"?\n\n`
    + `${regex ? "Regex mode ON. " : ""}${caseS ? "Case-sensitive. " : ""}`
    + `This rewrites files on disk and cannot be undone from inside TexLocal.\n\n`
    + `(Tip: commit with git first, or export ZIP as a backup.)`
  );
  if (!ok) return;

  // Cancel any pending auto-save so it can't race with the file rewrites.
  clearTimeout(saveTimer);
  // v4.9.4 — flush the buffer BEFORE replacing: the backend replaces what's
  // on disk, so edits typed within the autosave debounce window (<=800ms)
  // must land first — otherwise they'd be missed by the replace and then
  // clobbered by the reload below.
  await saveCurrentFile();

  const resultsEl = document.getElementById("search-results");
  const countEl   = document.getElementById("search-count");
  resultsEl.innerHTML = '<div class="search-empty">Replacing…</div>';
  countEl.style.display = "none";

  let data;
  try {
    const res = await fetch(
      `/api/projects/${encodeURIComponent(currentProject)}/replace-all`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ find, replace, regex, case: caseS }),
      }
    );
    data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || ("HTTP " + res.status));
  } catch (e) {
    resultsEl.innerHTML =
      `<div class="search-empty" style="color:var(--red)">Replace failed: ${escapeHtml(e.message)}</div>`;
    return;
  }

  const files = data.files || [];
  countEl.textContent = `${data.total_replacements} replacement${data.total_replacements === 1 ? "" : "s"} across ${files.length} file${files.length === 1 ? "" : "s"}`;
  countEl.style.display = "block";

  if (!files.length) {
    resultsEl.innerHTML = '<div class="search-empty">No matches — nothing changed.</div>';
    return;
  }
  resultsEl.innerHTML = files.map(f =>
    `<div class="search-result-item" data-path="${escapeAttr(f.path)}" onclick="openFile(this.dataset.path)">
       <div class="search-result-header">
         <span class="search-result-file">${escapeHtml(f.path)}</span>
         <span class="search-result-line">×${f.count}</span>
       </div>
       <div class="search-result-text">${escapeHtml(f.preview || "")}</div>
     </div>`
  ).join("");

  // If the currently-open file was rewritten, reload its contents from
  // disk so the editor doesn't keep displaying the pre-replace version.
  // v4.9.4 — was openFile(currentFile), whose unconditional saveCurrentFile()
  // wrote the pre-replace buffer back over the freshly-replaced file and
  // silently reverted every replacement in the OPEN file (other files kept
  // theirs, so the count message lied). Reload from disk without saving.
  if (currentFile && files.some(f => f.path === currentFile)) {
    await _reloadCurrentFileFromDisk();
  }
}

export async function doSearch() {
  if (!currentProject) { alert("Select a project first."); return; }
  const q = document.getElementById("search-input").value.trim();
  if (!q) return;

  const resultsEl = document.getElementById("search-results");
  const countEl   = document.getElementById("search-count");
  resultsEl.innerHTML = '<div class="search-empty">Searching…</div>';
  countEl.style.display = "none";

  const res  = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/search?q=${encodeURIComponent(q)}`);
  const data = await res.json();
  const results = data.results || [];

  if (!results.length) {
    resultsEl.innerHTML = '<div class="search-empty">No results found</div>';
    return;
  }

  const total = results.length + (data.truncated ? "+" : "");
  countEl.textContent = `${total} result${results.length !== 1 ? "s" : ""}${data.truncated ? " (showing first 200)" : ""}`;
  countEl.style.display = "block";

  const esc = s => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  // build regex from the escaped query so it matches within HTML-escaped text
  const qEsc = esc(q);
  const qRe  = new RegExp(qEsc.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"), "gi");

  resultsEl.innerHTML = "";
  results.forEach(r => {
    const div = document.createElement("div");
    div.className = "search-result-item";
    const hiText = esc(r.text).replace(qRe, m => `<mark>${m}</mark>`);
    div.innerHTML = `
      <div class="search-result-loc">${esc(r.file)} : line ${r.line}</div>
      <div class="search-result-text">${hiText}</div>
    `;
    div.onclick = async () => {
      hideSearchPanel();
      if (r.file !== currentFile) await openFile(r.file);
      setTimeout(() => {
        // v4.7.10 — /search now returns 1-based lines; convert to 0-based.
        CM.setCursor(r.line - 1, 0);
        CM.scrollIntoView({ line: r.line - 1, ch: 0 }, 100);
        CM.focus();
      }, 180);
    };
    resultsEl.appendChild(div);
  });
}

// v4.4.0 — KaTeX MATH HOVER PREVIEW ────────────────────────────────
// Shows a rendered popup when hovering over $...$ / $$...$$ / \[...\] / \(...\).
// Single-line detection only — covers the vast majority of thesis inline math.
// Lookbehind not used for browser compat; $$ vs $ disambiguated by checking
// adjacent chars manually.
export function _attachKatexHover() {
  if (typeof katex === "undefined") return;   // CDN failed — degrade silently
  const popup = document.getElementById("katex-preview");
  if (!popup) return;
  let _hoverTimer = null;
  let _lastSrc    = null;

  function _findMathAt(line, ch) {
    // Walk the line with a small state machine to find the math span under ch.
    const len = line.length;
    let i = 0;
    while (i < len) {
      // $$ display math
      if (line[i] === '$' && line[i+1] === '$') {
        const start = i + 2;
        const end   = line.indexOf('$$', start);
        if (end < 0) break;
        if (i <= ch && ch <= end + 2) return { src: line.slice(start, end), display: true };
        i = end + 2; continue;
      }
      // $ inline math (not adjacent to another $)
      if (line[i] === '$' && line[i-1] !== '$' && line[i+1] !== '$') {
        const start = i + 1;
        const end   = line.indexOf('$', start);
        if (end < 0) break;
        if (line[end+1] === '$') { i = end + 2; continue; }  // skip $$
        if (i <= ch && ch <= end + 1) return { src: line.slice(start, end), display: false };
        i = end + 1; continue;
      }
      // \[ display math
      if (line[i] === '\\' && line[i+1] === '[') {
        const start = i + 2;
        const end   = line.indexOf('\\]', start);
        if (end < 0) break;
        if (i <= ch && ch <= end + 2) return { src: line.slice(start, end), display: true };
        i = end + 2; continue;
      }
      // \( inline math
      if (line[i] === '\\' && line[i+1] === '(') {
        const start = i + 2;
        const end   = line.indexOf('\\)', start);
        if (end < 0) break;
        if (i <= ch && ch <= end + 2) return { src: line.slice(start, end), display: false };
        i = end + 2; continue;
      }
      i++;
    }
    return null;
  }


  // v4.4.0 — Detect cursor inside a multi-line math environment.
  // Scans up to 50 lines back for \begin{env}, then forward for \end{env}.
  // Returns { src: full environment including \begin/\end, display: true } or null.
  const _MATH_ENVS = new Set([
    'equation','equation*','align','align*','gather','gather*',
    'multline','multline*','math','displaymath','eqnarray','eqnarray*',
    'alignat','alignat*','flalign','flalign*','split','cases',
    'pmatrix','bmatrix','vmatrix','Bmatrix','matrix','array',
  ]);
  function _findMathEnvAt(pos) {
    const total = CM.lineCount();
    const cur   = pos.line;
    const endRe   = /\\end\{([^}]+)\}/;
    const beginRe = /\\begin\{([^}]+)\}/;
    // Scan backwards to find \begin{mathenv} — stop if \end found first
    let beginLine = -1, env = null;
    for (let i = cur; i >= Math.max(0, cur - 60); i--) {
      const ln = CM.getLine(i) || '';
      const bm = ln.match(beginRe);
      if (bm && _MATH_ENVS.has(bm[1])) { beginLine = i; env = bm[1]; break; }
      if (i < cur && endRe.test(ln)) break;  // hit \end before \begin — not inside
    }
    if (beginLine < 0) return null;
    // Scan forward to find matching \end{env}
    let endLine = -1;
    for (let i = beginLine + 1; i <= Math.min(total - 1, cur + 60); i++) {
      if ((CM.getLine(i) || '').includes('\\end{' + env + '}')) { endLine = i; break; }
    }
    if (endLine < 0 || cur > endLine) return null;
    // Collect lines and render as display math
    const lines = [];
    for (let i = beginLine; i <= endLine; i++) lines.push(CM.getLine(i) || '');
    return { src: lines.join('\n'), display: true };
  }

  CM.getWrapperElement().addEventListener("mousemove", e => {
    clearTimeout(_hoverTimer);
    _hoverTimer = setTimeout(() => {
      const pos  = CM.coordsChar({ left: e.clientX, top: e.clientY });
      const line = CM.getLine(pos.line);
      if (!line) { popup.classList.remove("visible"); return; }
      const math = _findMathAt(line, pos.ch) || _findMathEnvAt(pos);
      if (!math) { popup.classList.remove("visible"); _lastSrc = null; return; }
      if (math.src === _lastSrc) return;   // same formula still hovered — skip re-render
      _lastSrc = math.src;
      popup.innerHTML = "";
      try {
        katex.render(math.src.trim(), popup, { displayMode: math.display, throwOnError: false });
      } catch (err) {
        popup.innerHTML = `<span class="katex-error">${err.message}</span>`;
      }
      // Position: prefer above cursor, fall back to below if near top.
      const pw = Math.min(popup.scrollWidth + 28, 480);
      const ph = popup.scrollHeight || 60;
      let left = e.clientX + 12;
      let top  = e.clientY - ph - 14;
      if (left + pw > window.innerWidth - 8) left = Math.max(4, e.clientX - pw);
      if (top < 8) top = e.clientY + 20;
      popup.style.left = left + "px";
      popup.style.top  = top  + "px";
      popup.classList.add("visible");
    }, 280);  // 280ms debounce — fast enough for hover, avoids flicker on cursor movement
  });

  CM.getWrapperElement().addEventListener("mouseleave", () => {
    clearTimeout(_hoverTimer);
    popup.classList.remove("visible");
    _lastSrc = null;
  });
}
