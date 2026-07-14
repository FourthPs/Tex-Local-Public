// static/cm6/adapter.js — Phase 5 increment 1 (2026-07-03)
// CM6-backed implementation of the `CM` facade shape that editor.js Phase 1
// established. The public surface here MUST match the 37-member CM5 facade in
// editor.js so the CM-light modules (files/pdfviewer/github/panels/bibtools/
// search) and most of the heavy modules keep working unchanged when the engine
// flips to CM6.
//
// NOT WIRED IN YET. index.html/boot.js still boot CM5. This file is imported by
// nothing until Phase 5 increment 2 adds the engine switch. Kept as new,
// side-effect-free code so the live editor is untouched (parent-plan §8:
// "every landed state must leave a working editor").
//
// Keystone design (see PHASE5_cm6-migration_2026-07-03.md): the facade keeps
// CM5-shaped positions — {line, ch} with 0-BASED lines — at every boundary, and
// converts to/from CM6 integer offsets internally. CM6's doc.line(n) is 1-based.

import {
  EditorState, StateField, StateEffect, Compartment, RangeSet, Prec,
  EditorView, Decoration, keymap, lineNumbers, drawSelection,
  highlightActiveLine, highlightActiveLineGutter, gutter, GutterMarker,
  rectangularSelection, crosshairCursor,
  history, historyKeymap, defaultKeymap, indentWithTab,
  StreamLanguage, indentUnit, foldGutter, codeFolding, foldService, syntaxHighlighting, HighlightStyle,
  stex, closeBrackets, closeBracketsKeymap,
  toggleFold, search, openSearchPanel, findNext, findPrevious, highlightSelectionMatches,
  linter, lintGutter,
  autocompletion, completionKeymap, startCompletion, acceptCompletion,
  tags as t,
} from "cm6"; // bare specifier → static/vendor/cm6/cm6.bundle.js via import map (added in increment 2)
import { CM6_THEMES } from "cm6-themes"; // v5.3.0 — registry of named CM6 themes (pure data)

// ── position conversion (the keystone) ───────────────────────────────
// CM5 {line(0-based), ch} ↔ CM6 offset. `st` is an EditorState.
function _posToOffset(st, pos) {
  if (pos == null) return undefined;
  if (typeof pos === "number") return pos;            // tolerate raw offsets
  const lines = st.doc.lines;
  const lineNo = Math.min(Math.max((pos.line | 0) + 1, 1), lines); // 1-based, clamped
  const line = st.doc.line(lineNo);
  const ch = Math.min(Math.max(pos.ch | 0, 0), line.length);
  return line.from + ch;
}
function _offsetToPos(st, off) {
  const o = Math.min(Math.max(off | 0, 0), st.doc.length);
  const line = st.doc.lineAt(o);
  return { line: line.number - 1, ch: o - line.from };
}

// ── generic decoration StateField for markText + line classes ────────
// One field holds all app-added inline marks + line decorations, keyed by a
// numeric handle so markText()'s returned {clear()} can remove exactly its own.
let _handleSeq = 1;
const addMarkEff   = StateEffect.define();  // {id, from, to, deco}
const addLineEff   = StateEffect.define();  // {id, pos, deco}
const clearEff     = StateEffect.define();  // {id}  — remove one handle
const clearGroupEff = StateEffect.define(); // {group} — remove all in a group

const _decoField = StateField.define({
  create() { return Decoration.none; },
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addMarkEff)) {
        set = set.update({ add: [e.value.deco.range(e.value.from, e.value.to)] });
      } else if (e.is(addLineEff)) {
        set = set.update({ add: [e.value.deco.range(e.value.pos)] });
      } else if (e.is(clearEff)) {
        const id = e.value.id;
        set = set.update({ filter: (f, to, deco) => deco.spec._hid !== id });
      } else if (e.is(clearGroupEff)) {
        const g = e.value.group;
        set = set.update({ filter: (f, to, deco) => deco.spec._group !== g });
      }
    }
    return set;
  },
  provide: f => EditorView.decorations.from(f),
});

// ── zero-width position trackers (snippet placeholders) ──────────────
// CM6 Decoration.mark forbids empty ranges, but the snippet engine needs
// zero-width markers for `${1}`/`${0}` slots. Track them as position pairs that
// map across edits via tr.changes.mapPos (assoc from inclusiveLeft/Right).
const addPointEff = StateEffect.define(); // {id, from, to, fromAssoc, toAssoc, group}
const _pointField = StateField.define({
  create() { return []; },
  update(pts, tr) {
    if (!tr.docChanged && tr.effects.length === 0) return pts;
    let next = tr.docChanged
      ? pts.map(p => ({ ...p, from: tr.changes.mapPos(p.from, p.fromAssoc), to: tr.changes.mapPos(p.to, p.toAssoc) }))
      : pts.slice();
    for (const e of tr.effects) {
      if (e.is(addPointEff)) next.push(e.value);
      else if (e.is(clearEff)) next = next.filter(p => p.id !== e.value.id);
      else if (e.is(clearGroupEff)) next = next.filter(p => p.group !== e.value.group);
    }
    return next;
  },
});

// ── gutter markers (compile-error gutter etc.) ───────────────────────
// Keyed by gutter id → a StateField<RangeSet<GutterMarker>>. Increment 4
// (errors.js) fleshes this out; the field + effects exist now so setGutterMarker
// / clearGutter on the facade are non-throwing from the start.
class _ElMarker extends GutterMarker {
  constructor(el) { super(); this._el = el; }
  toDOM() { return this._el; }
}
const setGutterEff   = StateEffect.define(); // {gid, from, marker}
const clearGutterEff = StateEffect.define(); // {gid}
// v-CM6 inc4 — real error gutter. errors.js uses a single gutter id
// "cm-errors-gutter" (from the CM5 gutters list). One StateField holds its
// RangeSet<GutterMarker>: setGutterMarker adds a marker at a line; a null marker
// removes the one at that line (CM5 setGutterMarker(line,id,null)); clearGutter
// empties the set. The gutter() extension renders it left of the content.
const _errGutterField = StateField.define({
  create() { return RangeSet.empty; },
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setGutterEff) && e.value.gid === "cm-errors-gutter") {
        if (e.value.marker) set = set.update({ add: [e.value.marker.range(e.value.from)], sort: true });
        else set = set.update({ filter: (from) => from !== e.value.from });
      } else if (e.is(clearGutterEff) && e.value.gid === "cm-errors-gutter") {
        set = RangeSet.empty;
      }
    }
    return set;
  },
});
const _errGutter = gutter({
  class: "cm-errors-gutter",
  markers: (view) => view.state.field(_errGutterField),
});

// v-CM6 inc5 — stex syntax linter. CM5 registered a lint helper
// (`registerHelper('lint','stex', fn)`) that returns CM5 annotations
// {from:{line,ch}, to:{line,ch}, message, severity}. CM6 uses linter() returning
// Diagnostic[] with integer offsets. This bridge reads the same registry entry
// (_helpers.lint.stex, populated by linter.js's _initLinter) and converts. The
// underlines + hover panel + lintGutter() squiggles are CM6-native.
const _stexLinter = linter((view) => {
  const fn = _helpers.lint.stex;
  if (!fn) return [];
  let anns;
  try { anns = fn(view.state.doc.toString()) || []; }
  catch (e) { console.error("[cm6] stex lint error", e); return []; }
  const st = view.state;
  const out = [];
  for (const a of anns) {
    const from = _posToOffset(st, a.from);
    let to = _posToOffset(st, a.to);
    if (to < from) to = from;
    out.push({ from, to,
      severity: a.severity === "error" ? "error" : a.severity === "warning" ? "warning" : "info",
      message: a.message || "" });
  }
  return out;
}, { delay: 600 });

// ── event dispatch (on/off) via a single updateListener ──────────────
function _makeEventHub() {
  const listeners = { change: new Set(), cursorActivity: new Set() };
  const ext = EditorView.updateListener.of(u => {
    if (u.docChanged) listeners.change.forEach(cb => cb(_hubView, u));
    if (u.selectionSet || u.docChanged) listeners.cursorActivity.forEach(cb => cb(_hubView, u));
    // v-CM6 inc7 — spell.js re-scans on "viewportChange" (scroll/fold/resize).
    if (u.viewportChanged && listeners.viewportChange) listeners.viewportChange.forEach(cb => cb(_hubView, u));
  });
  let _hubView = null;
  return {
    ext,
    bind(v) {
      _hubView = v;
      // v-CM6 inc7 — CM5 "scroll" event (spell context menu hides on scroll).
      v.scrollDOM.addEventListener("scroll", () => { if (listeners.scroll) listeners.scroll.forEach(cb => cb(_hubView)); });
    },
    on(ev, cb)  { (listeners[ev] || (listeners[ev] = new Set())).add(cb); },
    off(ev, cb) { listeners[ev] && listeners[ev].delete(cb); },
  };
}

// ── registerHelper registry (fold / hint / lint) ─────────────────────
// CM6 has no global helper registry. The facade keeps existing
// CM.registerHelper("fold"|"hint"|"lint", name, fn) calls working by storing the
// fn here; the corresponding CM6 extension (foldService / completion source /
// linter) reads from this registry. Wired per-type in later increments.
const _helpers = { fold: {}, hint: {}, lint: {} };

// ── LaTeX token highlight — light + dark, matching CM5's stex token colors
// (editor.css `.cm-s-default .cm-*` + its `[data-editor-theme="dark"]` set).
// CM6 needs explicit HighlightStyles; CM5 shipped default token CSS.
// v5.3.0 — built from a theme registry entry's `tokens` (see cm6/themes.js).
// Each token def is a CM6 style spec ({color, fontWeight?, fontStyle?}) keyed by
// the 7 stex tags TexLocal colors; spread straight onto the tag row.
function _mkHighlightFrom(tk) {
  return HighlightStyle.define([
    { tag: t.keyword,   ...tk.keyword },   // \commands
    { tag: t.tagName,   ...tk.tagName },   // \begin \end
    { tag: t.comment,   ...tk.comment },   // %
    { tag: t.string,    ...tk.string },
    { tag: t.atom,      ...tk.atom },      // $math$
    { tag: t.namespace, ...tk.namespace }, // builtin
    { tag: t.bracket,   ...tk.bracket },   // {} []
  ]);
}

// ── CM6 editor theme — light + dark, mirroring editor.css's `.CodeMirror-*`
// rules (which target CM5's DOM and never reach CM6's `.cm-*`). Native CM6
// chrome (autocomplete/lint/search/fold/scrollbar) is styled with CSS vars so it
// follows the app UI theme automatically; the hardcoded hex (bg/gutter/tokens)
// differs per data-editor-theme and is swapped via the compartment + observer.
const _themeShared = {
  ".cm-content": {
    // v-CM6 vp.3 — font-size lives on `&` (.cm-editor), NOT here. setFontSize()
    // sets an inline font-size on .cm-editor; a rule on .cm-content would beat
    // that inline value (explicit rule > inheritance), pinning CM6 to 13.5px and
    // ignoring the user's saved size → CM6 looked "zoomed out" vs CM5. Inheriting
    // lets the inline value win exactly like CM5's .CodeMirror.
    fontFamily: "var(--font-code)", lineHeight: "1.7",
    caretColor: "var(--accent)",
    // v-CM6 vp.2 — padding lives on .cm-content, NOT .cm-scroller. Padding the
    // scroller (a flex row of gutters+content) insets the gutter too, so the
    // grey line-number strip no longer sat flush to the editor's top-left and
    // wrapped lines looked oddly indented. CM6 keeps gutter numbers aligned with
    // padded content, so this matches CM5 (flush gutter + 8px text inset).
    padding: "8px 8px 8px 6px",
  },
  ".cm-scroller": {
    // v5.0.2 — cursor:text over the editor area. CM5's editor.css gave `.CodeMirror`
    // an I-beam; under CM6 that rule doesn't reach `.cm-*`, so the editor showed the
    // default arrow. Set it on the scroller so the whole code area reads as editable
    // (the fold-gutter overrides back to `pointer` on its own elements).
    overflow: "auto", fontFamily: "var(--font-code)", lineHeight: "1.7", cursor: "text",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  // v-CM6 vp.4 — tighten the gutter toward CM5: CM6's default line-number padding
  // + fold column are wider, so the grey strip looked too broad and pushed text
  // right. Trim both → narrower band, text nearer the left edge.
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 2px 0 6px" },
  ".cm-foldGutter": { width: "12px" },
  ".cm-foldGutter .cm-gutterElement": { color: "var(--muted)", cursor: "pointer", padding: "0 1px", fontSize: "11px" },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--panel)", border: "1px solid var(--border)",
    color: "var(--muted)", borderRadius: "4px", padding: "0 4px", margin: "0 2px",
  },
  // native autocomplete dropdown  ≈  CM5 .CodeMirror-hints
  ".cm-tooltip": {
    border: "1px solid var(--border)", borderRadius: "6px",
    backgroundColor: "var(--surface)", color: "var(--text)",
    boxShadow: "0 4px 16px rgba(0,0,0,.4)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-code)", fontSize: "12px", maxHeight: "16em",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "4px 12px", color: "var(--text)" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--accent)", color: "#fff" },
  ".cm-completionInfo": {
    border: "1px solid var(--border)", borderRadius: "6px",
    backgroundColor: "var(--surface)", color: "var(--text)",
    padding: "6px 10px", fontFamily: "var(--font-code)", fontSize: "11px",
  },
  // lint hover tooltip  ≈  CM5 .cm-marker-tooltip
  ".cm-diagnostic": { fontFamily: "var(--font-code)", fontSize: "11px", padding: "4px 8px" },
  ".cm-diagnostic-error": { borderLeft: "3px solid #e53e3e" },
  ".cm-diagnostic-warning": { borderLeft: "3px solid #d97706" },
  // search panel  ≈  CM5 .CodeMirror-dialog
  ".cm-panels": { backgroundColor: "var(--surface)", color: "var(--text)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panel.cm-search": { padding: "6px 12px", fontFamily: "var(--font-ui)", fontSize: "12px" },
  ".cm-panel.cm-search input": {
    backgroundColor: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)",
    borderRadius: "4px", padding: "3px 8px", fontFamily: "var(--font-code)", fontSize: "12px",
  },
  ".cm-panel.cm-search input, .cm-panel.cm-search .cm-textfield": {
    backgroundColor: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)",
    borderRadius: "4px", padding: "3px 8px", fontFamily: "var(--font-code)", fontSize: "12px",
    outline: "none",
  },
  ".cm-panel.cm-search input:focus, .cm-panel.cm-search .cm-textfield:focus": { borderColor: "var(--accent)" },
  ".cm-panel.cm-search button, .cm-panel.cm-search .cm-button": {
    backgroundColor: "var(--panel)", backgroundImage: "none",
    border: "1px solid var(--border)", color: "var(--text)", borderRadius: "4px",
    padding: "2px 8px", fontFamily: "var(--font-ui)", fontSize: "11px", cursor: "pointer",
  },
  ".cm-panel.cm-search button:hover, .cm-panel.cm-search .cm-button:hover": { borderColor: "var(--accent)", color: "var(--accent)" },
  ".cm-panel.cm-search label": { fontSize: "11px", color: "var(--muted)", display: "inline-flex", alignItems: "center", gap: "3px" },
  ".cm-panel.cm-search [name=close]": {
    color: "var(--muted)", fontSize: "16px", lineHeight: "1", padding: "0 6px",
    border: "none", background: "none", cursor: "pointer",
  },
  ".cm-panel.cm-search [name=close]:hover": { color: "var(--text)", background: "none" },
  ".cm-scroller::-webkit-scrollbar": { width: "10px", height: "10px" },
  ".cm-scroller::-webkit-scrollbar-thumb": { backgroundColor: "var(--border)", borderRadius: "5px" },
};
// v5.3.0 — built from a registry entry's `chrome` (bg/gutter/activeLine/selection).
// `_themeShared` (theme-independent, var(--…)-driven chrome + caret=accent) is
// merged in for every theme; only these hardcoded surfaces vary per theme.
function _mkThemeFrom(c, dark) {
  const specific = {
    "&": { height: "100%", backgroundColor: c.bg, color: c.fg, fontSize: "13.5px" },
    ".cm-gutters": { backgroundColor: c.gutterBg, color: c.gutterFg, border: "none", borderRight: "1px solid " + c.gutterBorder },
    ".cm-lineNumbers .cm-gutterElement": { color: c.gutterFg },
    ".cm-activeLine": { backgroundColor: c.activeLine },
    ".cm-activeLineGutter": { backgroundColor: c.activeLineGutter, color: "var(--accent)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: c.selection },
    ".cm-selectionMatch": { backgroundColor: c.selectionMatch },
  };
  return EditorView.theme(Object.assign({}, _themeShared, specific), { dark });
}

// v5.3.0 — the fine theme id lives on <html data-editor-scheme>; only the CM6
// adapter reads it. Fall back to the coarse data-editor-theme (light|dark) so a
// first paint before the scheme attr is set, or an old install, still resolves.
function _currentSchemeId() {
  if (typeof document === "undefined" || !document.documentElement) return "paper";
  const s = document.documentElement.getAttribute("data-editor-scheme");
  if (s && CM6_THEMES[s]) return s;
  return document.documentElement.getAttribute("data-editor-theme") === "dark" ? "midnight" : "paper";
}

// Built themes memoized per id (rebuilding the EditorView.theme + HighlightStyle
// on every toggle is wasteful; the color data is static).
const _themeCache = {};
function _buildTheme(id) {
  const th = CM6_THEMES[id] || CM6_THEMES.paper;
  if (!_themeCache[id]) {
    _themeCache[id] = [ _mkThemeFrom(th.chrome, th.appearance === "dark"), syntaxHighlighting(_mkHighlightFrom(th.tokens)) ];
  }
  return _themeCache[id];
}

// One MutationObserver watches <html data-editor-theme> and live-reconfigures the
// active editor's theme compartment. CM5 did this with a CSS attribute selector;
// CM6's JS theme can't cascade off an ancestor attr, so we reconfigure instead.
let _activeView = null, _activeThemeComp = null, _themeObserver = null;
function _ensureThemeObserver() {
  if (_themeObserver || typeof MutationObserver === "undefined" || typeof document === "undefined") return;
  _themeObserver = new MutationObserver(() => {
    if (_activeView && _activeThemeComp)
      _activeView.dispatch({ effects: _activeThemeComp.reconfigure(_buildTheme(_currentSchemeId())) });
  });
  // v5.3.0 — watch the fine scheme id (primary) + the coarse light/dark attr (so
  // a bare setEditorTheme still repaints CM6). Either change reconfigures.
  _themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-editor-scheme", "data-editor-theme"] });
}

// ── the facade factory ───────────────────────────────────────────────
// Returns an object matching the CM5 facade's member shape, bound to `view`.
function makeCM(view, comps, hub) {
  const st = () => view.state;
  const CM = {
    // text / document
    getValue:          () => st().doc.toString(),
    setValue:          (s) => view.dispatch({ changes: { from: 0, to: st().doc.length, insert: s ?? "" } }),
    getLine:           (n) => (n >= 0 && n < st().doc.lines ? st().doc.line(n + 1).text : ""),
    lineCount:         () => st().doc.lines,
    lastLine:          () => st().doc.lines - 1,
    getRange:          (a, b) => st().sliceDoc(_posToOffset(st(), a), _posToOffset(st(), b)),
    replaceRange:      (text, a, b) => view.dispatch({
                          changes: { from: _posToOffset(st(), a), to: b != null ? _posToOffset(st(), b) : _posToOffset(st(), a), insert: text },
                        }),
    replaceSelection:  (text) => view.dispatch(st().replaceSelection(text)),
    getSelection:      () => { const s = st().selection.main; return st().sliceDoc(s.from, s.to); },
    somethingSelected: () => !st().selection.main.empty,
    eachLine:          (f) => { const d = st().doc; for (let i = 1; i <= d.lines; i++) { const l = d.line(i); f({ text: l.text, lineNo: () => i - 1 }); } },
    // cursor / selection / scroll / coords
    getCursor:         (which) => {
                          const s = st().selection.main;
                          const off = which === "anchor" ? s.anchor : which === "from" ? s.from : which === "to" ? s.to : s.head;
                          return _offsetToPos(st(), off);
                        },
    setCursor:         (a, b) => view.dispatch({ selection: { anchor: _posToOffset(st(), (typeof a === "number") ? { line: a, ch: b || 0 } : a) } }), // v-CM6 inc4 — accept CM5 (line,ch) form too
    setSelection:      (anchor, head) => view.dispatch({ selection: { anchor: _posToOffset(st(), anchor), head: _posToOffset(st(), head != null ? head : anchor) } }), // v-CM6 inc8 — snippet placeholder select
    scrollIntoView:    (pos, margin) => view.dispatch({ effects: EditorView.scrollIntoView(_posToOffset(st(), pos), { y: "center", yMargin: (typeof margin === "number") ? margin : 0 }) }),
    coordsChar:        (c) => { const off = view.posAtCoords({ x: c.left, y: c.top }); return off == null ? { line: 0, ch: 0 } : _offsetToPos(st(), off); },
    cursorCoords:      (where, _mode) => { // v5.7.0p6 — caret overlay anchor; CM6 coordsAtPos returns client coords = CM5 mode "window"
                          const s = st().selection.main;
                          const off = (where == null || where === true) ? s.head : where === false ? s.anchor : _posToOffset(st(), where);
                          const r = view.coordsAtPos(off);
                          return r ? { left: r.left, top: r.top, bottom: r.bottom } : null;
                        },
    getViewport:       () => { const v = view.viewport; return { from: st().doc.lineAt(v.from).number - 1, to: st().doc.lineAt(v.to).number - 1 }; },
    // focus / DOM
    focus:             () => view.focus(),
    hasFocus:          () => view.hasFocus,
    getWrapperElement: () => view.dom,
    refresh:           () => view.requestMeasure(),
    // marks / line classes / gutters  → decoration effects
    markText:          (a, b, opts = {}) => {
                          const id = _handleSeq++;
                          const group = opts._group;
                          const fromOff = _posToOffset(st(), a);
                          const toOff   = _posToOffset(st(), b);
                          if (fromOff === toOff) {
                            // zero-width tracker (snippet ${1}/${0}) — CM6 marks forbid empty ranges.
                            view.dispatch({ effects: addPointEff.of({ id, group,
                              from: fromOff, to: toOff,
                              fromAssoc: opts.inclusiveLeft ? -1 : 1,
                              toAssoc:   opts.inclusiveRight ? 1 : -1 }) });
                          } else {
                            const attrs = Object.assign({}, opts.attributes || {}); // spell.js passes {attributes:{title}}
                            if (opts.title && !attrs.title) attrs.title = opts.title;
                            const spec = { class: opts.className || "", attributes: attrs, _hid: id, _group: group };
                            if (opts.inclusiveLeft  != null) spec.inclusiveStart = opts.inclusiveLeft;
                            if (opts.inclusiveRight != null) spec.inclusiveEnd   = opts.inclusiveRight;
                            view.dispatch({ effects: addMarkEff.of({ id, from: fromOff, to: toOff, deco: Decoration.mark(spec) }) });
                          }
                          // CM5 marks expose .find() → current {from,to}. Non-zero marks live in
                          // _decoField; zero-width in _pointField. Both map across edits.
                          const find = () => {
                            const set = view.state.field(_decoField);
                            const cur = set.iter();
                            while (cur.value) {
                              if (cur.value.spec._hid === id) return { from: _offsetToPos(view.state, cur.from), to: _offsetToPos(view.state, cur.to) };
                              cur.next();
                            }
                            for (const pt of view.state.field(_pointField)) {
                              if (pt.id === id) return { from: _offsetToPos(view.state, pt.from), to: _offsetToPos(view.state, pt.to) };
                            }
                            return null;
                          };
                          return { clear: () => view.dispatch({ effects: clearEff.of({ id }) }), find, id };
                        },
    addLineClass:      (n, _where, cls) => {
                          const id = _handleSeq++;
                          const pos = st().doc.line(Math.min(Math.max(n + 1, 1), st().doc.lines)).from;
                          const deco = Decoration.line({ class: cls, _hid: id, _group: "line:" + cls });
                          view.dispatch({ effects: addLineEff.of({ id, pos, deco }) });
                          return { id };
                        },
    removeLineClass:   (_n, _where, cls) => view.dispatch({ effects: clearGroupEff.of({ group: "line:" + cls }) }),
    setGutterMarker:   (n, gid, el) => view.dispatch({ effects: setGutterEff.of({ gid, from: st().doc.line(n + 1).from, marker: el ? new _ElMarker(el) : null }) }),
    clearGutter:       (gid) => view.dispatch({ effects: clearGutterEff.of({ gid }) }),
    // config / events / batching / history
    setOption:         (k, v) => _setOption(view, comps, k, v),
    getOption:         (name) => (name === "indentWithTabs") ? false : ((name === "indentUnit" || name === "tabSize") ? (st().tabSize || 2) : undefined), // v-CM6 inc6 — used by env-block insert
    showHint:          () => startCompletion(view),  // v-CM6 inc6 — CM5 showHint(opts) → CM6 startCompletion (sources drive; opts ignored)
    on:                (ev, cb) => hub.on(ev, cb),
    off:               (ev, cb) => hub.off(ev, cb),
    operation:         (f) => f(),                 // CM6 batches natively via transactions
    clearHistory:      () => view.dispatch({ effects: comps.history.reconfigure(history()) }),
    changeGeneration:  () => _changeGen,           // monotonic; bumped by updateListener below
    // statics
    registerHelper:    (type, name, fn) => { (_helpers[type] || (_helpers[type] = {}))[name] = fn; },
    Pos:               (line, ch) => ({ line, ch }),
    normalizeKeyMap:   (m) => m,                    // keybinding rework handled in increment 3
    keyName:           () => "",                    // ditto
    get helpers() { return _helpers; },
    get hint()    { return _hintNamespace; },       // populated by autocomplete increment
  };
  return CM;
}

// Placeholder hint namespace; autocomplete.js increment sets .latex/.proseword.
const _hintNamespace = {};

// v-CM6 inc6 — autocomplete. Reuse the CM5 hint helpers verbatim: call each with
// the bound facade as `cm`, then convert the CM5 result {list,from,to} into a CM6
// CompletionResult. `_activeCM` is set in createCm6Editor (one editor per app).
let _activeCM = null;
function _hintItemToCompletion(item, cm) {
  if (typeof item === "string") return { label: item };
  const label = item.displayText || item.text || "";
  const c = { label };
  if (item.meta)  c.detail = item.meta;   // author/year or file:line → dim detail
  if (item.title) c.info   = item.title;  // paper title → side tooltip
  if (typeof item.hint === "function") {
    // custom CM5 apply fn (env block / \cmd{} braces). CM6 calls apply(view,comp,
    // from,to); rebuild the CM5 `data`={from,to} it expects and let it self-edit.
    c.apply = (v, comp, from, to) => {
      const s = v.state;
      item.hint(cm, { from: _offsetToPos(s, from), to: _offsetToPos(s, to) });
    };
  } else if (item.text != null && item.text !== label) {
    c.apply = item.text;
  }
  return c;
}
function _cm6HintSource(name) {
  return (context) => {
    const fn = _helpers.hint[name];
    if (!fn || !_activeCM) return null;
    let res;
    try { res = fn(_activeCM); } catch (e) { console.error("[cm6] hint " + name, e); return null; }
    if (!res || !res.list || !res.list.length) return null;
    const s = context.state;
    return {
      from: _posToOffset(s, res.from),
      to:   _posToOffset(s, res.to),
      options: res.list.map(it => _hintItemToCompletion(it, _activeCM)),
      filter: false, // CM5 helper already filtered (incl. cite title-match); source re-runs per keystroke
    };
  };
}
const _cm6Autocomplete = autocompletion({
  override: [_cm6HintSource("latex"), _cm6HintSource("proseword")],
  activateOnTyping: true,
  icons: false,
});

// monotonic doc-change counter for changeGeneration()
let _changeGen = 0;

// setOption(k,v) → reconfigure the matching Compartment. Unknown keys no-op
// (with a console note) rather than throw, so a stray CM5 option can't crash.
// ── CM5 extraKeys → CM6 keymap translation (increment 3) ─────────────
// A minimal cm-like passed to CM5-style handlers that expect a `cm` arg. Only
// the members the editor.js EDITOR_ACTIONS handlers actually touch are provided
// (getCursor + foldCode); the rest go unused by those handlers.
function _cmProxy(view) {
  // Snippet + fold key handlers need the full editing surface; delegate to the
  // bound facade (_activeCM) and add the CM5-only cm.foldCode the fold keys call.
  const base = _activeCM || {
    getCursor: (which) => {
      const s = view.state.selection.main;
      const off = which === "anchor" ? s.anchor : which === "from" ? s.from : which === "to" ? s.to : s.head;
      return _offsetToPos(view.state, off);
    },
    getValue: () => view.state.doc.toString(),
  };
  return Object.assign(Object.create(base), { foldCode: () => toggleFold(view) });
}
// CM5 key string → CM6 key string. The difference that bites: a bare capital
// letter in CM6 implies Shift ("Ctrl-F" = Ctrl+Shift+f), but CM5 "Ctrl-F" =
// Ctrl+f. Lowercase the final single-letter token to preserve intent.
function _cm5KeyToCm6(k) {
  const parts = k.split("-");
  const last = parts[parts.length - 1];
  if (last.length === 1 && /[A-Za-z]/.test(last)) parts[parts.length - 1] = last.toLowerCase();
  return parts.join("-");
}
// Resolve a CM5 extraKeys value (function OR CM5 command string) to a CM6
// run(view)=>bool. Unknown strings → null (binding skipped).
function _cm6RunFor(handler) {
  if (typeof handler === "function") {
    return (v) => { try { handler(_cmProxy(v)); } catch (e) { console.error("[cm6] key handler error", e); } return true; };
  }
  switch (handler) {
    case "find": case "findPersistent": case "replace": return (v) => { openSearchPanel(v); return true; };
    case "findNext": return (v) => { findNext(v); return true; };
    case "findPrev": case "findPrevious": return (v) => { findPrevious(v); return true; };
    default: return null;
  }
}
// Build a CM6 keymap from a CM5 extraKeys map + swap it into comps.appKeys. Tab
// is skipped so CM6's default indent stays (snippets, which owned Tab in CM5,
// aren't ported yet).
function _applyExtraKeys(view, comps, map) {
  const bindings = [];
  for (const k in map) {
    // Tab IS wired now (snippet handler); acceptCompletion binds Tab at higher
    // precedence (Prec.highest below) so completion-accept still wins.
    const run = _cm6RunFor(map[k]);
    if (!run) continue;
    bindings.push({ key: _cm5KeyToCm6(k), run, preventDefault: true });
  }
  view.dispatch({ effects: comps.appKeys.reconfigure(keymap.of(bindings)) });
}

function _setOption(view, comps, k, v) {
  switch (k) {
    case "tabSize":
      view.dispatch({ effects: [
        comps.tab.reconfigure(EditorState.tabSize.of(v)),
        comps.indent.reconfigure(indentUnit.of(" ".repeat(v))),
      ]});
      break;
    case "lineWrapping":
      view.dispatch({ effects: comps.wrap.reconfigure(v ? EditorView.lineWrapping : []) });
      break;
    case "readOnly":
      view.dispatch({ effects: comps.readOnly.reconfigure(EditorState.readOnly.of(!!v)) });
      break;
    case "extraKeys":
      _applyExtraKeys(view, comps, v || {});  // increment 3 — CM5 keymap → CM6 appKeys
      break;
    case "theme": case "gutters": case "lint": case "mode":
      // theme = CSS-attribute driven in TexLocal; gutters/lint/mode = extensions. No-op.
      break;
    default:
      console.debug("[cm6] setOption unmapped:", k);
  }
}

// ── editor construction ──────────────────────────────────────────────
// Mirrors the CM5 `cmEditor = CodeMirror(host, {...})` init. Returns {view, CM}.
// Heavy-feature extensions (real fold ranges, lint, autocomplete, spell,
// gutters) are added by their own increments; increment 1 stands up a
// functional core editor only.
export function createCm6Editor(host, { value = "", tabSize = 2, lineWrapping = true } = {}) {
  const comps = {
    tab: new Compartment(), indent: new Compartment(), wrap: new Compartment(),
    readOnly: new Compartment(), appKeys: new Compartment(), history: new Compartment(),
    theme: new Compartment(),
  };
  const hub = _makeEventHub();

  // fold ranges read from the registry (registerHelper("fold","latex-section")).
  const _foldFromRegistry = foldService.of((state, lineStart, lineEnd) => {
    const fn = _helpers.fold["latex-section"];
    if (!fn) return null;
    // Adapt CM6 (state, lineStart, lineEnd) → the CM5 helper's (cm-like, {line,ch}).
    const cmLike = {
      getLine: (n) => (n >= 0 && n < state.doc.lines ? state.doc.line(n + 1).text : ""),
      lastLine: () => state.doc.lines - 1,
    };
    const startLine = state.doc.lineAt(lineStart).number - 1;
    const r = fn(cmLike, { line: startLine, ch: 0 });
    if (!r) return null;
    const from = state.doc.line(r.from.line + 1).from + r.from.ch;
    const to   = state.doc.line(r.to.line + 1).from + r.to.ch;
    return to > from ? { from, to } : null;
  });

  const state = EditorState.create({
    doc: value,
    extensions: [
      lineNumbers(),
      highlightActiveLine(), highlightActiveLineGutter(),
      drawSelection(),
      // v5.0.0-beta.8.0 — multi-cursor (free in CM6): Alt-click adds cursors, Alt-drag
      // makes a rectangular/column selection; crosshair cursor while Alt held.
      EditorState.allowMultipleSelections.of(true),
      rectangularSelection(),
      crosshairCursor(),
      history(),
      closeBrackets(),
      StreamLanguage.define(stex),
      codeFolding(), foldGutter(), _foldFromRegistry,
      search({ top: true }), highlightSelectionMatches(), // increment 3 — CM6 native find/replace panel
      _decoField, _pointField,  // v-CM6 inc8 — _pointField tracks zero-width snippet slots
      _errGutterField, _errGutter,  // v-CM6 inc4 — compile-error gutter markers
      _stexLinter, lintGutter(),  // v-CM6 inc5 — stex syntax lint (underlines + gutter)
      _cm6Autocomplete,  // v-CM6 inc6 — cite/ref/env/cmd + prose completion
      comps.tab.of(EditorState.tabSize.of(tabSize)),
      comps.indent.of(indentUnit.of(" ".repeat(tabSize))),
      comps.wrap.of(lineWrapping ? EditorView.lineWrapping : []),
      comps.readOnly.of(EditorState.readOnly.of(false)),
      comps.theme.of(_buildTheme(_currentSchemeId())), // v5.3.0 — named editor theme (registry) + token highlight
      // v-CM6 inc8 — Tab accepts completion FIRST (higher precedence than the
      // appKeys snippet-Tab below); if no completion is active it returns false
      // and Tab falls through to the snippet handler in appKeys.
      Prec.highest(keymap.of([{ key: "Tab", run: acceptCompletion }])),
      comps.appKeys.of([]), // app/editor keybindings incl. snippet Tab (increment 3/8)
      keymap.of([...closeBracketsKeymap, ...completionKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
      hub.ext,
      EditorView.updateListener.of(u => { if (u.docChanged) _changeGen++; }),
    ],
  });

  const view = new EditorView({ state, parent: host });
  // v-CM6 vp — track active view + theme compartment so the data-editor-theme
  // observer can live-reconfigure light/dark (see _ensureThemeObserver above).
  _activeView = view; _activeThemeComp = comps.theme; _ensureThemeObserver();
  hub.bind(view);
  const CM = makeCM(view, comps, hub);
  _activeCM = CM; // v-CM6 inc6 — completion sources call this bound facade
  return { view, CM };
}

// Exported for tests / later increments that need the registry or converters.
export { _posToOffset, _offsetToPos, _helpers, _cm6HintSource, _hintItemToCompletion };
