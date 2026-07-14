// static/quickopen.js — Quick Open (Ctrl+P) fuzzy file switcher.
// Extracted from editor.js (2026-07-06, no version bump). ESM module.
// The global Ctrl+P keydown lives in editor.js core (shared handler) and calls
// openQuickOpen(); the input's own listeners are wired via _initQuickOpen() (boot.js).
import { CM, _esc, cmEditor, currentProject } from "editor";
import { openFile } from "files";

// ── v3.2.3 — QUICK OPEN (Ctrl+P) ────────────────────────────────
// File cache is refreshed by loadFiles(). Matching is a simple subsequence
// scorer: each query character must appear in order in the candidate; we
// reward consecutive matches, basename hits, and earlier hit positions.
// Top-50 are shown to keep the list snappy on big projects.
let quickOpenFiles  = [];   // current project's file list (filtered)
let qoActiveIdx     = 0;
let qoCurrentMatches = [];

export function setQuickOpenFiles(files) {
  // Called from loadFiles after fetching. We keep all non-generated files
  // (images included — quick-open is a navigator, not a tex-only switcher).
  quickOpenFiles = (files || []).slice();
}

function _qoFuzzyScore(query, text) {
  // Returns { score, hits: [indices] } or null if not a subsequence match.
  // Higher score = better. Bonuses for: consecutive char streaks, hits inside
  // the basename portion, and hits at position 0 of the basename.
  if (!query) return { score: 0, hits: [] };
  const q   = query.toLowerCase();
  const t   = text.toLowerCase();
  const baseStart = text.lastIndexOf("/") + 1;
  let ti = 0, qi = 0, score = 0, streak = 0;
  const hits = [];
  while (qi < q.length && ti < t.length) {
    if (t[ti] === q[qi]) {
      hits.push(ti);
      let bonus = 1;
      if (ti >= baseStart) bonus += 2;       // basename hits weigh more
      if (ti === baseStart) bonus += 3;      // very first char of basename
      bonus += streak;                       // reward consecutive matches
      score += bonus;
      streak++;
      qi++;
    } else {
      streak = 0;
    }
    ti++;
  }
  if (qi < q.length) return null;
  // Shorter paths break ties — they're usually more relevant.
  score -= text.length * 0.02;
  return { score, hits };
}

function _qoRenderHits(text, hits) {
  // Wrap matched chars in <span class="qo-hit">. Hits is sorted asc.
  if (!hits || !hits.length) return _esc(text);
  let out = "", cursor = 0;
  for (const i of hits) {
    if (i > cursor) out += _esc(text.slice(cursor, i));
    out += `<span class="qo-hit">${_esc(text[i])}</span>`;
    cursor = i + 1;
  }
  if (cursor < text.length) out += _esc(text.slice(cursor));
  return out;
}


function _qoRebuild() {
  const q = document.getElementById("qo-input").value.trim();
  let matches;
  if (!q) {
    // Empty query — show recent files (just the first 50) so the modal
    // is still useful as a "what was I working on" jumper.
    matches = quickOpenFiles.slice(0, 50).map(f => ({ path: f, score: 0, hits: [] }));
  } else {
    matches = [];
    for (const f of quickOpenFiles) {
      const r = _qoFuzzyScore(q, f);
      if (r) matches.push({ path: f, score: r.score, hits: r.hits });
    }
    matches.sort((a, b) => b.score - a.score);
    matches = matches.slice(0, 50);
  }
  qoCurrentMatches = matches;
  qoActiveIdx = 0;
  _qoRenderList();
}

function _qoRenderList() {
  const list = document.getElementById("qo-list");
  if (!qoCurrentMatches.length) {
    list.innerHTML = `<div class="qo-empty">No files match</div>`;
    return;
  }
  list.innerHTML = qoCurrentMatches.map((m, i) => {
    const slash = m.path.lastIndexOf("/");
    const dir   = slash >= 0 ? m.path.slice(0, slash) : "";
    const base  = slash >= 0 ? m.path.slice(slash + 1) : m.path;
    // Re-score the hits relative to the slice. Easier: just render the full
    // path with hits, then place basename on left and dir on right.
    const baseHits = m.hits
      .filter(h => h > slash)
      .map(h => h - slash - 1);
    return `<div class="qo-item ${i === qoActiveIdx ? "active" : ""}" data-idx="${i}">
      <span class="qo-name">${_qoRenderHits(base, baseHits)}</span>
      ${dir ? `<span class="qo-path">${_esc(dir)}</span>` : ""}
    </div>`;
  }).join("");
  // Wire clicks and ensure active item is in view
  list.querySelectorAll(".qo-item").forEach(el => {
    el.addEventListener("click", () => {
      qoActiveIdx = parseInt(el.dataset.idx, 10);
      _qoOpenSelected();
    });
  });
  const activeEl = list.querySelector(".qo-item.active");
  if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
}

function _qoOpenSelected() {
  const m = qoCurrentMatches[qoActiveIdx];
  if (!m) return;
  closeQuickOpen();
  // Re-use the existing openFile path so all the same side-effects fire
  // (tabs, cite cache reload, autoflag, etc.).
  openFile(m.path);
}

export function openQuickOpen() {
  if (!currentProject) return;
  const overlay = document.getElementById("quick-open-overlay");
  const input   = document.getElementById("qo-input");
  overlay.classList.add("open");
  input.value = "";
  _qoRebuild();
  // Defer focus until display:flex has applied — otherwise focus() is a no-op.
  setTimeout(() => input.focus(), 0);
}

export function closeQuickOpen() {
  document.getElementById("quick-open-overlay").classList.remove("open");
  // Return focus to the editor so typing resumes naturally.
  if (cmEditor) CM.focus();
}

// Single keydown handler on the input drives navigation. Bound once via
// inline addEventListener in init() (after DOM is ready).
function _qoOnInputKey(e) {
  if (e.key === "Escape") { e.preventDefault(); closeQuickOpen(); return; }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (qoCurrentMatches.length) {
      qoActiveIdx = (qoActiveIdx + 1) % qoCurrentMatches.length;
      _qoRenderList();
    }
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    if (qoCurrentMatches.length) {
      qoActiveIdx = (qoActiveIdx - 1 + qoCurrentMatches.length) % qoCurrentMatches.length;
      _qoRenderList();
    }
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    _qoOpenSelected();
    return;
  }
}


// v-refactor 2026-07-06 — bind quick-open input handlers; called by boot.js after DOM ready
export function _initQuickOpen() {
  const inp = document.getElementById("qo-input");
  if (inp) {
    inp.addEventListener("input", _qoRebuild);
    inp.addEventListener("keydown", _qoOnInputKey);
  }
}
