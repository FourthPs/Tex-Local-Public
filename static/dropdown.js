// static/dropdown.js — v5.x — Custom dropdown component (tl-dd).
//
// Replaces the flat, OS-rendered <select> popup with a floating card menu that
// matches the cite-hint (.CodeMirror-hints) and spell-context-menu look:
// var(--surface) card, --border, rounded, soft shadow, accent-highlighted
// selection. Native <select> lists can't be styled with CSS (the OS draws
// them), so to get that look we ENHANCE the select rather than restyle it.
//
// Enhancement = keep the native <select> in the DOM as the hidden source of
// truth, and render our own trigger button + menu beside it. This means every
// existing behavior keeps working untouched:
//   - inline onchange="..." handlers  (we dispatch a real 'change' event)
//   - programmatic `select.value = x` (mirrored into the trigger label on the
//     next Settings-panel open via the MutationObserver in _initDropdowns)
//   - dynamically populated options / <optgroup>s (menu is rebuilt from the
//     select's current children every time it opens)
//
// Phase 1 targets the 3 Settings selects (editor theme, accent color,
// compiler). Toolbar / project / GitHub-modal selects are intentionally left
// native for now — enhanceSelect() works on any of them when we extend later.

const CHEVRON =
  '<svg class="tl-dd-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
  'aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
const CHECK =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<polyline points="20 6 9 17 4 12"/></svg>';

// Only one menu is ever open. Track it so any new open (or outside click / Esc /
// resize) tears the previous one down cleanly.
const _open = { menu: null, trigger: null, cleanup: null };

function _closeMenu() {
  if (_open.cleanup) { _open.cleanup(); _open.cleanup = null; }
  if (_open.menu) { _open.menu.remove(); _open.menu = null; }
  if (_open.trigger) {
    _open.trigger.setAttribute("aria-expanded", "false");
    _open.trigger = null;
  }
}

function _syncTrigger(trigger, sel) {
  const opt = sel.selectedOptions[0];
  const label = trigger.querySelector(".tl-dd-label");
  if (label) label.textContent = opt ? opt.textContent : "";
  // v5.8.0p7 — mirror the native disabled state (dashboard's repo select is
  // disabled while loading / signed out; editor-page selects never disable).
  trigger.disabled = sel.disabled;
}

function _mkItem(opt, sel, trigger, items) {
  const it = document.createElement("div");
  const isSel = opt.value === sel.value;
  it.className = "tl-dd-item" + (isSel ? " sel" : "");
  it.setAttribute("role", "option");
  it.setAttribute("aria-selected", isSel ? "true" : "false");
  it.dataset.value = opt.value;
  it.innerHTML = '<span class="tl-dd-check">' + CHECK + "</span><span class=\"tl-dd-text\"></span>";
  it.querySelector(".tl-dd-text").textContent = opt.textContent;
  it.addEventListener("click", (e) => {
    e.stopPropagation();
    if (sel.value !== opt.value) {
      sel.value = opt.value;
      // Real change event → fires the inline onchange="setAppearance(this.value)"
      // etc. exactly as a native <select> pick would.
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    _syncTrigger(trigger, sel);
    _closeMenu();
    trigger.focus();
  });
  items.push(it);
  return it;
}

function _position(menu, trigger) {
  const r = trigger.getBoundingClientRect();
  menu.style.minWidth = r.width + "px";
  menu.style.visibility = "hidden";
  menu.style.left = "0px";
  menu.style.top = "0px";
  const mh = menu.offsetHeight;
  const mw = menu.offsetWidth;
  let top = r.bottom + 4;
  // Flip up if it would overflow the bottom and there's room above.
  if (top + mh > window.innerHeight - 8 && r.top - 4 - mh > 8) {
    top = r.top - 4 - mh;
  }
  let left = r.left;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - 8 - mw;
  if (left < 8) left = 8;
  menu.style.left = left + "px";
  menu.style.top = top + "px";
  menu.style.visibility = "";
}

function _openMenu(trigger, sel) {
  _closeMenu();

  const menu = document.createElement("div");
  menu.className = "tl-dd-menu";
  menu.setAttribute("role", "listbox");
  menu.tabIndex = -1;

  const items = [];
  // Rebuild from the select's live children each open → dynamic options and
  // <optgroup>s (editor-theme Light/Dark groups) are always current.
  for (const node of sel.children) {
    if (node.tagName === "OPTGROUP") {
      const gl = document.createElement("div");
      gl.className = "tl-dd-group";
      gl.textContent = node.label;
      menu.appendChild(gl);
      for (const opt of node.children) menu.appendChild(_mkItem(opt, sel, trigger, items));
    } else if (node.tagName === "OPTION") {
      menu.appendChild(_mkItem(node, sel, trigger, items));
    }
  }

  document.body.appendChild(menu);
  _position(menu, trigger);
  _open.menu = menu;
  _open.trigger = trigger;
  trigger.setAttribute("aria-expanded", "true");

  let hi = items.findIndex((it) => it.dataset.value === sel.value);
  if (hi < 0) hi = 0;
  const setHi = (i) => {
    items.forEach((it) => it.classList.remove("hi"));
    if (items[i]) {
      items[i].classList.add("hi");
      items[i].scrollIntoView({ block: "nearest" });
      hi = i;
    }
  };
  setHi(hi);

  const onKey = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setHi(Math.min(items.length - 1, hi + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi(Math.max(0, hi - 1)); }
    else if (e.key === "Home") { e.preventDefault(); setHi(0); }
    else if (e.key === "End") { e.preventDefault(); setHi(items.length - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (items[hi]) items[hi].click(); }
    else if (e.key === "Escape") { e.preventDefault(); _closeMenu(); trigger.focus(); }
    else if (e.key === "Tab") { _closeMenu(); }
  };
  // Ignore clicks on the trigger itself — its own handler owns the toggle
  // (open→close). Without this guard the capture-phase close here fires first,
  // then the trigger handler sees no open menu and immediately reopens it.
  const onDocClick = (e) => {
    if (!menu.contains(e.target) && !trigger.contains(e.target)) _closeMenu();
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("click", onDocClick, true);
  window.addEventListener("resize", _closeMenu);
  _open.cleanup = () => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("click", onDocClick, true);
    window.removeEventListener("resize", _closeMenu);
  };
}

// Enhance one native <select>. Idempotent; safe to call more than once.
export function enhanceSelect(sel) {
  if (!sel || sel.dataset.tlEnhanced) return null;
  sel.dataset.tlEnhanced = "1";

  const wrap = document.createElement("div");
  wrap.className = "tl-dd";
  // Size variant inherited from the native select's context so the trigger
  // matches its neighbors: compact toolbar (etb), prominent project bar, or
  // full-width modal field. Settings selects keep the default look.
  if (sel.classList.contains("etb-select")) wrap.classList.add("tl-dd--compact");
  else if (sel.classList.contains("project-selector")) wrap.classList.add("tl-dd--prominent");
  if (sel.id === "gh-visibility" || sel.id === "gh-repo-select") wrap.classList.add("tl-dd--block");
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel); // move the native select inside the wrapper (hidden via CSS)
  sel.classList.add("tl-dd-native");

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "tl-dd-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  if (sel.getAttribute("aria-label")) trigger.setAttribute("aria-label", sel.getAttribute("aria-label"));
  trigger.innerHTML = '<span class="tl-dd-label"></span>' + CHEVRON;
  wrap.appendChild(trigger);
  _syncTrigger(trigger, sel);

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (_open.trigger === trigger) { _closeMenu(); return; }
    _openMenu(trigger, sel);
  });
  // Keep the label right if something dispatches a real change on the select.
  sel.addEventListener("change", () => _syncTrigger(trigger, sel));

  return wrap;
}

// v5.7.2 — public resync for callers that set a select's .value programmatically
// WITHOUT dispatching "change" (dispatching would re-fire the select's inline
// onchange — e.g. switchProject's abort path would loop). Cheap: trigger-text
// sync only, no menu rebuild.
export function _tlddSync() { _syncAll(); }

function _syncAll() {
  document.querySelectorAll(".tl-dd").forEach((wrap) => {
    const sel = wrap.querySelector("select");
    const trigger = wrap.querySelector(".tl-dd-trigger");
    if (sel && trigger) _syncTrigger(trigger, sel);
  });
}

// Called once from boot.js after init(). Enhances the Settings selects and
// re-syncs trigger labels whenever the Settings panel opens (openSettingsPanel
// sets select.value programmatically just before it adds .open).
export function _initDropdowns() {
  // Phase 1 = Settings selects; Phase 2 adds the toolbar + project bar + the
  // GitHub-modal visibility field (all on index.html). dashboard.html's
  // gh-repo-select lives on a separate page/bundle — enhanced there separately.
  ["editor-theme-select", "appearance-select", "compiler-select",
   "project-select", "font-size-select", "tab-size-select",
   "gh-visibility"].forEach((id) => {
    const sel = document.getElementById(id);
    if (sel) enhanceSelect(sel);
  });
  const panel = document.getElementById("settings-panel");
  if (panel) {
    new MutationObserver(() => {
      if (panel.classList.contains("open")) _syncAll();
    }).observe(panel, { attributes: true, attributeFilter: ["class"] });
  }
}
