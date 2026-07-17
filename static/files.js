import { setQuickOpenFiles } from "quickopen";
import { CM, _ssCurrentFile, _ssEditorDirty, _ssMainFile, _ssOpenTabs, _ssSaveTimer, closeModal, compile, currentFile, currentProject, editorDirty, escapeAttr, escapeHtml, isImageFile, loadIncludes, loadProjects, mainFile, openModal, openTabs, saveTimer, switchGen, switchProject, updateWordCount } from "editor";
import { clearErrorMarkers, repaintErrorMarkers } from "errors";

// static/files.js — TexLocal Phase 2 module split (v5.0.0-beta.2.0)
// Lifted verbatim from editor.js (CM-light cluster). Interim shared-scope:
// a classic <script defer>, NOT an ES module — shares editor.js's global
// scope (module-level state + the global CM adapter facade). Loads AFTER
// editor.js and BEFORE boot.js. CM6 note: touches CodeMirror only via CM.*

// ── FILES ─────────────────────────────────────────────────────
export const openFolders = new Set(); // เก็บ path ของ folder ที่ขยายอยู่

// ── v4.7.11 — File-tree icons: inline SVG (Lucide-derived) replacing emoji.
// WHY: emoji render differently per-OS, can't be recolored, and ignored the
// Appearance theme. These use stroke/fill="currentColor" so the .file-icon /
// .file-star / .file-ren / .file-del CSS colors (all theme --accent/--yellow/
// --red driven) flow through automatically — Default & Cerulean, light & dark.
function _svgIcon(inner, { size = 14, fill = false } = {}) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" `
       + `fill="${fill ? "currentColor" : "none"}" stroke="currentColor" `
       + `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}
const FILE_TREE_ICONS = {
  // file types
  tex:   `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>`,
  bib:   `<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>`,
  pdf:   `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><text x="12" y="18.5" font-size="6.5" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" style="font-family:var(--font-ui,sans-serif)">PDF</text>`,
  other: `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>`,
  // folders + tree arrow
  folder:     `<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>`,
  folderOpen: `<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>`,
  arrow:      `<path d="m9 18 6-6-6-6"/>`,
  // action glyphs (Lucide: star / pencil / trash-2)
  star:   `<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>`,
  rename: `<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>`,
  del:    `<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>`,
};

function buildFileTree(files) {
  // แปลง flat list เป็น nested object
  // root = { __files: [...], folderName: { __files: [...], ... }, ... }
  const root = { __files: [] };
  files.forEach(f => {
    const parts = f.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts[i];
      if (!node[dir]) node[dir] = { __files: [] };
      node = node[dir];
    }
    node.__files.push(f);
  });
  return root;
}

function renderFileTree(node, container, depth = 0, prefix = "") {
  const indent = 14 + depth * 16;
  // โฟลเดอร์ก่อน (เรียง A-Z)
  const folders = Object.keys(node).filter(k => k !== "__files").sort();
  folders.forEach(folder => {
    const fullPath = prefix ? `${prefix}/${folder}` : folder;
    const isOpen = openFolders.has(fullPath);

    const div = document.createElement("div");
    div.className = "file-item folder-item";
    div.style.paddingLeft = indent + "px";
    div.innerHTML = `
      <span class="folder-arrow ${isOpen ? "open" : ""}">${_svgIcon(FILE_TREE_ICONS.arrow, {size: 12})}</span>
      <span class="file-icon">${_svgIcon(isOpen ? FILE_TREE_ICONS.folderOpen : FILE_TREE_ICONS.folder)}</span>
      <span style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(folder)}</span>
    `;
    div.onclick = () => {
      if (openFolders.has(fullPath)) openFolders.delete(fullPath);
      else openFolders.add(fullPath);
      loadFiles();
    };
    // ── drop target: รับไฟล์มาวางใน folder นี้
    div.addEventListener("dragover", e => {
      e.preventDefault(); e.stopPropagation();
      div.classList.add("drag-over");
    });
    div.addEventListener("dragleave", () => div.classList.remove("drag-over"));
    div.addEventListener("drop", async e => {
      e.preventDefault(); e.stopPropagation();
      div.classList.remove("drag-over");
      const src = e.dataTransfer.getData("text/plain");
      if (!src) return;
      const filename = src.split("/").pop();
      await moveFile(src, `${fullPath}/${filename}`);
      openFolders.add(fullPath); // auto-expand หลัง drop
    });
    container.appendChild(div);

    if (isOpen) {
      renderFileTree(node[folder], container, depth + 1, fullPath);
    }
  });

  // ไฟล์ (เรียง A-Z)
  const files = (node.__files || []).sort();
  files.forEach(filePath => {
    const filename = filePath.split("/").pop();
    const div = document.createElement("div");
    div.className = "file-item" + (filePath === currentFile ? " active" : "");
    div.style.paddingLeft = indent + "px";
    const icon = filePath.endsWith(".tex") ? FILE_TREE_ICONS.tex
               : filePath.endsWith(".bib") ? FILE_TREE_ICONS.bib
               : filePath.endsWith(".pdf") ? FILE_TREE_ICONS.pdf : FILE_TREE_ICONS.other;
    const isMain = filePath === mainFile;
    const isTex  = filePath.endsWith(".tex");
    div.innerHTML = `
      <span class="file-icon">${_svgIcon(icon)}</span>
      <span class="file-label" style="overflow:hidden;text-overflow:ellipsis;flex:1">${escapeHtml(filename)}</span>
      ${isTex ? `<span class="file-star${isMain ? " is-main" : ""}" title="${isMain ? "Main file" : "Set as main file"}">${_svgIcon(FILE_TREE_ICONS.star, {size: 13})}</span>` : ""}
      <span class="file-ren" title="Rename">${_svgIcon(FILE_TREE_ICONS.rename, {size: 13})}</span>
      <span class="file-del" title="Delete">${_svgIcon(FILE_TREE_ICONS.del, {size: 13})}</span>
    `;
    if (isTex) {
      div.querySelector(".file-star").onclick = e => {
        e.stopPropagation();
        setMainFile(filePath);
      };
    }
    div.querySelector(".file-ren").onclick = e => { e.stopPropagation(); startRenameFile(div, filePath); };
    div.querySelector(".file-del").onclick = e => deleteFile(e, filePath);
    div.ondblclick = e => { e.stopPropagation(); startRenameFile(div, filePath); };
    div.onclick = () => openFile(filePath);
    // ── draggable source
    div.draggable = true;
    div.addEventListener("dragstart", e => {
      e.dataTransfer.setData("text/plain", filePath);
      e.dataTransfer.effectAllowed = "move";
      e.stopPropagation();
      setTimeout(() => div.classList.add("dragging"), 0);
    });
    div.addEventListener("dragend", () => div.classList.remove("dragging"));
    container.appendChild(div);
  });
}

// ไฟล์ generated ที่ซ่อนจาก file tree
const HIDDEN_EXTS = new Set([
  "aux","log","toc","out","bbl","blg","fls","bcf",
  "lof","lot","nav","snm","vrb","xdv","run.xml","fdb_latexmk",
  "pdf"   // PDF output ดูได้จาก preview panel อยู่แล้ว
]);
function isGeneratedFile(path) {
  const name = path.split("/").pop().toLowerCase();
  if (name === ".keep") return true;
  if (name.endsWith(".synctex.gz") || name.endsWith(".synctex(busy)")) return true;
  const ext = name.includes(".") ? name.split(".").pop() : "";
  return HIDDEN_EXTS.has(ext);
}

export async function loadFiles() {
  if (!currentProject) return;
  const _gen = switchGen;   // v5.7.1 (#5) — capture; drop the paint if a newer switch lands
  const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/files`);
  const allFiles = await res.json();
  // v5.7.1 (#5, codex Medium) — a newer project switch happened mid-fetch, so
  // this file list is for the OLD project; don't repaint the tree (and return
  // nothing so _restoreLastFile falls back to its mainFile path, itself guarded).
  if (switchGen !== _gen) return;
  const files = allFiles.filter(f => !isGeneratedFile(f));   // ซ่อนไฟล์ขยะ
  // v3.2.3 — keep a flat cache for the Ctrl+P quick-open modal so it doesn't
  // need its own fetch on every invocation.
  setQuickOpenFiles(files);
  const container = document.getElementById("file-tree");
  container.innerHTML = "";
  const treeData = buildFileTree(files);
  renderFileTree(treeData, container);

  // v4.7.4 — return the (filtered) file list so callers (e.g. _restoreLastFile)
  // can reuse this fetch instead of issuing their own.
  return files;
}

export async function openFile(name) {
  if (!currentProject) return;
  // v5.7.1 (#5, codex Medium) — capture the switch generation at entry; if a
  // project switch lands during either await below, this open is for the old
  // project and must not paint its content into the new one (the review's
  // cross-project "stale openFile" hazard). Re-checked after each await.
  const _gen = switchGen;
  // CRITICAL: cancel any pending auto-save BEFORE we change `currentFile`.
  // Without this, a saveTimer queued for the OLD file can fire during the
  // async fetch below, while currentFile already points to the NEW file but
  // the editor still holds the OLD content — that writes the OLD content
  // into the NEW file and corrupts it.
  clearTimeout(saveTimer);
  _ssSaveTimer(null);
  await saveCurrentFile();
  if (switchGen !== _gen) return;   // v5.7.1 (#5) — switched projects mid-save
  _ssCurrentFile(name);
  localStorage.setItem(`texlocal_last_file_${currentProject}`, name);

  if (isImageFile(name)) {
    // ── IMAGE VIEWER ──────────────────────────────────────
    document.getElementById("editor-host").style.display  = "none";
    const viewer = document.getElementById("image-viewer");
    viewer.style.display = "flex";
    const url  = `/api/projects/${encodeURIComponent(currentProject)}/raw?path=${encodeURIComponent(name)}`;
    const ext  = name.split(".").pop().toLowerCase();
    const fname = name.split("/").pop();
    if (ext === "pdf") {
      viewer.innerHTML = `
        <div class="img-info">${escapeHtml(fname)} — เปิดดูได้ใน PDF Preview panel</div>
        <iframe src="${url}" style="flex:1;width:100%;border:none;border-radius:4px;"></iframe>`;
    } else {
      const img = new Image();
      img.src = url;
      img.onload = () => {
        viewer.innerHTML = `
          <img src="${url}" alt="${escapeAttr(fname)}">
          <div class="img-info">${escapeHtml(fname)} &nbsp;·&nbsp; ${img.naturalWidth} × ${img.naturalHeight} px</div>`;
      };
      img.onerror = () => {
        viewer.innerHTML = `<div class="img-info" style="color:var(--red)">ไม่สามารถแสดงรูปภาพนี้ได้</div>`;
      };
      viewer.innerHTML = `<div class="img-info">⏳ Loading…</div>`;
    }
    if (!openTabs.find(t => t.name === name)) openTabs.push({ name, content: "" });
    renderTabs();
    loadFiles();
    return;
  }

  // ── TEXT EDITOR ───────────────────────────────────────
  document.getElementById("image-viewer").style.display  = "none";
  document.getElementById("editor-host").style.display   = "";
  const res  = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/file?path=${encodeURIComponent(name)}`);
  const data = await res.json();
  if (switchGen !== _gen) return;   // v5.7.1 (#5) — switched projects mid-fetch
  // v4.7.3 — guard against a missing/unreadable file (e.g. detect-main fell back
  // to "main.tex" but no such file exists → backend 404 → data.content undefined).
  // setValue(undefined) throws and leaves the editor blank ("stuck"); show an
  // empty buffer instead so the project at least opens.
  const content = (typeof data.content === "string") ? data.content : "";
  if (!openTabs.find(t => t.name === name)) openTabs.push({ name, content });
  else openTabs.find(t => t.name === name).content = content;
  // v5.8.5p2 — clear the OUTGOING file's error markers BEFORE replacing the doc.
  // Under CM6 the error line-classes (_decoField) and the error-gutter RangeSet
  // are mapped through every change; a full-doc setValue collapses their offsets
  // (line decos land off a line-start), which leaves the lineNumbers gutter
  // rendering blank cells until a reflow — the p1 symptom PoL still saw after the
  // refresh nudge (refresh re-measures geometry but doesn't rebuild the number
  // cells). Clearing first makes setValue map an EMPTY set, so this jump-open is
  // identical to a plain cross-file open — the path the p1 bisect proved clean.
  // (Was called AFTER setValue, i.e. once the stale decos had already mapped.)
  clearErrorMarkers();
  CM.setValue(content);
  CM.clearHistory();
  // v5.0.3 — setValue() above fires a synchronous "change" that sets editorDirty;
  // this is a freshly-loaded buffer that already matches disk, so clear it. Any
  // real edit after this re-sets it, so the next save still fires correctly.
  _ssEditorDirty(false);
  const ext = name.split(".").pop();
  CM.setOption("mode", ext === "bib" ? "bibtex" : "stex");
  // v4.7.0beta (PR#2) — restore the last cursor line for this file so you reopen
  // where you left off. Clamp to the current length in case the file shrank.
  try {
    const pos = JSON.parse(localStorage.getItem(`texlocal_pos_${currentProject}::${name}`) || "null");
    if (pos && typeof pos.line === "number") {
      const line = Math.min(Math.max(0, pos.line), CM.lastLine());
      CM.setCursor({ line, ch: pos.ch || 0 });
      CM.scrollIntoView({ line, ch: pos.ch || 0 }, 140);
    }
  } catch (_) {}
  renderTabs();
  loadFiles();
  updateOutline();
  updateWordCount();
  // v5.8.5p4 — repaint this file's compile markers (per-open-file). No-op until a
  // compile has run; after a cross-file error jump this puts the ✕/! back on the
  // right line of the file we just opened. Runs after setValue, so markers land
  // on the new content (openFile cleared the old file's markers before setValue).
  repaintErrorMarkers();
}

// v4.7.0beta (PR#2) — Persist the cursor line per (project, file), debounced,
// so openFile can restore it. Keyed the same way openFile reads it.
let _posSaveTimer = null;
export function _initFiles() {
CM.on("cursorActivity", () => {
  if (!currentProject || !currentFile) return;
  clearTimeout(_posSaveTimer);
  _posSaveTimer = setTimeout(() => {
    try {
      const c = CM.getCursor();
      localStorage.setItem(`texlocal_pos_${currentProject}::${currentFile}`,
                           JSON.stringify({ line: c.line, ch: c.ch }));
    } catch (_) {}
  }, 400);
});
}

// v4.7.0beta (PR#2) — reopen the last-visited file on project open (cursor
// restored inside openFile); falls back to the detected main file. Used by
// switchProject's parallel-startup batch.
export async function _restoreLastFile(project, filesP) {
  const last = localStorage.getItem(`texlocal_last_file_${project}`);
  if (last) {
    try {
      // v4.7.4 — reuse loadFiles()'s in-flight fetch (passed as filesP) instead
      // of a second /files round-trip; fall back to a direct fetch if not given.
      const files = filesP ? await filesP
                           : await (await fetch(`/api/projects/${encodeURIComponent(project)}/files`)).json();
      if (Array.isArray(files) && files.includes(last)) { await openFile(last); return; }
    } catch (_) {}
  }
  if (mainFile) await openFile(mainFile);
}

export function renderTabs() {
  const container = document.getElementById("editor-tabs");
  container.innerHTML = "";
  openTabs.forEach(t => {
    const div = document.createElement("div");
    div.className = "tab" + (t.name === currentFile ? " active" : "");
    div.title = t.name;
    const label = document.createElement("span");
    label.className   = "tab-label";
    label.textContent = t.name.split("/").pop();
    const close = document.createElement("span");
    close.className   = "tab-close";
    close.textContent = "×";
    close.title       = "Close tab";
    close.onclick     = (e) => closeTab(t.name, e);
    div.appendChild(label);
    div.appendChild(close);
    div.onclick = () => openFile(t.name);
    // Middle-click closes, like a browser tab.
    div.onmousedown = (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.name, e); } };
    container.appendChild(div);
  });
}

// v4.7.0beta (PR#2) — Close an editor tab. If it's the active one, flush it and
// switch to a neighbour (or clear the editor if it was the last tab).
async function closeTab(name, e) {
  if (e) e.stopPropagation();
  const idx = openTabs.findIndex(t => t.name === name);
  if (idx === -1) return;
  const wasActive = (name === currentFile);
  if (wasActive) {
    // v5.0.1 — was `catch (_) {}`, which swallowed a failed save and then closed
    // the tab below, discarding the visible unsaved buffer while the on-disk file
    // stayed old. saveCurrentFile() now throws + flashes the save-error indicator;
    // abort the close so the user keeps their content and can retry.
    try { await saveCurrentFile(); }
    catch (_) { return; }
  }
  openTabs.splice(idx, 1);
  if (!wasActive) { renderTabs(); return; }
  if (openTabs.length) {
    await openFile(openTabs[Math.max(0, idx - 1)].name);   // neighbour to the left
  } else {
    _ssCurrentFile(null);
    CM.setValue("");
    clearErrorMarkers();
    renderTabs();
    updateOutline();
    updateWordCount();
  }
}

// v5.0.1 — save-failure surface (code-review: silent save + stale compile).
// Flashes the compile-status strip so a failed write is visible; _clearSaveError
// only clears a message it set (dataset flag) so it never stomps compile status.
function _showSaveError(file, msg) {
  const s = document.getElementById("compile-status");
  if (!s) return;
  s.textContent = `⚠ Save failed (${file}): ${msg}`;
  s.className    = "compile-status err";
  s.dataset.saveError = "1";
}
function _clearSaveError() {
  const s = document.getElementById("compile-status");
  if (s && s.dataset.saveError === "1") {
    s.textContent = "";
    s.className    = "compile-status";
    delete s.dataset.saveError;
  }
}

export async function saveCurrentFile() {
  if (!currentProject || !currentFile) return;
  if (isImageFile(currentFile)) return;   // ห้าม save ทับไฟล์รูปภาพ
  // v5.0.3 — nothing changed since the last save/open → skip the disk write.
  // This is what removes the click-delay in the file tree: openFile()'s
  // `await saveCurrentFile()` now returns instantly for an unedited buffer
  // instead of POSTing the whole file and bumping its mtime (which had been
  // invalidating the cite/bib/synctex mtime caches on every plain file switch).
  if (!editorDirty) return;
  // Snapshot the path/project at call-time. If `currentFile` flips while the
  // POST is in flight, we still write the editor's content to the file the
  // editor was actually displaying — never to the next file we just opened.
  const fileAtSave = currentFile;
  const projAtSave = currentProject;
  const content    = CM.getValue();
  // v5.0.1 — was fire-and-forget (never checked res.ok). On disk-full /
  // permission / 500, the editor kept the newer buffer while compile read the
  // OLDER on-disk content → PDF/log that didn't match the screen. Now throw on
  // failure so callers (compile / cross-file replace) can abort instead.
  let res;
  try {
    res = await fetch(`/api/projects/${encodeURIComponent(projAtSave)}/file`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ path: fileAtSave, content })
    });
  } catch (e) {
    _showSaveError(fileAtSave, e.message || "network error");
    throw e;
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const d = await res.json(); if (d && d.error) msg = d.error; } catch (_) {}
    _showSaveError(fileAtSave, msg);
    throw new Error(`Save failed: ${msg}`);
  }
  _clearSaveError();
  _ssEditorDirty(false);   // v5.0.3 — buffer now matches disk
}

// auto-save และ tab key ถูก handle โดย CodeMirror แล้ว

// ── OUTLINE ───────────────────────────────────────────────────
function parseOutline(content) {
  const pattern = /^[ \t]*\\(chapter|section|subsection|subsubsection)\*?\{([^}]+)\}/;
  return content.split("\n").reduce((acc, line, i) => {
    const m = line.match(pattern);
    if (m) acc.push({ level: m[1], title: m[2], line: i });
    return acc;
  }, []);
}

function renderOutline(items) {
  const el = document.getElementById("outline-tree");
  if (!items.length) {
    el.innerHTML = '<div class="outline-empty">No sections found</div>';
    return;
  }
  el.innerHTML = "";
  items.forEach(({ level, title, line }) => {
    const div = document.createElement("div");
    div.className = `outline-item lvl-${level}`;
    div.textContent = title;
    div.title = title;
    div.onclick = () => {
      CM.setCursor(line, 0);
      CM.scrollIntoView({ line, ch: 0 }, 80);
      CM.focus();
    };
    el.appendChild(div);
  });
}

export function updateOutline() {
  const ext = (currentFile || "").split(".").pop();
  if (ext !== "tex") {
    document.getElementById("outline-tree").innerHTML = '<div class="outline-empty">Only for .tex files</div>';
    return;
  }
  renderOutline(parseOutline(CM.getValue()));
}

export function toggleOutline() {
  const sec = document.getElementById("outline-section");
  const btn = document.getElementById("outline-toggle");
  sec.classList.toggle("collapsed");
  btn.textContent = sec.classList.contains("collapsed") ? "+" : "−";
}

// ── MOVE FILE ─────────────────────────────────────────────────
function startRenameFile(div, filePath) {
  const labelEl = div.querySelector(".file-label");
  const dir     = filePath.includes("/") ? filePath.substring(0, filePath.lastIndexOf("/") + 1) : "";
  const oldName = filePath.split("/").pop();

  const input = document.createElement("input");
  input.className = "file-rename-input";
  input.value = oldName;
  labelEl.replaceWith(input);
  div.onclick = null;
  input.focus();
  input.select();

  const commit = async () => {
    const newName = input.value.trim();
    if (newName && newName !== oldName) {
      await moveFile(filePath, dir + newName);
    } else {
      await loadFiles();
    }
  };
  input.onkeydown = async e => {
    if (e.key === "Enter")  { e.preventDefault(); await commit(); }
    if (e.key === "Escape") { await loadFiles(); }
  };
  input.onblur = commit;
}

async function moveFile(src, dst) {
  if (!src || !dst || src === dst) return;
  const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/movefile`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ src, dst })
  });
  const data = await res.json();
  if (data.ok) {
    // อัปเดต currentFile และ tabs ถ้าไฟล์ที่ย้ายกำลังเปิดอยู่
    if (currentFile === src) _ssCurrentFile(dst);
    const tab = openTabs.find(t => t.name === src);
    if (tab) tab.name = dst;
    renderTabs();
    await loadFiles();
  }
}

// root drop zone (ลากออกมาวางในพื้นที่ว่าง = ย้ายไป root)
;(function() {
  const treeEl = document.getElementById("file-tree");
  treeEl.addEventListener("dragover", e => {
    e.preventDefault();
    treeEl.classList.add("drag-over-root");
  });
  treeEl.addEventListener("dragleave", e => {
    if (!treeEl.contains(e.relatedTarget))
      treeEl.classList.remove("drag-over-root");
  });
  treeEl.addEventListener("drop", async e => {
    e.preventDefault();
    treeEl.classList.remove("drag-over-root");
    const src = e.dataTransfer.getData("text/plain");
    if (!src) return;
    const filename = src.split("/").pop();
    if (src === filename) return; // อยู่ root อยู่แล้ว
    await moveFile(src, filename);
  });
})();

// ── UPLOAD FILES ─────────────────────────────────────────────
export function triggerUpload() {
  if (!currentProject) return alert("Select a project first.");
  document.getElementById("upload-input").value = "";
  document.getElementById("upload-input").click();
}

export async function handleUpload(fileList) {
  if (!fileList || !fileList.length || !currentProject) return;
  const status = document.getElementById("compile-status");
  status.textContent = `Uploading ${fileList.length} file(s)…`;
  status.className = "compile-status";

  const form = new FormData();
  for (const f of fileList) form.append("files", f);

  const res  = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/upload`, { method: "POST", body: form });
  const data = await res.json();
  if (data.ok) {
    status.textContent = `✓ Uploaded ${data.files.length} file(s)`;
    status.className = "compile-status ok";
    await loadFiles();
  } else {
    status.textContent = "✗ Upload failed";
    status.className = "compile-status err";
  }
}

// Drag-and-drop upload onto file tree
;(function() {
  const tree = document.getElementById("file-tree");
  tree.addEventListener("dragenter", e => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); tree.classList.add("upload-hover"); } });
  tree.addEventListener("dragover",  e => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); } });
  tree.addEventListener("dragleave", e => { if (!tree.contains(e.relatedTarget)) tree.classList.remove("upload-hover"); });
  tree.addEventListener("drop", async e => {
    tree.classList.remove("upload-hover");
    if (!e.dataTransfer.files.length) return;
    // ถ้าเป็นไฟล์จากภายนอก (ไม่ใช่ drag-and-drop ไฟล์ภายใน)
    const isExternal = !e.dataTransfer.getData("text/plain");
    if (!isExternal) return;
    e.preventDefault(); e.stopPropagation();
    await handleUpload(e.dataTransfer.files);
  });
})();

// ── IMPORT ZIP ────────────────────────────────────────────────
export function onZipSelected(input) {
  const file = input.files[0];
  if (!file) return;
  document.getElementById("zip-drop-label").textContent = `📦 ${file.name}`;
  const name = file.name.replace(/\.zip$/i, "").replace(/[^a-zA-Z0-9_\- ]/g, "_");
  document.getElementById("input-zip-name").value = name;
}

;(function() {
  const zone = document.getElementById("zip-drop-zone");
  zone.addEventListener("dragover",  e => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", e => {
    e.preventDefault(); zone.classList.remove("over");
    const file = e.dataTransfer.files[0];
    if (!file || !file.name.endsWith(".zip")) return alert("Please drop a .zip file");
    document.getElementById("zip-file-input").files; // can't set directly
    // manually set via DataTransfer trick
    const dt = new DataTransfer(); dt.items.add(file);
    document.getElementById("zip-file-input").files = dt.files;
    onZipSelected(document.getElementById("zip-file-input"));
  });
})();

export async function importZip() {
  const fileInput = document.getElementById("zip-file-input");
  const name      = document.getElementById("input-zip-name").value.trim();
  if (!fileInput.files[0]) return alert("Please select a ZIP file.");
  if (!name)               return alert("Please enter a project name.");

  const btn = document.getElementById("import-zip-btn");
  btn.textContent = "Importing…"; btn.disabled = true;

  const form = new FormData();
  form.append("file", fileInput.files[0]);
  form.append("name", name);

  const res  = await fetch("/api/import-zip", { method: "POST", body: form });
  const data = await res.json();
  btn.textContent = "Import"; btn.disabled = false;

  if (data.ok) {
    closeModal("modal-import-zip");
    await loadProjects();
    document.getElementById("project-select").value = data.name;
    await switchProject(data.name);
  } else {
    alert("Import failed: " + data.error);
  }
}

function setMainFile(path) {
  _ssMainFile(path);
  const status = document.getElementById("compile-status");
  status.textContent = `Main: ${path.split("/").pop()}`;
  status.className = "compile-status";
  loadFiles();  // re-render stars
  // v3.2.2 — \include{} list is keyed off the main file; if the user
  // switches main, refresh availableIncludes (and reconcile the saved
  // selection) so the popup reflects the new file's chapters.
  loadIncludes();
}

export function showNewFolder() {
  if (!currentProject) return alert("Select a project first.");
  document.getElementById("input-folder-name").value = "";
  openModal("modal-folder");
  setTimeout(() => document.getElementById("input-folder-name").focus(), 100);
}

export async function createFolder() {
  const name = document.getElementById("input-folder-name").value.trim();
  if (!name) return;
  await fetch(`/api/projects/${encodeURIComponent(currentProject)}/newfolder`, {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ path: name })
  });
  closeModal("modal-folder");
  openFolders.add(name);   // auto-expand folder ใหม่
  await loadFiles();
}

export function showNewFile() {
  if (!currentProject) return alert("Select a project first.");
  document.getElementById("input-file-name").value = "";
  openModal("modal-file");
  setTimeout(() => document.getElementById("input-file-name").focus(), 100);
}

export async function createFile() {
  const name = document.getElementById("input-file-name").value.trim();
  if (!name) return;
  await fetch(`/api/projects/${encodeURIComponent(currentProject)}/newfile`, {
    method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({path:name})
  });
  closeModal("modal-file");
  await loadFiles();
  openFile(name);
}

async function deleteFile(e, name) {
  e.stopPropagation();
  if (!confirm(`Delete ${name}?`)) return;
  // Cancel pending auto-save before nuking the file — otherwise the timer
  // could re-create the file we just asked the server to delete.
  if (currentFile === name) {
    clearTimeout(saveTimer);
    _ssSaveTimer(null);
  }
  await fetch(`/api/projects/${encodeURIComponent(currentProject)}/file?path=${encodeURIComponent(name)}`, { method:"DELETE" });
  if (currentFile === name) {
    _ssCurrentFile(null);
    _ssOpenTabs(openTabs.filter(t => t.name !== name));
    CM.setValue("");
    renderTabs();
  }
  loadFiles();
}
