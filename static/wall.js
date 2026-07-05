"use strict";
/* Weather wall: a fullscreen grid of tiles for a TV. Embed tiles (Windy,
   aircraft, ships) center on your configured location; native tiles pull
   from the app's own state. Tile choices + column count persist locally. */

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const LS = "wall.v1";
let cfg = { cols: 4, tiles: ["windy-radar", "windy-waves", "windy-gust",
            "windy-satellite", "station", "adsb", "ships", "windy-rain"],
            urls: {} };
try { Object.assign(cfg, JSON.parse(localStorage.getItem(LS) || "{}")); }
catch { /* defaults */ }

let LAT = 35, LON = -97.5, editing = false, lastState = {};

const windy = ov => `https://embed.windy.com/embed2.html?lat=${LAT}&lon=${LON}` +
  `&detailLat=${LAT}&detailLon=${LON}&zoom=7&level=surface&overlay=${ov}` +
  `&menu=&message=true&marker=true&calendar=now&pressure=&type=map` +
  `&location=coordinates&metricWind=default&metricTemp=default&radarRange=-1`;

const SOURCES = {
  "windy-radar":     { name: "Windy — radar",      url: () => windy("radar") },
  "windy-satellite": { name: "Windy — satellite",  url: () => windy("satellite") },
  "windy-wind":      { name: "Windy — wind",       url: () => windy("wind") },
  "windy-gust":      { name: "Windy — gusts",      url: () => windy("gust") },
  "windy-waves":     { name: "Windy — waves",      url: () => windy("waves") },
  "windy-rain":      { name: "Windy — rain accum", url: () => windy("rainAccu") },
  "windy-temp":      { name: "Windy — temperature",url: () => windy("temp") },
  "windy-clouds":    { name: "Windy — clouds",     url: () => windy("clouds") },
  "windy-pressure":  { name: "Windy — pressure",   url: () => windy("pressure") },
  "windy-thunder":   { name: "Windy — thunderstorms", url: () => windy("thunder") },
  "windy-snow":      { name: "Windy — new snow",   url: () => windy("snowAccu") },
  "windy-fog":       { name: "Windy — fog",        url: () => windy("fog") },
  "windy-visibility":{ name: "Windy — visibility", url: () => windy("visibility") },
  "windy-cape":      { name: "Windy — CAPE",       url: () => windy("cape") },
  "windy-dewpoint":  { name: "Windy — dew point",  url: () => windy("dewpoint") },
  "windy-rh":        { name: "Windy — humidity",   url: () => windy("rh") },
  "windy-currents":  { name: "Windy — currents",   url: () => windy("currents") },
  "windy-sst":       { name: "Windy — sea temp",   url: () => windy("sst") },
  "windy-uv":        { name: "Windy — UV index",   url: () => windy("uvindex") },
  "windy-aq":        { name: "Windy — PM2.5",      url: () => windy("pm2p5") },
  "windy-fires":     { name: "Windy — fires",      url: () => windy("fires") },
  "adsb":  { name: "Aircraft (ADS-B Exchange)",
             url: () => `https://globe.adsbexchange.com/?lat=${LAT}&lon=${LON}&zoom=8&hideSidebar&hideButtons` },
  "adsb-live": { name: "Aircraft (airplanes.live)",
             url: () => `https://globe.airplanes.live/?lat=${LAT}&lon=${LON}&zoom=8&hideSidebar&hideButtons` },
  "adsb-fi": { name: "Aircraft (adsb.fi)",
             url: () => `https://globe.adsb.fi/?lat=${LAT}&lon=${LON}&zoom=8&hideSidebar&hideButtons` },
  "ships": { name: "Ships (VesselFinder)",
             url: () => `https://www.vesselfinder.com/aismap?zoom=8&lat=${LAT}&lon=${LON}&names=false` },
  "ships-mt": { name: "Ships (MarineTraffic)",
             url: () => `https://www.marinetraffic.com/en/ais/embed/zoom:8/centery:${LAT}/centerx:${LON}/maptype:4/shownames:false/mmsi:0/shipid:0/fleet:/fleet_id:/vtypes:/showmenu:false/remember:false` },
  "lightning-map": { name: "Lightning (LightningMaps)",
             url: () => `https://www.lightningmaps.org/?lang=en#m=oss;t=3;s=0;o=0;b=;ts=0;y=${LAT};x=${LON};z=8;d=2;dl=2;dc=0;` },
  "station": { name: "My weather station", native: renderStationTile },
  "clock":   { name: "Clock",              native: renderClockTile },
  "custom":  { name: "Custom URL…",        custom: true },
  "blank":   { name: "(empty)",            native: el => el.innerHTML = "" },
};

/* ------------------------------- grid ------------------------------- */
function buildGrid() {
  document.documentElement.style.setProperty("--wall-cols", cfg.cols);
  $("wall-cols").value = cfg.cols;
  const grid = $("wall-grid");
  grid.innerHTML = "";
  const count = cfg.cols * 2;
  while (cfg.tiles.length < count) cfg.tiles.push("blank");
  cfg.tiles.slice(0, count).forEach((key, i) => {
    const tile = document.createElement("div");
    tile.className = "wtile";
    const pick = document.createElement("div");
    pick.className = "pick";
    const sel = document.createElement("select");
    sel.innerHTML = Object.entries(SOURCES).map(([k, s]) =>
      `<option value="${k}" ${k === key ? "selected" : ""}>${esc(s.name)}</option>`).join("");
    sel.onchange = () => {
      if (sel.value === "custom") {
        const cur = cfg.urls?.[i] || "https://";
        const u = prompt("URL to embed in this tile:", cur);
        if (!u || !/^https?:\/\//i.test(u)) { sel.value = cfg.tiles[i]; return; }
        cfg.urls = cfg.urls || {};
        cfg.urls[i] = u;
      }
      cfg.tiles[i] = sel.value; save(); fillTile(tile, sel.value, i);
    };
    pick.appendChild(sel);
    tile.appendChild(pick);
    grid.appendChild(tile);
    fillTile(tile, key, i);
  });
}
function fillTile(tile, key, i) {
  const src = SOURCES[key] || SOURCES.blank;
  [...tile.children].forEach(ch => { if (!ch.classList.contains("pick")) ch.remove(); });
  if (src.custom) {
    const f = document.createElement("iframe");
    f.loading = "lazy";
    f.src = cfg.urls?.[i] || "about:blank";
    tile.appendChild(f);
  } else if (src.native) {
    const div = document.createElement("div");
    div.className = "wnative";
    div.dataset.native = key;
    tile.appendChild(div);
    src.native(div);
  } else {
    const f = document.createElement("iframe");
    f.loading = "lazy";
    f.src = src.url();
    tile.appendChild(f);
  }
}
function save() { localStorage.setItem(LS, JSON.stringify(cfg)); }

/* --------------------------- native tiles --------------------------- */
const cToF = c => c == null ? null : c * 9 / 5 + 32;
function renderStationTile(el) {
  const o = lastState.obs || {}, wn = lastState.wind_now || {};
  const st = lastState.station || {};
  const mph = wn.speed_ms == null ? "--" : Math.round(wn.speed_ms * 2.23694);
  el.innerHTML =
    `<div class="cap" style="color:var(--good);letter-spacing:2px;font-weight:800">
       ${esc(st.name || "WEATHER STATION")}</div>
     <div class="huge">${o.temp_c == null ? "--" : Math.round(cToF(o.temp_c))}°F</div>
     <div class="rows">
       <b>humidity</b><span>${o.rh == null ? "--" : Math.round(o.rh)} %</span>
       <b>wind</b><span>${mph} mph</span>
       <b>pressure</b><span>${o.pressure_mb == null ? "--" : (o.pressure_mb * 0.02953).toFixed(2)} inHg</span>
       <b>rain today</b><span>${o.rain_mm == null ? "--" : (o.rain_mm / 25.4).toFixed(2)} in</span>
       <b>UV · solar</b><span>${o.uv ?? "--"} · ${o.solar ?? "--"} W/m²</span>
       <b>lightning</b><span>${(o.strike_count ?? 0) > 0 ? "⚡ " + o.strike_count + " recent" : "none recent"}</span>
     </div>`;
}
function renderClockTile(el) {
  const now = new Date();
  el.innerHTML = `<div class="huge">${now.toLocaleTimeString()}</div>
    <div style="color:var(--muted)">${now.toLocaleDateString([],
      { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</div>`;
}
function refreshNatives() {
  document.querySelectorAll("[data-native]").forEach(el => {
    const src = SOURCES[el.dataset.native];
    if (src && src.native) src.native(el);
  });
}

/* ------------------------- bottom bar widgets ------------------------- */
function tickClock() {
  const now = new Date();
  $("wb-clock").textContent = now.toLocaleTimeString();
  $("wb-date").textContent = now.toLocaleDateString([],
    { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}
function moonPhase(d = new Date()) {  // days since a known new moon / synodic
  const synodic = 29.530588853;
  const days = (d - new Date(Date.UTC(2000, 0, 6, 18, 14))) / 86400000;
  const phase = ((days % synodic) + synodic) % synodic / synodic;   // 0..1
  const names = ["NEW MOON", "WAXING CRESCENT", "FIRST QUARTER",
    "WAXING GIBBOUS", "FULL MOON", "WANING GIBBOUS", "LAST QUARTER",
    "WANING CRESCENT"];
  return { phase, name: names[Math.floor(phase * 8 + 0.5) % 8] };
}
function drawMoon() {
  const { phase, name } = moonPhase();
  $("wb-moon-cap").textContent = name;
  const cv = $("wb-moon-cv"), ctx = cv.getContext("2d");
  const r = 15, cx = 17, cy = 17;
  ctx.clearRect(0, 0, 34, 34);
  ctx.fillStyle = "#e8e2d0";
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#10151c";
  const ill = (1 - Math.cos(phase * 2 * Math.PI)) / 2;   // illuminated frac
  const waxing = phase < 0.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI / 2, -Math.PI / 2, waxing);        // dark half
  const w = r * (1 - 2 * ill);
  ctx.ellipse(cx, cy, Math.abs(w), r, 0, -Math.PI / 2, Math.PI / 2,
              (w > 0) !== waxing);
  ctx.fill();
}
async function drawTide(station) {
  if (!station) { $("wb-tide").hidden = true; return; }
  try {
    const d = await (await fetch(`/api/tide?station=${station}`)).json();
    const pts = d.predictions || [];
    if (!pts.length) { $("wb-tide").hidden = true; return; }
    $("wb-tide").hidden = false;
    const cv = $("wb-tide-cv"), ctx = cv.getContext("2d");
    const lo = Math.min(...pts.map(p => p.v)), hi = Math.max(...pts.map(p => p.v));
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = getComputedStyle(document.documentElement)
      .getPropertyValue("--accent").trim();
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = i * cv.width / (pts.length - 1);
      const y = cv.height - 5 - (p.v - lo) / ((hi - lo) || 1) * (cv.height - 10);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
    const now = new Date(), frac = (now.getHours() + now.getMinutes() / 60) / 24;
    ctx.strokeStyle = "#ffd41a";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(frac * cv.width, 0); ctx.lineTo(frac * cv.width, cv.height);
    ctx.stroke(); ctx.setLineDash([]);
  } catch { $("wb-tide").hidden = true; }
}

/* ------------------------------ data poll ------------------------------ */
async function poll() {
  try {
    lastState = await (await fetch("/api/state")).json();
    const alerts = lastState.alerts || [];
    const el = $("wb-alerts");
    el.textContent = alerts.length
      ? `⚠ ${alerts.length} ACTIVE — ${alerts[0].event.toUpperCase()}`
      : "NO ACTIVE ALERTS";
    el.classList.toggle("hot", alerts.length > 0);
    refreshNatives();
  } catch { /* retry next tick */ }
}

/* -------------------------------- init -------------------------------- */
$("wall-cols").onchange = e => { cfg.cols = +e.target.value; save(); buildGrid(); };
$("wall-edit-btn").onclick = () => {
  editing = !editing;
  document.body.classList.toggle("wall-edit", editing);
};
$("wall-fs").onclick = () => document.fullscreenElement
  ? document.exitFullscreen() : document.documentElement.requestFullscreen();

(async () => {
  try {
    const s = await (await fetch("/api/settings")).json();
    const st = (await (await fetch("/api/state")).json()).station || {};
    if (st.lat != null) { LAT = +st.lat.toFixed(3); LON = +st.lon.toFixed(3); }
    buildGrid();
    drawTide(s.tide_station);
    setInterval(() => drawTide(s.tide_station), 600000);
  } catch { buildGrid(); }
  tickClock(); setInterval(tickClock, 1000);
  drawMoon(); setInterval(drawMoon, 3600000);
  poll(); setInterval(poll, 5000);
})();
