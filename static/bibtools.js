import { CM, _esc, _reloadCurrentFileFromDisk, _togglePopover, availableIncludes, currentFile, currentProject, draftMode, escapeAttr, escapeHtml, loadCiteData, renderHistoryPanel, saveTimer, selectedIncludes } from "editor";
import { openFile, saveCurrentFile } from "files";

// static/bibtools.js — TexLocal Phase 2 module split (v5.0.0-beta.2.0)
// Lifted verbatim from editor.js (CM-light cluster). Interim shared-scope:
// a classic <script defer>, NOT an ES module — shares editor.js's global
// scope (module-level state + the global CM adapter facade). Loads AFTER
// editor.js and BEFORE boot.js. CM6 note: touches CodeMirror only via CM.*

// ── v3.2.2 — TODO tracker ────────────────────────────────────
export async function loadTodosUI() {
  if (!currentProject) return;
  const list  = document.getElementById("td-list");
  const count = document.getElementById("td-count");
  list.innerHTML = '<div class="td-empty">Scanning…</div>';
  count.textContent = "";
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/todos`);
    const d = await r.json();
    const todos = d.todos || [];
    if (!todos.length) {
      list.innerHTML =
        `<div class="td-empty">No <code>\\todo{}</code>, <code>% TODO</code>,
         <code>% FIXME</code>, or <code>% XXX</code> markers found.<br><br>
         Add comments like <code>% TODO derive eq.</code> in your .tex
         files to track pending work.</div>`;
      return;
    }
    count.textContent = `${todos.length} item${todos.length === 1 ? "" : "s"}`;
    list.innerHTML = todos.map(t =>
      `<div class="td-item" data-file="${escapeAttr(t.file)}" onclick="jumpToTodo(this.dataset.file, ${t.line})">
         <span class="td-tag ${t.kind}">${t.kind === "todo" ? "todo" : t.kind}</span>
         <span class="td-text">${escapeHtml(t.text || "(empty)")}</span>
         <span class="td-loc">${escapeHtml(t.file)}:${t.line}</span>
       </div>`
    ).join("");
  } catch (e) {
    list.innerHTML = `<div class="td-empty" style="color:var(--red)">Load failed: ${escapeHtml(e.message)}</div>`;
  }
}
export async function jumpToTodo(file, line) {
  if (file !== currentFile) await openFile(file);
  const lineNo = Math.max(0, (line | 0) - 1);
  setTimeout(() => {
    CM.setCursor(lineNo, 0);
    CM.scrollIntoView({ line: lineNo, ch: 0 }, 120);
    CM.focus();
    CM.addLineClass(lineNo, "background", "cm-synctex-jump");
    setTimeout(() => CM.removeLineClass(lineNo, "background", "cm-synctex-jump"), 1200);
  }, file !== currentFile ? 200 : 0);
  document.getElementById("todo-panel").classList.remove("open");
}

// ── v4.9.0 — BIBLIOGRAPHY AUDIT ─────────────────────────────────────
// Cross-checks \\cite usage vs .bib entries (backend /bib-audit) and lists:
//   • unresolved — cited key with no .bib entry  (also underlined inline
//                  by lintCrossRefs; listed here for a jump-to-fix workflow)
//   • duplicate  — key defined 2+ times; BibTeX silently keeps the first
//   • unused     — .bib entry no key ever cites  (informational)
// The toolbar badge counts only unresolved + duplicate — the "broken"
// classes. `unused` is often large for a Mendeley-exported library, so it's
// shown in the panel but kept out of the alarming red badge.
// v5.0.0-beta.0.0 — Popover
export function toggleBibPanel(e){ _togglePopover(e, { panelId: "bib-panel", btnId: "bib-toggle-btn", width: 440, onOpen: loadBibAuditUI }); }

let _bibAuditInFlight = null;   // v4.9.6 (B2) — coalesce concurrent audit fetches
async function _fetchBibAudit() {
  if (!currentProject) return null;
  // v4.9.6 (B2) — a successful compile fires two audits back-to-back
  // (updateBibBadge via loadCiteData, then _appendBibAuditBreadcrumb); if one
  // is already in flight, share its promise instead of issuing a second
  // identical request. The backend also mtime-caches /bib-audit now, so even
  // staggered calls are cheap — this just kills the duplicate round-trip.
  // Cleared the moment the request settles, so a later edit re-fetches fresh.
  if (_bibAuditInFlight) return _bibAuditInFlight;
  const proj = currentProject;
  _bibAuditInFlight = (async () => {
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(proj)}/bib-audit`);
      if (!r.ok) throw new Error("bib-audit " + r.status);
      return await r.json();
    } finally {
      _bibAuditInFlight = null;
    }
  })();
  return _bibAuditInFlight;
}

// Lightweight badge refresh — no panel needed. Counts only the "broken"
// classes (unresolved + duplicate) so a big unused list doesn't cry wolf.
export async function updateBibBadge() {
  const badge = document.getElementById("bib-badge");
  if (!badge) return;
  if (!currentProject) { badge.style.display = "none"; return; }
  try {
    const d = await _fetchBibAudit();
    const c = (d && d.counts) || {};
    const broken = (c.unresolved || 0) + (c.duplicate || 0);
    if (broken > 0) {
      badge.textContent = broken > 99 ? "99+" : String(broken);
      badge.style.display = "block";
    } else {
      badge.style.display = "none";
    }
  } catch (_) {
    badge.style.display = "none";
  }
}

let _lastBibAudit = null;   // v4.9.2
export async function loadBibAuditUI() {
  const list  = document.getElementById("bib-list");
  const count = document.getElementById("bib-count");
  if (!currentProject) {
    list.innerHTML = '<div class="bib-empty">Open a project first</div>';
    count.textContent = "";
    return;
  }
  list.innerHTML = '<div class="bib-empty">Scanning…</div>';
  count.textContent = "";
  let d;
  try {
    d = await _fetchBibAudit();
  } catch (e) {
    list.innerHTML = `<div class="bib-empty" style="color:var(--red)">Load failed: ${escapeHtml(e.message)}</div>`;
    return;
  }
  const unresolved = d.unresolved || [];
  const duplicate  = d.duplicate  || [];
  const unused     = d.unused     || [];
  _lastBibAudit = d;   // v4.9.2 — remembered for the bulk "comment out all"
  const total = unresolved.length + duplicate.length + unused.length;
  if (total === 0) {
    list.innerHTML = `<div class="bib-empty clean">✓ No citation issues found${
      d.nocite_all ? " (\\nocite{*} in use — unused check skipped)" : ""}</div>`;
    count.textContent = "";
    return;
  }
  count.textContent = `${unresolved.length + duplicate.length} to fix`;

  const rowsUnresolved = unresolved.map(u =>
    `<div class="bib-item" data-file="${escapeAttr(u.file)}" onclick="jumpToBibIssue(this.dataset.file, ${u.line})">
       <span class="bib-key">${escapeHtml(u.key)}</span>
       <span class="bib-note">no .bib entry</span>
       <span class="bib-loc">${escapeHtml(u.file)}:${u.line}</span>
     </div>`).join("");

  const rowsDuplicate = duplicate.map(dup =>
    dup.locations.map((loc, idx) =>
      `<div class="bib-item" data-file="${escapeAttr(loc.file)}" onclick="jumpToBibIssue(this.dataset.file, ${loc.line})">
         <span class="bib-key">${escapeHtml(dup.key)}</span>
         <span class="bib-note">${idx === 0 ? "kept" : "shadowed"} · ${dup.count}×</span>
         <span class="bib-loc">${escapeHtml(loc.file)}:${loc.line}</span>
       </div>`).join("")).join("");

  const rowsUnused = unused.map(u =>
    `<div class="bib-item" data-file="${escapeAttr(u.file)}" onclick="jumpToBibIssue(this.dataset.file, ${u.line})">
       <span class="bib-key">${escapeHtml(u.key)}</span>
       <span class="bib-note">never cited</span>
       <span class="bib-loc">${escapeHtml(u.file)}:${u.line}</span>
       <button class="bib-rm" title="Comment out this entry (reversible)"
               data-key="${escapeAttr(u.key)}" onclick="event.stopPropagation();bibRemoveUnused([this.dataset.key])">comment out</button>
     </div>`).join("");

  let html = "";
  if (unresolved.length)
    html += `<div class="bib-section">Unresolved <span class="bib-sec-count unresolved">${unresolved.length}</span></div>` + rowsUnresolved;
  if (duplicate.length)
    html += `<div class="bib-section">Duplicate keys <span class="bib-sec-count duplicate">${duplicate.length}</span></div>` + rowsDuplicate;
  if (unused.length)
    html += `<div class="bib-section">Unused${d.nocite_all ? " (skipped)" : ""} <span class="bib-sec-count unused">${unused.length}</span>`
          + (d.nocite_all ? "" : `<span style="flex:1"></span><button class="bib-rm-all" onclick="bibRemoveAllUnused()">Comment out all</button>`)
          + `</div>` + rowsUnused;
  list.innerHTML = html;
}

export async function jumpToBibIssue(file, line) {
  if (file !== currentFile) await openFile(file);
  const lineNo = Math.max(0, (line | 0) - 1);
  setTimeout(() => {
    CM.setCursor(lineNo, 0);
    CM.scrollIntoView({ line: lineNo, ch: 0 }, 120);
    CM.focus();
    CM.addLineClass(lineNo, "background", "cm-synctex-jump");
    setTimeout(() => CM.removeLineClass(lineNo, "background", "cm-synctex-jump"), 1200);
  }, file !== currentFile ? 200 : 0);
  document.getElementById("bib-panel").classList.remove("open");
}

// v4.9.2 — Remove-unused (bib-audit phase 2, piece 2). "Remove" = comment out
// (prefix each line with %), reversible, and the backend backs up the .bib to
// .texlocal-bibbak/ first. Both a bulk "Comment out all" and per-row buttons
// route through bibRemoveUnused(keys); the backend re-verifies each key is
// still uncited before touching it.
export function bibRemoveAllUnused() {
  const keys = ((_lastBibAudit && _lastBibAudit.unused) || []).map(u => u.key);
  bibRemoveUnused(keys);
}
async function bibRemoveUnused(keys) {
  if (!currentProject || !keys || !keys.length) return;
  const many = keys.length > 1;
  const msg = many
    ? `Comment out ${keys.length} unused entries?\n\nEach is prefixed with % in the .bib (reversible), and a backup is saved to .texlocal-bibbak/ first.`
    : `Comment out "${keys[0]}"?\n\nIt's prefixed with % in the .bib (reversible); a backup is saved first.`;
  if (!confirm(msg)) return;
  // If a .bib is open in the editor, flush any pending edit and cancel the
  // debounced autosave first — otherwise a stale buffer could re-save over the
  // server-side comment-out.
  const bibOpen = currentFile && currentFile.toLowerCase().endsWith(".bib");
  if (bibOpen) { clearTimeout(saveTimer); await saveCurrentFile(); }
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/bib-remove-unused`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
    if (d.reason === "nocite_all") {
      _bibToast("\\nocite{*} in use — nothing is unused");
    } else {
      const n = d.commented_count || 0;
      _bibToast(`Commented out ${n} entr${n === 1 ? "y" : "ies"} · backup in .texlocal-bibbak/`);
    }
    // Reload the open .bib so the editor shows the commented version, then
    // refresh caches (autocomplete + linter + badge) and repaint the panel.
    // v4.9.4 — was openFile(currentFile). openFile's first act is an
    // unconditional saveCurrentFile(), which pushed the STALE (pre-comment)
    // buffer back over the .bib the server had just commented — silently
    // undoing the remove while the toast claimed success. Reload from disk
    // WITHOUT saving instead (same trap githubPull already avoids).
    if (bibOpen) await _reloadCurrentFileFromDisk();
    await loadCiteData();
    loadBibAuditUI();
  } catch (e) {
    _bibToast("Remove failed: " + e.message);
  }
}
// Small transient toast inside the bib panel (no global toast helper exists).
function _bibToast(msg) {
  const panel = document.getElementById("bib-panel");
  if (!panel) return;
  panel.querySelectorAll(".bib-toast").forEach(n => n.remove());
  const t = document.createElement("div");
  t.className = "bib-toast";
  t.textContent = msg;
  panel.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

// v4.9.0 — Compile-log breadcrumb (bib-audit phase 2, piece 1). Reuses the
// same /bib-audit scan; prepends one line onto the already-rendered log. Cheap
// enough to fetch per compile (same profile as the badge refresh). Failures
// are swallowed silently — a breadcrumb is a nice-to-have, never a blocker.
export async function _appendBibAuditBreadcrumb() {
  if (!currentProject) return;
  const logEl = document.getElementById("log-content");
  if (!logEl) return;
  let d;
  try { d = await _fetchBibAudit(); } catch (_) { return; }
  if (!d) return;
  const c = d.counts || {};
  const parts = [];
  if (c.unresolved) parts.push(`${c.unresolved} unresolved`);
  if (c.duplicate)  parts.push(`${c.duplicate} duplicate`);
  if (c.unused)     parts.push(`${c.unused} unused`);
  let line;
  if (parts.length) {
    line = `[bib audit] ${parts.join(" \u00b7 ")}`;
    if (c.unresolved || c.duplicate) line += "  \u2014 open the Bibliography panel to fix";
    if (d.nocite_all)                line += "  (\\nocite{*}: unused check skipped)";
  } else {
    line = "[bib audit] \u2713 no citation issues";
  }
  // Prepend as its own top line. Guard against stacking if somehow re-run
  // against a log we already annotated (belt-and-braces; compile() resets
  // log-content from data.log each run, so this normally won't trigger).
  const cur = logEl.textContent || "";
  logEl.textContent = cur.startsWith("[bib audit]")
    ? line + "\n" + cur.slice(cur.indexOf("\n") + 1)
    : line + "\n" + cur;
}

// v4.4.0 — DOCUMENT OUTLINE ─────────────────────────────────────────
// v5.0.0-beta.0.0 — Popover
export function toggleOutlinePanel(e){ _togglePopover(e, { panelId: "outline-panel", btnId: "outline-toggle-btn", width: 360, onOpen: renderOutlinePanel }); }

const _OL_LEVEL_LABEL = { chapter: "chapter", section: "section", subsection: "subsection", subsubsection: "subsub" };
const _OL_INDENT      = { chapter: 0, section: 1, subsection: 2, subsubsection: 3 };

export async function renderOutlinePanel() {
  const list = document.getElementById("ol-list");
  const cnt  = document.getElementById("ol-count");
  if (!currentProject) { list.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:12px">No project open.</div>'; return; }
  list.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:12px">Scanning…</div>';
  try {
    const res  = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/outline`);
    const data = await res.json();
    if (!data.length) {
      list.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:12px">No sections found.</div>';
      cnt.textContent = ""; return;
    }
    cnt.textContent = data.length + " entries";
    const frag = document.createDocumentFragment();
    data.forEach(item => {
      const div = document.createElement("div");
      div.className = `ol-row ol-indent-${_OL_INDENT[item.level] || 0}`;
      // v5.7.1 (#3, codex High) — section titles come from editable .tex source,
      // so build these with textContent/title (DOM) instead of innerHTML. An
      // apostrophe/quote/angle-bracket/handler in a \section title used to reach
      // an HTML sink here.
      const _lvl = document.createElement("span");
      _lvl.className = "ol-level";
      _lvl.textContent = _OL_LEVEL_LABEL[item.level] || item.level;
      const _ttl = document.createElement("span");
      _ttl.className = "ol-title";
      _ttl.title = item.title || "";
      _ttl.textContent = item.title || "(untitled)";
      const _fl = document.createElement("span");
      _fl.className = "ol-file";
      _fl.title = item.file || "";
      _fl.textContent = (item.file || "").split("/").pop();
      div.append(_lvl, _ttl, _fl);
      div.addEventListener("click", async () => {
        await openFile(item.file);
        // v4.7.10 — /outline now returns 1-based lines (was 0-based); convert
        // to CodeMirror's 0-based index here.
        CM.setCursor(item.line - 1, 0);
        CM.scrollIntoView({ line: item.line - 1, ch: 0 }, 80);
        CM.focus();
      });
      frag.appendChild(div);
    });
    list.innerHTML = "";
    list.appendChild(frag);
  } catch (err) {
    list.innerHTML = `<div style="padding:12px;color:var(--error);font-size:12px">Error: ${err.message}</div>`;
  }
}


// v5.0.0-beta.0.0 — Popover
export function toggleTodoPanel(e){ _togglePopover(e, { panelId: "todo-panel", btnId: "todo-toggle-btn", width: 420, onOpen: loadTodosUI }); }

// ── v3.2.3 — WORD-COUNT-PER-CHAPTER GOALS ───────────────────────
// State: goalsData = { goals: {path: target}, counts: {path: words} }
// The panel lists files. Default view = only files with a goal set.
// Toggle "Show all" to inline-set new goals on any .tex file.
//
// Persistence flow: user edits a number → blur fires → POST /goals
// with the full updated map → server overwrites .texlocal-goals.json.
let goalsData = { goals: {}, counts: {} };

export async function loadGoalsUI() {
  const list = document.getElementById("gp-list");
  if (!currentProject) {
    list.innerHTML = '<div class="gp-empty">Open a project first</div>';
    return;
  }
  list.innerHTML = '<div class="gp-empty">Scanning word counts…</div>';
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/goals`);
    const d = await r.json();
    goalsData = { goals: d.goals || {}, counts: d.counts || {} };
  } catch (_) {
    goalsData = { goals: {}, counts: {} };
  }
  renderGoalsPanel();
}

export function renderGoalsPanel() {
  const list    = document.getElementById("gp-list");
  const showAll = document.getElementById("gp-show-all").checked;
  // Decide which files to show
  const allPaths = Object.keys(goalsData.counts).sort();
  const visible  = showAll
    ? allPaths
    : Object.keys(goalsData.goals).sort();
  if (!visible.length) {
    list.innerHTML = `<div class="gp-empty">
      ${showAll
        ? 'No .tex files in this project'
        : 'No goals set yet — toggle "Show all files" above to set one'}
    </div>`;
    _updateGoalsFooter();
    return;
  }
  // Build with data-path attributes; click and blur handlers are wired after
  // innerHTML so we avoid double-escaping JS string literals through HTML.
  list.innerHTML = visible.map(p => {
    const count  = goalsData.counts[p] || 0;
    const target = goalsData.goals[p]  || 0;
    const pct    = target > 0 ? Math.min(100, (count / target) * 100) : 0;
    const cls    = target > 0 && count >= target
      ? (count > target * 1.1 ? "over" : "full")
      : "";
    return `<div class="gp-row" data-path="${_esc(p)}">
      <span class="gp-name" data-path="${_esc(p)}">${_esc(p)}</span>
      <span class="gp-count">${count.toLocaleString()}</span>
      <input class="gp-target" type="number" min="0" placeholder="–" value="${target || ""}" data-path="${_esc(p)}">
      <div class="gp-bar-wrap"><div class="gp-bar ${cls}" style="width:${pct}%"></div></div>
    </div>`;
  }).join("");
  list.querySelectorAll(".gp-name").forEach(el => {
    el.addEventListener("click", () => {
      openFile(el.dataset.path);
      toggleGoalsPanel();
    });
  });
  list.querySelectorAll(".gp-target").forEach(inp => {
    inp.addEventListener("blur", () => onGoalChange(inp.dataset.path, inp.value));
    // Pressing Enter inside the input commits + blurs.
    inp.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); inp.blur(); }
    });
  });
  _updateGoalsFooter();
}

function _updateGoalsFooter() {
  // Footer aggregates across the files that have a goal set (regardless of
  // show-all state) — that's the meaningful "thesis progress" number.
  let tCount = 0, tTarget = 0;
  for (const p of Object.keys(goalsData.goals)) {
    tCount  += goalsData.counts[p] || 0;
    tTarget += goalsData.goals[p]  || 0;
  }
  document.getElementById("gp-foot-count").textContent  = tCount.toLocaleString();
  document.getElementById("gp-foot-target").textContent = tTarget.toLocaleString();
  // Header subtitle: short progress summary
  const sub = document.getElementById("gp-totals");
  if (tTarget > 0) {
    const pct = Math.round((tCount / tTarget) * 100);
    sub.textContent = `· ${pct}% (${tCount.toLocaleString()}/${tTarget.toLocaleString()})`;
  } else {
    sub.textContent = "";
  }
}

async function onGoalChange(path, raw) {
  // Empty / 0 clears the goal entry. We send the FULL updated map so the
  // server can overwrite atomically — that way a stale tab can't resurrect
  // a deleted goal.
  const n = parseInt(raw, 10);
  if (!n || n <= 0) {
    delete goalsData.goals[path];
  } else {
    goalsData.goals[path] = n;
  }
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/goals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goals: goalsData.goals }),
    });
    if (!r.ok) throw new Error("save failed");
    const d = await r.json();
    if (d.goals) goalsData.goals = d.goals;
  } catch (_) {
    // Soft-fail — keep the in-memory state, just no persistence this round.
  }
  renderGoalsPanel();
}

// v5.0.0-beta.0.0 — Popover
export function toggleGoalsPanel(e){ _togglePopover(e, { panelId: "goals-panel", btnId: "goals-toggle-btn", width: 460, onOpen: loadGoalsUI }); }

// ── v3.2.3 — RECENT COMPILE LOG HISTORY ─────────────────────────
// Stored per-project in localStorage. Each entry:
//   { ts, elapsed, ok, errCount, warnCount, draft, partial, log }
// Logs are capped at 50KB to keep localStorage under quota (10 entries × 50KB
// = 500KB worst case). Truncated logs get a "... [truncated]" suffix.
const HISTORY_MAX_LEN = 10;
const HISTORY_LOG_CAP = 50 * 1024;
export let _historyActiveIdx = -1;
export function _ssHistoryActiveIdx(v){ _historyActiveIdx = v; }  // v5.0.0-beta.4.0 — Phase 4 ESM prep (see editor.js)

export function _historyKey() {
  return currentProject ? `texlocal_compile_history_${currentProject}` : null;
}

export function loadCompileHistory() {
  const k = _historyKey();
  if (!k) return [];
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function saveCompileHistory(arr) {
  const k = _historyKey();
  if (!k) return;
  try {
    localStorage.setItem(k, JSON.stringify(arr));
  } catch (e) {
    // Quota exceeded — drop the oldest half and retry once.
    try {
      const trimmed = arr.slice(0, Math.max(3, Math.floor(arr.length / 2)));
      localStorage.setItem(k, JSON.stringify(trimmed));
    } catch (_) { /* give up silently */ }
  }
}

export function recordCompileToHistory({ log, ok, elapsed, parsed }) {
  if (!currentProject) return;
  let logTrunc = log || "";
  if (logTrunc.length > HISTORY_LOG_CAP) {
    logTrunc = logTrunc.slice(0, HISTORY_LOG_CAP) + "\n... [truncated]";
  }
  const entry = {
    ts:        Date.now(),
    elapsed:   elapsed,
    ok:        !!ok,
    errCount:  (parsed && parsed.errors)   ? parsed.errors.length   : 0,
    warnCount: (parsed && parsed.warnings) ? parsed.warnings.length : 0,
    draft:     !!draftMode,
    partial:   selectedIncludes.length > 0
                 && availableIncludes.length > 0
                 && selectedIncludes.length < availableIncludes.length,
    log:       logTrunc,
  };
  const arr = loadCompileHistory();
  arr.unshift(entry);                       // newest first
  if (arr.length > HISTORY_MAX_LEN) arr.length = HISTORY_MAX_LEN;
  saveCompileHistory(arr);
  // If panel is open, refresh display
  if (document.getElementById("history-panel").classList.contains("open")) {
    renderHistoryPanel();
  }
}
