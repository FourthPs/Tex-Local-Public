import { closeSettingsPanel } from "settings";
import { CM, _ssCustomDict, _ssCustomDictMtime, _ssSpellChecker, _ssSpellEnabled, _ssSpellLoadingPromise, _ssSpellMarkers, _ssSpellScanTimer, _ssSpellSuggestEnabled, currentProject, customDict, customDictMtime, spellChecker, spellEnabled, spellLoadingPromise, spellMarkers, spellScanTimer, spellSuggestEnabled } from "editor";

// static/spell.js — TexLocal Phase 3 module split (v5.0.0-beta.3.0)
// English spell check (Typo.js, token-aware markText) + spell-suggest worker + right-click context menu + custom-dictionary manager. Shared toggle-state (spellChecker/spellEnabled/customDict/_spellHintTimer/…) intentionally left in editor.js core.
// Interim shared-scope: a classic <script defer>, NOT an ES module — shares
// editor.js's global scope (module-level state + CM adapter facade + core
// state/helpers). Loads AFTER editor.js core and BEFORE boot.js. CM access is
// via the CM.* facade only (Phase 1 containment) — 0 raw cmEditor./CodeMirror.

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

export async function _ensureSpellDict() {
  // Dedup concurrent loads — toggle-on while loading shouldn't kick off two.
  if (spellChecker) return spellChecker;
  if (spellLoadingPromise) return spellLoadingPromise;
  const status = document.getElementById("spell-status");
  if (status) { status.textContent = "Loading dictionary…"; status.classList.add("visible"); }
  const _slp = (async () => {
    if (typeof Typo === "undefined") {
      // CDN failed (offline?) — surface the failure once and don't retry.
      if (status) { status.textContent = "Spell dict failed to load"; setTimeout(() => status.classList.remove("visible"), 3000); }
      console.error("[spellcheck] Typo.js global missing — CDN blocked?");
      return null;
    }
    try {
      const base = "/static/vendor/typo/dictionaries/en_US";
      const [aff, dic] = await Promise.all([
        fetch(base + "/en_US.aff").then(r => r.ok ? r.text() : Promise.reject(r.status)),
        fetch(base + "/en_US.dic").then(r => r.ok ? r.text() : Promise.reject(r.status)),
      ]);
      // platform "any" forces Typo to use the in-memory dict args (not try to
      // fetch them itself — which would fail because Typo guesses a relative
      // path that doesn't match jsdelivr's layout).
      _ssSpellChecker(new Typo("en_US", aff, dic, { platform: "any" }));
      if (status) { status.textContent = "Dictionary loaded"; setTimeout(() => status.classList.remove("visible"), 1500); }
      return spellChecker;
    } catch (e) {
      if (status) { status.textContent = "Spell dict failed to load"; setTimeout(() => status.classList.remove("visible"), 3000); }
      console.error("[spellcheck] dict load failed:", e);
      return null;
    } finally {
      _ssSpellLoadingPromise(null);
    }
  })();
  _ssSpellLoadingPromise(_slp);
  return spellLoadingPromise;
}

export async function loadCustomDict(projectName) {
  _ssCustomDict(new Set());
  _ssCustomDictMtime(0);
  if (!projectName) return;
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectName)}/dict`);
    if (!res.ok) return;
    const data = await res.json();
    (data.words || []).forEach(w => customDict.add(String(w).toLowerCase()));
    // v3.3.5 — Cache mtime for hot-reload comparison. Missing/zero means the
    // file doesn't exist yet; next focus tick will see a non-zero mtime if
    // the user creates it externally.
    _ssCustomDictMtime(Number(data.mtime) || 0);
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
    _ssCustomDict(new Set());
    (data.words || []).forEach(w => customDict.add(String(w).toLowerCase()));
    _ssCustomDictMtime(newMtime);
    if (spellChecker) scheduleSpellCheck(30);
  } catch (_) { /* network blip; try again on next focus */ }
}
// Wire the focus listener once at script load.
window.addEventListener("focus", _maybeReloadDictOnFocus);

function _clearSpellMarkers() {
  for (const m of spellMarkers) {
    try { m.clear(); } catch (_) {}
  }
  _ssSpellMarkers([]);
}

export function _buildSkipMask(text) {
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
    const marker = CM.markText(
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
  try { return CM.getLine(line) || ""; } catch (_) { return ""; }
}

// v4.4.0 — The red wavy underline now shows whenever EITHER spell check OR
// "Suggest corrections while typing" is on. Both use the same dictionary and
// the same _spellCheckLine pass, so seeing which word is wrong (underline) and
// getting corrections for it (dropdown / right-click) are two halves of one
// feature. False until the dict has actually loaded.
function _spellHighlightOn() {
  return (spellEnabled || spellSuggestEnabled) && !!spellChecker;
}

export function _runSpellCheck() {
  if (!_spellHighlightOn()) return;
  _clearSpellMarkers();
  // Scope: only the visible viewport ± a 50-line buffer. For a 2000-line
  // chapter this is ~100 lines of work — fast, and the user can't see beyond
  // the viewport anyway. Buffer makes scrolling feel "always already checked".
  const vp = CM.getViewport();
  const total = CM.lineCount();
  const from = Math.max(0, vp.from - 50);
  const to   = Math.min(total, vp.to   + 50);
  CM.operation(() => {
    for (let i = from; i < to; i++) _spellCheckLine(i);
  });
}

let _spellViewportTimer = null;
export function scheduleSpellCheck(delay) {
  clearTimeout(spellScanTimer);
  _ssSpellScanTimer(setTimeout(_runSpellCheck, typeof delay === "number" ? delay : 600));
}

export function onSpellCheckToggle() {
  const cb = document.getElementById("spellcheck-toggle");
  _ssSpellEnabled(cb.checked);
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
export function onSpellSuggestToggle() {
  const cb = document.getElementById("spell-suggest-toggle");
  _ssSpellSuggestEnabled(cb ? cb.checked : true);
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
export function _initSpellCheck() {
  const saved = localStorage.getItem("texlocal_spellcheck") === "1";
  _ssSpellEnabled(saved);
  // v4.6.0 — inline suggestions default OFF (absent key → off); explicit "1" on.
  _ssSpellSuggestEnabled(localStorage.getItem("texlocal_spellsuggest") === "1");
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
  CM.on("viewportChange", () => {
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
  // "Replace with X" via CM.replaceRange().
  CM.getWrapperElement().addEventListener("contextmenu", (evt) => {
    if ((!spellEnabled && !spellSuggestEnabled) || !spellMarkers.length) return;
    const pos = CM.coordsChar({ left: evt.clientX, top: evt.clientY });
    if (!pos) return;
    for (const m of spellMarkers) {
      const range = m.find();
      if (!range) continue;
      const inLine = pos.line === range.from.line && pos.line === range.to.line;
      if (!inLine) continue;
      if (pos.ch < range.from.ch || pos.ch > range.to.ch) continue;
      const word = CM.getRange(range.from, range.to);
      if (!word) continue;
      evt.preventDefault();
      _showSpellContextMenu(word, range, evt.clientX, evt.clientY);
      return;
    }
  });
}

// v3.3.3 — context menu state. _currentMenuWord lets onAddToDictClick know
// which word to POST without having to re-resolve from the DOM.
// v3.3.4 — _currentMenuRange lets onReplaceClick swap the word in place via
// CM.replaceRange(). The range comes from the spellMarker we matched
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
export const _suggestCache = new Map();

// v4.4.0 — Spell suggest Web Worker (Blob URL).
// Runs Typo.suggest() off the main thread so right-click never freezes UI.
// Worker loads its own copy of Typo.js + en_US dict (~1.7MB extra memory,
// acceptable for a single-user local app).
const _SUGGEST_WORKER_SRC = `
importScripts('${location.origin}/static/vendor/typo/typo.js');
let _wTypo = null;
let _wLoading = null;
function _wLoadDict() {
  if (_wTypo) return Promise.resolve(_wTypo);
  if (_wLoading) return _wLoading;
  const base = '${location.origin}/static/vendor/typo/dictionaries/en_US';
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
    CM.on("scroll", _hideSpellContextMenu);
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
    // v4.7.0 — restore the v4.4.0 Web Worker path. The v4.6.0 rebuild regressed
    // this to a synchronous spellChecker.suggest(), which blocks the main thread
    // ~50-250ms and makes the right-click menu stutter. _suggestAsync runs
    // Typo.suggest() off-thread; falls back to empty if the worker is unavailable.
    _suggestAsync(word).then(suggestions => {
      _suggestCache.set(cacheKey, suggestions);
      _injectSuggestions(suggestions);
    });
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
  CM.off("scroll", _hideSpellContextMenu);
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
  CM.replaceRange(suggestion, range.from, range.to);
  // Place the cursor after the inserted text and refocus the editor so the
  // user can keep typing without an extra click.
  CM.focus();
  // Re-scan: the new word may itself be flagged (unlikely from a dict
  // suggestion, but cheap), and the original marker needs to clear.
  scheduleSpellCheck(30);
  _hideSpellContextMenu();
}

export async function onAddToDictClick() {
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

export async function openDictManager() {
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
    _ssCustomDictMtime(Number(data.mtime) || 0);
    _renderDictMgrList("");
  } catch (e) {
    list.innerHTML = `<div class="dm-empty show">Network error: ${e.message}</div>`;
  }
}

export function closeDictManager() {
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

export function onDictMgrFilterInput() {
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
