# Changelog

All notable changes to TexLocal are documented here.

---

## v4.3.0 — 2026-05-31

### Editor & UI
- Split the monolithic editor file into `static/editor.css` and `static/editor.js` — no user-visible change, but makes the codebase easier to maintain and extend

### Desktop installer
- Installer now bundles `static/editor.css` and `static/editor.js` correctly alongside the HTML templates

---

## v4.2.4 — 2026-05-31

### Desktop app
- "Check for updates" in the About modal now shows a specific reason when the check fails (no releases yet, rate limit, network error) instead of a generic failure message
- Added a fallback "Open releases page" link so you can always get to the download page manually

---

## v4.2.3 — 2026-05-31

### Desktop app
- Added an **About** modal (accessible from the dashboard) showing the current version, repo link, and a "Check for updates" button
- Current version number is now displayed in the dashboard header

---

## v4.2.2 — 2026-05-31

### Editor & UI
- Editor toolbar now scrolls horizontally when buttons overflow the available width — no more hidden buttons on narrow windows or smaller screens

---

## v4.2.1 — 2026-05-31

### Editor & UI
- **Template chooser redesign** — the New Project modal now shows visual card-style options with SVG preview icons (Article, Beamer, Thesis, Blank) instead of a plain radio list; cards highlight on selection and adapt to light/dark theme automatically

---

## v4.2.0 — 2026-05-20

### Desktop app
- **Auto-update banner** — the dashboard checks GitHub Releases on launch and shows a banner with a one-click update flow when a newer version is available
- Update progress is shown in a modal; the app restarts automatically after the installer finishes
- Version is now a single constant (`TEXLOCAL_VERSION`) used by both the UI banner and the update check — no more version string drift

---

## v4.1.6 — 2026-05-20

### Desktop app
- Stable installer release after a round of build fixes (v4.1.0–v4.1.5)
- Added **Debug Mode** shortcut in the Start Menu — generates a diagnostic log useful for reporting compile issues on new machines
- Installer now handles closing and restarting TexLocal automatically during updates

---

## v4.1.0 — 2026-05-20

### Desktop app
- **MiKTeX bundled in the installer** — no separate LaTeX install required on the end user's machine; MiKTeX portable is extracted and injected into PATH at launch
- Installer is per-user (no admin rights required) and includes WebView2 runtime detection

---

## v4.0.0 — 2026-05-20

### Desktop app
- **Standalone Windows desktop app** — TexLocal now ships as `TexLocal.exe` built with PyInstaller and wrapped in a native PyWebView window; no Python or Flask install required to run
- Inno Setup installer (`TexLocal-Setup-X.Y.Z.exe`) with Start Menu shortcuts, uninstaller, and per-user install path

---

## v3.3.2 — 2026-05-12

### Editing
- **Spell check** — English spell checking with red wavy underlines, right-click suggestions ("Did you mean…?"), and an "Add to dictionary" option; per-project custom dictionary stored in `.texlocal-dict.txt`
- **Error grouping** — repeated LaTeX errors/warnings from the same root cause are collapsed into a single card with an occurrence count badge; expand to see all instances

---

## v3.3.0 — 2026-05-12

### Editing
- **Snippet library** — tab-expandable snippets with `${1}` / `${2}` placeholder navigation; ships with built-in LaTeX snippets and supports per-project custom snippets via `.texlocal-snippets.json`
- **Compile stats tooltip** — hover over the compile button after a successful build to see page count, word count estimate, and compile time
- **Missing-package detection** — the error panel now identifies `! LaTeX Error: File '…' not found` errors and highlights them with a dedicated badge and install hint

---

## v3.3.3 / v3.3.2 (dict patch) — 2026-05-12

### Editing
- Custom dictionary words can now be added directly from the editor (right-click → "Add to dictionary") without editing `.texlocal-dict.txt` manually

---

## v3.2.3 — 2026-05-12

### Editing
- **Cross-reference linter** — undefined `\ref{}` and `\cite{}` targets are underlined in the editor with a wavy marker; updates automatically after each compile
- **Quick Open** (`Ctrl+P`) — fuzzy file switcher across all files in the current project
- **Compile history** — recent compile results are stored per project; click any entry to review its log
- **Section folding** — collapse and expand LaTeX sections with `Ctrl+Shift+[` / `Ctrl+Shift+]`
- **Writing goals** — set a word count goal per project; live progress bar in the goals panel
- **Horizontal resize handle** between the file tree and outline panel

### PDF
- Page number input syncs with scroll position via IntersectionObserver
- PDF outline panel

---

## v3.2.2 — 2026-05-12

### Editing
- **Citation autocomplete** — `\cite{}` completion now shows author, year, and title in a two-row hint; fuzzy-matched against `.bib` keys
- **Project-wide Find & Replace** — replace a string across all `.tex` files in the project at once
- **TODO scanner** — collects `\todo{}` markers and `% TODO / FIXME / XXX` comments into a panel with jump-to-line

### Compiling
- BibTeX / Biber auto-detection and multi-pass compile

---

## v3.x and earlier

Core editor, PDF preview, SyncTeX forward/backward search, multi-file project support, draft mode, `\includeonly` support, light/dark themes, ZIP import/export, image viewer, auto-save, and drag-and-drop file upload.
