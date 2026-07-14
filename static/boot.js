// static/boot.js — TexLocal Phase 4 pt2 (v5.0.0-beta.5.0): ESM entry point.
// The ONLY module in a <script type="module"> tag; imports the whole graph.
// 1) namespace-import every module, 2) bridge inline on* handlers onto window,
// 3) run the CM registrations (deferred out of module top-level to dodge the
//    circular-import TDZ on the CM facade), 4) kick off init().
import * as _ed from "editor";
import * as _settings from "settings";
import * as _quickopen from "quickopen";
import * as _grammar from "grammar";
import * as _files from "files";
import * as _pdf from "pdfviewer";
import * as _github from "github";
import * as _panels from "panels";
import * as _bib from "bibtools";
import * as _search from "search";
import * as _errors from "errors";
import * as _linter from "linter";
import * as _autocomplete from "autocomplete";
import * as _synctex from "synctex";
import * as _spell from "spell";
// v5.x — custom dropdown (tl-dd): floating card menu replacing native <select> visuals
import * as _dropdown from "dropdown";

// HTML -> module bridge. Inline on* handlers resolve against window; ES modules
// don't auto-expose top-level decls, so spread each module namespace onto window.
// Only exported names land here; internal helpers stay module-private.
Object.assign(window, _ed, _settings, _quickopen, _grammar, _files, _pdf, _github, _panels, _bib, _search, _errors, _linter, _autocomplete, _synctex, _spell, _dropdown);

// CM registrations — run now that editor.js has fully evaluated (CM + cmEditor
// exist). These were top-level executed statements before the flip; under ESM the
// import graph can evaluate a module before editor.js, so they are deferred here.
_files._initFiles();
_panels._initPanels();
_search._attachKatexHover();
_search._attachKatexCaret(); // v5.7.0p6 — live equation preview at the caret (real_time_plan.md §7.4)
// v-CM6 (Phase 5 inc2) — the CM-heavy features (cross-ref/stex lint, latex+prose
// autocomplete, spell) are NOT ported to CM6 yet. Under the CM6 engine their init
// would attach CM5-only runtime hooks (showHint, cm.state, viewportChange), so
// skip them; CM5 keeps them. These get re-enabled per-module in increments 4-7.
_linter._initLinter(); // v-CM6 inc5 — safe under CM6: registerHelper('lint') writes _helpers.lint.stex; setOption('gutters'/'lint') no-op
_autocomplete._initAutocomplete(); // v-CM6 inc6 — registers _helpers.hint.latex/proseword (read by the CM6 completion sources); its CM.on("keyup") triggers are inert under CM6 (hub never dispatches keyup)
_spell._initSpellCheck(); // v-CM6 inc7 — spell underlines (markText+find) + right-click menu + dict manager; the hub now dispatches viewportChange + scroll

_settings._initSettings();
_quickopen._initQuickOpen(); // 2026-07-06 — Quick Open input handlers
_grammar._initGrammar(); // 2026-07-06 — Grammar Ctrl+Shift+G out-of-editor listener // 2026-07-06 — settings/keymap split; registers the settings outside-click closer

// App startup — sole init() caller.
_ed.init();

// v5.x — enhance the Settings <select>s into card dropdowns. After init() so
// the editor-theme options are populated and initial values are set.
_dropdown._initDropdowns();
