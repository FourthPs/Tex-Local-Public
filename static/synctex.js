import { CM, compile, currentFile, currentProject, mainFile } from "editor";
import { pdfDisplayedName, pdfScrollToPosition } from "pdfviewer";

// static/synctex.js — TexLocal Phase 3 module split (v5.0.0-beta.3.0)
// SyncTeX forward search (editor → PDF). Backward search already lives in pdfviewer.js (Phase 2).
// Interim shared-scope: a classic <script defer>, NOT an ES module — shares
// editor.js's global scope (module-level state + CM adapter facade + core
// state/helpers). Loads AFTER editor.js core and BEFORE boot.js. CM access is
// via the CM.* facade only (Phase 1 containment) — 0 raw cmEditor./CodeMirror.

// ── SYNCTEX FORWARD SEARCH ───────────────────────────────────
// Forward search: editor cursor → scroll PDF to the right page.
// (Exact line highlighting is unreliable with MiKTeX synctex on paragraph text;
//  use backward search — click PDF → editor — for precise navigation instead.)

// shared timer so a fresh syncForward result isn't wiped by a stale 15s timeout
let _syncForwardStatusTimer = null;
export async function syncForward() {
  if (!currentProject || !currentFile) return;
  if (!currentFile.endsWith(".tex")) return;

  // Cancel any auto-clear left over from a previous syncForward call
  if (_syncForwardStatusTimer) {
    clearTimeout(_syncForwardStatusTimer);
    _syncForwardStatusTimer = null;
  }

  const btn  = document.getElementById("synctex-btn");
  const cur  = CM.getCursor();
  const line = cur.line + 1;
  const col  = cur.ch  + 1;
  // v5.7.0p7 — sync against what the viewer is SHOWING. While ⚡ Live displays
  // _tlpreview.pdf, the full document's .synctex is a DIFFERENT doc (chapter-
  // only preview, different physical pages) → the old behavior jumped to weird
  // lines on fresh text; _tlpreview.synctex.gz exists (quick compiles keep
  // -synctex=1) and matches the preview exactly, so fresh text is syncable
  // as soon as the live cycle lands.
  const pdfName = pdfDisplayedName() || mainFile.replace(/\.tex$/, ".pdf");

  const container = document.getElementById("pdf-canvas-container");
  if (container.style.display === "none") {
    document.getElementById("compile-status").textContent = "Compile first";
    document.getElementById("compile-status").className = "compile-status err";
    return;
  }

  btn.classList.add("syncing");
  btn.classList.remove("error");

  try {
    const res  = await fetch(
      `/api/projects/${encodeURIComponent(currentProject)}/synctex/forward` +
      `?file=${encodeURIComponent(currentFile)}&line=${line}&col=${col}&pdf=${encodeURIComponent(pdfName)}`
    );
    const data = await res.json();

    if (!data.ok) {
      btn.classList.remove("syncing"); btn.classList.add("error");
      setTimeout(() => btn.classList.remove("error"), 2000);
      document.getElementById("compile-status").textContent = data.error || "SyncTeX failed";
      document.getElementById("compile-status").className = "compile-status err";
      return;
    }

    // Scroll to the correct page + highlight full wrapped paragraph range
    // data.y  = top of first visual line (from TOP of page)
    // data.y2 = baseline of last visual line (from TOP of page)
    // data.h  = glyph ascent (~10pt) for descent calc
    pdfScrollToPosition(data.page, data.x, data.y, data.h || 10, 0, data.y2 || 0);

    btn.classList.remove("syncing");
    btn.style.color = "var(--green)";
    setTimeout(() => { btn.style.color = ""; }, 800);

    // Brief confirmation — auto-clears after a couple seconds.
    const dbg = data.debug || {};
    const matchedNote = (dbg.matched_line && dbg.matched_line !== (CM.getCursor().line + 1))
                          ? ` (matched line ${dbg.matched_line})` : "";
    document.getElementById("compile-status").textContent = `⇢ Page ${data.page}${matchedNote}`;
    document.getElementById("compile-status").className   = "compile-status ok";
    _syncForwardStatusTimer = setTimeout(() => {
      document.getElementById("compile-status").textContent = "";
      document.getElementById("compile-status").className = "compile-status";
      _syncForwardStatusTimer = null;
    }, 2000);

  } catch (e) {
    btn.classList.remove("syncing"); btn.classList.add("error");
    setTimeout(() => btn.classList.remove("error"), 2000);
  }
}

// v5.7.0p7 — quiet forward sync, used by swapPDF as the caret anchor on
// full↔preview transitions: same backend resolve as syncForward but no
// button/status side-effects, INSTANT scroll (it runs under the swap snapshot
// overlay, which reads scrollTop right after), and resolves false on any miss
// (file not in \includeonly's Input map, no synctex yet, network) so the
// caller can fall back to the fraction restore.
export async function syncForwardQuiet(pdfName) {
  if (!currentProject || !currentFile || !currentFile.endsWith(".tex")) return false;
  const cur = CM.getCursor();
  try {
    const res = await fetch(
      `/api/projects/${encodeURIComponent(currentProject)}/synctex/forward` +
      `?file=${encodeURIComponent(currentFile)}&line=${cur.line + 1}&col=${cur.ch + 1}` +
      `&pdf=${encodeURIComponent(pdfName)}`
    );
    const data = await res.json();
    if (!data.ok) return false;
    // Stale synctex can point past the new doc's last page (no wrap) —
    // report a miss so the caller's frac fallback still positions something.
    if (!document.getElementById(`pdf-page-${data.page}`)) return false;
    pdfScrollToPosition(data.page, data.x, data.y, data.h || 10, 0, data.y2 || 0, { instant: true, noHighlight: true });
    return true;
  } catch (_) {
    return false;
  }
}
