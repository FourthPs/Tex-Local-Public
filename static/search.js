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

// v5.7.0p6 — shared math-detection helpers, lifted (dedented) out of
// _attachKatexHover's closure so the caret overlay below can reuse them.
// Logic unchanged.
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

// v5.7.0p9 — environments KaTeX auto-numbers. In the narrow caret/hover popup
// that "(1)" tag overprints the equation body (the popup is much narrower than
// the page, so the right-aligned number lands on top of the math). The popup is
// a shape check, not a numbered reference, so we render the starred (unnumbered)
// variant of these — see the strip in _findMathEnvAt.
const _NUMBERED_ENVS = /^(equation|align|gather|multline|alignat|flalign|eqnarray)$/;
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
  let src = lines.join('\n');
  // v5.7.0p10 — \label isn't a KaTeX command; with throwOnError:false it renders
  // as raw red error text in the popup. Strip it — the preview needs no anchor.
  src = src.replace(/\\label\s*\{[^}]*\}/g, '');
  // v5.7.0p9 — drop the auto-number so it can't overprint the body in the popup
  // (render the starred variant; keeps alignment, just no "(1)" tag).
  if (_NUMBERED_ENVS.test(env)) {
    src = src.replace('\\begin{' + env + '}', '\\begin{' + env + '*}')
             .replace('\\end{' + env + '}',   '\\end{' + env + '*}');
  }
  return { src, display: true };
}

// v5.7.0p6 — true while the CARET overlay owns #katex-preview (typing inside
// math). The hover handlers check it so a stray mousemove can't hide or
// hijack the popup mid-keystroke; caret release hands the popup back.
let _katexCaretOwns = false;

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
  let _hideTimer  = null;
  let _lastSrc    = null;
  let _lastProbe  = 0;   // v5.7.0p10 — throttle the (up-to-120-line) math probe

  function _clearHide() { clearTimeout(_hideTimer); _hideTimer = null; }

  // v5.7.0p10 — deliberate hide grace, DECOUPLED from the 280ms show debounce.
  // Leaving a formula used to hide only once mouse movement paused (the show
  // timer kept resetting on every move → popup lingered while the mouse roamed
  // over prose). Now a per-move probe schedules a fixed short grace the moment
  // the cursor leaves math, so it disappears predictably ~150 ms after.
  function _scheduleHide() {
    if (_hideTimer) return;   // grace already running — don't extend it
    _hideTimer = setTimeout(() => {
      _hideTimer = null;
      if (_katexCaretOwns) return;   // caret typing took over the popup
      popup.classList.remove("visible");
      _lastSrc = null;
    }, 150);
  }

  CM.getWrapperElement().addEventListener("mousemove", e => {
    if (_katexCaretOwns) return;  // v5.7.0p6 — caret overlay owns the popup

    // Cheap per-move check: is the cursor still over math? Throttled so the
    // env probe doesn't run on every single mousemove event.
    const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
    if (now - _lastProbe < 45) return;
    _lastProbe = now;

    const pos  = CM.coordsChar({ left: e.clientX, top: e.clientY });
    const line = pos && CM.getLine(pos.line);
    const math = line ? (_findMathAt(line, pos.ch) || _findMathEnvAt(pos)) : null;

    if (!math) {
      clearTimeout(_hoverTimer);                                  // cancel a pending show
      if (popup.classList.contains("visible")) _scheduleHide();   // fixed grace, then hide
      return;
    }

    // Over math → cancel any pending hide, (re)schedule the throttled render.
    _clearHide();
    clearTimeout(_hoverTimer);
    _hoverTimer = setTimeout(() => {
      if (_katexCaretOwns) return;
      if (math.src === _lastSrc) { popup.classList.add("visible"); return; }  // same formula — just ensure shown
      _lastSrc = math.src;
      popup.innerHTML = "";
      try {
        katex.render(math.src.trim(), popup, { displayMode: math.display, throwOnError: false });
      } catch (err) {
        // v5.7.1 (#3, codex High) — render parser error text via textContent,
        // not innerHTML (err.message is unescaped and could carry markup).
        popup.replaceChildren();
        const _ke = document.createElement("span");
        _ke.className = "katex-error";
        _ke.textContent = err.message;
        popup.appendChild(_ke);
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
    _clearHide();
    if (_katexCaretOwns) return;  // v5.7.0p6 — don't hide the caret overlay
    popup.classList.remove("visible");
    _lastSrc = null;
  });
}

// v5.7.0p6 — KaTeX CARET OVERLAY — the "instant channel" of the live-preview
// initiative (real_time_plan.md §7.4/§8.4). While the caret sits inside a math
// span/env, every buffer change re-renders that equation into the shared
// #katex-preview popup, throttled 150 ms — per-keystroke feedback for the one
// content type that needs it, with zero subprocess/disk cost (KaTeX < 5 ms).
// Show rule: only a buffer CHANGE shows the popup (arrowing through prose must
// not pop previews); once shown, caret movement follows it into a different
// equation and hides it when the caret leaves math. Independent of ⚡ Live mode
// (engine-independent, always on — same spirit as the hover preview).
export function _attachKatexCaret() {
  if (typeof katex === "undefined") return;   // CDN failed — degrade silently
  const popup = document.getElementById("katex-preview");
  if (!popup) return;
  let _timer   = null;
  let _lastSrc = null;

  function _mathAtCaret() {
    const pos  = CM.getCursor();
    const line = CM.getLine(pos.line) || "";
    return _findMathAt(line, pos.ch) || _findMathEnvAt(pos);
  }

  function _hide() {
    if (!_katexCaretOwns) return;
    _katexCaretOwns = false;
    _lastSrc = null;
    popup.classList.remove("visible");
  }

  function _render(math) {
    if (math.src !== _lastSrc) {
      _lastSrc = math.src;
      popup.innerHTML = "";
      try {
        katex.render(math.src.trim(), popup, { displayMode: math.display, throwOnError: false });
      } catch (err) {
        // v5.7.1 (#3, codex High) — render parser error text via textContent,
        // not innerHTML (err.message is unescaped and could carry markup).
        popup.replaceChildren();
        const _ke = document.createElement("span");
        _ke.className = "katex-error";
        _ke.textContent = err.message;
        popup.appendChild(_ke);
      }
    }
    // Anchor above the caret (window coords — popup is position:fixed); flip
    // below when clipped at the top, clamp inside the right edge. Re-measured
    // every render — the popup grows as the equation does.
    const c = CM.cursorCoords(true, "window");
    if (!c) return;
    const pw = Math.min(popup.scrollWidth + 28, 480);
    const ph = popup.scrollHeight || 60;
    let left = c.left + 12;
    let top  = c.top - ph - 12;
    if (left + pw > window.innerWidth - 8) left = Math.max(4, window.innerWidth - 8 - pw);
    if (top < 8) top = (c.bottom != null ? c.bottom : c.top + 18) + 10;
    popup.style.left = left + "px";
    popup.style.top  = top + "px";
    _katexCaretOwns = true;
    popup.classList.add("visible");
  }

  const _sched = () => {
    clearTimeout(_timer);
    _timer = setTimeout(() => {
      const math = _mathAtCaret();
      if (math) _render(math); else _hide();
    }, 150);  // plan §7.4 throttle
  };

  // Buffer change → (re)render or hide. File loads (setValue) also fire this,
  // but land the caret at 0,0 — outside math → clean hide, no phantom popup.
  CM.on("change", _sched);

  // Caret movement without an edit: only relevant while the overlay is shown
  // (follow into another equation / hide on leaving math). Never shows it.
  CM.on("cursorActivity", () => { if (_katexCaretOwns) _sched(); });

  // Click outside the editor (PDF pane, panels…) — caret didn't move, so
  // cursorActivity won't fire; hide explicitly.
  document.addEventListener("mousedown", (e) => {
    if (_katexCaretOwns && !CM.getWrapperElement().contains(e.target)) _hide();
  });
}
