"use strict";
/* Level 2 mode — timeline engine (plan §2.4) driving the radar-core GPU
   layer: catalog poll → prefetch binary artifacts newest-first into the
   renderer's ring buffer → playback clock swaps GPU textures per frame. */

window.viewMode = "tiles";
const l2 = { site: null, cat: null, sel: { tilt: 0, moment: "REF" },
             frameIds: [], cur: -1, playing: true, timer: null, pollTimer: null,
             tables: {}, layer: null, loadToken: 0 };

fetch("/api/colortables").then(r => r.json()).then(t => { l2.tables = t; })
  .catch(() => {});

/* ----------------------------- color tables ----------------------------- */
function lutFor(moment, lo, hi) {
  const stops = l2.tables[moment] ||
    [{ v: lo, rgb: [80, 80, 200], rgb2: [220, 220, 60] },
     { v: (lo + hi) / 2, rgb: [220, 220, 60], rgb2: [220, 40, 40] }];
  const lut = new Uint8Array(256 * 4);
  for (let raw = 2; raw < 256; raw++) {
    const v = lo + (raw - 2) / 253 * (hi - lo);
    let seg = null, next = null;
    for (let i = 0; i < stops.length; i++)
      if (v >= stops[i].v) { seg = stops[i]; next = stops[i + 1]; }
    if (!seg) continue;
    let rgb = seg.rgb;
    if (seg.rgb2) {
      const hiV = next ? next.v : hi;
      const k = Math.max(0, Math.min(1, (v - seg.v) / ((hiV - seg.v) || 1)));
      rgb = seg.rgb.map((c, i) => Math.round(c + (seg.rgb2[i] - c) * k));
    }
    lut.set([...rgb, seg.a ?? 235], raw * 4);
  }
  return lut;
}

/* ------------------------------- helpers ------------------------------- */
function currentSite() {
  const v = $("site-select").value;
  return v === "__custom" ? $("site-custom").value.toUpperCase() : v;
}
function ensureLayer() {
  if (!l2.layer && map) l2.layer = RadarCore.leafletLayer(map, "radargl");
  return l2.layer;
}

/* ------------------------- timeline: prefetch ------------------------- */
async function loadFrames() {
  const token = ++l2.loadToken;
  const site = currentSite();
  if (!site || !l2.cat || !ensureLayer()) return;
  const entry = l2.cat.tilts[l2.sel.tilt] || l2.cat.tilts[0];
  if (!entry) { $("frame-time").textContent = "L2: no tilts decoded"; return; }
  const wantN = Math.min(+(localStorage.getItem("frameCount") || 10), 8,
                         l2.cat.volumes.length);
  const vols = l2.cat.volumes.slice(-wantN);
  l2.frameIds = vols.map(v => v.id);
  $("frame-slider").max = Math.max(0, vols.length - 1);
  const R = l2.layer.renderer;
  R.maxFrames = Math.max(12, wantN + 2);

  for (let i = vols.length - 1; i >= 0; i--) {         // newest first
    if (token !== l2.loadToken) return;
    const id = vols[i].id;
    const key = frameKeyOf(id, entry.angle, l2.sel.moment);
    if (!R.header(key)) {
      $("frame-time").textContent =
        `L2: loading volume ${vols.length - i}/${vols.length}…`;
      try {
        const resp = await fetch(`/api/l2/artifact?site=${site}` +
          `&vol=${encodeURIComponent(id)}&angle=${entry.angle}` +
          `&moment=${l2.sel.moment}`);
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          $("frame-time").textContent = "L2: " + (err.error || resp.status);
          continue;
        }
        const { header, grid } = RadarCore.parseArtifact(await resp.arrayBuffer());
        if (token !== l2.loadToken) return;
        R.addFrame(key, header, grid);
      } catch (e) { $("frame-time").textContent = "L2: " + e.message; continue; }
    }
    if (i === vols.length - 1) showL2Frame(i);         // paint newest ASAP
  }
  showL2Frame(l2.frameIds.length - 1);
}

const frameKeyOf = (id, angle, moment) => `${id}|${angle}|${moment}`;

function showL2Frame(i) {
  const R = l2.layer?.renderer;
  if (!R || !l2.frameIds.length || !l2.cat) return;
  const entry = l2.cat.tilts[l2.sel.tilt] || l2.cat.tilts[0];
  // walk to the nearest loaded frame if this one isn't ready yet
  const keys = l2.frameIds.map(id => frameKeyOf(id, entry.angle, l2.sel.moment));
  if (!R.header(keys[i])) {
    const loaded = keys.map((k, j) => R.header(k) ? j : null).filter(j => j != null);
    if (!loaded.length) return;
    i = loaded.reduce((a, b) => Math.abs(b - i) < Math.abs(a - i) ? b : a);
  }
  l2.cur = i;
  const h = R.header(keys[i]);
  R.setLUT(lutFor(h.moment, h.lo, h.hi));
  R.setFrame(keys[i]);
  l2.layer.redraw();
  const when = h.time ? new Date(h.time)
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "?";
  $("frame-time").textContent =
    `LEVEL II · ${h.moment} · ${(h.angle ?? 0).toFixed(1)}° · ${when}` +
    ` · vol ${i + 1}/${l2.frameIds.length} · echo ${h.pct_echo}%`;
  $("frame-slider").value = i;
}

function l2SetPlaying(p) {
  l2.playing = p;
  $("play-btn").textContent = p ? "⏸" : "▶";
  clearInterval(l2.timer);
  if (p) l2.timer = setInterval(() => {
    if (l2.frameIds.length) showL2Frame((l2.cur + 1) % l2.frameIds.length);
  }, +$("speed-slider").value);
}

/* ------------------------------ toolbar ------------------------------ */
function syncL2Toolbar() {
  const tilt = $("tilt-select"), mom = $("l2-moment-select");
  const tHtml = l2.cat.tilts.map((t, i) =>
    `<option value="${i}">${t.angle.toFixed(1)}°</option>`).join("");
  if (tilt.dataset.r !== tHtml) { tilt.innerHTML = tHtml; tilt.dataset.r = tHtml; }
  l2.sel.tilt = Math.min(l2.sel.tilt, l2.cat.tilts.length - 1);
  tilt.value = l2.sel.tilt;
  const moms = l2.cat.tilts[l2.sel.tilt]?.moments || ["REF"];
  const mHtml = moms.map(m => `<option>${m}</option>`).join("");
  if (mom.dataset.r !== mHtml) { mom.innerHTML = mHtml; mom.dataset.r = mHtml; }
  if (!moms.includes(l2.sel.moment)) l2.sel.moment = moms[0];
  mom.value = l2.sel.moment;
}

async function l2Refresh(force) {
  const site = currentSite();
  if (!site || site === "__custom") return;
  try {
    const resp = await fetch(`/api/l2/catalog?site=${site}`);
    const cat = await resp.json();
    if (cat.error || !Array.isArray(cat.tilts) || !Array.isArray(cat.volumes)) {
      $("frame-time").textContent = "L2: " +
        (cat.error || cat.detail || `catalog HTTP ${resp.status}`);
      return;
    }
    const changed = force || l2.site !== site ||
      cat.volumes.at(-1)?.id !== l2.cat?.volumes?.at(-1)?.id;
    l2.site = site; l2.cat = cat;
    syncL2Toolbar();
    if (changed) await loadFrames();
  } catch (e) { $("frame-time").textContent = "L2: " + e.message; }
}

/* -------------------------------- mode -------------------------------- */
function setViewMode(mode) {
  window.viewMode = mode;
  localStorage.setItem("viewMode", mode);
  const isL2 = mode === "l2";
  document.querySelectorAll(".l2-only").forEach(el => el.hidden = !isL2);
  document.querySelectorAll(".tiles-only").forEach(el => el.hidden = isL2);
  if (isL2) {
    setPlaying(false);
    radarLayers.forEach(l => map && map.removeLayer(l));
    radarLayers = []; frameKey = "";
    if (ensureLayer()) l2.layer.renderer.opacity = radarOpacity;
    l2Refresh(true);
    l2SetPlaying(true);
    l2.pollTimer = setInterval(() => l2Refresh(false), 30000);
  } else {
    clearInterval(l2.pollTimer); clearInterval(l2.timer);
    if (l2.layer) { l2.layer.remove(); l2.layer = null; }
    l2.cat = null; l2.frameIds = [];
    $("frame-time").textContent = "waiting for radar…";
    setPlaying(true);
  }
}

$("view-select").onchange = e => setViewMode(e.target.value);
$("tilt-select").onchange = e => { l2.sel.tilt = +e.target.value; loadFrames(); };
$("l2-moment-select").onchange = e => { l2.sel.moment = e.target.value; loadFrames(); };
$("l2-smooth").onchange = e => {
  if (l2.layer) { l2.layer.renderer.setSmoothing(e.target.checked); l2.layer.redraw(); }
};
$("play-btn").addEventListener("click", () => {
  if (window.viewMode === "l2") l2SetPlaying(!l2.playing);
});
$("frame-slider").addEventListener("input", e => {
  if (window.viewMode === "l2") { l2SetPlaying(false); showL2Frame(+e.target.value); }
});
$("speed-slider").addEventListener("input", () => {
  if (window.viewMode === "l2") l2SetPlaying(l2.playing);
});
$("opacity-slider").addEventListener("input", () => {
  if (l2.layer) { l2.layer.renderer.opacity = radarOpacity; l2.layer.redraw(); }
});
$("frames-select").addEventListener("change", () => {
  if (window.viewMode === "l2") loadFrames();
});
$("site-select").addEventListener("change", () => {
  if (window.viewMode === "l2" && $("site-select").value !== "__custom")
    l2Refresh(true);
});

if (localStorage.getItem("viewMode") === "l2") {
  $("view-select").value = "l2";
  setTimeout(() => setViewMode("l2"), 1500);
}
