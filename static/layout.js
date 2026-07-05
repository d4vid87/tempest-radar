"use strict";
/* layout: every UI element is a free panel. Edit mode (✎) lets the user
   drag, resize, hide, and scale each one; the arrangement persists in
   localStorage and can be exported/imported as JSON. Nothing is static. */

const Layout = (() => {

const LS_KEY = "layout.v3";

/* Panel registry: id -> { el, title, defaults(vw,vh) -> {x,y,w?}, resizable } */
const REG = [
  /* row 0: tickers span the top */
  { id: "ticker",         title: "News ticker",     d: (vw) => ({ x: 0, y: 0,  w: vw }), rs: true },
  { id: "wx-ticker",      title: "Weather ticker",  d: (vw) => ({ x: 0, y: 28, w: vw }), rs: true },
  /* floating chrome, RadarOmega-style: site badge centered up top,
     mode toggle beside the menu button, controls pinned to the bottom */
  { id: "panel-site",     title: "Radar site",      d: (vw) => ({ x: Math.round(vw / 2 - 150), y: 66 }) },
  { id: "panel-view",     title: "View mode",       d: () => ({ x: 70, y: 66 }) },
  { id: "panel-banner",   title: "Alert banner",    d: (vw) => ({ x: Math.round(vw * 0.28), y: 116, w: Math.round(vw * 0.44) }), rs: true },
  { id: "panel-frames",   title: "Frames / map",    d: (vw, vh) => ({ x: 12, y: vh - 56 }) },
  { id: "panel-product",  title: "Product (loop)",  d: (vw, vh) => ({ x: vw - 320, y: vh - 56 }) },
  { id: "panel-l2",       title: "Tilt / moment",   d: (vw, vh) => ({ x: vw - 620, y: vh - 56 }) },
  { id: "panel-windy",    title: "Windy layer",     d: (vw, vh) => ({ x: vw - 480, y: vh - 56 }) },
  /* right rail: telemetry cards */
  { id: "card-station",   title: "Station card",    d: (vw) => ({ x: vw - 246, y: 112, w: 230 }), rs: true },
  { id: "card-wind",      title: "Wind card",       d: (vw) => ({ x: vw - 246, y: 234, w: 230 }), rs: true },
  { id: "card-pressure",  title: "Pressure card",   d: (vw) => ({ x: vw - 246, y: 456, w: 230 }), rs: true },
  { id: "card-rainsun",   title: "Rain/sun card",   d: (vw) => ({ x: vw - 246, y: 572, w: 230 }), rs: true },
  { id: "card-lightning", title: "Lightning card",  d: (vw) => ({ x: vw - 246, y: 668, w: 230 }), rs: true },
  /* bottom center: playback bar, status tucked above it */
  { id: "timebar",        title: "Timeline",        d: (vw, vh) => ({ x: Math.round(vw * 0.24), y: vh - 62, w: Math.round(vw * 0.52) }), rs: true },
  { id: "statusbar",      title: "Status readout",  d: (vw, vh) => ({ x: 12, y: vh - 92 }) },
];

let state = { panels: {}, uiScale: 1, panelAlpha: 0.92 };
let editing = false;
window.uiEditMode = false;

function load() {
  try { Object.assign(state, JSON.parse(localStorage.getItem(LS_KEY) || "{}")); }
  catch { /* fresh start */ }
}
function save() { localStorage.setItem(LS_KEY, JSON.stringify(state)); }

const stage = () => document.querySelector("main");
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function applyOne(reg) {
  const el = document.getElementById(reg.id);
  if (!el) return;
  const box = stage().getBoundingClientRect();
  const p = state.panels[reg.id] || {};
  const d = reg.d(box.width, box.height);
  const w = p.w ?? d.w;
  const x = clamp(p.x ?? d.x, 0, Math.max(0, box.width - 60));
  const y = clamp(p.y ?? d.y, 0, Math.max(0, box.height - 30));
  el.style.left = x + "px";
  el.style.top = y + "px";
  if (w != null) el.style.width = w + "px";
  el.style.display = p.hidden ? "none" : "";
}

function applyAll() {
  REG.forEach(applyOne);
  document.documentElement.style.setProperty("--ui-scale", state.uiScale);
  document.documentElement.style.setProperty("--panel-alpha", state.panelAlpha);
}

/* ------------------------------ edit mode ------------------------------ */
function setEditing(on) {
  editing = on;
  window.uiEditMode = on;
  document.body.classList.toggle("edit-mode", on);
  $("layout-panel").hidden = !on;
  $("layout-btn").classList.toggle("on", on);
  if (on) renderLayoutList();
  else save();
}

function startDrag(e, el, reg, resize) {
  if (!editing) return;
  e.preventDefault();
  e.stopPropagation();
  const box = stage().getBoundingClientRect();
  const startX = e.clientX, startY = e.clientY;
  const r = el.getBoundingClientRect();
  const ox = r.left - box.left, oy = r.top - box.top, ow = r.width;
  const move = ev => {
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    const snap = v => Math.round(v / 8) * 8;
    const p = state.panels[reg.id] = state.panels[reg.id] || {};
    if (resize) {
      p.w = Math.max(120, snap(ow + dx));
      el.style.width = p.w + "px";
    } else {
      p.x = clamp(snap(ox + dx), 0, box.width - 60);
      p.y = clamp(snap(oy + dy), 0, box.height - 30);
      el.style.left = p.x + "px";
      el.style.top = p.y + "px";
    }
  };
  const up = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    save();
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
}

function wire() {
  for (const reg of REG) {
    const el = document.getElementById(reg.id);
    if (!el) continue;
    el.classList.add("panel");
    el.addEventListener("pointerdown", e => {
      if (e.target.classList.contains("rs-handle")) return;
      startDrag(e, el, reg, false);
    });
    if (reg.rs) {
      const h = document.createElement("div");
      h.className = "rs-handle";
      h.title = "drag to resize";
      h.addEventListener("pointerdown", e => startDrag(e, el, reg, true));
      el.appendChild(h);
    }
    // block control interaction while editing (drag wins)
    el.addEventListener("click", e => { if (editing) { e.stopPropagation(); e.preventDefault(); } }, true);
  }
}

/* ---------------------------- layout window ---------------------------- */
function renderLayoutList() {
  $("layout-list").innerHTML = REG.map(r => {
    const hidden = state.panels[r.id]?.hidden;
    return `<label class="lay-row"><input type="checkbox" data-p="${r.id}"
      ${hidden ? "" : "checked"}> ${r.title}</label>`;
  }).join("");
  $("layout-list").querySelectorAll("input").forEach(cb => {
    cb.onchange = () => {
      const p = state.panels[cb.dataset.p] = state.panels[cb.dataset.p] || {};
      p.hidden = !cb.checked;
      applyOne(REG.find(r => r.id === cb.dataset.p));
      save();
    };
  });
  $("ui-scale").value = state.uiScale;
  $("panel-alpha").value = state.panelAlpha;
}

function init() {
  load();
  wire();
  applyAll();
  window.addEventListener("resize", applyAll);
  $("layout-btn").onclick = () => setEditing(!editing);
  $("layout-done").onclick = () => setEditing(false);
  $("layout-reset").onclick = () => {
    state = { panels: {}, uiScale: 1, panelAlpha: 0.92 };
    save(); applyAll(); renderLayoutList();
  };
  $("ui-scale").oninput = e => {
    state.uiScale = +e.target.value;
    document.documentElement.style.setProperty("--ui-scale", state.uiScale);
    save();
  };
  $("panel-alpha").oninput = e => {
    state.panelAlpha = +e.target.value;
    document.documentElement.style.setProperty("--panel-alpha", state.panelAlpha);
    save();
  };
  $("layout-export").onclick = () => {
    navigator.clipboard?.writeText(JSON.stringify(state));
    $("layout-msg").textContent = "layout copied to clipboard";
    setTimeout(() => $("layout-msg").textContent = "", 2000);
  };
  $("layout-import").onclick = () => {
    const txt = prompt("Paste a layout JSON:");
    if (!txt) return;
    try { state = JSON.parse(txt); save(); applyAll(); renderLayoutList(); }
    catch { $("layout-msg").textContent = "invalid JSON"; }
  };
}

return { init, isEditing: () => editing };
})();
