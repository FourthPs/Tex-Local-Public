// static/grammar.js — Grammar mode (v4.4.0): send a paragraph to the grammar
// textarea (QuillBot/Grammarly workflow) and write edits back. Extracted from
// editor.js (2026-07-06, no version bump). EDITOR_ACTIONS calls toggleGrammarMode();
// the out-of-editor Ctrl+Shift+G listener is wired via _initGrammar() (boot.js).
import { CM, closeModal, cmEditor, openModal } from "editor";

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
export function toggleGrammarMode() {
  const modal = document.getElementById("modal-grammar");
  if (modal && modal.classList.contains("open")) closeModal("modal-grammar");
  else openGrammarMode();
}
// CodeMirror's "Shift-Ctrl-G" extraKey handles the open case while the editor
// is focused. This document-level handler covers Ctrl+Shift+G when focus is
// elsewhere (e.g. inside the grammar textarea, to close it) — and bails when
// the editor is focused so the two never double-fire.
// v-refactor 2026-07-06 — Ctrl+Shift+G when focus is outside CM; called by boot.js
export function _initGrammar() {
  document.addEventListener("keydown", e => {
    if (!((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey
          && (e.key === "g" || e.key === "G"))) return;
    if (cmEditor && CM.hasFocus && CM.hasFocus()) return;  // CM keymap handles it
    e.preventDefault();
    toggleGrammarMode();
  });
}
