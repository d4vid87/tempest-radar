"use strict";
/* Data overlays (SPC/IEM/AWC feeds) + weather-alert filtering.
   Both persist in localStorage and restore on load. Relies on $, esc,
   MapEngine from earlier scripts. */

(() => {
/* ============================ data overlays ============================ */
const OVERLAYS = {
  outlook1: { name: "Severe wx outlook — today" },
  outlook2: { name: "Severe wx outlook — tomorrow" },
  mcd:      { name: "Mesoscale discussions" },
  watches:  { name: "SPC watches (TOR/SVR)" },
  lsr:      { name: "Local storm reports (6 h)", point: true },
  metar:    { name: "METARs — surface obs", point: true, bbox: true },
};
const OV_LS = "overlays.v1";
let ovOn = {};
try { ovOn = JSON.parse(localStorage.getItem(OV_LS) || "{}"); } catch {}

function ovAnchor(map) {
  return map.getLayer("alerts-fill") ? "alerts-fill" : undefined;
}
async function ovFetch(kind) {
  const map = MapEngine.getMap();
  let url = `/api/overlay/${kind}`;
  if (OVERLAYS[kind].bbox) {
    const b = map.getBounds();
    url += `?bbox=${b.getSouth().toFixed(1)},${b.getWest().toFixed(1)},` +
           `${b.getNorth().toFixed(1)},${b.getEast().toFixed(1)}`;
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error("feed unavailable");
  return r.json();
}
function ovRemove(kind) {
  const map = MapEngine.getMap();
  if (!map) return;
  for (const suf of ["fill", "line", "pt"]) {
    const id = `ov-${kind}-${suf}`;
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(`ov-${kind}`)) map.removeSource(`ov-${kind}`);
}
function ovAddLayers(kind) {
  const map = MapEngine.getMap();
  const src = `ov-${kind}`, anchor = ovAnchor(map);
  if (kind === "outlook1" || kind === "outlook2") {
    map.addLayer({ id: `${src}-fill`, type: "fill", source: src,
      paint: { "fill-color": ["coalesce", ["get", "fill"], "#888"],
               "fill-opacity": kind === "outlook1" ? 0.18 : 0.10 } }, anchor);
    map.addLayer({ id: `${src}-line`, type: "line", source: src,
      paint: { "line-color": ["coalesce", ["get", "stroke"], "#888"],
               "line-width": 1.4 } }, anchor);
  } else if (kind === "mcd") {
    map.addLayer({ id: `${src}-fill`, type: "fill", source: src,
      paint: { "fill-color": "#4fd1ff", "fill-opacity": 0.10 } }, anchor);
    map.addLayer({ id: `${src}-line`, type: "line", source: src,
      paint: { "line-color": "#4fd1ff", "line-width": 1.6,
               "line-dasharray": [3, 2] } }, anchor);
  } else if (kind === "watches") {
    map.addLayer({ id: `${src}-line`, type: "line", source: src,
      paint: { "line-color": ["match", ["get", "type"], "TOR", "#ff2a44",
                              "#ffd41a"], "line-width": 2.2 } }, anchor);
  } else if (kind === "lsr") {
    map.addLayer({ id: `${src}-pt`, type: "circle", source: src,
      paint: { "circle-radius": 4.5, "circle-color": "#ffd41a",
               "circle-opacity": 0.9, "circle-stroke-color": "#0b0f14",
               "circle-stroke-width": 1.2 } });
  } else if (kind === "metar") {
    map.addLayer({ id: `${src}-pt`, type: "circle", source: src,
      paint: { "circle-radius": 4,
               "circle-color": ["match", ["coalesce", ["get", "fltcat"], ""],
                 "VFR", "#38e07b", "MVFR", "#4fa8ff",
                 "IFR", "#ff5533", "LIFR", "#ff44cc", "#9aa7b5"],
               "circle-stroke-color": "#0b0f14",
               "circle-stroke-width": 1 } });
  }
  ovBindPopups(kind);
}
const c2f = c => c == null ? null : Math.round(c * 9 / 5 + 32);
function ovPopupHtml(kind, p) {
  const row = (k, v) => v == null || v === "" ? "" : `<b>${k}</b><span>${esc(v)}</span>`;
  if (kind === "lsr") return `<div class="storm-pop"><h4>STORM REPORT</h4><div class="rows">
    ${row("event", p.typetext)}${row("magnitude", p.magf || p.magnitude)}
    ${row("where", `${p.city || ""} ${p.county ? "· " + p.county + " Co." : ""}`)}
    ${row("when", p.valid)}${row("source", p.source)}
    ${row("remark", (p.remark || "").slice(0, 220))}</div></div>`;
  if (kind === "metar") return `<div class="storm-pop"><h4>${esc(p.id || "METAR")}</h4><div class="rows">
    ${row("site", p.site)}${row("temp", c2f(p.temp) != null ? c2f(p.temp) + " °F" : null)}
    ${row("dew pt", c2f(p.dewp) != null ? c2f(p.dewp) + " °F" : null)}
    ${row("wind", p.wspd != null ? `${p.wdir ?? "--"}° @ ${Math.round(p.wspd * 1.15078)} mph` : null)}
    ${row("visibility", p.visib != null ? p.visib + " mi" : null)}
    ${row("category", p.fltcat)}${row("raw", (p.rawOb || "").slice(0, 140))}</div></div>`;
  if (kind === "mcd") return `<div class="storm-pop"><h4>MESOSCALE DISCUSSION ${esc(p.num || "")}</h4>
    <div class="rows">${row("concerning", p.concerning)}${row("valid", p.utc_issue || p.issue)}
    ${row("expires", p.utc_expire || p.expire)}</div>
    ${p.num ? `<a href="https://www.spc.noaa.gov/products/md/md${String(p.num).padStart(4, "0")}.html"
      target="_blank" rel="noopener">full discussion ↗</a>` : ""}</div>`;
  if (kind === "watches") return `<div class="storm-pop">
    <h4>${p.type === "TOR" ? "TORNADO" : "SEVERE T'STORM"} WATCH ${esc(p.number || "")}</h4>
    <div class="rows">${row("issued", p.issue)}${row("expires", p.expire)}</div></div>`;
  const lbl = p.LABEL2 || p.LABEL || "";
  return `<div class="storm-pop"><h4>SPC OUTLOOK</h4><div class="rows">
    ${row("risk", lbl)}${row("valid", p.VALID)}${row("expires", p.EXPIRE)}</div></div>`;
}
const ovPopupBound = {};
function ovBindPopups(kind) {
  if (ovPopupBound[kind]) return;
  ovPopupBound[kind] = true;
  const map = MapEngine.getMap();
  const layer = OVERLAYS[kind].point ? `ov-${kind}-pt`
    : (kind === "watches" ? `ov-${kind}-line` : `ov-${kind}-fill`);
  map.on("click", layer, e => {
    const f = e.features && e.features[0];
    if (!f) return;
    new maplibregl.Popup({ maxWidth: "300px", className: "storm-popup" })
      .setLngLat(e.lngLat).setHTML(ovPopupHtml(kind, f.properties)).addTo(map);
  });
  if (OVERLAYS[kind].point) {
    map.on("mouseenter", layer, () => map.getCanvas().style.cursor = "pointer");
    map.on("mouseleave", layer, () => map.getCanvas().style.cursor = "");
  }
}
async function ovRefresh(kind) {
  const map = MapEngine.getMap();
  if (!map || !ovOn[kind]) return;
  try {
    const data = await ovFetch(kind);
    const src = map.getSource(`ov-${kind}`);
    if (src) src.setData(data);
    else {
      map.addSource(`ov-${kind}`, { type: "geojson", data });
      ovAddLayers(kind);
    }
  } catch { /* feed hiccup — keep whatever is shown */ }
}
function ovToggle(kind, on) {
  ovOn[kind] = on;
  localStorage.setItem(OV_LS, JSON.stringify(ovOn));
  if (on) ovRefresh(kind); else ovRemove(kind);
}
setInterval(() => Object.keys(OVERLAYS).forEach(k => ovRefresh(k)), 300000);

/* overlays modal */
function buildOvModal() {
  const div = document.createElement("div");
  div.id = "ov-modal"; div.hidden = true;
  div.innerHTML = `<div id="ov-box">
    <div class="set-head"><b>🗺 Data overlays</b><button id="ov-close">✕</button></div>
    <div class="set-hint">Live layers from SPC, IEM and AviationWeather —
      free feeds, refreshed every 5 minutes. Click features for details.</div>
    ${Object.entries(OVERLAYS).map(([k, o]) =>
      `<label class="ov-row"><input type="checkbox" data-ov="${k}"
        ${ovOn[k] ? "checked" : ""}> ${o.name}</label>`).join("")}
  </div>`;
  document.body.appendChild(div);
  div.querySelector("#ov-close").onclick = () => div.hidden = true;
  div.querySelectorAll("[data-ov]").forEach(cb =>
    cb.onchange = () => ovToggle(cb.dataset.ov, cb.checked));
}

/* ========================= weather alert settings ========================= */
const ALERT_CATS = {
  "Storm Based": ["Tornado Warning", "Severe Thunderstorm Warning",
    "Flash Flood Warning", "Special Marine Warning", "Snow Squall Warning",
    "Dust Storm Warning", "Extreme Wind Warning", "Special Weather Statement"],
  "Tropical": ["Hurricane Warning", "Hurricane Watch",
    "Tropical Storm Warning", "Tropical Storm Watch", "Storm Surge Warning",
    "Storm Surge Watch", "Hurricane Local Statement"],
  "Winter": ["Winter Storm Warning", "Winter Storm Watch", "Blizzard Warning",
    "Ice Storm Warning", "Winter Weather Advisory",
    "Lake Effect Snow Warning", "Wind Chill Warning", "Wind Chill Advisory",
    "Extreme Cold Warning", "Extreme Cold Watch", "Freeze Warning",
    "Freeze Watch", "Frost Advisory"],
  "Non-Precip": ["High Wind Warning", "High Wind Watch", "Wind Advisory",
    "Excessive Heat Warning", "Extreme Heat Warning", "Heat Advisory",
    "Dense Fog Advisory", "Air Quality Alert", "Red Flag Warning",
    "Fire Weather Watch", "Blowing Dust Advisory"],
  "Hydro": ["Flood Warning", "Flood Watch", "Flood Advisory",
    "River Flood Warning", "Coastal Flood Warning", "Coastal Flood Watch",
    "Coastal Flood Advisory", "Hydrologic Outlook"],
  "Watches": ["Tornado Watch", "Severe Thunderstorm Watch"],
};
const AS_LS = "alertFilters.v1";
let AS = { master: true, cats: {}, events: {} };
try { Object.assign(AS, JSON.parse(localStorage.getItem(AS_LS) || "{}")); } catch {}
function asSave() { localStorage.setItem(AS_LS, JSON.stringify(AS)); }
function catOf(event) {
  for (const [cat, evs] of Object.entries(ALERT_CATS))
    if (evs.includes(event)) return cat;
  return null;
}
/* used by app.js when rendering alerts */
window.alertAllowed = a => {
  if (!AS.master) return false;
  const cat = catOf(a.event);
  if (cat && AS.cats[cat] === false) return false;
  if (AS.events[a.event] === false) return false;
  return true;                       // unknown event types stay visible
};

function buildAsModal() {
  const div = document.createElement("div");
  div.id = "aset-modal"; div.hidden = true;
  const cats = Object.keys(ALERT_CATS);
  div.innerHTML = `<div id="aset-box">
    <div class="set-head"><b>⚠ Weather alert settings</b>
      <button id="aset-close">✕</button></div>
    <label class="ov-row master"><input type="checkbox" id="aset-master"
      ${AS.master ? "checked" : ""}> <b>All selected weather alerts</b></label>
    <div id="aset-tabs">${cats.map((c, i) =>
      `<button class="aset-tab${i ? "" : " on"}" data-cat="${c}">${c}</button>`).join("")}</div>
    ${cats.map((c, i) => `<div class="aset-pane" data-pane="${c}" ${i ? "hidden" : ""}>
      <label class="ov-row master"><input type="checkbox" data-catall="${c}"
        ${AS.cats[c] !== false ? "checked" : ""}> <b>Turn on/off all ${c.toLowerCase()}</b></label>
      ${ALERT_CATS[c].map(ev => `<label class="ov-row"><input type="checkbox"
        data-ev="${ev}" ${AS.events[ev] !== false ? "checked" : ""}> ${ev}</label>`).join("")}
    </div>`).join("")}
    <div class="set-hint">Hidden alert types are excluded from the badge,
      banner, map polygons and sounds. Unlisted event types always show.</div>
  </div>`;
  document.body.appendChild(div);
  div.querySelector("#aset-close").onclick = () => div.hidden = true;
  div.querySelectorAll(".aset-tab").forEach(btn => btn.onclick = () => {
    div.querySelectorAll(".aset-tab").forEach(b =>
      b.classList.toggle("on", b === btn));
    div.querySelectorAll(".aset-pane").forEach(p =>
      p.hidden = p.dataset.pane !== btn.dataset.cat);
  });
  const rerender = () => { asSave();
    if (typeof S !== "undefined" && S.lastAlertsRaw) applyAlertFilter(); };
  div.querySelector("#aset-master").onchange = e => {
    AS.master = e.target.checked; rerender(); };
  div.querySelectorAll("[data-catall]").forEach(cb => cb.onchange = () => {
    AS.cats[cb.dataset.catall] = cb.checked;
    div.querySelectorAll(`[data-pane="${cb.dataset.catall}"] [data-ev]`)
      .forEach(e => { e.checked = cb.checked;
        AS.events[e.dataset.ev] = cb.checked; });
    rerender(); });
  div.querySelectorAll("[data-ev]").forEach(cb => cb.onchange = () => {
    AS.events[cb.dataset.ev] = cb.checked; rerender(); });
}
function applyAlertFilter() {
  S.lastAlerts = (S.lastAlertsRaw || []).filter(window.alertAllowed);
  renderAlerts(S.lastAlerts);
}

/* ------------------------------- wiring ------------------------------- */
buildOvModal();
buildAsModal();
(function addMenuItems() {
  const menu = document.getElementById("main-menu");
  const mk = (id, label) => {
    const b = document.createElement("button");
    b.id = id; b.className = "menu-item"; b.innerHTML = label;
    return b;
  };
  const ovBtn = mk("ov-btn", "🗺&ensp;Data overlays");
  const asBtn = mk("aset-btn", "⚠&ensp;Alert settings");
  const first = document.getElementById("locations-btn");
  menu.insertBefore(asBtn, first);
  menu.insertBefore(ovBtn, first);
  ovBtn.onclick = () => { menu.hidden = true;
    document.getElementById("ov-modal").hidden = false; };
  asBtn.onclick = () => { menu.hidden = true;
    document.getElementById("aset-modal").hidden = false; };
})();
/* restore enabled overlays once the map exists; refetch METARs on pan */
(function ovBoot() {
  const t = setInterval(() => {
    const map = MapEngine.getMap();
    if (!map || !map.isStyleLoaded()) return;
    clearInterval(t);
    Object.keys(OVERLAYS).forEach(k => { if (ovOn[k]) ovRefresh(k); });
    let mvTimer = null;
    map.on("moveend", () => {
      if (!ovOn.metar) return;
      clearTimeout(mvTimer);
      mvTimer = setTimeout(() => ovRefresh("metar"), 1200);
    });
  }, 800);
})();
})();
