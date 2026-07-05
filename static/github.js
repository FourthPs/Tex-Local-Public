import { _reloadCurrentFileFromDisk, currentProject, openModal } from "editor";
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
function _ghSetStatus(text, showLogin, showLogout) {
  const t  = document.getElementById("gh-auth-text");
  const bi = document.getElementById("gh-login-btn");
  const bo = document.getElementById("gh-logout-btn");
  if (t)  t.textContent = text;
  if (bi) bi.style.display = showLogin  ? "" : "none";
  if (bo) bo.style.display = showLogout ? "" : "none";
}

async function _ghRefreshStatus() {
  try {
    const st = await (await fetch("/api/github/status")).json();
    if (st.logged_in) {
      const viaGh = st.mode === "gh";   // gh CLI session — our Log out can't end it
      _ghSetStatus("Signed in as " + (st.account || "GitHub") + (viaGh ? " (gh CLI) ✓" : " ✓"),
                   false, !viaGh);
    } else {
      _ghSetStatus("Not signed in to GitHub.", true, false);
    }
    return st;
  } catch (_) {
    _ghSetStatus("Could not reach the server.", false, false);
    return null;
  }
}

export function openGitHubModal() {
  if (!currentProject) { alert("Open a project first."); return; }
  const nameInput = document.getElementById("gh-repo-name");
  if (nameInput && !nameInput.value.trim()) nameInput.value = currentProject;
  const res = document.getElementById("gh-result");
  if (res) { res.style.display = "none"; res.textContent = ""; }
  const sync = document.getElementById("gh-sync-row");
  if (sync) sync.style.display = "none";
  openModal("modal-github");
  _ghRefreshStatus();
  _ghCheckSync();
}

let _ghPollTimer = null;
export async function githubLogin() {
  _ghSetStatus("Starting GitHub sign-in…", false, false);
  try {
    const r = await fetch("/api/github/login", { method: "POST" });
    const d = await r.json();
    if (!r.ok) { _ghSetStatus(d.error || "Sign-in failed.", true, false); return; }
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
        _ghSetStatus("Signed in as " + (p.account || "GitHub") + " ✓", false, true);
      } else if (p.status === "error") {
        clearInterval(_ghPollTimer);
        _ghSetStatus(p.error || "Sign-in failed.", true, false);
      }
    }, interval);
  } catch (_) {
    _ghSetStatus("Sign-in request failed.", true, false);
  }
}

export async function githubLogout() {
  clearInterval(_ghPollTimer);
  _ghSetStatus("Signing out…", false, false);
  try { await fetch("/api/github/logout", { method: "POST" }); } catch (_) {}
  _ghRefreshStatus();
}

export async function githubBackup() {
  if (!currentProject) { alert("Open a project first."); return; }
  const btn = document.getElementById("gh-backup-btn");
  const res = document.getElementById("gh-result");
  const repo = (document.getElementById("gh-repo-name").value || currentProject).trim();
  const priv = document.getElementById("gh-visibility").value !== "public";
  const msg  = (document.getElementById("gh-commit-msg").value || "Backup from TexLocal").trim();
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Backing up…"; }
  if (res) { res.style.display = "block"; res.textContent = "Working…"; }
  try { await saveCurrentFile(); } catch (_) {}
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/github/backup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, private: priv, message: msg }),
    });
    const d = await r.json();
    const lines = (d.steps || []).map(s =>
      (s.ok ? "✓ " : "✗ ") + s.step + (!s.ok && s.err ? "\n   " + s.err : ""));
    if (d.ok) lines.push("", d.repo_url ? ("Done → " + d.repo_url) : "Done.");
    else if (d.error) lines.push((lines.length ? "\n" : "") + "Error: " + d.error);
    if (res) res.textContent = lines.join("\n");
    if (r.status === 401) _ghRefreshStatus();
    if (d.ok) _ghCheckSync();   // refresh ahead/behind after pushing
  } catch (e) {
    if (res) res.textContent = "Request failed: " + e;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "⬆ Commit & push"; }
  }
}

// v4.4.0 — Check how local compares to the GitHub remote (fetch + ahead/behind)
// and offer Pull when the remote is ahead.
async function _ghCheckSync() {
  const row  = document.getElementById("gh-sync-row");
  const txt  = document.getElementById("gh-sync-text");
  const pull = document.getElementById("gh-pull-btn");
  if (!row || !currentProject) { if (row) row.style.display = "none"; return; }
  row.style.display = "flex";
  txt.textContent = "Checking for remote changes…";
  pull.style.display = "none";
  let d;
  try {
    d = await (await fetch(`/api/projects/${encodeURIComponent(currentProject)}/github/sync`)).json();
  } catch (_) { row.style.display = "none"; return; }
  if (!d.repo || !d.remote) { row.style.display = "none"; return; }   // nothing connected yet
  if (!d.fetched) {
    txt.textContent = "Couldn't reach the remote" + (d.fetch_error ? ": " + d.fetch_error : ".");
    return;
  }
  const parts = [];
  if (d.behind) parts.push(`↓ ${d.behind} behind`);
  if (d.ahead)  parts.push(`↑ ${d.ahead} ahead`);
  txt.textContent = parts.length
    ? `${parts.join(" · ")} origin/${d.branch}` + (d.dirty ? " · local edits" : "")
    : `Up to date with origin/${d.branch} ✓`;
  pull.style.display = d.behind ? "" : "none";
  pull.disabled = false; pull.textContent = "⬇ Pull";
}

export async function githubPull() {
  const pull = document.getElementById("gh-pull-btn");
  const res  = document.getElementById("gh-result");
  pull.disabled = true; pull.textContent = "⏳ Pulling…";
  try {
    const d = await (await fetch(`/api/projects/${encodeURIComponent(currentProject)}/github/pull`,
                                 { method: "POST" })).json();
    if (res) res.style.display = "block";
    if (d.ok) {
      await _reloadCurrentFileFromDisk();   // bring pulled content into the editor
      await loadFiles();                    // newly-pulled files show in the tree
      if (res) res.textContent = "Pulled from GitHub:\n" + (d.out || "done");
      _ghCheckSync();
    } else {
      // Reload so any conflict markers / merged content show in the editor.
      await _reloadCurrentFileFromDisk();
      await loadFiles();
      let head;
      if (d.conflict)     head = "Merge conflict — open the file(s), fix the <<<<< ===== >>>>> markers, then back up:\n";
      else if (d.blocked) head = "Couldn't merge automatically — back up (Commit & push) first, then Pull:\n";
      else                head = "Pull failed:\n";
      if (res) res.textContent = head + (d.error || "");
      pull.disabled = false; pull.textContent = "⬇ Pull";
      _ghCheckSync();
    }
  } catch (e) {
    if (res) { res.style.display = "block"; res.textContent = "Pull request failed: " + e; }
    pull.disabled = false; pull.textContent = "⬇ Pull";
  }
}
