// static/cm6/themes.js — v5.3.0
// ─────────────────────────────────────────────────────────────────────────────
// CM6 editor-theme REGISTRY (pure data, no imports — loads under either engine).
//
// Why this file exists: a color palette is co-designed with its background, so
// each theme bundles chrome (bg/gutter/selection) + syntax tokens and carries an
// intrinsic `appearance` of "light" or "dark". Adding a theme = adding one object
// here; `static/cm6/adapter.js` builds the CM6 EditorView.theme + HighlightStyle
// from it, and `editor.js` builds the Settings dropdown from CM6_THEME_META.
//
// SCOPE (Pol's call, 2026-07-07): these palettes render under CM6 ONLY. CM5 (the
// legacy `?cm=5` engine) keeps its original two looks via editor.css and is NOT
// extended — picking e.g. "Dracula" under CM5 just yields that theme's coarse
// light/dark appearance. The appearance is mirrored onto `data-editor-theme`
// (light|dark) which still drives CM5 + `.spell-error`/`.cm-snippet-placeholder`
// CSS + the PDF "match" mode; the fine theme id lives on `data-editor-scheme`,
// which only the CM6 adapter reads. So NO editor.css changes are needed.
//
// caret/accent stay `var(--accent)` (in the adapter's _themeShared) across ALL
// themes so the app's Appearance accent shows through; only bg/gutter/selection
// and the 7 stex token colors are per-theme here.

// tokens: the 7 stex highlight tags TexLocal colors (keyword=\cmd, tagName=
// \begin/\end, comment=%, string, atom=$math$, namespace=builtin, bracket={}[]).
export const CM6_THEMES = {
  // ── LIGHT ──────────────────────────────────────────────────────────────────
  paper: {
    name: "Paper", appearance: "light",
    chrome: {
      bg: "#ffffff", fg: "#1a1a2e",
      gutterBg: "#f4f5f7", gutterFg: "#a0aab8", gutterBorder: "#dde1ea",
      activeLine: "rgba(var(--accent-rgb),.05)", activeLineGutter: "rgba(var(--accent-rgb),.08)",
      selection: "rgba(var(--accent-rgb),.18)", selectionMatch: "rgba(var(--accent-rgb),.15)",
    },
    tokens: {
      keyword:   { color: "#0057b8", fontWeight: "600" },
      tagName:   { color: "#007a4d", fontWeight: "600" },
      comment:   { color: "#8a9ab0", fontStyle: "italic" },
      string:    { color: "#9c3a00" },
      atom:      { color: "#7b35b8" },
      namespace: { color: "#c07000" },
      bracket:   { color: "#2a7de1" },
    },
  },
  "solarized-light": {
    name: "Solarized Light", appearance: "light",
    chrome: {
      bg: "#fdf6e3", fg: "#657b83",
      gutterBg: "#eee8d5", gutterFg: "#93a1a1", gutterBorder: "#e3ddc9",
      activeLine: "rgba(147,161,161,.12)", activeLineGutter: "rgba(147,161,161,.20)",
      selection: "#e3dcc6", selectionMatch: "#d7d0be",
    },
    tokens: {
      keyword:   { color: "#268bd2", fontWeight: "600" }, // blue
      tagName:   { color: "#859900", fontWeight: "600" }, // green
      comment:   { color: "#93a1a1", fontStyle: "italic" },
      string:    { color: "#2aa198" }, // cyan
      atom:      { color: "#d33682" }, // magenta
      namespace: { color: "#b58900" }, // yellow
      bracket:   { color: "#cb4b16" }, // orange
    },
  },
  "github-light": {
    name: "GitHub Light", appearance: "light",
    chrome: {
      bg: "#ffffff", fg: "#24292f",
      gutterBg: "#f6f8fa", gutterFg: "#b1bac4", gutterBorder: "#e1e4e8",
      activeLine: "rgba(234,238,242,.6)", activeLineGutter: "rgba(234,238,242,.9)",
      selection: "#cce5ff", selectionMatch: "#dbedff",
    },
    tokens: {
      keyword:   { color: "#cf222e", fontWeight: "600" }, // red
      tagName:   { color: "#116329", fontWeight: "600" }, // green
      comment:   { color: "#6e7781", fontStyle: "italic" },
      string:    { color: "#0a3069" }, // navy
      atom:      { color: "#8250df" }, // purple
      namespace: { color: "#953800" }, // orange-brown
      bracket:   { color: "#24292f" },
    },
  },
  // ── DARK ───────────────────────────────────────────────────────────────────
  midnight: {
    name: "Midnight", appearance: "dark",
    chrome: {
      bg: "#161922", fg: "#e2e8f0",
      gutterBg: "#11141b", gutterFg: "#4a5365", gutterBorder: "#1f2330",
      activeLine: "rgba(var(--accent-rgb),.07)", activeLineGutter: "rgba(var(--accent-rgb),.10)",
      selection: "rgba(var(--accent-rgb),.22)", selectionMatch: "rgba(var(--accent-rgb),.18)",
    },
    tokens: {
      keyword:   { color: "#7eb6ff", fontWeight: "600" }, // sky
      tagName:   { color: "#6ee7b7", fontWeight: "600" }, // mint
      comment:   { color: "#6b7585", fontStyle: "italic" },
      string:    { color: "#f4a574" }, // peach
      atom:      { color: "#c8a4ff" }, // lilac
      namespace: { color: "#fbbf24" }, // amber
      bracket:   { color: "#93c5fd" }, // pale
    },
  },
  dracula: {
    name: "Dracula", appearance: "dark",
    chrome: {
      bg: "#282a36", fg: "#f8f8f2",
      gutterBg: "#21222c", gutterFg: "#6272a4", gutterBorder: "#191a21",
      activeLine: "rgba(98,114,164,.15)", activeLineGutter: "rgba(98,114,164,.25)",
      selection: "#44475a", selectionMatch: "#3a3d4d",
    },
    tokens: {
      keyword:   { color: "#ff79c6", fontWeight: "600" }, // pink
      tagName:   { color: "#8be9fd", fontWeight: "600" }, // cyan
      comment:   { color: "#6272a4", fontStyle: "italic" },
      string:    { color: "#f1fa8c" }, // yellow
      atom:      { color: "#bd93f9" }, // purple
      namespace: { color: "#50fa7b" }, // green
      bracket:   { color: "#f8f8f2" },
    },
  },
  "one-dark": {
    name: "One Dark", appearance: "dark",
    chrome: {
      bg: "#282c34", fg: "#abb2bf",
      gutterBg: "#21252b", gutterFg: "#495162", gutterBorder: "#181a1f",
      activeLine: "rgba(153,161,179,.10)", activeLineGutter: "rgba(153,161,179,.18)",
      selection: "#3e4451", selectionMatch: "#343a45",
    },
    tokens: {
      keyword:   { color: "#c678dd", fontWeight: "600" }, // purple
      tagName:   { color: "#e06c75", fontWeight: "600" }, // red
      comment:   { color: "#7f848e", fontStyle: "italic" },
      string:    { color: "#98c379" }, // green
      atom:      { color: "#d19a66" }, // orange
      namespace: { color: "#56b6c2" }, // cyan
      bracket:   { color: "#abb2bf" },
    },
  },
};

// Ordered list for the Settings dropdown (grouped by appearance). Keep the two
// originals first in each group so upgrading users find their old look on top.
export const CM6_THEME_META = [
  { id: "paper",           name: "Paper",           appearance: "light" },
  { id: "solarized-light", name: "Solarized Light", appearance: "light" },
  { id: "github-light",    name: "GitHub Light",    appearance: "light" },
  { id: "midnight",        name: "Midnight",        appearance: "dark"  },
  { id: "dracula",         name: "Dracula",         appearance: "dark"  },
  { id: "one-dark",        name: "One Dark",        appearance: "dark"  },
];

// appearance ("light"|"dark") for a theme id; unknown → "light" (paper-safe).
export function cm6ThemeAppearance(id) {
  return (CM6_THEMES[id] || CM6_THEMES.paper).appearance;
}

// v5.4.0 — the editor background color for a theme id; used by the PDF preview
// "match" mode to tint the viewer desk (area around the page) to the same color
// as the editor background (e.g. Solarized Light's cream). Unknown → paper white.
export function cm6ThemeBg(id) {
  return (CM6_THEMES[id] || CM6_THEMES.paper).chrome.bg;
}
