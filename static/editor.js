let currentProject    = null;
let currentFile       = null;

// ── IMAGE FILE DETECTION (ต้องประกาศก่อน saveCurrentFile) ──
const IMAGE_EXTS = new Set(["png","jpg","jpeg","gif","bmp","svg","webp","tiff","tif","ico"]);
function isImageFile(name) {
  return name ? IMAGE_EXTS.has(name.split(".").pop().toLowerCase()) : false;
}
let mainFile          = "main.tex";   // ไฟล์หลักสำหรับ compile
let openTabs          = [];   // [{name, content}]
let saveTimer         = null;
let autoCompile       = false;
let autoCompileTimer  = null;
let wordCountTimer    = null;
let draftMode         = false;   // v3.2.2 — skip figures during compile (per-project)

// v3.2.2 — autocomplete sources for \cite{...} and \ref{...}
// Both are populated by loadCiteData() (per-project) and refreshed after
// every compile. The hint helper below filters on the typed prefix.
let bibkeysCache      = [];   // [{key, type, author, year, title}]
let labelsCache       = [];   // [{name, file, line}]

// v3.2.2 — \includeonly chapter switcher
let availableIncludes = [];   // [{path, line}] from the project's main file
let selectedIncludes  = [];   // subset of availableIncludes paths the user wants compiled

// v3.3.2 — Spell-check state.
//  spellChecker       : Typo instance once en_US is loaded (null until first use)
//  spellLoadingPromise: in-flight load (deduped — never start a second download)
//  spellEnabled       : on/off (mirrors localStorage `texlocal_spellcheck`)
//  spellMarkers       : array of CodeMirror TextMarker handles — cleared and
//                       rebuilt each rescan. Storing them so we don't have to
//                       call findMarks on the whole doc each time.
//  customDict         : per-project Set<string> from `.texlocal-dict.txt`, all
//                       words lower-cased. Reloaded on switchProject. Lets Pol
//                       add Rydberg / Hubbard / bibkey author names without
//                       polluting the global en_US dictionary.
//  spellScanTimer     : debounce handle for on-change rescans.
let spellChecker         = null;
let spellLoadingPromise  = null;
let spellEnabled         = false;
let spellMarkers         = [];
let customDict           = new Set();
let spellScanTimer       = null;
// v4.4.0 — Inline spell suggestions ("word suggestion"). When on, typing a
// word the en_US dict rejects pops a CodeMirror dropdown of corrections — the
// typing-time companion to the right-click "Replace with" menu. INDEPENDENT of
// the red-underline spell check: it loads the same dictionary on demand, so it
// works even with the underline toggle off. Mirrors localStorage
// `texlocal_spellsuggest`; defaults OFF (opt-in, per documented intent).
let spellSuggestEnabled  = false;
let _spellHintTimer      = null;
// v3.3.5 — Hot-reload state. customDictMtime is the file mtime returned by
// the last successful /dict GET. On window focus we re-fetch and only swap
// customDict if the mtime changed — keeps the disk read cheap and avoids
// gratuitous rescans when Pol just alt-tabs back without editing the file.
let customDictMtime      = 0;


// ── CODEMIRROR INIT ──────────────────────────────────────────
// v3.2.3 — LaTeX heading folding. registerHelper runs once and is used by
// foldcode/foldgutter to compute fold ranges. Rules:
//   - Recognised commands: \chapter \section \subsection \subsubsection \paragraph
//   - A heading folds until the line BEFORE the next heading whose level is
//     equal or higher (smaller number).
//   - Levels: chapter=0, section=1, subsection=2, subsubsection=3, paragraph=4.
//   - Optional argument [...] and starred form *  are allowed.
const _LATEX_HEAD_RE = /^\s*\\(chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{/;
const _LATEX_HEAD_LVL = { chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4 };
CodeMirror.registerHelper("fold", "latex-section", function (cm, start) {
  const lineStr = cm.getLine(start.line);
  const m = lineStr && lineStr.match(_LATEX_HEAD_RE);
  if (!m) return null;
  const curLevel = _LATEX_HEAD_LVL[m[1]];
  const lastLine = cm.lastLine();
  let endLine = lastLine;
  for (let i = start.line + 1; i <= lastLine; i++) {
    const nm = cm.getLine(i).match(_LATEX_HEAD_RE);
    if (nm && _LATEX_HEAD_LVL[nm[1]] <= curLevel) {
      endLine = i - 1;
      break;
    }
  }
  if (endLine <= start.line) return null;
  return {
    from: CodeMirror.Pos(start.line, lineStr.length),
    to:   CodeMirror.Pos(endLine, cm.getLine(endLine).length),
  };
});

const cmEditor = CodeMirror(document.getElementById("editor-host"), {
  mode: "stex",
  theme: "default",
  lineNumbers: true,
  lineWrapping: true,
  tabSize: 2,
  indentWithTabs: false,
  autofocus: false,
  // v3.2.3 — foldGutter added between linenumbers and error gutter.
  gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter", "cm-errors-gutter"],
  foldGutter: {
    rangeFinder: CodeMirror.helpers.fold["latex-section"],
  },
  // v3.2.2 — autopair brackets, quotes, and dollars. Pairs typed: ( [ { " ' $.
  // CodeMirror also handles "skip closer if cursor is right before it" and
  // "delete pair on backspace" automatically. The string form lists
  // open/close characters position-paired (index 0 opens index 1 of the
  // partner string, etc.). Backslash-bracket pairs like `\[ \]` aren't
  // covered by this addon (it operates on single chars); they're typed
  // less often and `\[<Tab>` template via snippets covers that case.
  autoCloseBrackets: { pairs: "()[]{}\"\"''$$", explode: "[]{}", closeBefore: ")]}'\":;>$" },
  extraKeys: {
    // v3.3.0 — Snippet expansion + placeholder Tab-cycle. Falls back to
    // the original "insert 2 spaces" if no snippet is matched and no active
    // session is in flight. `_snippetTabHandler` is hoisted via function
    // declaration further down — safe to reference here even though the
    // body comes later in the file.
    "Tab":        cm => _snippetTabHandler(cm),
    "Ctrl-Enter": ()  => compile(),
    "Ctrl-F":     "findPersistent",
    "Ctrl-H":     "replace",
    "Ctrl-G":     "findNext",
    "Shift-Ctrl-G": "findPrev",
    // v3.2.3 — fold/unfold at cursor (mirror VSCode's Ctrl+Shift+[ / ])
    "Ctrl-Shift-[": cm => cm.foldCode(cm.getCursor(), { rangeFinder: CodeMirror.helpers.fold["latex-section"] }),
    "Ctrl-Shift-]": cm => cm.foldCode(cm.getCursor(), { rangeFinder: CodeMirror.helpers.fold["latex-section"] }),
  }
});
let outlineTimer = null;
cmEditor.on("change", () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCurrentFile, 800);
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(updateOutline, 1200);
  if (autoCompile) {
    clearTimeout(autoCompileTimer);
    autoCompileTimer = setTimeout(compile, 3000);
  }
  clearTimeout(wordCountTimer);
  wordCountTimer = setTimeout(updateWordCount, 500);
  // v3.2.3 — cross-ref linter, debounced (defined further below).
  if (typeof scheduleCrossRefLint === "function") scheduleCrossRefLint();
  // v3.3.2 — spell check, debounced. 600ms is long enough that mid-word edits
  // don't repeatedly flash the underline, but short enough to feel responsive
  // when the user pauses. Only runs if Pol has enabled it in Settings.
  if ((spellEnabled || spellSuggestEnabled) && typeof scheduleSpellCheck === "function") scheduleSpellCheck();
});
cmEditor.on("cursorActivity", () => {
  const cur = cmEditor.getCursor();
  document.getElementById("cursor-pos").textContent = `Ln ${cur.line + 1}, Col ${cur.ch + 1}`;
});

// ── v3.2.2 — Image hover preview ─────────────────────────────
// Hover the cursor over `\includegraphics{Figure/02/Beguin}` and a small
// floating panel shows the actual image. Useful when many figures share
// near-identical filenames (Ch.6_Spectroscopic_*.png etc.) and you can't
// remember which path is which.
//
// Path resolution: try the path as-typed first, then with common image
// extensions appended. We don't parse \graphicspath{} for v1 — the
// project-root-relative form covers the vast majority of cases. PDF/EPS
// figures aren't previewable (Image element can't render them) so we
// limit extensions to raster formats.
const _IMG_INC_RE = /\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
const _IMG_EXTS   = ["", ".png", ".jpg", ".jpeg", ".gif"];
let   imgHoverTimer = null;
let   imgHoverLast  = null;

function _showImgPreviewAt(rawPath, x, y) {
  const el = document.getElementById("img-hover-preview");
  el.style.left = (x + 14) + "px";
  el.style.top  = (y + 14) + "px";
  if (rawPath === imgHoverLast) return;   // already showing this image
  imgHoverLast = rawPath;
  // Probe each extension in turn; first 200 wins.
  const proj = encodeURIComponent(currentProject || "");
  const tryNext = (idx) => {
    if (imgHoverLast !== rawPath) return;   // user moved on
    if (idx >= _IMG_EXTS.length) {
      el.innerHTML = `<div class="ihp-err">Image not found in project:<br><code>${escapeHtml(rawPath)}</code></div>`;
      el.style.display = "block";
      return;
    }
    const fullPath = rawPath + _IMG_EXTS[idx];
    const url = `/api/projects/${proj}/raw?path=${encodeURIComponent(fullPath)}`;
    const probe = new Image();
    probe.onload = () => {
      if (imgHoverLast !== rawPath) return;
      el.innerHTML =
        `<img src="${url}" alt="">
         <div class="ihp-cap">${escapeHtml(fullPath)}</div>`;
      el.style.display = "block";
    };
    probe.onerror = () => tryNext(idx + 1);
    probe.src = url;
  };
  tryNext(0);
}
function _hideImgPreview() {
  document.getElementById("img-hover-preview").style.display = "none";
  imgHoverLast = null;
}

(function bindImgHover() {
  const wrap = cmEditor.getWrapperElement();
  wrap.addEventListener("mousemove", e => {
    if (imgHoverTimer) clearTimeout(imgHoverTimer);
    imgHoverTimer = setTimeout(() => {
      // Map mouse → editor (line, ch)
      const pos = cmEditor.coordsChar({ left: e.clientX, top: e.clientY });
      const line = cmEditor.getLine(pos.line);
      if (!line) return _hideImgPreview();
      _IMG_INC_RE.lastIndex = 0;
      let m;
      while ((m = _IMG_INC_RE.exec(line)) !== null) {
        // Path (group 1) sits between the LAST `{` and its matching `}`.
        const argStart = m.index + m[0].lastIndexOf("{") + 1;
        const argEnd   = argStart + m[1].length;
        if (pos.ch >= argStart && pos.ch <= argEnd) {
          return _showImgPreviewAt(m[1].trim(), e.clientX, e.clientY);
        }
      }
      _hideImgPreview();
    }, 90);
  });
  wrap.addEventListener("mouseleave", () => {
    if (imgHoverTimer) clearTimeout(imgHoverTimer);
    _hideImgPreview();
  });
})();

// ── INIT ─────────────────────────────────────────────────────
async function init() {
  // restore saved theme
  const savedTheme = localStorage.getItem("texlocal_theme") || "dark";
  setTheme(savedTheme, true);
  // v3.2.3 — restore saved editor theme (default = light, the original look)
  const savedEditorTheme = localStorage.getItem("texlocal_editor_theme") || "light";
  setEditorTheme(savedEditorTheme, true);
  // restore font & tab size
  const savedFontSize = localStorage.getItem("texlocal_font_size");
  if (savedFontSize) setFontSize(savedFontSize);
  const savedTabSize = localStorage.getItem("texlocal_tab_size");
  if (savedTabSize) setTabSize(savedTabSize);
  await loadProjects();

  // priority 1: URL param (?project=name) — จาก dashboard
  const urlProject = new URLSearchParams(window.location.search).get("project");
  if (urlProject) {
    const sel = document.getElementById("project-select");
    if ([...sel.options].some(o => o.value === urlProject)) {
      sel.value = urlProject;
      await switchProject(urlProject, { openMain: true });
    }
    history.replaceState(null, "", "/editor");
    return;
  }

  // priority 2: restore last session
  const lastProject = localStorage.getItem("texlocal_last_project");
  if (lastProject) {
    const sel = document.getElementById("project-select");
    if ([...sel.options].some(o => o.value === lastProject)) {
      sel.value = lastProject;
      // v4.5.0 — switchProject({openMain:true}) opens the detected main file
      // as part of its parallel startup batch (was a serial openFile here).
      await switchProject(lastProject, { openMain: true });
    }
  }
}

// ── PROJECTS ─────────────────────────────────────────────────
async function loadProjects() {
  const res = await fetch("/api/projects");
  const list = await res.json();
  const sel = document.getElementById("project-select");
  sel.innerHTML = '<option value="">— select project —</option>';
  list.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.name; opt.textContent = p.name;
    sel.appendChild(opt);
  });
  if (currentProject) sel.value = currentProject;
}

function saveCompilerPref(compiler) {
  if (!currentProject) return;
  localStorage.setItem(`texlocal_compiler_${currentProject}`, compiler);
}

function loadCompilerPref(projectName) {
  const saved = localStorage.getItem(`texlocal_compiler_${projectName}`);
  const sel   = document.getElementById("compiler-select");
  sel.value   = saved || "pdflatex";   // default = pdflatex
}

// v3.2.2 — Pull \include{...} list from the project's main file so the
// chapter-selector popup can render checkboxes. Updates `availableIncludes`
// and reconciles `selectedIncludes` (drop entries that no longer exist —
// e.g. user deleted a chapter file).
async function loadIncludes() {
  if (!currentProject) {
    availableIncludes = []; selectedIncludes = [];
    return;
  }
  try {
    const r = await fetch(
      `/api/projects/${encodeURIComponent(currentProject)}/includes`
      + `?main=${encodeURIComponent(mainFile)}`
    );
    if (!r.ok) throw new Error("includes " + r.status);
    const d = await r.json();
    availableIncludes = d.includes || [];
  } catch (_) {
    availableIncludes = [];
  }
  // Reconcile saved selection against current list — keep only paths
  // that still exist as \include{} entries.
  const valid = new Set(availableIncludes.map(i => i.path));
  selectedIncludes = selectedIncludes.filter(p => valid.has(p));
  updateChaptersBadge();
}

// Restore per-project selection from localStorage. Called from
// switchProject after loadIncludes so reconciliation works correctly.
function loadIncludesPref(projectName) {
  try {
    const raw = localStorage.getItem(`texlocal_includeonly_${projectName}`);
    selectedIncludes = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(selectedIncludes)) selectedIncludes = [];
  } catch (_) {
    selectedIncludes = [];
  }
}
function saveIncludesPref() {
  if (!currentProject) return;
  localStorage.setItem(
    `texlocal_includeonly_${currentProject}`,
    JSON.stringify(selectedIncludes),
  );
}

// "PARTIAL" yellow badge in the PDF toolbar — same pattern as draft mode.
// Only visible when the user has narrowed the chapter set; an empty
// selection (which means "compile all") hides it.
function updateChaptersBadge() {
  let badge = document.getElementById("chapters-badge");
  const tb  = document.querySelector(".pdf-toolbar");
  if (!tb) return;
  if (!badge) {
    badge = document.createElement("span");
    badge.id = "chapters-badge";
    badge.title = "Compiling only a subset of chapters via \\includeonly. Click 📑 to adjust.";
    badge.style.cssText =
      "display:inline-block;font:600 9px var(--font-ui);letter-spacing:1px;"
    + "padding:2px 6px;border-radius:3px;background:var(--yellow);color:#0d0f14;"
    + "margin-left:6px;cursor:help;";
    tb.appendChild(badge);
  }
  const partial = selectedIncludes.length > 0
                  && availableIncludes.length > 0
                  && selectedIncludes.length < availableIncludes.length;
  badge.textContent = `PARTIAL (${selectedIncludes.length}/${availableIncludes.length})`;
  badge.style.display = partial ? "inline-block" : "none";
}

// Render the popup. Called when opening, on toggle, on All/None, on
// reload. The list HTML is rebuilt every time but checkbox state lives
// in `selectedIncludes`, so no DOM-event-target issues like the symbol
// panel had — the close handler checks panel.contains() before closing
// and our checkboxes are inside the panel.
function renderChaptersPanel() {
  const list = document.getElementById("cp-list");
  const hint = document.getElementById("cp-hint");
  if (!availableIncludes.length) {
    list.innerHTML =
      `<div class="cp-empty">
         No <code>\\include{}</code> found in
         <strong>${escapeHtml(mainFile)}</strong>.<br><br>
         This feature only applies to projects whose main file uses
         <code>\\include{}</code> for chapters.<br>
         <code>\\input{}</code> is not controllable.
       </div>`;
    hint.textContent = "";
    return;
  }
  const sel = new Set(selectedIncludes);
  hint.textContent = sel.size
                     ? `${sel.size} of ${availableIncludes.length} selected`
                     : "Empty = compile all";
  list.innerHTML = availableIncludes.map(it => {
    const checked = sel.has(it.path) ? "checked" : "";
    return `<label class="cp-row">
              <input type="checkbox" ${checked} onchange="toggleInclude('${escapeAttr(it.path)}', this.checked)">
              <span class="cp-path">${escapeHtml(it.path)}</span>
              <span class="cp-line">L${it.line}</span>
            </label>`;
  }).join("");
}

// Tiny helpers — used for safe HTML interpolation in the panel above.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]
  ));
}
function escapeAttr(s) { return escapeHtml(s).replace(/'/g, "&#39;"); }

// v3.3.0 — Hidden-textarea clipboard fallback. navigator.clipboard works on
// https://localhost but some users open via http://<ip>:5000 (network access)
// where the API is undefined; document.execCommand("copy") still works there.
function _copyFallback(text, onSuccess) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0"; ta.style.pointerEvents = "none";
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    if (typeof onSuccess === "function") onSuccess();
  } catch (e) { /* swallow — the user can still drag-select the text */ }
}

function toggleInclude(path, checked) {
  const idx = selectedIncludes.indexOf(path);
  if (checked && idx < 0) selectedIncludes.push(path);
  else if (!checked && idx >= 0) selectedIncludes.splice(idx, 1);
  saveIncludesPref();
  // Refresh hint text + badge without rebuilding the whole list.
  document.getElementById("cp-hint").textContent =
    selectedIncludes.length
      ? `${selectedIncludes.length} of ${availableIncludes.length} selected`
      : "Empty = compile all";
  updateChaptersBadge();
}

function setAllIncludes(allOn) {
  selectedIncludes = allOn ? availableIncludes.map(i => i.path) : [];
  saveIncludesPref();
  renderChaptersPanel();
  updateChaptersBadge();
}

async function loadIncludesUI() {
  await loadIncludes();
  renderChaptersPanel();
}

// v3.3.7 — Mutual exclusion for toolbar/cog popovers. Until now each panel
// (env, symbols, snippets, chapters, todo, goals, history, settings) opened
// independently — clicking a second toolbar button while another was open
// stacked the new panel on top of the old, partially obscuring it and
// confusing the outside-click dismissal (clicking the visible-but-covered
// panel under the new one would close the *new* one instead of the bottom
// one). Pol's report: "เปิด window ขึ้นมา เช่นช่อง equation แล้วเรากด env
// ตอนนี้มันขึ้น window ซ่อนกัน — แก้แบบถ้าไปกดอันใหม่ก็ให้ขึ้นอันใหม่ไปเลย".
//
// The list is centralised here so adding a new toolbar popover is a
// one-line append, not an N-place edit. The exceptId guard lets each
// toggle function pass its own panel ID — closing the panel about to be
// opened would be a no-op but the early skip is cleaner than relying on
// "already-closed close" being idempotent.
const _TOOLBAR_PANEL_IDS = [
  "chapters-panel", "env-panel", "snippet-panel", "todo-panel",
  "goals-panel", "history-panel", "symbol-panel", "settings-panel",
  "outline-panel"
];
function _closeOtherToolbarPanels(exceptId) {
  for (const id of _TOOLBAR_PANEL_IDS) {
    if (id === exceptId) continue;
    const p = document.getElementById(id);
    if (p && p.classList.contains("open")) p.classList.remove("open");
  }
}

function toggleChaptersPanel(e) {
  const panel = document.getElementById("chapters-panel");
  if (panel.classList.contains("open")) {
    panel.classList.remove("open");
    return;
  }
  _closeOtherToolbarPanels("chapters-panel"); // v3.3.7
  // Position below the toolbar button, right-anchored.
  const btn = document.getElementById("chapters-toggle-btn");
  const rect = btn.getBoundingClientRect();
  const pw   = 320;
  let left   = rect.right - pw;
  if (left < 4) left = 4;
  panel.style.top  = (rect.bottom + 4) + "px";
  panel.style.left = left + "px";
  // Always re-load on open — main file may have changed.
  loadIncludesUI();
  panel.classList.add("open");
  if (e) e.stopPropagation();
}

// Outside-click close — same pattern as the settings/symbol popups.
document.addEventListener("click", e => {
  const panel = document.getElementById("chapters-panel");
  if (!panel || !panel.classList.contains("open")) return;
  if (panel.contains(e.target)) return;
  if (e.target.closest("#chapters-toggle-btn")) return;
  panel.classList.remove("open");
});

// v3.2.2 — Pull aggregated bibkey + label data for autocomplete. Cached on
// the server side, so frequent calls are cheap when nothing has changed.
async function loadCiteData() {
  if (!currentProject) {
    bibkeysCache = []; labelsCache = [];
    lintCrossRefs();   // clear any stale marks
    return;
  }
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/cite-data`);
    if (!r.ok) throw new Error("cite-data " + r.status);
    const d = await r.json();
    bibkeysCache = d.bibkeys || [];
    labelsCache  = d.labels  || [];
  } catch (_) {
    bibkeysCache = []; labelsCache = [];
  }
  // v3.2.3 — refresh the cross-ref linter once the cache lands.
  lintCrossRefs();
}

// ── v3.2.3 — CROSS-REFERENCE LIVE LINTER ───────────────────────
// Walks the active document, finds every \cite{}, \ref{}, \eqref{},
// \autoref{}, \cref{}, \Cref{} call and underlines individual keys (split
// by comma) that aren't present in their respective caches.
//
// `markText` is the CodeMirror v5 API for inline highlights. We collect each
// returned handle so we can clear() them before re-running. Underline only
// the offending key, not the whole call, so a partially-wrong multi-cite
// still surfaces the exact bad key.
const _XREF_RE = /\\(cite|citep|citet|ref|eqref|autoref|cref|Cref)\{([^}]+)\}/g;
let _xrefMarks = [];
let _xrefLintTimer = null;
function lintCrossRefs() {
  if (typeof cmEditor === "undefined" || !cmEditor) return;
  // Clear old marks first — markText handles return objects with .clear()
  for (const m of _xrefMarks) {
    try { m.clear(); } catch (_) {}
  }
  _xrefMarks = [];
  // Skip when both caches are empty (project just loaded, before /cite-data
  // populates them). Otherwise every key would falsely flag as broken.
  if (!bibkeysCache.length && !labelsCache.length) return;
  const bibSet   = new Set(bibkeysCache.map(b => b.key));
  const labelSet = new Set(labelsCache.map(l => l.name));
  const totalLines = cmEditor.lineCount();
  for (let lineNo = 0; lineNo < totalLines; lineNo++) {
    const text = cmEditor.getLine(lineNo);
    if (!text) continue;
    if (text.indexOf("\\cite") < 0 && text.indexOf("\\ref") < 0
        && text.indexOf("\\eqref") < 0 && text.indexOf("\\autoref") < 0
        && text.indexOf("\\cref") < 0 && text.indexOf("\\Cref") < 0) continue;
    _XREF_RE.lastIndex = 0;
    let m;
    while ((m = _XREF_RE.exec(text)) !== null) {
      const cmd       = m[1];
      const inner     = m[2];
      const isCite    = (cmd === "cite" || cmd === "citep" || cmd === "citet");
      const targetSet = isCite ? bibSet : labelSet;
      const innerStart = m.index + cmd.length + 2;   // "\<cmd>{"
      // Each key may be separated by comma + optional whitespace.
      let cursor = 0;
      for (const part of inner.split(",")) {
        const lead = part.match(/^\s*/)[0].length;
        const trimmed = part.trim();
        const keyStart = innerStart + cursor + lead;
        cursor += part.length + 1;             // +1 for comma
        if (!trimmed) continue;
        if (targetSet.has(trimmed)) continue;
        // Found a broken key — mark it with the wavy underline.
        const mark = cmEditor.markText(
          { line: lineNo, ch: keyStart },
          { line: lineNo, ch: keyStart + trimmed.length },
          {
            className: "cm-xref-broken",
            title: isCite
              ? `Citation key not found: ${trimmed}`
              : `Label not found: ${trimmed}`,
          },
        );
        _xrefMarks.push(mark);
      }
    }
  }
}

function scheduleCrossRefLint() {
  // Debounced so it doesn't run on every keystroke. 400ms is fast enough that
  // typing a citation key feels live but slow enough to skip the scan during
  // burst-edits.
  clearTimeout(_xrefLintTimer);
  _xrefLintTimer = setTimeout(lintCrossRefs, 400);
}

// v3.2.2 — Draft mode: stored per-project so a thesis with heavy figures can
// stay in draft while a presentation deck stays in full-render mode.
function loadDraftPref(projectName) {
  draftMode = localStorage.getItem(`texlocal_draft_${projectName}`) === "1";
  const cb = document.getElementById("draft-mode-toggle");
  if (cb) cb.checked = draftMode;
  updateDraftBadge();
}
function onDraftModeToggle() {
  draftMode = document.getElementById("draft-mode-toggle").checked;
  if (currentProject) {
    localStorage.setItem(`texlocal_draft_${currentProject}`, draftMode ? "1" : "0");
  }
  updateDraftBadge();
}
// Small "DRAFT" pill on the PDF toolbar so the user never forgets they're
// looking at a figure-less render. Hidden when draft is off.
function updateDraftBadge() {
  let badge = document.getElementById("draft-badge");
  const tb  = document.querySelector(".pdf-toolbar");
  if (!tb) return;
  if (!badge) {
    badge = document.createElement("span");
    badge.id = "draft-badge";
    badge.textContent = "DRAFT";
    badge.title = "Draft mode is on — figures are not rendered. Toggle in Settings.";
    badge.style.cssText =
      "display:inline-block;font:600 9px var(--font-ui);letter-spacing:1px;"
    + "padding:2px 6px;border-radius:3px;background:var(--yellow);color:#0d0f14;"
    + "margin-left:6px;cursor:help;";
    // place after the zoom controls; if not found, just append to toolbar
    tb.appendChild(badge);
  }
  badge.style.display = draftMode ? "inline-block" : "none";
}

async function switchProject(name, opts) {
  if (!name) return;
  // Cancel any pending auto-save from the previous project — otherwise it
  // could fire after `currentProject` flipped and write into the new project.
  clearTimeout(saveTimer);
  saveTimer = null;
  currentProject = name;
  localStorage.setItem("texlocal_last_project", name);
  loadCompilerPref(name);
  loadDraftPref(name);       // v3.2.2 — restore per-project draft toggle
  loadCiteData();            // v3.2.2 — populate \cite/\ref autocomplete cache
  loadSnippets();            // v3.3.0 — overlay project's custom snippets on defaults
  loadIncludesPref(name);    // v3.2.2 — restore per-project chapter selection
  loadIncludes();            // (async) populate availableIncludes + reconcile
  loadCustomDict(name);      // v3.3.2 — overlay project's .texlocal-dict.txt for spell check
  currentFile = null;
  openTabs = [];
  openFolders.clear();   // fix: clear folder state เมื่อเปลี่ยน project
  mainFile = "main.tex"; // default ก่อน แล้วค่อย detect
  clearErrorMarkers();
  hideErrorPanel();
  renderTabs();
  cmEditor.setValue("");
  document.getElementById("pdf-canvas-container").style.display = "none";
  document.getElementById("pdf-placeholder").style.display = "flex";
  document.getElementById("pdf-download").style.display = "none";
  // v3.2.3 — include the page-jump input + total label so they reset on project switch
  ["pdf-zoom-out","pdf-zoom-in","pdf-zoom-label","pdf-zoom-sep2","pdf-page-input","pdf-page-total"].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = "none";
  });
  document.getElementById("compile-status").textContent = "";
  document.getElementById("compile-status").title       = "";   // v3.3.0 — clear stale stats tooltip on project switch
  // ── Auto-detect main file ──────────────────────────────────
  try {
    const mRes  = await fetch(`/api/projects/${encodeURIComponent(name)}/detect-main`);
    const mData = await mRes.json();
    mainFile = mData.main;
    if (mainFile !== "main.tex") {
      const status = document.getElementById("compile-status");
      status.textContent = `Main: ${mainFile.split("/").pop()}`;
      status.className = "compile-status";
    }
  } catch (_) { /* fallback to main.tex */ }
  // ── Parallel startup (v4.5.0) ──────────────────────────────────────
  // The file-tree, the main file's editor content, and the compiled PDF are
  // all independent. Loading them concurrently — instead of awaiting
  // loadFiles → HEAD → showPDF → openFile in series — markedly cuts the time
  // from "open editor" to "PDF + source on screen". Combined with lazy PDF
  // rasterisation (renderPdfFromUrl), the compiled main file now appears
  // almost immediately even for a 150-page thesis.
  const _startupTasks = [ loadFiles() ];

  const pdfName = mainFile.replace(/\.tex$/, ".pdf");
  _startupTasks.push((async () => {
    try {
      // HEAD avoids downloading the file just to learn if it exists;
      // 404 = no PDF yet (first open) → leave the placeholder visible.
      const chk = await fetch(
        `/api/projects/${encodeURIComponent(name)}/pdf?file=${encodeURIComponent(pdfName)}`,
        { method: "HEAD" }
      );
      if (chk.ok) await showPDF(pdfName);
    } catch (_) { /* network error — leave placeholder */ }
  })());

  // v4.5.0 — open the detected main file's source as part of the same batch
  // (callers that want it pass { openMain: true }).
  if (opts && opts.openMain && mainFile) _startupTasks.push(openFile(mainFile));

  await Promise.allSettled(_startupTasks);
}

function showNewProject() {
  document.getElementById("input-project-name").value = "";
  openModal("modal-project");
  setTimeout(() => document.getElementById("input-project-name").focus(), 100);
}

async function createProject() {
  const name = document.getElementById("input-project-name").value.trim();
  if (!name) return;
  await fetch("/api/projects", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({name}) });
  closeModal("modal-project");
  await loadProjects();
  document.getElementById("project-select").value = name;
  await switchProject(name);
}

// ── FILES ─────────────────────────────────────────────────────
const openFolders = new Set(); // เก็บ path ของ folder ที่ขยายอยู่

function buildFileTree(files) {
  // แปลง flat list เป็น nested object
  // root = { __files: [...], folderName: { __files: [...], ... }, ... }
  const root = { __files: [] };
  files.forEach(f => {
    const parts = f.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts[i];
      if (!node[dir]) node[dir] = { __files: [] };
      node = node[dir];
    }
    node.__files.push(f);
  });
  return root;
}

function renderFileTree(node, container, depth = 0, prefix = "") {
  const indent = 14 + depth * 16;
  // โฟลเดอร์ก่อน (เรียง A-Z)
  const folders = Object.keys(node).filter(k => k !== "__files").sort();
  folders.forEach(folder => {
    const fullPath = prefix ? `${prefix}/${folder}` : folder;
    const isOpen = openFolders.has(fullPath);

    const div = document.createElement("div");
    div.className = "file-item folder-item";
    div.style.paddingLeft = indent + "px";
    div.innerHTML = `
      <span class="folder-arrow ${isOpen ? "open" : ""}">▶</span>
      <span class="file-icon">${isOpen ? "📂" : "📁"}</span>
      <span style="overflow:hidden;text-overflow:ellipsis">${folder}</span>
    `;
    div.onclick = () => {
      if (openFolders.has(fullPath)) openFolders.delete(fullPath);
      else openFolders.add(fullPath);
      loadFiles();
    };
    // ── drop target: รับไฟล์มาวางใน folder นี้
    div.addEventListener("dragover", e => {
      e.preventDefault(); e.stopPropagation();
      div.classList.add("drag-over");
    });
    div.addEventListener("dragleave", () => div.classList.remove("drag-over"));
    div.addEventListener("drop", async e => {
      e.preventDefault(); e.stopPropagation();
      div.classList.remove("drag-over");
      const src = e.dataTransfer.getData("text/plain");
      if (!src) return;
      const filename = src.split("/").pop();
      await moveFile(src, `${fullPath}/${filename}`);
      openFolders.add(fullPath); // auto-expand หลัง drop
    });
    container.appendChild(div);

    if (isOpen) {
      renderFileTree(node[folder], container, depth + 1, fullPath);
    }
  });

  // ไฟล์ (เรียง A-Z)
  const files = (node.__files || []).sort();
  files.forEach(filePath => {
    const filename = filePath.split("/").pop();
    const div = document.createElement("div");
    div.className = "file-item" + (filePath === currentFile ? " active" : "");
    div.style.paddingLeft = indent + "px";
    const icon = filePath.endsWith(".tex") ? "📄"
               : filePath.endsWith(".bib") ? "📚"
               : filePath.endsWith(".pdf") ? "📕" : "📎";
    const isMain = filePath === mainFile;
    const isTex  = filePath.endsWith(".tex");
    div.innerHTML = `
      <span class="file-icon">${icon}</span>
      <span class="file-label" style="overflow:hidden;text-overflow:ellipsis;flex:1">${filename}</span>
      ${isTex ? `<span class="file-star${isMain ? " is-main" : ""}" title="${isMain ? "Main file" : "Set as main file"}">★</span>` : ""}
      <span class="file-ren" title="Rename">✏</span>
      <span class="file-del">✕</span>
    `;
    if (isTex) {
      div.querySelector(".file-star").onclick = e => {
        e.stopPropagation();
        setMainFile(filePath);
      };
    }
    div.querySelector(".file-ren").onclick = e => { e.stopPropagation(); startRenameFile(div, filePath); };
    div.querySelector(".file-del").onclick = e => deleteFile(e, filePath);
    div.ondblclick = e => { e.stopPropagation(); startRenameFile(div, filePath); };
    div.onclick = () => openFile(filePath);
    // ── draggable source
    div.draggable = true;
    div.addEventListener("dragstart", e => {
      e.dataTransfer.setData("text/plain", filePath);
      e.dataTransfer.effectAllowed = "move";
      e.stopPropagation();
      setTimeout(() => div.classList.add("dragging"), 0);
    });
    div.addEventListener("dragend", () => div.classList.remove("dragging"));
    container.appendChild(div);
  });
}

// ไฟล์ generated ที่ซ่อนจาก file tree
const HIDDEN_EXTS = new Set([
  "aux","log","toc","out","bbl","blg","fls","bcf",
  "lof","lot","nav","snm","vrb","xdv","run.xml","fdb_latexmk",
  "pdf"   // PDF output ดูได้จาก preview panel อยู่แล้ว
]);
function isGeneratedFile(path) {
  const name = path.split("/").pop().toLowerCase();
  if (name === ".keep") return true;
  if (name.endsWith(".synctex.gz") || name.endsWith(".synctex(busy)")) return true;
  const ext = name.includes(".") ? name.split(".").pop() : "";
  return HIDDEN_EXTS.has(ext);
}

async function loadFiles() {
  if (!currentProject) return;
  const res = await fetch(`/api/projects/${currentProject}/files`);
  const allFiles = await res.json();
  const files = allFiles.filter(f => !isGeneratedFile(f));   // ซ่อนไฟล์ขยะ
  // v3.2.3 — keep a flat cache for the Ctrl+P quick-open modal so it doesn't
  // need its own fetch on every invocation.
  setQuickOpenFiles(files);
  const container = document.getElementById("file-tree");
  container.innerHTML = "";
  const treeData = buildFileTree(files);
  renderFileTree(treeData, container);

  // แสดง "auto" badge ถ้ามี .bib file อยู่ใน project
  const hasBib = files.some(f => f.endsWith(".bib"));
}

async function openFile(name) {
  if (!currentProject) return;
  // CRITICAL: cancel any pending auto-save BEFORE we change `currentFile`.
  // Without this, a saveTimer queued for the OLD file can fire during the
  // async fetch below, while currentFile already points to the NEW file but
  // the editor still holds the OLD content — that writes the OLD content
  // into the NEW file and corrupts it.
  clearTimeout(saveTimer);
  saveTimer = null;
  await saveCurrentFile();
  currentFile = name;
  localStorage.setItem(`texlocal_last_file_${currentProject}`, name);

  if (isImageFile(name)) {
    // ── IMAGE VIEWER ──────────────────────────────────────
    document.getElementById("editor-host").style.display  = "none";
    const viewer = document.getElementById("image-viewer");
    viewer.style.display = "flex";
    const url  = `/api/projects/${encodeURIComponent(currentProject)}/raw?path=${encodeURIComponent(name)}`;
    const ext  = name.split(".").pop().toLowerCase();
    const fname = name.split("/").pop();
    if (ext === "pdf") {
      viewer.innerHTML = `
        <div class="img-info">${fname} — เปิดดูได้ใน PDF Preview panel</div>
        <iframe src="${url}" style="flex:1;width:100%;border:none;border-radius:4px;"></iframe>`;
    } else {
      const img = new Image();
      img.src = url;
      img.onload = () => {
        viewer.innerHTML = `
          <img src="${url}" alt="${fname}">
          <div class="img-info">${fname} &nbsp;·&nbsp; ${img.naturalWidth} × ${img.naturalHeight} px</div>`;
      };
      img.onerror = () => {
        viewer.innerHTML = `<div class="img-info" style="color:var(--red)">ไม่สามารถแสดงรูปภาพนี้ได้</div>`;
      };
      viewer.innerHTML = `<div class="img-info">⏳ Loading…</div>`;
    }
    if (!openTabs.find(t => t.name === name)) openTabs.push({ name, content: "" });
    renderTabs();
    loadFiles();
    return;
  }

  // ── TEXT EDITOR ───────────────────────────────────────
  document.getElementById("image-viewer").style.display  = "none";
  document.getElementById("editor-host").style.display   = "";
  const res  = await fetch(`/api/projects/${currentProject}/file?path=${encodeURIComponent(name)}`);
  const data = await res.json();
  if (!openTabs.find(t => t.name === name)) openTabs.push({ name, content: data.content });
  else openTabs.find(t => t.name === name).content = data.content;
  cmEditor.setValue(data.content);
  cmEditor.clearHistory();
  clearErrorMarkers();
  const ext = name.split(".").pop();
  cmEditor.setOption("mode", ext === "bib" ? "bibtex" : "stex");
  renderTabs();
  loadFiles();
  updateOutline();
  updateWordCount();
}

function renderTabs() {
  const container = document.getElementById("editor-tabs");
  container.innerHTML = "";
  openTabs.forEach(t => {
    const div = document.createElement("div");
    div.className = "tab" + (t.name === currentFile ? " active" : "");
    div.textContent = t.name.split("/").pop();
    div.onclick = () => openFile(t.name);
    container.appendChild(div);
  });
}

async function saveCurrentFile() {
  if (!currentProject || !currentFile) return;
  if (isImageFile(currentFile)) return;   // ห้าม save ทับไฟล์รูปภาพ
  // Snapshot the path/project at call-time. If `currentFile` flips while the
  // POST is in flight, we still write the editor's content to the file the
  // editor was actually displaying — never to the next file we just opened.
  const fileAtSave = currentFile;
  const projAtSave = currentProject;
  const content    = cmEditor.getValue();
  await fetch(`/api/projects/${encodeURIComponent(projAtSave)}/file`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ path: fileAtSave, content })
  });
}

// auto-save และ tab key ถูก handle โดย CodeMirror แล้ว

// ── OUTLINE ───────────────────────────────────────────────────
function parseOutline(content) {
  const pattern = /^[ \t]*\\(chapter|section|subsection|subsubsection)\*?\{([^}]+)\}/;
  return content.split("\n").reduce((acc, line, i) => {
    const m = line.match(pattern);
    if (m) acc.push({ level: m[1], title: m[2], line: i });
    return acc;
  }, []);
}

function renderOutline(items) {
  const el = document.getElementById("outline-tree");
  if (!items.length) {
    el.innerHTML = '<div class="outline-empty">No sections found</div>';
    return;
  }
  el.innerHTML = "";
  items.forEach(({ level, title, line }) => {
    const div = document.createElement("div");
    div.className = `outline-item lvl-${level}`;
    div.textContent = title;
    div.title = title;
    div.onclick = () => {
      cmEditor.setCursor(line, 0);
      cmEditor.scrollIntoView({ line, ch: 0 }, 80);
      cmEditor.focus();
    };
    el.appendChild(div);
  });
}

function updateOutline() {
  const ext = (currentFile || "").split(".").pop();
  if (ext !== "tex") {
    document.getElementById("outline-tree").innerHTML = '<div class="outline-empty">Only for .tex files</div>';
    return;
  }
  renderOutline(parseOutline(cmEditor.getValue()));
}

function toggleOutline() {
  const sec = document.getElementById("outline-section");
  const btn = document.getElementById("outline-toggle");
  sec.classList.toggle("collapsed");
  btn.textContent = sec.classList.contains("collapsed") ? "+" : "−";
}

// ── MOVE FILE ─────────────────────────────────────────────────
function startRenameFile(div, filePath) {
  const labelEl = div.querySelector(".file-label");
  const dir     = filePath.includes("/") ? filePath.substring(0, filePath.lastIndexOf("/") + 1) : "";
  const oldName = filePath.split("/").pop();

  const input = document.createElement("input");
  input.className = "file-rename-input";
  input.value = oldName;
  labelEl.replaceWith(input);
  div.onclick = null;
  input.focus();
  input.select();

  const commit = async () => {
    const newName = input.value.trim();
    if (newName && newName !== oldName) {
      await moveFile(filePath, dir + newName);
    } else {
      await loadFiles();
    }
  };
  input.onkeydown = async e => {
    if (e.key === "Enter")  { e.preventDefault(); await commit(); }
    if (e.key === "Escape") { await loadFiles(); }
  };
  input.onblur = commit;
}

async function moveFile(src, dst) {
  if (!src || !dst || src === dst) return;
  const res = await fetch(`/api/projects/${currentProject}/movefile`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ src, dst })
  });
  const data = await res.json();
  if (data.ok) {
    // อัปเดต currentFile และ tabs ถ้าไฟล์ที่ย้ายกำลังเปิดอยู่
    if (currentFile === src) currentFile = dst;
    const tab = openTabs.find(t => t.name === src);
    if (tab) tab.name = dst;
    renderTabs();
    await loadFiles();
  }
}

// root drop zone (ลากออกมาวางในพื้นที่ว่าง = ย้ายไป root)
;(function() {
  const treeEl = document.getElementById("file-tree");
  treeEl.addEventListener("dragover", e => {
    e.preventDefault();
    treeEl.classList.add("drag-over-root");
  });
  treeEl.addEventListener("dragleave", e => {
    if (!treeEl.contains(e.relatedTarget))
      treeEl.classList.remove("drag-over-root");
  });
  treeEl.addEventListener("drop", async e => {
    e.preventDefault();
    treeEl.classList.remove("drag-over-root");
    const src = e.dataTransfer.getData("text/plain");
    if (!src) return;
    const filename = src.split("/").pop();
    if (src === filename) return; // อยู่ root อยู่แล้ว
    await moveFile(src, filename);
  });
})();

// ── UPLOAD FILES ─────────────────────────────────────────────
function triggerUpload() {
  if (!currentProject) return alert("Select a project first.");
  document.getElementById("upload-input").value = "";
  document.getElementById("upload-input").click();
}

async function handleUpload(fileList) {
  if (!fileList || !fileList.length || !currentProject) return;
  const status = document.getElementById("compile-status");
  status.textContent = `Uploading ${fileList.length} file(s)…`;
  status.className = "compile-status";

  const form = new FormData();
  for (const f of fileList) form.append("files", f);

  const res  = await fetch(`/api/projects/${currentProject}/upload`, { method: "POST", body: form });
  const data = await res.json();
  if (data.ok) {
    status.textContent = `✓ Uploaded ${data.files.length} file(s)`;
    status.className = "compile-status ok";
    await loadFiles();
  } else {
    status.textContent = "✗ Upload failed";
    status.className = "compile-status err";
  }
}

// Drag-and-drop upload onto file tree
;(function() {
  const tree = document.getElementById("file-tree");
  tree.addEventListener("dragenter", e => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); tree.classList.add("upload-hover"); } });
  tree.addEventListener("dragover",  e => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); } });
  tree.addEventListener("dragleave", e => { if (!tree.contains(e.relatedTarget)) tree.classList.remove("upload-hover"); });
  tree.addEventListener("drop", async e => {
    tree.classList.remove("upload-hover");
    if (!e.dataTransfer.files.length) return;
    // ถ้าเป็นไฟล์จากภายนอก (ไม่ใช่ drag-and-drop ไฟล์ภายใน)
    const isExternal = !e.dataTransfer.getData("text/plain");
    if (!isExternal) return;
    e.preventDefault(); e.stopPropagation();
    await handleUpload(e.dataTransfer.files);
  });
})();

// ── IMPORT ZIP ────────────────────────────────────────────────
function onZipSelected(input) {
  const file = input.files[0];
  if (!file) return;
  document.getElementById("zip-drop-label").textContent = `📦 ${file.name}`;
  const name = file.name.replace(/\.zip$/i, "").replace(/[^a-zA-Z0-9_\- ]/g, "_");
  document.getElementById("input-zip-name").value = name;
}

;(function() {
  const zone = document.getElementById("zip-drop-zone");
  zone.addEventListener("dragover",  e => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", e => {
    e.preventDefault(); zone.classList.remove("over");
    const file = e.dataTransfer.files[0];
    if (!file || !file.name.endsWith(".zip")) return alert("Please drop a .zip file");
    document.getElementById("zip-file-input").files; // can't set directly
    // manually set via DataTransfer trick
    const dt = new DataTransfer(); dt.items.add(file);
    document.getElementById("zip-file-input").files = dt.files;
    onZipSelected(document.getElementById("zip-file-input"));
  });
})();

async function importZip() {
  const fileInput = document.getElementById("zip-file-input");
  const name      = document.getElementById("input-zip-name").value.trim();
  if (!fileInput.files[0]) return alert("Please select a ZIP file.");
  if (!name)               return alert("Please enter a project name.");

  const btn = document.getElementById("import-zip-btn");
  btn.textContent = "Importing…"; btn.disabled = true;

  const form = new FormData();
  form.append("file", fileInput.files[0]);
  form.append("name", name);

  const res  = await fetch("/api/import-zip", { method: "POST", body: form });
  const data = await res.json();
  btn.textContent = "Import"; btn.disabled = false;

  if (data.ok) {
    closeModal("modal-import-zip");
    await loadProjects();
    document.getElementById("project-select").value = data.name;
    await switchProject(data.name);
  } else {
    alert("Import failed: " + data.error);
  }
}

function setMainFile(path) {
  mainFile = path;
  const status = document.getElementById("compile-status");
  status.textContent = `Main: ${path.split("/").pop()}`;
  status.className = "compile-status";
  loadFiles();  // re-render stars
  // v3.2.2 — \include{} list is keyed off the main file; if the user
  // switches main, refresh availableIncludes (and reconcile the saved
  // selection) so the popup reflects the new file's chapters.
  loadIncludes();
}

function showNewFolder() {
  if (!currentProject) return alert("Select a project first.");
  document.getElementById("input-folder-name").value = "";
  openModal("modal-folder");
  setTimeout(() => document.getElementById("input-folder-name").focus(), 100);
}

async function createFolder() {
  const name = document.getElementById("input-folder-name").value.trim();
  if (!name) return;
  await fetch(`/api/projects/${currentProject}/newfolder`, {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ path: name })
  });
  closeModal("modal-folder");
  openFolders.add(name);   // auto-expand folder ใหม่
  await loadFiles();
}

function showNewFile() {
  if (!currentProject) return alert("Select a project first.");
  document.getElementById("input-file-name").value = "";
  openModal("modal-file");
  setTimeout(() => document.getElementById("input-file-name").focus(), 100);
}

async function createFile() {
  const name = document.getElementById("input-file-name").value.trim();
  if (!name) return;
  await fetch(`/api/projects/${currentProject}/newfile`, {
    method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({path:name})
  });
  closeModal("modal-file");
  await loadFiles();
  openFile(name);
}

async function deleteFile(e, name) {
  e.stopPropagation();
  if (!confirm(`Delete ${name}?`)) return;
  // Cancel pending auto-save before nuking the file — otherwise the timer
  // could re-create the file we just asked the server to delete.
  if (currentFile === name) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await fetch(`/api/projects/${currentProject}/file?path=${encodeURIComponent(name)}`, { method:"DELETE" });
  if (currentFile === name) {
    currentFile = null;
    openTabs = openTabs.filter(t => t.name !== name);
    cmEditor.setValue("");
    renderTabs();
  }
  loadFiles();
}

// ── ERROR MARKERS + PANEL ────────────────────────────────────
let lastParsedLog = null;   // เก็บ parsed result ล่าสุดไว้เปิด Logs panel ได้เสมอ
let logsActiveTab = "all";  // tab ที่เลือกอยู่ใน Logs panel

function parseLatexErrors(log) {
  const errors = [], warnings = [], infos = [];
  const lines = log.split("\n");
  // v3.3.0 — Missing-package detection. Tracks packages/classes the user
  // doesn't have installed; surfaced as a dedicated card with an `mpm
  // --install=<pkg>` copy button. Dedup by name so spam from a hundred
  // re-runs doesn't compound. We deliberately collect AS WELL AS leaving
  // the original error in `errors[]` — the user sees both "package missing"
  // (with install hint) AND the raw "! LaTeX Error" message (for context).
  const missingPackages = [];
  const seenPkg = new Set();
  const addPkg = (name, kind) => {
    if (!name) return;
    // Strip path prefix (rare; defensive) and extension.
    const stem = name.replace(/^.*[\\\/]/, "").replace(/\.(sty|cls)$/i, "");
    if (!stem || seenPkg.has(stem)) return;
    seenPkg.add(stem);
    missingPackages.push({ name: stem, kind });
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];

    // v3.3.0 — Missing-package patterns. Three forms seen in the wild:
    //   `! LaTeX Error: File `foo.sty' not found.`     (MiKTeX, TeX Live)
    //   `! Package foo Error: ... bar.sty not found.`  (some packages)
    //   `! I can't find file `foo'.`                   (older TeX, no ext)
    // We scan separately from Patterns A/B so the missing-package card can
    // still appear even if the surrounding message also matches one of those
    // (it almost always does — the "! LaTeX Error" line is also Pattern B).
    let mPkg = l.match(/^!\s*LaTeX\s+Error:\s*File\s+[`'"]([^'"`]+\.(?:sty|cls))['"`]\s+not\s+found/i);
    if (mPkg) addPkg(mPkg[1], /\.cls$/i.test(mPkg[1]) ? "class" : "package");
    else {
      mPkg = l.match(/^!\s*I\s+can'?t\s+find\s+file\s+[`'"]([^'"`]+?)(?:\.(?:sty|cls))?['"`]/i);
      if (mPkg) addPkg(mPkg[1], "package");
    }

    // Pattern A: ./file.tex:LINE: message
    const mA = l.match(/^((?:\.\/)?[^:\n]+\.tex):(\d+):\s*(.+)$/);
    if (mA) {
      const msg = mA[3].trim();
      if (msg && !msg.startsWith("(")) {
        errors.push({ file: mA[1].replace(/^\.\//, ""), line: parseInt(mA[2]) - 1, msg });
      }
      continue;
    }

    // Pattern B: ! Error → look ahead for l.N
    const mB = l.match(/^! (.+)$/);
    if (mB) {
      let lineNo = -1;
      for (let j = i + 1; j < Math.min(i + 15, lines.length); j++) {
        const mL = lines[j].match(/^l\.(\d+)/);
        if (mL) { lineNo = parseInt(mL[1]) - 1; break; }
      }
      errors.push({ file: null, line: lineNo, msg: mB[1].trim() });
      continue;
    }

    // Pattern C: Overfull / Underfull \hbox
    const mOF = l.match(/^((?:Over|Under)full \\[hv]box[^)]*\))\s+(?:detected at line (\d+)|in paragraph at lines (\d+))/i);
    if (mOF) {
      const lineNo = parseInt(mOF[2] || mOF[3]) - 1;
      warnings.push({ file: null, line: lineNo, msg: mOF[0].trim() });
      continue;
    }

    // Pattern D: LaTeX Warning / Package Warning ... on input line N
    const mW = l.match(/(?:LaTeX|Package\s+\S+)\s+Warning[:\s]+(.*?)(?:\s+on input line (\d+))?\.?\s*$/i);
    if (mW) {
      const msg = mW[1].trim() || l.trim();
      const lineNo = mW[2] ? parseInt(mW[2]) - 1 : -1;
      warnings.push({ file: null, line: lineNo, msg });
      continue;
    }

    // Pattern E: Info messages
    const mI = l.match(/^(?:LaTeX|Package\s+\S+)\s+(?:Font\s+)?Info[:\s]+(.+)$/i);
    if (mI) {
      infos.push({ file: null, line: -1, msg: mI[1].trim() });
      continue;
    }
  }

  const dedup = arr => {
    const seen = new Set();
    return arr.filter(e => {
      const key = `${e.file}:${e.line}:${e.msg.slice(0,60)}`;
      if (seen.has(key)) return false; seen.add(key); return true;
    });
  };
  return { errors: dedup(errors), warnings: dedup(warnings), infos: dedup(infos),
           missingPackages };   // v3.3.0
}

function showErrorPanel({ errors, warnings }) {
  const panel = document.getElementById("error-panel");
  const title = document.getElementById("pdf-pane-title");

  document.getElementById("pdf-canvas-container").style.display = "none";
  document.getElementById("pdf-placeholder").style.display = "none";

  const errCount  = errors.length;
  const warnCount = warnings.length;

  panel.innerHTML = `
    <div class="err-panel-header" id="err-panel-hdr">
      <span class="err-summary">
        ${errCount  ? `<span style="color:var(--red)">✕ ${errCount} error${errCount>1?"s":""}</span>` : ""}
        ${errCount && warnCount ? "<span style='color:var(--muted)'>&nbsp;·&nbsp;</span>" : ""}
        ${warnCount ? `<span style="color:var(--yellow)">! ${warnCount} warning${warnCount>1?"s":""}</span>` : ""}
      </span>
    </div>
    <div class="err-cards" id="err-cards"></div>
  `;

  // ใช้ position:absolute inset:0 ใน .pdf-content wrapper — ไม่ต้องวัด height เอง
  panel.classList.add("visible");

  title.textContent = "Compile Errors";

  const cards = document.getElementById("err-cards");

  // v3.3.0 — Missing-package install hints at the very top, before raw
  // errors/warnings. These are the most actionable items in the panel:
  // the rest of the cascade (Undefined control sequence, etc.) is almost
  // always downstream of the missing .sty file, so once the user clicks
  // Install the rest typically vanishes.
  const missing = (lastParsedLog && lastParsedLog.missingPackages) || [];
  missing.forEach(pkg => {
    const card = document.createElement("div");
    card.className = "err-card err-missing-pkg";
    // MiKTeX users get `mpm --install=<pkg>`; TeX Live users get
    // `tlmgr install <pkg>`. We show MiKTeX as the primary (Pol's setup)
    // and TeX Live as the secondary tip. Class files (.cls) use the same
    // commands — pkgname without extension is what the installers expect.
    const cmdMiktex = `mpm --install=${pkg.name}`;
    card.innerHTML = `
      <div class="err-header">
        <span class="err-icon">📦</span>
        <span class="err-msg">Missing ${pkg.kind}: <b>${escapeHtml(pkg.name)}</b><br>
          <span style="color:var(--muted);font-family:var(--font-ui);font-size:11px">
            Install via MiKTeX Package Manager — or <code style="font-family:var(--font-code)">tlmgr install ${escapeHtml(pkg.name)}</code> on TeX Live.
          </span>
        </span>
      </div>
      <div class="err-mpkg-row">
        <code class="err-mpkg-cmd">${escapeHtml(cmdMiktex)}</code>
        <button class="err-mpkg-copy" type="button">Copy</button>
      </div>
    `;
    const btn = card.querySelector(".err-mpkg-copy");
    btn.onclick = () => {
      // navigator.clipboard fails over http on some browsers; fallback to
      // a hidden textarea + execCommand("copy") which works everywhere.
      const txt = cmdMiktex;
      const ok = () => {
        btn.textContent = "Copied!"; btn.classList.add("copied");
        setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(ok, () => _copyFallback(txt, ok));
      } else {
        _copyFallback(txt, ok);
      }
    };
    cards.appendChild(card);
  });

  const allItems = [
    ...errors.map(e  => ({ ...e, isError: true  })),
    ...warnings.map(w => ({ ...w, isError: false }))
  ];

  // v3.3.2 — Group repeated errors by shape. The same `\foo` typo in a macro
  // cascades to "Undefined control sequence \foo" at every use site, producing
  // 12+ identical cards in figure-heavy chapters. Grouping collapses them to
  // one card with a ×N badge; clicking the badge/chevron expands the list of
  // file:line occurrences. Order of cards is preserved by FIRST occurrence
  // (so the topmost group is the first error to surface) — important because
  // the root cause is almost always the first one chronologically.
  const groups = _groupErrorItems(allItems);
  groups.forEach(group => {
    const rep = group.rep;
    const n = group.occurrences.length;
    const card = document.createElement("div");
    card.className = `err-card ${rep.isError ? "err-error" : "err-warn"}`;
    const locText = [rep.file, rep.line >= 0 ? `line ${rep.line + 1}` : null]
      .filter(Boolean).join(", ");

    // Singleton (n===1): same UX as v3.3.1 — just the .err-nav arrow.
    // Multi (n>1): hide .err-nav, show ×N pill + chevron. Both pill and
    // chevron toggle the .err-expanded class on the card to reveal the list.
    let headerExtra = "";
    if (n > 1) {
      headerExtra = `<span class="err-count-badge" title="${n} occurrences — click to expand">×${n}</span>
                     <button class="err-chev" title="Show all occurrences" aria-label="Expand occurrences">▶</button>`;
    } else if (rep.line >= 0) {
      headerExtra = `<button class="err-nav" title="Jump to line">↗</button>`;
    }

    card.innerHTML = `
      <div class="err-header">
        <span class="err-icon">${rep.isError ? "✕" : "!"}</span>
        <span class="err-msg">${rep.msg}</span>
        ${headerExtra}
      </div>
      ${locText ? `<div class="err-loc">${locText}${n > 1 ? ` · +${n - 1} more` : ""}</div>` : ""}
      ${n > 1 ? `<div class="err-occurrences"></div>` : ""}
    `;

    if (n === 1 && rep.line >= 0) {
      card.querySelector(".err-nav").onclick = () => {
        cmEditor.setCursor(rep.line, 0);
        cmEditor.scrollIntoView({ line: rep.line, ch: 0 }, 80);
        cmEditor.focus();
      };
    } else if (n > 1) {
      // Populate the occurrences list lazily — only build DOM rows when
      // first expanded. For groups with 50+ occurrences (worst case: a
      // missing \def cascade) this saves a chunk of init work.
      const occList = card.querySelector(".err-occurrences");
      const chev    = card.querySelector(".err-chev");
      const badge   = card.querySelector(".err-count-badge");
      let populated = false;
      const populate = () => {
        if (populated) return;
        populated = true;
        group.occurrences.forEach(occ => {
          const row = document.createElement("button");
          row.className = "err-occ-row";
          row.type = "button";
          const where = [occ.file, occ.line >= 0 ? `line ${occ.line + 1}` : "(no line)"]
            .filter(Boolean).join(", ");
          row.textContent = `↗  ${where}`;
          if (occ.line >= 0) {
            row.onclick = () => {
              cmEditor.setCursor(occ.line, 0);
              cmEditor.scrollIntoView({ line: occ.line, ch: 0 }, 80);
              cmEditor.focus();
            };
          } else {
            row.disabled = true;
            row.style.cursor = "default";
          }
          occList.appendChild(row);
        });
      };
      const toggle = (e) => {
        e.stopPropagation();
        populate();
        card.classList.toggle("err-expanded");
      };
      if (chev)  chev.onclick  = toggle;
      if (badge) badge.onclick = toggle;
    }
    cards.appendChild(card);
  });
}

// v3.3.2 — Shape-based key generator for error grouping. Strips variable parts
// (line numbers in trailing "on input line NNN" / "at lines XXX-YYY" /
// "detected at line N") so two warnings with the same root cause at different
// lines collapse. Keeps the meaningful token (e.g. \foo) intact — distinct
// undefined sequences are different groups, not one mega-bucket.
function _errorGroupKey(item) {
  let key = (item.msg || "").trim();
  // Drop trailing line-number tails that LaTeX appends to warnings.
  key = key.replace(/\s+on input line\s+\d+\.?$/gi, "");
  key = key.replace(/\s+(?:at|in paragraph at)\s+lines?\s+\d+(?:-{1,2}\d+)?\.?$/gi, "");
  key = key.replace(/\s+detected at line\s+\d+\.?$/gi, "");
  // v3.3.2 — Defensive: strip line refs even if NOT at end of string. Some
  // pdflatex setups (and some package warnings) embed "l.NNN" or "line NNN"
  // mid-message — without these stripped, the same root cause at different
  // lines wouldn't collapse. We use \b boundaries so we don't eat actual
  // words containing "line" (e.g. "lineart").
  key = key.replace(/\s*\bl\.\d+\b/gi, "");
  key = key.replace(/\s+\bline\s+\d+\b/gi, "");
  key = key.replace(/\s+\blines?\s+\d+(?:[-–—]\d+)?\b/gi, "");
  // Collapse repeated whitespace introduced by stripping.
  key = key.replace(/\s+/g, " ").trim();
  // Trailing period is decorative — strip so "Foo." and "Foo" merge.
  key = key.replace(/\.+$/, "");
  // Severity is part of the key so an error and a warning with identical text
  // (rare but possible) stay separate.
  return `${item.isError ? "E" : "W"}|${key.toLowerCase()}`;
}

function _groupErrorItems(items) {
  // Map iteration is insertion-ordered so the first-seen group ends up first
  // in the rendered list — matches users' "fix the first error first" mental
  // model better than sorting by count.
  const groups = new Map();
  for (const item of items) {
    const key = _errorGroupKey(item);
    if (!groups.has(key)) {
      groups.set(key, { rep: item, occurrences: [] });
    }
    groups.get(key).occurrences.push(item);
  }
  // v3.3.2 diagnostic — helps confirm grouping path is live after refresh.
  // Console.debug is filtered out by default (won't spam regular browsing);
  // visible only when DevTools "Verbose" log level is on. Leave permanently —
  // tiny cost, big win for next-time-something-feels-off triage.
  try {
    const summary = [...groups.values()].map(g => `${g.occurrences.length}× "${(g.rep.msg||"").slice(0,32)}"`);
    console.debug("[err-group]", items.length, "items →", groups.size, "groups", summary);
  } catch (_) {}
  return [...groups.values()];
}

function hideErrorPanel() {
  const panel = document.getElementById("error-panel");
  panel.classList.remove("visible");
  panel.innerHTML = "";
  document.getElementById("pdf-pane-title").textContent = "PDF Preview";
}

// ── LOGS PANEL ────────────────────────────────────────────────
function updateLogsBadge(parsed) {
  const badge = document.getElementById("logs-btn-badge");
  if (!parsed) { badge.textContent = ""; badge.className = ""; return; }
  const e = parsed.errors.length, w = parsed.warnings.length, n = parsed.infos.length;
  const total = e + w + n;
  if (!total) { badge.textContent = ""; badge.className = ""; return; }
  if (e) {
    badge.textContent = `${e}E ${w}W`;
    badge.id = "logs-btn-badge"; badge.className = "b-err";
  } else if (w) {
    badge.textContent = `${w}W`;
    badge.id = "logs-btn-badge"; badge.className = "b-warn";
  } else {
    badge.textContent = `${n}`;
    badge.id = "logs-btn-badge"; badge.className = "";
  }
}

function renderLogsCards(items) {
  const cards = document.getElementById("logs-cards");
  if (!cards) return;
  cards.innerHTML = "";
  if (!items.length) {
    cards.innerHTML = '<div style="text-align:center;padding:32px;color:var(--muted);font-size:13px">No items</div>';
    return;
  }
  // v3.3.2 — Apply error-grouping here too. Logs panel renders the same data
  // as the Error panel but with All/Errors/Warnings/Info tabs; grouping logic
  // is identical. _errorGroupKey reads `.isError`, so we synthesize that from
  // `.kind` before grouping (an `info` kind counts as not-an-error so info
  // items group separately from a same-text warning, which is the right
  // behaviour because they have different severity colour anyway).
  const normalized = items.map(it => ({ ...it, isError: it.kind === "error" }));
  const groups = _groupErrorItems(normalized);
  groups.forEach(group => {
    const rep = group.rep;
    const n   = group.occurrences.length;
    const kind = rep.kind || (rep.isError ? "error" : "warn");
    const cls  = kind === "error" ? "err-error" : kind === "info" ? "err-info" : "err-warn";
    const icon = kind === "error" ? "✕" : kind === "info" ? "ℹ" : "!";
    const card = document.createElement("div");
    card.className = `err-card ${cls}`;
    const locText = [rep.file, rep.line >= 0 ? `line ${rep.line + 1}` : null].filter(Boolean).join(", ");

    let headerExtra = "";
    if (n > 1) {
      headerExtra = `<span class="err-count-badge" title="${n} occurrences — click to expand">×${n}</span>
                     <button class="err-chev" title="Show all occurrences" aria-label="Expand occurrences">▶</button>`;
    } else if (rep.line >= 0) {
      headerExtra = `<button class="err-nav" title="Jump to line">↗</button>`;
    }

    card.innerHTML = `
      <div class="err-header">
        <span class="err-icon">${icon}</span>
        <span class="err-msg">${rep.msg}</span>
        ${headerExtra}
      </div>
      ${locText ? `<div class="err-loc">${locText}${n > 1 ? ` · +${n - 1} more` : ""}</div>` : ""}
      ${n > 1 ? `<div class="err-occurrences"></div>` : ""}
    `;

    if (n === 1 && rep.line >= 0) {
      card.querySelector(".err-nav").onclick = () => {
        cmEditor.setCursor(rep.line, 0);
        cmEditor.scrollIntoView({ line: rep.line, ch: 0 }, 80);
        cmEditor.focus();
      };
    } else if (n > 1) {
      const occList = card.querySelector(".err-occurrences");
      const chev    = card.querySelector(".err-chev");
      const badge   = card.querySelector(".err-count-badge");
      let populated = false;
      const populate = () => {
        if (populated) return;
        populated = true;
        group.occurrences.forEach(occ => {
          const row = document.createElement("button");
          row.className = "err-occ-row";
          row.type = "button";
          const where = [occ.file, occ.line >= 0 ? `line ${occ.line + 1}` : "(no line)"]
            .filter(Boolean).join(", ");
          row.textContent = `↗  ${where}`;
          if (occ.line >= 0) {
            row.onclick = () => {
              cmEditor.setCursor(occ.line, 0);
              cmEditor.scrollIntoView({ line: occ.line, ch: 0 }, 80);
              cmEditor.focus();
            };
          } else {
            row.disabled = true;
            row.style.cursor = "default";
          }
          occList.appendChild(row);
        });
      };
      const toggle = (e) => {
        e.stopPropagation();
        populate();
        card.classList.toggle("err-expanded");
      };
      if (chev)  chev.onclick  = toggle;
      if (badge) badge.onclick = toggle;
    }
    cards.appendChild(card);
  });
}

function showLogsPanel(parsed) {
  const panel = document.getElementById("logs-panel");
  const e = parsed.errors.map(x => ({ ...x, kind: "error" }));
  const w = parsed.warnings.map(x => ({ ...x, kind: "warn" }));
  const n = parsed.infos.map(x => ({ ...x, kind: "info" }));
  const allItems = [...e, ...w, ...n];

  const tabData = [
    { id: "all",     label: "All logs", items: allItems,  bclass: "" },
    { id: "errors",  label: "Errors",   items: e,         bclass: "b-err"  },
    { id: "warnings",label: "Warnings", items: w,         bclass: "b-warn" },
    { id: "infos",   label: "Info",     items: n,         bclass: "b-info" },
  ];

  panel.innerHTML = `
    <div class="logs-tabs">
      ${tabData.map(t => `
        <button class="logs-tab${logsActiveTab === t.id ? " active" : ""}"
                onclick="logsActiveTab='${t.id}'; showLogsPanel(lastParsedLog)">
          ${t.label}
          <span class="lbadge ${t.bclass}">${t.items.length}</span>
        </button>`).join("")}
      <button class="logs-close" onclick="hideLogsPanel()">✕</button>
    </div>
    <div class="logs-cards" id="logs-cards"></div>
  `;
  panel.classList.add("visible");

  const activeTab = tabData.find(t => t.id === logsActiveTab) || tabData[0];
  renderLogsCards(activeTab.items);
}

function hideLogsPanel() {
  const panel = document.getElementById("logs-panel");
  panel.classList.remove("visible");
  panel.innerHTML = "";
}

function toggleLogsPanel() {
  const panel = document.getElementById("logs-panel");
  if (panel.classList.contains("visible")) {
    hideLogsPanel();
  } else {
    if (!lastParsedLog) return;
    showLogsPanel(lastParsedLog);
  }
}

function clearErrorMarkers() {
  cmEditor.clearGutter("cm-errors-gutter");
  cmEditor.eachLine(lh => {
    cmEditor.removeLineClass(lh, "background", "cm-error-line");
    cmEditor.removeLineClass(lh, "background", "cm-warn-line");
  });
}

// v3.2.3 — Singleton tooltip reused across every marker. Created lazily on
// first hover so we don't add DOM nodes for users who never trigger a build.
let _markerTipEl = null;
function _ensureMarkerTip() {
  if (_markerTipEl) return _markerTipEl;
  _markerTipEl = document.createElement("div");
  _markerTipEl.className = "cm-marker-tooltip";
  document.body.appendChild(_markerTipEl);
  return _markerTipEl;
}
function _showMarkerTip(el, msg, isError) {
  const tip = _ensureMarkerTip();
  tip.className = "cm-marker-tooltip " + (isError ? "error" : "warn");
  tip.innerHTML = `<span class="tip-tag">${isError ? "ERROR" : "WARNING"}</span>${_esc(msg || "(no message)")}`;
  // Make visible first so offsetWidth/Height are measurable
  tip.style.display = "block";
  tip.style.left = "0px"; tip.style.top = "0px";
  const r = el.getBoundingClientRect();
  // Prefer to the right of the marker, vertically centered. If it would
  // overflow the right edge, flip to the left side.
  let left = r.right + 8;
  if (left + tip.offsetWidth + 8 > window.innerWidth) {
    left = Math.max(4, r.left - tip.offsetWidth - 8);
  }
  let top = r.top + r.height / 2 - tip.offsetHeight / 2;
  top = Math.max(4, Math.min(window.innerHeight - tip.offsetHeight - 4, top));
  tip.style.left = left + "px";
  tip.style.top  = top  + "px";
}
function _hideMarkerTip() {
  if (_markerTipEl) _markerTipEl.style.display = "none";
}

function showErrorMarkers({ errors, warnings }) {
  clearErrorMarkers();
  const total = cmEditor.lineCount();

  const addMarker = (lineNo, msg, isError) => {
    if (lineNo < 0 || lineNo >= total) return;
    const el = document.createElement("div");
    el.className = isError ? "cm-error-marker" : "cm-warn-marker";
    el.textContent = isError ? "✕" : "!";
    // Kept as a fallback if our styled tooltip ever fails to mount (e.g.
    // headless screenshot tooling). The custom tooltip below wins because
    // it fires on mouseenter instantly while title needs ~1s delay.
    el.title = msg || "";
    el.addEventListener("mouseenter", () => _showMarkerTip(el, msg, isError));
    el.addEventListener("mouseleave", _hideMarkerTip);
    el.onclick = () => {
      cmEditor.setCursor(lineNo, 0);
      cmEditor.scrollIntoView({ line: lineNo, ch: 0 }, 80);
      cmEditor.focus();
    };
    cmEditor.setGutterMarker(lineNo, "cm-errors-gutter", el);
    cmEditor.addLineClass(lineNo, "background", isError ? "cm-error-line" : "cm-warn-line");
  };

  errors.forEach(e   => addMarker(e.line, e.msg, true));
  warnings.forEach(w => addMarker(w.line, w.msg, false));
}

// ── COMPILE ───────────────────────────────────────────────────
async function compile() {
  if (!currentProject) return alert("Select a project first.");
  // Cancel any pending auto-save so it can't race with our explicit save below
  // (otherwise an in-flight POST could clobber our save with a stale snapshot).
  clearTimeout(saveTimer);
  await saveCurrentFile();

  const btn    = document.getElementById("compile-btn");
  const status = document.getElementById("compile-status");
  btn.innerHTML = '<span class="spinner"></span>';
  btn.disabled  = true;
  status.textContent = "Compiling...";
  status.className   = "compile-status";
  const t0 = Date.now();

const compiler = document.getElementById("compiler-select").value;
  const res  = await fetch(`/api/projects/${currentProject}/compile`, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      main: mainFile,
      bibtex: true,
      compiler,
      draft: draftMode,
      includeOnly: selectedIncludes,   // v3.2.2 — empty = full compile
    })
  });
  const data = await res.json();

  btn.innerHTML = "▶ Compile";
  btn.disabled  = false;

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  document.getElementById("log-content").textContent = data.log || "";

  const parsed = parseLatexErrors(data.log || "");
  lastParsedLog = parsed;
  updateLogsBadge(parsed);
  // v3.2.3 — Push this run into the compile history (last 10 per project).
  // Done before the ok/err branches so failed compiles are also remembered.
  recordCompileToHistory({ log: data.log || "", ok: data.ok, elapsed, parsed });
  // ถ้า logs panel เปิดอยู่ ให้ refresh
  if (document.getElementById("logs-panel").classList.contains("visible")) {
    showLogsPanel(parsed);
  }

  // v3.3.0 — pull page count + output bytes out of the log so the status
  // line can show "245 pp" alongside elapsed time. Cheap regex scan, runs
  // even when the compile failed (we still surface partial pages if found).
  const stats = _extractCompileStats(data.log || "");

  if (data.ok) {
    const partial = selectedIncludes.length > 0
                    && availableIncludes.length > 0
                    && selectedIncludes.length < availableIncludes.length;
    const tags = [];
    if (draftMode) tags.push("draft");
    if (partial)   tags.push(`${selectedIncludes.length}/${availableIncludes.length} chapters`);
    // v3.3.0 — pages + warnings inlined as middot-separated bits so the
    // success line tells the whole story at a glance, instead of just elapsed.
    const bits = [`✓ Compiled in ${elapsed}s`];
    if (stats.pages) bits.push(`${stats.pages} pp`);
    if (parsed.warnings.length) bits.push(`${parsed.warnings.length} warn`);
    status.textContent = bits.join(" · ") + (tags.length ? ` (${tags.join(", ")})` : "");
    status.title       = _compileStatsTooltip(elapsed);  // v3.3.0 — hover for trend
    status.className   = "compile-status ok";
    hideErrorPanel();
    showPDF(data.pdf);
    // v3.2.2 — labels and bibkeys may have been added/removed; refresh
    // cache so the next \ref{ / \cite{ shows current state. Backend caches
    // on mtime, so this is essentially free when nothing changed.
    loadCiteData();
    showErrorMarkers({ errors: [], warnings: parsed.warnings });
    document.getElementById("log-panel").classList.remove("open");
  } else {
    // v3.3.0 — keep stats hint on failure too: shows recent-runs avg even
    // when this run blew up, so user can see "this used to take 8s, now it's hanging".
    status.textContent = `✗ ${parsed.errors.length} error${parsed.errors.length !== 1 ? "s" : ""} (${elapsed}s)`;
    status.title       = _compileStatsTooltip(elapsed);
    status.className   = "compile-status err";
    showErrorMarkers(parsed);
    showErrorPanel(parsed);
  }
}

// v3.3.0 — Parse pdflatex's "Output written on <pdf> (N pages, M bytes)."
// trailer from the compile log. Falls back to nulls if the line isn't found
// (e.g. compile crashed before writing the PDF, draft mode wrote a broken PDF).
// We deliberately match the LAST occurrence — the log can contain multiple
// passes (compile → bibtex → compile → compile), and only the final pdflatex
// invocation's page count is what's on screen.
function _extractCompileStats(log) {
  if (!log) return { pages: null, bytes: null };
  const re = /Output written on\s+\S+\s+\((\d+)\s+pages?,\s+(\d+)\s+bytes/g;
  let m, last = null;
  while ((m = re.exec(log)) !== null) last = m;
  if (!last) return { pages: null, bytes: null };
  return { pages: parseInt(last[1], 10), bytes: parseInt(last[2], 10) };
}

// v3.3.0 — Build a one-line tooltip from compile history (last 5 successful
// runs by default). Lets the user spot perf regressions ("normally 8s, today
// 14s — what slowed it down?") without opening the history panel. Uses the
// already-existing localStorage history so no extra storage cost.
function _compileStatsTooltip(currentElapsed) {
  try {
    const arr = loadCompileHistory();
    if (!arr || arr.length < 2) return `This run: ${currentElapsed}s`;
    // arr is newest-first per recordCompileToHistory. Skip the current run
    // (just-added at index 0) and look at the prior 5 successful compiles —
    // failures often crash early and skew the average toward fast/instant.
    const prior = arr.slice(1).filter(h => h.ok).slice(0, 5);
    if (!prior.length) return `This run: ${currentElapsed}s`;
    const times = prior.map(h => parseFloat(h.elapsed)).filter(n => !isNaN(n));
    if (!times.length) return `This run: ${currentElapsed}s`;
    const avg = (times.reduce((a, b) => a + b, 0) / times.length).toFixed(1);
    const min = Math.min(...times).toFixed(1);
    const max = Math.max(...times).toFixed(1);
    return `This run: ${currentElapsed}s  ·  Prior ${times.length}: avg ${avg}s, min ${min}s, max ${max}s`;
  } catch (_) {
    return `This run: ${currentElapsed}s`;
  }
}

// ── PDF.js VIEWER ─────────────────────────────────────────────
const PDFJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174";
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_CDN + "/pdf.worker.min.js";

let pdfJsDoc        = null;   // loaded PDFDocumentProxy
let pdfJsScale      = 1.0;    // current zoom (start at 100%)
let pdfJsPageHts    = [null]; // page heights in pt (1-indexed), for coordinate conversion
let pdfJsUrl        = null;   // last loaded url (for zoom re-render)
let pdfJsLastUrl    = null;   // url that pdfJsDoc was loaded from (skip refetch on zoom)
let pdfJsRendering  = false;
let pdfPendingScale = null;   // queued zoom request that hit the rendering lock
let pdfTextCache    = {};     // page number → TextContent items cache (reused across zooms)
let pdfZoomTimer    = null;   // debounce timer for zoom re-render
let pdfMeasureCtx   = null;   // offscreen 2d ctx for fast text-width measurement
let pdfRenderToken  = 0;      // monotonically incremented; cancels stale renders on rapid zoom

// Offscreen canvas for measuring glyph widths during text-layer build.
// Replaces the previous probe.getBoundingClientRect() approach — that call
// forced a layout reflow for EVERY text item (could be thousands per page),
// which was the main reason zoom felt sluggish on long documents.
function getMeasureCtx() {
  if (!pdfMeasureCtx) {
    const c = document.createElement("canvas");
    pdfMeasureCtx = c.getContext("2d");
  }
  return pdfMeasureCtx;
}

function showZoomControls(visible) {
  ["pdf-zoom-out","pdf-zoom-in","pdf-zoom-label","pdf-zoom-sep2"].forEach(id => {
    document.getElementById(id).style.display = visible ? "" : "none";
  });
  // v3.2.3 — also show/hide the page-jump input alongside zoom controls.
  const pin = document.getElementById("pdf-page-input");
  const ptl = document.getElementById("pdf-page-total");
  if (pin) pin.style.display = visible ? "" : "none";
  if (ptl) ptl.style.display = visible ? "" : "none";
  if (visible && pdfJsDoc && ptl) ptl.textContent = "/ " + pdfJsDoc.numPages;
}

// v3.2.3 — Page jump. Scrolls #pdf-page-N into view in the scroll container,
// then briefly tints the input border so the user sees their action landed.
function pdfJumpToPage(p, inputEl) {
  if (!pdfJsDoc) return;
  const n = parseInt(p, 10);
  if (!n || n < 1 || n > pdfJsDoc.numPages) {
    if (inputEl) {
      inputEl.style.borderColor = "var(--red)";
      setTimeout(() => { inputEl.style.borderColor = ""; }, 600);
    }
    return;
  }
  const wrap = document.getElementById(`pdf-page-${n}`);
  if (!wrap) return;
  wrap.scrollIntoView({ behavior: "smooth", block: "start" });
  // Move focus off the input so the IntersectionObserver can re-sync the
  // value as the smooth-scroll progresses. Otherwise the value stays pinned
  // to what the user typed even after they've landed on the target page.
  if (inputEl) {
    inputEl.style.borderColor = "var(--accent)";
    setTimeout(() => { inputEl.style.borderColor = ""; inputEl.blur(); }, 600);
  }
}

// v3.2.3 — Scroll-following page indicator. As the user scrolls the PDF the
// page-input value tracks the most-visible page. The user can still type a
// number + Enter (or just blur) to jump elsewhere — we suppress observer
// writes while the input has focus so the typed value isn't clobbered.
//
// IntersectionObserver semantics: each callback receives only the entries
// that changed. We maintain a running map of page-num → intersectionRatio
// and after every callback recompute the argmax. That keeps the "current"
// page sticky on slow scrolls and snappy on fast ones.
let _pdfPageObserver = null;
const _pdfPageVisibility = new Map();   // pageNum → ratio (0..1)
function _attachPdfPageObserver() {
  // Tear down any previous observer — pages are recreated on every re-render
  // (compile / zoom) so the old nodes are now detached.
  if (_pdfPageObserver) {
    try { _pdfPageObserver.disconnect(); } catch (_) {}
    _pdfPageObserver = null;
  }
  _pdfPageVisibility.clear();
  const container = document.getElementById("pdf-canvas-container");
  if (!container || !pdfJsDoc) return;
  if (typeof IntersectionObserver === "undefined") return;   // very old browser
  _pdfPageObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const m = e.target.id && e.target.id.match(/^pdf-page-(\d+)$/);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (e.isIntersecting && e.intersectionRatio > 0) {
        _pdfPageVisibility.set(n, e.intersectionRatio);
      } else {
        _pdfPageVisibility.delete(n);
      }
    }
    // Choose the page that occupies the most of the viewport right now.
    // Tie-break by lower number (so when two pages straddle the seam we
    // report the earlier one, which feels right on top-anchored scrolling).
    let bestN = null, bestR = -1;
    for (const [n, r] of _pdfPageVisibility) {
      if (r > bestR || (r === bestR && (bestN === null || n < bestN))) {
        bestR = r; bestN = n;
      }
    }
    if (bestN === null) return;
    const inp = document.getElementById("pdf-page-input");
    if (!inp) return;
    // Don't clobber the user's in-progress typing.
    if (document.activeElement === inp) return;
    if (inp.value !== String(bestN)) inp.value = String(bestN);
  }, {
    root: container,
    // Multiple thresholds so the ratio re-computes as the page slides into
    // and out of view, not just at the boundaries.
    threshold: [0, 0.1, 0.25, 0.5, 0.75, 1.0],
  });
  container.querySelectorAll(".pdf-page-wrap").forEach(el => {
    _pdfPageObserver.observe(el);
  });
}

// v4.5.0 — Lazy page rasteriser (see renderPdfFromUrl). Renders ONE page's
// canvas + text layer into its already-placed placeholder wrap, on demand.
// Safe to call repeatedly: it no-ops if the page is already rendered or being
// rendered, and aborts if a newer full render (compile / zoom) has started.
async function _renderPdfPageContent(n) {
  const wrap = document.getElementById(`pdf-page-${n}`);
  if (!wrap || wrap.dataset.rendered !== "0") return;
  if (!pdfJsDoc) return;
  const tok = pdfRenderToken;            // newer full render → abandon this one
  wrap.dataset.rendered = "rendering";
  try {
    const dpr  = window.devicePixelRatio || 1;
    const page = await pdfJsDoc.getPage(n);
    if (tok !== pdfRenderToken) { wrap.dataset.rendered = "0"; return; }

    const vp1 = page.getViewport({ scale: 1 });
    if (pdfJsPageHts[n] !== vp1.height) pdfJsPageHts[n] = vp1.height;   // fix estimate

    const viewport = page.getViewport({ scale: pdfJsScale });
    const cssW = Math.floor(viewport.width);
    const cssH = Math.floor(viewport.height);
    // Correct the placeholder size if this page isn't the uniform page-1 size.
    if (wrap.style.width  !== cssW + "px") wrap.style.width  = cssW + "px";
    if (wrap.style.height !== cssH + "px") wrap.style.height = cssH + "px";

    const canvas = document.createElement("canvas");
    canvas.width        = Math.floor(cssW * dpr);
    canvas.height       = Math.floor(cssH * dpr);
    canvas.style.width  = cssW + "px";
    canvas.style.height = cssH + "px";
    wrap.appendChild(canvas);

    const renderTransform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;
    await page.render({
      canvasContext: canvas.getContext("2d"),
      viewport,
      transform: renderTransform,
    }).promise;
    if (tok !== pdfRenderToken) return;

    // Text layer — selection / I-beam. Same CSS-scale geometry as the canvas.
    try {
      const textViewport = page.getViewport({ scale: pdfJsScale });
      let textContent = pdfTextCache[n];
      if (!textContent) { textContent = await page.getTextContent(); pdfTextCache[n] = textContent; }
      if (tok !== pdfRenderToken) return;

      const textLayerDiv = document.createElement("div");
      textLayerDiv.className    = "textLayer";
      textLayerDiv.style.width  = cssW + "px";
      textLayerDiv.style.height = cssH + "px";
      wrap.appendChild(textLayerDiv);

      const composeTransform = (m1, m2) => [
        m1[0]*m2[0] + m1[2]*m2[1],
        m1[1]*m2[0] + m1[3]*m2[1],
        m1[0]*m2[2] + m1[2]*m2[3],
        m1[1]*m2[2] + m1[3]*m2[3],
        m1[0]*m2[4] + m1[2]*m2[5] + m1[4],
        m1[1]*m2[4] + m1[3]*m2[5] + m1[5],
      ];
      const measureCtx = getMeasureCtx();
      const frag       = document.createDocumentFragment();
      for (const item of textContent.items || []) {
        if (!item || !item.str) continue;
        const tx       = composeTransform(textViewport.transform, item.transform);
        const fontSize = Math.hypot(tx[2], tx[3]);
        if (fontSize < 1) continue;
        const angle = Math.atan2(tx[1], tx[0]);
        const left  = tx[4];
        const top   = tx[5] - fontSize;
        const span  = document.createElement("span");
        span.textContent      = item.str;
        span.style.left       = left + "px";
        span.style.top        = top  + "px";
        span.style.fontSize   = fontSize + "px";
        span.style.fontFamily = "sans-serif";
        if (item.width && item.width > 0) {
          const targetW  = item.width * textViewport.scale;
          measureCtx.font = fontSize + "px sans-serif";
          const naturalW = measureCtx.measureText(item.str).width || 1;
          const ratio    = targetW / naturalW;
          span.style.transform       = (angle !== 0 ? `rotate(${angle}rad) ` : "") + `scaleX(${ratio.toFixed(4)})`;
          span.style.transformOrigin = "0% 0%";
        } else if (angle !== 0) {
          span.style.transform = `rotate(${angle}rad)`;
        }
        frag.appendChild(span);
      }
      textLayerDiv.appendChild(frag);
    } catch (err) {
      console.warn("[textLayer] render failed for page", n, err);
    }

    wrap.dataset.rendered = "1";
  } catch (err) {
    wrap.dataset.rendered = "0";   // allow a retry on the next intersection
    console.warn("[pdf] page render failed", n, err);
  }
}

// v4.5.0 — Triggers lazy rasterisation of pages as they approach the viewport.
// Distinct from _pdfPageObserver (which only tracks the visible page NUMBER).
// The generous rootMargin pre-renders ~1.5 screens ahead so scrolling feels
// seamless rather than "blank, then pop".
let _pdfLazyObserver = null;
function _attachPdfLazyRenderObserver() {
  if (_pdfLazyObserver) { try { _pdfLazyObserver.disconnect(); } catch (_) {} _pdfLazyObserver = null; }
  const container = document.getElementById("pdf-canvas-container");
  if (!container || !pdfJsDoc) return;
  if (typeof IntersectionObserver === "undefined") {
    // No observer support → render everything (old eager behaviour).
    for (let n = 1; n <= pdfJsDoc.numPages; n++) _renderPdfPageContent(n);
    return;
  }
  _pdfLazyObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const m = e.target.id && e.target.id.match(/^pdf-page-(\d+)$/);
      if (m) _renderPdfPageContent(parseInt(m[1], 10));
    }
  }, { root: container, rootMargin: "1200px 0px" });
  container.querySelectorAll(".pdf-page-wrap").forEach(el => _pdfLazyObserver.observe(el));
}

// v4.5.0 — Backward-search (double-click PDF → jump to editor line). Extracted
// from the old per-page render loop so it can be attached to a placeholder
// wrap before the page is rasterised.
function _attachPdfBackwardSearch(wrap, pageNum) {
  wrap.addEventListener("dblclick", async (e) => {
    if (!currentProject) return;
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.removeAllRanges) sel.removeAllRanges();
    const rect   = wrap.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const pdf_x = clickX / pdfJsScale;
    const pdf_y = clickY / pdfJsScale;
    const pdfName = mainFile.replace(/\.tex$/, ".pdf");

    const status = document.getElementById("compile-status");
    status.textContent = "\u21a9 Searching\u2026";
    status.className   = "compile-status";

    try {
      const res  = await fetch(
        `/api/projects/${encodeURIComponent(currentProject)}/synctex/backward` +
        `?page=${pageNum}&x=${Math.round(pdf_x)}&y=${Math.round(pdf_y)}&pdf=${encodeURIComponent(pdfName)}`
      );
      const data = await res.json();
      if (!data.ok) {
        status.textContent = data.error || "No match";
        status.className   = "compile-status err";
        setTimeout(() => { status.textContent = ""; status.className = "compile-status"; }, 2000);
        return;
      }
      if (data.file && data.file !== currentFile) {
        await openFile(data.file);
      }
      const targetLine = (data.line || 1) - 1;
      setTimeout(() => {
        cmEditor.setCursor(targetLine, 0);
        cmEditor.scrollIntoView({ line: targetLine, ch: 0 }, 120);
        cmEditor.focus();
        cmEditor.addLineClass(targetLine, "background", "cm-synctex-jump");
        setTimeout(() => cmEditor.removeLineClass(targetLine, "background", "cm-synctex-jump"), 1200);
      }, data.file !== currentFile ? 200 : 0);

      status.textContent = `\u21a9 Line ${data.line}`;
      status.className   = "compile-status ok";
      setTimeout(() => { status.textContent = ""; status.className = "compile-status"; }, 1500);
    } catch (_) {
      status.textContent = "Backward search failed";
      status.className   = "compile-status err";
      setTimeout(() => { status.textContent = ""; status.className = "compile-status"; }, 2000);
    }
  });
}

// v3.2.2 — PDF outline / TOC sidebar
let pdfOutlineLoaded = false;   // last PDF load attempted to fetch outline
let pdfOutlineData   = [];      // resolved tree: [{title, page, items: [...]}]

// Resolve a pdf.js dest (named string OR array) to a 1-indexed page number.
async function _resolveOutlineDest(dest) {
  try {
    let d = dest;
    if (typeof d === "string") d = await pdfJsDoc.getDestination(d);
    if (!Array.isArray(d) || !d[0]) return null;
    return (await pdfJsDoc.getPageIndex(d[0])) + 1;
  } catch (_) { return null; }
}
async function _walkOutline(items) {
  const out = [];
  for (const it of items) {
    const page = await _resolveOutlineDest(it.dest);
    const sub  = (it.items && it.items.length) ? await _walkOutline(it.items) : [];
    out.push({ title: it.title || "(untitled)", page, items: sub });
  }
  return out;
}
async function loadPdfOutline() {
  pdfOutlineLoaded = false;
  pdfOutlineData   = [];
  if (!pdfJsDoc) return;
  try {
    const raw = await pdfJsDoc.getOutline();
    if (!raw || !raw.length) {
      pdfOutlineLoaded = true;
      return;
    }
    pdfOutlineData = await _walkOutline(raw);
  } catch (_) {
    pdfOutlineData = [];
  }
  pdfOutlineLoaded = true;
}
function renderPdfOutline() {
  const list = document.getElementById("pdf-outline-list");
  if (!pdfOutlineData.length) {
    list.innerHTML = `<div class="po-empty">No outline / bookmarks in this PDF.<br><br>
      Add <code>\\section{}</code>, <code>\\chapter{}</code>, or load
      <code>hyperref</code> to generate them.</div>`;
    return;
  }
  const renderItems = (items, depth) => items.map(it => {
    const padLeft = 8 + depth * 12;
    const pageStr = it.page ? `p.${it.page}` : "";
    const titleEsc = escapeHtml(it.title);
    const onClick = it.page
      ? `onclick="pdfScrollToPage(${it.page})"`
      : "";
    return `<div class="po-item" ${onClick} style="padding-left:${padLeft}px">
              <span class="po-title">${titleEsc}</span>
              <span class="po-page">${pageStr}</span>
            </div>`
         + (it.items && it.items.length
              ? `<div class="po-children">${renderItems(it.items, depth + 1)}</div>`
              : "");
  }).join("");
  list.innerHTML = renderItems(pdfOutlineData, 0);
}
function togglePdfOutline() {
  const content = document.querySelector(".pdf-content");
  const isOpen  = content.classList.toggle("outline-open");
  if (isOpen) {
    if (!pdfOutlineLoaded) {
      // Lazy-load on first open after a fresh PDF
      loadPdfOutline().then(renderPdfOutline);
    } else {
      renderPdfOutline();
    }
  }
}
// Scroll the canvas container so the top of `pageNum` is at the top of view.
function pdfScrollToPage(pageNum) {
  const wrap = document.getElementById(`pdf-page-${pageNum}`);
  if (!wrap) return;
  const container = document.getElementById("pdf-canvas-container");
  container.scrollTo({ top: Math.max(0, wrap.offsetTop - 16), behavior: "smooth" });
}

async function showPDF(filename) {
  const ts  = Date.now();
  const url = `/api/projects/${currentProject}/pdf?file=${encodeURIComponent(filename)}&t=${ts}`;
  pdfJsUrl  = url;
  pdfTextCache = {};  // clear text cache on new PDF load
  pdfOutlineLoaded = false;
  pdfOutlineData   = [];

  const container = document.getElementById("pdf-canvas-container");
  const ph        = document.getElementById("pdf-placeholder");
  const dl        = document.getElementById("pdf-download");

  ph.style.display        = "none";
  container.style.display = "flex";
  container.innerHTML     = '<div style="color:var(--muted);padding:32px;text-align:center;font-size:12px">Loading PDF…</div>';
  showZoomControls(true);
  document.getElementById("pdf-zoom-label").textContent = Math.round(pdfJsScale * 100) + "%";

  dl.href = `/api/projects/${currentProject}/pdf?file=${encodeURIComponent(filename)}`;
  dl.download = filename;
  dl.style.display = "inline";

  await renderPdfFromUrl(url, true);   // force reload — new compile output
}

// `forceReload`: re-fetch the PDF (called from showPDF after compile).
// When false (zoom), skip getDocument() and reuse the loaded pdfJsDoc — saves
// the network round-trip on each zoom step.
async function renderPdfFromUrl(url, forceReload) {
  if (pdfJsRendering) {
    // Remember the most recent zoom request so it isn't dropped silently.
    pdfPendingScale = pdfJsScale;
    return;
  }
  pdfJsRendering = true;
  // Bump the render token; any in-flight async work that finishes after a
  // newer render started can detect cancellation and bail out early.
  const myToken = ++pdfRenderToken;
  const container = document.getElementById("pdf-canvas-container");
  try {
    if (forceReload || !pdfJsDoc || pdfJsLastUrl !== url) {
      pdfJsDoc     = await pdfjsLib.getDocument(url).promise;
      pdfJsLastUrl = url;
      pdfTextCache = {};   // PDF changed → text content cache is now stale
      // v3.2.3 — Refresh the page-jump total label NOW that we know numPages
      // for the freshly-loaded document. showZoomControls() runs before this
      // (so the toolbar can flip visible while "Loading PDF…" is showing),
      // which would otherwise leave the "/ N" label stuck at the previous
      // PDF's count — or at the HTML default "/ 0" on first load.
      const _ptl = document.getElementById("pdf-page-total");
      if (_ptl) _ptl.textContent = "/ " + pdfJsDoc.numPages;
      const _pin = document.getElementById("pdf-page-input");
      if (_pin) _pin.max = pdfJsDoc.numPages;
    }
    pdfJsPageHts = [null];   // index 0 unused
    container.innerHTML = "";

    // v4.5.0 — LAZY PDF rendering. Rasterising every page (canvas + text
    // layer) up-front made opening a ~150-page thesis take several seconds
    // before anything was usable. Instead we create correctly-SIZED page
    // placeholders immediately — so total scroll height, page-jump offsets and
    // synctex `pdf-page-N` targets are all valid right away — then rasterise
    // each page only when it nears the viewport (see _renderPdfPageContent /
    // _attachPdfLazyRenderObserver). First paint is now near-instant.
    //
    // Page size is read from page 1 and assumed uniform (true for A4/Letter
    // theses). If a page differs when it actually renders, its wrap height and
    // pdfJsPageHts entry are corrected then — a mixed-size doc just gets a
    // small one-time scroll nudge on the odd page.
    const _p1   = await pdfJsDoc.getPage(1);
    if (myToken !== pdfRenderToken) return;
    const _vp1  = _p1.getViewport({ scale: 1 });
    const _vpS  = _p1.getViewport({ scale: pdfJsScale });
    const cssW  = Math.floor(_vpS.width);
    const cssH  = Math.floor(_vpS.height);
    const uniH1 = _vp1.height;   // scale-1 height estimate used for jumps

    for (let n = 1; n <= pdfJsDoc.numPages; n++) {
      if (myToken !== pdfRenderToken) return;
      pdfJsPageHts.push(uniH1);

      const wrap = document.createElement("div");
      wrap.className        = "pdf-page-wrap";
      wrap.id               = `pdf-page-${n}`;
      wrap.dataset.page     = String(n);
      wrap.dataset.rendered = "0";          // "0" = not yet, "rendering", "1" = done
      wrap.style.width      = cssW + "px";
      wrap.style.height     = cssH + "px";
      wrap.style.cursor     = "default";
      _attachPdfBackwardSearch(wrap, n);    // dblclick → editor jump (no raster needed)
      container.appendChild(wrap);
    }

    // Rasterise on-screen (and soon-to-be-on-screen) pages lazily.
    _attachPdfLazyRenderObserver();
  } catch (err) {
    container.innerHTML = `<div style="color:var(--red);padding:24px;font-size:12px">PDF load error: ${err.message}</div>`;
  } finally {
    pdfJsRendering = false;
    // v3.2.3 — Re-attach the page-visibility observer to the freshly-rendered
    // pages. Done in `finally` so zoom re-renders also re-bind, and so the
    // observer never lingers on detached nodes from a previous render.
    _attachPdfPageObserver();
    // Drain a queued zoom that arrived while we were busy. We re-render at
    // whatever pdfJsScale currently holds — pdfZoom() updated it synchronously
    // before queuing, so the latest user intent wins.
    if (pdfPendingScale !== null) {
      pdfPendingScale = null;
      if (pdfJsUrl) setTimeout(() => renderPdfFromUrl(pdfJsUrl, false), 0);
    }
    // v3.2.2 — refresh PDF outline button visibility. We only show 🗂
    // when the loaded PDF actually has bookmarks (most LaTeX docs with
    // hyperref do; raw beamer or quick test docs may not).
    if (pdfJsDoc && !pdfOutlineLoaded) {
      loadPdfOutline().then(() => {
        const btn = document.getElementById("pdf-outline-btn");
        if (btn) btn.style.display = pdfOutlineData.length ? "inline-block" : "none";
        // If user already has the panel open, render now that data is in.
        if (document.querySelector(".pdf-content")?.classList.contains("outline-open")) {
          renderPdfOutline();
        }
      });
    }
  }
}

// Zoom strategy:
//   1. Update the label and apply a CSS transform on existing pages for
//      INSTANT visual feedback — even on a 200-page thesis the user sees
//      the new size within a frame, instead of waiting for a full re-render.
//   2. Debounce the actual canvas re-render. Rapid +/+/+ clicks collapse
//      into a single render at the final scale; the in-between scales never
//      pay the rasterisation cost.
//   3. Once the real render lands, the CSS transform is cleared and the
//      page is sharp at its new resolution.
//
// `anchor` (optional, v3.2.2): {x, y} in container viewport CSS px. When
// provided, scroll is adjusted so that the document point currently under
// the anchor stays under the anchor after zoom — i.e. pinch-to-zoom locks
// to the cursor instead of the centre of the page. Falls back to scroll-
// fraction preservation when omitted (the +/- toolbar buttons).
async function pdfZoom(delta, anchor) {
  const newScale = Math.max(0.5, Math.min(4.0, pdfJsScale + delta));
  if (newScale === pdfJsScale || !pdfJsUrl) return;

  const container = document.getElementById("pdf-canvas-container");
  const oldScale  = pdfJsScale;
  const ratio     = newScale / oldScale;

  // Snapshot scroll-restoration intent BEFORE any DOM mutation. We capture
  // both representations so the debounced re-render can restore correctly
  // even if many pinch ticks land in the same 140ms window.
  let restore;
  if (anchor) {
    // Document point under the cursor at the OLD scale (in CSS px).
    const docX = container.scrollLeft + anchor.x;
    const docY = container.scrollTop  + anchor.y;
    restore = { kind: "cursor", docX, docY, cx: anchor.x, cy: anchor.y, ratio };
  } else {
    restore = { kind: "frac", frac: container.scrollTop / (container.scrollHeight || 1) };
  }

  pdfJsScale = newScale;
  document.getElementById("pdf-zoom-label").textContent = Math.round(pdfJsScale * 100) + "%";

  // ── Instant CSS-resize preview ─────────────────────────────────────
  // We resize wrap + canvas via CSS so the browser stretches the existing
  // canvas bitmap to the new size immediately. The .textLayer spans are
  // positioned at the OLD scale, so we apply a CSS transform on the layer
  // itself — much cheaper than rebuilding it. The real re-render that
  // lands ~140ms later replaces all of this with sharp pixels.
  document.querySelectorAll(".pdf-page-wrap").forEach(wrap => {
    const wPx = parseFloat(wrap.style.width)  || 0;
    const hPx = parseFloat(wrap.style.height) || 0;
    const newW = wPx * ratio;
    const newH = hPx * ratio;
    wrap.style.width  = newW + "px";
    wrap.style.height = newH + "px";
    const cv = wrap.querySelector("canvas");
    if (cv) {
      cv.style.width  = newW + "px";
      cv.style.height = newH + "px";
    }
    const tl = wrap.querySelector(".textLayer");
    if (tl) {
      const prev = parseFloat(tl.dataset.previewScale || "1") * ratio;
      tl.dataset.previewScale  = prev;
      tl.style.transform       = `scale(${prev})`;
      tl.style.transformOrigin = "0 0";
    }
  });

  // Apply anchored scroll IMMEDIATELY so the cursor stays pinned to the
  // same document point during the preview window. For frac-based zoom
  // (toolbar buttons) we leave scroll alone here and restore in the
  // timeout once the new scrollHeight is known.
  if (restore.kind === "cursor") {
    // After CSS scaling by `ratio`, the document point (docX, docY)
    // is now at (docX*ratio, docY*ratio). To put it back under the
    // cursor (cx, cy) we need scroll = docPoint*ratio − cursor.
    container.scrollLeft = restore.docX * ratio - restore.cx;
    container.scrollTop  = restore.docY * ratio - restore.cy;
  }

  // ── Debounced real render ──────────────────────────────────────────
  if (pdfZoomTimer) clearTimeout(pdfZoomTimer);
  pdfZoomTimer = setTimeout(async () => {
    pdfZoomTimer = null;
    // forceReload=false → reuse pdfJsDoc (no network refetch on zoom)
    await renderPdfFromUrl(pdfJsUrl, false);
    if (restore.kind === "frac") {
      container.scrollTop = restore.frac * container.scrollHeight;
    }
    // For cursor-anchored zoom the preview already scrolled to the
    // correct position; the rebuilt pages match those exact dims (modulo
    // sub-pixel Math.floor rounding) so no further adjustment is needed.
  }, 140);
}

// ── Trackpad pinch / Ctrl+wheel zoom ──────────────────────────────────
// Browsers report two-finger trackpad pinch gestures as `wheel` events with
// `e.ctrlKey === true` (the "ctrl" flag is synthetic for pinch — it isn't
// the keyboard Ctrl key). The same convention covers Ctrl+wheel for mouse
// users, so a single handler serves both inputs.
//
// We translate the wheel deltaY into a *multiplicative* scale factor via
// exp(-deltaY · k). Multiplicative scaling keeps the perceived zoom rate
// constant across the whole 50–400% range, unlike a flat additive step
// which would feel coarse at 50% and sluggish at 400%.
//
// `passive: false` is required so that preventDefault() can stop the
// browser's own page-zoom handler from also running.
function attachPdfWheelZoom() {
  const container = document.getElementById("pdf-canvas-container");
  if (!container || container._wheelZoomBound) return;
  container._wheelZoomBound = true;

  container.addEventListener("wheel", (e) => {
    // Only intercept pinch / Ctrl-wheel; let plain two-finger scroll pass.
    if (!e.ctrlKey) return;
    // Always block the browser-level page zoom over our container, even
    // if there's no PDF loaded — otherwise an accidental pinch on the
    // empty placeholder would zoom the whole TexLocal UI.
    e.preventDefault();
    if (!pdfJsDoc) return;

    // Sensitivity: divide deltaY by 100 and exponentiate. Typical pinch
    // tick is ±5–15 deltaY units → ±5–15% scale change per tick. The
    // negative sign maps "fingers spreading apart" (pinch out, deltaY<0)
    // to "zoom in" (factor>1).
    const factor = Math.exp(-e.deltaY * 0.01);
    const newScale = Math.max(0.5, Math.min(4.0, pdfJsScale * factor));
    const delta    = newScale - pdfJsScale;
    if (delta === 0) return;

    // Cursor position relative to the container's viewport (CSS px).
    const rect = container.getBoundingClientRect();
    const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    pdfZoom(delta, anchor);
  }, { passive: false });
}
// Bind once on first paint — and re-bind defensively if the element gets
// recreated (it shouldn't, but cheap insurance).
document.addEventListener("DOMContentLoaded", attachPdfWheelZoom);
attachPdfWheelZoom();

// page, x, y, h, w, y2 — all in PDF points, TeX/synctex convention:
//   y  = top of topmost visual line (from TOP of page) = min(baseline - ascent) across records
//   y2 = baseline of bottommost visual line (from TOP of page) = max(baseline) across records
//   h  = glyph ascent of one line (~8-12pt), used for descent calculation
// w — optional text width in pt (word-level highlight)
function pdfScrollToPosition(page, x, y, h, w, y2) {
  const wrap = document.getElementById(`pdf-page-${page}`);
  if (!wrap) return;
  // v4.5.0 — with lazy rendering the synctex target page may not be rasterised
  // yet; kick it off now so the highlight lands on real content, not a blank.
  _renderPdfPageContent(page);
  document.querySelectorAll(".pdf-highlight").forEach(el => el.remove());

  const glyphH  = (h && h > 2) ? h : 10;
  const descent = glyphH * 0.3;         // small descent below last baseline
  const yBot    = (y2 && y2 > y) ? y2 : (y + glyphH);  // last baseline

  // y is already the top of the highlight (y_top = first-line top)
  // bottom of highlight = last baseline + descent
  const canvasYtop = Math.max(0, y * pdfJsScale);
  const canvasHpx  = (yBot - y + descent) * pdfJsScale;

  const hl = document.createElement("div");
  hl.className = "pdf-highlight";
  hl.style.top    = canvasYtop + "px";
  hl.style.height = canvasHpx + "px";

  if (w && w > 0) {
    // word-level highlight: position and width from text item
    hl.style.left  = (x * pdfJsScale) + "px";
    hl.style.right = "auto";
    hl.style.width = (w * pdfJsScale) + "px";
  }
  // else: full-width (left:0; right:0 from CSS)

  wrap.appendChild(hl);
  setTimeout(() => hl.remove(), 2500);

  // scroll so the FIRST line of the highlight is in the upper-centre of the PDF pane
  const container  = document.getElementById("pdf-canvas-container");
  const firstLineY = canvasYtop + glyphH * pdfJsScale / 2;  // centre of first (topmost) line
  const target     = wrap.offsetTop + firstLineY - container.clientHeight / 3;
  container.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
}

function toggleLog() {
  document.getElementById("log-panel").classList.toggle("open");
}

// ── PROJECT MANAGEMENT MODAL ─────────────────────────────────
async function openProjectsModal() {
  await renderProjectList();
  openModal("modal-projects");
}

async function renderProjectList() {
  const res  = await fetch("/api/projects");
  const list = await res.json();
  const el   = document.getElementById("project-list");
  el.innerHTML = "";

  if (!list.length) {
    el.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted);font-size:13px">No projects yet</div>';
    return;
  }

  list.forEach(p => {
    const row = document.createElement("div");
    row.className = "project-row" + (p.name === currentProject ? " active-proj" : "");

    const date = new Date(p.modified * 1000);
    const dateStr = date.toLocaleDateString(undefined, { day:"numeric", month:"short", year:"numeric" })
                  + " " + date.toLocaleTimeString(undefined, { hour:"2-digit", minute:"2-digit" });

    row.innerHTML = `
      <span class="project-row-name" title="${p.name}">${p.name}</span>
      <span class="project-row-date">${dateStr}</span>
      <button class="project-row-del" title="Delete project">🗑</button>
    `;

    // คลิกชื่อ = เปิด project
    row.addEventListener("click", e => {
      if (e.target.classList.contains("project-row-del")) return;
      document.getElementById("project-select").value = p.name;
      switchProject(p.name);
      closeModal("modal-projects");
    });

    // ปุ่มลบ
    row.querySelector(".project-row-del").addEventListener("click", async e => {
      e.stopPropagation();
      if (!confirm(`Delete project "${p.name}"?\n\nThis cannot be undone.`)) return;
      await fetch(`/api/projects/${encodeURIComponent(p.name)}`, { method: "DELETE" });
      // ถ้าเป็น project ที่กำลังเปิดอยู่ ให้ reset
      if (p.name === currentProject) {
        currentProject = null;
        currentFile    = null;
        openTabs       = [];
        mainFile       = "main.tex";
        cmEditor.setValue("");
        renderTabs();
        document.getElementById("pdf-canvas-container").style.display = "none";
        document.getElementById("pdf-placeholder").style.display = "flex";
        document.getElementById("pdf-download").style.display = "none";
        document.getElementById("compile-status").textContent  = "";
        document.getElementById("file-tree").innerHTML         = "";
        hideErrorPanel();
      }
      await loadProjects();
      await renderProjectList();
    });

    el.appendChild(row);
  });
}

// ── MODALS ────────────────────────────────────────────────────
function openModal(id)  { document.getElementById(id).classList.add("open"); }
function closeModal(id) { document.getElementById(id).classList.remove("open"); }
document.querySelectorAll(".modal-overlay").forEach(o => {
  o.addEventListener("click", e => { if (e.target === o) o.classList.remove("open"); });
});

// ── EXPORT ZIP ───────────────────────────────────────────────
function exportZip() {
  if (!currentProject) return alert("Select a project first.");
  const btn = document.getElementById("export-zip-btn");
  btn.textContent = "⏳ Exporting…"; btn.disabled = true;
  const a = document.createElement("a");
  a.href = `/api/projects/${encodeURIComponent(currentProject)}/export-zip`;
  a.download = `${currentProject}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => { btn.textContent = "⬇ Export ZIP"; btn.disabled = false; }, 1500);
}

// ── WORD COUNT ────────────────────────────────────────────────
function stripLatexCommands(src) {
  return src
    .replace(/\\[a-zA-Z]+\*?\{[^}]*\}/g, " ")  // \cmd{...}
    .replace(/\\[a-zA-Z]+\*/g, " ")             // \cmd*
    .replace(/\\[a-zA-Z]+/g, " ")               // \cmd
    .replace(/[{}$%&_^~]/g, " ")                // special chars
    .replace(/\s+/g, " ").trim();
}
function updateWordCount() {
  const el = document.getElementById("word-count");
  if (!currentFile || !currentFile.endsWith(".tex")) { el.textContent = ""; return; }
  const plain = stripLatexCommands(cmEditor.getValue());
  const words = plain ? plain.split(/\s+/).filter(w => w.length > 0).length : 0;
  el.textContent = `${words.toLocaleString()} words`;
}

// ── AUTO-COMPILE ──────────────────────────────────────────────
function onAutoCompileToggle() {
  autoCompile = document.getElementById("auto-compile-toggle").checked;
  if (!autoCompile) clearTimeout(autoCompileTimer);
}

// ── LATEX AUTOCOMPLETE ────────────────────────────────────────
const LATEX_COMMANDS = [
  // document structure
  "\\documentclass","\\usepackage","\\begin","\\end","\\input","\\include",
  "\\title","\\author","\\date","\\maketitle","\\tableofcontents",
  "\\section","\\subsection","\\subsubsection","\\paragraph","\\subparagraph",
  "\\chapter","\\part","\\appendix","\\bibliography","\\bibliographystyle",
  "\\addbibresource","\\printbibliography","\\cite","\\ref","\\label","\\pageref",
  // text formatting
  "\\textbf","\\textit","\\texttt","\\textsc","\\textrm","\\textsf",
  "\\emph","\\underline","\\footnote","\\text",
  // math
  "\\frac","\\sqrt","\\sum","\\prod","\\int","\\oint","\\lim","\\infty",
  "\\alpha","\\beta","\\gamma","\\delta","\\epsilon","\\varepsilon",
  "\\zeta","\\eta","\\theta","\\vartheta","\\iota","\\kappa","\\lambda",
  "\\mu","\\nu","\\xi","\\pi","\\varpi","\\rho","\\varrho",
  "\\sigma","\\varsigma","\\tau","\\upsilon","\\phi","\\varphi","\\chi",
  "\\psi","\\omega","\\Gamma","\\Delta","\\Theta","\\Lambda","\\Xi",
  "\\Pi","\\Sigma","\\Upsilon","\\Phi","\\Psi","\\Omega",
  "\\forall","\\exists","\\nabla","\\partial","\\hbar","\\ell","\\Re","\\Im",
  "\\leq","\\geq","\\neq","\\approx","\\equiv","\\sim","\\simeq",
  "\\subset","\\supset","\\subseteq","\\supseteq","\\in","\\notin",
  "\\cup","\\cap","\\setminus","\\emptyset","\\mathbb","\\mathcal","\\mathbf",
  "\\left","\\right","\\big","\\Big","\\bigg","\\Bigg",
  "\\cdot","\\cdots","\\ldots","\\vdots","\\ddots","\\times","\\div","\\pm","\\mp",
  "\\to","\\rightarrow","\\leftarrow","\\Rightarrow","\\Leftarrow",
  "\\Leftrightarrow","\\leftrightarrow","\\mapsto",
  "\\hat","\\tilde","\\bar","\\vec","\\dot","\\ddot","\\overline","\\underline",
  "\\overbrace","\\underbrace","\\widehat","\\widetilde",
  // environments (for \begin{ autocomplete)
  "equation","equation*","align","align*","gather","gather*","multline",
  "itemize","enumerate","description","figure","table","tabular",
  "minipage","center","flushleft","flushright","verbatim","lstlisting",
  "theorem","lemma","proof","definition","remark","corollary","example",
  "abstract","titlepage","document",
  // spacing
  "\\hspace","\\vspace","\\hfill","\\vfill","\\newline","\\newpage","\\clearpage",
  "\\noindent","\\indent","\\quad","\\qquad","\\,","\\;","\\:",
  // misc
  "\\item","\\href","\\url","\\includegraphics","\\caption","\\label",
  "\\multicolumn","\\multirow","\\hline","\\cline","\\toprule","\\midrule","\\bottomrule",
  "\\newcommand","\\renewcommand","\\DeclareMathOperator",
];

// v3.2.2 — context regexes for \cite{ and \ref{ autocomplete.
//   _CITE_CTX matches the typed prefix of the LAST key inside any
//   `\xxxcite[...]{a, b, partia|}` (cite, citep, citet, nocite, textcite,
//   parencite, autocite, footcite, fullcite, etc.).
//   _REF_CTX  matches inside `\ref{`, `\eqref{`, `\autoref{`, `\cref{`,
//   `\Cref{`, `\nameref{`, `\vref{`, etc. — but NOT `\label{` (that's a
//   definition site, not a usage).
const _CITE_CTX = /\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{(?:[^}]*,\s*)?([^},\s]*)$/i;
const _REF_CTX  = /\\(?:ref|eqref|pageref|autoref|cref|Cref|nameref|vref|vpageref|crefrange|Crefrange|labelcref)\*?\{([^}]*?)$/;

// Custom renderer: bibkey/label in accent colour, dimmed metadata next to it.
// v3.2.3 — Now optionally renders a second row with the paper title when
// `item.title` is present (only set for \cite entries; label hints don't
// have a sensible title to show).
function _renderCiteHint(elt, _data, item) {
  const row1 = document.createElement("div");
  row1.className = "cite-hint-row1";
  const k = document.createElement("span");
  k.className   = "cite-hint-key";
  k.textContent = item.text;
  row1.appendChild(k);
  if (item.meta) {
    const m = document.createElement("span");
    m.className   = "cite-hint-meta";
    m.textContent = item.meta;
    row1.appendChild(m);
  }
  elt.appendChild(row1);
  if (item.title) {
    const t = document.createElement("span");
    t.className   = "cite-hint-title";
    t.textContent = item.title;
    // Native title on hover gives the full untruncated title if it overflows.
    t.title       = item.title;
    elt.appendChild(t);
  }
}

CodeMirror.registerHelper("hint","latex", function(cm) {
  const cur  = cm.getCursor();
  const line = cm.getLine(cur.line);
  const end  = cur.ch;
  const pre  = line.slice(0, end);

  // ── \cite{...} context ───────────────────────────────────────────
  const mCite = _CITE_CTX.exec(pre);
  if (mCite) {
    const typed = mCite[1] || "";
    const tlow  = typed.toLowerCase();
    // v3.2.3 — Match against key OR title so typing "rydberg" surfaces
    // every paper with "Rydberg" in the title, not just those whose key
    // contains "rydberg".
    const list  = bibkeysCache
      .filter(b => !typed
                 || b.key.toLowerCase().includes(tlow)
                 || (b.title || "").toLowerCase().includes(tlow))
      .slice(0, 80)
      .map(b => ({
        text:        b.key,
        displayText: b.key,
        meta:        b.author
                       ? (b.author + (b.year ? ` (${b.year})` : ""))
                       : (b.year ? `(${b.year})` : ""),
        title:       b.title || "",
        render:      _renderCiteHint,
      }));
    if (list.length) {
      return { list,
               from: { line: cur.line, ch: end - typed.length },
               to:   cur };
    }
    // fallthrough to generic command hints if cache empty / no match
  }

  // ── \ref{...} context ────────────────────────────────────────────
  const mRef = _REF_CTX.exec(pre);
  if (mRef) {
    const typed = mRef[1] || "";
    const tlow  = typed.toLowerCase();
    const list  = labelsCache
      .filter(l => !typed || l.name.toLowerCase().includes(tlow))
      .slice(0, 80)
      .map(l => ({
        text:        l.name,
        displayText: l.name,
        meta:        `${l.file}:${l.line}`,
        render:      _renderCiteHint,
      }));
    if (list.length) {
      return { list,
               from: { line: cur.line, ch: end - typed.length },
               to:   cur };
    }
  }

  // ── Existing \begin{...} / \cmd autocomplete ─────────────────────
  // ดึง token ปัจจุบันย้อนหลัง
  let start = end;
  while (start > 0 && /[\\\w*]/.test(line[start-1])) start--;
  const token = line.slice(start, end);
  if (!token.startsWith("\\") && !pre.match(/\\[a-zA-Z]*$/)) return;

  // ถ้า cursor อยู่หลัง \begin{ หรือ \end{ → suggest environments
  const envMatch = pre.match(/\\(?:begin|end)\{([^}]*)$/);
  if (envMatch) {
    const typed = envMatch[1];
    const envs  = LATEX_COMMANDS.filter(c => !c.startsWith("\\")).filter(c => c.startsWith(typed));
    const from  = { line: cur.line, ch: end - typed.length };
    return { list: envs, from, to: cur };
  }

  // otherwise suggest commands
  const cmdMatch = pre.match(/\\[a-zA-Z*]*$/);
  if (!cmdMatch) return;
  const typed = cmdMatch[0];
  const list  = LATEX_COMMANDS.filter(c => c.startsWith("\\") && c.startsWith(typed));
  const from  = { line: cur.line, ch: end - typed.length };
  return { list, from, to: cur };
});

// Trigger autocomplete on backslash, on letters within \cmd, AND on `{` /
// letters inside \cite{...} or \ref{...} so the dropdown shows up the
// moment the user opens the brace or starts typing a key.
cmEditor.on("keyup", (cm, e) => {
  if (!e.key) return;
  const cur = cm.getCursor();
  const pre = cm.getLine(cur.line).slice(0, cur.ch);
  const inCiteOrRef = _CITE_CTX.test(pre) || _REF_CTX.test(pre);

  // `{` is special: it TRANSITIONS context from \cmd → \cite{ / \ref{,
  // so we must force a fresh dropdown even if a stale completion is still
  // active. showHint replaces the active dropdown internally.
  if (e.key === "{" && inCiteOrRef) {
    cm.showHint({ hint: CodeMirror.hint.latex, completeSingle: false });
    return;
  }

  if (cm.state.completionActive) return;

  // Inside a cite/ref brace — fire on any printable key (incl. comma for
  // multi-key `\cite{a, b, c|}`) or Backspace to refresh the filter.
  if (inCiteOrRef && (e.key.length === 1 || e.key === "Backspace")) {
    cm.showHint({ hint: CodeMirror.hint.latex, completeSingle: false });
    return;
  }

  // \cmd context (existing behaviour)
  if (e.key === "\\" || (e.key.length === 1 && pre.match(/\\[a-zA-Z]{1,}$/))) {
    cm.showHint({ hint: CodeMirror.hint.latex, completeSingle: false });
  }
});

// ── PROSE WORD SUGGESTIONS (v4.4.0) ───────────────────────────
// One typing-time dropdown over plain prose that does two jobs:
//   1. AUTOCOMPLETE — as you type a word prefix, offer longer words that begin
//      with it, drawn from (a) words already in this document (domain terms
//      like "Rydberg", "polyglossia") and (b) the en_US dictionary. Tab OR
//      Enter inserts the highlighted word.
//   2. CORRECT — when there's nothing to complete AND the typed word is a
//      complete misspelling (e.g. "recieve"), fall back to spelling fixes (the
//      typing-time twin of the right-click "Replace with" menu).
// Both reuse the same dictionary the wavy-underline pass loads, and the same
// skip-mask, so the dropdown never fires inside \commands, math, comments, or
// citation braces. Gated on the "Word suggestions" toggle (spellSuggestEnabled).

// Walk back over letters/apostrophes to find the word ending at the cursor.
function _proseWordAt(cm, cur) {
  const line = cm.getLine(cur.line) || "";
  let start = cur.ch;
  while (start > 0 && /[A-Za-z']/.test(line[start - 1])) start--;
  return { word: line.slice(start, cur.ch), start, end: cur.ch, line };
}

// Sorted, lower-cased, de-duped dictionary word list — built once (lazily) from
// Typo's internal table so we can prefix-search by binary lower-bound. ~150k
// entries incl. inflections; the one-time filter+sort (~150ms) happens on the
// first completion, then it's cached for the session.
let _dictWords = null;
function _dictWordList() {
  if (_dictWords) return _dictWords;
  const table = spellChecker && spellChecker.dictionaryTable;
  if (!table) return null;
  const seen = new Set();
  for (const w of Object.keys(table)) {
    if (!/^[A-Za-z][A-Za-z']*$/.test(w)) continue;   // skip "0th", numbers, symbol-laced
    seen.add(w.toLowerCase());
  }
  _dictWords = Array.from(seen).sort();
  return _dictWords;
}

// Lower-bound binary search → contiguous run of words starting with `prefix`,
// strictly longer than it (a completion must add something). Sorted input.
function _dictPrefix(prefix, limit) {
  const words = _dictWordList();
  if (!words) return [];
  let lo = 0, hi = words.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (words[mid] < prefix) lo = mid + 1; else hi = mid; }
  const out = [];
  for (let i = lo; i < words.length && out.length < limit; i++) {
    if (!words[i].startsWith(prefix)) break;
    if (words[i].length > prefix.length) out.push(words[i]);
  }
  return out;
}

// Document words, cached and rebuilt only when the buffer actually changes
// (cm.changeGeneration() bumps on every edit). Preserves original casing so
// "Rydberg" completes capitalised. Capped so a huge thesis file stays cheap.
let _docWordCache = { gen: null, words: [] };
function _docWords() {
  const gen = cmEditor.changeGeneration();
  if (gen !== _docWordCache.gen) {
    const seen = new Map();   // lower → original (first-seen wins)
    const re = /[A-Za-z][A-Za-z']{1,}/g;
    const text = cmEditor.getValue();
    let m;
    while ((m = re.exec(text))) {
      const lw = m[0].toLowerCase();
      if (!seen.has(lw)) seen.set(lw, m[0]);
      if (seen.size > 6000) break;
    }
    _docWordCache = { gen, words: Array.from(seen.values()) };
  }
  return _docWordCache.words;
}

CodeMirror.registerHelper("hint", "proseword", function(cm) {
  if (!spellSuggestEnabled || !spellChecker) return;
  const cur = cm.getCursor();
  const { word, start, end, line } = _proseWordAt(cm, cur);
  if (word.length < 2) return;                              // too short → noisy
  if (/'(?:s|t|re|ve|ll|d|m)$/i.test(word)) return;         // contraction/possessive
  // Don't fire inside math / comments / \command regions / citation braces.
  const mask = _buildSkipMask(line);
  for (let j = start; j < end; j++) if (mask[j]) return;

  const lw = word.toLowerCase();
  const upperFirst = /^[A-Z]/.test(word);
  const seen = new Set([lw]);
  const out = [];
  const cap = 9;

  // 1) AUTOCOMPLETE — document words first (most relevant), then dictionary.
  for (const dw of _docWords()) {
    if (out.length >= cap) break;
    const dlw = dw.toLowerCase();
    if (dlw.length > lw.length && dlw.startsWith(lw) && !seen.has(dlw)) {
      seen.add(dlw); out.push(dw);
    }
  }
  for (const m of _dictPrefix(lw, cap)) {
    if (out.length >= cap) break;
    if (!seen.has(m)) { seen.add(m); out.push(upperFirst ? m.charAt(0).toUpperCase() + m.slice(1) : m); }
  }

  // 2) CORRECT — only when there's nothing to complete AND the whole word is a
  //    misspelling (e.g. "recieve"): offer spelling fixes instead.
  if (!out.length) {
    if (word.length < 3) return;
    if (word.length <= 5 && word === word.toUpperCase()) return;   // acronym
    if (customDict.has(lw)) return;
    if (spellChecker.check(word)) return;                          // correct & complete → nothing to add
    let suggestions;
    if (_suggestCache.has(lw)) suggestions = _suggestCache.get(lw);
    else {
      try { suggestions = spellChecker.suggest(word, 7) || []; } catch (_) { suggestions = []; }
      _suggestCache.set(lw, suggestions);
    }
    // Drop the input echo and Typo.js's occasional digit-laced junk ("vegab02nd").
    suggestions = (suggestions || []).filter(s => s && s.toLowerCase() !== lw && !/\d/.test(s));
    for (const s of suggestions) {
      if (out.length >= cap) break;
      if (!seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); }
    }
  }

  if (!out.length) return;
  return {
    list: out.map(s => ({ text: s, displayText: s })),
    from: { line: cur.line, ch: start },
    to:   { line: cur.line, ch: end },
  };
});

// Tab (and the default Enter) insert the highlighted word. extraKeys here bind
// ONLY while the dropdown is open, so the editor's normal Tab (snippet expand /
// indent) is untouched whenever the dropdown isn't showing.
const _PROSE_HINT_OPTS = {
  hint: CodeMirror.hint.proseword,
  completeSingle: false,
  extraKeys: { Tab: (cm, h) => h.pick() },
};

// Trigger. Separate keyup listener so it can't perturb the LaTeX-autocomplete
// logic above. Lightly debounced.
cmEditor.on("keyup", (cm, e) => {
  if (!spellSuggestEnabled) return;
  if (!e.key || cm.state.completionActive) return;   // a dropdown is already up
  // React only to prose typing / corrective backspace — not arrows, modifiers,
  // Enter, etc. (those would re-pop the menu the user just dismissed).
  const typing = (e.key.length === 1 && /[A-Za-z']/.test(e.key)) || e.key === "Backspace";
  if (!typing) return;
  const cur = cm.getCursor();
  const pre = cm.getLine(cur.line).slice(0, cur.ch);
  // Never compete with the LaTeX/cite/ref dropdowns — those own these contexts.
  if (_CITE_CTX.test(pre) || _REF_CTX.test(pre) || /\\[a-zA-Z]*$/.test(pre)) return;
  // Lazy-load the dictionary on first prose typing — no upfront 1.7MB for users
  // who only read or only write \commands. The load takes ~1-2s, by which time
  // the user has usually stopped typing, so we must re-fire the hint when it
  // resolves — otherwise the very FIRST word never gets a dropdown.
  if (!spellChecker) {
    _ensureSpellDict().then(d => {
      if (!d || !spellSuggestEnabled) return;
      _runSpellCheck();   // underline the wrong words now that the dict is here
      if (!cm.state.completionActive) cm.showHint(_PROSE_HINT_OPTS);
    });
    return;
  }
  clearTimeout(_spellHintTimer);
  _spellHintTimer = setTimeout(() => {
    if (cm.state.completionActive) return;
    // showHint quietly does nothing if the helper returns no list.
    cm.showHint(_PROSE_HINT_OPTS);
  }, 250);
});

// ── RESIZE PANELS ────────────────────────────────────────────
;(function() {
  // `active` is the data-resize value of the handle being dragged. Three
  // kinds today:
  //   - "sidebar"  → horizontal drag adjusts aside.width
  //   - "pdf"      → horizontal drag adjusts pdfPane.width (inverted dx)
  //   - "outline"  → vertical drag adjusts outline-section.height (v3.2.3)
  let active = null, startX = 0, startY = 0, startW = 0;
  const sidebar        = document.querySelector("aside");
  const pdfPane        = document.querySelector(".pdf-pane");
  const outlineSection = document.getElementById("outline-section");

  document.querySelectorAll(".resize-handle, .resize-handle-h").forEach(handle => {
    handle.addEventListener("mousedown", e => {
      active = handle.dataset.resize;
      startX = e.clientX;
      startY = e.clientY;
      if (active === "sidebar")      startW = sidebar.offsetWidth;
      else if (active === "outline") startW = outlineSection.offsetHeight;
      else                            startW = pdfPane.offsetWidth;
      handle.classList.add("resizing");
      document.body.style.userSelect = "none";
      document.body.style.cursor = (active === "outline") ? "row-resize" : "col-resize";
      e.preventDefault();
    });
  });

  document.addEventListener("mousemove", e => {
    if (!active) return;
    if (active === "sidebar") {
      const w = Math.max(160, Math.min(420, startW + (e.clientX - startX)));
      sidebar.style.width = w + "px";
    } else if (active === "outline") {
      // Drag handle DOWN → outline section shrinks (handle sits ABOVE it),
      // so subtract dy. Clamp so neither Files nor Outline can disappear.
      const dy = e.clientY - startY;
      // Leave at least ~80px for the file list above and respect a sensible
      // top end (60% of window height).
      const h = Math.max(60, Math.min(window.innerHeight * 0.6, startW - dy));
      outlineSection.style.height    = h + "px";
      outlineSection.style.maxHeight = "none";   // override the CSS cap
    } else {
      // ลาก handle ไปซ้าย = PDF กว้างขึ้น
      const w = Math.max(200, Math.min(window.innerWidth * 0.72, startW - (e.clientX - startX)));
      pdfPane.style.width = w + "px";
    }
    // refresh CodeMirror เมื่อ editor ขนาดเปลี่ยน
    cmEditor.refresh();
    // update error panel height ถ้ากำลังแสดงอยู่
    const ep = document.getElementById("error-panel");
    if (ep && ep.style.display === "flex") {
      const ph = document.querySelector(".pdf-pane").clientHeight;
      const th = document.querySelector(".pdf-toolbar").clientHeight;
      ep.style.height = (ph - th) + "px";
      const hdr   = document.getElementById("err-panel-hdr");
      const cards = document.getElementById("err-cards");
      if (hdr && cards) cards.style.height = (ep.clientHeight - hdr.clientHeight) + "px";
    }
  });

  document.addEventListener("mouseup", () => {
    if (!active) return;
    // v3.2.3 — include both vertical and horizontal handles in the cleanup.
    document.querySelectorAll(".resize-handle, .resize-handle-h").forEach(h => h.classList.remove("resizing"));
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    active = null;
  });
})();

// ── FONT SIZE & TAB SIZE ─────────────────────────────────────
function setFontSize(px) {
  document.querySelector(".CodeMirror").style.fontSize = px + "px";
  cmEditor.refresh();
  localStorage.setItem("texlocal_font_size", px);
}

function setTabSize(n) {
  n = parseInt(n);
  cmEditor.setOption("tabSize", n);
  cmEditor.setOption("indentUnit", n);
  localStorage.setItem("texlocal_tab_size", n);
}

// ── EDITOR TOOLBAR ACTIONS ───────────────────────────────────
function wrapSel(before, after) {
  const sel = cmEditor.getSelection();
  if (sel) {
    cmEditor.replaceSelection(before + sel + after);
  } else {
    const cur = cmEditor.getCursor();
    cmEditor.replaceSelection(before + after);
    cmEditor.setCursor({ line: cur.line, ch: cur.ch + before.length });
  }
  cmEditor.focus();
}

// ── GRAMMAR MODE (v4.4.0) ─────────────────────────────────────
// Browser grammar/paraphrase extensions (QuillBot, Grammarly, LanguageTool)
// only attach to real editable fields — CodeMirror keeps the document in its
// own model behind a hidden 1-line scratch textarea, so they can't see it.
// This opens the current selection (or, if nothing is selected, the paragraph
// around the cursor) in a genuine full <textarea> the extension CAN hook. The
// edited text is written back to the exact source range on "Insert back".
// NB: extensions run in browser mode (localhost:5000) only — the desktop
// WebView2 build doesn't load browser extensions at all.
let _grammarRange = null;

function _currentParagraphRange() {
  // Block bounded by blank lines (or document edges) around the cursor.
  const cur  = cmEditor.getCursor();
  const last = cmEditor.lastLine();
  const blank = (ln) => !(cmEditor.getLine(ln) || "").trim();
  if (blank(cur.line)) {
    const len = (cmEditor.getLine(cur.line) || "").length;
    return { from: { line: cur.line, ch: 0 }, to: { line: cur.line, ch: len } };
  }
  let top = cur.line, bot = cur.line;
  while (top > 0    && !blank(top - 1)) top--;
  while (bot < last && !blank(bot + 1)) bot++;
  return { from: { line: top, ch: 0 }, to: { line: bot, ch: (cmEditor.getLine(bot) || "").length } };
}

function openGrammarMode() {
  if (!cmEditor) return;
  const range = cmEditor.somethingSelected()
    ? { from: cmEditor.getCursor("from"), to: cmEditor.getCursor("to") }
    : _currentParagraphRange();
  _grammarRange = range;
  const ta = document.getElementById("grammar-textarea");
  if (!ta) return;
  ta.value = cmEditor.getRange(range.from, range.to);
  openModal("modal-grammar");
  // Focus + caret at end so the extension activates and typing starts cleanly.
  setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 30);
}

function applyGrammarText() {
  const ta = document.getElementById("grammar-textarea");
  if (ta && _grammarRange) {
    // Modal blocks editing while open, so the stored range is still valid.
    cmEditor.replaceRange(ta.value, _grammarRange.from, _grammarRange.to);
  }
  _grammarRange = null;
  closeModal("modal-grammar");
  cmEditor.focus();
}

function insertDisplayMath() {
  const cur = cmEditor.getCursor();
  cmEditor.replaceSelection('\\[\n\n\\]');
  cmEditor.setCursor({ line: cur.line + 1, ch: 0 });
  cmEditor.focus();
}

// ── SYNCTEX FORWARD SEARCH ───────────────────────────────────
// Forward search: editor cursor → scroll PDF to the right page.
// (Exact line highlighting is unreliable with MiKTeX synctex on paragraph text;
//  use backward search — click PDF → editor — for precise navigation instead.)

// shared timer so a fresh syncForward result isn't wiped by a stale 15s timeout
let _syncForwardStatusTimer = null;
async function syncForward() {
  if (!currentProject || !currentFile) return;
  if (!currentFile.endsWith(".tex")) return;

  // Cancel any auto-clear left over from a previous syncForward call
  if (_syncForwardStatusTimer) {
    clearTimeout(_syncForwardStatusTimer);
    _syncForwardStatusTimer = null;
  }

  const btn  = document.getElementById("synctex-btn");
  const cur  = cmEditor.getCursor();
  const line = cur.line + 1;
  const col  = cur.ch  + 1;
  const pdfName = mainFile.replace(/\.tex$/, ".pdf");

  const container = document.getElementById("pdf-canvas-container");
  if (container.style.display === "none") {
    document.getElementById("compile-status").textContent = "Compile first";
    document.getElementById("compile-status").className = "compile-status err";
    return;
  }

  btn.classList.add("syncing");
  btn.classList.remove("error");

  try {
    const res  = await fetch(
      `/api/projects/${encodeURIComponent(currentProject)}/synctex/forward` +
      `?file=${encodeURIComponent(currentFile)}&line=${line}&col=${col}&pdf=${encodeURIComponent(pdfName)}`
    );
    const data = await res.json();

    if (!data.ok) {
      btn.classList.remove("syncing"); btn.classList.add("error");
      setTimeout(() => btn.classList.remove("error"), 2000);
      document.getElementById("compile-status").textContent = data.error || "SyncTeX failed";
      document.getElementById("compile-status").className = "compile-status err";
      return;
    }

    // Scroll to the correct page + highlight full wrapped paragraph range
    // data.y  = top of first visual line (from TOP of page)
    // data.y2 = baseline of last visual line (from TOP of page)
    // data.h  = glyph ascent (~10pt) for descent calc
    pdfScrollToPosition(data.page, data.x, data.y, data.h || 10, 0, data.y2 || 0);

    btn.classList.remove("syncing");
    btn.style.color = "var(--green)";
    setTimeout(() => { btn.style.color = ""; }, 800);

    // Brief confirmation — auto-clears after a couple seconds.
    const dbg = data.debug || {};
    const matchedNote = (dbg.matched_line && dbg.matched_line !== (cmEditor.getCursor().line + 1))
                          ? ` (matched line ${dbg.matched_line})` : "";
    document.getElementById("compile-status").textContent = `⇢ Page ${data.page}${matchedNote}`;
    document.getElementById("compile-status").className   = "compile-status ok";
    _syncForwardStatusTimer = setTimeout(() => {
      document.getElementById("compile-status").textContent = "";
      document.getElementById("compile-status").className = "compile-status";
      _syncForwardStatusTimer = null;
    }, 2000);

  } catch (e) {
    btn.classList.remove("syncing"); btn.classList.add("error");
    setTimeout(() => btn.classList.remove("error"), 2000);
  }
}

// ── THEME ────────────────────────────────────────────────────
function setTheme(theme, skipSave) {
  if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  if (!skipSave) localStorage.setItem("texlocal_theme", theme);
  // sync settings panel buttons
  document.getElementById("theme-dark-btn").classList.toggle("active", theme === "dark");
  document.getElementById("theme-light-btn").classList.toggle("active", theme === "light");
}

// v3.2.3 — Editor theme (independent of UI theme). "dark" applies the
// dark-bg / light-ink palette to the CodeMirror pane only. "light" reverts
// to the default white-bg look. Persisted globally (not per-project).
function setEditorTheme(theme, skipSave) {
  if (theme === "dark") {
    document.documentElement.setAttribute("data-editor-theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-editor-theme");
  }
  if (!skipSave) localStorage.setItem("texlocal_editor_theme", theme);
  const lightBtn = document.getElementById("editor-theme-light-btn");
  const darkBtn  = document.getElementById("editor-theme-dark-btn");
  if (lightBtn) lightBtn.classList.toggle("active", theme === "light");
  if (darkBtn)  darkBtn.classList.toggle("active", theme === "dark");
}

// ── v3.2.3 — QUICK OPEN (Ctrl+P) ────────────────────────────────
// File cache is refreshed by loadFiles(). Matching is a simple subsequence
// scorer: each query character must appear in order in the candidate; we
// reward consecutive matches, basename hits, and earlier hit positions.
// Top-50 are shown to keep the list snappy on big projects.
let quickOpenFiles  = [];   // current project's file list (filtered)
let qoActiveIdx     = 0;
let qoCurrentMatches = [];

function setQuickOpenFiles(files) {
  // Called from loadFiles after fetching. We keep all non-generated files
  // (images included — quick-open is a navigator, not a tex-only switcher).
  quickOpenFiles = (files || []).slice();
}

function _qoFuzzyScore(query, text) {
  // Returns { score, hits: [indices] } or null if not a subsequence match.
  // Higher score = better. Bonuses for: consecutive char streaks, hits inside
  // the basename portion, and hits at position 0 of the basename.
  if (!query) return { score: 0, hits: [] };
  const q   = query.toLowerCase();
  const t   = text.toLowerCase();
  const baseStart = text.lastIndexOf("/") + 1;
  let ti = 0, qi = 0, score = 0, streak = 0;
  const hits = [];
  while (qi < q.length && ti < t.length) {
    if (t[ti] === q[qi]) {
      hits.push(ti);
      let bonus = 1;
      if (ti >= baseStart) bonus += 2;       // basename hits weigh more
      if (ti === baseStart) bonus += 3;      // very first char of basename
      bonus += streak;                       // reward consecutive matches
      score += bonus;
      streak++;
      qi++;
    } else {
      streak = 0;
    }
    ti++;
  }
  if (qi < q.length) return null;
  // Shorter paths break ties — they're usually more relevant.
  score -= text.length * 0.02;
  return { score, hits };
}

function _qoRenderHits(text, hits) {
  // Wrap matched chars in <span class="qo-hit">. Hits is sorted asc.
  if (!hits || !hits.length) return _esc(text);
  let out = "", cursor = 0;
  for (const i of hits) {
    if (i > cursor) out += _esc(text.slice(cursor, i));
    out += `<span class="qo-hit">${_esc(text[i])}</span>`;
    cursor = i + 1;
  }
  if (cursor < text.length) out += _esc(text.slice(cursor));
  return out;
}

function _esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[c]);
}

function _qoRebuild() {
  const q = document.getElementById("qo-input").value.trim();
  let matches;
  if (!q) {
    // Empty query — show recent files (just the first 50) so the modal
    // is still useful as a "what was I working on" jumper.
    matches = quickOpenFiles.slice(0, 50).map(f => ({ path: f, score: 0, hits: [] }));
  } else {
    matches = [];
    for (const f of quickOpenFiles) {
      const r = _qoFuzzyScore(q, f);
      if (r) matches.push({ path: f, score: r.score, hits: r.hits });
    }
    matches.sort((a, b) => b.score - a.score);
    matches = matches.slice(0, 50);
  }
  qoCurrentMatches = matches;
  qoActiveIdx = 0;
  _qoRenderList();
}

function _qoRenderList() {
  const list = document.getElementById("qo-list");
  if (!qoCurrentMatches.length) {
    list.innerHTML = `<div class="qo-empty">No files match</div>`;
    return;
  }
  list.innerHTML = qoCurrentMatches.map((m, i) => {
    const slash = m.path.lastIndexOf("/");
    const dir   = slash >= 0 ? m.path.slice(0, slash) : "";
    const base  = slash >= 0 ? m.path.slice(slash + 1) : m.path;
    // Re-score the hits relative to the slice. Easier: just render the full
    // path with hits, then place basename on left and dir on right.
    const baseHits = m.hits
      .filter(h => h > slash)
      .map(h => h - slash - 1);
    return `<div class="qo-item ${i === qoActiveIdx ? "active" : ""}" data-idx="${i}">
      <span class="qo-name">${_qoRenderHits(base, baseHits)}</span>
      ${dir ? `<span class="qo-path">${_esc(dir)}</span>` : ""}
    </div>`;
  }).join("");
  // Wire clicks and ensure active item is in view
  list.querySelectorAll(".qo-item").forEach(el => {
    el.addEventListener("click", () => {
      qoActiveIdx = parseInt(el.dataset.idx, 10);
      _qoOpenSelected();
    });
  });
  const activeEl = list.querySelector(".qo-item.active");
  if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
}

function _qoOpenSelected() {
  const m = qoCurrentMatches[qoActiveIdx];
  if (!m) return;
  closeQuickOpen();
  // Re-use the existing openFile path so all the same side-effects fire
  // (tabs, cite cache reload, autoflag, etc.).
  openFile(m.path);
}

function openQuickOpen() {
  if (!currentProject) return;
  const overlay = document.getElementById("quick-open-overlay");
  const input   = document.getElementById("qo-input");
  overlay.classList.add("open");
  input.value = "";
  _qoRebuild();
  // Defer focus until display:flex has applied — otherwise focus() is a no-op.
  setTimeout(() => input.focus(), 0);
}

function closeQuickOpen() {
  document.getElementById("quick-open-overlay").classList.remove("open");
  // Return focus to the editor so typing resumes naturally.
  if (cmEditor) cmEditor.focus();
}

// Single keydown handler on the input drives navigation. Bound once via
// inline addEventListener in init() (after DOM is ready).
function _qoOnInputKey(e) {
  if (e.key === "Escape") { e.preventDefault(); closeQuickOpen(); return; }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (qoCurrentMatches.length) {
      qoActiveIdx = (qoActiveIdx + 1) % qoCurrentMatches.length;
      _qoRenderList();
    }
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    if (qoCurrentMatches.length) {
      qoActiveIdx = (qoActiveIdx - 1 + qoCurrentMatches.length) % qoCurrentMatches.length;
      _qoRenderList();
    }
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    _qoOpenSelected();
    return;
  }
}

// ── FOCUS MODE ────────────────────────────────────────────────
function toggleFocusMode() {
  document.body.classList.toggle("focus-mode");
  setTimeout(() => cmEditor.refresh(), 50);
}
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    if (document.body.classList.contains("focus-mode")) {
      document.body.classList.remove("focus-mode");
      setTimeout(() => cmEditor.refresh(), 50);
    }
    hideSearchPanel();
  }
  if (e.ctrlKey && e.altKey && e.key === "ArrowRight") {
    e.preventDefault();
    syncForward();
  }
  if (e.ctrlKey && e.shiftKey && e.key === "F") {
    e.preventDefault();
    toggleSearchPanel();
  }
  // v3.2.3 — Quick file switcher. Match both Ctrl+P (Win/Linux) and Cmd+P
  // (Mac). Suppressed when the modal is already open so the input can use
  // P naturally.
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "p" || e.key === "P")) {
    const overlay = document.getElementById("quick-open-overlay");
    if (overlay && !overlay.classList.contains("open")) {
      e.preventDefault();
      openQuickOpen();
    }
  }
});

// v3.2.3 — Bind the quick-open input's own key handler once on first ready
// frame (the modal exists from initial render but we attach lazily to avoid
// running before the DOM is parsed in some bundling edge cases).
window.addEventListener("DOMContentLoaded", () => {
  const inp = document.getElementById("qo-input");
  if (inp) {
    inp.addEventListener("input", _qoRebuild);
    inp.addEventListener("keydown", _qoOnInputKey);
  }
});

// ── SETTINGS PANEL ───────────────────────────────────────────
function toggleSettingsPanel(e) {
  const panel = document.getElementById("settings-panel");
  if (panel.classList.contains("open")) {
    panel.classList.remove("open");
    return;
  }
  _closeOtherToolbarPanels("settings-panel"); // v3.3.7
  const btn  = document.getElementById("settings-btn");
  const rect = btn.getBoundingClientRect();
  const pw   = 256;
  let left = rect.right - pw;
  if (left < 4) left = 4;
  panel.style.top  = (rect.bottom + 4) + "px";
  panel.style.left = left + "px";
  // sync current state into panel
  const curTheme = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  document.getElementById("theme-dark-btn").classList.toggle("active", curTheme === "dark");
  document.getElementById("theme-light-btn").classList.toggle("active", curTheme === "light");
  // v3.2.3 — sync editor theme buttons
  const curEditorTheme = document.documentElement.getAttribute("data-editor-theme") === "dark" ? "dark" : "light";
  document.getElementById("editor-theme-light-btn").classList.toggle("active", curEditorTheme === "light");
  document.getElementById("editor-theme-dark-btn").classList.toggle("active", curEditorTheme === "dark");
  document.getElementById("auto-compile-toggle").checked = autoCompile;
  document.getElementById("draft-mode-toggle").checked   = draftMode;
  // v3.3.2 — sync spell check toggle to current state (may have been changed
  // programmatically since the popup was last opened).
  const spCb = document.getElementById("spellcheck-toggle");
  if (spCb) spCb.checked = spellEnabled;
  if (currentProject) {
    const saved = localStorage.getItem(`texlocal_compiler_${currentProject}`) || "pdflatex";
    document.getElementById("compiler-select").value = saved;
  }
  panel.classList.add("open");
  if (e) e.stopPropagation();
}

function closeSettingsPanel() {
  document.getElementById("settings-panel").classList.remove("open");
}

document.addEventListener("click", e => {
  const panel = document.getElementById("settings-panel");
  if (!panel.classList.contains("open")) return;
  if (panel.contains(e.target)) return;
  if (e.target.closest("#settings-btn")) return;
  panel.classList.remove("open");
});

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

function renderSymbolPanel() {
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

function selectSymCat(i, e) {
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

function insertSymbol(cmd, e) {
  // The same safety net as selectSymCat — and it also covers the case
  // where focus shifts to the editor after replaceSelection, which on
  // some browsers fires a synthetic click that bubbles to document.
  if (e) e.stopPropagation();
  const cursor = cmEditor.getCursor();
  cmEditor.replaceSelection(cmd);
  // if command ends with {} put cursor inside braces
  if (cmd.endsWith("{}")) {
    cmEditor.setCursor({ line: cursor.line, ch: cursor.ch + cmd.length - 1 });
  }
  cmEditor.focus();
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
function selectEnvCat(i, e) {
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
function insertEnv(catIdx, itemIdx, e) {
  if (e) e.stopPropagation();
  const it = ENV_CATEGORIES[catIdx].items[itemIdx];
  if (!it) return;
  const snippet = it.snippet;
  const pipe    = snippet.indexOf("|");
  const cleaned = pipe >= 0 ? snippet.replace("|", "") : snippet;
  const cursor  = cmEditor.getCursor();
  cmEditor.replaceSelection(cleaned);
  if (pipe >= 0) {
    // Compute target cursor: walk `snippet[:pipe]` to count newlines
    // and trailing-line characters from the original cursor position.
    const pre   = snippet.slice(0, pipe);
    const lines = pre.split("\n");
    const tgt = lines.length === 1
      ? { line: cursor.line, ch: cursor.ch + lines[0].length }
      : { line: cursor.line + lines.length - 1, ch: lines[lines.length - 1].length };
    cmEditor.setCursor(tgt);
  }
  cmEditor.focus();
}
function toggleEnvPanel(e) {
  const panel = document.getElementById("env-panel");
  if (panel.classList.contains("open")) {
    panel.classList.remove("open");
    return;
  }
  _closeOtherToolbarPanels("env-panel"); // v3.3.7
  const btn  = document.getElementById("env-toggle-btn");
  const rect = btn.getBoundingClientRect();
  const pw   = 380;
  let left   = rect.right - pw;
  if (left < 4) left = 4;
  panel.style.top  = (rect.bottom + 4) + "px";
  panel.style.left = left + "px";
  renderEnvPanel();
  panel.classList.add("open");
  if (e) e.stopPropagation();
}
document.addEventListener("click", e => {
  const panel = document.getElementById("env-panel");
  if (!panel || !panel.classList.contains("open")) return;
  if (panel.contains(e.target)) return;
  if (e.target.closest("#env-toggle-btn")) return;
  panel.classList.remove("open");
});

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

async function loadSnippets() {
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
function _snippetTabHandler(cm) {
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
cmEditor.on("cursorActivity", () => {
  if (!_snippetSession) return;
  const ranges = _snippetSession.markers
    .map(m => m.mark.find()).filter(Boolean);
  if (!ranges.length) { _snippetClear(); return; }
  let minLine = Infinity, maxLine = -Infinity;
  for (const r of ranges) {
    if (r.from.line < minLine) minLine = r.from.line;
    if (r.to.line   > maxLine) maxLine = r.to.line;
  }
  const cur = cmEditor.getCursor();
  if (cur.line < minLine - 1 || cur.line > maxLine + 1) _snippetClear();
});

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
      const cur = cmEditor.getCursor();
      _snippetExpand(cmEditor, body, cur, cur);
      document.getElementById("snippet-panel").classList.remove("open");
      cmEditor.focus();
    });
  });
}

function toggleSnippetPanel(e) {
  const panel = document.getElementById("snippet-panel");
  if (panel.classList.contains("open")) {
    panel.classList.remove("open");
    return;
  }
  _closeOtherToolbarPanels("snippet-panel"); // v3.3.7
  const btn  = document.getElementById("snippet-toggle-btn");
  const rect = btn.getBoundingClientRect();
  const pw   = 380;
  let left   = rect.right - pw;
  if (left < 4) left = 4;
  panel.style.top  = (rect.bottom + 4) + "px";
  panel.style.left = left + "px";
  renderSnippetPanel();
  panel.classList.add("open");
  if (e) e.stopPropagation();
}
document.addEventListener("click", e => {
  const panel = document.getElementById("snippet-panel");
  if (!panel || !panel.classList.contains("open")) return;
  if (panel.contains(e.target)) return;
  if (e.target.closest("#snippet-toggle-btn")) return;
  panel.classList.remove("open");
});

// ── v3.2.2 — TODO tracker ────────────────────────────────────
async function loadTodosUI() {
  if (!currentProject) return;
  const list  = document.getElementById("td-list");
  const count = document.getElementById("td-count");
  list.innerHTML = '<div class="td-empty">Scanning…</div>';
  count.textContent = "";
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/todos`);
    const d = await r.json();
    const todos = d.todos || [];
    if (!todos.length) {
      list.innerHTML =
        `<div class="td-empty">No <code>\\todo{}</code>, <code>% TODO</code>,
         <code>% FIXME</code>, or <code>% XXX</code> markers found.<br><br>
         Add comments like <code>% TODO derive eq.</code> in your .tex
         files to track pending work.</div>`;
      return;
    }
    count.textContent = `${todos.length} item${todos.length === 1 ? "" : "s"}`;
    list.innerHTML = todos.map(t =>
      `<div class="td-item" onclick="jumpToTodo('${escapeAttr(t.file)}', ${t.line})">
         <span class="td-tag ${t.kind}">${t.kind === "todo" ? "todo" : t.kind}</span>
         <span class="td-text">${escapeHtml(t.text || "(empty)")}</span>
         <span class="td-loc">${escapeHtml(t.file)}:${t.line}</span>
       </div>`
    ).join("");
  } catch (e) {
    list.innerHTML = `<div class="td-empty" style="color:var(--red)">Load failed: ${escapeHtml(e.message)}</div>`;
  }
}
async function jumpToTodo(file, line) {
  if (file !== currentFile) await openFile(file);
  const lineNo = Math.max(0, (line | 0) - 1);
  setTimeout(() => {
    cmEditor.setCursor(lineNo, 0);
    cmEditor.scrollIntoView({ line: lineNo, ch: 0 }, 120);
    cmEditor.focus();
    cmEditor.addLineClass(lineNo, "background", "cm-synctex-jump");
    setTimeout(() => cmEditor.removeLineClass(lineNo, "background", "cm-synctex-jump"), 1200);
  }, file !== currentFile ? 200 : 0);
  document.getElementById("todo-panel").classList.remove("open");
}
// v4.4.0 — DOCUMENT OUTLINE ─────────────────────────────────────────
function toggleOutlinePanel(e) {
  const panel = document.getElementById("outline-panel");
  if (panel.classList.contains("open")) { panel.classList.remove("open"); return; }
  _closeOtherToolbarPanels("outline-panel");
  const btn  = document.getElementById("outline-toggle-btn");
  const rect = btn.getBoundingClientRect();
  const pw   = 360;
  let left   = rect.right - pw;
  if (left < 4) left = 4;
  panel.style.top  = (rect.bottom + 4) + "px";
  panel.style.left = left + "px";
  renderOutlinePanel();
  panel.classList.add("open");
  if (e) e.stopPropagation();
}
document.addEventListener("click", e => {
  const panel = document.getElementById("outline-panel");
  if (!panel || !panel.classList.contains("open")) return;
  if (panel.contains(e.target)) return;
  if (e.target.closest("#outline-toggle-btn")) return;
  panel.classList.remove("open");
});

const _OL_LEVEL_LABEL = { chapter: "chapter", section: "section", subsection: "subsection", subsubsection: "subsub" };
const _OL_INDENT      = { chapter: 0, section: 1, subsection: 2, subsubsection: 3 };

async function renderOutlinePanel() {
  const list = document.getElementById("ol-list");
  const cnt  = document.getElementById("ol-count");
  if (!currentProject) { list.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:12px">No project open.</div>'; return; }
  list.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:12px">Scanning…</div>';
  try {
    const res  = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/outline`);
    const data = await res.json();
    if (!data.length) {
      list.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:12px">No sections found.</div>';
      cnt.textContent = ""; return;
    }
    cnt.textContent = data.length + " entries";
    const frag = document.createDocumentFragment();
    data.forEach(item => {
      const div = document.createElement("div");
      div.className = `ol-row ol-indent-${_OL_INDENT[item.level] || 0}`;
      div.innerHTML =
        `<span class="ol-level">${_OL_LEVEL_LABEL[item.level] || item.level}</span>` +
        `<span class="ol-title" title="${item.title.replace(/"/g,'&quot;')}">${item.title || '(untitled)'}</span>` +
        `<span class="ol-file" title="${item.file}">${item.file.split('/').pop()}</span>`;
      div.addEventListener("click", async () => {
        await openFile(item.file);
        cmEditor.setCursor(item.line, 0);
        cmEditor.scrollIntoView({ line: item.line, ch: 0 }, 80);
        cmEditor.focus();
      });
      frag.appendChild(div);
    });
    list.innerHTML = "";
    list.appendChild(frag);
  } catch (err) {
    list.innerHTML = `<div style="padding:12px;color:var(--error);font-size:12px">Error: ${err.message}</div>`;
  }
}


function toggleTodoPanel(e) {
  const panel = document.getElementById("todo-panel");
  if (panel.classList.contains("open")) {
    panel.classList.remove("open");
    return;
  }
  _closeOtherToolbarPanels("todo-panel"); // v3.3.7
  const btn  = document.getElementById("todo-toggle-btn");
  const rect = btn.getBoundingClientRect();
  const pw   = 420;
  let left   = rect.right - pw;
  if (left < 4) left = 4;
  panel.style.top  = (rect.bottom + 4) + "px";
  panel.style.left = left + "px";
  loadTodosUI();
  panel.classList.add("open");
  if (e) e.stopPropagation();
}
document.addEventListener("click", e => {
  const panel = document.getElementById("todo-panel");
  if (!panel || !panel.classList.contains("open")) return;
  if (panel.contains(e.target)) return;
  if (e.target.closest("#todo-toggle-btn")) return;
  panel.classList.remove("open");
});

// ── v3.2.3 — WORD-COUNT-PER-CHAPTER GOALS ───────────────────────
// State: goalsData = { goals: {path: target}, counts: {path: words} }
// The panel lists files. Default view = only files with a goal set.
// Toggle "Show all" to inline-set new goals on any .tex file.
//
// Persistence flow: user edits a number → blur fires → POST /goals
// with the full updated map → server overwrites .texlocal-goals.json.
let goalsData = { goals: {}, counts: {} };

async function loadGoalsUI() {
  const list = document.getElementById("gp-list");
  if (!currentProject) {
    list.innerHTML = '<div class="gp-empty">Open a project first</div>';
    return;
  }
  list.innerHTML = '<div class="gp-empty">Scanning word counts…</div>';
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/goals`);
    const d = await r.json();
    goalsData = { goals: d.goals || {}, counts: d.counts || {} };
  } catch (_) {
    goalsData = { goals: {}, counts: {} };
  }
  renderGoalsPanel();
}

function renderGoalsPanel() {
  const list    = document.getElementById("gp-list");
  const showAll = document.getElementById("gp-show-all").checked;
  // Decide which files to show
  const allPaths = Object.keys(goalsData.counts).sort();
  const visible  = showAll
    ? allPaths
    : Object.keys(goalsData.goals).sort();
  if (!visible.length) {
    list.innerHTML = `<div class="gp-empty">
      ${showAll
        ? 'No .tex files in this project'
        : 'No goals set yet — toggle "Show all files" above to set one'}
    </div>`;
    _updateGoalsFooter();
    return;
  }
  // Build with data-path attributes; click and blur handlers are wired after
  // innerHTML so we avoid double-escaping JS string literals through HTML.
  list.innerHTML = visible.map(p => {
    const count  = goalsData.counts[p] || 0;
    const target = goalsData.goals[p]  || 0;
    const pct    = target > 0 ? Math.min(100, (count / target) * 100) : 0;
    const cls    = target > 0 && count >= target
      ? (count > target * 1.1 ? "over" : "full")
      : "";
    return `<div class="gp-row" data-path="${_esc(p)}">
      <span class="gp-name" data-path="${_esc(p)}">${_esc(p)}</span>
      <span class="gp-count">${count.toLocaleString()}</span>
      <input class="gp-target" type="number" min="0" placeholder="–" value="${target || ""}" data-path="${_esc(p)}">
      <div class="gp-bar-wrap"><div class="gp-bar ${cls}" style="width:${pct}%"></div></div>
    </div>`;
  }).join("");
  list.querySelectorAll(".gp-name").forEach(el => {
    el.addEventListener("click", () => {
      openFile(el.dataset.path);
      toggleGoalsPanel();
    });
  });
  list.querySelectorAll(".gp-target").forEach(inp => {
    inp.addEventListener("blur", () => onGoalChange(inp.dataset.path, inp.value));
    // Pressing Enter inside the input commits + blurs.
    inp.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); inp.blur(); }
    });
  });
  _updateGoalsFooter();
}

function _updateGoalsFooter() {
  // Footer aggregates across the files that have a goal set (regardless of
  // show-all state) — that's the meaningful "thesis progress" number.
  let tCount = 0, tTarget = 0;
  for (const p of Object.keys(goalsData.goals)) {
    tCount  += goalsData.counts[p] || 0;
    tTarget += goalsData.goals[p]  || 0;
  }
  document.getElementById("gp-foot-count").textContent  = tCount.toLocaleString();
  document.getElementById("gp-foot-target").textContent = tTarget.toLocaleString();
  // Header subtitle: short progress summary
  const sub = document.getElementById("gp-totals");
  if (tTarget > 0) {
    const pct = Math.round((tCount / tTarget) * 100);
    sub.textContent = `· ${pct}% (${tCount.toLocaleString()}/${tTarget.toLocaleString()})`;
  } else {
    sub.textContent = "";
  }
}

async function onGoalChange(path, raw) {
  // Empty / 0 clears the goal entry. We send the FULL updated map so the
  // server can overwrite atomically — that way a stale tab can't resurrect
  // a deleted goal.
  const n = parseInt(raw, 10);
  if (!n || n <= 0) {
    delete goalsData.goals[path];
  } else {
    goalsData.goals[path] = n;
  }
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/goals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goals: goalsData.goals }),
    });
    if (!r.ok) throw new Error("save failed");
    const d = await r.json();
    if (d.goals) goalsData.goals = d.goals;
  } catch (_) {
    // Soft-fail — keep the in-memory state, just no persistence this round.
  }
  renderGoalsPanel();
}

function toggleGoalsPanel(e) {
  const panel = document.getElementById("goals-panel");
  if (panel.classList.contains("open")) {
    panel.classList.remove("open");
    return;
  }
  _closeOtherToolbarPanels("goals-panel"); // v3.3.7
  const btn  = document.getElementById("goals-toggle-btn");
  const rect = btn.getBoundingClientRect();
  const pw   = 460;
  let left   = rect.right - pw;
  if (left < 4) left = 4;
  panel.style.top  = (rect.bottom + 4) + "px";
  panel.style.left = left + "px";
  loadGoalsUI();
  panel.classList.add("open");
  if (e) e.stopPropagation();
}
document.addEventListener("click", e => {
  const panel = document.getElementById("goals-panel");
  if (!panel || !panel.classList.contains("open")) return;
  if (panel.contains(e.target)) return;
  if (e.target.closest("#goals-toggle-btn")) return;
  panel.classList.remove("open");
});

// ── v3.2.3 — RECENT COMPILE LOG HISTORY ─────────────────────────
// Stored per-project in localStorage. Each entry:
//   { ts, elapsed, ok, errCount, warnCount, draft, partial, log }
// Logs are capped at 50KB to keep localStorage under quota (10 entries × 50KB
// = 500KB worst case). Truncated logs get a "... [truncated]" suffix.
const HISTORY_MAX_LEN = 10;
const HISTORY_LOG_CAP = 50 * 1024;
let _historyActiveIdx = -1;

function _historyKey() {
  return currentProject ? `texlocal_compile_history_${currentProject}` : null;
}

function loadCompileHistory() {
  const k = _historyKey();
  if (!k) return [];
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function saveCompileHistory(arr) {
  const k = _historyKey();
  if (!k) return;
  try {
    localStorage.setItem(k, JSON.stringify(arr));
  } catch (e) {
    // Quota exceeded — drop the oldest half and retry once.
    try {
      const trimmed = arr.slice(0, Math.max(3, Math.floor(arr.length / 2)));
      localStorage.setItem(k, JSON.stringify(trimmed));
    } catch (_) { /* give up silently */ }
  }
}

function recordCompileToHistory({ log, ok, elapsed, parsed }) {
  if (!currentProject) return;
  let logTrunc = log || "";
  if (logTrunc.length > HISTORY_LOG_CAP) {
    logTrunc = logTrunc.slice(0, HISTORY_LOG_CAP) + "\n... [truncated]";
  }
  const entry = {
    ts:        Date.now(),
    elapsed:   elapsed,
    ok:        !!ok,
    errCount:  (parsed && parsed.errors)   ? parsed.errors.length   : 0,
    warnCount: (parsed && parsed.warnings) ? parsed.warnings.length : 0,
    draft:     !!draftMode,
    partial:   selectedIncludes.length > 0
                 && availableIncludes.length > 0
                 && selectedIncludes.length < availableIncludes.length,
    log:       logTrunc,
  };
  const arr = loadCompileHistory();
  arr.unshift(entry);                       // newest first
  if (arr.length > HISTORY_MAX_LEN) arr.length = HISTORY_MAX_LEN;
  saveCompileHistory(arr);
  // If panel is open, refresh display
  if (document.getElementById("history-panel").classList.contains("open")) {
    renderHistoryPanel();
  }
}

// ── SPELL CHECK (v3.3.2) ─────────────────────────────────────
//
// Design notes (the WHY, since the WHAT is in the code):
//
//  * Why Typo.js: pure-JS Hunspell port, works with the same en_US.aff /
//    en_US.dic files Firefox + LibreOffice ship — high-quality affixed
//    dictionary, handles past-tense / plurals / suffixes correctly without
//    us having to bundle a giant precomputed word list. Cost: ~1.7MB dict
//    on first enable, but cached by the browser thereafter.
//
//  * Why text-based skip-mask instead of CodeMirror getTokenAt(): the
//    stex tokeniser is reliable for control sequences (\foo → "tag") but
//    its math-mode and brace-content typing is brittle across versions
//    (CM5 stex sometimes emits null for variable names inside math).
//    A small per-line regex pass that masks $...$, \cmd, and brace args
//    of citation-like commands gives us higher precision with less code
//    AND no dependency on private stex state shape.
//
//  * Why per-line scan, not full-doc: thesis files run 1500+ lines; scanning
//    everything on every keystroke would jank the editor. We rescan only the
//    visible viewport (+ a small buffer above/below for scroll smoothness)
//    on toggle-on and on debounced change events.
//
//  * Why a custom dict file (.texlocal-dict.txt) not a UI: Pol's thesis uses
//    Rydberg, Hubbard, Mott, Endres, PeterSchauss, etc. — proper nouns the
//    en_US dictionary can never know. A one-word-per-line text file at the
//    project root is the most portable form (travels via /export-zip, edits
//    in any text editor). Right-click "Add to dictionary" UI is deferred.
//
//  * Why match >= 3-letter English words only: filters out single-letter
//    variables in math that escape the skip-mask (e.g. `x` in `let x = 5`)
//    and avoids spell-checking acronyms (PRA, JOSA, RMP) — they'd flood the
//    panel since en_US doesn't know journal-name acronyms.

// Commands whose immediate brace arg is identifier-like (NOT prose) — skip.
// Order matters slightly: longer prefixes first would matter if we ran prefix
// match, but we anchor on \b so prefix collisions aren't an issue.
const _SPELL_SKIP_BRACE_CMDS = /\\(?:cite[a-zA-Z]*|ref|eqref|cref|Cref|autoref|nameref|pageref|footcite|textcite|citeauthor|citeyear|citep|citet|nocite|label|input|include|includeonly|bibliography|bibliographystyle|includegraphics|usepackage|RequirePackage|documentclass|href|url|nolinkurl|graphicspath|inputenc|fontenc|setmainfont|setsansfont|setmonofont|setmainlanguage|babelfont|newcommand|renewcommand|providecommand|DeclareMathOperator|def)\b/g;

async function _ensureSpellDict() {
  // Dedup concurrent loads — toggle-on while loading shouldn't kick off two.
  if (spellChecker) return spellChecker;
  if (spellLoadingPromise) return spellLoadingPromise;
  const status = document.getElementById("spell-status");
  if (status) { status.textContent = "Loading dictionary…"; status.classList.add("visible"); }
  spellLoadingPromise = (async () => {
    if (typeof Typo === "undefined") {
      // CDN failed (offline?) — surface the failure once and don't retry.
      if (status) { status.textContent = "Spell dict failed to load"; setTimeout(() => status.classList.remove("visible"), 3000); }
      console.error("[spellcheck] Typo.js global missing — CDN blocked?");
      return null;
    }
    try {
      const base = "https://cdn.jsdelivr.net/npm/typo-js@1.2.4/dictionaries/en_US";
      const [aff, dic] = await Promise.all([
        fetch(base + "/en_US.aff").then(r => r.ok ? r.text() : Promise.reject(r.status)),
        fetch(base + "/en_US.dic").then(r => r.ok ? r.text() : Promise.reject(r.status)),
      ]);
      // platform "any" forces Typo to use the in-memory dict args (not try to
      // fetch them itself — which would fail because Typo guesses a relative
      // path that doesn't match jsdelivr's layout).
      spellChecker = new Typo("en_US", aff, dic, { platform: "any" });
      if (status) { status.textContent = "Dictionary loaded"; setTimeout(() => status.classList.remove("visible"), 1500); }
      return spellChecker;
    } catch (e) {
      if (status) { status.textContent = "Spell dict failed to load"; setTimeout(() => status.classList.remove("visible"), 3000); }
      console.error("[spellcheck] dict load failed:", e);
      return null;
    } finally {
      spellLoadingPromise = null;
    }
  })();
  return spellLoadingPromise;
}

async function loadCustomDict(projectName) {
  customDict = new Set();
  customDictMtime = 0;
  if (!projectName) return;
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectName)}/dict`);
    if (!res.ok) return;
    const data = await res.json();
    (data.words || []).forEach(w => customDict.add(String(w).toLowerCase()));
    // v3.3.5 — Cache mtime for hot-reload comparison. Missing/zero means the
    // file doesn't exist yet; next focus tick will see a non-zero mtime if
    // the user creates it externally.
    customDictMtime = Number(data.mtime) || 0;
  } catch (_) { /* dict file is optional; absence is fine */ }
  // If spell check is already active, rescan so newly-added words clear.
  if (_spellHighlightOn()) scheduleSpellCheck(50);
}

// v3.3.5 — Hot-reload on window focus. Fires when Pol alt-tabs back to the
// editor. Cheap mtime check on the backend: if the dict file was edited
// externally (e.g. VS Code, hand-edit to remove a word), swap customDict
// and trigger a rescan so wavy underlines update without a page reload.
// No-ops when spell check is off (no point fetching) or no project loaded.
async function _maybeReloadDictOnFocus() {
  if (!spellEnabled && !spellSuggestEnabled) return;
  if (!currentProject) return;
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/dict`);
    if (!res.ok) return;
    const data = await res.json();
    const newMtime = Number(data.mtime) || 0;
    // Same mtime → file unchanged; bail out without disturbing customDict.
    if (newMtime === customDictMtime) return;
    customDict = new Set();
    (data.words || []).forEach(w => customDict.add(String(w).toLowerCase()));
    customDictMtime = newMtime;
    if (spellChecker) scheduleSpellCheck(30);
  } catch (_) { /* network blip; try again on next focus */ }
}
// Wire the focus listener once at script load.
window.addEventListener("focus", _maybeReloadDictOnFocus);

function _clearSpellMarkers() {
  for (const m of spellMarkers) {
    try { m.clear(); } catch (_) {}
  }
  spellMarkers = [];
}

function _buildSkipMask(text) {
  // 1 = "do not spell-check this character". Walk once, handling escapes,
  // inline-math `$...$`, line comments (`%`), and any \command region.
  const n = text.length;
  const mask = new Uint8Array(n);
  let inMath = false;
  for (let i = 0; i < n; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 0x5C /* \ */) {
      // Mask the backslash + the following command name (alpha+) or the
      // single escaped char if non-alpha (e.g. `\$`, `\%`, `\_`).
      mask[i] = 1;
      let j = i + 1;
      if (j < n && /[a-zA-Z]/.test(text[j])) {
        while (j < n && /[a-zA-Z]/.test(text[j])) { mask[j] = 1; j++; }
        if (j < n && text[j] === "*") { mask[j] = 1; j++; }  // starred form
      } else if (j < n) {
        mask[j] = 1; j++;
      }
      i = j - 1;
      continue;
    }
    if (ch === 0x25 /* % */) {
      // Comment runs to EOL — mask everything left.
      while (i < n) { mask[i] = 1; i++; }
      break;
    }
    if (ch === 0x24 /* $ */) {
      // Inline math delimiter — itself masked + flip math state.
      mask[i] = 1;
      inMath = !inMath;
      continue;
    }
    if (inMath) mask[i] = 1;
  }
  // Second pass: mask brace args of citation/ref/label/input/include/etc.
  // We re-scan from the original text rather than the mask because the
  // commands themselves are already masked above, but we still want to peek
  // back at them to detect "is this a skip-brace command?".
  _SPELL_SKIP_BRACE_CMDS.lastIndex = 0;
  let m;
  while ((m = _SPELL_SKIP_BRACE_CMDS.exec(text))) {
    let i = m.index + m[0].length;
    // Optional [opts] arg — skip and mask.
    while (i < n && /\s/.test(text[i])) i++;
    if (text[i] === "[") {
      let depth = 1, j = i + 1;
      while (j < n && depth > 0) {
        if (text[j] === "\\" && j + 1 < n) { j += 2; continue; }
        if (text[j] === "[") depth++;
        else if (text[j] === "]") depth--;
        j++;
      }
      for (let k = i; k < Math.min(j, n); k++) mask[k] = 1;
      i = j;
    }
    while (i < n && /\s/.test(text[i])) i++;
    // Required {arg} — mask the WHOLE thing (including nested braces).
    if (text[i] === "{") {
      let depth = 1, j = i + 1;
      while (j < n && depth > 0) {
        if (text[j] === "\\" && j + 1 < n) { j += 2; continue; }
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
        j++;
      }
      for (let k = i; k < Math.min(j, n); k++) mask[k] = 1;
    }
  }
  return mask;
}

function _spellCheckLine(line) {
  const text = cm_get_line_safe(line);
  if (!text || !text.trim()) return;
  const mask = _buildSkipMask(text);
  // English word matcher — 3+ chars, allow internal apostrophe (don't, it's).
  const wordRe = /[A-Za-z][A-Za-z']{2,}/g;
  let m;
  while ((m = wordRe.exec(text))) {
    const start = m.index, end = start + m[0].length;
    // Any masked char inside the word → skip whole word.
    let bad = false;
    for (let j = start; j < end; j++) {
      if (mask[j]) { bad = true; break; }
    }
    if (bad) continue;
    const word = m[0];
    // Skip ALL-CAPS short tokens (likely acronyms / journal codes).
    if (word.length <= 5 && word === word.toUpperCase()) continue;
    // Skip if the word contains an apostrophe + 's (don't, it's, Pol's)
    // because contractions / possessives aren't worth flagging.
    if (/'s$/i.test(word) || /'t$/i.test(word) || /'re$/i.test(word) || /'ve$/i.test(word) || /'ll$/i.test(word) || /'d$/i.test(word) || /'m$/i.test(word)) continue;
    if (customDict.has(word.toLowerCase())) continue;
    if (!spellChecker) continue;
    if (spellChecker.check(word)) continue;
    const marker = cmEditor.markText(
      { line, ch: start },
      { line, ch: end },
      { className: "spell-error", attributes: { title: `Possibly misspelled: ${word}` } }
    );
    spellMarkers.push(marker);
  }
}

// Defensive helper — cm.getLine() can throw if line index is out of bounds
// after a rapid delete; just return empty so the caller bails gracefully.
function cm_get_line_safe(line) {
  try { return cmEditor.getLine(line) || ""; } catch (_) { return ""; }
}

// v4.4.0 — The red wavy underline now shows whenever EITHER spell check OR
// "Suggest corrections while typing" is on. Both use the same dictionary and
// the same _spellCheckLine pass, so seeing which word is wrong (underline) and
// getting corrections for it (dropdown / right-click) are two halves of one
// feature. False until the dict has actually loaded.
function _spellHighlightOn() {
  return (spellEnabled || spellSuggestEnabled) && !!spellChecker;
}

function _runSpellCheck() {
  if (!_spellHighlightOn()) return;
  _clearSpellMarkers();
  // Scope: only the visible viewport ± a 50-line buffer. For a 2000-line
  // chapter this is ~100 lines of work — fast, and the user can't see beyond
  // the viewport anyway. Buffer makes scrolling feel "always already checked".
  const vp = cmEditor.getViewport();
  const total = cmEditor.lineCount();
  const from = Math.max(0, vp.from - 50);
  const to   = Math.min(total, vp.to   + 50);
  cmEditor.operation(() => {
    for (let i = from; i < to; i++) _spellCheckLine(i);
  });
}

let _spellViewportTimer = null;
function scheduleSpellCheck(delay) {
  clearTimeout(spellScanTimer);
  spellScanTimer = setTimeout(_runSpellCheck, typeof delay === "number" ? delay : 600);
}

function onSpellCheckToggle() {
  const cb = document.getElementById("spellcheck-toggle");
  spellEnabled = cb.checked;
  localStorage.setItem("texlocal_spellcheck", spellEnabled ? "1" : "0");
  if (spellEnabled) {
    _ensureSpellDict().then(d => {
      if (d) _runSpellCheck();
    });
  } else {
    // Keep the underlines if suggestions still want them; only clear when
    // BOTH features are off.
    if (!spellSuggestEnabled) _clearSpellMarkers();
    const status = document.getElementById("spell-status");
    if (status) status.classList.remove("visible");
  }
}

// v4.4.0 — Inline-suggestion toggle. Independent of the underline toggle so a
// user can keep red squiggles without the typing-time dropdown (or vice versa).
// No dict work here — the dropdown is gated at trigger time on spellChecker.
function onSpellSuggestToggle() {
  const cb = document.getElementById("spell-suggest-toggle");
  spellSuggestEnabled = cb ? cb.checked : true;
  localStorage.setItem("texlocal_spellsuggest", spellSuggestEnabled ? "1" : "0");
  if (spellSuggestEnabled) {
    // Warm the dictionary, then underline misspellings (same pass spell check
    // uses) so wrong words are flagged even with the red-underline toggle off.
    _ensureSpellDict().then(d => { if (d) _runSpellCheck(); });
  } else if (!spellEnabled) {
    // Neither feature wants the underlines now.
    _clearSpellMarkers();
  }
}

// Init on load — restore the user's preference. Don't actually fetch the
// dictionary yet; wait until the editor settles (1s) so initial paint isn't
// blocked by ~1.7MB of dict parsing.
(function _initSpellCheck() {
  const saved = localStorage.getItem("texlocal_spellcheck") === "1";
  spellEnabled = saved;
  // v4.6.0 — inline suggestions default OFF (absent key → off); explicit "1" on.
  spellSuggestEnabled = localStorage.getItem("texlocal_spellsuggest") === "1";
  const sc = document.getElementById("spell-suggest-toggle");
  if (sc) sc.checked = spellSuggestEnabled;
  // Sync the checkbox once Settings popup is built — the input is in the
  // markup already, so we can set it right away.
  const cb = document.getElementById("spellcheck-toggle");
  if (cb) cb.checked = saved;
  // Load the dict on settle if EITHER feature is on, so misspellings already
  // in the opened document get underlined without waiting for the user to type.
  // (Suggestions default on, so this is the common path.)
  if (saved || spellSuggestEnabled) {
    setTimeout(() => {
      _ensureSpellDict().then(d => { if (d) _runSpellCheck(); });
    }, 1000);
  }
  // Re-scan when the viewport changes (scroll, fold/unfold, resize).
  // Light debounce — scrolling fires many viewportChange events.
  cmEditor.on("viewportChange", () => {
    if (!_spellHighlightOn()) return;
    clearTimeout(_spellViewportTimer);
    _spellViewportTimer = setTimeout(_runSpellCheck, 200);
  });

  // v3.3.3 — Right-click on a spell-error span → context menu offering to
  // add the word to .texlocal-dict.txt. We catch contextmenu on CM's wrapper
  // and resolve the click into a {line,ch} via coordsChar, then test each
  // active spellMarker for containment. This is robust against CM splitting
  // the rendered span across token boundaries.
  // v3.3.4 — Now also passes the resolved range so the menu can offer
  // "Replace with X" via cmEditor.replaceRange().
  cmEditor.getWrapperElement().addEventListener("contextmenu", (evt) => {
    if ((!spellEnabled && !spellSuggestEnabled) || !spellMarkers.length) return;
    const pos = cmEditor.coordsChar({ left: evt.clientX, top: evt.clientY });
    if (!pos) return;
    for (const m of spellMarkers) {
      const range = m.find();
      if (!range) continue;
      const inLine = pos.line === range.from.line && pos.line === range.to.line;
      if (!inLine) continue;
      if (pos.ch < range.from.ch || pos.ch > range.to.ch) continue;
      const word = cmEditor.getRange(range.from, range.to);
      if (!word) continue;
      evt.preventDefault();
      _showSpellContextMenu(word, range, evt.clientX, evt.clientY);
      return;
    }
  });
})();

// v3.3.3 — context menu state. _currentMenuWord lets onAddToDictClick know
// which word to POST without having to re-resolve from the DOM.
// v3.3.4 — _currentMenuRange lets onReplaceClick swap the word in place via
// cmEditor.replaceRange(). The range comes from the spellMarker we matched
// in the contextmenu listener — using the live marker (instead of a fresh
// re-resolve at click time) means the replace still works even if the user's
// edits before the menu opened have shifted absolute offsets, because CM
// keeps marker ranges in sync with edits.
let _currentMenuWord  = null;
let _currentMenuRange = null;
let _menuDismissHandler = null;

// v3.3.6 — Per-session cache of Typo.suggest() results, keyed by lowercased
// word. The Hunspell algorithm in typo-js is synchronous and CPU-bound
// (~50-250ms per call on common typos), which is what made the right-click
// menu feel laggy in v3.3.4/5. We now (a) open and position the menu
// instantly with just the "Add to dictionary" item visible, (b) compute
// suggestions on the next tick via setTimeout(0) so the menu paints first,
// and (c) cache the result so subsequent right-clicks on the same word are
// effectively free. Cache is invariant for the session because Typo's
// suggest output depends only on the loaded Hunspell .aff/.dic — neither
// changes once spell-check is enabled.
const _suggestCache = new Map();

// v4.4.0 — Spell suggest Web Worker (Blob URL).
// Runs Typo.suggest() off the main thread so right-click never freezes UI.
// Worker loads its own copy of Typo.js + en_US dict (~1.7MB extra memory,
// acceptable for a single-user local app).
const _SUGGEST_WORKER_SRC = `
importScripts('https://cdn.jsdelivr.net/npm/typo-js@1.2.4/typo.js');
let _wTypo = null;
let _wLoading = null;
function _wLoadDict() {
  if (_wTypo) return Promise.resolve(_wTypo);
  if (_wLoading) return _wLoading;
  const base = 'https://cdn.jsdelivr.net/npm/typo-js@1.2.4/dictionaries/en_US';
  _wLoading = Promise.all([
    fetch(base + '/en_US.aff').then(r => r.text()),
    fetch(base + '/en_US.dic').then(r => r.text()),
  ]).then(([aff, dic]) => {
    _wTypo = new Typo('en_US', aff, dic, { platform: 'any' });
    _wLoading = null;
    return _wTypo;
  });
  return _wLoading;
}
self.onmessage = function(e) {
  const { id, word } = e.data;
  _wLoadDict().then(t => {
    let s = [];
    try { s = t.suggest(word, 5) || []; } catch(_) {}
    self.postMessage({ id, word, suggestions: s });
  }).catch(() => self.postMessage({ id, word, suggestions: [] }));
};
`;
let _suggestWorker = null;
let _suggestWorkerPending = new Map();
let _suggestWorkerIdSeq  = 0;

function _ensureSuggestWorker() {
  if (_suggestWorker) return _suggestWorker;
  try {
    const blob = new Blob([_SUGGEST_WORKER_SRC], { type: 'application/javascript' });
    _suggestWorker = new Worker(URL.createObjectURL(blob));
    _suggestWorker.onmessage = (e) => {
      const { id, suggestions } = e.data;
      const cb = _suggestWorkerPending.get(id);
      if (cb) { _suggestWorkerPending.delete(id); cb(suggestions); }
    };
    _suggestWorker.onerror = () => { _suggestWorker = null; };  // reset on crash
  } catch (_) { _suggestWorker = null; }
  return _suggestWorker;
}

function _suggestAsync(word) {
  return new Promise(resolve => {
    const worker = _ensureSuggestWorker();
    if (!worker) { resolve([]); return; }
    const id = ++_suggestWorkerIdSeq;
    _suggestWorkerPending.set(id, resolve);
    try { worker.postMessage({ id, word }); }
    catch (_) { _suggestWorkerPending.delete(id); resolve([]); }
  });
}


function _showSpellContextMenu(word, range, x, y) {
  _currentMenuWord  = word;
  _currentMenuRange = range;
  const menu = document.getElementById("spell-context-menu");
  const label = document.getElementById("scm-word");
  if (!menu || !label) return;
  label.textContent = "«" + word + "»";
  // Restore the default item state in case a previous "Added!" toast lingered.
  const item = document.getElementById("scm-add");
  if (item) { item.style.opacity = ""; item.style.pointerEvents = ""; }
  // Strip any toast row leftover AND any prior suggestions/divider so we
  // can re-render fresh for this word.
  Array.from(menu.querySelectorAll(".scm-toast, .scm-suggestion, .scm-divider"))
    .forEach(n => n.remove());

  // v3.3.6 — Open + position the menu FIRST, before computing suggestions.
  // _clampPosition is reused after async injection because the menu height
  // grows by up to 5 rows + 1 divider once suggestions land, which can push
  // the bottom edge past the viewport on a click near the bottom of the pane.
  const _clampPosition = () => {
    const r = menu.getBoundingClientRect();
    const w = r.width  || 230;
    const h = r.height || 60;
    menu.style.left = Math.min(x, window.innerWidth  - w - 8) + "px";
    menu.style.top  = Math.min(y, window.innerHeight - h - 8) + "px";
  };
  menu.classList.add("open");
  _clampPosition();

  // Dismiss on any click outside, Escape, or scroll. Bind once; tear down
  // when the menu hides so we don't accumulate listeners. Deferred one tick
  // so the contextmenu event that opened us doesn't itself trip "click".
  _menuDismissHandler = (e) => {
    if (e.type === "keydown" && e.key !== "Escape") return;
    _hideSpellContextMenu();
  };
  setTimeout(() => {
    document.addEventListener("click",   _menuDismissHandler, { once: true });
    document.addEventListener("keydown", _menuDismissHandler, { once: true });
    cmEditor.on("scroll", _hideSpellContextMenu);
  }, 0);

  // v3.3.6 — Render suggestions asynchronously so the menu paints first.
  // `word` is captured in the closure so a rapid second right-click on a
  // different word can't inject stale suggestions into the new menu — the
  // `_currentMenuWord === word` guard at injection time bails out cleanly.
  if (!spellChecker || typeof spellChecker.suggest !== "function") return;

  const _injectSuggestions = (suggestions) => {
    // Defensive: menu may have been dismissed or replaced for another word
    // between kick-off and now.
    if (_currentMenuWord !== word) return;
    if (!menu.classList.contains("open")) return;
    // Dedup against the original (case-insensitive) — Typo can echo input
    // back as a "suggestion" in rare edge cases.
    suggestions = (suggestions || [])
      .filter(s => s && s.toLowerCase() !== word.toLowerCase());
    if (!suggestions.length) return;
    const frag = document.createDocumentFragment();
    suggestions.forEach(s => {
      const row = document.createElement("div");
      row.className = "scm-item scm-suggestion";
      row.dataset.suggestion = s;
      row.innerHTML =
        `<span class="scm-icon">↻</span>` +
        `<span>Replace with <span class="scm-word"></span></span>`;
      // textContent (not innerHTML) so apostrophes/quotes in suggestions
      // like "because's" don't break the markup.
      row.querySelector(".scm-word").textContent = s;
      row.addEventListener("click", (ev) => {
        ev.stopPropagation();
        onReplaceClick(row.dataset.suggestion);
      });
      frag.appendChild(row);
    });
    // Visual separator before the "Add" item.
    const divider = document.createElement("div");
    divider.className = "scm-divider";
    frag.appendChild(divider);
    // Insert before #scm-add so suggestions appear at the top of the menu.
    menu.insertBefore(frag, item || null);
    // Re-clamp: menu height grew, may now extend past viewport bottom.
    _clampPosition();
  };

  const cacheKey = word.toLowerCase();
  if (_suggestCache.has(cacheKey)) {
    // Cache hit — still defer one tick so behaviour is uniform with the
    // miss path (no risk of layout thrash from "sometimes the menu paints
    // tall, sometimes short"). The compute itself is free here.
    setTimeout(() => _injectSuggestions(_suggestCache.get(cacheKey)), 0);
  } else {
    setTimeout(() => {
      let suggestions = [];
      try { suggestions = spellChecker.suggest(word, 5) || []; }
      catch (e) { suggestions = []; }
      _suggestCache.set(cacheKey, suggestions);
      _injectSuggestions(suggestions);
    }, 0);
  }
}

function _hideSpellContextMenu() {
  const menu = document.getElementById("spell-context-menu");
  if (menu) menu.classList.remove("open");
  _currentMenuWord  = null;
  _currentMenuRange = null;
  if (_menuDismissHandler) {
    document.removeEventListener("click",   _menuDismissHandler);
    document.removeEventListener("keydown", _menuDismissHandler);
    _menuDismissHandler = null;
  }
  cmEditor.off("scroll", _hideSpellContextMenu);
}

// v3.3.4 — Replace the right-clicked misspelled word with the chosen
// suggestion. Range is captured at menu-open time (live CM marker), so it
// stays valid against intervening edits. After the swap, schedule a quick
// spell-check pass so any new error state updates within ~30ms.
function onReplaceClick(suggestion) {
  const range = _currentMenuRange;
  if (!range || !suggestion) { _hideSpellContextMenu(); return; }
  // Defensive: if the marker was cleared between menu-open and click (e.g.
  // the user toggled spell check off mid-menu), bail without touching CM.
  if (!range.from || !range.to) { _hideSpellContextMenu(); return; }
  cmEditor.replaceRange(suggestion, range.from, range.to);
  // Place the cursor after the inserted text and refocus the editor so the
  // user can keep typing without an extra click.
  cmEditor.focus();
  // Re-scan: the new word may itself be flagged (unlikely from a dict
  // suggestion, but cheap), and the original marker needs to clear.
  scheduleSpellCheck(30);
  _hideSpellContextMenu();
}

async function onAddToDictClick() {
  const word = _currentMenuWord;
  if (!word) { _hideSpellContextMenu(); return; }
  if (!currentProject) {
    _showMenuToast("No active project");
    return;
  }
  // Disable the click target so a double-click doesn't fire twice.
  const item = document.getElementById("scm-add");
  if (item) { item.style.opacity = "0.5"; item.style.pointerEvents = "none"; }
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/dict`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ word })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      _showMenuToast("Error: " + (data.error || res.status));
      return;
    }
    // Optimistically add to the in-memory set so the next spell scan clears
    // this word's underlines without waiting for a /dict round-trip.
    customDict.add(word.toLowerCase());
    if (data.added) {
      _showMenuToast(`Added · ${customDict.size} word${customDict.size !== 1 ? "s" : ""} in dict`);
    } else if (data.reason === "duplicate") {
      _showMenuToast("Already in dictionary");
    }
    // Re-scan immediately so the underline disappears.
    scheduleSpellCheck(30);
    // Auto-dismiss after a beat so the toast is readable.
    setTimeout(_hideSpellContextMenu, 900);
  } catch (e) {
    _showMenuToast("Network error: " + e.message);
  }
}

function _showMenuToast(msg) {
  const menu = document.getElementById("spell-context-menu");
  if (!menu) return;
  Array.from(menu.querySelectorAll(".scm-toast")).forEach(n => n.remove());
  const toast = document.createElement("div");
  toast.className = "scm-toast";
  toast.textContent = msg;
  menu.appendChild(toast);
}

// v3.3.5 — "Manage custom dictionary" modal. Opens from Settings → Custom
// dictionary → Manage…. Loads `.texlocal-dict.txt` via /dict GET, renders a
// row per word with a × button that DELETEs that word from the file. Each
// successful delete also drops the word from in-memory `customDict` so the
// next spell rescan flags it again immediately.
let _dictMgrWords = [];   // last-loaded word list (for client-side filter)
let _dictMgrEsc   = null; // bound Escape handler (removed on close)

async function openDictManager() {
  if (!currentProject) return;
  // Auto-close the settings popup so the modal isn't half-hidden underneath.
  closeSettingsPanel();
  const overlay = document.getElementById("dict-mgr-overlay");
  const filter  = document.getElementById("dm-filter");
  const list    = document.getElementById("dm-list");
  if (!overlay || !list) return;
  // Reset filter every time the modal opens — feels less surprising than a
  // sticky filter from last session ("why are my words missing?").
  if (filter) filter.value = "";
  list.innerHTML = "";
  document.getElementById("dm-count").textContent = "";
  document.getElementById("dm-empty").classList.remove("show");
  overlay.classList.add("open");
  // Esc-to-close. Bound once per open, removed on close.
  _dictMgrEsc = (e) => { if (e.key === "Escape") closeDictManager(); };
  document.addEventListener("keydown", _dictMgrEsc);
  // Focus the filter so Pol can start typing immediately on big dicts.
  setTimeout(() => filter && filter.focus(), 30);
  // Fetch fresh — don't trust in-memory customDict here, since hot-reload
  // may not have run yet if the user hasn't focused-out since last edit.
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/dict`);
    if (!res.ok) {
      list.innerHTML = `<div class="dm-empty show">Could not load dictionary (HTTP ${res.status}).</div>`;
      return;
    }
    const data = await res.json();
    _dictMgrWords = (data.words || []).slice();
    // Keep mtime in sync so the focus hot-reload doesn't see a phantom
    // change right after we just refreshed.
    customDictMtime = Number(data.mtime) || 0;
    _renderDictMgrList("");
  } catch (e) {
    list.innerHTML = `<div class="dm-empty show">Network error: ${e.message}</div>`;
  }
}

function closeDictManager() {
  const overlay = document.getElementById("dict-mgr-overlay");
  if (overlay) overlay.classList.remove("open");
  if (_dictMgrEsc) {
    document.removeEventListener("keydown", _dictMgrEsc);
    _dictMgrEsc = null;
  }
}

function _renderDictMgrList(filterStr) {
  const list  = document.getElementById("dm-list");
  const count = document.getElementById("dm-count");
  const empty = document.getElementById("dm-empty");
  if (!list) return;
  list.innerHTML = "";
  const q = (filterStr || "").trim().toLowerCase();
  // Stable sort: case-insensitive alpha. Mirrors how a human would scan
  // a printed word list. (File order is "added order" — fine for the
  // file itself but unfriendly for a manage UI.)
  const sorted = _dictMgrWords.slice().sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );
  const filtered = q ? sorted.filter(w => w.toLowerCase().includes(q)) : sorted;
  if (count) {
    count.textContent = filtered.length === _dictMgrWords.length
      ? `· ${_dictMgrWords.length}`
      : `· ${filtered.length} of ${_dictMgrWords.length}`;
  }
  if (filtered.length === 0) {
    // Two distinct empty states: (a) dict has no words at all, (b) filter
    // hides everything. Same element, different copy.
    if (empty) {
      empty.textContent = _dictMgrWords.length === 0
        ? "No words yet. Right-click a misspelled word and choose Add to dictionary."
        : "No matches for that filter.";
      empty.classList.add("show");
    }
    return;
  }
  if (empty) empty.classList.remove("show");
  const frag = document.createDocumentFragment();
  for (const w of filtered) {
    const row = document.createElement("div");
    row.className = "dm-row";
    row.dataset.word = w;
    // textContent for the word so apostrophes / quotes never break markup.
    const wordEl = document.createElement("span");
    wordEl.className = "dm-word";
    wordEl.textContent = w;
    const delBtn = document.createElement("button");
    delBtn.className = "dm-row-del";
    delBtn.textContent = "×";
    delBtn.title = `Remove "${w}" from dictionary`;
    delBtn.onclick = () => onDictMgrDelete(w, row);
    row.appendChild(wordEl);
    row.appendChild(delBtn);
    frag.appendChild(row);
  }
  list.appendChild(frag);
}

function onDictMgrFilterInput() {
  const filter = document.getElementById("dm-filter");
  _renderDictMgrList(filter ? filter.value : "");
}

async function onDictMgrDelete(word, rowEl) {
  if (!currentProject || !word) return;
  // Optimistic "removing" state: half-opacity + pointer-events:none stops
  // double-clicks while the DELETE is in flight. If the call fails, we
  // restore the row.
  if (rowEl) rowEl.classList.add("removing");
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/dict`, {
      method:  "DELETE",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ word })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      if (rowEl) rowEl.classList.remove("removing");
      return;
    }
    // Drop from in-memory state so the next spell rescan re-flags this
    // word. Also drop from _dictMgrWords so a filter-clear re-render
    // doesn't show it again.
    customDict.delete(word.toLowerCase());
    _dictMgrWords = _dictMgrWords.filter(w => w.toLowerCase() !== word.toLowerCase());
    // Re-render to update the count + handle the "now empty" case.
    const filter = document.getElementById("dm-filter");
    _renderDictMgrList(filter ? filter.value : "");
    // Trigger a rescan — the deleted word's instances in the buffer should
    // light back up if they're indeed misspellings per Typo's en_US dict.
    if (_spellHighlightOn()) scheduleSpellCheck(30);
  } catch (e) {
    if (rowEl) rowEl.classList.remove("removing");
  }
}

function _fmtAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function renderHistoryPanel() {
  const list  = document.getElementById("hp-list");
  const sub   = document.getElementById("hp-sub");
  const detail = document.getElementById("hp-detail");
  const arr = loadCompileHistory();
  if (!arr.length) {
    list.innerHTML = '<div class="hp-empty">No compile runs recorded yet — try compiling once and they\'ll appear here.</div>';
    sub.textContent = "";
    detail.classList.remove("open");
    return;
  }
  sub.textContent = `· ${arr.length} run${arr.length !== 1 ? "s" : ""}`;
  list.innerHTML = arr.map((h, i) => {
    const tags = [];
    if (h.draft)   tags.push("draft");
    if (h.partial) tags.push("partial");
    return `<div class="hp-row ${h.ok ? "ok" : "err"} ${i === _historyActiveIdx ? "active" : ""}" data-idx="${i}">
      <span class="hp-dot">${h.ok ? "●" : "●"}</span>
      <span>
        <span class="hp-when">${_fmtAgo(h.ts)}</span>
        <span class="hp-info"> · ${h.elapsed}s · ${h.errCount}E ${h.warnCount}W</span>
      </span>
      <span class="hp-tags">${tags.join(" ")}</span>
      <span class="hp-info">${new Date(h.ts).toLocaleTimeString()}</span>
    </div>`;
  }).join("");
  list.querySelectorAll(".hp-row").forEach(el => {
    el.addEventListener("click", () => {
      const idx = parseInt(el.dataset.idx, 10);
      _historyActiveIdx = (_historyActiveIdx === idx) ? -1 : idx;   // toggle
      renderHistoryPanel();
    });
  });
  if (_historyActiveIdx >= 0 && arr[_historyActiveIdx]) {
    detail.textContent = arr[_historyActiveIdx].log || "(empty log)";
    detail.classList.add("open");
  } else {
    detail.classList.remove("open");
  }
}

function clearCompileHistory() {
  if (!confirm("Clear all compile history for this project?")) return;
  const k = _historyKey();
  if (!k) return;
  localStorage.removeItem(k);
  _historyActiveIdx = -1;
  renderHistoryPanel();
}

function toggleHistoryPanel(e) {
  const panel = document.getElementById("history-panel");
  if (panel.classList.contains("open")) {
    panel.classList.remove("open");
    return;
  }
  _closeOtherToolbarPanels("history-panel"); // v3.3.7
  const btn  = document.getElementById("history-btn");
  const rect = btn.getBoundingClientRect();
  const pw   = 540;
  let left   = rect.right - pw;
  if (left < 4) left = 4;
  let top = rect.bottom + 4;
  panel.style.top  = top  + "px";
  panel.style.left = left + "px";
  _historyActiveIdx = -1;
  renderHistoryPanel();
  panel.classList.add("open");
  if (e) e.stopPropagation();
}
document.addEventListener("click", e => {
  const panel = document.getElementById("history-panel");
  if (!panel || !panel.classList.contains("open")) return;
  if (panel.contains(e.target)) return;
  if (e.target.closest("#history-btn")) return;
  panel.classList.remove("open");
});

function toggleSymbolPanel(e) {
  const panel = document.getElementById("symbol-panel");
  if (panel.classList.contains("open")) {
    panel.classList.remove("open");
    return;
  }
  _closeOtherToolbarPanels("symbol-panel"); // v3.3.7
  // position below the toggle button
  const btn = document.getElementById("sym-toggle-btn");
  const rect = btn.getBoundingClientRect();
  const panelW = 370;
  let left = rect.right - panelW;
  if (left < 4) left = 4;
  panel.style.top  = (rect.bottom + 4) + "px";
  panel.style.left = left + "px";
  renderSymbolPanel();
  panel.classList.add("open");
  if (e) e.stopPropagation();
}

document.addEventListener("click", e => {
  const panel = document.getElementById("symbol-panel");
  if (!panel.classList.contains("open")) return;
  if (panel.contains(e.target)) return;
  if (e.target.closest("#sym-toggle-btn")) return;
  panel.classList.remove("open");
});

// ── SEARCH ACROSS FILES ───────────────────────────────────────
function toggleSearchPanel() {
  const panel = document.getElementById("search-panel");
  if (panel.classList.contains("open")) {
    hideSearchPanel();
  } else {
    panel.classList.add("open");
    setTimeout(() => document.getElementById("search-input").focus(), 60);
  }
}

function hideSearchPanel() {
  document.getElementById("search-panel").classList.remove("open");
}

// v3.2.2 — Replace-mode toggle + project-wide replace-all.
function toggleReplaceMode() {
  const row = document.getElementById("replace-row");
  const visible = row.style.display !== "none";
  row.style.display = visible ? "none" : "flex";
  if (!visible) setTimeout(() => document.getElementById("replace-input").focus(), 40);
}

async function doReplaceAll() {
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
    `<div class="search-result-item" onclick="openFile('${escapeAttr(f.path)}')">
       <div class="search-result-header">
         <span class="search-result-file">${escapeHtml(f.path)}</span>
         <span class="search-result-line">×${f.count}</span>
       </div>
       <div class="search-result-text">${escapeHtml(f.preview || "")}</div>
     </div>`
  ).join("");

  // If the currently-open file was rewritten, reload its contents from
  // disk so the editor doesn't keep displaying the pre-replace version.
  if (currentFile && files.some(f => f.path === currentFile)) {
    await openFile(currentFile);
  }
}

async function doSearch() {
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
      <div class="search-result-loc">${esc(r.file)} : line ${r.line + 1}</div>
      <div class="search-result-text">${hiText}</div>
    `;
    div.onclick = async () => {
      hideSearchPanel();
      if (r.file !== currentFile) await openFile(r.file);
      setTimeout(() => {
        cmEditor.setCursor(r.line, 0);
        cmEditor.scrollIntoView({ line: r.line, ch: 0 }, 100);
        cmEditor.focus();
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
(function _attachKatexHover() {
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
    const total = cmEditor.lineCount();
    const cur   = pos.line;
    const endRe   = /\\end\{([^}]+)\}/;
    const beginRe = /\\begin\{([^}]+)\}/;
    // Scan backwards to find \begin{mathenv} — stop if \end found first
    let beginLine = -1, env = null;
    for (let i = cur; i >= Math.max(0, cur - 60); i--) {
      const ln = cmEditor.getLine(i) || '';
      const bm = ln.match(beginRe);
      if (bm && _MATH_ENVS.has(bm[1])) { beginLine = i; env = bm[1]; break; }
      if (i < cur && endRe.test(ln)) break;  // hit \end before \begin — not inside
    }
    if (beginLine < 0) return null;
    // Scan forward to find matching \end{env}
    let endLine = -1;
    for (let i = beginLine + 1; i <= Math.min(total - 1, cur + 60); i++) {
      if ((cmEditor.getLine(i) || '').includes('\\end{' + env + '}')) { endLine = i; break; }
    }
    if (endLine < 0 || cur > endLine) return null;
    // Collect lines and render as display math
    const lines = [];
    for (let i = beginLine; i <= endLine; i++) lines.push(cmEditor.getLine(i) || '');
    return { src: lines.join('\n'), display: true };
  }

  cmEditor.getWrapperElement().addEventListener("mousemove", e => {
    clearTimeout(_hoverTimer);
    _hoverTimer = setTimeout(() => {
      const pos  = cmEditor.coordsChar({ left: e.clientX, top: e.clientY });
      const line = cmEditor.getLine(pos.line);
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

  cmEditor.getWrapperElement().addEventListener("mouseleave", () => {
    clearTimeout(_hoverTimer);
    popup.classList.remove("visible");
    _lastSrc = null;
  });
})();

// v4.4.0 — PRE-COMPILE SYNTAX LINTER ───────────────────────────────
// Checks for: unmatched {}, \begin/\end mismatches, unclosed $ (inline math).
// Registered as CodeMirror "stex" lint helper; wavy underlines appear without
// running pdflatex. Conservative by design — skips \verb|..| and verbatim envs.
// False-positive risk noted in HANDOFF: \verb|{| is explicitly skipped here.

function _buildLatexSkipRanges(text) {
  const ranges = [];
  // \verb*?X...X  (any delimiter char)
  const verbRe = /\\verb\*?(.)/g;
  let m;
  while ((m = verbRe.exec(text)) !== null) {
    const delim = m[1];
    const start = m.index;
    const end   = text.indexOf(delim, m.index + m[0].length);
    if (end >= 0) ranges.push([start, end + 1]);
  }
  // \begin{verbatim}...\end{verbatim}
  const venvRe = /\\begin\{verbatim\*?\}[\s\S]*?\\end\{verbatim\*?\}/g;
  while ((m = venvRe.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length]);
  // % line comments — skip from % to end of line (but not \%)
  const commentRe = /(?<!\\)%[^\n]*/g;
  while ((m = commentRe.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

function _latexInSkip(ranges, pos) {
  for (const [a, b] of ranges) { if (pos >= a && pos < b) return true; }
  return false;
}

function _latexOffsetToPos(text, offset) {
  const before = text.slice(0, offset);
  const lines  = before.split('\n');
  return { line: lines.length - 1, ch: lines[lines.length - 1].length };
}

CodeMirror.registerHelper('lint', 'stex', function(text) {
  const errors = [];
  const skip   = _buildLatexSkipRanges(text);

  // ── 1. Brace balance ────────────────────────────────────────
  const braceStack = [];
  for (let i = 0; i < text.length; i++) {
    if (_latexInSkip(skip, i)) continue;
    if (text[i] === '\\') { i++; continue; }   // skip escaped char
    if (text[i] === '{') {
      braceStack.push(i);
    } else if (text[i] === '}') {
      if (braceStack.length === 0) {
        const p = _latexOffsetToPos(text, i);
        errors.push({ from: p, to: { line: p.line, ch: p.ch + 1 },
          message: 'Unmatched }', severity: 'error' });
      } else { braceStack.pop(); }
    }
  }
  // Report only the last 3 unmatched opens to avoid flooding
  braceStack.slice(-3).forEach(idx => {
    const p = _latexOffsetToPos(text, idx);
    errors.push({ from: p, to: { line: p.line, ch: p.ch + 1 },
      message: 'Unmatched {', severity: 'error' });
  });

  // ── 2. \begin / \end environment matching ───────────────────
  const envStack = [];
  const envRe = /\\(begin|end)\{([^}]*)\}/g;
  let em;
  while ((em = envRe.exec(text)) !== null) {
    if (_latexInSkip(skip, em.index)) continue;
    const kind = em[1], env = em[2].trim();
    if (kind === 'begin') {
      envStack.push({ env, index: em.index, len: em[0].length });
    } else {
      if (envStack.length === 0) {
        const p = _latexOffsetToPos(text, em.index);
        errors.push({ from: p, to: { line: p.line, ch: p.ch + em[0].length },
          message: `\\end{${env}} without matching \\begin`, severity: 'error' });
      } else {
        const last = envStack[envStack.length - 1];
        if (last.env === env) { envStack.pop(); }
        else {
          const p = _latexOffsetToPos(text, em.index);
          errors.push({ from: p, to: { line: p.line, ch: p.ch + em[0].length },
            message: `\\end{${env}} but expected \\end{${last.env}}`, severity: 'warning' });
        }
      }
    }
  }
  envStack.slice(-3).forEach(({ env, index, len }) => {
    const p = _latexOffsetToPos(text, index);
    errors.push({ from: p, to: { line: p.line, ch: p.ch + len },
      message: `\\begin{${env}} never closed`, severity: 'warning' });
  });

  // ── 3. Unclosed $ (inline math) ─────────────────────────────
  // Walk the document, count unescaped single $ (not $$).
  // An odd total means one $ is unpaired; report at its position.
  let dollarCount = 0, lastDollarIdx = -1;
  for (let i = 0; i < text.length; i++) {
    if (_latexInSkip(skip, i)) continue;
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '$') {
      if (text[i + 1] === '$') { i++; continue; }  // skip $$
      dollarCount++;
      lastDollarIdx = i;
    }
  }
  if (dollarCount % 2 !== 0 && lastDollarIdx >= 0) {
    const p = _latexOffsetToPos(text, lastDollarIdx);
    errors.push({ from: p, to: { line: p.line, ch: p.ch + 1 },
      message: 'Unclosed $ — odd number of inline math delimiters in file', severity: 'warning' });
  }

  return errors;
});

// Enable lint gutter and linting on the editor.
// setOption after init avoids re-specifying the whole gutters array.
cmEditor.setOption('gutters', [
  'CodeMirror-linenumbers', 'CodeMirror-foldgutter',
  'CodeMirror-lint-markers', 'cm-errors-gutter'
]);
cmEditor.setOption('lint', { delay: 600 });   // 600ms after last keystroke

init();
