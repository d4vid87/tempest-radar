"use strict";
/* map-engine: MapLibre GL host (plan §2.1). Owns the map, basemap swapping,
   tile-loop raster layers, alert polygons, and DOM markers. Nothing in here
   knows about radar decoding or UI state. */

const MapEngine = (() => {

const BASEMAPS = {
  dark_all:        { url: "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png", attribution: "© OSM © CARTO" },
  dark_nolabels:   { url: "https://a.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png", attribution: "© OSM © CARTO" },
  dark_streets:    { url: "https://a.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png",
                     overlay: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
                               "https://a.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}.png"],
                     attribution: "© OSM © CARTO · roads © Esri" },
  light_all:       { url: "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png", attribution: "© OSM © CARTO" },
  light_nolabels:  { url: "https://a.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png", attribution: "© OSM © CARTO" },
  voyager:         { url: "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png", attribution: "© OSM © CARTO" },
  osm:             { url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: "© OpenStreetMap" },
  opentopo:        { url: "https://a.tile.opentopomap.org/{z}/{x}/{y}.png", attribution: "© OSM © OpenTopoMap" },
  satellite:       { url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", attribution: "Imagery © Esri" },
  satellite_roads: { url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
                     overlay: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
                     attribution: "Imagery © Esri" },
  esri_streets:    { url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", attribution: "© Esri" },
  esri_topo:       { url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}", attribution: "© Esri" },
  esri_darkgray:   { url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", attribution: "© Esri" },
  esri_lightgray:  { url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", attribution: "© Esri" },
  natgeo:          { url: "https://server.arcgisonline.com/ArcGIS/rest/services/NatGeo_World_Map/MapServer/tile/{z}/{y}/{x}", attribution: "© Esri © NatGeo" },
  usgs_topo:       { url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}", attribution: "USGS" },
  usgs_imagery:    { url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}", attribution: "USGS" },
};

const SEV_COLORS = { Extreme: "#ff2a44", Severe: "#ff8c1a",
                     Moderate: "#ffd41a", Minor: "#6fb7ff", Unknown: "#9aa7b5" };

let map = null;
const tileFrames = [];        // [{srcId, layerId}]
const markers = {};           // site id -> maplibregl.Marker
let stationMarker = null;

function firstOverlayId() {
  if (tileFrames.length) return tileFrames[0].layerId;
  if (map.getLayer("l2-radar")) return "l2-radar";
  if (map.getLayer("alerts-fill")) return "alerts-fill";
  return undefined;
}

function init(container, center, zoom, basemapKey, onReady) {
  const bm = BASEMAPS[basemapKey] || BASEMAPS.dark_all;
  map = new maplibregl.Map({
    container, center, zoom, attributionControl: true,
    style: { version: 8,
      sources: { base: { type: "raster", tiles: [bm.url], tileSize: 256,
                         attribution: bm.attribution } },
      layers: [{ id: "base", type: "raster", source: "base" }] },
  });
  if (bm.overlay) map.on("load", () => addBaseOverlay(bm.overlay));
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }),
                 "bottom-right");
  map.on("load", () => {
    map.addSource("alerts", { type: "geojson",
      data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "alerts-fill", type: "fill", source: "alerts",
      paint: { "fill-color": ["match", ["get", "severity"],
        "Extreme", SEV_COLORS.Extreme, "Severe", SEV_COLORS.Severe,
        "Moderate", SEV_COLORS.Moderate, "Minor", SEV_COLORS.Minor,
        SEV_COLORS.Unknown], "fill-opacity": 0.10 } });
    map.addSource("storms", { type: "geojson",
      data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "storm-tracks", type: "line", source: "storms",
      filter: ["==", ["geometry-type"], "LineString"],
      paint: { "line-color": ["get", "color"], "line-width": 1.2,
               "line-opacity": 0.75, "line-dasharray": [1.5, 2.5] } });
    map.addLayer({ id: "storm-cells", type: "circle", source: "storms",
      filter: ["==", ["geometry-type"], "Point"],
      paint: { "circle-radius": ["case", ["get", "cell"], 4.5, 1.7],
               "circle-color": ["get", "color"],
               "circle-opacity": ["case", ["get", "cell"], 0.95, 0.7],
               "circle-stroke-color": "#0b0f14",
               "circle-stroke-width": ["case", ["get", "cell"], 1.2, 0] } });
    map.on("click", "storm-cells", e => {
      const f = (e.features || []).find(f =>
        f.properties.cell === true || f.properties.cell === "true");
      if (!f || !f.properties.info) return;
      let c; try { c = JSON.parse(f.properties.info); } catch { return; }
      const mph = c.sknt != null ? Math.round(c.sknt * 1.15078) : null;
      const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE",
                    "S","SSW","SW","WSW","W","WNW","NW","NNW"];
      const toward = c.drct != null ? (c.drct + 180) % 360 : null;
      const compass = toward != null ? dirs[Math.round(toward / 22.5) % 16] : null;
      const row = (k, v) => v == null || v === "" ? "" :
        `<b>${k}</b><span>${v}</span>`;
      const flag = c.tvs ? '<div class="storm-flag tvs">⚠ TVS — possible tornado</div>'
        : c.meso ? '<div class="storm-flag meso">↻ Mesocyclone detected</div>' : "";
      const html = `<div class="storm-pop">
        <h4>CELL ${c.id}</h4>${flag}<div class="rows">
        ${row("motion", compass ? `${compass} @ ${mph} mph` : (mph != null ? mph + " mph" : "stationary"))}
        ${row("max dBZ", c.max_dbz)}
        ${row("VIL", c.vil != null ? c.vil + " kg/m²" : null)}
        ${row("hail prob", c.poh != null ? c.poh + " %" : null)}
        ${row("svr hail", c.posh != null ? c.posh + " %" : null)}
        </div></div>`;
      new maplibregl.Popup({ maxWidth: "280px", className: "storm-popup" })
        .setLngLat(f.geometry.coordinates).setHTML(html).addTo(map);
    });
    map.on("mouseenter", "storm-cells", () => map.getCanvas().style.cursor = "pointer");
    map.on("mouseleave", "storm-cells", () => map.getCanvas().style.cursor = "");
    map.addLayer({ id: "alerts-line", type: "line", source: "alerts",
      paint: { "line-color": ["match", ["get", "severity"],
        "Extreme", SEV_COLORS.Extreme, "Severe", SEV_COLORS.Severe,
        "Moderate", SEV_COLORS.Moderate, "Minor", SEV_COLORS.Minor,
        SEV_COLORS.Unknown], "line-width": 1.8 } });
    onReady && onReady(map);
  });
  return map;
}

function addBaseOverlay(urls) {
  // roads + labels render ABOVE the radar so they stay readable,
  // but below alert polygons and storm tracks
  const anchor = map.getLayer("alerts-fill") ? "alerts-fill" : undefined;
  (Array.isArray(urls) ? urls : [urls]).forEach((url, i) => {
    const id = "base-ov" + i;
    map.addSource(id, { type: "raster", tiles: [url], tileSize: 256 });
    map.addLayer({ id, type: "raster", source: id }, anchor);
  });
}
function setBasemap(key) {
  const bm = BASEMAPS[key] || BASEMAPS.dark_all;
  if (!map || !map.isStyleLoaded()) return;
  for (const id of ["base", "base-ov", "base-ov0", "base-ov1", "base-ov2"]) {
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
  }
  map.addSource("base", { type: "raster", tiles: [bm.url], tileSize: 256,
                          attribution: bm.attribution });
  map.addLayer({ id: "base", type: "raster", source: "base" },
               firstOverlayId());
  if (bm.overlay) addBaseOverlay(bm.overlay);
}

/* ------------------------------ storm tracks ------------------------------ */
function offsetKm(lat, lon, bearingDeg, km) {
  const R = 111.194, b = bearingDeg * Math.PI / 180;
  return [lon + km * Math.sin(b) / (R * Math.cos(lat * Math.PI / 180)),
          lat + km * Math.cos(b) / R];
}
function setStormTracks(cells, accent) {
  const src = map && map.getSource("storms");
  if (!src) return;
  const feats = [];
  for (const c of cells || []) {
    const color = c.tvs ? "#ff2a44" : c.meso ? "#ff8c1a" : accent;
    feats.push({ type: "Feature",
      geometry: { type: "Point", coordinates: [c.lon, c.lat] },
      properties: { color, cell: true, info: JSON.stringify(c) } });
    if (c.drct != null && c.sknt > 2) {
      const toward = (c.drct + 180) % 360;      // STI motion is FROM-convention
      const pts = [[c.lon, c.lat]];
      for (const t of [15, 30, 45, 60]) {
        const p = offsetKm(c.lat, c.lon, toward, c.sknt * 1.852 * t / 60);
        pts.push(p);
        feats.push({ type: "Feature",
          geometry: { type: "Point", coordinates: p },
          properties: { color, cell: false } });
      }
      feats.push({ type: "Feature",
        geometry: { type: "LineString", coordinates: pts },
        properties: { color } });
    }
  }
  src.setData({ type: "FeatureCollection", features: feats });
}

/* ------------------------- tile-loop raster frames ------------------------ */
function setTileFrames(urls) {
  clearTileFrames();
  urls.forEach((url, i) => {
    const srcId = `tf-src-${i}`, layerId = `tf-${i}`;
    // maxzoom 9 ≈ the radar data's native bin resolution; past that the GPU
    // upscales with linear filtering, smoothing bins instead of hard squares
    map.addSource(srcId, { type: "raster", tiles: [url], tileSize: 256,
                           maxzoom: 9 });
    map.addLayer({ id: layerId, type: "raster", source: srcId,
      paint: { "raster-opacity": 0, "raster-opacity-transition": { duration: 0 },
               "raster-resampling": "linear",
               "raster-fade-duration": 0 } },
      map.getLayer("base-ov0") ? "base-ov0"
        : map.getLayer("alerts-fill") ? "alerts-fill" : undefined);
    tileFrames.push({ srcId, layerId });
  });
}
function showTileFrame(idx, opacity) {
  tileFrames.forEach((f, i) =>
    map.setPaintProperty(f.layerId, "raster-opacity", i === idx ? opacity : 0));
}
function clearTileFrames() {
  for (const f of tileFrames) {
    if (map.getLayer(f.layerId)) map.removeLayer(f.layerId);
    if (map.getSource(f.srcId)) map.removeSource(f.srcId);
  }
  tileFrames.length = 0;
}

/* --------------------------------- alerts --------------------------------- */
function setAlerts(alerts) {
  const src = map && map.getSource("alerts");
  if (!src) return;
  src.setData({ type: "FeatureCollection",
    features: alerts.filter(a => a.geometry).map(a => ({
      type: "Feature", geometry: a.geometry,
      properties: { severity: a.severity, event: a.event } })) });
}

/* -------------------------------- markers --------------------------------- */
function setSiteMarkers(sites, activeId, onPick) {
  for (const s of sites) {
    if (markers[s.id] || s.lat == null) continue;
    const el = document.createElement("div");
    el.className = "radar-site";
    el.dataset.site = s.id;
    el.innerHTML = "<span></span>";
    el.title = `${s.id} — ${s.name}`;
    el.onclick = () => onPick(s.id);
    markers[s.id] = new maplibregl.Marker({ element: el })
      .setLngLat([s.lon, s.lat]).addTo(map);
  }
  markActive(activeId);
}
function markActive(id) {
  document.querySelectorAll(".radar-site").forEach(el =>
    el.classList.toggle("active", el.dataset.site === id));
}
function setStationMarker(lat, lon, name, show) {
  if (stationMarker) { stationMarker.remove(); stationMarker = null; }
  if (!show || lat == null) return;
  const el = document.createElement("div");
  el.className = "station-dot";
  el.innerHTML = '<div class="pulse"></div><div class="core"></div>';
  el.title = name;
  stationMarker = new maplibregl.Marker({ element: el })
    .setLngLat([lon, lat]).addTo(map);
}

let locMarkers = [];
function setCustomLocations(locs, onPick) {
  locMarkers.forEach(m => m.remove());
  locMarkers = [];
  for (const l of locs || []) {
    if (l.lat == null || l.lon == null) continue;
    const el = document.createElement("div");
    el.className = "loc-pin";
    let pin;
    if (l.icon && l.id) {
      pin = document.createElement("img");
      pin.className = "pin-img";
      pin.src = `/api/locations/${l.id}/icon?t=${l._t || 0}`;
      pin.onerror = () => { pin.replaceWith(Object.assign(
        document.createElement("span"), { className: "pin" })); };
    } else {
      pin = document.createElement("span");
      pin.className = "pin";
    }
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = l.name;
    el.append(pin, lbl);
    if (onPick) el.onclick = () => onPick(l);
    locMarkers.push(new maplibregl.Marker({ element: el, anchor: "bottom" })
      .setLngLat([l.lon, l.lat]).addTo(map));
  }
}

function flyTo(lat, lon, zoom) { map && map.flyTo({ center: [lon, lat], zoom }); }
function getMap() { return map; }

return { init, setBasemap, setTileFrames, showTileFrame, clearTileFrames,
         setAlerts, setSiteMarkers, markActive, setStationMarker, flyTo,
         getMap, setStormTracks, setCustomLocations, BASEMAPS };
})();
