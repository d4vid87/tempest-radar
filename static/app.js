"use strict";
/* app: data client + UI glue over map-engine / radar-core / timeline. */

/* ------------------------------ helpers ------------------------------ */
const $ = id => document.getElementById(id);
const cToF = c => c == null ? null : c * 9 / 5 + 32;
const msToMph = v => v == null ? null : v * 2.23694;
const mbToInHg = v => v == null ? null : v * 0.02953;
const mmToIn = v => v == null ? null : v / 25.4;
const kmToMi = v => v == null ? null : v * 0.621371;
const COMPASS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
const compass = d => d == null ? "--" : COMPASS[Math.round(d / 22.5) % 16];
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const rel = e => { const m = Math.round((Date.now()/1000 - e)/60);
  if (m < 1) return "now"; if (m < 60) return m + "m";
  const h = Math.round(m/60); return h < 24 ? h + "h" : Math.round(h/24) + "d"; };
const PRODUCT_NAMES = { N0B: "Reflectivity (super-res)", N0Q: "Reflectivity",
  N0U: "Velocity (super-res)", N0V: "Velocity", N0S: "Storm-rel velocity",
  N0R: "Reflectivity (legacy)", NCR: "Composite", NET: "Echo tops",
  EET: "Enh. echo tops", TST: "⊕ calibration" };

/* ------------------------------- state ------------------------------- */
const S = {
  mode: ["l2", "windy"].includes(localStorage.getItem("viewMode"))
    ? localStorage.getItem("viewMode") : "tiles",
  site: null, sites: [], theme: null, tables: {},
  radarOpacity: 0.78,
  tiles: { key: "" },
  l2: { cat: null, sel: { tilt: 0, moment: "REF" }, ids: [], token: 0, poll: null },
  wxItems: null, lastAlerts: [], knownAlertIds: null, soundOn: false,
  mapReady: false,
};
const radarLayer = new RadarCore.RadarLayer();
const tl = new Timeline(onFrame);

/* -------------------------------- map -------------------------------- */
function activeBasemap() {
  return localStorage.getItem("basemap") || S.theme?.basemap || "dark_all";
}
function initMapOnce(lat, lon) {
  if (S.mapReady || typeof maplibregl === "undefined") return;
  S.mapReady = true;
  MapEngine.init("map", [lon, lat], 8, activeBasemap(), map => {
    map.addLayer(radarLayer, map.getLayer("base-ov0") ? "base-ov0" : "alerts-fill");
    radarLayer.setOpacity(S.radarOpacity);
    MapEngine.setSiteMarkers(S.sites, $("site-select").value, chooseSite);
    locRender();
    setMode(S.mode, true);
  });
}

/* --------------------------- custom locations --------------------------- */
let LOCS = [];
async function locLoad() {
  try { LOCS = await (await fetch("/api/locations")).json(); }
  catch { LOCS = []; }
  if (!Array.isArray(LOCS)) LOCS = [];
  locRender();
}
function locSave() {
  fetch("/api/locations", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(LOCS) }).catch(() => {});
}
function locRender() {
  if (S.mapReady) MapEngine.setCustomLocations(LOCS,
    l => MapEngine.flyTo(l.lat, l.lon, 11));
  const box = $("loc-list");
  if (!box) return;
  box.innerHTML = LOCS.length ? LOCS.map((l, i) =>
    `<div class="loc-row" data-i="${i}">
       ${l.icon && l.id ? `<img class="loc-thumb" alt=""
          src="/api/locations/${l.id}/icon?t=${l._t || 0}">` : ""}
       <b>${esc(l.name)}</b>
       <span class="muted">${(+l.lat).toFixed(3)}, ${(+l.lon).toFixed(3)}</span>
       <button class="loc-img" data-img="${i}" title="upload custom image">🖼</button>
       <button class="loc-del" data-del="${i}" title="remove">✕</button>
     </div>`).join("")
    : '<div class="set-hint">No locations yet — add one below.</div>';
  box.querySelectorAll(".loc-row").forEach(row => {
    row.onclick = e => {
      if (e.target.dataset.del != null) {
        LOCS.splice(+e.target.dataset.del, 1);
        locSave(); locRender(); return;
      }
      if (e.target.dataset.img != null) {
        S.locImgIdx = +e.target.dataset.img;
        $("loc-file").click(); return;
      }
      const l = LOCS[+row.dataset.i];
      $("loc-modal").hidden = true;
      MapEngine.flyTo(l.lat, l.lon, 11);
    };
  });
}
function locResizeImage(file, size = 128) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const s = Math.min(img.width, img.height);
      c.getContext("2d").drawImage(img, (img.width - s) / 2,
        (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      c.toBlob(b => b ? resolve(b) : reject(new Error("encode failed")),
               "image/png");
    };
    img.onerror = () => reject(new Error("not an image"));
    img.src = URL.createObjectURL(file);
  });
}
$("loc-file").onchange = async e => {
  const file = e.target.files[0];
  e.target.value = "";
  const l = LOCS[S.locImgIdx];
  if (!file || !l) return;
  if (!l.id) { l.id = Math.random().toString(36).slice(2, 12); }
  try {
    const blob = await locResizeImage(file);
    const r = await fetch(`/api/locations/${l.id}/icon`, { method: "POST",
      headers: { "Content-Type": "image/png" }, body: blob });
    if (!(await r.json()).ok) throw new Error("upload rejected");
    l.icon = true; l._t = Math.floor(performance.now());
    locSave(); locRender();
  } catch (err) { alert("Image upload failed: " + err.message); }
};
function locAdd(name, lat, lon) {
  LOCS.push({ name: name || "Location", lat, lon });
  locSave(); locRender();
  $("loc-name").value = ""; $("loc-geo").value = "";
  $("loc-geo-results").innerHTML = "";
}
$("locations-btn").onclick = () => {
  $("main-menu").hidden = true;
  $("loc-modal").hidden = false;
  locRender();
};
$("loc-close").onclick = () => $("loc-modal").hidden = true;
$("loc-geo-btn").onclick = async () => {
  const q = $("loc-geo").value.trim();
  if (q.length < 3) return;
  $("loc-geo-results").innerHTML = '<div class="set-hint">searching…</div>';
  try {
    const hits = await (await fetch(`/api/geocode?q=${encodeURIComponent(q)}`)).json();
    $("loc-geo-results").innerHTML = (hits || []).map((h, i) =>
      `<button class="geo-hit" data-i="${i}">${esc(h.label)}</button>`).join("")
      || '<div class="set-hint">no results</div>';
    $("loc-geo-results").querySelectorAll(".geo-hit").forEach(btn => {
      btn.onclick = () => {
        const h = hits[+btn.dataset.i];
        locAdd($("loc-name").value.trim() || h.label.split(",")[0], h.lat, h.lon);
      };
    });
  } catch { $("loc-geo-results").innerHTML = '<div class="set-hint">search failed</div>'; }
};
$("loc-geo").onkeydown = e => { if (e.key === "Enter") $("loc-geo-btn").click(); };
$("loc-add-pick").onclick = () => {
  const name = $("loc-name").value.trim();
  $("loc-modal").hidden = true;
  const map = MapEngine.getMap();
  if (!map) return;
  map.getCanvas().style.cursor = "crosshair";
  map.once("click", e => {
    map.getCanvas().style.cursor = "";
    locAdd(name || prompt("Name this location:") || "Location",
           e.lngLat.lat, e.lngLat.lng);
    $("loc-modal").hidden = false;
  });
};
locLoad();

/* --------------------------- timeline glue --------------------------- */
function onFrame(id, i, total) {
  $("frame-slider").max = Math.max(0, total - 1);
  $("frame-slider").value = i;
  if (S.mode === "tiles") {
    MapEngine.showTileFrame(i, S.radarOpacity);
    const ts = id;
    let when = "latest (live)";
    if (ts !== "0") {
      const iso = `${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}T${ts.slice(8,10)}:${ts.slice(10,12)}:00Z`;
      when = new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    $("frame-time").textContent = `${S.tiles.site || ""} ${S.tiles.product || ""} · ${when} · ${i + 1}/${total}`;
  } else {
    const h = radarLayer.header(id);
    if (!h) {  // not loaded yet — snap to nearest loaded
      const loaded = tl.frames.map((f, j) => radarLayer.header(f) ? j : null)
                       .filter(j => j != null);
      if (loaded.length) tl.show(loaded.reduce((a, b) =>
        Math.abs(b - i) < Math.abs(a - i) ? b : a));
      return;
    }
    radarLayer.setLUT(lutFor(h.moment, h.lo, h.hi));
    radarLayer.setFrame(id);
    const when = h.time ? new Date(h.time)
      .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "live";
    $("frame-time").textContent =
      `L2 ${h.moment} · ${(h.angle ?? 0).toFixed(1)}° · ${when} · ` +
      `${i + 1}/${total} · echo ${h.pct_echo}%`;
  }
}

/* ------------------------------ tiles mode ------------------------------ */
function applyTiles(radar) {
  if (!S.mapReady || S.mode !== "tiles" || !radar?.frames?.length) return;
  const n = +(localStorage.getItem("frameCount") || 10);
  const frames = radar.frames.slice(-n);
  const key = radar.site + radar.product + frames.join(",")
            + (frames[0] === "0" ? radar.updated : "");
  if (key === S.tiles.key) return;
  S.tiles.key = key;
  S.tiles.site = radar.site; S.tiles.product = radar.product;
  MapEngine.setTileFrames(frames.map(ts => {
    let u = `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::${radar.site}-${radar.product}-${ts}/{z}/{x}/{y}.png`;
    if (ts === "0") u += "?t=" + Date.now();
    return u;
  }));
  tl.setFrames(frames);
  if (!tl.playing) tl.play();
}
function syncProductSelect(radar) {
  const sel = $("product-select");
  const products = radar.products?.length ? radar.products : [radar.product];
  const html = products.map(p =>
    `<option value="${p}">${p}${PRODUCT_NAMES[p] ? " — " + PRODUCT_NAMES[p] : ""}</option>`).join("");
  if (sel.dataset.r !== html) { sel.innerHTML = html; sel.dataset.r = html; }
  if (document.activeElement !== sel) sel.value = radar.product;
}

/* ------------------------------- L2 mode ------------------------------- */
const frameKeyOf = (id, angle, moment) => `${id}|${angle}|${moment}`;

async function l2Refresh(force) {
  if (S.mode !== "l2" || !S.site || !S.mapReady) return;
  try {
    const resp = await fetch(`/api/l2/catalog?site=${S.site}`);
    const cat = await resp.json();
    if (cat.error || !Array.isArray(cat.tilts) || !Array.isArray(cat.volumes)) {
      $("frame-time").textContent = "L2: " +
        (cat.error || cat.detail || `catalog HTTP ${resp.status}`);
      return;
    }
    const changed = force ||
      cat.volumes.at(-1)?.id !== S.l2.cat?.volumes?.at(-1)?.id;
    S.l2.cat = cat;
    syncL2Toolbar();
    if (changed) await l2LoadFrames();
  } catch (e) { $("frame-time").textContent = "L2: " + e.message; }
}

function syncL2Toolbar() {
  const cat = S.l2.cat, tilt = $("tilt-select"), mom = $("l2-moment-select");
  const tHtml = cat.tilts.map((t, i) =>
    `<option value="${i}">${t.angle.toFixed(1)}°</option>`).join("");
  if (tilt.dataset.r !== tHtml) { tilt.innerHTML = tHtml; tilt.dataset.r = tHtml; }
  S.l2.sel.tilt = Math.min(S.l2.sel.tilt, cat.tilts.length - 1);
  tilt.value = S.l2.sel.tilt;
  syncPaletteSelect();
  const moms = cat.tilts[S.l2.sel.tilt]?.moments || ["REF"];
  const mHtml = moms.map(m =>
    `<option value="${m}">${m}${PRODUCT_NAMES[m] ? " — " + PRODUCT_NAMES[m] : ""}</option>`).join("");
  if (mom.dataset.r !== mHtml) { mom.innerHTML = mHtml; mom.dataset.r = mHtml; }
  if (!moms.includes(S.l2.sel.moment)) S.l2.sel.moment = moms[0];
  mom.value = S.l2.sel.moment;
}

async function l2LoadFrames() {
  const token = ++S.l2.token;
  const cat = S.l2.cat;
  const entry = cat.tilts[S.l2.sel.tilt] || cat.tilts[0];
  if (!entry) { $("frame-time").textContent = "L2: no tilts decoded"; return; }
  const wantN = Math.min(+(localStorage.getItem("frameCount") || 10), 8,
                         cat.volumes.length);
  const vols = cat.volumes.slice(-wantN);
  const keys = vols.map(v => frameKeyOf(v.id, entry.angle, S.l2.sel.moment));
  radarLayer.maxFrames = Math.max(12, wantN + 2);
  S.l2.ids = keys;
  tl.setFrames(keys, false);

  for (let i = vols.length - 1; i >= 0; i--) {       // newest first
    if (token !== S.l2.token) return;
    if (!radarLayer.header(keys[i])) {
      $("frame-time").textContent =
        `L2: loading volume ${vols.length - i}/${vols.length}…`;
      try {
        const r = await fetch(`/api/l2/artifact?site=${S.site}` +
          `&vol=${encodeURIComponent(vols[i].id)}&angle=${entry.angle}` +
          `&moment=${S.l2.sel.moment}`);
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          $("frame-time").textContent = "L2: " + (err.error || r.status);
          continue;
        }
        const { header, grid } = RadarCore.parseArtifact(await r.arrayBuffer());
        if (token !== S.l2.token) return;
        radarLayer.addFrame(keys[i], header, grid);
      } catch (e) { $("frame-time").textContent = "L2: " + e.message; continue; }
    }
    if (i === vols.length - 1) tl.show(vols.length - 1);
  }
  tl.show(keys.length - 1);
  if (!tl.playing) tl.play();
}

/* ---------------------------- color tables ---------------------------- */
fetch("/api/colortables").then(r => r.json()).then(t => {
  S.tables = t; syncPaletteSelect();
}).catch(() => {});
function paletteFor(moment) {
  const list = S.tables[moment] || [];
  const want = localStorage.getItem("pal:" + moment);
  return list.find(p => p.name === want) || list[0] || null;
}
function syncPaletteSelect() {
  const sel = $("palette-select"), list = S.tables[S.l2.sel.moment] || [];
  const html = list.map(p => `<option>${esc(p.name)}</option>`).join("");
  if (sel.dataset.r !== html) { sel.innerHTML = html; sel.dataset.r = html; }
  const cur = paletteFor(S.l2.sel.moment);
  if (cur) sel.value = cur.name;
}
function lutFor(moment, lo, hi) {
  const stops = paletteFor(moment)?.stops ||
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
      rgb = seg.rgb.map((c, j) => Math.round(c + (seg.rgb2[j] - c) * k));
    }
    lut.set([...rgb, seg.a ?? 235], raw * 4);
  }
  return lut;
}

/* ------------------------------ mode switch ------------------------------ */
/* Overlays the Windy embed API supports (premium-only layers excluded). */
const WINDY_OVERLAYS = [
  ["radar", "Radar"], ["satellite", "Satellite"], ["wind", "Wind"],
  ["gust", "Wind gusts"], ["gustAccu", "Gust accumulation"],
  ["rain", "Rain, thunder"], ["rainAccu", "Rain accumulation"],
  ["snowAccu", "New snow"], ["snowcover", "Snow depth"],
  ["ptype", "Precip type"], ["thunder", "Thunderstorms"],
  ["temp", "Temperature"], ["dewpoint", "Dew point"], ["rh", "Humidity"],
  ["wetbulbtemp", "Wet bulb temp"], ["solarpower", "Solar power"],
  ["uvindex", "UV index"], ["clouds", "Clouds"], ["hclouds", "High clouds"],
  ["mclouds", "Medium clouds"], ["lclouds", "Low clouds"], ["fog", "Fog"],
  ["visibility", "Visibility"], ["cbase", "Cloud base"],
  ["cape", "CAPE index"], ["ccl", "Convective layer"],
  ["pressure", "Pressure"], ["deg0", "Freezing altitude"],
  ["waves", "Waves"], ["wwaves", "Wind waves"], ["swell1", "Swell 1"],
  ["swell2", "Swell 2"], ["sst", "Sea temperature"],
  ["currents", "Currents"], ["currentsTide", "Tidal currents"],
  ["no2", "NO₂"], ["pm2p5", "PM2.5"], ["aerosol", "Aerosol"],
  ["gtco3", "Ozone layer"], ["so2", "SO₂"], ["cosc", "CO concentration"],
  ["dustsm", "Dust mass"], ["fires", "Fire intensity"],
  ["efiWind", "EFI wind"], ["efiTemp", "EFI temperature"],
  ["efiRain", "EFI rain"],
];
const WINDY_LEVELS = [
  ["surface", "Surface"], ["100m", "100 m"], ["975h", "975 hPa"],
  ["950h", "950 hPa"], ["925h", "925 hPa"], ["900h", "900 hPa"],
  ["850h", "850 hPa"], ["700h", "700 hPa"], ["500h", "500 hPa"],
  ["300h", "300 hPa"], ["250h", "250 hPa"], ["150h", "150 hPa"],
];
function initWindyControls() {
  const ov = $("windy-overlay"), lv = $("windy-level");
  ov.innerHTML = WINDY_OVERLAYS.map(([v, n]) =>
    `<option value="${v}">${n}</option>`).join("");
  lv.innerHTML = WINDY_LEVELS.map(([v, n]) =>
    `<option value="${v}">${n}</option>`).join("");
  ov.value = localStorage.getItem("windyOverlay") || "radar";
  lv.value = localStorage.getItem("windyLevel") || "surface";
  if (!ov.value) ov.value = "radar";
  if (!lv.value) lv.value = "surface";
  ov.onchange = () => { localStorage.setItem("windyOverlay", ov.value);
    updateWindyFrame(); };
  lv.onchange = () => { localStorage.setItem("windyLevel", lv.value);
    updateWindyFrame(); };
}
function updateWindyFrame() {
  const known = S.sites.find(s => s.id === S.site);
  const lat = known?.lat ?? 35, lon = known?.lon ?? -97.5;
  const overlay = $("windy-overlay").value || "radar";
  const level = $("windy-level").value || "surface";
  const src = `https://embed.windy.com/embed2.html?lat=${lat}&lon=${lon}` +
    `&detailLat=${lat}&detailLon=${lon}&zoom=8&level=${level}&overlay=${overlay}` +
    `&menu=&message=true&marker=true&calendar=now&type=map` +
    `&location=coordinates&metricWind=default&metricTemp=default&radarRange=-1`;
  const f = $("windy-frame");
  if (f.dataset.src !== src) { f.src = src; f.dataset.src = src; }
}

function setMode(mode, initial) {
  S.mode = mode;
  localStorage.setItem("viewMode", mode);
  $("view-tiles").classList.toggle("on", mode === "tiles");
  $("view-l2").classList.toggle("on", mode === "l2");
  $("view-windy").classList.toggle("on", mode === "windy");
  document.querySelectorAll(".l2-only").forEach(el => el.hidden = mode !== "l2");
  document.querySelectorAll(".tiles-only").forEach(el => el.hidden = mode !== "tiles");
  document.querySelectorAll(".radar-only").forEach(el => el.hidden = mode === "windy");
  document.querySelectorAll(".windy-only").forEach(el => el.hidden = mode !== "windy");
  $("windy-wrap").hidden = mode !== "windy";
  tl.pause();
  clearInterval(S.l2.poll);
  if (mode === "windy") {
    MapEngine.clearTileFrames();
    S.tiles.key = "";
    radarLayer.current = null;
    S.l2.cat = null;
    MapEngine.getMap()?.triggerRepaint();
    updateWindyFrame();
  } else if (mode === "l2") {
    MapEngine.clearTileFrames();
    S.tiles.key = "";
    l2Refresh(true);
    S.l2.poll = setInterval(() => l2Refresh(false), 30000);
  } else {
    radarLayer.current = null;
    S.l2.cat = null;
    MapEngine.getMap()?.triggerRepaint();
    $("frame-time").textContent = "waiting for radar…";
    if (!initial) fetch("/api/state").then(r => r.json())
      .then(s => applyTiles(s.radar)).catch(() => {});
  }
}
$("view-tiles").onclick = () => setMode("tiles");
$("view-l2").onclick = () => setMode("l2");
$("view-windy").onclick = () => setMode("windy");

/* -------------------------------- sites -------------------------------- */
async function initSites() {
  S.sites = await (await fetch("/api/sites")).json();
  const sel = $("site-select");
  sel.innerHTML = S.sites.map(s =>
    `<option value="${s.id}">${s.id} — ${esc(s.name)}</option>`).join("")
    + '<option value="__custom">other…</option>';
  sel.onchange = () => {
    if (sel.value === "__custom") { $("site-custom").hidden = false;
      $("site-custom").focus(); return; }
    $("site-custom").hidden = true;
    chooseSite(sel.value);
  };
  $("site-custom").onkeydown = e => {
    if (e.key === "Enter" && e.target.value.trim().length >= 3)
      chooseSite(e.target.value.trim().toUpperCase());
  };
}
async function chooseSite(id) {
  S.site = id;
  const sel = $("site-select");
  if ([...sel.options].some(o => o.value === id)) sel.value = id;
  MapEngine.markActive(id);
  const known = S.sites.find(s => s.id === id);
  if (known) MapEngine.flyTo(known.lat, known.lon, 8);
  try { await fetch("/api/radar", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ site: id }) }); } catch {}
  S.tiles.key = "";
  if (S.mode === "l2") l2Refresh(true);
  refreshWxTicker();
  refreshStorms();
  if (S.mode === "windy") updateWindyFrame();
}

/* ------------------------------- widgets ------------------------------- */
function drawWindDial(speedMph, dir, gustMph) {
  const cv = $("wind-dial"), ctx = cv.getContext("2d");
  const w = cv.width, h = cv.height, cx = w/2, cy = h/2, r = Math.min(w,h)/2 - 12;
  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = 2; ctx.strokeStyle = cssVar("--border");
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.stroke();
  ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  [["N",0],["E",90],["S",180],["W",270]].forEach(([lb, ang]) => {
    const rad = (ang - 90) * Math.PI/180;
    ctx.strokeStyle = cssVar("--muted");
    ctx.beginPath();
    ctx.moveTo(cx + (r-8)*Math.cos(rad), cy + (r-8)*Math.sin(rad));
    ctx.lineTo(cx + r*Math.cos(rad), cy + r*Math.sin(rad));
    ctx.stroke();
    ctx.fillStyle = cssVar("--muted");
    ctx.fillText(lb, cx + (r-19)*Math.cos(rad), cy + (r-19)*Math.sin(rad));
  });
  if (dir != null && speedMph > 0.3) {
    const rad = (dir - 90) * Math.PI/180;
    ctx.fillStyle = cssVar("--accent");
    ctx.beginPath();
    ctx.moveTo(cx + (r-13)*Math.cos(rad), cy + (r-13)*Math.sin(rad));
    ctx.lineTo(cx + 9*Math.cos(rad + Math.PI*0.82), cy + 9*Math.sin(rad + Math.PI*0.82));
    ctx.lineTo(cx + 9*Math.cos(rad - Math.PI*0.82), cy + 9*Math.sin(rad - Math.PI*0.82));
    ctx.fill();
  }
  ctx.fillStyle = cssVar("--text"); ctx.font = "bold 21px sans-serif";
  ctx.fillText(Math.round(speedMph ?? 0), cx, cy - 8);
  ctx.fillStyle = cssVar("--muted"); ctx.font = "9.5px sans-serif";
  ctx.fillText(`mph ${compass(dir)}`, cx, cy + 12);
  ctx.fillText(`gust ${Math.round(gustMph ?? 0)}`, cx, cy + 24);
}
function drawSpark(values) {
  const cv = $("spark"), ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!values || values.length < 2) return;
  const lo = Math.min(...values), hi = Math.max(...values), span = (hi - lo) || 0.01;
  ctx.lineWidth = 2;
  ctx.strokeStyle = values.at(-1) >= values[0] ? cssVar("--good") : "#ff8c1a";
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = i * cv.width / (values.length - 1);
    const y = cv.height - 4 - (v - lo) / span * (cv.height - 8);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
}

/* ------------------------------ alerts + sound ------------------------------ */
const sndWarn = new Audio("/static/sounds/alert_warning.wav");
const sndWatch = new Audio("/static/sounds/alert_watch.wav");
$("sound-toggle").onclick = () => {
  S.soundOn = !S.soundOn;
  $("sound-toggle").textContent = S.soundOn ? "🔊" : "🔇";
  if (S.soundOn) { sndWatch.volume = 0.4; sndWatch.play().catch(() => {}); }
};
function renderAlerts(alerts) {
  const badge = $("alert-badge"), banner = $("banner"), det = $("alert-details");
  badge.textContent = `${alerts.length} ALERT${alerts.length === 1 ? "" : "S"}`;
  badge.className = "badge sev-" + (alerts[0]?.severity || "none");
  if (!alerts.length) { banner.hidden = true; det.hidden = true; }
  else {
    const top = alerts[0];
    banner.hidden = false;
    banner.textContent = `⚠ ${top.event}` +
      (alerts.length > 1 ? `  (+${alerts.length - 1} more)` : "") +
      " — click for details";
    banner.className = "severity-" + (top.severity || "Minor");
    det.innerHTML = alerts.map(a =>
      `<b>${esc(a.event)} — ${esc(a.severity)}</b>${esc(a.headline)}<br>` +
      `<small>${esc(a.instruction || "")}</small>`).join("<hr>");
  }
  if (S.mapReady) MapEngine.setAlerts(alerts);
  const ids = new Set(alerts.map(a => a.id));
  if (S.knownAlertIds !== null && S.soundOn) {
    const fresh = alerts.filter(a => !S.knownAlertIds.has(a.id));
    if (fresh.length) {
      const urgent = fresh.some(a => a.event.endsWith("Warning") ||
        ["Extreme", "Severe"].includes(a.severity));
      (urgent ? sndWarn : sndWatch).play().catch(() => {});
    }
  }
  S.knownAlertIds = ids;
}
$("banner").onclick = () =>
  { $("alert-details").hidden = !$("alert-details").hidden; };

/* -------------------------------- tickers -------------------------------- */
const tickerKeys = {};
function renderTicker(items, tickerId = "ticker", trackId = "ticker-track") {
  const t = $(tickerId);
  if (!items.length) { t.hidden = true; return; }
  t.hidden = false;
  const key = items.map(i => i.link || i.title).join("|");
  if (key === tickerKeys[tickerId]) return;
  tickerKeys[tickerId] = key;
  const html = items.map(i => {
    const fresh = i.epoch && Date.now()/1000 - i.epoch < 1800;
    return `<span class="ticker-item${fresh ? " fresh" : ""}">` +
      `<span class="src">${esc(i.source)}</span>` +
      `<a href="${i.link}" target="_blank" rel="noopener">${esc(i.title)}</a>` +
      `<span class="when">${i.epoch ? rel(i.epoch) : ""}</span></span>` +
      `<span class="ticker-sep">•</span>`;
  }).join("");
  const track = $(trackId);
  track.innerHTML = html + html;
  track.style.setProperty("--ticker-dur", Math.max(40, items.length * 7) + "s");
}
async function refreshWxTicker() {
  if (!S.site) return;
  try {
    const r = await (await fetch(`/api/wx_alerts?site=${S.site}`)).json();
    S.wxItems = Array.isArray(r.items) ? r.items : null;
    $("wx-ticker-label").textContent =
      S.wxItems !== null ? `⚡ ${r.state} WX` : "⚡ WEATHER";
  } catch { S.wxItems = null; }
}
setInterval(refreshWxTicker, 60000);

/* ------------------------------ storm tracks ------------------------------ */
async function refreshStorms() {
  if (!$("tracks-toggle").checked || !S.site || !S.mapReady) {
    if (S.mapReady) MapEngine.setStormTracks([], "#ffffff");
    return;
  }
  try {
    const r = await (await fetch(`/api/storm_tracks?site=${S.site}`)).json();
    MapEngine.setStormTracks(r.cells || [], "#ffffff");
  } catch { /* keep last */ }
}
$("tracks-toggle").checked = localStorage.getItem("tracks") === "1";
$("tracks-toggle").onchange = e => {
  localStorage.setItem("tracks", e.target.checked ? "1" : "0");
  refreshStorms();
};
setInterval(refreshStorms, 60000);

/* -------------------------------- themes -------------------------------- */
async function initThemes() {
  const themes = await (await fetch("/api/themes")).json();
  const sel = $("theme-select");
  sel.innerHTML = themes.map(t =>
    `<option value="${t.id}">${esc(t.name)}</option>`).join("");
  const saved = localStorage.getItem("theme") || themes[0].id;
  sel.value = themes.some(t => t.id === saved) ? saved : themes[0].id;
  sel.onchange = () => applyTheme(themes.find(t => t.id === sel.value));
  applyTheme(themes.find(t => t.id === sel.value));
}
function applyTheme(theme) {
  if (!theme) return;
  S.theme = theme;
  localStorage.setItem("theme", theme.id);
  for (const [k, v] of Object.entries(theme.vars || {}))
    document.documentElement.style.setProperty(k, v);
  if (S.mapReady) MapEngine.setBasemap(activeBasemap());
}
$("basemap-select").value = localStorage.getItem("basemap") || "";
$("basemap-select").onchange = e => {
  if (e.target.value) localStorage.setItem("basemap", e.target.value);
  else localStorage.removeItem("basemap");
  if (S.mapReady) MapEngine.setBasemap(activeBasemap());
};

/* ------------------------------- controls ------------------------------- */
$("play-btn").onclick = () => { tl.toggle();
  $("play-btn").textContent = tl.playing ? "⏸" : "▶"; };
$("frame-slider").oninput = e => { tl.pause();
  $("play-btn").textContent = "▶"; tl.show(+e.target.value); };
$("speed-slider").oninput = e => tl.setSpeed(+e.target.value);
$("opacity-slider").oninput = e => {
  S.radarOpacity = e.target.value / 100;
  if (S.mode === "tiles") MapEngine.showTileFrame(tl.cur, S.radarOpacity);
  else radarLayer.setOpacity(S.radarOpacity);
};
$("frames-select").value = localStorage.getItem("frameCount") || "10";
$("frames-select").onchange = e => {
  localStorage.setItem("frameCount", e.target.value);
  S.tiles.key = "";
  if (S.mode === "l2") l2LoadFrames();
};
$("product-select").onchange = e => {
  fetch("/api/radar", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ product: e.target.value }) }).catch(() => {});
  S.tiles.key = "";
};
$("tilt-select").onchange = e => { S.l2.sel.tilt = +e.target.value; l2LoadFrames(); };
$("l2-moment-select").onchange = e => { S.l2.sel.moment = e.target.value;
  syncPaletteSelect(); l2LoadFrames(); };
$("palette-select").onchange = e => {
  localStorage.setItem("pal:" + S.l2.sel.moment, e.target.value);
  if (S.mode === "l2" && tl.frames.length) tl.show(tl.cur);   // instant recolor
};
$("l2-smooth").onchange = e => radarLayer.setSmoothing(e.target.checked);
$("wall-btn").onclick = () => window.open("/wall", "_blank");
document.addEventListener("keydown", e => {
  if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
  if (e.code === "Space") { e.preventDefault(); $("play-btn").click(); }
  else if (e.code === "ArrowRight") { tl.step(1); $("play-btn").textContent = "▶"; }
  else if (e.code === "ArrowLeft") { tl.step(-1); $("play-btn").textContent = "▶"; }
});

/* ------------------------------ main poll ------------------------------ */
async function poll() {
  try {
    const s = await (await fetch("/api/state")).json();
    const st = s.station || {};
    initMapOnce(st.lat ?? 35.0, st.lon ?? -97.5);
    if (st.lat != null && S.mapReady && !S._markerPlaced) {
      S._markerPlaced = true;
      MapEngine.setStationMarker(st.lat, st.lon, st.name || "station",
                                 st.show_marker !== false);
    }
    $("station-name").textContent = st.name || "";
    $("station-title").textContent = (st.name || "STATION").toUpperCase();

    const o = s.obs || {};
    if (o.temp_c != null) $("temp").textContent = Math.round(cToF(o.temp_c)) + "°F";
    if (o.rh != null) $("humidity").textContent = `humidity ${Math.round(o.rh)} %`;
    const wn = s.wind_now || {};
    drawWindDial(msToMph(wn.speed_ms) ?? 0, wn.dir, msToMph(o.wind_gust) ?? 0);
    if (o.pressure_mb != null)
      $("pressure").textContent = mbToInHg(o.pressure_mb).toFixed(2) + " inHg";
    drawSpark((o.pressure_hist || []).map(mbToInHg));
    if (o.rain_mm != null)
      $("rain").textContent = mmToIn(o.rain_mm).toFixed(2) + " in today";
    $("uv").textContent = `UV ${o.uv ?? "--"} · ${o.solar ?? "--"} W/m²`;
    const strike = s.last_strike || {};
    const lel = $("lightning");
    if (strike.epoch && Date.now()/1000 - strike.epoch < 900) {
      lel.textContent = `⚡ strike ≈ ${Math.round(kmToMi(strike.dist_km))} mi, ${rel(strike.epoch)} ago`;
      lel.className = "hot";
    } else if ((o.strike_count ?? 0) > 0) {
      lel.textContent = `⚡ ${o.strike_count} strikes recently`;
      lel.className = "hot";
    } else { lel.textContent = "no strikes detected"; lel.className = ""; }

    if (s.radar) {
      if (!S.site && s.radar.site && S.sites.length) { S.site = s.radar.site;
        const sel = $("site-select");
        if ([...sel.options].some(x => x.value === S.site)) sel.value = S.site;
        MapEngine.markActive(S.site);
        const known = S.sites.find(x => x.id === S.site);
        if (known) MapEngine.flyTo(known.lat, known.lon, 8);
        refreshWxTicker(); }
      syncProductSelect(s.radar);
      applyTiles(s.radar);
    }
    S.lastAlertsRaw = s.alerts || [];
    S.lastAlerts = typeof alertAllowed === "function"
      ? S.lastAlertsRaw.filter(alertAllowed) : S.lastAlertsRaw;
    renderAlerts(S.lastAlerts);
    renderTicker(s.news || []);
    renderTicker(S.wxItems ?? s.wx_news ?? [], "wx-ticker", "wx-ticker-track");
    $("statusbar").innerHTML = Object.entries(s.workers || {})
      .map(([k, v]) => `<span>${esc(k)}: ${esc(String(v))}</span>`).join("");
  } catch { $("statusbar").textContent = "server unreachable — retrying…"; }
}

initThemes();
initWindyControls();
initSites();
poll();
setInterval(poll, 3000);
if (S.mode === "l2") { /* applied once map is ready via initMapOnce */ }
