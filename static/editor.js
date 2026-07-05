import { _appendBibAuditBreadcrumb, _historyActiveIdx, _historyKey, _ssHistoryActiveIdx, loadCompileHistory, recordCompileToHistory, updateBibBadge } from "bibtools";
import { _ssLastParsedLog, clearErrorMarkers, hideErrorPanel, parseLatexErrors, showErrorMarkers, showErrorPanel, showLogsPanel, updateLogsBadge } from "errors";
import { _restoreLastFile, loadFiles, openFile, openFolders, renderTabs, saveCurrentFile, updateOutline } from "files";
import { lintCrossRefs, scheduleCrossRefLint } from "linter";
import { _snippetTabHandler, loadSnippets, renderSymbolPanel } from "panels";
import { showPDF } from "pdfviewer";
import { hideSearchPanel, toggleSearchPanel } from "search";
import { loadCustomDict, scheduleSpellCheck } from "spell";
import { syncForward } from "synctex";
import { createCm6Editor } from "cm6-adapter"; // v-CM6 Phase 5 inc2 — only USED when CM6_ENGINE

export let currentProject    = null;
export let currentFile       = null;

// ── IMAGE FILE DETECTION (ต้องประกาศก่อน saveCurrentFile) ──
const IMAGE_EXTS = new Set(["png","jpg","jpeg","gif","bmp","svg","webp","tiff","tif","ico"]);
export function isImageFile(name) {
  return name ? IMAGE_EXTS.has(name.split(".").pop().toLowerCase()) : false;
}
export let mainFile          = "main.tex";   // ไฟล์หลักสำหรับ compile
export let openTabs          = [];   // [{name, content}]
export let saveTimer         = null;
let autoCompile       = false;
let autoCompileTimer  = null;
let wordCountTimer    = null;
export let draftMode         = false;   // v3.2.2 — skip figures during compile (per-project)

// v3.2.2 — autocomplete sources for \cite{...} and \ref{...}
// Both are populated by loadCiteData() (per-project) and refreshed after
// every compile. The hint helper below filters on the typed prefix.
export let bibkeysCache      = [];   // [{key, type, author, year, title}]
export let labelsCache       = [];   // [{name, file, line}]
// v4.4.0 — user-defined commands/environments (project-wide) for \cmd and
// \begin{} autocomplete, populated by loadCiteData.
export let userCmdCache      = [];   // ["\\foo", ...]  // v5.0.0-beta.7.4 — export: autocomplete.js imports these (were ReferenceError under ESM → \begin/\cmd hint threw)
export let userEnvCache      = [];   // ["mytheorem", ...]

// v3.2.2 — \includeonly chapter switcher
export let availableIncludes = [];   // [{path, line}] from the project's main file
export let selectedIncludes  = [];   // subset of availableIncludes paths the user wants compiled

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
export let spellChecker         = null;
export let spellLoadingPromise  = null;
export let spellEnabled         = false;
export let spellMarkers         = [];
export let customDict           = new Set();
export let spellScanTimer       = null;
// v4.4.0 — Inline spell suggestions ("word suggestion"). When on, typing a
// word the en_US dict rejects pops a CodeMirror dropdown of corrections — the
// typing-time companion to the right-click "Replace with" menu. INDEPENDENT of
// the red-underline spell check: it loads the same dictionary on demand, so it
// works even with the underline toggle off. Mirrors localStorage
// `texlocal_spellsuggest`; defaults OFF (opt-in, per documented intent).
export let spellSuggestEnabled  = false;
export let _spellHintTimer      = null;
// v3.3.5 — Hot-reload state. customDictMtime is the file mtime returned by
// the last successful /dict GET. On window focus we re-fetch and only swap
// customDict if the mtime changed — keeps the disk read cheap and avoids
// gratuitous rescans when Pol just alt-tabs back without editing the file.
export let customDictMtime      = 0;
// v5.0.0-beta.4.0 — Phase 4 ESM prep: shared-state setters. Cross-file writers call these
// instead of reassigning a module-owned `let` directly, so next session's
// `type=module` flip needs zero logic change (an imported binding is read-only;
// mutating via the owner's setter is not). See PHASE4_esm-audit_2026-07-03.md.
export function _ssCurrentFile(v){ currentFile = v; }
export function _ssMainFile(v){ mainFile = v; }
export function _ssOpenTabs(v){ openTabs = v; }
export function _ssSaveTimer(v){ saveTimer = v; }
export function _ssSpellChecker(v){ spellChecker = v; }
export function _ssSpellEnabled(v){ spellEnabled = v; }
export function _ssSpellLoadingPromise(v){ spellLoadingPromise = v; }
export function _ssSpellMarkers(v){ spellMarkers = v; }
export function _ssSpellScanTimer(v){ spellScanTimer = v; }
export function _ssSpellSuggestEnabled(v){ spellSuggestEnabled = v; }
export function _ssSpellHintTimer(v){ _spellHintTimer = v; }
export function _ssCustomDict(v){ customDict = v; }
export function _ssCustomDictMtime(v){ customDictMtime = v; }


// ── CM ADAPTER FACADE (Phase 1 — v5.0.0-beta.1.0) ─────────────────
// v5.0.0-beta.1.0 — Every CodeMirror touchpoint in this file now goes through `CM`
// instead of the raw `cmEditor` instance or the `CodeMirror` static namespace.
// Phase 1 of the editor.js → CodeMirror 6 groundwork (see
// PLAN_editor-modularization_2026-07-02.md): the ~167 direct CM call sites
// (151 cmEditor.* + 16 CodeMirror.*) are funnelled to this one object, so the
// eventual CM5 → CM6 rewrite touches ONLY these wrapper bodies, not every
// caller. After this, a grep for the raw instance/static refs returns only
// lines inside this facade.
//
// Still in editor.js (not yet a separate cmadapter.js file): the `cmEditor`
// instance is a script-scope const created just below, and classic <script>
// files do not share lexical scope — extracting the facade to its own file
// needs the CM init moved into it (or `cmEditor` promoted to a window global),
// a later slice. The facade owns no state: instance methods delegate to the
// `cmEditor` const (only ever CALLED after init runs, so its TDZ is a
// non-issue), statics/getters delegate to the global CodeMirror. Arrow wrappers
// preserve the correct receiver — do NOT swap them for bare method refs or
// `this` unbinds. CM6 day = reimplement these bodies against EditorState /
// EditorView + transactions; callers stay put.
//
// NOTE: handler-local cm.* calls (inside registerHelper / extraKeys handlers,
// where CodeMirror passes the instance in as an argument) are deliberately NOT
// routed here — they live inside the CM-heavy code (fold/hint/lint) that CM6
// rewrites wholesale anyway.
const _CM5 = {
  // text / document
  getValue:          (...a) => cmEditor.getValue(...a),
  setValue:          (...a) => cmEditor.setValue(...a),
  getLine:           (...a) => cmEditor.getLine(...a),
  lineCount:         (...a) => cmEditor.lineCount(...a),
  lastLine:          (...a) => cmEditor.lastLine(...a),
  getRange:          (...a) => cmEditor.getRange(...a),
  replaceRange:      (...a) => cmEditor.replaceRange(...a),
  replaceSelection:  (...a) => cmEditor.replaceSelection(...a),
  getSelection:      (...a) => cmEditor.getSelection(...a),
  somethingSelected: (...a) => cmEditor.somethingSelected(...a),
  eachLine:          (...a) => cmEditor.eachLine(...a),
  // cursor / selection / scroll / coords
  getCursor:         (...a) => cmEditor.getCursor(...a),
  setCursor:         (...a) => cmEditor.setCursor(...a),
  scrollIntoView:    (...a) => cmEditor.scrollIntoView(...a),
  coordsChar:        (...a) => cmEditor.coordsChar(...a),
  getViewport:       (...a) => cmEditor.getViewport(...a),
  // focus / DOM
  focus:             (...a) => cmEditor.focus(...a),
  hasFocus:          (...a) => cmEditor.hasFocus(...a),
  getWrapperElement: (...a) => cmEditor.getWrapperElement(...a),
  refresh:           (...a) => cmEditor.refresh(...a),
  // marks / line classes / gutters
  markText:          (...a) => cmEditor.markText(...a),
  addLineClass:      (...a) => cmEditor.addLineClass(...a),
  removeLineClass:   (...a) => cmEditor.removeLineClass(...a),
  setGutterMarker:   (...a) => cmEditor.setGutterMarker(...a),
  clearGutter:       (...a) => cmEditor.clearGutter(...a),
  // config / events / batching / history
  setOption:         (...a) => cmEditor.setOption(...a),
  on:                (...a) => cmEditor.on(...a),
  off:               (...a) => cmEditor.off(...a),
  operation:         (...a) => cmEditor.operation(...a),
  clearHistory:      (...a) => cmEditor.clearHistory(...a),
  changeGeneration:  (...a) => cmEditor.changeGeneration(...a),
  // statics — delegate to the global CodeMirror namespace
  registerHelper:    (...a) => CodeMirror.registerHelper(...a),
  Pos:               (...a) => CodeMirror.Pos(...a),
  normalizeKeyMap:   (...a) => CodeMirror.normalizeKeyMap(...a),
  keyName:           (...a) => CodeMirror.keyName(...a),
  get helpers() { return CodeMirror.helpers; },
  get hint()    { return CodeMirror.hint; },
};

// v-CM6 (Phase 5 inc2) — engine switch. `?cm=6` opts in + persists to
// localStorage; `?cm=5` opts out; otherwise the saved flag decides. CM5 remains
// the default. Heavy features (lint/autocomplete/spell) are guarded off under
// CM6 for this increment — see boot.js + linter.js. Full plan: PHASE5 doc.
const CM6_ENGINE = (() => {
  // v5.0.0-beta.8.0 — CM6 is now the DEFAULT engine. `?cm=5` opts into legacy CM5 (persists
  // to localStorage as the escape hatch); `?cm=6` clears it back to default; with
  // no param the default is CM6 unless the user explicitly parked on CM5.
  try {
    const q = new URLSearchParams(location.search).get("cm");
    if (q === "5") { localStorage.setItem("texlocal_cm_engine", "5"); return false; }
    if (q === "6") { localStorage.removeItem("texlocal_cm_engine"); return true; }
    return localStorage.getItem("texlocal_cm_engine") !== "5";
  } catch (_) { return true; }
})();
export { CM6_ENGINE };

// v-CM6 (Phase 5) — the ?cm=6 flag PERSISTS to localStorage (so it survives
// dashboard→editor navigation while testing). That created a trap: after visiting
// ?cm=6 once, a later plain /editor is silently still CM6 — where autocomplete/
// spell/lint are intentionally off this increment, so it LOOKS like CM5 broke.
// This badge makes the active engine unmistakable + gives a one-click way back to
// CM5 (clears the flag, preserves the current project in the URL). Remove when
// CM6 is feature-complete and becomes the default.
function _cm6Badge() {
  // v5.0.0-beta.8.0 — CM6 is the default now, so no badge for it. Show a small badge ONLY
  // when running the legacy CM5 engine (opted in via ?cm=5) so it's obvious you're
  // off the default, with one click back to CM6 (project preserved).
  if (CM6_ENGINE || document.getElementById("cm6-badge")) return;
  const b = document.createElement("div");
  b.id = "cm6-badge";
  b.innerHTML = 'CM5 (legacy) \u00b7 <a href="#" id="cm6-exit" style="color:#fff;text-decoration:underline">Switch to CM6</a>';
  b.style.cssText = "position:fixed;bottom:10px;right:12px;z-index:99999;background:#4b5563;color:#fff;font:12px/1.4 'Sora',system-ui,sans-serif;padding:6px 10px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.35);max-width:300px";
  document.body.appendChild(b);
  document.getElementById("cm6-exit").addEventListener("click", (e) => {
    e.preventDefault();
    try { localStorage.removeItem("texlocal_cm_engine"); } catch (_) {}
    const u = new URL(location.href);
    u.searchParams.delete("cm");            // drop ?cm=5 so it can't re-arm the legacy flag
    location.href = u.pathname + u.search;  // reload into default CM6, project preserved
  });
}

// CM + cmEditor are engine-chosen. CM5 = the `_CM5` facade above + a real
// CodeMirror instance (built in the INIT block below, guarded on !CM6_ENGINE).
// CM6 = the adapter's facade + an EditorView, built now. `export let` so
// importers get a live binding to whichever engine won.
export let CM = _CM5;
export let cmEditor;
if (CM6_ENGINE) {
  const _tab = parseInt(localStorage.getItem("texlocal_tab_size") || "2", 10) || 2;
  const _cm6 = createCm6Editor(document.getElementById("editor-host"), { tabSize: _tab, lineWrapping: true });
  CM = _cm6.CM;
  cmEditor = _cm6.view;
}

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
CM.registerHelper("fold", "latex-section", function (cm, start) {
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
    from: CM.Pos(start.line, lineStr.length),
    to:   CM.Pos(endLine, cm.getLine(endLine).length),
  };
});

// ── v4.8.2 — Editor keybinding registry (settings/keymap phase 3) ──────
// EDITOR_ACTIONS is the single source of truth for the remappable, editor-scope
// shortcuts. Each entry pairs a stable id (matching KEYBINDINGS below) with its
// default key + the CM handler. The init extraKeys is BUILT from this map (see
// _buildExtraKeys) rather than hand-written, so a user remap only rewrites one
// localStorage entry and re-applies — the handler wiring never moves. Global
// (document-level) and CM-default shortcuts are intentionally NOT here: phase 3
// remaps editor scope only.
const _KB_LS_KEY = "texlocal_keybindings"; // global overrides {id: "Canonical-Key"}
const EDITOR_ACTIONS = {
  snippet:     { defaultKey: "Tab",          handler: cm => _snippetTabHandler(cm) },
  compile:     { defaultKey: "Ctrl-Enter",   handler: ()  => compile() },
  find:        { defaultKey: "Ctrl-F",       handler: "findPersistent" },
  replace:     { defaultKey: "Ctrl-H",       handler: "replace" },
  "find-next": { defaultKey: "Ctrl-G",       handler: "findNext" },
  // Shift-Ctrl-G is CM's canonical modifier order for Ctrl+Shift+G.
  grammar:     { defaultKey: "Shift-Ctrl-G", handler: ()  => toggleGrammarMode() },
  // fold + unfold share one toggle handler (foldCode toggles), different keys.
  fold:        { defaultKey: "Ctrl-Shift-[", handler: cm => cm.foldCode(cm.getCursor(), { rangeFinder: CM.helpers.fold["latex-section"] }) },
  unfold:      { defaultKey: "Ctrl-Shift-]", handler: cm => cm.foldCode(cm.getCursor(), { rangeFinder: CM.helpers.fold["latex-section"] }) },
};
// Saved overrides ({} on missing/corrupt). Global localStorage, matching
// texlocal_theme / texlocal_font_size etc.
function getSavedKeybindings() {
  try { return JSON.parse(localStorage.getItem(_KB_LS_KEY)) || {}; }
  catch (e) { return {}; }
}
// Build the CM extraKeys object: override key (if any) else default → handler.
// CM normalises modifier order on setOption, so keys need no pre-normalising
// here — normalisation matters only for conflict comparison (see _kbNorm).
function _buildExtraKeys(overrides) {
  const map = {};
  for (const id in EDITOR_ACTIONS) {
    const key = (overrides && overrides[id]) || EDITOR_ACTIONS[id].defaultKey;
    map[key] = EDITOR_ACTIONS[id].handler;
  }
  return map;
}

if (!CM6_ENGINE) cmEditor = CodeMirror(document.getElementById("editor-host"), {
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
    rangeFinder: CM.helpers.fold["latex-section"],
  },
  // v3.2.2 — autopair brackets, quotes, and dollars. Pairs typed: ( [ { " ' $.
  // CodeMirror also handles "skip closer if cursor is right before it" and
  // "delete pair on backspace" automatically. The string form lists
  // open/close characters position-paired (index 0 opens index 1 of the
  // partner string, etc.). Backslash-bracket pairs like `\[ \]` aren't
  // covered by this addon (it operates on single chars); they're typed
  // less often and `\[<Tab>` template via snippets covers that case.
  autoCloseBrackets: { pairs: "()[]{}\"\"''$$", explode: "[]{}", closeBefore: ")]}'\":;>$" },
  // v4.8.2 — extraKeys is built from EDITOR_ACTIONS (defined above) merged with
  // any saved remaps, so this is the only place the editor keymap is wired.
  // Live remapping goes through applyEditorKeybindings(); see the Keyboard tab.
  extraKeys: _buildExtraKeys(getSavedKeybindings())
});
let outlineTimer = null;
CM.on("change", () => {
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
CM.on("cursorActivity", () => {
  const cur = CM.getCursor();
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
  const wrap = CM.getWrapperElement();
  wrap.addEventListener("mousemove", e => {
    if (imgHoverTimer) clearTimeout(imgHoverTimer);
    imgHoverTimer = setTimeout(() => {
      // Map mouse → editor (line, ch)
      const pos = CM.coordsChar({ left: e.clientX, top: e.clientY });
      const line = CM.getLine(pos.line);
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
export async function init() {
  console.info("[TexLocal] editor engine:", CM6_ENGINE ? "CM6" : "CM5 (legacy)");
  _cm6Badge(); // v5.0.0-beta.8.0 — show a legacy badge only when running CM5
  if (CM6_ENGINE) applyEditorKeybindings(); // v-CM6 inc3 — wire EDITOR_ACTIONS into the CM6 keymap (CM5 builds them inline at construction)
  // restore saved theme
  const savedTheme = localStorage.getItem("texlocal_theme") || "dark";
  setTheme(savedTheme, true);
  // v3.2.3 — restore saved editor theme (default = light, the original look)
  const savedEditorTheme = localStorage.getItem("texlocal_editor_theme") || "light";
  setEditorTheme(savedEditorTheme, true);
  // v4.7.9 — restore saved appearance theme (default = original blue scheme)
  const savedAppearance = localStorage.getItem("texlocal_appearance") || "default";
  setAppearance(savedAppearance, true);
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
export async function loadProjects() {
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

export function saveCompilerPref(compiler) {
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
export async function loadIncludes() {
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
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]
  ));
}
export function escapeAttr(s) { return escapeHtml(s).replace(/'/g, "&#39;"); }

// v3.3.0 — Hidden-textarea clipboard fallback. navigator.clipboard works on
// https://localhost but some users open via http://<ip>:5000 (network access)
// where the API is undefined; document.execCommand("copy") still works there.
export function _copyFallback(text, onSuccess) {
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

export function toggleInclude(path, checked) {
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

export function setAllIncludes(allOn) {
  selectedIncludes = allOn ? availableIncludes.map(i => i.path) : [];
  saveIncludesPref();
  renderChaptersPanel();
  updateChaptersBadge();
}

export async function loadIncludesUI() {
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
  "outline-panel", "package-panel", "bib-panel"   // v4.9.0
];
function _closeOtherToolbarPanels(exceptId) {
  for (const id of _TOOLBAR_PANEL_IDS) {
    if (id === exceptId) continue;
    const p = document.getElementById(id);
    if (p && p.classList.contains("open")) p.classList.remove("open");
  }
}

// v5.0.0-beta.0.0 — Popover helper (Phase 0 of the editor.js modularization; see
// PLAN_editor-modularization). Every toolbar popover used to repeat the same
// open -> _closeOtherToolbarPanels -> position-below-button -> clamp-left ->
// onOpen -> add .open -> stopPropagation dance, PLUS a near-identical per-panel
// document outside-click listener. That was ~10 copies of ~20 lines + 10
// document listeners. This worker + one delegated listener replace all of it;
// each toggle*Panel is now a one-line call passing {panelId, btnId, width, onOpen}.
// Settings is deliberately NOT a Popover — it's a centered modal with its own
// Esc handling + closeSettingsPanel() lifecycle (v4.8.0).
export function _togglePopover(e, { panelId, btnId, width, onOpen }) {
  const panel = document.getElementById(panelId);
  if (panel.classList.contains("open")) { panel.classList.remove("open"); return; }
  _closeOtherToolbarPanels(panelId);
  const rect = document.getElementById(btnId).getBoundingClientRect();
  let left = rect.right - width;
  if (left < 4) left = 4;                        // clamp to viewport left edge
  panel.style.top  = (rect.bottom + 4) + "px";   // right-anchored, below the button
  panel.style.left = left + "px";
  if (onOpen) onOpen();                          // panels re-render / re-fetch on open
  panel.classList.add("open");
  if (e) e.stopPropagation();                    // don't let the delegated close fire
}

// v5.0.0-beta.0.0 — single delegated outside-click close for ALL toolbar popovers,
// replacing the 10 duplicated per-panel document listeners. panelId -> its
// toggle button, so a click on the button itself doesn't immediately re-close
// the panel the toggle just opened. Only one popover is ever open at a time
// (_closeOtherToolbarPanels), so the loop closes at most one per click.
const _POPOVER_BTN = {
  "chapters-panel": "chapters-toggle-btn",
  "env-panel":      "env-toggle-btn",
  "package-panel":  "package-toggle-btn",
  "snippet-panel":  "snippet-toggle-btn",
  "bib-panel":      "bib-toggle-btn",
  "outline-panel":  "outline-toggle-btn",
  "todo-panel":     "todo-toggle-btn",
  "goals-panel":    "goals-toggle-btn",
  "history-panel":  "history-btn",
  "symbol-panel":   "sym-toggle-btn",
};
document.addEventListener("click", (e) => {
  for (const panelId in _POPOVER_BTN) {
    const panel = document.getElementById(panelId);
    if (!panel || !panel.classList.contains("open")) continue;
    if (panel.contains(e.target)) continue;
    if (e.target.closest("#" + _POPOVER_BTN[panelId])) continue;
    panel.classList.remove("open");
  }
});

// v5.0.0-beta.0.0 — Popover (worker: _togglePopover). loadIncludesUI on open because
// the main file may have changed since the panel was last opened.
export function toggleChaptersPanel(e){ _togglePopover(e, { panelId: "chapters-panel", btnId: "chapters-toggle-btn", width: 320, onOpen: loadIncludesUI }); }

// v3.2.2 — Pull aggregated bibkey + label data for autocomplete. Cached on
// the server side, so frequent calls are cheap when nothing has changed.
export async function loadCiteData() {
  if (!currentProject) {
    bibkeysCache = []; labelsCache = []; userCmdCache = []; userEnvCache = [];
    lintCrossRefs();   // clear any stale marks
    return;
  }
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/cite-data`);
    if (!r.ok) throw new Error("cite-data " + r.status);
    const d = await r.json();
    bibkeysCache = d.bibkeys || [];
    labelsCache  = d.labels  || [];
    userCmdCache = d.commands || [];
    userEnvCache = d.environments || [];
  } catch (_) {
    bibkeysCache = []; labelsCache = []; userCmdCache = []; userEnvCache = [];
  }
  // v3.2.3 — refresh the cross-ref linter once the cache lands.
  lintCrossRefs();
  // v4.9.0 — keep the bib-audit toolbar badge in sync with the same signal.
  updateBibBadge();
}

// v5.0.0-beta.3.0 — CROSS-REFERENCE LIVE LINTER lifted to static/linter.js (Phase 3 CM-heavy split).

// v3.2.2 — Draft mode: stored per-project so a thesis with heavy figures can
// stay in draft while a presentation deck stays in full-render mode.
function loadDraftPref(projectName) {
  draftMode = localStorage.getItem(`texlocal_draft_${projectName}`) === "1";
  const cb = document.getElementById("draft-mode-toggle");
  if (cb) cb.checked = draftMode;
  updateDraftBadge();
}
export function onDraftModeToggle() {
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

export async function switchProject(name, opts) {
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
  CM.setValue("");
  document.getElementById("pdf-canvas-container").style.display = "none";
  document.getElementById("pdf-placeholder").style.display = "flex";
  document.getElementById("pdf-download").style.display = "none";
  // v3.2.3 — include the page-jump input + total label so they reset on project switch
  ["pdf-zoom-out","pdf-zoom-in","pdf-zoom-label","pdf-zoom-sep2","pdf-page-input","pdf-page-total"].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = "none";
  });
  document.getElementById("compile-status").textContent = "";
  document.getElementById("compile-status").title       = "";   // v3.3.0 — clear stale stats tooltip on project switch
  // ── Detect main file — cache-first (v4.7.4) ────────────────
  // detect-main is one network round-trip that previously BLOCKED the whole
  // parallel batch below (it's awaited before the batch can start). The main
  // file almost never changes, so cache it per project and reuse it instantly;
  // only the FIRST open of a project pays the round-trip. A background
  // revalidate (stale-while-revalidate) keeps the cache honest for next time.
  const _mainKey = `texlocal_main_${name}`;
  const _setMainStatus = (m) => {
    if (m && m !== "main.tex") {
      const status = document.getElementById("compile-status");
      status.textContent = `Main: ${m.split("/").pop()}`;
      status.className = "compile-status";
    }
  };
  const _cachedMain = localStorage.getItem(_mainKey);
  if (_cachedMain) {
    mainFile = _cachedMain;          // use immediately — no await, no blocking
    _setMainStatus(mainFile);
    // Revalidate in the background; only refresh the cache (next open is then
    // correct). We don't reopen files this session — a renamed main is rare and
    // self-heals on the next open. Guard against a fast project switch.
    fetch(`/api/projects/${encodeURIComponent(name)}/detect-main`)
      .then(r => r.json())
      .then(d => {
        const fresh = d.main || "main.tex";
        if (fresh !== _cachedMain) {
          localStorage.setItem(_mainKey, fresh);
          if (currentProject === name) _setMainStatus(fresh);
        }
      })
      .catch(() => {});
  } else {
    try {
      const mData = await (await fetch(`/api/projects/${encodeURIComponent(name)}/detect-main`)).json();
      mainFile = mData.main || "main.tex";
      localStorage.setItem(_mainKey, mainFile);   // cache for instant reuse next time
      _setMainStatus(mainFile);
    } catch (_) { /* fallback to main.tex */ }
  }
  // ── Parallel startup (v4.5.0) ──────────────────────────────────────
  // The file-tree, the main file's editor content, and the compiled PDF are
  // all independent. Loading them concurrently — instead of awaiting
  // loadFiles → HEAD → showPDF → openFile in series — markedly cuts the time
  // from "open editor" to "PDF + source on screen". Combined with lazy PDF
  // rasterisation (renderPdfFromUrl), the compiled main file now appears
  // almost immediately even for a 150-page thesis.
  // v4.7.4 — capture loadFiles()'s promise so _restoreLastFile can reuse this
  // one /files fetch instead of issuing a second identical round-trip.
  const _filesP = loadFiles();
  const _startupTasks = [ _filesP ];

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

  // v4.5.0 — open the source as part of the same batch. v4.7.0beta (PR#2):
  // reopen the LAST-visited file (with its saved cursor) instead of always
  // main; _restoreLastFile falls back to mainFile when there's no valid last
  // file.
  // v4.7.3 — open the main/last file by DEFAULT on every project switch. Bug:
  // only init's dashboard (?project=) and last-session paths passed
  // { openMain: true }; switching via the header dropdown, the Projects modal,
  // or after a ZIP import called switchProject(name) with no opts, so no file
  // opened and the editor sat blank ("stuck, didn't go to main"). Now any
  // switch restores a file unless a caller explicitly opts out with
  // { openMain: false }.
  if (!opts || opts.openMain !== false) _startupTasks.push(_restoreLastFile(name, _filesP));

  await Promise.allSettled(_startupTasks);
}

export function showNewProject() {
  document.getElementById("input-project-name").value = "";
  openModal("modal-project");
  setTimeout(() => document.getElementById("input-project-name").focus(), 100);
}

export async function createProject() {
  const name = document.getElementById("input-project-name").value.trim();
  if (!name) return;
  await fetch("/api/projects", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({name}) });
  closeModal("modal-project");
  await loadProjects();
  document.getElementById("project-select").value = name;
  await switchProject(name);
}

// v5.0.0-beta.2.0 — FILES lifted to static/files.js (Phase 2 CM-light split). Loaded via <script defer> after editor.js.
// v5.0.0-beta.3.0 — ERROR MARKERS + PANEL + LOGS lifted to static/errors.js (Phase 3 CM-heavy split).
//   Owns lastParsedLog / logsActiveTab / _markerTipEl (global, shared scope). Loaded via <script defer> after editor.js.

// ── COMPILE ───────────────────────────────────────────────────
export async function compile() {
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
      // v4.9.5 — was hard-coded `true` (code-review B1). That forced a
      // bibtex/biber run + the full 3-pass sequence (compile→bib→compile→compile)
      // on EVERY compile whenever any .bib file existed in the project — even if
      // the document never \bibliography/\addbibresource'd it — making the
      // backend's has_bib_cmd auto-detection dead code and costing 2 extra
      // pdflatex passes (+ a spurious "no \citation commands" warning) on the
      // common path of the real thesis. Send false and let the backend decide.
      bibtex: false,
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
  _ssLastParsedLog(parsed);
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
  // v4.9.0 — prepend a one-line citation-health summary to the log so bib
  // problems surface without opening the panel. Async, fire-and-forget; runs
  // on success and failure alike (citation health is independent of compile).
  _appendBibAuditBreadcrumb();
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

// v5.0.0-beta.2.0 — PDFVIEWER lifted to static/pdfviewer.js (Phase 2 CM-light split). Loaded via <script defer> after editor.js.
export function toggleLog() {
  document.getElementById("log-panel").classList.toggle("open");
}

// ── PROJECT MANAGEMENT MODAL ─────────────────────────────────
export async function openProjectsModal() {
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
        CM.setValue("");
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
export function openModal(id)  { document.getElementById(id).classList.add("open"); }
export function closeModal(id) { document.getElementById(id).classList.remove("open"); }
document.querySelectorAll(".modal-overlay").forEach(o => {
  o.addEventListener("click", e => { if (e.target === o) o.classList.remove("open"); });
});

// ── EXPORT ZIP ───────────────────────────────────────────────
// v4.7.6 — WebView2 (the host the desktop build embeds) treats HTML5 download
// (<a download> / programmatic a.click()) as a no-op, so PDF/ZIP downloads
// silently failed in the desktop app though browser mode worked. desktopSave
// hands the server-relative URL + a suggested filename to the Python js_api,
// which fetches the bytes from the local server and shows a native Save dialog.
export async function desktopSave(urlPath, filename) {
  try {
    const res = await window.pywebview.api.save_file(urlPath, filename);
    if (res && res.ok) return;                    // saved — dialog already confirmed location
    if (res && res.cancelled) return;             // user cancelled — stay quiet
    alert("Download failed: " + ((res && res.error) || "unknown error"));
  } catch (e) {
    alert("Download failed: " + e);
  }
}

function exportZip() {
  if (!currentProject) return alert("Select a project first.");
  const btn = document.getElementById("export-zip-btn");
  const urlPath = `/api/projects/${encodeURIComponent(currentProject)}/export-zip`;
  const fname   = `${currentProject}.zip`;
  // v4.7.6 — desktop build can't use <a download>; go through the bridge.
  if (window.pywebview) {
    btn.textContent = "⏳ Exporting…"; btn.disabled = true;
    desktopSave(urlPath, fname).finally(() => {
      setTimeout(() => { btn.textContent = "⬇ Export ZIP"; btn.disabled = false; }, 300);
    });
    return;
  }
  btn.textContent = "⏳ Exporting…"; btn.disabled = true;
  const a = document.createElement("a");
  a.href = urlPath;
  a.download = fname;
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
export function updateWordCount() {
  const el = document.getElementById("word-count");
  if (!currentFile || !currentFile.endsWith(".tex")) { el.textContent = ""; return; }
  const plain = stripLatexCommands(CM.getValue());
  const words = plain ? plain.split(/\s+/).filter(w => w.length > 0).length : 0;
  el.textContent = `${words.toLocaleString()} words`;
}

// ── AUTO-COMPILE ──────────────────────────────────────────────
export function onAutoCompileToggle() {
  autoCompile = document.getElementById("auto-compile-toggle").checked;
  if (!autoCompile) clearTimeout(autoCompileTimer);
}

// v5.0.0-beta.3.0 — LATEX AUTOCOMPLETE + PROSE WORD SUGGESTIONS lifted to static/autocomplete.js (Phase 3 CM-heavy split).
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
    CM.refresh();
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
export function setFontSize(px) {
  // v-CM6 — .CodeMirror exists only in CM5; CM6 uses .cm-editor. Guard both.
  const _fsEl = document.querySelector(".CodeMirror") || document.querySelector(".cm-editor");
  if (_fsEl) _fsEl.style.fontSize = px + "px";
  CM.refresh();
  localStorage.setItem("texlocal_font_size", px);
}

export function setTabSize(n) {
  n = parseInt(n);
  CM.setOption("tabSize", n);
  CM.setOption("indentUnit", n);
  localStorage.setItem("texlocal_tab_size", n);
}

// ── EDITOR TOOLBAR ACTIONS ───────────────────────────────────
export function wrapSel(before, after) {
  const sel = CM.getSelection();
  if (sel) {
    CM.replaceSelection(before + sel + after);
  } else {
    const cur = CM.getCursor();
    CM.replaceSelection(before + after);
    CM.setCursor({ line: cur.line, ch: cur.ch + before.length });
  }
  CM.focus();
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
  const cur  = CM.getCursor();
  const last = CM.lastLine();
  const blank = (ln) => !(CM.getLine(ln) || "").trim();
  if (blank(cur.line)) {
    const len = (CM.getLine(cur.line) || "").length;
    return { from: { line: cur.line, ch: 0 }, to: { line: cur.line, ch: len } };
  }
  let top = cur.line, bot = cur.line;
  while (top > 0    && !blank(top - 1)) top--;
  while (bot < last && !blank(bot + 1)) bot++;
  return { from: { line: top, ch: 0 }, to: { line: bot, ch: (CM.getLine(bot) || "").length } };
}

export function openGrammarMode() {
  if (!cmEditor) return;
  const range = CM.somethingSelected()
    ? { from: CM.getCursor("from"), to: CM.getCursor("to") }
    : _currentParagraphRange();
  _grammarRange = range;
  const ta = document.getElementById("grammar-textarea");
  if (!ta) return;
  ta.value = CM.getRange(range.from, range.to);
  openModal("modal-grammar");
  // Focus + caret at end so the extension activates and typing starts cleanly.
  setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 30);
}

export function applyGrammarText() {
  const ta = document.getElementById("grammar-textarea");
  if (ta && _grammarRange) {
    // Modal blocks editing while open, so the stored range is still valid.
    CM.replaceRange(ta.value, _grammarRange.from, _grammarRange.to);
  }
  _grammarRange = null;
  closeModal("modal-grammar");
  CM.focus();
}

// v4.4.0 — Ctrl-G toggle: open Grammar mode, or close it if already open.
function toggleGrammarMode() {
  const modal = document.getElementById("modal-grammar");
  if (modal && modal.classList.contains("open")) closeModal("modal-grammar");
  else openGrammarMode();
}
// CodeMirror's "Shift-Ctrl-G" extraKey handles the open case while the editor
// is focused. This document-level handler covers Ctrl+Shift+G when focus is
// elsewhere (e.g. inside the grammar textarea, to close it) — and bails when
// the editor is focused so the two never double-fire.
document.addEventListener("keydown", e => {
  if (!((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey
        && (e.key === "g" || e.key === "G"))) return;
  if (cmEditor && CM.hasFocus && CM.hasFocus()) return;  // CM keymap handles it
  e.preventDefault();
  toggleGrammarMode();
});

// v5.0.0-beta.2.0 — GITHUB lifted to static/github.js (Phase 2 CM-light split). Loaded via <script defer> after editor.js.
// Reload the open file's content from disk WITHOUT saving the editor buffer
// first — used after a pull, where saving would push the stale buffer back
// over the freshly-pulled changes.
export async function _reloadCurrentFileFromDisk() {
  if (!currentProject || !currentFile || isImageFile(currentFile)) return;
  try {
    const data = await (await fetch(`/api/projects/${encodeURIComponent(currentProject)}/file?path=${encodeURIComponent(currentFile)}`)).json();
    const tab = openTabs.find(t => t.name === currentFile);
    if (tab) tab.content = data.content;
    CM.setValue(data.content || "");
    CM.clearHistory();
    updateOutline(); updateWordCount();
  } catch (_) { /* leave the editor as-is on failure */ }
}

export function insertDisplayMath() {
  const cur = CM.getCursor();
  CM.replaceSelection('\\[\n\n\\]');
  CM.setCursor({ line: cur.line + 1, ch: 0 });
  CM.focus();
}

// v5.0.0-beta.3.0 — SYNCTEX FORWARD SEARCH lifted to static/synctex.js (Phase 3 CM-heavy split).
// ── THEME ────────────────────────────────────────────────────
export function setTheme(theme, skipSave) {
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
export function setEditorTheme(theme, skipSave) {
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

// v4.7.9 — Appearance theme: accent color scheme for UI text & buttons.
// Orthogonal to data-theme (dark/light) and data-editor-theme — it only
// swaps the accent system (--accent, --accent-rgb, --accent-bright,
// --btn-primary-bg[-hover]). "default" = the original blue (#5b9cf6);
// "cerulean" applies the SchemeColor "Cerulean Gradient" palette via the
// [data-appearance="cerulean"] block in editor.css. The app icon is NOT
// affected. Persisted globally (not per-project), shared with dashboard.html.
export function setAppearance(name, skipSave) {
  if (name === "cerulean") {
    document.documentElement.setAttribute("data-appearance", "cerulean");
  } else {
    name = "default";
    document.documentElement.removeAttribute("data-appearance");
  }
  if (!skipSave) localStorage.setItem("texlocal_appearance", name);
  const defBtn = document.getElementById("appearance-default-btn");
  const cerBtn = document.getElementById("appearance-cerulean-btn");
  if (defBtn) defBtn.classList.toggle("active", name === "default");
  if (cerBtn) cerBtn.classList.toggle("active", name === "cerulean");
}

// ── v3.2.3 — QUICK OPEN (Ctrl+P) ────────────────────────────────
// File cache is refreshed by loadFiles(). Matching is a simple subsequence
// scorer: each query character must appear in order in the candidate; we
// reward consecutive matches, basename hits, and earlier hit positions.
// Top-50 are shown to keep the list snappy on big projects.
let quickOpenFiles  = [];   // current project's file list (filtered)
let qoActiveIdx     = 0;
let qoCurrentMatches = [];

export function setQuickOpenFiles(files) {
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

export function _esc(s) {
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

export function closeQuickOpen() {
  document.getElementById("quick-open-overlay").classList.remove("open");
  // Return focus to the editor so typing resumes naturally.
  if (cmEditor) CM.focus();
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
export function toggleFocusMode() {
  document.body.classList.toggle("focus-mode");
  setTimeout(() => CM.refresh(), 50);
}
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    if (document.body.classList.contains("focus-mode")) {
      document.body.classList.remove("focus-mode");
      setTimeout(() => CM.refresh(), 50);
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
let _settingsEsc = null; // v4.8.0 — bound Escape handler, removed on close

// v4.8.0 — Settings moved from a 256px toolbar dropdown to a centered modal
// dialog with a left tab rail (Appearance / Compile / Editor / Keyboard),
// reusing the dict-manager overlay pattern. The rect-anchor positioning the
// dropdown needed is gone — the overlay centers via flexbox. Backdrop click
// closes it (inline onclick on #settings-panel); Esc closes via a listener
// added on open / removed on close, matching openDictManager.
export function switchSettingsTab(name) {
  for (const t of document.querySelectorAll(".settings-tab")) {
    const on = t.id === `settings-tab-${name}`;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  }
  for (const p of document.querySelectorAll(".settings-pane")) {
    p.classList.toggle("active", p.id === `settings-pane-${name}`);
  }
  if (name === "keyboard") renderKeyboardShortcuts(); // v4.8.1 — lazy-render cheat-sheet
  if (name === "engine") renderEditorEngineInfo();   // v-CM6 vp.2 — engine + packages
}

// v-CM6 vp.2 — Settings ▸ Engine tab. Shows which editor engine is live (CM6
// default / CM5 legacy) and the CM6 package versions vendored in the offline
// bundle (static/vendor/cm6/, pins mirrored from VERSIONS.txt). Read-only info;
// package names/versions are trusted constants, so no escaping needed.
const CM6_PACKAGES = [
  ["@codemirror/state", "6.7.0"],
  ["@codemirror/view", "6.43.4"],
  ["@codemirror/commands", "6.10.4"],
  ["@codemirror/language", "6.12.4"],
  ["@codemirror/autocomplete", "6.20.3"],
  ["@codemirror/lint", "6.9.7"],
  ["@codemirror/search", "6.7.1"],
  ["@codemirror/legacy-modes", "stex"],
  ["@lezer/highlight", "tags"],
];
function renderEditorEngineInfo() {
  const pane = document.getElementById("settings-pane-engine");
  if (!pane) return;
  const cm6 = CM6_ENGINE;
  const engineName = cm6 ? "CodeMirror 6" : "CodeMirror 5.65.16 (legacy)";
  const engineNote = cm6
    ? "The modern engine (default). Multi-cursor, incremental parsing, stronger Thai/IME handling."
    : "The classic engine, kept as a reversible fallback. Add <code>?cm=6</code> to the URL to switch back to CM6.";
  const rows = cm6
    ? CM6_PACKAGES.map(([n, v]) =>
        `<div class="engine-pkg"><span class="engine-pkg-name">${n}</span><span class="engine-pkg-ver">${v}</span></div>`).join("")
    : `<div class="engine-pkg"><span class="engine-pkg-name">codemirror</span><span class="engine-pkg-ver">5.65.16</span></div>` +
      `<div class="engine-pkg"><span class="engine-pkg-name">+ mode / addon</span><span class="engine-pkg-ver">stex, fold, hint, lint, search…</span></div>`;
  pane.innerHTML =
    `<div class="engine-hero">` +
      `<span class="engine-badge ${cm6 ? "is-cm6" : "is-cm5"}">${cm6 ? "CM6" : "CM5"}</span>` +
      `<div class="engine-hero-txt"><div class="engine-hero-name">${engineName}</div>` +
        `<div class="engine-hero-note">${engineNote}</div></div>` +
    `</div>` +
    `<div class="engine-sec-title">Editor packages</div>` +
    `<div class="engine-pkg-list">${rows}</div>` +
    `<div class="engine-foot">Also bundled: pdf.js 3.11.174 · KaTeX (math preview) · Typo.js (spell check)</div>`;
}

export function toggleSettingsPanel(e) {
  const panel = document.getElementById("settings-panel");
  if (panel.classList.contains("open")) {
    closeSettingsPanel();
    return;
  }
  _closeOtherToolbarPanels("settings-panel"); // v3.3.7
  // sync current state into panel controls
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
  switchSettingsTab("appearance"); // always open on the first tab
  panel.classList.add("open");
  // v4.8.0 — Esc closes the modal, but not while the dict-manager modal is
  // stacked on top of it (opened from the Editor tab's "Manage…" button).
  _settingsEsc = (ev) => {
    if (ev.key !== "Escape") return;
    const dm = document.getElementById("dict-mgr-overlay");
    if (dm && dm.classList.contains("open")) return;
    closeSettingsPanel();
  };
  document.addEventListener("keydown", _settingsEsc);
  if (e) e.stopPropagation();
}

export function closeSettingsPanel() {
  document.getElementById("settings-panel").classList.remove("open");
  if (_settingsEsc) {
    document.removeEventListener("keydown", _settingsEsc);
    _settingsEsc = null;
  }
}

// ── KEYBOARD SHORTCUTS CHEAT-SHEET (v4.8.1 — phase 2) ────────
// v4.8.1 — Single source of truth for keyboard shortcuts, consolidating the
// three places bindings currently live: CodeMirror extraKeys (editor scope,
// editor.js ~line 116), document-level keydown handlers (global scope), and
// CM 5.65's built-in default keymap (cmdefault — listed for discoverability,
// e.g. Ctrl-D deletes a line, which has surprised people). Rendered read-only
// in the Keyboard tab for now; the `id`/`scope` fields are groundwork for the
// phase-3 click-to-remap (editor-scope keys remap first). Keep this list in
// sync when adding a new binding anywhere above.
const KEYBINDINGS = [
  { cat: "Compile & files", items: [
    { id: "compile",        label: "Compile document",              keys: ["Ctrl-Enter"],             scope: "editor" },
    { id: "quick-open",     label: "Quick open file",               keys: ["Ctrl-P"],                 scope: "global" },
  ]},
  { cat: "Search", items: [
    { id: "find",           label: "Find in file",                  keys: ["Ctrl-F"],                 scope: "editor" },
    { id: "replace",        label: "Replace in file",               keys: ["Ctrl-H"],                 scope: "editor" },
    { id: "find-next",      label: "Find next",                     keys: ["Ctrl-G"],                 scope: "editor" },
    { id: "project-search", label: "Search across project",         keys: ["Ctrl-Shift-F"],           scope: "global" },
    { id: "escape",         label: "Close search / exit focus mode", keys: ["Esc"],                   scope: "global" },
  ]},
  { cat: "Editing", items: [
    { id: "snippet",        label: "Expand snippet / indent",       keys: ["Tab"],                    scope: "editor" },
    { id: "grammar",        label: "Toggle grammar mode",           keys: ["Ctrl-Shift-G"],           scope: "editor" },
    { id: "add-cursor",     label: "Add cursor (multi-cursor)",     keys: ["Alt-Click"],              scope: "cmdefault" },
    { id: "delete-line",    label: "Delete line",                   keys: ["Ctrl-D"],                 scope: "cmdefault" },
    { id: "undo",           label: "Undo",                          keys: ["Ctrl-Z"],                 scope: "cmdefault" },
    { id: "redo",           label: "Redo",                          keys: ["Ctrl-Y", "Ctrl-Shift-Z"], scope: "cmdefault" },
  ]},
  { cat: "Folding & view", items: [
    { id: "fold",           label: "Fold section",                  keys: ["Ctrl-Shift-["],           scope: "editor" },
    { id: "unfold",         label: "Unfold section",                keys: ["Ctrl-Shift-]"],           scope: "editor" },
  ]},
  { cat: "Navigation", items: [
    { id: "synctex-fwd",    label: "Jump to PDF (SyncTeX forward)", keys: ["Ctrl-Alt-→"],             scope: "global" },
  ]},
];

// Render the read-only cheat-sheet into the Keyboard tab (built once, guarded
// by dataset.rendered so re-opening the tab is a no-op).
// v4.8.2 (phase 3) — the cheat-sheet is now interactive for editor-scope
// shortcuts: each editor row is a button that captures a new keystroke,
// conflict-checks it against the other editor bindings + reserved global/
// CM-default keys, persists to localStorage and re-applies live via
// applyEditorKeybindings(). Global and CM-default rows stay read-only (locked)
// — phase 3 is editor-scope only. Re-rendered on every open and after each
// remap (the old dataset.rendered guard is gone — the pane is now stateful).
function renderKeyboardShortcuts() {
  const pane = document.getElementById("settings-pane-keyboard");
  if (!pane) return;
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // split(/-(?!$)/) keeps a trailing "-" key intact (e.g. "Ctrl--").
  const chip = (combo) => combo.split(/-(?!$)/).map(k => `<kbd class="kbd">${esc(k)}</kbd>`).join('<span class="kbd-plus">+</span>');
  const overrides = getSavedKeybindings();
  const hasOverrides = Object.keys(overrides).length > 0;
  let html = '<div class="kb-intro">Click an editor shortcut to remap it. Global and built-in shortcuts are shown for reference.</div>';
  html += `<div class="kb-toolbar"><button class="kb-reset" onclick="resetAllKeybindings()"${hasOverrides ? "" : " disabled"}>Reset all to defaults</button></div>`;
  for (const group of KEYBINDINGS) {
    html += `<div class="kb-group"><div class="kb-cat">${esc(group.cat)}</div>`;
    for (const it of group.items) {
      const remappable = it.scope === "editor" && (it.id in EDITOR_ACTIONS);
      if (remappable) {
        // Display the real binding source (EDITOR_ACTIONS default or override),
        // not KEYBINDINGS.keys — so display can't drift from what actually fires.
        const eff = overrides[it.id] || EDITOR_ACTIONS[it.id].defaultKey;
        const changed = overrides[it.id] ? " kb-changed" : "";
        html += `<div class="kb-row"><span class="kb-label">${esc(it.label)}</span>` +
                `<button type="button" class="kb-remap${changed}" data-id="${it.id}" title="Click to remap">${chip(eff)}</button></div>`;
      } else {
        const keysHtml = it.keys.map(chip).join('<span class="kb-or">or</span>');
        html += `<div class="kb-row"><span class="kb-label">${esc(it.label)}</span>` +
                `<span class="kb-keys kb-locked" title="Not remappable in this version">${keysHtml}</span></div>`;
      }
    }
    html += "</div>";
  }
  pane.innerHTML = html;
  for (const btn of pane.querySelectorAll(".kb-remap")) {
    btn.addEventListener("click", () => _kbBeginCapture(btn));
  }
}

// Apply the current (default + override) editor keymap onto the live editor.
// setOption("extraKeys", …) replaces the whole map, so a removed default key
// stops firing — that's why remap rebuilds the full map rather than layering
// an addKeyMap on top (which couldn't unbind the old default).
function applyEditorKeybindings() {
  CM.setOption("extraKeys", _buildExtraKeys(getSavedKeybindings()));
}

// Normalise a key string to CM's canonical modifier order for conflict
// comparison ("Ctrl-Shift-[" and "Shift-Ctrl-[" are the same binding).
function _kbNorm(key) {
  try { return Object.keys(CM.normalizeKeyMap({ [key]: "x" }))[0]; }
  catch (e) { return key; }
}
// Accept a binding only if it has a real modifier (Ctrl/Alt/Cmd) or is a
// standalone special key — a bare letter would hijack typing in the editor.
const _KB_SPECIALS = new Set(["Tab","Enter","Esc","Backspace","Delete","Insert","Home","End","PageUp","PageDown","Up","Down","Left","Right","F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12"]);
function _kbIsValidBinding(name) {
  if (/(^|-)(Ctrl|Alt|Cmd)-/.test(name)) return true;
  return _KB_SPECIALS.has(name.split(/-(?!$)/).pop());
}

let _kbCapturingId = null;
let _kbCaptureBtn  = null;
function _kbBeginCapture(btn) {
  if (_kbCapturingId) return;                 // one capture at a time
  _kbCapturingId = btn.dataset.id;
  _kbCaptureBtn  = btn;
  btn.classList.add("kb-capturing");
  btn.innerHTML = '<span class="kb-capture-hint">Press keys… (Esc cancels)</span>';
  // Capture phase so this fires before the Settings-modal Esc handler and
  // before CodeMirror; preventDefault stops the keystroke doing its old job
  // while we're recording it.
  document.addEventListener("keydown", _kbCaptureKeydown, true);
}
function _kbEndCapture() {
  document.removeEventListener("keydown", _kbCaptureKeydown, true);
  _kbCapturingId = null;
  _kbCaptureBtn  = null;
  renderKeyboardShortcuts();
}
function _kbCaptureKeydown(e) {
  if (["Control","Shift","Alt","Meta"].includes(e.key)) return; // wait for real key
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") { _kbEndCapture(); return; }
  const name = CM.keyName(e);
  if (!name || !_kbIsValidBinding(name)) {
    _kbFlash("Needs a modifier (Ctrl/Alt) or a special key");
    return;
  }
  const norm = _kbNorm(name);
  const id = _kbCapturingId;
  const overrides = getSavedKeybindings();
  // Conflict 1: same key already bound to a DIFFERENT editor action.
  for (const oid in EDITOR_ACTIONS) {
    if (oid === id) continue;
    if (_kbNorm(overrides[oid] || EDITOR_ACTIONS[oid].defaultKey) === norm) {
      _kbFlash("Already used by another editor shortcut");
      return;
    }
  }
  // Conflict 2: reserved by a global / CM-default shortcut (shown locked).
  for (const g of KEYBINDINGS) for (const it of g.items) {
    if (it.scope === "editor") continue;
    for (const k of it.keys) if (_kbNorm(k) === norm) { _kbFlash("Reserved by: " + it.label); return; }
  }
  // Persist. If the new key equals the default, drop the override so the row
  // reads as unchanged and Reset-all can go fully clean.
  if (_kbNorm(EDITOR_ACTIONS[id].defaultKey) === norm) delete overrides[id];
  else overrides[id] = name;
  localStorage.setItem(_KB_LS_KEY, JSON.stringify(overrides));
  applyEditorKeybindings();
  _kbEndCapture();
}
// Briefly show a rejection reason in the capturing button, then restore prompt.
function _kbFlash(msg) {
  if (_kbCaptureBtn) _kbCaptureBtn.innerHTML = `<span class="kb-capture-hint kb-conflict">${msg}</span>`;
  setTimeout(() => {
    if (_kbCapturingId && _kbCaptureBtn)
      _kbCaptureBtn.innerHTML = '<span class="kb-capture-hint">Press keys… (Esc cancels)</span>';
  }, 1500);
}
export function resetAllKeybindings() {
  localStorage.removeItem(_KB_LS_KEY);
  applyEditorKeybindings();
  renderKeyboardShortcuts();
}

document.addEventListener("click", e => {
  const panel = document.getElementById("settings-panel");
  if (!panel.classList.contains("open")) return;
  if (panel.contains(e.target)) return;
  if (e.target.closest("#settings-btn")) return;
  panel.classList.remove("open");
});

// v5.0.0-beta.2.0 — PANELS lifted to static/panels.js (Phase 2 CM-light split). Loaded via <script defer> after editor.js.
// v5.0.0-beta.2.0 — BIBTOOLS lifted to static/bibtools.js (Phase 2 CM-light split). Loaded via <script defer> after editor.js.
// v5.0.0-beta.3.0 — SPELL CHECK + dict manager lifted to static/spell.js (Phase 3). Shared spell-state (spellChecker/spellEnabled/customDict/_spellHintTimer/…) stays in editor.js core — used by autocomplete + settings + the change handler.

function _fmtAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

export function renderHistoryPanel() {
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
      _ssHistoryActiveIdx((_historyActiveIdx === idx) ? -1 : idx);   // toggle
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

export function clearCompileHistory() {
  if (!confirm("Clear all compile history for this project?")) return;
  const k = _historyKey();
  if (!k) return;
  localStorage.removeItem(k);
  _ssHistoryActiveIdx(-1);
  renderHistoryPanel();
}

// v5.0.0-beta.0.0 — Popover. onOpen resets the keyboard-nav highlight before rendering.
export function toggleHistoryPanel(e){ _togglePopover(e, { panelId: "history-panel", btnId: "history-btn", width: 540, onOpen: () => { _ssHistoryActiveIdx(-1); renderHistoryPanel(); } }); }

// v5.0.0-beta.0.0 — Popover
export function toggleSymbolPanel(e){ _togglePopover(e, { panelId: "symbol-panel", btnId: "sym-toggle-btn", width: 370, onOpen: renderSymbolPanel }); }

// v5.0.0-beta.2.0 — SEARCH lifted to static/search.js (Phase 2 CM-light split). Loaded via <script defer> after editor.js.
// v4.4.0 — PRE-COMPILE SYNTAX LINTER ───────────────────────────────
// Checks for: unmatched {}, \begin/\end mismatches, unclosed $ (inline math).
// Registered as CodeMirror "stex" lint helper; wavy underlines appear without
// running pdflatex. Conservative by design — skips \verb|..| and verbatim envs.
// False-positive risk noted in HANDOFF: \verb|{| is explicitly skipped here.

// v5.0.0-beta.3.0 — SYNTAX LINTER (stex lint helper + gutters/lint setOption) lifted to static/linter.js (Phase 3 CM-heavy split).

// v5.0.0-beta.2.0 — init() relocated to static/boot.js so it runs AFTER the lifted
// Phase 2 modules load (boot.js is the last <script defer>). Keeping init()
// here would call module fns (loadFiles/showPDF/...) before their scripts ran.
