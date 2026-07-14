import { CM, _copyFallback, _esc, compile, escapeHtml } from "editor";
import { openPackageManager } from "panels";

// static/errors.js — TexLocal Phase 3 module split (v5.0.0-beta.3.0)
// Lifted verbatim from editor.js (error markers + panel + logs cluster).
// Interim shared-scope: a classic <script defer>, NOT an ES module — shares
// editor.js's global scope (module-level state + the global CM adapter facade
// + _esc). Loads AFTER editor.js and BEFORE boot.js. First CM-heavy module of
// Phase 3, but touches CodeMirror only through CM.* (gutter markers/line
// classes/cursor) — Phase 1 facade containment holds, so it moved cleanly.

// ── ERROR MARKERS + PANEL ────────────────────────────────────
let lastParsedLog = null;   // เก็บ parsed result ล่าสุดไว้เปิด Logs panel ได้เสมอ
export function _ssLastParsedLog(v){ lastParsedLog = v; }  // v5.0.0-beta.4.0 — Phase 4 ESM prep (see editor.js)
let logsActiveTab = "all";  // tab ที่เลือกอยู่ใน Logs panel
let errorPanelPdfState = { available: false, fresh: false };

export function parseLatexErrors(log) {
  const errors = [], warnings = [], infos = [];
  const lines = log.split("\n");
  // v3.3.0 — Missing-package detection. Tracks packages/classes the user
  // doesn't have installed; surfaced as a dedicated card with an `mpm
  // --install=<pkg>` copy button. Dedup by name so spam from a hundred
  // re-runs doesn't compound. We deliberately collect AS WELL AS leaving
  // the original error in `errors[]` — the user sees both "package missing"
  // (with install hint) AND the raw "! LaTeX Error" message (for context).
  const missingPackages = [];
  const seenPkg = new Set();
  const addPkg = (name, kind) => {
    if (!name) return;
    // Strip path prefix (rare; defensive) and extension.
    const stem = name.replace(/^.*[\\\/]/, "").replace(/\.(sty|cls)$/i, "");
    if (!stem || seenPkg.has(stem)) return;
    seenPkg.add(stem);
    missingPackages.push({ name: stem, kind });
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];

    // v3.3.0 — Missing-package patterns. Three forms seen in the wild:
    //   `! LaTeX Error: File `foo.sty' not found.`     (MiKTeX, TeX Live)
    //   `! Package foo Error: ... bar.sty not found.`  (some packages)
    //   `! I can't find file `foo'.`                   (older TeX, no ext)
    // We scan separately from Patterns A/B so the missing-package card can
    // still appear even if the surrounding message also matches one of those
    // (it almost always does — the "! LaTeX Error" line is also Pattern B).
    let mPkg = l.match(/^!\s*LaTeX\s+Error:\s*File\s+[`'"]([^'"`]+\.(?:sty|cls))['"`]\s+not\s+found/i);
    if (mPkg) addPkg(mPkg[1], /\.cls$/i.test(mPkg[1]) ? "class" : "package");
    else {
      mPkg = l.match(/^!\s*I\s+can'?t\s+find\s+file\s+[`'"]([^'"`]+?)(?:\.(?:sty|cls))?['"`]/i);
      if (mPkg) addPkg(mPkg[1], "package");
    }

    // Pattern A: ./file.tex:LINE: message
    const mA = l.match(/^((?:[A-Za-z]:)?(?:\.\/)?[^:\n]+\.tex):(\d+):\s*(.+)$/);   // v4.9.10 (B5) — optional drive prefix so a Windows absolute path (C:\...\ch.tex:42:) is attributed to a file/line, not skipped (the drive-letter colon used to defeat [^:\n]+)
    if (mA) {
      const msg = mA[3].trim();
      if (msg && !msg.startsWith("(")) {
        errors.push({ file: mA[1].replace(/^\.\//, "").replace(/\\/g, "/"), line: parseInt(mA[2]) - 1, msg });   // v4.9.10 (B5) — \ → / so an abs Windows path matches the app path style
      }
      continue;
    }

    // Pattern B: ! Error → look ahead for l.N
    const mB = l.match(/^! (.+)$/);
    if (mB) {
      let lineNo = -1;
      for (let j = i + 1; j < Math.min(i + 15, lines.length); j++) {
        const mL = lines[j].match(/^l\.(\d+)/);
        if (mL) { lineNo = parseInt(mL[1]) - 1; break; }
      }
      errors.push({ file: null, line: lineNo, msg: mB[1].trim() });
      continue;
    }

    // Pattern C: Overfull / Underfull \hbox
    const mOF = l.match(/^((?:Over|Under)full \\[hv]box[^)]*\))\s+(?:detected at line (\d+)|in paragraph at lines (\d+))/i);
    if (mOF) {
      const lineNo = parseInt(mOF[2] || mOF[3]) - 1;
      warnings.push({ file: null, line: lineNo, msg: mOF[0].trim() });
      continue;
    }

    // Pattern D: LaTeX Warning / Package Warning ... on input line N
    const mW = l.match(/(?:LaTeX|Package\s+\S+)\s+Warning[:\s]+(.*?)(?:\s+on input line (\d+))?\.?\s*$/i);
    if (mW) {
      const msg = mW[1].trim() || l.trim();
      const lineNo = mW[2] ? parseInt(mW[2]) - 1 : -1;
      warnings.push({ file: null, line: lineNo, msg });
      continue;
    }

    // Pattern E: Info messages
    const mI = l.match(/^(?:LaTeX|Package\s+\S+)\s+(?:Font\s+)?Info[:\s]+(.+)$/i);
    if (mI) {
      infos.push({ file: null, line: -1, msg: mI[1].trim() });
      continue;
    }
  }

  const dedup = arr => {
    const seen = new Set();
    return arr.filter(e => {
      const key = `${e.file}:${e.line}:${e.msg.slice(0,60)}`;
      if (seen.has(key)) return false; seen.add(key); return true;
    });
  };
  return { errors: dedup(errors), warnings: dedup(warnings), infos: dedup(infos),
           missingPackages };   // v3.3.0
}

// v5.0.0-beta.0.0 — Unified error/logs card renderer (Phase 0 of the editor.js
// modularization). showErrorPanel (compile "Errors" pane) and renderLogsCards
// ("Logs" pane) built byte-identical grouped cards — same x N badge, chevron,
// lazily-populated occurrence rows and jump-to-line wiring — differing ONLY in
// how each derived the severity class + icon (Logs also has an "info" kind;
// Errors doesn't). Both now assemble their items, and call this one renderer.
//
// `items` arrive in one of two shapes: Errors-pane items carry {isError}; Logs
// items carry {kind: "error"|"warn"|"info"}. We synthesize `.isError` from
// `kind` before grouping (because _errorGroupKey keys on isError) and derive the
// class/icon from `kind` when present, else from isError — reproducing both
// callers' original behaviour exactly. Container clearing / empty-state stay in
// the callers (they differ: Errors appends after missing-package cards; Logs
// clears + shows a "No items" placeholder).
function renderErrorCards(items, cards) {
  const norm = items.map(it => (it.kind !== undefined ? { ...it, isError: it.kind === "error" } : it));
  const groups = _groupErrorItems(norm);
  groups.forEach(group => {
    const rep = group.rep;
    const n   = group.occurrences.length;
    const kind = rep.kind || (rep.isError ? "error" : "warn");
    const cls  = kind === "error" ? "err-error" : kind === "info" ? "err-info" : "err-warn";
    const icon = kind === "error" ? "✕" : kind === "info" ? "ℹ" : "!";
    const card = document.createElement("div");
    card.className = `err-card ${cls}`;
    const locText = [rep.file, rep.line >= 0 ? `line ${rep.line + 1}` : null].filter(Boolean).join(", ");

    let headerExtra = "";
    if (n > 1) {
      headerExtra = `<span class="err-count-badge" title="${n} occurrences — click to expand">×${n}</span>
                     <button class="err-chev" title="Show all occurrences" aria-label="Expand occurrences">▶</button>`;
    } else if (rep.line >= 0) {
      headerExtra = `<button class="err-nav" title="Jump to line">↗</button>`;
    }

    card.innerHTML = `
      <div class="err-header">
        <span class="err-icon">${icon}</span>
        <span class="err-msg">${rep.msg}</span>
        ${headerExtra}
      </div>
      ${locText ? `<div class="err-loc">${locText}${n > 1 ? ` · +${n - 1} more` : ""}</div>` : ""}
      ${n > 1 ? `<div class="err-occurrences"></div>` : ""}
    `;

    if (n === 1 && rep.line >= 0) {
      card.querySelector(".err-nav").onclick = () => {
        CM.setCursor(rep.line, 0);
        CM.scrollIntoView({ line: rep.line, ch: 0 }, 80);
        CM.focus();
      };
    } else if (n > 1) {
      // Populate the occurrences list lazily — only build DOM rows when first
      // expanded (a missing-\def cascade can produce 50+ occurrences).
      const occList = card.querySelector(".err-occurrences");
      const chev    = card.querySelector(".err-chev");
      const badge   = card.querySelector(".err-count-badge");
      let populated = false;
      const populate = () => {
        if (populated) return;
        populated = true;
        group.occurrences.forEach(occ => {
          const row = document.createElement("button");
          row.className = "err-occ-row";
          row.type = "button";
          const where = [occ.file, occ.line >= 0 ? `line ${occ.line + 1}` : "(no line)"]
            .filter(Boolean).join(", ");
          row.textContent = `↗  ${where}`;
          if (occ.line >= 0) {
            row.onclick = () => {
              CM.setCursor(occ.line, 0);
              CM.scrollIntoView({ line: occ.line, ch: 0 }, 80);
              CM.focus();
            };
          } else {
            row.disabled = true;
            row.style.cursor = "default";
          }
          occList.appendChild(row);
        });
      };
      const toggle = (e) => {
        e.stopPropagation();
        populate();
        card.classList.toggle("err-expanded");
      };
      if (chev)  chev.onclick  = toggle;
      if (badge) badge.onclick = toggle;
    }
    cards.appendChild(card);
  });
}

export function showErrorPanel({ errors, warnings }, pdfState = {}) {
  const panel = document.getElementById("error-panel");
  const title = document.getElementById("pdf-pane-title");
  errorPanelPdfState = {
    available: Boolean(pdfState.available),
    fresh: Boolean(pdfState.fresh),
  };

  document.getElementById("pdf-canvas-container").style.display = "none";
  document.getElementById("pdf-placeholder").style.display = "none";

  const errCount  = errors.length;
  const warnCount = warnings.length;

  panel.innerHTML = `
    <div class="err-panel-header" id="err-panel-hdr">
      <span class="err-summary">
        ${errCount  ? `<span style="color:var(--red)">✕ ${errCount} error${errCount>1?"s":""}</span>` : ""}
        ${errCount && warnCount ? "<span style='color:var(--muted)'>&nbsp;·&nbsp;</span>" : ""}
        ${warnCount ? `<span style="color:var(--yellow)">! ${warnCount} warning${warnCount>1?"s":""}</span>` : ""}
      </span>
      ${errorPanelPdfState.available ? `<button type="button" class="err-view-pdf">${errorPanelPdfState.fresh ? "View PDF" : "View previous PDF"}</button>` : ""}
    </div>
    <div class="err-cards" id="err-cards"></div>
  `;

  // ใช้ position:absolute inset:0 ใน .pdf-content wrapper — ไม่ต้องวัด height เอง
  panel.classList.add("visible");

  title.textContent = "Compile Errors";
  const viewPdf = panel.querySelector(".err-view-pdf");
  if (viewPdf) viewPdf.addEventListener("click", () => hideErrorPanel({ restorePdf: true }));

  const cards = document.getElementById("err-cards");

  // v3.3.0 — Missing-package install hints at the very top, before raw
  // errors/warnings. These are the most actionable items in the panel:
  // the rest of the cascade (Undefined control sequence, etc.) is almost
  // always downstream of the missing .sty file, so once the user clicks
  // Install the rest typically vanishes.
  const missing = (lastParsedLog && lastParsedLog.missingPackages) || [];
  missing.forEach(pkg => {
    const card = document.createElement("div");
    card.className = "err-card err-missing-pkg";
    // MiKTeX users get `mpm --install=<pkg>`; TeX Live users get
    // `tlmgr install <pkg>`. We show MiKTeX as the primary (Pol's setup)
    // and TeX Live as the secondary tip. Class files (.cls) use the same
    // commands — pkgname without extension is what the installers expect.
    const cmdMiktex = `mpm --install=${pkg.name}`;
    card.innerHTML = `
      <div class="err-header">
        <span class="err-icon">📦</span>
        <span class="err-msg">Missing ${pkg.kind}: <b>${escapeHtml(pkg.name)}</b><br>
          <span style="color:var(--muted);font-family:var(--font-ui);font-size:11px">
            Install via MiKTeX Package Manager — or <code style="font-family:var(--font-code)">tlmgr install ${escapeHtml(pkg.name)}</code> on TeX Live.
          </span>
        </span>
      </div>
      <div class="err-mpkg-row">
        <code class="err-mpkg-cmd">${escapeHtml(cmdMiktex)}</code>
        <button class="err-mpkg-install" type="button" title="Open MiKTeX Console / TeX Live to install">📦 Open Manager</button>
        <button class="err-mpkg-copy" type="button">Copy</button>
      </div>
    `;
    // v4.4.0 — open the system package-manager GUI (MiKTeX Console / TeX Live)
    // so the user installs there, rather than shelling the installer in-app.
    card.querySelector(".err-mpkg-install").onclick = () => openPackageManager();
    const btn = card.querySelector(".err-mpkg-copy");
    btn.onclick = () => {
      // navigator.clipboard fails over http on some browsers; fallback to
      // a hidden textarea + execCommand("copy") which works everywhere.
      const txt = cmdMiktex;
      const ok = () => {
        btn.textContent = "Copied!"; btn.classList.add("copied");
        setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(ok, () => _copyFallback(txt, ok));
      } else {
        _copyFallback(txt, ok);
      }
    };
    cards.appendChild(card);
  });

  const allItems = [
    ...errors.map(e  => ({ ...e, isError: true  })),
    ...warnings.map(w => ({ ...w, isError: false }))
  ];

  // v5.0.0-beta.0.0 — render via the shared renderErrorCards (Phase 0). Errors-pane items
  // carry {isError}; the unified renderer derives severity class/icon from that.
  renderErrorCards(allItems, cards);
}

// v3.3.2 — Shape-based key generator for error grouping. Strips variable parts
// (line numbers in trailing "on input line NNN" / "at lines XXX-YYY" /
// "detected at line N") so two warnings with the same root cause at different
// lines collapse. Keeps the meaningful token (e.g. \foo) intact — distinct
// undefined sequences are different groups, not one mega-bucket.
function _errorGroupKey(item) {
  let key = (item.msg || "").trim();
  // Drop trailing line-number tails that LaTeX appends to warnings.
  key = key.replace(/\s+on input line\s+\d+\.?$/gi, "");
  key = key.replace(/\s+(?:at|in paragraph at)\s+lines?\s+\d+(?:-{1,2}\d+)?\.?$/gi, "");
  key = key.replace(/\s+detected at line\s+\d+\.?$/gi, "");
  // v3.3.2 — Defensive: strip line refs even if NOT at end of string. Some
  // pdflatex setups (and some package warnings) embed "l.NNN" or "line NNN"
  // mid-message — without these stripped, the same root cause at different
  // lines wouldn't collapse. We use \b boundaries so we don't eat actual
  // words containing "line" (e.g. "lineart").
  key = key.replace(/\s*\bl\.\d+\b/gi, "");
  key = key.replace(/\s+\bline\s+\d+\b/gi, "");
  key = key.replace(/\s+\blines?\s+\d+(?:[-–—]\d+)?\b/gi, "");
  // Collapse repeated whitespace introduced by stripping.
  key = key.replace(/\s+/g, " ").trim();
  // Trailing period is decorative — strip so "Foo." and "Foo" merge.
  key = key.replace(/\.+$/, "");
  // Severity is part of the key so an error and a warning with identical text
  // (rare but possible) stay separate.
  return `${item.isError ? "E" : "W"}|${key.toLowerCase()}`;
}

function _groupErrorItems(items) {
  // Map iteration is insertion-ordered so the first-seen group ends up first
  // in the rendered list — matches users' "fix the first error first" mental
  // model better than sorting by count.
  const groups = new Map();
  for (const item of items) {
    const key = _errorGroupKey(item);
    if (!groups.has(key)) {
      groups.set(key, { rep: item, occurrences: [] });
    }
    groups.get(key).occurrences.push(item);
  }
  // v3.3.2 diagnostic — helps confirm grouping path is live after refresh.
  // Console.debug is filtered out by default (won't spam regular browsing);
  // visible only when DevTools "Verbose" log level is on. Leave permanently —
  // tiny cost, big win for next-time-something-feels-off triage.
  try {
    const summary = [...groups.values()].map(g => `${g.occurrences.length}× "${(g.rep.msg||"").slice(0,32)}"`);
    console.debug("[err-group]", items.length, "items →", groups.size, "groups", summary);
  } catch (_) {}
  return [...groups.values()];
}

export function hideErrorPanel({ restorePdf = false } = {}) {
  const panel = document.getElementById("error-panel");
  panel.classList.remove("visible");
  panel.innerHTML = "";
  document.getElementById("pdf-pane-title").textContent = "PDF Preview";
  if (restorePdf) {
    const canvas = document.getElementById("pdf-canvas-container");
    const placeholder = document.getElementById("pdf-placeholder");
    if (errorPanelPdfState.available) {
      canvas.style.display = "flex";
      placeholder.style.display = "none";
    } else {
      canvas.style.display = "none";
      placeholder.style.display = "flex";
    }
  }
}

// ── LOGS PANEL ────────────────────────────────────────────────
export function updateLogsBadge(parsed) {
  const badge = document.getElementById("logs-btn-badge");
  if (!parsed) { badge.textContent = ""; badge.className = ""; return; }
  const e = parsed.errors.length, w = parsed.warnings.length, n = parsed.infos.length;
  const total = e + w + n;
  if (!total) { badge.textContent = ""; badge.className = ""; return; }
  if (e) {
    badge.textContent = `${e}E ${w}W`;
    badge.id = "logs-btn-badge"; badge.className = "b-err";
  } else if (w) {
    badge.textContent = `${w}W`;
    badge.id = "logs-btn-badge"; badge.className = "b-warn";
  } else {
    badge.textContent = `${n}`;
    badge.id = "logs-btn-badge"; badge.className = "";
  }
}

function renderLogsCards(items) {
  const cards = document.getElementById("logs-cards");
  if (!cards) return;
  cards.innerHTML = "";
  if (!items.length) {
    cards.innerHTML = '<div style="text-align:center;padding:32px;color:var(--muted);font-size:13px">No items</div>';
    return;
  }
  // v3.3.2 — Apply error-grouping here too. Logs panel renders the same data
  // as the Error panel but with All/Errors/Warnings/Info tabs; grouping logic
  // is identical. _errorGroupKey reads `.isError`, so we synthesize that from
  // `.kind` before grouping (an `info` kind counts as not-an-error so info
  // items group separately from a same-text warning, which is the right
  // behaviour because they have different severity colour anyway).
  // v5.0.0-beta.0.0 — render via the shared renderErrorCards (Phase 0). Logs items carry
  // {kind} (error/warn/info); the unified renderer synthesizes .isError for
  // grouping and derives severity class/icon from kind.
  renderErrorCards(items, cards);
}

export function showLogsPanel(parsed) {
  const panel = document.getElementById("logs-panel");
  const e = parsed.errors.map(x => ({ ...x, kind: "error" }));
  const w = parsed.warnings.map(x => ({ ...x, kind: "warn" }));
  const n = parsed.infos.map(x => ({ ...x, kind: "info" }));
  const allItems = [...e, ...w, ...n];

  const tabData = [
    { id: "all",     label: "All logs", items: allItems,  bclass: "" },
    { id: "errors",  label: "Errors",   items: e,         bclass: "b-err"  },
    { id: "warnings",label: "Warnings", items: w,         bclass: "b-warn" },
    { id: "infos",   label: "Info",     items: n,         bclass: "b-info" },
  ];

  panel.innerHTML = `
    <div class="logs-tabs">
      ${tabData.map(t => `
        <button type="button" data-logs-tab="${t.id}" class="logs-tab${logsActiveTab === t.id ? " active" : ""}">
          ${t.label}
          <span class="lbadge ${t.bclass}">${t.items.length}</span>
        </button>`).join("")}
      <button type="button" class="logs-close">✕</button>
    </div>
    <div class="logs-cards" id="logs-cards"></div>
  `;
  panel.classList.add("visible");

  panel.querySelectorAll("[data-logs-tab]").forEach(button => {
    button.addEventListener("click", () => {
      logsActiveTab = button.dataset.logsTab;
      showLogsPanel(lastParsedLog);
    });
  });
  panel.querySelector(".logs-close")?.addEventListener("click", hideLogsPanel);

  const activeTab = tabData.find(t => t.id === logsActiveTab) || tabData[0];
  renderLogsCards(activeTab.items);
}

export function hideLogsPanel() {
  const panel = document.getElementById("logs-panel");
  panel.classList.remove("visible");
  panel.innerHTML = "";
}

export function toggleLogsPanel() {
  const panel = document.getElementById("logs-panel");
  if (panel.classList.contains("visible")) {
    hideLogsPanel();
  } else {
    if (!lastParsedLog) return;
    showLogsPanel(lastParsedLog);
  }
}

export function clearErrorMarkers() {
  CM.clearGutter("cm-errors-gutter");
  CM.eachLine(lh => {
    CM.removeLineClass(lh, "background", "cm-error-line");
    CM.removeLineClass(lh, "background", "cm-warn-line");
  });
}

// v3.2.3 — Singleton tooltip reused across every marker. Created lazily on
// first hover so we don't add DOM nodes for users who never trigger a build.
let _markerTipEl = null;
function _ensureMarkerTip() {
  if (_markerTipEl) return _markerTipEl;
  _markerTipEl = document.createElement("div");
  _markerTipEl.className = "cm-marker-tooltip";
  document.body.appendChild(_markerTipEl);
  return _markerTipEl;
}
function _showMarkerTip(el, msg, isError) {
  const tip = _ensureMarkerTip();
  tip.className = "cm-marker-tooltip " + (isError ? "error" : "warn");
  tip.innerHTML = `<span class="tip-tag">${isError ? "ERROR" : "WARNING"}</span>${_esc(msg || "(no message)")}`;
  // Make visible first so offsetWidth/Height are measurable
  tip.style.display = "block";
  tip.style.left = "0px"; tip.style.top = "0px";
  const r = el.getBoundingClientRect();
  // Prefer to the right of the marker, vertically centered. If it would
  // overflow the right edge, flip to the left side.
  let left = r.right + 8;
  if (left + tip.offsetWidth + 8 > window.innerWidth) {
    left = Math.max(4, r.left - tip.offsetWidth - 8);
  }
  let top = r.top + r.height / 2 - tip.offsetHeight / 2;
  top = Math.max(4, Math.min(window.innerHeight - tip.offsetHeight - 4, top));
  tip.style.left = left + "px";
  tip.style.top  = top  + "px";
}
function _hideMarkerTip() {
  if (_markerTipEl) _markerTipEl.style.display = "none";
}

export function showErrorMarkers({ errors, warnings }) {
  clearErrorMarkers();
  const total = CM.lineCount();

  const addMarker = (lineNo, msg, isError) => {
    if (lineNo < 0 || lineNo >= total) return;
    const el = document.createElement("div");
    el.className = isError ? "cm-error-marker" : "cm-warn-marker";
    el.textContent = isError ? "✕" : "!";
    // Kept as a fallback if our styled tooltip ever fails to mount (e.g.
    // headless screenshot tooling). The custom tooltip below wins because
    // it fires on mouseenter instantly while title needs ~1s delay.
    el.title = msg || "";
    el.addEventListener("mouseenter", () => _showMarkerTip(el, msg, isError));
    el.addEventListener("mouseleave", _hideMarkerTip);
    el.onclick = () => {
      CM.setCursor(lineNo, 0);
      CM.scrollIntoView({ line: lineNo, ch: 0 }, 80);
      CM.focus();
    };
    CM.setGutterMarker(lineNo, "cm-errors-gutter", el);
    CM.addLineClass(lineNo, "background", isError ? "cm-error-line" : "cm-warn-line");
  };

  errors.forEach(e   => addMarker(e.line, e.msg, true));
  warnings.forEach(w => addMarker(w.line, w.msg, false));
}
