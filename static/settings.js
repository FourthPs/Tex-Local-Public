// static/settings.js — Settings panel + engine info + keyboard cheat-sheet/remap.
// Extracted from editor.js (2026-07-06, no version bump). ESM module; imports shared
// state/facade from editor. Cycle editor<->settings is runtime-only (safe): editor calls
// applyEditorKeybindings() inside init(); settings reads editor bindings in user handlers.
import {
  CM, CM6_ENGINE, EDITOR_ACTIONS, _KB_LS_KEY, _buildExtraKeys,
  _closeOtherToolbarPanels, autoCompile, compile, currentProject,
  draftMode, escapeHtml, getSavedKeybindings, spellEnabled,
  liveDebounceMs, liveDraftOn,  // v5.7.0p4 — Live mode settings sync
} from "editor";

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
// v5.0.2 — non-editor libraries surfaced in Settings ▸ Engine. Static versions
// (vendored; change only on a bundle rebuild). Typo.js has no semver (old hunspell
// port) so it shows its kind instead of a number.
const LIB_PACKAGES = [
  ["pdf.js", "3.11.174"],
  ["KaTeX", "0.16.9"],
  ["Typo.js", "hunspell"],
];
let _toolchainCache = null;   // v5.0.2 — /api/toolchain result, fetched once per page

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
  const libRows = LIB_PACKAGES.map(([n, v]) =>
    `<div class="engine-pkg"><span class="engine-pkg-name">${n}</span><span class="engine-pkg-ver">${v}</span></div>`).join("");
  pane.innerHTML =
    `<div class="engine-hero">` +
      `<span class="engine-badge ${cm6 ? "is-cm6" : "is-cm5"}">${cm6 ? "CM6" : "CM5"}</span>` +
      `<div class="engine-hero-txt"><div class="engine-hero-name">${engineName}</div>` +
        `<div class="engine-hero-note">${engineNote}</div></div>` +
    `</div>` +
    `<div class="engine-sec-title">Editor packages</div>` +
    `<div class="engine-pkg-list">${rows}</div>` +
    `<div class="engine-sec-title">Rendering &amp; libraries</div>` +
    `<div class="engine-pkg-list">${libRows}</div>` +
    `<div class="engine-sec-title">LaTeX toolchain</div>` +
    `<div class="engine-pkg-list" id="engine-toolchain">` +
      `<div class="engine-pkg"><span class="engine-pkg-name" style="color:var(--muted)">Detecting…</span></div></div>`;
  _loadToolchainInfo();
}

// v5.0.2 — fill the "LaTeX toolchain" section from /api/toolchain (MiKTeX version +
// available compilers + bundled/system). Async because it shells out to pdflatex on
// the backend; cached per page so re-opening the tab doesn't re-probe.
async function _loadToolchainInfo() {
  const el = document.getElementById("engine-toolchain");
  if (!el) return;
  try {
    if (!_toolchainCache) _toolchainCache = await (await fetch("/api/toolchain")).json();
    const t = _toolchainCache || {};
    const avail = Object.entries(t.compilers || {}).filter(([, v]) => v).map(([k]) => k);
    const rows = [];
    if (t.miktex) rows.push(["MiKTeX", `${t.miktex} · ${t.bundled ? "bundled" : "system"}`]);
    rows.push(["Compilers", avail.length ? avail.join(", ") : "none found"]);
    if (t.engine_line) rows.push(["TeX engine", t.engine_line]);
    if (!t.miktex && !t.engine_line && !avail.length) {
      el.innerHTML = `<div class="engine-pkg"><span class="engine-pkg-name" style="color:var(--muted)">MiKTeX not detected on this machine</span></div>`;
      return;
    }
    el.innerHTML = rows.map(([n, v]) =>
      `<div class="engine-pkg"><span class="engine-pkg-name">${escapeHtml(n)}</span><span class="engine-pkg-ver">${escapeHtml(String(v))}</span></div>`).join("");
  } catch (e) {
    el.innerHTML = `<div class="engine-pkg"><span class="engine-pkg-name" style="color:var(--muted)">toolchain lookup failed</span></div>`;
  }
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
  // v5.3.0 — sync editor-theme dropdown to the current scheme (the old Light/Dark
  // buttons were replaced by a named-preset <select>; referencing the removed
  // button ids here was throwing and blocking the whole Settings panel from opening).
  const _themeSel = document.getElementById("editor-theme-select");
  if (_themeSel) {
    const curScheme = document.documentElement.getAttribute("data-editor-scheme")
      || (document.documentElement.getAttribute("data-editor-theme") === "dark" ? "midnight" : "paper");
    if (_themeSel.value !== curScheme) _themeSel.value = curScheme;
  }
  document.getElementById("auto-compile-toggle").checked = autoCompile;
  document.getElementById("draft-mode-toggle").checked   = draftMode;
  // v5.7.0p4 — sync Live mode knobs to current state
  const ldInp = document.getElementById("live-debounce-input");
  if (ldInp) ldInp.value = liveDebounceMs;
  const ldCb = document.getElementById("live-draft-toggle");
  if (ldCb) ldCb.checked = liveDraftOn;
  // v3.3.2 — sync spell check toggle to current state (may have been changed
  // programmatically since the popup was last opened).
  const spCb = document.getElementById("spellcheck-toggle");
  if (spCb) spCb.checked = spellEnabled;
  // v5.6.0 — sync the "Export STATS.md" toggle (global pref, default on).
  const esCb = document.getElementById("export-stats-toggle");
  if (esCb) esCb.checked = localStorage.getItem("texlocal_export_stats") !== "0";
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
export function applyEditorKeybindings() {
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

// v-refactor 2026-07-06 — outside-click closer; called by boot.js after editor.js eval
export function _initSettings() {
  document.addEventListener("click", e => {
    const panel = document.getElementById("settings-panel");
    if (!panel.classList.contains("open")) return;
    if (panel.contains(e.target)) return;
    if (e.target.closest("#settings-btn")) return;
    panel.classList.remove("open");
  });
}
