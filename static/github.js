import { _reloadCurrentFileFromDisk, closeModal, currentProject, openModal } from "editor";
import { loadFiles, saveCurrentFile } from "files";

// static/github.js — TexLocal Phase 2 module split (v5.0.0-beta.2.0)
// Lifted verbatim from editor.js (CM-light cluster). Interim shared-scope:
// a classic <script defer>, NOT an ES module — shares editor.js's global
// scope (module-level state + the global CM adapter facade). Loads AFTER
// editor.js and BEFORE boot.js. CM6 note: touches CodeMirror only via CM.*

// ── GITHUB BACKUP (v4.4.0) ────────────────────────────────────
// Per-project "Backup to GitHub": commit & push via the backend. The modal
// shows sign-in status and a device-flow login/logout; backup flushes the
// open file first so on-disk state matches.
// showLogin / showLogout toggle the two auth-row buttons independently.
let _ghAuthMode = null;
let _ghLoggedIn = false;
let _ghGitReady = false;
let _ghRepoLinked = false;
let _ghAuthReady = false;
let _ghSyncReady = false;
let _ghSyncResolved = false; // request settled, even if repository state is unknown
let _ghBusy = false;
// v5.8.0p4 — stale-while-revalidate cache. Reopening the modal for the same
// project renders instantly from the last completed checks (no veil), then the
// normal checks re-run quietly in the background and correct anything stale.
// The only genuinely volatile datum is ahead/behind from `git fetch`, and for a
// single-user tool that only moves when the user themselves pushed elsewhere.
let _ghCacheSt = null;    // last /github/status JSON (global — not per-project)
let _ghCacheSync = null;  // { project, d } — last completed sync check

function _ghSetStatus(text, showLogin, showLogout) {
  const t  = document.getElementById("gh-auth-text");
  const bi = document.getElementById("gh-login-btn");
  const bo = document.getElementById("gh-logout-btn");
  if (t)  t.textContent = text;
  if (bi) bi.style.display = showLogin  ? "" : "none";
  if (bo) bo.style.display = showLogout ? "" : "none";
}

function _ghSetGitStatus(ready) {
  _ghGitReady = Boolean(ready);
  const row = document.getElementById("gh-git-row");
  const text = document.getElementById("gh-git-text");
  // v5.8.0p2 — Git being present is plumbing, not news: fold the happy case
  // into the signed-in line and show this row only when something needs attention.
  if (row) {
    row.style.display = ready === true ? "none" : "flex";
    row.dataset.state = ready === true ? "ok" : (ready === false ? "error" : "checking");
  }
  if (text) text.textContent = ready === false
    ? "Git is required for GitHub Backup but was not found on this computer."
    : "Could not check whether Git is available.";
  _ghUpdateBackupButton();
}

// v5.8.0p3 — drop the loading veil once the modal knows its final layout:
// auth resolved, and (when signed in) the sync check has decided linked-vs-new.
// One-way per open; openGitHubModal re-arms it.
function _ghMaybeReveal() {
  if (!_ghAuthReady) return;
  if (_ghLoggedIn && !_ghSyncResolved) return;
  const overlay = document.getElementById("modal-github");
  if (overlay) overlay.removeAttribute("data-gh-loading");
}

function _ghUpdateBackupButton() {
  _ghMaybeReveal();
  const btn = document.getElementById("gh-backup-btn");
  if (!btn) return;
  btn.textContent = _ghBusy
    ? "Backing up…"
    : (_ghSyncResolved && !_ghSyncReady
      ? "Back up unavailable"
      : (_ghRepoLinked ? "Back up now" : "Create repository & back up"));
  btn.disabled = _ghBusy || !_ghAuthReady || !_ghSyncReady ||
                 !_ghLoggedIn || !_ghGitReady;
  if (!_ghAuthReady || !_ghSyncResolved) btn.title = "Checking GitHub status…";
  else if (!_ghSyncReady) btn.title = "Repository status could not be checked.";
  else if (!_ghLoggedIn) btn.title = "Sign in to GitHub first.";
  else if (!_ghGitReady) btn.title = "Git is required for GitHub Backup.";
  else btn.title = "";
}

function _ghShowResult(kind, summary, details, repoUrl) {
  const box = document.getElementById("gh-result");
  const heading = document.getElementById("gh-result-summary");
  const link = document.getElementById("gh-result-link");
  const disclosure = document.getElementById("gh-result-details");
  const pre = document.getElementById("gh-result-technical");
  if (!box) return;
  box.style.display = "block";
  box.dataset.state = kind || "info";
  if (heading) heading.textContent = summary || "";
  if (pre) pre.textContent = details || "";
  if (disclosure) disclosure.style.display = details ? "block" : "none";
  if (disclosure) disclosure.open = false;
  if (link) {
    if (/^https:\/\/github\.com\//i.test(repoUrl || "")) {
      link.href = repoUrl;
      link.style.display = "inline-block";
    } else {
      link.removeAttribute("href");
      link.style.display = "none";
    }
  }
}

function _ghRemoteLabel(remote) {
  const clean = String(remote || "").trim().replace(/\.git$/i, "");
  const github = clean.match(/github\.com[/:]([^/]+\/[^/]+)$/i);
  return github ? github[1] : clean;
}

// v5.8.0p2 — until the first sync check resolves we don't know whether this
// project already has a remote; briefly showing the creation fields for a linked
// project flashed the wrong UI on every modal open. Hide both until sync decides.
function _ghSetRepoPending() {
  const connected = document.getElementById("gh-connected-row");
  const createFields = document.getElementById("gh-repo-create-fields");
  if (connected) connected.style.display = "none";
  if (createFields) createFields.style.display = "none";
  _ghRepoLinked = false;
  _ghUpdateBackupButton();
}

// v5.8.0 — A repository name and visibility only affect the first Backup action.
// Once origin exists, show the actual destination and make the controls
// read-only rather than leaving values that look editable but are ignored.
function _ghSetRepoMode(remote) {
  const linked = Boolean(remote);
  const name = document.getElementById("gh-repo-name");
  const connected = document.getElementById("gh-connected-row");
  const connectedRepo = document.getElementById("gh-connected-repo");
  const createFields = document.getElementById("gh-repo-create-fields");
  const label = linked ? _ghRemoteLabel(remote) : "";

  if (connected) connected.style.display = linked ? "flex" : "none";
  if (connectedRepo) connectedRepo.textContent = label;
  if (createFields) createFields.style.display = linked ? "none" : "block";
  _ghRepoLinked = linked;
  if (name) {
    name.readOnly = linked;
    name.setAttribute("aria-readonly", linked ? "true" : "false");
    name.title = linked ? "This project is already connected to this GitHub repository." : "";
    if (linked) {
      name.value = label;
      name.dataset.ghLinked = "1";
    } else {
      // Keep a deliberately typed creation name, but discard a label that
      // belonged to the previously opened linked project.
      const wasLinked = name.dataset.ghLinked === "1";
      delete name.dataset.ghLinked;
      if (wasLinked || !name.value.trim()) name.value = currentProject || "";
    }
  }
  _ghUpdateBackupButton();
}

// v5.8.0p4 — pure render of a /github/status payload (also fed from cache).
function _ghRenderStatus(st) {
  _ghAuthMode = st.logged_in ? st.mode : null;
  _ghLoggedIn = Boolean(st.logged_in);
  _ghAuthReady = true;
  _ghSetGitStatus(Boolean(st.git_installed));
  if (st.logged_in) {
    // v5.8.0p3 — no checkmark glyphs in status text (PoL's call); state reads
    // through wording alone. ✓/✗ stay only inside collapsed Technical details.
    _ghSetStatus("Signed in as " + (st.account || "GitHub")
                 + (st.git_installed ? " · Git ready" : ""), false, true);
  } else {
    _ghSetStatus("Not signed in to GitHub.", true, false);
  }
  _ghUpdateBackupButton();
}

async function _ghRefreshStatus() {
  try {
    const st = await (await fetch("/api/github/status")).json();
    _ghCacheSt = st;          // v5.8.0p4
    _ghRenderStatus(st);
    return st;
  } catch (_) {
    _ghCacheSt = null;        // v5.8.0p4 — don't fast-path from a dead server
    _ghAuthReady = true;
    _ghLoggedIn = false;
    _ghSetGitStatus(null);
    _ghSetStatus("Could not reach the server.", false, false);
    _ghUpdateBackupButton();
    return null;
  }
}

export function openGitHubModal() {
  if (!currentProject) { alert("Open a project first."); return; }
  _ghBusy = false;
  // v5.8.0p4 — SWR fast path: same project + complete cache → render the final
  // layout immediately (no veil), then let the normal checks refresh it quietly.
  const _cachedOpen = Boolean(_ghCacheSt && _ghCacheSt.logged_in &&
                              _ghCacheSync && _ghCacheSync.project === currentProject);
  if (!_cachedOpen) {
    _ghAuthReady = false;
    _ghSyncReady = false;
    _ghSyncResolved = false;
    _ghGitReady = false;
    _ghSetRepoPending();
  }
  const res = document.getElementById("gh-result");
  if (res) res.style.display = "none";
  const resultSummary = document.getElementById("gh-result-summary");
  const resultDetails = document.getElementById("gh-result-technical");
  const resultDisclosure = document.getElementById("gh-result-details");
  const resultLink = document.getElementById("gh-result-link");
  if (resultSummary) resultSummary.textContent = "";
  if (resultDetails) resultDetails.textContent = "";
  if (resultDisclosure) { resultDisclosure.style.display = "none"; resultDisclosure.open = false; }
  if (resultLink) { resultLink.style.display = "none"; resultLink.removeAttribute("href"); }
  const overlay = document.getElementById("modal-github");
  if (_cachedOpen) {
    // v5.8.0p4 — instant open from cache; background refresh corrects staleness.
    if (overlay) overlay.removeAttribute("data-gh-loading");
    _ghAuthReady = true;
    _ghSyncReady = true;
    _ghSyncResolved = true;
    _ghRenderStatus(_ghCacheSt);
    _ghRenderSync(_ghCacheSync.d);
    openModal("modal-github");
    _ghRefreshStatus();
    _ghCheckSync({ quiet: true });
    return;
  }
  const sync = document.getElementById("gh-sync-row");
  if (sync) sync.style.display = "none";
  _ghSetStatus("Checking GitHub sign-in…", false, false);
  // v5.8.0p2 — the auth line already reads as "checking"; the Git row only
  // appears if the check comes back negative, so keep it hidden while pending.
  const gitRow = document.getElementById("gh-git-row");
  if (gitRow) { gitRow.style.display = "none"; gitRow.dataset.state = "checking"; }
  // v5.8.0p3 — loading veil: hide the whole body behind one "Checking GitHub…"
  // line until the layout is decided (auth resolved + sync picked linked-vs-new),
  // so the modal appears once, in its final shape, instead of morphing.
  if (overlay) overlay.dataset.ghLoading = "1";
  _ghUpdateBackupButton();
  openModal("modal-github");
  _ghRefreshStatus();
  _ghCheckSync();
}

let _ghPollTimer = null;
export async function githubLogin() {
  _ghAuthReady = false;
  _ghSetStatus("Starting GitHub sign-in…", false, false);
  _ghUpdateBackupButton();
  try {
    const r = await fetch("/api/github/login", { method: "POST" });
    const d = await r.json();
    if (!r.ok) {
      _ghAuthReady = true;
      _ghSetStatus(d.error || "Sign-in failed.", true, false);
      _ghUpdateBackupButton();
      return;
    }
    if (d.already) { _ghRefreshStatus(); return; }
    const uri  = d.verification_uri || "https://github.com/login/device";
    const code = d.user_code || "";
    // v4.7.0 — open the verify page in a REAL browser. The WebView2 desktop
    // build (pywebview injects window.pywebview) can't window.open a system tab,
    // so ask the backend to launch the OS browser; plain browser mode uses
    // window.open as before.
    if (window.pywebview) {
      try { await fetch("/api/github/open-verify", { method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: uri }) }); } catch (_) {}
    } else {
      try { window.open(uri, "_blank", "noopener"); } catch (_) {}
    }
    _ghSetStatus("Enter code " + code + " at " + uri + " — waiting for you to authorise…", false, false);
    clearInterval(_ghPollTimer);
    const interval = Math.max(2, (d.interval || 5)) * 1000;
    _ghPollTimer = setInterval(async () => {
      let p;
      try { p = await (await fetch("/api/github/login/poll", { method: "POST" })).json(); }
      catch (_) { return; }
      if (p.status === "authorized") {
        clearInterval(_ghPollTimer);
        // v5.8.0p2 — reuse the status refresh so the signed-in line (incl. Git
        // readiness) has one source of truth instead of a hand-built copy here.
        _ghRefreshStatus();
      } else if (p.status === "error") {
        clearInterval(_ghPollTimer);
        _ghAuthReady = true;
        _ghSetStatus(p.error || "Sign-in failed.", true, false);
        _ghUpdateBackupButton();
      }
    }, interval);
  } catch (_) {
    _ghAuthReady = true;
    _ghSetStatus("Sign-in request failed.", true, false);
    _ghUpdateBackupButton();
  }
}

export async function githubLogout() {
  const logoutCli = _ghAuthMode === "gh";
  // v5.8.0 — CLI authentication belongs to the Windows account, so require a
  // deliberate in-app confirmation without falling back to browser chrome.
  if (logoutCli) {
    openModal("modal-github-logout");
    const confirmBtn = document.getElementById("gh-logout-confirm-btn");
    if (confirmBtn) setTimeout(() => confirmBtn.focus(), 0);
    return;
  }
  await _ghPerformLogout(false);
}

export async function githubLogoutConfirm() {
  closeModal("modal-github-logout");
  await _ghPerformLogout(true);
}

async function _ghPerformLogout(logoutCli) {
  clearInterval(_ghPollTimer);
  _ghAuthReady = false;
  _ghSetStatus("Signing out…", false, false);
  _ghUpdateBackupButton();
  try {
    const r = await fetch("/api/github/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ logout_cli: logoutCli }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) {
      _ghAuthReady = true;
      _ghSetStatus(d.error || "Sign-out failed.", false, true);
      _ghUpdateBackupButton();
      return;
    }
    _ghAuthMode = null;
    _ghLoggedIn = false;
    _ghAuthReady = true;
    _ghCacheSt = null;        // v5.8.0p4 — no fast-path across an auth change
    _ghCacheSync = null;
    _ghSetStatus("Signed out of GitHub.", true, false);
    _ghUpdateBackupButton();
  } catch (_) {
    _ghAuthReady = true;
    _ghSetStatus("Sign-out request failed.", false, true);
    _ghUpdateBackupButton();
  }
}

export async function githubBackup() {
  if (!currentProject) { alert("Open a project first."); return; }
  const repo = (document.getElementById("gh-repo-name").value || currentProject).trim();
  const priv = document.getElementById("gh-visibility").value !== "public";
  const msg  = (document.getElementById("gh-commit-msg").value || "Backup from TexLocal").trim();
  if (!_ghLoggedIn || !_ghGitReady || !_ghAuthReady || !_ghSyncReady) return;
  _ghBusy = true;
  _ghUpdateBackupButton();
  _ghShowResult("info", "Preparing your backup…", "", "");
  // v5.7.1 (#1, codex High) — do NOT swallow a pre-backup save failure. The old
  // catch(_){} let a failed write through, so commit/push could report success
  // while excluding the latest visible edit. Abort the backup instead so the
  // user fixes the save first rather than pushing stale content.
  try {
    await saveCurrentFile();
  } catch (e) {
    _ghShowResult("error", "Backup stopped because the current file could not be saved.",
                  String(e.message || e), "");
    _ghBusy = false;
    _ghUpdateBackupButton();
    return;
  }
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/github/backup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, private: priv, message: msg }),
    });
    const d = await r.json();
    const lines = (d.steps || []).map(s =>
      (s.ok ? "✓ " : "✗ ") + s.step + (!s.ok && s.err ? "\n   " + s.err : ""));
    if (d.error) lines.push("Error: " + d.error);
    if (d.ok) {
      _ghShowResult("ok", "Backup complete. Your project is up to date on GitHub.",
                    lines.join("\n"), d.repo_url || "");
    } else if (d.non_fast_forward) {
      _ghShowResult("warn",
        "GitHub has newer changes. Get those changes before backing up again.",
        lines.join("\n"), "");
    } else {
      _ghShowResult("error", "Backup could not be completed.", lines.join("\n"), "");
    }
    if (r.status === 401) _ghRefreshStatus();
    if (d.ok || d.non_fast_forward) _ghCheckSync();
  } catch (e) {
    _ghShowResult("error", "TexLocal could not reach the backup service.",
                  String(e.message || e), "");
  } finally {
    _ghBusy = false;
    _ghUpdateBackupButton();
  }
}

// v4.4.0 — Check how local compares to the GitHub remote (fetch + ahead/behind)
// and offer Pull when the remote is ahead.
async function _ghCheckSync(opts) {
  // v5.8.0p4 — quiet = SWR background refresh: skip the loud "Checking…" reset
  // so the cached render stays on screen until fresh data replaces it.
  const quiet = Boolean(opts && opts.quiet);
  const project = currentProject;
  const row  = document.getElementById("gh-sync-row");
  const txt  = document.getElementById("gh-sync-text");
  const pull = document.getElementById("gh-pull-btn");
  if (!row || !currentProject) { if (row) row.style.display = "none"; return; }
  if (!quiet) {
    _ghSyncReady = false;
    _ghSyncResolved = false;
    _ghUpdateBackupButton();
    row.style.display = "flex";
    txt.textContent = "Checking for remote changes…";
    pull.style.display = "none";
  }
  let d;
  try {
    d = await (await fetch(`/api/projects/${encodeURIComponent(project)}/github/sync`)).json();
  } catch (_) {
    _ghCacheSync = null;      // v5.8.0p4 — next open takes the veiled path
    if (quiet) return;        // keep the cached render; nothing better to show
    // v5.8.0p6 — a transport/JSON failure means "unknown", not "unlinked".
    // Hide both destination modes, reveal an actionable error, and keep Backup
    // disabled until a later successful check establishes the real repository.
    _ghSyncResolved = true;
    _ghSyncReady = false;
    _ghSetRepoPending();
    row.style.display = "flex";
    txt.textContent = "Could not check repository status. Close and reopen to try again.";
    txt.title = "";
    pull.style.display = "none";
    _ghUpdateBackupButton();
    return;
  }
  if (project !== currentProject) return;  // a late check must not rewrite another project's modal
  _ghCacheSync = { project, d };           // v5.8.0p4
  _ghRenderSync(d);
}

// v5.8.0p4 — pure render of a /github/sync payload (also fed from cache).
function _ghRenderSync(d) {
  const row  = document.getElementById("gh-sync-row");
  const txt  = document.getElementById("gh-sync-text");
  const pull = document.getElementById("gh-pull-btn");
  if (!row || !txt || !pull) return;
  _ghSyncResolved = true;
  if (!d.repo || !d.remote) {
    _ghSetRepoMode(null);
    row.style.display = "none";
    _ghSyncReady = true;
    _ghUpdateBackupButton();
    return;
  }
  _ghSetRepoMode(d.remote);
  row.style.display = "flex";
  if (!d.fetched) {
    txt.textContent = "Could not check GitHub for newer changes.";
    txt.title = d.fetch_error || "";
    _ghSyncReady = true;
    _ghUpdateBackupButton();
    return;
  }
  txt.title = "";
  if (d.behind && d.ahead) {
    txt.textContent = "This project and GitHub both have new changes — get GitHub changes first, then back up.";
  } else if (d.behind) {
    txt.textContent = `GitHub has ${d.behind} newer change${d.behind === 1 ? "" : "s"}.`;
  } else if (d.ahead || d.dirty) {
    txt.textContent = "Local changes are ready to back up.";
  } else {
    txt.textContent = "Up to date with GitHub";
  }
  pull.style.display = d.behind ? "" : "none";
  pull.disabled = false; pull.textContent = "Get GitHub changes";
  _ghSyncReady = true;
  _ghUpdateBackupButton();
}

export async function githubPull() {
  // v5.8.0p5 — plan item D3: bind this pull to the project it started in. A pull
  // takes seconds (fetch + merge); if the user switches projects while it is in
  // flight, the completion below would reload the NEW project's buffer from disk
  // (losing unsaved edits there) and write this pull's status into its modal.
  // A late completion for a foreign project is dropped instead — same guard
  // _ghCheckSync already uses. The pull itself still finishes on disk in the
  // original project; its result shows on the next sync check there.
  const project = currentProject;
  const pull = document.getElementById("gh-pull-btn");
  pull.disabled = true; pull.textContent = "Getting changes…";
  // v5.7.1 (#1, codex High) — flush a dirty buffer BEFORE pulling. Pull ends
  // with _reloadCurrentFileFromDisk(), which would overwrite unsaved edits with
  // the pulled disk content; saving first puts the edit on disk (and into the
  // merge) instead of silently losing it. Abort on save failure.
  try {
    await saveCurrentFile();
  } catch (e) {
    if (project !== currentProject) return;  // v5.8.0p6 — stale save failure
    _ghShowResult("error", "Changes could not be downloaded because the current file was not saved.",
                  String(e.message || e), "");
    pull.disabled = false; pull.textContent = "Get GitHub changes";
    return;
  }
  if (project !== currentProject) return;    // v5.8.0p6 — switched during save
  try {
    const d = await (await fetch(`/api/projects/${encodeURIComponent(project)}/github/pull`,
                                 { method: "POST" })).json();
    if (project !== currentProject) return;  // v5.8.0p5 — stale completion (D3)
    if (d.ok) {
      await _reloadCurrentFileFromDisk(project); // helper also guards its internal await
      if (project !== currentProject) return;
      await loadFiles();                    // newly-pulled files show in the tree
      if (project !== currentProject) return;
      _ghShowResult("ok", "GitHub changes downloaded.", d.out || "", "");
      _ghCheckSync();
    } else {
      // Reload so any conflict markers / merged content show in the editor.
      await _reloadCurrentFileFromDisk(project);
      if (project !== currentProject) return;
      await loadFiles();
      if (project !== currentProject) return;
      let head;
      if (d.conflict)     head = "GitHub changes created a merge conflict. Resolve the marked files, then back up.";
      else if (d.blocked) head = "Back up your local changes, then try getting GitHub changes again.";
      else                head = "GitHub changes could not be downloaded.";
      const conflictList = (d.conflict_files || []).length
        ? "Conflicted files:\n" + d.conflict_files.map(f => "• " + f).join("\n") +
          "\n\nOpen each file and resolve the <<<<<<<, =======, and >>>>>>> sections."
        : "";
      _ghShowResult(d.conflict ? "warn" : "error", head,
                    [conflictList, d.error || ""].filter(Boolean).join("\n\n"), "");
      if (d.conflict) {
        pull.disabled = true;
        pull.textContent = "Resolve conflicts first";
      } else {
        pull.disabled = false;
        pull.textContent = "Get GitHub changes";
        _ghCheckSync();
      }
    }
  } catch (e) {
    if (project !== currentProject) return;  // v5.8.0p5 — stale failure (D3)
    _ghShowResult("error", "TexLocal could not reach GitHub.", String(e.message || e), "");
    pull.disabled = false; pull.textContent = "Get GitHub changes";
  }
}
