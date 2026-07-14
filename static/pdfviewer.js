import { CM, compile, currentFile, currentProject, desktopSave, escapeHtml, mainFile, switchGen } from "editor";
import { openFile } from "files";
import { syncForwardQuiet } from "synctex"; // v5.7.0p7 — caret anchor on full↔preview swaps (call-time only, cycle-safe)

// static/pdfviewer.js — TexLocal Phase 2 module split (v5.0.0-beta.2.0)
// Lifted verbatim from editor.js (CM-light cluster). Interim shared-scope:
// a classic <script defer>, NOT an ES module — shares editor.js's global
// scope (module-level state + the global CM adapter facade). Loads AFTER
// editor.js and BEFORE boot.js. CM6 note: touches CodeMirror only via CM.*

// ── PDF.js VIEWER ─────────────────────────────────────────────
const PDFJS_CDN = "/static/vendor/pdfjs";  // v4.x — vendored (offline)
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_CDN + "/pdf.worker.min.js";

let pdfJsDoc        = null;   // loaded PDFDocumentProxy
let pdfJsScale      = 1.0;    // current zoom (start at 100%)
let pdfJsPageHts    = [null]; // page heights in pt (1-indexed), for coordinate conversion
let pdfJsUrl        = null;   // last loaded url (for zoom re-render)
let pdfJsLastUrl    = null;   // url that pdfJsDoc was loaded from (skip refetch on zoom)
let pdfJsRendering  = false;
let pdfPendingRender = null;  // latest render request queued behind the rendering lock
let pdfTextCache    = {};     // page number → TextContent items cache (reused across zooms)
let pdfZoomTimer    = null;   // debounce timer for zoom re-render
let pdfMeasureCtx   = null;   // offscreen 2d ctx for fast text-width measurement
let pdfRenderToken  = 0;      // monotonically incremented; cancels stale renders on rapid zoom

// v5.7.0p7 — name of the file the viewer is currently displaying (parsed from
// the last-loaded /pdf URL). Lets SyncTeX + swapPDF distinguish the ⚡ preview
// (_tlpreview.pdf) from the full document without a second piece of state to
// keep in sync — pdfJsUrl is already the single source of truth.
export function pdfDisplayedName() {
  if (!pdfJsUrl) return null;
  try { return new URL(pdfJsUrl, location.origin).searchParams.get("file"); }
  catch (_) { return null; }
}

// Offscreen canvas for measuring glyph widths during text-layer build.
// Replaces the previous probe.getBoundingClientRect() approach — that call
// forced a layout reflow for EVERY text item (could be thousands per page),
// which was the main reason zoom felt sluggish on long documents.
function getMeasureCtx() {
  if (!pdfMeasureCtx) {
    const c = document.createElement("canvas");
    pdfMeasureCtx = c.getContext("2d");
  }
  return pdfMeasureCtx;
}

function showZoomControls(visible) {
  ["pdf-zoom-out","pdf-zoom-in","pdf-zoom-label","pdf-zoom-sep2"].forEach(id => {
    document.getElementById(id).style.display = visible ? "" : "none";
  });
  // v3.2.3 — also show/hide the page-jump input alongside zoom controls.
  const pin = document.getElementById("pdf-page-input");
  const ptl = document.getElementById("pdf-page-total");
  if (pin) pin.style.display = visible ? "" : "none";
  if (ptl) ptl.style.display = visible ? "" : "none";
  if (visible && pdfJsDoc && ptl) ptl.textContent = "/ " + pdfJsDoc.numPages;
}

// v3.2.3 — Page jump. Scrolls #pdf-page-N into view in the scroll container,
// then briefly tints the input border so the user sees their action landed.
export function pdfJumpToPage(p, inputEl) {
  if (!pdfJsDoc) return;
  const n = parseInt(p, 10);
  if (!n || n < 1 || n > pdfJsDoc.numPages) {
    if (inputEl) {
      inputEl.style.borderColor = "var(--red)";
      setTimeout(() => { inputEl.style.borderColor = ""; }, 600);
    }
    return;
  }
  const wrap = document.getElementById(`pdf-page-${n}`);
  if (!wrap) return;
  wrap.scrollIntoView({ behavior: "smooth", block: "start" });
  // Move focus off the input so the IntersectionObserver can re-sync the
  // value as the smooth-scroll progresses. Otherwise the value stays pinned
  // to what the user typed even after they've landed on the target page.
  if (inputEl) {
    inputEl.style.borderColor = "var(--accent)";
    setTimeout(() => { inputEl.style.borderColor = ""; inputEl.blur(); }, 600);
  }
}

// v3.2.3 — Scroll-following page indicator. As the user scrolls the PDF the
// page-input value tracks the most-visible page. The user can still type a
// number + Enter (or just blur) to jump elsewhere — we suppress observer
// writes while the input has focus so the typed value isn't clobbered.
//
// IntersectionObserver semantics: each callback receives only the entries
// that changed. We maintain a running map of page-num → intersectionRatio
// and after every callback recompute the argmax. That keeps the "current"
// page sticky on slow scrolls and snappy on fast ones.
let _pdfPageObserver = null;
const _pdfPageVisibility = new Map();   // pageNum → ratio (0..1)
function _attachPdfPageObserver() {
  // Tear down any previous observer — pages are recreated on every re-render
  // (compile / zoom) so the old nodes are now detached.
  if (_pdfPageObserver) {
    try { _pdfPageObserver.disconnect(); } catch (_) {}
    _pdfPageObserver = null;
  }
  _pdfPageVisibility.clear();
  const container = document.getElementById("pdf-canvas-container");
  if (!container || !pdfJsDoc) return;
  if (typeof IntersectionObserver === "undefined") return;   // very old browser
  _pdfPageObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const m = e.target.id && e.target.id.match(/^pdf-page-(\d+)$/);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (e.isIntersecting && e.intersectionRatio > 0) {
        _pdfPageVisibility.set(n, e.intersectionRatio);
      } else {
        _pdfPageVisibility.delete(n);
      }
    }
    // Choose the page that occupies the most of the viewport right now.
    // Tie-break by lower number (so when two pages straddle the seam we
    // report the earlier one, which feels right on top-anchored scrolling).
    let bestN = null, bestR = -1;
    for (const [n, r] of _pdfPageVisibility) {
      if (r > bestR || (r === bestR && (bestN === null || n < bestN))) {
        bestR = r; bestN = n;
      }
    }
    if (bestN === null) return;
    const inp = document.getElementById("pdf-page-input");
    if (!inp) return;
    // Don't clobber the user's in-progress typing.
    if (document.activeElement === inp) return;
    if (inp.value !== String(bestN)) inp.value = String(bestN);
  }, {
    root: container,
    // Multiple thresholds so the ratio re-computes as the page slides into
    // and out of view, not just at the boundaries.
    threshold: [0, 0.1, 0.25, 0.5, 0.75, 1.0],
  });
  container.querySelectorAll(".pdf-page-wrap").forEach(el => {
    _pdfPageObserver.observe(el);
  });
}

// v4.5.0 — Lazy page rasteriser (see renderPdfFromUrl). Renders ONE page's
// canvas + text layer into its already-placed placeholder wrap, on demand.
// Safe to call repeatedly: it no-ops if the page is already rendered or being
// rendered, and aborts if a newer full render (compile / zoom) has started.
async function _renderPdfPageContent(n) {
  const wrap = document.getElementById(`pdf-page-${n}`);
  if (!wrap || wrap.dataset.rendered !== "0") return;
  if (!pdfJsDoc) return;
  const tok = pdfRenderToken;            // newer full render → abandon this one
  wrap.dataset.rendered = "rendering";
  try {
    const dpr  = window.devicePixelRatio || 1;
    const page = await pdfJsDoc.getPage(n);
    if (tok !== pdfRenderToken) { wrap.dataset.rendered = "0"; return; }

    const vp1 = page.getViewport({ scale: 1 });
    if (pdfJsPageHts[n] !== vp1.height) pdfJsPageHts[n] = vp1.height;   // fix estimate

    const viewport = page.getViewport({ scale: pdfJsScale });
    const cssW = Math.floor(viewport.width);
    const cssH = Math.floor(viewport.height);
    // Correct the placeholder size if this page isn't the uniform page-1 size.
    if (wrap.style.width  !== cssW + "px") wrap.style.width  = cssW + "px";
    if (wrap.style.height !== cssH + "px") wrap.style.height = cssH + "px";

    const canvas = document.createElement("canvas");
    canvas.width        = Math.floor(cssW * dpr);
    canvas.height       = Math.floor(cssH * dpr);
    canvas.style.width  = cssW + "px";
    canvas.style.height = cssH + "px";
    wrap.appendChild(canvas);

    const renderTransform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;
    await page.render({
      canvasContext: canvas.getContext("2d"),
      viewport,
      transform: renderTransform,
    }).promise;
    if (tok !== pdfRenderToken) return;

    // Text layer — selection / I-beam. Same CSS-scale geometry as the canvas.
    try {
      const textViewport = page.getViewport({ scale: pdfJsScale });
      let textContent = pdfTextCache[n];
      if (!textContent) { textContent = await page.getTextContent(); pdfTextCache[n] = textContent; }
      if (tok !== pdfRenderToken) return;

      const textLayerDiv = document.createElement("div");
      textLayerDiv.className    = "textLayer";
      textLayerDiv.style.width  = cssW + "px";
      textLayerDiv.style.height = cssH + "px";
      wrap.appendChild(textLayerDiv);

      const composeTransform = (m1, m2) => [
        m1[0]*m2[0] + m1[2]*m2[1],
        m1[1]*m2[0] + m1[3]*m2[1],
        m1[0]*m2[2] + m1[2]*m2[3],
        m1[1]*m2[2] + m1[3]*m2[3],
        m1[0]*m2[4] + m1[2]*m2[5] + m1[4],
        m1[1]*m2[4] + m1[3]*m2[5] + m1[5],
      ];
      const measureCtx = getMeasureCtx();
      const frag       = document.createDocumentFragment();
      for (const item of textContent.items || []) {
        if (!item || !item.str) continue;
        const tx       = composeTransform(textViewport.transform, item.transform);
        const fontSize = Math.hypot(tx[2], tx[3]);
        if (fontSize < 1) continue;
        const angle = Math.atan2(tx[1], tx[0]);
        const left  = tx[4];
        const top   = tx[5] - fontSize;
        const span  = document.createElement("span");
        span.textContent      = item.str;
        span.style.left       = left + "px";
        span.style.top        = top  + "px";
        span.style.fontSize   = fontSize + "px";
        span.style.fontFamily = "sans-serif";
        if (item.width && item.width > 0) {
          const targetW  = item.width * textViewport.scale;
          measureCtx.font = fontSize + "px sans-serif";
          const naturalW = measureCtx.measureText(item.str).width || 1;
          const ratio    = targetW / naturalW;
          span.style.transform       = (angle !== 0 ? `rotate(${angle}rad) ` : "") + `scaleX(${ratio.toFixed(4)})`;
          span.style.transformOrigin = "0% 0%";
        } else if (angle !== 0) {
          span.style.transform = `rotate(${angle}rad)`;
        }
        frag.appendChild(span);
      }
      textLayerDiv.appendChild(frag);
    } catch (err) {
      console.warn("[textLayer] render failed for page", n, err);
    }

    wrap.dataset.rendered = "1";
  } catch (err) {
    wrap.dataset.rendered = "0";   // allow a retry on the next intersection
    console.warn("[pdf] page render failed", n, err);
  }
}

// v4.5.0 — Triggers lazy rasterisation of pages as they approach the viewport.
// Distinct from _pdfPageObserver (which only tracks the visible page NUMBER).
// The generous rootMargin pre-renders ~1.5 screens ahead so scrolling feels
// seamless rather than "blank, then pop".
let _pdfLazyObserver = null;
function _attachPdfLazyRenderObserver() {
  if (_pdfLazyObserver) { try { _pdfLazyObserver.disconnect(); } catch (_) {} _pdfLazyObserver = null; }
  const container = document.getElementById("pdf-canvas-container");
  if (!container || !pdfJsDoc) return;
  if (typeof IntersectionObserver === "undefined") {
    // No observer support → render everything (old eager behaviour).
    for (let n = 1; n <= pdfJsDoc.numPages; n++) _renderPdfPageContent(n);
    return;
  }
  _pdfLazyObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const m = e.target.id && e.target.id.match(/^pdf-page-(\d+)$/);
      if (m) _renderPdfPageContent(parseInt(m[1], 10));
    }
  }, { root: container, rootMargin: "1200px 0px" });
  container.querySelectorAll(".pdf-page-wrap").forEach(el => _pdfLazyObserver.observe(el));
}

// v4.5.0 — Backward-search (double-click PDF → jump to editor line). Extracted
// from the old per-page render loop so it can be attached to a placeholder
// wrap before the page is rasterised.
function _attachPdfBackwardSearch(wrap, pageNum) {
  wrap.addEventListener("dblclick", async (e) => {
    if (!currentProject) return;
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.removeAllRanges) sel.removeAllRanges();
    const rect   = wrap.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const pdf_x = clickX / pdfJsScale;
    const pdf_y = clickY / pdfJsScale;
    // v5.7.0p7 — sync against what the viewer is SHOWING: while ⚡ Live displays
    // _tlpreview.pdf, the full document's synctex is a different doc (chapter-
    // only, different physical pages) → wrong-line jumps on fresh text.
    const pdfName = pdfDisplayedName() || mainFile.replace(/\.tex$/, ".pdf");

    const status = document.getElementById("compile-status");
    status.textContent = "\u21a9 Searching\u2026";
    status.className   = "compile-status";

    try {
      const res  = await fetch(
        `/api/projects/${encodeURIComponent(currentProject)}/synctex/backward` +
        `?page=${pageNum}&x=${Math.round(pdf_x)}&y=${Math.round(pdf_y)}&pdf=${encodeURIComponent(pdfName)}`
      );
      const data = await res.json();
      if (!data.ok) {
        status.textContent = data.error || "No match";
        status.className   = "compile-status err";
        setTimeout(() => { status.textContent = ""; status.className = "compile-status"; }, 2000);
        return;
      }
      if (data.file && data.file !== currentFile) {
        await openFile(data.file);
      }
      const targetLine = (data.line || 1) - 1;
      setTimeout(() => {
        CM.setCursor(targetLine, 0);
        CM.scrollIntoView({ line: targetLine, ch: 0 }, 120);
        CM.focus();
        CM.addLineClass(targetLine, "background", "cm-synctex-jump");
        setTimeout(() => CM.removeLineClass(targetLine, "background", "cm-synctex-jump"), 1200);
      }, data.file !== currentFile ? 200 : 0);

      status.textContent = `\u21a9 Line ${data.line}`;
      status.className   = "compile-status ok";
      setTimeout(() => { status.textContent = ""; status.className = "compile-status"; }, 1500);
    } catch (_) {
      status.textContent = "Backward search failed";
      status.className   = "compile-status err";
      setTimeout(() => { status.textContent = ""; status.className = "compile-status"; }, 2000);
    }
  });
}

// v3.2.2 — PDF outline / TOC sidebar
let pdfOutlineLoaded = false;   // last PDF load attempted to fetch outline
let pdfOutlineData   = [];      // resolved tree: [{title, page, items: [...]}]

// Resolve a pdf.js dest (named string OR array) to a 1-indexed page number.
async function _resolveOutlineDest(dest) {
  try {
    let d = dest;
    if (typeof d === "string") d = await pdfJsDoc.getDestination(d);
    if (!Array.isArray(d) || !d[0]) return null;
    return (await pdfJsDoc.getPageIndex(d[0])) + 1;
  } catch (_) { return null; }
}
async function _walkOutline(items) {
  const out = [];
  for (const it of items) {
    const page = await _resolveOutlineDest(it.dest);
    const sub  = (it.items && it.items.length) ? await _walkOutline(it.items) : [];
    out.push({ title: it.title || "(untitled)", page, items: sub });
  }
  return out;
}
async function loadPdfOutline() {
  pdfOutlineLoaded = false;
  pdfOutlineData   = [];
  if (!pdfJsDoc) return;
  try {
    const raw = await pdfJsDoc.getOutline();
    if (!raw || !raw.length) {
      pdfOutlineLoaded = true;
      return;
    }
    pdfOutlineData = await _walkOutline(raw);
  } catch (_) {
    pdfOutlineData = [];
  }
  pdfOutlineLoaded = true;
}
function renderPdfOutline() {
  const list = document.getElementById("pdf-outline-list");
  if (!pdfOutlineData.length) {
    list.innerHTML = `<div class="po-empty">No outline / bookmarks in this PDF.<br><br>
      Add <code>\\section{}</code>, <code>\\chapter{}</code>, or load
      <code>hyperref</code> to generate them.</div>`;
    return;
  }
  const renderItems = (items, depth) => items.map(it => {
    const padLeft = 8 + depth * 12;
    const pageStr = it.page ? `p.${it.page}` : "";
    const titleEsc = escapeHtml(it.title);
    const onClick = it.page
      ? `onclick="pdfScrollToPage(${it.page})"`
      : "";
    return `<div class="po-item" ${onClick} style="padding-left:${padLeft}px">
              <span class="po-title">${titleEsc}</span>
              <span class="po-page">${pageStr}</span>
            </div>`
         + (it.items && it.items.length
              ? `<div class="po-children">${renderItems(it.items, depth + 1)}</div>`
              : "");
  }).join("");
  list.innerHTML = renderItems(pdfOutlineData, 0);
}
export function togglePdfOutline() {
  const content = document.querySelector(".pdf-content");
  const isOpen  = content.classList.toggle("outline-open");
  if (isOpen) {
    if (!pdfOutlineLoaded) {
      // Lazy-load on first open after a fresh PDF
      loadPdfOutline().then(renderPdfOutline);
    } else {
      renderPdfOutline();
    }
  }
}
// Scroll the canvas container so the top of `pageNum` is at the top of view.
export function pdfScrollToPage(pageNum) {
  const wrap = document.getElementById(`pdf-page-${pageNum}`);
  if (!wrap) return;
  const container = document.getElementById("pdf-canvas-container");
  container.scrollTo({ top: Math.max(0, wrap.offsetTop - 16), behavior: "smooth" });
}

export async function showPDF(filename) {
  const context = { project: currentProject, generation: switchGen };
  if (!context.project) return false;
  const ts  = Date.now();
  const url = `/api/projects/${encodeURIComponent(context.project)}/pdf?file=${encodeURIComponent(filename)}&t=${ts}`;
  pdfJsUrl  = url;
  pdfTextCache = {};  // clear text cache on new PDF load
  pdfOutlineLoaded = false;
  pdfOutlineData   = [];

  const container = document.getElementById("pdf-canvas-container");
  const ph        = document.getElementById("pdf-placeholder");
  const dl        = document.getElementById("pdf-download");

  ph.style.display        = "none";
  container.style.display = "flex";
  container.style.color   = "";
  container.innerHTML     = '<div style="color:var(--muted);padding:32px;text-align:center;font-size:12px">Loading PDF…</div>';
  showZoomControls(true);
  document.getElementById("pdf-zoom-label").textContent = Math.round(pdfJsScale * 100) + "%";

  dl.href = `/api/projects/${encodeURIComponent(context.project)}/pdf?file=${encodeURIComponent(filename)}`;
  dl.download = filename;
  dl.style.display = "inline";
  // v4.7.6 — the WebView2 desktop build ignores <a download> (no download
  // handler in the embedded host), so the button did nothing there while
  // browser mode worked. In desktop mode, route through the pywebview bridge
  // (native Save dialog). Browser mode keeps the plain anchor behaviour.
  dl.onclick = window.pywebview
    ? (e) => { e.preventDefault(); desktopSave(dl.getAttribute("href"), filename); }
    : null;

  await renderPdfFromUrl(url, true, context);   // force reload — new compile output
  return currentProject === context.project && switchGen === context.generation;
}

// v5.7.0 — Layer D (real_time_plan.md §2): seamless in-place PDF refresh.
// showPDF() blanks the container ("Loading PDF…") and rebuilds from scratch —
// right for a first open / project switch, wrong for a recompile of the SAME
// document, where it kills the reading position and restarts lazy raster from
// page 1 (the #1 "not seamless" symptom, plan §1). swapPDF instead:
//   1. awaits getDocument() fully BEFORE any DOM change — old pages stay
//      visible and interactive during the download/parse;
//   2. snapshots the scroll fraction and restores it right after the wraps
//      are rebuilt (pdfZoom's "frac" restore pattern);
//   3. keeps the last-good pages untouched on load failure (no error blank);
//   4. falls back to showPDF() when nothing is on screen yet or the target
//      file changed (scroll restore is meaningless across documents).
// v5.7.0p5 — pixel snapshot of the pages currently in view, fixed over the
// container. Held on top while swapPDF rebuilds + re-rasterises underneath,
// so the user never sees the white placeholders (plan §0: keep the old DOM
// visible until the new pages are ready). Canvas cloneNode() does NOT copy
// the bitmap — drawImage does. The computed CSS filter is copied so the
// dark-mode inverted view doesn't flash un-inverted.
function _swapSnapshotOverlay(container) {
  const rect = container.getBoundingClientRect();
  const ov = document.createElement("div");
  ov.style.cssText = "position:fixed;left:" + rect.left + "px;top:" + rect.top +
    "px;width:" + rect.width + "px;height:" + rect.height +
    "px;overflow:hidden;z-index:50;pointer-events:none;";
  container.querySelectorAll(".pdf-page-wrap canvas").forEach(cv => {
    const r = cv.getBoundingClientRect();
    if (r.bottom < rect.top || r.top > rect.bottom) return;   // off-screen
    const copy = document.createElement("canvas");
    copy.width  = cv.width;
    copy.height = cv.height;
    try { copy.getContext("2d").drawImage(cv, 0, 0); } catch (_) { return; }
    copy.style.cssText = "position:absolute;left:" + (r.left - rect.left) +
      "px;top:" + (r.top - rect.top) + "px;width:" + r.width +
      "px;height:" + r.height + "px;";
    copy.style.filter = getComputedStyle(cv).filter;   // dark-mode invert
    ov.appendChild(copy);
  });
  document.body.appendChild(ov);
  return ov;
}

export async function swapPDF(filename, opts = {}) {
  const context = { project: currentProject, generation: switchGen };
  const contextIsCurrent = () => currentProject === context.project &&
                                  switchGen === context.generation;
  const container = document.getElementById("pdf-canvas-container");
  const dl        = document.getElementById("pdf-download");
  // v5.7.0p4 — opts.preview (live cycles): the swapped-in file is _tlpreview.pdf
  // while the Download button stays pointed at the REAL full PDF, so the
  // download-name guard must be skipped (and dl is deliberately not touched —
  // downloading during Live mode gives the full document, not the preview).
  const dlMismatch = !opts.preview && (!dl || dl.download !== filename);
  if (!pdfJsDoc || !container || container.style.display === "none"
      || !container.querySelector(".pdf-page-wrap") || dlMismatch) {
    return showPDF(filename);
  }
  const ts  = Date.now();
  const url = `/api/projects/${encodeURIComponent(context.project)}/pdf?file=${encodeURIComponent(filename)}&t=${ts}`;

  let newDoc;
  try {
    newDoc = await pdfjsLib.getDocument(url).promise;
  } catch (_) {
    return;   // keep last-good pages; the compile-status line reports state
  }
  if (!contextIsCurrent()) return;

  const frac = container.scrollTop / (container.scrollHeight || 1);
  // v5.7.0p7 — is this swap a full↔preview TRANSITION? (document shape changes:
  // the preview is chapter-only, so a scroll fraction is meaningless across it)
  const nameChanged = pdfDisplayedName() !== filename;

  // Commit. renderPdfFromUrl(url, false) sees pdfJsLastUrl === url with an
  // already-loaded pdfJsDoc, so it skips getDocument and only rebuilds the
  // cheap correctly-sized placeholders + re-attaches the lazy-raster observer.
  pdfJsDoc         = newDoc;
  pdfJsUrl         = url;
  pdfJsLastUrl     = url;
  pdfTextCache     = {};
  pdfOutlineLoaded = false;
  pdfOutlineData   = [];
  // Page-jump labels normally refresh inside the getDocument branch we skip.
  const ptl = document.getElementById("pdf-page-total");
  if (ptl) ptl.textContent = "/ " + newDoc.numPages;
  const pin = document.getElementById("pdf-page-input");
  if (pin) pin.max = newDoc.numPages;

  // v5.7.0p5 — double-buffer: hold a pixel copy of the visible pages on top
  // while the wrap rebuild + re-raster happens underneath; drop it only when
  // the pages now in view are fully rendered → zero visible flash. On any
  // error the finally still removes the overlay (worst case = old behavior).
  const overlay = _swapSnapshotOverlay(container);
  try {
    await renderPdfFromUrl(url, false, context);
    if (!contextIsCurrent()) return;
    // v5.7.0p7 — on full↔preview transitions the frac restore landed on an
    // arbitrary page (looked like "page 1 then auto-scroll", PoL 2026-07-11).
    // Anchor by SyncTeX from the caret instead — the preview opens right at
    // the paragraph being edited. Same-document swaps keep the frac restore;
    // any anchor miss (file not in \includeonly, no synctex) falls back too.
    let anchored = false;
    if (nameChanged) {
      try { anchored = await syncForwardQuiet(filename); } catch (_) { anchored = false; }
      if (!contextIsCurrent()) return;
    }
    // Explicit instant scroll — never rely on the container's CSS scroll
    // behavior (a CSS smooth here = visible glide from page 1 + the raster
    // pass below reading a mid-animation scrollTop; bit us in v5.7.0p7).
    if (!anchored) container.scrollTo({ top: frac * container.scrollHeight, behavior: "auto" });
    // Rasterise the pages now in view BEFORE dropping the snapshot (the lazy
    // observer would get there too, but we must know when they're done).
    const top = container.scrollTop, bot = top + container.clientHeight;
    const jobs = [];
    container.querySelectorAll(".pdf-page-wrap").forEach(w => {
      if (w.offsetTop < bot && w.offsetTop + w.offsetHeight > top)
        jobs.push(_renderPdfPageContent(parseInt(w.dataset.page, 10)));
    });
    await Promise.all(jobs);
    if (!contextIsCurrent()) return;
  } finally {
    overlay.remove();
  }
}

// `forceReload`: re-fetch the PDF (called from showPDF after compile).
// When false (zoom), skip getDocument() and reuse the loaded pdfJsDoc — saves
// the network round-trip on each zoom step.
async function renderPdfFromUrl(url, forceReload, context) {
  const renderContext = context || { project: currentProject, generation: switchGen };
  const contextIsCurrent = () => currentProject === renderContext.project &&
                                  switchGen === renderContext.generation;
  if (!contextIsCurrent()) return false;
  if (pdfJsRendering) {
    // Remember the newest request, including its project generation. This lets
    // a project-B render queue behind project A without inheriting A's context.
    pdfPendingRender = { url, forceReload, context: renderContext };
    return false;
  }
  pdfJsRendering = true;
  // Bump the render token; any in-flight async work that finishes after a
  // newer render started can detect cancellation and bail out early.
  const myToken = ++pdfRenderToken;
  const container = document.getElementById("pdf-canvas-container");
  try {
    if (forceReload || !pdfJsDoc || pdfJsLastUrl !== url) {
      const loadedDoc = await pdfjsLib.getDocument(url).promise;
      if (myToken !== pdfRenderToken || !contextIsCurrent()) return false;
      pdfJsDoc     = loadedDoc;
      pdfJsLastUrl = url;
      pdfTextCache = {};   // PDF changed → text content cache is now stale
      // v3.2.3 — Refresh the page-jump total label NOW that we know numPages
      // for the freshly-loaded document. showZoomControls() runs before this
      // (so the toolbar can flip visible while "Loading PDF…" is showing),
      // which would otherwise leave the "/ N" label stuck at the previous
      // PDF's count — or at the HTML default "/ 0" on first load.
      const _ptl = document.getElementById("pdf-page-total");
      if (_ptl) _ptl.textContent = "/ " + pdfJsDoc.numPages;
      const _pin = document.getElementById("pdf-page-input");
      if (_pin) _pin.max = pdfJsDoc.numPages;
    }
    pdfJsPageHts = [null];   // index 0 unused
    container.innerHTML = "";

    // v4.5.0 — LAZY PDF rendering. Rasterising every page (canvas + text
    // layer) up-front made opening a ~150-page thesis take several seconds
    // before anything was usable. Instead we create correctly-SIZED page
    // placeholders immediately — so total scroll height, page-jump offsets and
    // synctex `pdf-page-N` targets are all valid right away — then rasterise
    // each page only when it nears the viewport (see _renderPdfPageContent /
    // _attachPdfLazyRenderObserver). First paint is now near-instant.
    //
    // Page size is read from page 1 and assumed uniform (true for A4/Letter
    // theses). If a page differs when it actually renders, its wrap height and
    // pdfJsPageHts entry are corrected then — a mixed-size doc just gets a
    // small one-time scroll nudge on the odd page.
    const _p1   = await pdfJsDoc.getPage(1);
    if (myToken !== pdfRenderToken || !contextIsCurrent()) return false;
    const _vp1  = _p1.getViewport({ scale: 1 });
    const _vpS  = _p1.getViewport({ scale: pdfJsScale });
    const cssW  = Math.floor(_vpS.width);
    const cssH  = Math.floor(_vpS.height);
    const uniH1 = _vp1.height;   // scale-1 height estimate used for jumps

    for (let n = 1; n <= pdfJsDoc.numPages; n++) {
      if (myToken !== pdfRenderToken || !contextIsCurrent()) return false;
      pdfJsPageHts.push(uniH1);

      const wrap = document.createElement("div");
      wrap.className        = "pdf-page-wrap";
      wrap.id               = `pdf-page-${n}`;
      wrap.dataset.page     = String(n);
      wrap.dataset.rendered = "0";          // "0" = not yet, "rendering", "1" = done
      wrap.style.width      = cssW + "px";
      wrap.style.height     = cssH + "px";
      wrap.style.cursor     = "default";
      _attachPdfBackwardSearch(wrap, n);    // dblclick → editor jump (no raster needed)
      container.appendChild(wrap);
    }

    // Rasterise on-screen (and soon-to-be-on-screen) pages lazily.
    _attachPdfLazyRenderObserver();
    return true;
  } catch (err) {
    if (contextIsCurrent()) {
      container.textContent = "PDF load error: " + (err.message || err);
      container.style.color = "var(--red)";
    }
    return false;
  } finally {
    pdfJsRendering = false;
    // v3.2.3 — Re-attach the page-visibility observer to the freshly-rendered
    // pages. Done in `finally` so zoom re-renders also re-bind, and so the
    // observer never lingers on detached nodes from a previous render.
    if (contextIsCurrent()) _attachPdfPageObserver();
    // Drain a queued zoom that arrived while we were busy. We re-render at
    // whatever pdfJsScale currently holds — pdfZoom() updated it synchronously
    // before queuing, so the latest user intent wins.
    if (pdfPendingRender) {
      const pending = pdfPendingRender;
      pdfPendingRender = null;
      setTimeout(() => renderPdfFromUrl(
        pending.url, pending.forceReload, pending.context), 0);
    }
    // v3.2.2 — refresh PDF outline button visibility. We only show 🗂
    // when the loaded PDF actually has bookmarks (most LaTeX docs with
    // hyperref do; raw beamer or quick test docs may not).
    if (contextIsCurrent() && pdfJsDoc && !pdfOutlineLoaded) {
      loadPdfOutline().then(() => {
        const btn = document.getElementById("pdf-outline-btn");
        if (btn) btn.style.display = pdfOutlineData.length ? "inline-block" : "none";
        // If user already has the panel open, render now that data is in.
        if (document.querySelector(".pdf-content")?.classList.contains("outline-open")) {
          renderPdfOutline();
        }
      });
    }
  }
}

// Zoom strategy:
//   1. Update the label and apply a CSS transform on existing pages for
//      INSTANT visual feedback — even on a 200-page thesis the user sees
//      the new size within a frame, instead of waiting for a full re-render.
//   2. Debounce the actual canvas re-render. Rapid +/+/+ clicks collapse
//      into a single render at the final scale; the in-between scales never
//      pay the rasterisation cost.
//   3. Once the real render lands, the CSS transform is cleared and the
//      page is sharp at its new resolution.
//
// `anchor` (optional, v3.2.2): {x, y} in container viewport CSS px. When
// provided, scroll is adjusted so that the document point currently under
// the anchor stays under the anchor after zoom — i.e. pinch-to-zoom locks
// to the cursor instead of the centre of the page. Falls back to scroll-
// fraction preservation when omitted (the +/- toolbar buttons).
export async function pdfZoom(delta, anchor) {
  const newScale = Math.max(0.5, Math.min(4.0, pdfJsScale + delta));
  if (newScale === pdfJsScale || !pdfJsUrl) return;

  const container = document.getElementById("pdf-canvas-container");
  const oldScale  = pdfJsScale;
  const ratio     = newScale / oldScale;

  // Snapshot scroll-restoration intent BEFORE any DOM mutation. We capture
  // both representations so the debounced re-render can restore correctly
  // even if many pinch ticks land in the same 140ms window.
  let restore;
  if (anchor) {
    // Document point under the cursor at the OLD scale (in CSS px).
    const docX = container.scrollLeft + anchor.x;
    const docY = container.scrollTop  + anchor.y;
    restore = { kind: "cursor", docX, docY, cx: anchor.x, cy: anchor.y, ratio };
  } else {
    restore = { kind: "frac", frac: container.scrollTop / (container.scrollHeight || 1) };
  }

  pdfJsScale = newScale;
  document.getElementById("pdf-zoom-label").textContent = Math.round(pdfJsScale * 100) + "%";

  // ── Instant CSS-resize preview ─────────────────────────────────────
  // We resize wrap + canvas via CSS so the browser stretches the existing
  // canvas bitmap to the new size immediately. The .textLayer spans are
  // positioned at the OLD scale, so we apply a CSS transform on the layer
  // itself — much cheaper than rebuilding it. The real re-render that
  // lands ~140ms later replaces all of this with sharp pixels.
  document.querySelectorAll(".pdf-page-wrap").forEach(wrap => {
    const wPx = parseFloat(wrap.style.width)  || 0;
    const hPx = parseFloat(wrap.style.height) || 0;
    const newW = wPx * ratio;
    const newH = hPx * ratio;
    wrap.style.width  = newW + "px";
    wrap.style.height = newH + "px";
    const cv = wrap.querySelector("canvas");
    if (cv) {
      cv.style.width  = newW + "px";
      cv.style.height = newH + "px";
    }
    const tl = wrap.querySelector(".textLayer");
    if (tl) {
      const prev = parseFloat(tl.dataset.previewScale || "1") * ratio;
      tl.dataset.previewScale  = prev;
      tl.style.transform       = `scale(${prev})`;
      tl.style.transformOrigin = "0 0";
    }
  });

  // Apply anchored scroll IMMEDIATELY so the cursor stays pinned to the
  // same document point during the preview window. For frac-based zoom
  // (toolbar buttons) we leave scroll alone here and restore in the
  // timeout once the new scrollHeight is known.
  if (restore.kind === "cursor") {
    // After CSS scaling by `ratio`, the document point (docX, docY)
    // is now at (docX*ratio, docY*ratio). To put it back under the
    // cursor (cx, cy) we need scroll = docPoint*ratio − cursor.
    container.scrollLeft = restore.docX * ratio - restore.cx;
    container.scrollTop  = restore.docY * ratio - restore.cy;
  }

  // ── Debounced real render ──────────────────────────────────────────
  if (pdfZoomTimer) clearTimeout(pdfZoomTimer);
  pdfZoomTimer = setTimeout(async () => {
    pdfZoomTimer = null;
    // forceReload=false → reuse pdfJsDoc (no network refetch on zoom)
    const rendered = await renderPdfFromUrl(pdfJsUrl, false);
    if (!rendered) return;
    if (restore.kind === "frac") {
      container.scrollTop = restore.frac * container.scrollHeight;
    }
    // For cursor-anchored zoom the preview already scrolled to the
    // correct position; the rebuilt pages match those exact dims (modulo
    // sub-pixel Math.floor rounding) so no further adjustment is needed.
  }, 140);
}

// ── Trackpad pinch / Ctrl+wheel zoom ──────────────────────────────────
// Browsers report two-finger trackpad pinch gestures as `wheel` events with
// `e.ctrlKey === true` (the "ctrl" flag is synthetic for pinch — it isn't
// the keyboard Ctrl key). The same convention covers Ctrl+wheel for mouse
// users, so a single handler serves both inputs.
//
// We translate the wheel deltaY into a *multiplicative* scale factor via
// exp(-deltaY · k). Multiplicative scaling keeps the perceived zoom rate
// constant across the whole 50–400% range, unlike a flat additive step
// which would feel coarse at 50% and sluggish at 400%.
//
// `passive: false` is required so that preventDefault() can stop the
// browser's own page-zoom handler from also running.
function attachPdfWheelZoom() {
  const container = document.getElementById("pdf-canvas-container");
  if (!container || container._wheelZoomBound) return;
  container._wheelZoomBound = true;

  container.addEventListener("wheel", (e) => {
    // Only intercept pinch / Ctrl-wheel; let plain two-finger scroll pass.
    if (!e.ctrlKey) return;
    // Always block the browser-level page zoom over our container, even
    // if there's no PDF loaded — otherwise an accidental pinch on the
    // empty placeholder would zoom the whole TexLocal UI.
    e.preventDefault();
    if (!pdfJsDoc) return;

    // Sensitivity: divide deltaY by 100 and exponentiate. Typical pinch
    // tick is ±5–15 deltaY units → ±5–15% scale change per tick. The
    // negative sign maps "fingers spreading apart" (pinch out, deltaY<0)
    // to "zoom in" (factor>1).
    const factor = Math.exp(-e.deltaY * 0.01);
    const newScale = Math.max(0.5, Math.min(4.0, pdfJsScale * factor));
    const delta    = newScale - pdfJsScale;
    if (delta === 0) return;

    // Cursor position relative to the container's viewport (CSS px).
    const rect = container.getBoundingClientRect();
    const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    pdfZoom(delta, anchor);
  }, { passive: false });
}
// Bind once on first paint — and re-bind defensively if the element gets
// recreated (it shouldn't, but cheap insurance).
document.addEventListener("DOMContentLoaded", attachPdfWheelZoom);
attachPdfWheelZoom();

// page, x, y, h, w, y2 — all in PDF points, TeX/synctex convention:
//   y  = top of topmost visual line (from TOP of page) = min(baseline - ascent) across records
//   y2 = baseline of bottommost visual line (from TOP of page) = max(baseline) across records
//   h  = glyph ascent of one line (~8-12pt), used for descent calculation
// w — optional text width in pt (word-level highlight)
export function pdfScrollToPosition(page, x, y, h, w, y2, opts = {}) {
  const wrap = document.getElementById(`pdf-page-${page}`);
  if (!wrap) return;
  // v4.5.0 — with lazy rendering the synctex target page may not be rasterised
  // yet; kick it off now so the highlight lands on real content, not a blank.
  _renderPdfPageContent(page);
  document.querySelectorAll(".pdf-highlight").forEach(el => el.remove());

  const glyphH  = (h && h > 2) ? h : 10;
  const descent = glyphH * 0.3;         // small descent below last baseline
  const yBot    = (y2 && y2 > y) ? y2 : (y + glyphH);  // last baseline

  // y is already the top of the highlight (y_top = first-line top)
  // bottom of highlight = last baseline + descent
  const canvasYtop = Math.max(0, y * pdfJsScale);
  const canvasHpx  = (yBot - y + descent) * pdfJsScale;

  // v5.7.0p9 — opts.noHighlight: quiet transition anchors (⚡ on/off swaps) scroll
  // to the caret but must NOT flash a highlight box — that read as a phantom blink
  // on leaving Live mode. The stale-highlight clear above still runs, so any
  // lingering box is removed either way.
  if (!opts.noHighlight) {
    const hl = document.createElement("div");
    hl.className = "pdf-highlight";
    hl.style.top    = canvasYtop + "px";
    hl.style.height = canvasHpx + "px";

    if (w && w > 0) {
      // word-level highlight: position and width from text item
      hl.style.left  = (x * pdfJsScale) + "px";
      hl.style.right = "auto";
      hl.style.width = (w * pdfJsScale) + "px";
    }
    // else: full-width (left:0; right:0 from CSS)

    wrap.appendChild(hl);
    setTimeout(() => hl.remove(), 2500);
  }

  // scroll so the FIRST line of the highlight is in the upper-centre of the PDF pane
  const container  = document.getElementById("pdf-canvas-container");
  const firstLineY = canvasYtop + glyphH * pdfJsScale / 2;  // centre of first (topmost) line
  const target     = wrap.offsetTop + firstLineY - container.clientHeight / 3;
  // v5.7.0p7 — opts.instant: swapPDF's transition anchor runs under the
  // snapshot overlay and the in-view raster pass reads scrollTop right after,
  // so the scroll must land synchronously; smooth stays for user sync clicks.
  container.scrollTo({ top: Math.max(0, target), behavior: opts.instant ? "auto" : "smooth" });
}
