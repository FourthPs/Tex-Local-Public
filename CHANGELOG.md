# Changelog

All notable changes to TexLocal are documented here.

---

## v6.0.1 — 2026-07-20

### Smaller, lighter install
- The installer and installed app are now much smaller — roughly 80 MB of unused Qt graphics libraries that were being bundled by accident have been removed. Nothing changes in how TexLocal looks or works; it just downloads faster and takes far less disk space.

### Fixes
- The compile error panel now points to the correct **source file** (not just the line number) for errors like "Undefined control sequence", even when your project sits in a deeply nested folder. Previously a long project path could make the error jump land on the wrong file.

## v6.0.0 — 2026-07-18

### The complete move to CodeMirror 6
- TexLocal now runs on a single, modern editor engine. Multi-cursor editing (Alt-click / Alt-drag column select), smoother performance on long chapters, and stronger Thai + English mixed-input handling are now the standard experience.
- The retired legacy editor engine and its assets were removed — the app is lighter and loads less on every start.
- Fixed: the highlighted row in citation autocomplete shows its text in white again (it could be unreadable on some themes).

### GitHub backup — validated end to end and hardened
- Sign-in now uses TexLocal's own verified GitHub app.
- Fixed a hang where the app kept waiting even after GitHub showed "your device is now connected" — sign-in polling is now sequential and respects GitHub's pacing hints.
- Sync status now correctly says both sides changed when GitHub is ahead *and* you have unsaved local changes, instead of claiming only GitHub changed.
- The full backup cycle (create private repo, push, pull, conflict handling, sign-out) has been validated live against real repositories.

### Under the hood
- The whole backend was restructured into a proper Python package with modular routes. No visible change today — it makes future features faster and safer to build.

## v5.8.7 — 2026-07-17

### Improvements
- Compile diagnostics are now remembered separately for each project during the current Editor session. Switching back to a project restores its latest Raw Log, warning/error badge, and parsed diagnostics without automatically reopening a panel.

### Fixes
- Switching projects no longer carries the previous project's Raw Log or Error/Logs state into the newly opened project.
- A late bibliography-audit response from an old project can no longer overwrite the current project's log, badge, or Bibliography panel.
- The project picker now displays the active project immediately when entering the Editor instead of temporarily remaining on “Select project”.

## v5.8.6 — 2026-07-17

### New
- **Choose where a new project is saved.** The New Project dialog is now a cleaner two-step flow — pick a template, then name the project and choose its folder. Projects can be stored outside the default TexLocal projects folder.
- **Move a project to another folder.** A new folder action on each dashboard project relocates its files to a folder you pick, with a safe verified move (nothing is deleted until the copy is confirmed).
- **`minted` support.** Syntax-highlighted code via the `minted` package now works out of the box with the bundled MiKTeX.
- **Export the raw compile log** to a file from the Compile Log panel.

### Improvements
- Dashboard dialogs (rename, duplicate, delete, and error messages) now use TexLocal's own themed dialogs instead of browser pop-ups.
- The Error/Logs panel now surfaces the **real fatal engine error** (for example a missing font or file) instead of only the downstream citation warnings, and reconstructs long messages that TeX wraps across several lines.
- Smarter bibliography detection: a commented-out `\addbibresource` no longer overrides your active bibliography.
- Dashboard actions stay inside the frame even with long project names; the web view shows the Move action (disabled) with a note that relocation is Desktop-only.

### Fixes
- **Desktop app:** bundled MiKTeX fonts now resolve correctly after installation, and a one-time font-database refresh after an install or upgrade means fresh projects no longer need a second Compile to get fonts and citations right. This clears the spurious font errors and "all citations undefined" that could appear on a freshly installed app.
- A single Full Compile now leaves the Error Panel at the final resolved citation/reference state; warnings from earlier internal passes remain available only in Raw Log.

## v5.8.5 — 2026-07-16

### Fixes
- Clicking an error or warning in the Logs panel now jumps to the **correct file and line** — including errors inside `\input`-ed chapters and undefined-citation/reference warnings, which previously landed in whatever file was open. Error markers now follow you to the right file as you switch.
- Undefined-citation messages are grouped by citation key and point back to your actual `\cite`, telling you clearly whether the key is missing from your `.bib` or just needs a Full Compile. Repeated log noise no longer creates duplicate cards.
- Live preview no longer shows valid citations and references as `[?]` — it reuses the last full compile's bibliography data (newly added cites still need one Full Compile to appear).
- The line-number gutter no longer briefly blanks out when jumping to an error.

### Reliability
- A failed compile now stops immediately instead of running extra passes, so errors surface faster.
- A broken or half-written PDF is never shown: the last good PDF is kept and restored if a compile is interrupted or runs out of memory.
- Switching projects while a compile is running no longer mixes state between projects.

## v5.8.4 — 2026-07-14

### Fixes
- A successful compile shows the refreshed PDF immediately, even if the Logs panel was open; success with warnings keeps the warning badge and parsed logs available.

### Improvements
- Settings > Compile groups the Live mode options under a labelled "Live mode" section with a short description.

## v5.8.3 — 2026-07-13

### Fixes
- The Logs panel tabs (All / Errors / Warnings / Info) and its close button work again.
- The error panel gained a compact **View PDF** / **View previous PDF** action to return to the rendered PDF without losing error and warning details.

## v5.8.2 — 2026-07-13

### New
- Compile can be cancelled: the Compile button becomes **Cancel** while a compile is running, for both manual and Live compiles.

### Security
- GitHub sign-in tokens are now stored encrypted with Windows DPAPI (never plaintext) and migrate automatically from the old format. Tokens are no longer visible to other processes during Git operations.

## v5.8.1 — 2026-07-13

### Security & reliability
- Auto-update downloads are verified end to end: the installer must match the SHA256 digest published with the GitHub release, and incomplete or tampered downloads are rejected. The check runs again right before the installer launches.
- Compile results are truthful: a failed run can no longer present an older PDF as if it were the new output.
- Backing up when GitHub has newer changes now explains the situation and points to **Get GitHub changes**; pull conflicts list the affected files and guide you to resolve them first.
- Fixes for very fast project switching (PDF, outline, and main-file detection can no longer mix projects).

## v5.8.0 — 2026-07-13

### New
- **GitHub backup, end to end.** Back up your project to a private GitHub repository in one click — create the repository from inside TexLocal, push updates with an optional note, and pull changes back down with **Get GitHub changes**. Sign in via GitHub device login or an existing gh CLI session; sign out works for both.

### Improvements
- The Backup dialog speaks plain language, shows one **Connected repository** card once linked, opens instantly on reopen, and hides Git plumbing unless something fails.
- The dashboard's Import-from-GitHub repository list uses the same styled dropdown as the rest of the app.

## v5.7.2 — 2026-07-12

### Fixes
- Two small polish fixes following the v5.7.1 reliability round.

## v5.7.1 — 2026-07-12

### Fixes
- Reliability round: fixed a potential loss of unsaved edits when switching projects at the wrong moment, made compile status truthful after failures, and hardened the app against several async races and an XSS vector.

## v5.7.0 — 2026-07-10

### New
- **Live mode — real-time preview.** A new Live button in the toolbar compiles the chapter you're editing as you type and refreshes the PDF seamlessly (no flash, scroll position kept). Previews never overwrite your full PDF. Fine-tune debounce and draft figures under Settings > Compile.
- Instant math preview at the caret (KaTeX) while Live mode is on, plus live-aware SyncTeX jumps.

### Improvements
- **Faster full compiles:** the LaTeX engine reruns only while something still needs resolving (references, citations), cutting typical builds roughly in half.

## v5.6.0 — 2026-07-07

### Improvements
- The STATS.md project summary in exported ZIPs is now optional (Settings toggle, on by default).

## v5.5.0 — 2026-07-07

### Improvements
- "Theme accent" is now **Accent color**, and all dropdown menus use a consistent custom style with keyboard navigation.

## v5.4.0 — 2026-07-07

### Improvements
- The PDF preview desk can tint itself to **match** your editor theme background.

## v5.3.0 — 2026-07-07

### New
- Named editor themes: pick an editor color scheme from Settings, independent of the app's dark/light mode.

## v5.2.0 — 2026-07-07

### Improvements
- The PDF preview theme is now independent from the editor theme.

## v5.1.1 — 2026-07-06

### Fixes
- Hardening round plus fixes to the STATS.md statistics.

## v5.1.0 — 2026-07-06

### New
- Exported ZIPs include a STATS.md summary: word counts, citations, figures, equations, and a bibliography cross-check.

## v5.0.5 — 2026-07-06

### Improvements
- Web mode now runs on a friendly named URL (`texlocal.localhost:52839`) and listens on both IPv4 and IPv6 loopback.

## v5.0.4 — 2026-07-06

### Fixes
- Web mode opens `127.0.0.1` directly, fixing sluggish first loads in some browsers.

## v5.0.3 — 2026-07-06

### Fixes
- Clicking between files in the file tree is snappier: unedited files no longer trigger a redundant save.

## v5.0.2 — 2026-07-06

### Improvements
- The editor loads faster in the browser (web mode) — assets are now served in parallel, and the projects page preloads the heaviest ones.
- Settings ▸ Engine now lists the full stack: editor packages, rendering libraries (pdf.js, KaTeX, Typo.js), and your LaTeX toolchain (MiKTeX version + available compilers).

### Fixes
- The mouse pointer over the code area shows a text cursor again instead of an arrow.

## v5.0.1 — 2026-07-06

### Fixes
- A failed save no longer silently produces a mismatched PDF. If a file can't be saved, TexLocal now shows a "Save failed" warning and stops the compile instead of building from older content. Closing a tab whose save failed also keeps your unsaved text so you can retry.
- Project names are validated properly: invalid names (Windows reserved names like `CON`/`NUL`, trailing dots or spaces, and characters like `< > : " | ? *`) are now rejected with a clear message instead of an obscure error.
- Fixed file, compile, and preview actions for projects whose names contain spaces or special characters.
- File, folder, and project names are now safely escaped in the interface.

## v5.0.0 — 2026-07-05

Migrated the code editor from CodeMirror 5 to CodeMirror 6.

- Adds multi-cursor editing (Alt-click / Alt-drag) and smoother handling of large documents.
- The editor keeps the same look as before; the previous engine stays available via `?cm=5`.

## v4.10.0 — 2026-07-02

Milestone installer release — the first download since v4.7.10 — packaging all of the v4.8 and v4.9 improvements listed below into one build. No new changes of its own.

## v4.9.10 — 2026-07-02

### Fixes
- Compile errors that carry a full Windows path now link to the correct file and line.

## v4.9.9 — 2026-07-02

### Fixes
- List items whose path or citation key contains an apostrophe now click through correctly (e.g. a `\label{eq:d'alembert}` in the Bibliography panel).

## v4.9.8 — 2026-07-02

### Fixes
- "Back up to GitHub" no longer fails when only the git e-mail address is unset.

## v4.9.7 — 2026-07-02

### Fixes
- Live citation warnings now recognize all biblatex commands (`\parencite`, `\autocite`, `\textcite`, …), matching the Bibliography panel.

## v4.9.6 — 2026-07-02

### Speed
- The bibliography check no longer runs twice on every compile — less overhead on large projects.

## v4.9.5 — 2026-07-02

### Speed
- Faster compiles on documents without a bibliography: an unnecessary BibTeX pass is now skipped.

## v4.9.4 — 2026-07-02

### Fixes
- Replace All and the bibliography clean-up no longer silently revert their change in the file you currently have open.

## v4.9.3 — 2026-07-02

### Fixes
- Editor tabs no longer spill over into the PDF preview when enough files are open to overflow the tab row.

## v4.9.2 — 2026-07-02

### Bibliography
- Unused `.bib` entries can be cleaned up with one click — "comment out" (fully reversible; your `.bib` is backed up first), individually or all at once.

## v4.9.1 — 2026-07-02

### Bibliography
- A one-line citation-health summary now appears in the compile log after every build.

## v4.9.0 — 2026-07-02

### Bibliography (new)
- A new Bibliography panel cross-checks your `\cite` commands against your `.bib` files and flags citations with no matching entry, duplicate keys, and entries that are never cited — each issue links straight to the file and line.

## v4.8.2 — 2026-07-02

### Keyboard
- Editor keyboard shortcuts can now be remapped to keys you prefer (Settings → Keyboard).

## v4.8.1 — 2026-07-02

### Keyboard
- New keyboard-shortcut cheat-sheet in Settings → Keyboard.

## v4.8.0 — 2026-07-02

### Settings
- Settings has been reworked into a cleaner centered window with tabs: Appearance, Compile, Editor, and Keyboard.

## v4.7.10 — 2026-07-01

### Fixes
- **Outline & search jump to the exact line.** Clicking an entry in the document outline or a project-search result now lands the cursor right on the target heading/match (line numbering is now consistent across the app).
- **Clearer GitHub errors.** "Back up to GitHub" now reports immediately if Git isn't installed instead of failing later with a confusing message, and the import dialog tells "couldn't reach GitHub" apart from "no repositories" rather than showing an empty list.
- **Reverse SyncTeX on non-English paths.** Clicking in the PDF to jump back to the source no longer errors on projects whose file paths contain non-ASCII characters (e.g. Thai folder names).
- **Faster compiles on large projects.** Removed redundant file scans before each compile — noticeable on multi-chapter theses.

## v4.7.9 — 2026-06-07

### Appearance
- **New: switchable Cerulean theme.** Pick between the original Default look and a new Cerulean color scheme from Settings → Appearance — independent of your light/dark editor theme.

## v4.7.8 — 2026-06-07

### Appearance
- Introduced a new Cerulean accent color across buttons, links, and highlights. (Made switchable in v4.7.9 — see above.)

## v4.7.7 — 2026-06-07

### Appearance
- Updated the app icon and favicon to a new Cerulean blue. (Reverted in v4.7.9 — the icon is back to the original blue.)

## v4.7.6 — 2026-06-05

### Desktop
- **Fixed: PDF Download and Export ZIP didn't work in the desktop app.** Both buttons now save correctly via a native Save dialog. (Browser mode was never affected.)

---

## v4.7.5 — 2026-06-04

### Under the hood
- Internal code cleanup (de-duplicated file scanning, removed unused code). No change to how the app behaves.

## v4.7.4 — 2026-06-04

### Editor
- Projects open faster — especially ones you've opened before.

## v4.7.3 — 2026-06-04

### Fixes
- Switching to another project (from the dropdown or the Projects list) now always opens a file — your last-edited one, at your last cursor position — instead of sometimes leaving the editor blank.
- After updating the app, the newest version now loads reliably.

## v4.7.2 — 2026-06-04

### Editor
- **Cleaner toolbar icons** — every button in the editor toolbar, PDF viewer, settings panel, and dashboard now uses a proper icon instead of emoji or plain symbols. The toolbar looks consistent across all operating systems and themes.

---

## v4.7.1 — 2026-06-02

### Desktop
- **Your settings now stick between sessions.** The desktop app remembers the compiler you pick per project (pdflatex / xelatex / lualatex), your theme, font size, last open file, and other preferences after you close and reopen it. (Previously the desktop app reset these to defaults on every launch — most noticeably switching the compiler back to pdflatex.)

---

## v4.7.0 — 2026-06-02

### GitHub (browser/source mode)
- **Sign in with GitHub** right inside TexLocal — no command-line setup. Uses GitHub's device-code flow: click the button, enter the short code on github.com, and you're connected.
- **Back up a project to GitHub** in one click — TexLocal initialises a git repo (with a LaTeX-aware `.gitignore`), commits, creates the repository for you if needed, and pushes. Private by default.
- **Import a project from GitHub** on the dashboard, and **check for / pull remote changes** (your unsaved local edits are stashed and re-applied automatically).

### Editor
- **Reopen where you left off** — projects now restore the last file you had open *and* your cursor line.
- **Closable tabs** — an × on each editor tab, or middle-click to close.
- **Smarter autocomplete** — your own `\newcommand` / `\newenvironment` definitions are now suggested, and the `\begin{...}` environment list pops up automatically as you type.
- **Package manager panel** — see which LaTeX packages your document uses, check whether each is installed, and open MiKTeX / TeX Live to add any that are missing.

### Fixes
- Deleting a project that contains a git repository no longer fails on Windows.
- Project-local `.cls` / `.bst` / `.bib` files are now found at compile time even when your main file lives in a subfolder.
- Right-click spelling suggestions are smooth again — computing suggestions no longer briefly freezes the editor.

### Desktop
- The installed Windows app now works fully **offline** — the UI fonts and all editor libraries are bundled into the app, so no internet connection is needed at launch.

_Thanks again to **PolarZ5** for contributing this whole batch of features (PR #2)._

---

## v4.6.0 — 2026-06-02

### Editor
- **Word suggestions** (optional, off by default): while typing prose, a dropdown can autocomplete words — both terms already used in your document (so names like "Rydberg" complete after a few letters) and ordinary English words — and offer spelling fixes for a mistyped word. Press Tab or Enter to accept. Turn it on in Settings → "Word suggestions". It never triggers inside LaTeX commands, math, comments, or citations.
- **Grammar mode** (✍ toolbar button): opens your selected text — or the paragraph at the cursor — in a plain text box where browser grammar extensions such as Grammarly, QuillBot, or LanguageTool can attach. Edit there and press "Insert back" to drop it into your document. (Browser mode only.)

_Thanks to **PolarZ5** for contributing both features — the first external contribution to TexLocal._

---

## v4.5.0 — 2026-06-01

### Editor
- Much faster editor open: the compiled PDF now appears almost immediately, even for long (100+ page) documents. Pages render as you scroll instead of all at once, and the file tree, your main file, and the PDF now load in parallel.

---

## v4.4.2 — 2026-06-01

### Editor
- Fixed: jumping from the editor to the PDF (forward sync) now highlights the **full paragraph** — previously the first line of a multi-line paragraph was left out of the highlight box.

---

## v4.4.1 — 2026-06-01

### Editor
- Fixed: "go to PDF location" (the ⇢ button / Ctrl+Alt+→) now works from chapter and appendix files, not just the main file. It previously failed with a "not found" error for any `\input`-ed file.

---

## v4.3.1 — 2026-06-01

### Desktop app
- Auto-update check and About modal link now point to the correct public repository
- Fixed: saving a file could silently corrupt it if the process was interrupted mid-write — all file writes are now atomic (write to temp → rename)
- Fixed: moving a file to a name that already exists now returns an error instead of silently overwriting the destination
- Fixed: uploading a file that already exists no longer overwrites it silently; the existing file is preserved and the duplicate is reported

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
