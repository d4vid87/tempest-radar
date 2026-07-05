"""Tempest Radar web server.

Serves the dashboard UI and a small JSON API; starts the background workers
(Tempest WebSocket, NWS alerts, IEM radar frames, news feeds) on startup.

    uvicorn app:app --host 0.0.0.0 --port 5555
"""

import json
import re
import sys
import time
import uuid

import requests
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

import config
import state
from workers.alerts import AlertsWorker
from workers.news import NewsWorker
from workers.radar import RadarWorker
from workers.level2 import L2Store, pack_artifact
from workers.tempest import TempestWorker, fetch_station_meta, seed_observation

STATIC = Path(__file__).parent / "static"

# ---------------------------------------------------------------------------
# Built-in themes. Custom ones live in /data/themes.json (same shape) and are
# merged in at request time, so users can add/edit themes with no restart.
# ---------------------------------------------------------------------------
BUILTIN_THEMES = [
    {"id": "storm", "name": "Storm Console",
     "basemap": "dark_all",
     "vars": {"--bg": "#10151c", "--panel": "#171e27", "--border": "#232d3a",
              "--text": "#d7e3ee", "--muted": "#8fa3b3", "--accent": "#4fd1ff",
              "--good": "#7fd7a4", "--warn": "#ffd41a", "--danger": "#ff2a44"}},
    {"id": "oled", "name": "Midnight OLED",
     "basemap": "dark_nolabels",
     "vars": {"--bg": "#000000", "--panel": "#0a0a0c", "--border": "#1c1c22",
              "--text": "#e8ecf1", "--muted": "#7c8791", "--accent": "#00e5ff",
              "--good": "#38e07b", "--warn": "#ffcc00", "--danger": "#ff3355"}},
    {"id": "daylight", "name": "Daylight",
     "basemap": "light_all",
     "vars": {"--bg": "#eef1f5", "--panel": "#ffffff", "--border": "#d5dce4",
              "--text": "#1c2733", "--muted": "#5d6b7a", "--accent": "#0a66c2",
              "--good": "#1a7f4b", "--warn": "#b58900", "--danger": "#c8102e"}},
    {"id": "phosphor", "name": "Phosphor Terminal",
     "basemap": "dark_nolabels",
     "vars": {"--bg": "#050b06", "--panel": "#081108", "--border": "#123a18",
              "--text": "#8effa8", "--muted": "#3f7a4c", "--accent": "#33ff66",
              "--good": "#33ff66", "--warn": "#d6ff33", "--danger": "#ff5533"}},
    {"id": "amber", "name": "Chaser Amber",
     "basemap": "dark_all",
     "vars": {"--bg": "#14100a", "--panel": "#1c150c", "--border": "#33270f",
              "--text": "#f2e3c8", "--muted": "#a68f66", "--accent": "#ffb000",
              "--good": "#a3d977", "--warn": "#ffcf40", "--danger": "#ff4d33"}},
]

_workers = []
_station_workers = {}
_radar_worker = None
_cfg = None
_meta = None
_l2 = None  # created after SITES is defined

# Curated NEXRAD sites for the picker (coords approximate — used only to
# recenter the map). Any valid site ID also works via the free-text box, and
# extras can be added in /data/config.json under "extra_sites".
SITES = [
    {"id": "KFWS", "name": "Dallas / Fort Worth TX", "lat": 32.57, "lon": -97.30},
    {"id": "KTLX", "name": "Oklahoma City OK", "lat": 35.33, "lon": -97.28},
    {"id": "KAMA", "name": "Amarillo TX", "lat": 35.23, "lon": -101.71},
    {"id": "KLBB", "name": "Lubbock TX", "lat": 33.65, "lon": -101.81},
    {"id": "KMAF", "name": "Midland TX", "lat": 31.94, "lon": -102.19},
    {"id": "KEWX", "name": "Austin / San Antonio TX", "lat": 29.70, "lon": -98.03},
    {"id": "KHGX", "name": "Houston TX", "lat": 29.47, "lon": -95.08},
    {"id": "KSHV", "name": "Shreveport LA", "lat": 32.45, "lon": -93.84},
    {"id": "KLZK", "name": "Little Rock AR", "lat": 34.84, "lon": -92.26},
    {"id": "KLIX", "name": "New Orleans LA", "lat": 30.34, "lon": -89.83},
    {"id": "KDGX", "name": "Jackson MS", "lat": 32.28, "lon": -89.98},
    {"id": "KNQA", "name": "Memphis TN", "lat": 35.34, "lon": -89.87},
    {"id": "KBMX", "name": "Birmingham AL", "lat": 33.17, "lon": -86.77},
    {"id": "KFFC", "name": "Atlanta GA", "lat": 33.36, "lon": -84.57},
    {"id": "KTBW", "name": "Tampa FL", "lat": 27.71, "lon": -82.40},
    {"id": "KMLB", "name": "Melbourne FL", "lat": 28.11, "lon": -80.65},
    {"id": "KPAH", "name": "Paducah KY", "lat": 37.07, "lon": -88.77},
    {"id": "KSGF", "name": "Springfield MO", "lat": 37.24, "lon": -93.40},
    {"id": "KEAX", "name": "Kansas City MO", "lat": 38.81, "lon": -94.26},
    {"id": "KICT", "name": "Wichita KS", "lat": 37.65, "lon": -97.44},
    {"id": "KDMX", "name": "Des Moines IA", "lat": 41.73, "lon": -93.72},
    {"id": "KMPX", "name": "Minneapolis MN", "lat": 44.85, "lon": -93.57},
    {"id": "KLOT", "name": "Chicago IL", "lat": 41.60, "lon": -88.08},
    {"id": "KIND", "name": "Indianapolis IN", "lat": 39.71, "lon": -86.28},
    {"id": "KCLE", "name": "Cleveland OH", "lat": 41.41, "lon": -81.86},
    {"id": "KOKX", "name": "New York NY", "lat": 40.87, "lon": -72.86},
    {"id": "KBOX", "name": "Boston MA", "lat": 41.96, "lon": -71.14},
    {"id": "KDIX", "name": "Philadelphia PA", "lat": 39.95, "lon": -74.41},
    {"id": "KLWX", "name": "Washington DC", "lat": 38.98, "lon": -77.48},
    {"id": "KFTG", "name": "Denver CO", "lat": 39.79, "lon": -104.55},
    {"id": "KABX", "name": "Albuquerque NM", "lat": 35.15, "lon": -106.82},
    {"id": "KIWA", "name": "Phoenix AZ", "lat": 33.29, "lon": -111.67},
    {"id": "KESX", "name": "Las Vegas NV", "lat": 35.70, "lon": -114.89},
    {"id": "KNKX", "name": "San Diego CA", "lat": 32.92, "lon": -117.04},
    {"id": "KMUX", "name": "San Francisco CA", "lat": 37.16, "lon": -121.90},
    {"id": "KRTX", "name": "Portland OR", "lat": 45.71, "lon": -122.96},
    {"id": "KATX", "name": "Seattle WA", "lat": 48.19, "lon": -122.50},
]
_l2 = L2Store(site_coords={s["id"]: (s["lat"], s["lon"]) for s in SITES})


def _public_station(cfg, meta):
    """What the UI is allowed to know. The station's real public name is
    never exposed; a location override replaces the true coordinates."""
    loc = cfg.get("location") or {}
    return {
        "name": cfg.get("station_label") or "Weather Station",
        "lat": loc.get("lat", meta["lat"]),
        "lon": loc.get("lon", meta["lon"]),
        "show_marker": bool(cfg.get("show_station_marker", True)),
        "configured": True,
    }


def start_station_workers(cfg) -> str | None:
    """(Re)start the station-dependent workers. Returns error text or None."""
    global _meta, _radar_worker
    for name in ("tempest_w", "alerts_w"):
        w = _station_workers.pop(name, None)
        if w:
            w.stop()
    try:
        meta = fetch_station_meta(cfg["station_id"], cfg["token"])
    except Exception as e:  # noqa: BLE001
        state.set_worker_status("tempest", f"startup error: {e}")
        return str(e)
    _meta = meta
    state.update("station", _public_station(cfg, meta))
    seed_observation(cfg["station_id"], cfg["token"])
    loc = cfg.get("location") or {}
    alat, alon = loc.get("lat", meta["lat"]), loc.get("lon", meta["lon"])
    tw = TempestWorker(cfg["token"], meta["device_id"])
    aw = AlertsWorker(alat, alon, cfg["alerts_poll_s"])
    _station_workers["tempest_w"] = tw
    _station_workers["alerts_w"] = aw
    tw.start()
    aw.start()
    return None


def start_radar_worker(cfg):
    """Start the radar worker independent of station availability."""
    global _radar_worker
    if _radar_worker is not None:
        return
    loc = cfg.get("location") or {}
    known = next((s for s in SITES if s["id"] == cfg["radar_site"]), None)
    lat = loc.get("lat") or (known["lat"] if known else 32.6)
    lon = loc.get("lon") or (known["lon"] if known else -97.3)
    _radar_worker = RadarWorker(cfg["radar_site"], cfg["radar_product"],
                                cfg["radar_poll_s"], lat=lat, lon=lon)
    _radar_worker.start()


def start_news_workers(cfg):
    for name in ("news_w", "wx_w"):
        w = _station_workers.pop(name, None)
        if w:
            w.stop()
    nw = NewsWorker(cfg["news_feeds"], cfg["news_poll_s"], "news")
    ww = NewsWorker(cfg.get("wx_feeds", []), cfg["news_poll_s"], "wx_news")
    _station_workers["news_w"] = nw
    _station_workers["wx_w"] = ww
    nw.start()
    ww.start()


@asynccontextmanager
async def lifespan(app):
    global _cfg
    cfg = config.load()
    _cfg = cfg
    start_radar_worker(cfg)
    if cfg["token"] and cfg["station_id"]:
        err = start_station_workers(cfg)
        if err:
            print(f"station startup: {err}", file=sys.stderr)
    else:
        state.set_worker_status("tempest", "not configured — open settings (⚙)")
        state.update("station", {"name": "Setup required", "configured": False})
    start_news_workers(cfg)
    yield
    for w in list(_station_workers.values()) + ([_radar_worker] if _radar_worker else []):
        w.stop()


app = FastAPI(title="Tempest Radar", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.get("/api/state")
def api_state():
    return JSONResponse(state.snapshot())


@app.get("/api/themes")
def api_themes():
    themes = list(BUILTIN_THEMES)
    seen = {t["id"] for t in themes}
    for t in config.load_custom_themes():
        if isinstance(t, dict) and t.get("id") and t.get("vars"):
            if t["id"] in seen:  # custom theme overrides builtin with same id
                themes = [x for x in themes if x["id"] != t["id"]]
            themes.append(t)
            seen.add(t["id"])
    return JSONResponse(themes)


@app.get("/api/sites")
def api_sites():
    sites = list(SITES)
    seen = {s["id"] for s in sites}
    for s in config.load().get("extra_sites", []):
        if isinstance(s, dict) and s.get("id") and s["id"] not in seen:
            sites.append(s)
            seen.add(s["id"])
    return JSONResponse(sites)


@app.post("/api/radar")
async def api_radar(body: dict):
    """Switch radar site and/or product live (no restart)."""
    if _radar_worker is None:
        return JSONResponse({"ok": False, "error": "radar worker not running"},
                            status_code=503)
    site = str(body.get("site") or "").upper().strip() or None
    product = str(body.get("product") or "").upper().strip() or None
    if site and not re.match(r"^[A-Z]{3,4}$", site):
        return JSONResponse({"ok": False, "error": "bad site id"}, status_code=400)
    if product and not re.match(r"^[A-Z0-9]{2,4}$", product):
        return JSONResponse({"ok": False, "error": "bad product"}, status_code=400)
    known = next((s for s in SITES if s["id"] == site), None)
    _radar_worker.reconfigure(site=site, product=product,
                              lat=known["lat"] if known else None,
                              lon=known["lon"] if known else None)
    return {"ok": True, "site": site or _radar_worker.site,
            "product": product or _radar_worker.product}



# ---------------------------------------------------------------------------
# Station history (WeatherFlow device observations, bucketed for charting)
# ---------------------------------------------------------------------------
_hist_cache = {}

@app.get("/api/history")
def api_history(hours: int = 24):
    hours = max(1, min(hours, 168))
    if _cfg is None or _meta is None or not _cfg.get("token"):
        return JSONResponse({"error": "station not configured"}, status_code=503)
    cached = _hist_cache.get(hours)
    if cached and time.time() - cached[0] < 300:
        return JSONResponse(cached[1])

    end = int(time.time())
    start = end - hours * 3600
    rows = []
    t = start
    while t < end:                       # WeatherFlow caps range per request
        chunk_end = min(t + 24 * 3600, end)
        r = requests.get(
            f"https://swd.weatherflow.com/swd/rest/observations/device/"
            f"{_meta['device_id']}",
            params={"token": _cfg["token"], "time_start": t,
                    "time_end": chunk_end}, timeout=20)
        r.raise_for_status()
        rows.extend(r.json().get("obs") or [])
        t = chunk_end
    if not rows:
        return JSONResponse({"error": "no observations returned"}, status_code=502)

    # obs_st indices: 0 epoch, 2 wind avg, 3 gust, 6 pressure, 7 temp, 8 rh,
    # 10 uv, 11 solar, 12 rain(mm/interval), 15 strikes
    bucket_s = max(60, (hours * 3600) // 288)
    buckets = {}
    for o in rows:
        b = (o[0] // bucket_s) * bucket_s
        buckets.setdefault(b, []).append(o)
    epochs, series = [], {k: [] for k in
        ("temp_c", "rh", "wind_avg", "wind_gust", "pressure_mb",
         "rain_mm", "uv", "solar", "strikes")}
    def avg(vals):
        vals = [v for v in vals if v is not None]
        return round(sum(vals) / len(vals), 2) if vals else None
    for b in sorted(buckets):
        rs = buckets[b]
        epochs.append(b)
        series["temp_c"].append(avg([r[7] for r in rs if len(r) > 7]))
        series["rh"].append(avg([r[8] for r in rs if len(r) > 8]))
        series["wind_avg"].append(avg([r[2] for r in rs if len(r) > 2]))
        series["wind_gust"].append(max((r[3] or 0) for r in rs if len(r) > 3))
        series["pressure_mb"].append(avg([r[6] for r in rs if len(r) > 6]))
        series["rain_mm"].append(round(sum((r[12] or 0) for r in rs if len(r) > 12), 2))
        series["uv"].append(avg([r[10] for r in rs if len(r) > 10]))
        series["solar"].append(avg([r[11] for r in rs if len(r) > 11]))
        series["strikes"].append(sum(int(r[15] or 0) for r in rs if len(r) > 15))
    payload = {"hours": hours, "bucket_s": bucket_s, "epochs": epochs, **series}
    _hist_cache[hours] = (time.time(), payload)
    return JSONResponse(payload)


# ---------------------------------------------------------------------------
# NEXRAD Level 2 (MetPy-decoded, supercell-wx style)
# ---------------------------------------------------------------------------
THREDDS_FS = "https://thredds.ucar.edu/thredds/fileServer/"
S3_BASE = "https://noaa-nexrad-level2.s3.amazonaws.com/"
VOL_ID_RE = re.compile(r"^[A-Za-z0-9/_.\-]+$")


def _vol_url(vol_id: str) -> str:
    # THREDDS ids look like nexrad/level2/KFWS/.../Level2_....ar2v
    # S3 keys look like 2026/07/02/KFWS/KFWS2026..._V06
    return (THREDDS_FS + vol_id) if vol_id.startswith("nexrad") else (S3_BASE + vol_id)


@app.get("/api/l2/catalog")
def api_l2_catalog(site: str):
    """Plan §2.3.E: the tiny 'what frames exist right now' source of truth."""
    site = site.upper().strip()
    if not re.match(r"^[A-Z]{4}$", site):
        return JSONResponse({"error": "bad site"}, status_code=400)
    try:
        cat = _l2.index(site)
        for t in cat.get("tilts", []):           # calibration always available
            if "TST" not in t["moments"]:
                t["moments"].append("TST")
        return JSONResponse(cat)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=502)


@app.get("/api/l2/artifact")
def api_l2_artifact(site: str, vol: str, angle: float = 0.5, moment: str = "REF"):
    """Plan §2.3.A: compact binary per-sweep artifact (header + uint8 grid)."""
    site = site.upper().strip()
    moment = moment.upper().strip()
    if not re.match(r"^[A-Z]{4}$", site) or not VOL_ID_RE.match(vol) \
            or site not in vol or ".." in vol:
        return JSONResponse({"error": "bad params"}, status_code=400)
    try:
        if moment == "TST":
            return Response(content=pack_artifact(make_test_pattern(site)),
                            media_type="application/octet-stream")
        sweep = _l2.sweep(site, vol, _vol_url(vol), angle, moment)
        if sweep is None:
            return JSONResponse({"error": "sweep not in volume"}, status_code=404)
        return Response(content=pack_artifact(dict(sweep)),
                        media_type="application/octet-stream",
                        headers={"Cache-Control": "public, max-age=86400"})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=502)


@app.get("/api/l2/debug")
def api_l2_debug(site: str):
    try:
        return JSONResponse(_l2.debug(site.upper().strip()))
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=502)


# ---------------------------------------------------------------------------
# Color tables — built-ins plus supercell-wx / GR2Analyst-style .pal files
# dropped into /data/colortables (Product: maps BR→REF, BV→VEL, CC→RHO)
# ---------------------------------------------------------------------------
_CLASSIC = {
    "REF": [  # faint clear-air grays, then the classic NWS ladder (solid steps)
        {"v": -25, "rgb": [59, 59, 62], "rgb2": [108, 116, 126], "a": 150},
        {"v": 0,   "rgb": [108, 116, 126], "a": 160},
        {"v": 5,   "rgb": [4, 233, 231]},  {"v": 10, "rgb": [1, 159, 244]},
        {"v": 15,  "rgb": [3, 0, 244]},    {"v": 20, "rgb": [2, 253, 2]},
        {"v": 25,  "rgb": [1, 197, 1]},    {"v": 30, "rgb": [0, 142, 0]},
        {"v": 35,  "rgb": [253, 248, 2]},  {"v": 40, "rgb": [229, 188, 0]},
        {"v": 45,  "rgb": [253, 149, 0]},  {"v": 50, "rgb": [253, 0, 0]},
        {"v": 55,  "rgb": [212, 0, 0]},    {"v": 60, "rgb": [188, 0, 0]},
        {"v": 65,  "rgb": [248, 0, 253]},  {"v": 70, "rgb": [152, 84, 198]},
        {"v": 75,  "rgb": [253, 253, 253]},
    ],
    "VEL": [  # inbound greens → gray zero → outbound reds (gradients)
        {"v": -101, "rgb": [140, 40, 255], "rgb2": [0, 240, 255]},
        {"v": -80,  "rgb": [0, 240, 255], "rgb2": [0, 255, 130]},
        {"v": -55,  "rgb": [0, 255, 130], "rgb2": [0, 120, 40]},
        {"v": -8,   "rgb": [0, 120, 40], "rgb2": [96, 112, 96]},
        {"v": -1,   "rgb": [110, 110, 110]},
        {"v": 1,    "rgb": [112, 96, 96], "rgb2": [130, 30, 20]},
        {"v": 8,    "rgb": [130, 30, 20], "rgb2": [255, 60, 30]},
        {"v": 55,   "rgb": [255, 60, 30], "rgb2": [255, 190, 80]},
        {"v": 80,   "rgb": [255, 190, 80], "rgb2": [255, 255, 180]},
    ],
    "SW":  [{"v": 0, "rgb": [40, 40, 60], "rgb2": [80, 160, 255]},
            {"v": 8, "rgb": [80, 160, 255], "rgb2": [255, 220, 60]},
            {"v": 16, "rgb": [255, 220, 60], "rgb2": [255, 40, 40]}],
    "ZDR": [{"v": -4, "rgb": [40, 60, 160], "rgb2": [160, 160, 160]},
            {"v": 0, "rgb": [160, 160, 160], "rgb2": [80, 200, 80]},
            {"v": 2, "rgb": [80, 200, 80], "rgb2": [250, 220, 60]},
            {"v": 5, "rgb": [250, 220, 60], "rgb2": [230, 40, 200]}],
    "RHO": [{"v": 0.2, "rgb": [30, 30, 30], "rgb2": [60, 60, 200]},
            {"v": 0.8, "rgb": [60, 60, 200], "rgb2": [60, 220, 60]},
            {"v": 0.96, "rgb": [60, 220, 60], "rgb2": [250, 250, 80]},
            {"v": 1.0, "rgb": [250, 120, 40], "rgb2": [240, 40, 220]}],
    "PHI": [{"v": 0, "rgb": [30, 30, 120], "rgb2": [40, 200, 200]},
            {"v": 120, "rgb": [40, 200, 200], "rgb2": [240, 220, 60]},
            {"v": 240, "rgb": [240, 220, 60], "rgb2": [220, 40, 40]}],
    "CFP": [{"v": 0, "rgb": [60, 60, 60], "rgb2": [220, 220, 220]}],
}


def _ramp(seq):
    """Turn a color sequence into a stop-list factory scaled to (lo, hi)."""
    n = len(seq) - 1
    def make(lo_v, hi_v):
        return [{"v": lo_v + (hi_v - lo_v) * i / n, "rgb": list(seq[i]),
                 "rgb2": list(seq[min(i + 1, n)])} for i in range(n)]
    return make


_RAMPS = {
    "Viridis":       _ramp([[68, 1, 84], [59, 82, 139], [33, 145, 140],
                            [94, 201, 98], [253, 231, 37]]),
    "Turbo":         _ramp([[48, 18, 59], [70, 134, 251], [27, 229, 181],
                            [164, 252, 60], [251, 185, 56], [220, 56, 20],
                            [122, 4, 3]]),
    "Inferno":       _ramp([[0, 0, 4], [87, 16, 110], [188, 55, 84],
                            [249, 142, 9], [252, 255, 164]]),
    "Magma":         _ramp([[0, 0, 4], [81, 18, 124], [183, 55, 121],
                            [251, 136, 97], [252, 253, 191]]),
    "Plasma":        _ramp([[13, 8, 135], [126, 3, 168], [204, 71, 120],
                            [248, 149, 64], [240, 249, 33]]),
    "Classic Green": _ramp([[10, 40, 10], [30, 120, 30], [60, 200, 60],
                            [230, 230, 40], [230, 120, 30], [200, 30, 30],
                            [240, 240, 240]]),
    "Dark Ocean":    _ramp([[5, 10, 30], [10, 40, 90], [20, 90, 160],
                            [40, 170, 220], [180, 240, 255]]),
    "Sunset":        _ramp([[40, 0, 70], [130, 20, 110], [220, 50, 70],
                            [250, 130, 40], [255, 210, 120]]),
    "Ice":           _ramp([[240, 250, 255], [160, 210, 245], [80, 150, 220],
                            [30, 80, 170], [10, 25, 90]]),
    "Neon":          _ramp([[20, 20, 30], [200, 30, 200], [40, 220, 220],
                            [170, 255, 60], [255, 255, 255]]),
    "Grayscale":     _ramp([[25, 25, 25], [235, 235, 235]]),
    "Amber Mono":    _ramp([[30, 18, 0], [140, 85, 10], [255, 176, 32],
                            [255, 235, 170]]),
}

_RANGES_UI = {"REF": (-32, 94.5), "VEL": (-101, 101), "SW": (0, 40),
              "ZDR": (-8, 8), "RHO": (0.2, 1.05), "PHI": (0, 360),
              "CFP": (0, 100), "TST": (-32, 94.5)}

BUILTIN_TABLES = {}
for _prod, _stops in _CLASSIC.items():
    _lo, _hi = _RANGES_UI.get(_prod, (0, 100))
    BUILTIN_TABLES[_prod] = ([{"name": "NWS Classic", "stops": _stops}] +
                             [{"name": _n, "stops": _f(_lo, _hi)}
                              for _n, _f in _RAMPS.items()])

PAL_PRODUCT_MAP = {"BR": "REF", "REF": "REF", "BV": "VEL", "VEL": "VEL",
                   "SW": "SW", "ZDR": "ZDR", "CC": "RHO", "RHO": "RHO",
                   "PHI": "PHI", "KDP": "PHI"}


def _parse_pal(text):
    prod, stops = None, []
    for line in text.splitlines():
        line = line.split(";")[0].strip()
        if line.lower().startswith("product:"):
            prod = line.split(":", 1)[1].strip().upper()
        m = re.match(r"color4?:\s*(-?[\d.]+)\s+(\d+)\s+(\d+)\s+(\d+)"
                     r"(?:\s+(\d+)\s+(\d+)\s+(\d+))?", line, re.I)
        if m:
            stop = {"v": float(m.group(1)),
                    "rgb": [int(m.group(2)), int(m.group(3)), int(m.group(4))]}
            if m.group(5):
                stop["rgb2"] = [int(m.group(5)), int(m.group(6)), int(m.group(7))]
            stops.append(stop)
    stops.sort(key=lambda s: s["v"])
    return PAL_PRODUCT_MAP.get(prod or "", None), stops


@app.get("/api/colortables")
def api_colortables():
    tables = {k: [dict(p) for p in v] for k, v in BUILTIN_TABLES.items()}
    ct_dir = config.DATA_DIR / "colortables"
    if ct_dir.is_dir():
        for f in sorted(ct_dir.glob("*.pal")):
            try:
                prod, stops = _parse_pal(f.read_text(errors="replace"))
                if prod and stops:
                    tables.setdefault(prod, []).append(
                        {"name": f.stem, "stops": stops})
            except Exception as e:
                print(f"[colortables] {f.name}: {e!r}")
    return JSONResponse(tables)


# ---------------------------------------------------------------------------
# In-app settings + geocoding
# ---------------------------------------------------------------------------
@app.get("/api/settings")
def api_settings_get():
    cfg = _cfg or config.load()
    def feeds(key):
        return [{"name": f.get("name", ""), "url": f.get("url", "")}
                for f in cfg.get(key, [])]
    return JSONResponse({
        "configured": bool(cfg.get("token") and cfg.get("station_id")),
        "has_token": bool(cfg.get("token")),
        "station_id": cfg.get("station_id"),
        "station_label": cfg.get("station_label", ""),
        "show_station_marker": bool(cfg.get("show_station_marker", True)),
        "location": cfg.get("location"),
        "tide_station": cfg.get("tide_station", ""),
        "news_feeds": feeds("news_feeds"),
        "wx_feeds": feeds("wx_feeds"),
    })


@app.post("/api/settings")
async def api_settings_post(body: dict):
    global _cfg
    cfg = _cfg or config.load()
    updates, station_changed, news_changed = {}, False, False

    if body.get("token"):
        updates["token"] = str(body["token"]).strip()
        station_changed = True
    if body.get("station_id") is not None:
        try:
            sid = int(body["station_id"])
        except (TypeError, ValueError):
            return JSONResponse({"ok": False, "error": "station id must be a number"},
                                status_code=400)
        if sid != cfg.get("station_id"):
            updates["station_id"] = sid
            station_changed = True
    if "station_label" in body:
        updates["station_label"] = str(body["station_label"])[:60]
    if "show_station_marker" in body:
        updates["show_station_marker"] = bool(body["show_station_marker"])
    if "tide_station" in body:
        updates["tide_station"] = re.sub(r"[^0-9]", "", str(body["tide_station"]))[:10]
    if "location" in body:
        loc = body["location"]
        if loc is None:
            updates["location"] = None
            station_changed = True
        elif isinstance(loc, dict) and -90 <= float(loc.get("lat", 999)) <= 90                 and -180 <= float(loc.get("lon", 999)) <= 180:
            updates["location"] = {"lat": float(loc["lat"]),
                                   "lon": float(loc["lon"]),
                                   "label": str(loc.get("label", ""))[:120]}
            station_changed = True
    for key in ("news_feeds", "wx_feeds"):
        if key in body and isinstance(body[key], list):
            clean = [{"name": str(f.get("name", "feed"))[:40],
                      "url": str(f.get("url", ""))}
                     for f in body[key]
                     if isinstance(f, dict)
                     and str(f.get("url", "")).startswith(("http://", "https://"))]
            updates[key] = clean
            news_changed = True

    if not updates:
        return JSONResponse({"ok": False, "error": "nothing to save"}, status_code=400)
    config.save_settings(updates)
    _cfg = config.load()

    msg = "saved"
    if news_changed:
        start_news_workers(_cfg)
        msg = "saved — feeds reloaded"
    if station_changed or ("station_label" in updates or "show_station_marker" in updates):
        if _cfg.get("token") and _cfg.get("station_id"):
            err = start_station_workers(_cfg)
            if err:
                return JSONResponse({"ok": False,
                                     "error": f"saved, but station failed: {err}"})
            msg = "saved — station connected"
        else:
            msg = "saved — enter both a token and station id to connect"
    return {"ok": True, "message": msg}


@app.get("/api/locations")
def api_locations_get():
    return JSONResponse(config.load().get("custom_locations", []))


@app.post("/api/locations")
async def api_locations_set(request: Request):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": "bad json"}, status_code=400)
    if not isinstance(body, list):
        return JSONResponse({"ok": False, "error": "expected a list"},
                            status_code=400)
    locs = []
    for it in (body or [])[:500]:
        try:
            loc = {"name": str(it["name"]).strip()[:48] or "Location",
                   "lat": float(it["lat"]), "lon": float(it["lon"])}
            lid = str(it.get("id") or "")
            loc["id"] = lid if re.match(r"^[A-Za-z0-9_-]{1,32}$", lid) \
                else uuid.uuid4().hex[:10]
            if it.get("icon"):
                loc["icon"] = True
            locs.append(loc)
        except (KeyError, TypeError, ValueError):
            continue
    config.save_settings({"custom_locations": locs})
    # drop icon files for locations that no longer exist
    keep = {l["id"] for l in locs}
    if LOC_ICON_DIR.exists():
        for f in LOC_ICON_DIR.iterdir():
            if f.stem not in keep:
                f.unlink(missing_ok=True)
    return {"ok": True, "count": len(locs)}


LOC_ICON_DIR = config.DATA_DIR / "loc_icons"
_IMG_SIGS = ((b"\x89PNG", ".png"), (b"\xff\xd8\xff", ".jpg"),
             (b"GIF8", ".gif"))


@app.post("/api/locations/{loc_id}/icon")
async def api_loc_icon_set(loc_id: str, request: Request):
    if not re.match(r"^[A-Za-z0-9_-]{1,32}$", loc_id):
        return JSONResponse({"ok": False, "error": "bad id"}, status_code=400)
    data = await request.body()
    if not data or len(data) > 3_000_000:
        return JSONResponse({"ok": False, "error": "empty or >3 MB"},
                            status_code=400)
    ext = next((e for sig, e in _IMG_SIGS if data.startswith(sig)), None)
    if ext is None and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        ext = ".webp"
    if ext is None:
        return JSONResponse({"ok": False, "error": "not an image"},
                            status_code=400)
    LOC_ICON_DIR.mkdir(parents=True, exist_ok=True)
    for old in LOC_ICON_DIR.glob(f"{loc_id}.*"):
        old.unlink(missing_ok=True)
    (LOC_ICON_DIR / f"{loc_id}{ext}").write_bytes(data)
    return {"ok": True}


@app.get("/api/locations/{loc_id}/icon")
def api_loc_icon_get(loc_id: str):
    if re.match(r"^[A-Za-z0-9_-]{1,32}$", loc_id) and LOC_ICON_DIR.exists():
        for f in LOC_ICON_DIR.glob(f"{loc_id}.*"):
            return FileResponse(f)
    return JSONResponse({"error": "no icon"}, status_code=404)


# ---------------------------------------------------------------------------
# Data overlays — proxied free feeds (SPC / IEM / AviationWeather), cached
# ---------------------------------------------------------------------------
OVERLAY_FEEDS = {
    "outlook1": "https://www.spc.noaa.gov/products/outlook/day1otlk_cat.lyr.geojson",
    "outlook2": "https://www.spc.noaa.gov/products/outlook/day2otlk_cat.lyr.geojson",
    "mcd": "https://mesonet.agron.iastate.edu/api/1/nws/spc_mcd.geojson",
    "watches": "https://mesonet.agron.iastate.edu/api/1/spc_watch_outline.geojson",
    "lsr": "https://mesonet.agron.iastate.edu/geojson/lsr.geojson?hours=6",
}
_overlay_cache = {}


@app.get("/api/overlay/{kind}")
def api_overlay(kind: str, bbox: str = ""):
    if kind == "metar":
        try:
            s, w, n, e = [round(float(x), 1) for x in bbox.split(",")]
            assert -90 <= s < n <= 90 and -180 <= w < e <= 180
        except (ValueError, AssertionError):
            return JSONResponse({"error": "bad bbox"}, status_code=400)
        url = ("https://aviationweather.gov/api/data/metar?format=geojson"
               f"&bbox={s},{w},{n},{e}")
        key = f"metar:{s},{w},{n},{e}"
    elif kind in OVERLAY_FEEDS:
        url, key = OVERLAY_FEEDS[kind], kind
    else:
        return JSONResponse({"error": "unknown overlay"}, status_code=404)
    cached = _overlay_cache.get(key)
    if cached and time.time() - cached[0] < 180:
        return Response(cached[1], media_type="application/json")
    try:
        r = requests.get(url, timeout=20,
                         headers={"User-Agent": "(tempest-radar; personal use)"})
        r.raise_for_status()
        body = r.content
        json.loads(body)          # ensure it's valid JSON, not an error page
    except Exception as e:  # noqa: BLE001
        if cached:                # serve stale rather than nothing
            return Response(cached[1], media_type="application/json")
        return JSONResponse({"error": str(e)}, status_code=502)
    _overlay_cache[key] = (time.time(), body)
    return Response(body, media_type="application/json")


@app.get("/api/geocode")
def api_geocode(q: str):
    """Address → coordinates via OpenStreetMap Nominatim (free, rate-limited;
    used only when the user searches in settings)."""
    q = q.strip()[:120]
    if len(q) < 3:
        return JSONResponse([])
    try:
        r = requests.get("https://nominatim.openstreetmap.org/search",
                         params={"format": "json", "q": q, "limit": 5},
                         headers={"User-Agent": "tempest-radar (self-hosted)"},
                         timeout=15)
        r.raise_for_status()
        return JSONResponse([
            {"label": item.get("display_name", "")[:120],
             "lat": float(item["lat"]), "lon": float(item["lon"])}
            for item in r.json()])
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e)}, status_code=502)


# ---------------------------------------------------------------------------
# Calibration test pattern (moment TST): 100 km range rings + compass wedges.
# Load it from the moment dropdown to verify geometry on screen instantly.
# ---------------------------------------------------------------------------
def make_test_pattern(site: str) -> dict:
    known = next((s for s in SITES if s["id"] == site), None)
    lat, lon = (known["lat"], known["lon"]) if known else (39.0, -98.0)
    rows, ngates, spacing = 720, 1832, 250.0
    grid = bytearray(rows * ngates)
    for row in range(rows):
        az = row * 0.5
        # compass wedges: 1 stripe at N, 2 at E, 3 at S, 4 at W (5° wide each)
        wedge = 0
        for n, center in ((1, 0), (2, 90), (3, 180), (4, 270)):
            for k in range(n):
                if abs((az - (center + k * 8) + 180) % 360 - 180) < 2.5:
                    wedge = 255
        base = row * ngates
        for g in range(ngates):
            ring = 200 if int(g * spacing) // 100000 % 2 == 0 else 60
            grid[base + g] = wedge or ring
    return {"rows": rows, "ngates": ngates, "first_m": 0.0,
            "spacing_m": spacing, "lo": -32.0, "hi": 94.5, "moment": "TST",
            "radar_lat": lat, "radar_lon": lon, "pct_echo": 100.0,
            "angle": 0.0, "time": None, "grid": bytes(grid)}


# ---------------------------------------------------------------------------
# Site-scoped severe weather ticker: active NWS alerts for the selected
# radar's state, replacing the national RSS feeds when the state is known.
# ---------------------------------------------------------------------------
_wx_cache = {}

@app.get("/api/wx_alerts")
def api_wx_alerts(site: str):
    site = site.upper().strip()
    known = next((s for s in SITES if s["id"] == site), None)
    state = None
    if known:
        tail = known["name"].rsplit(" ", 1)[-1]
        if len(tail) == 2 and tail.isupper():
            state = tail
    if not state:
        return JSONResponse({"items": None})   # unknown site -> RSS fallback
    cached = _wx_cache.get(state)
    if cached and time.time() - cached[0] < 60:
        return JSONResponse({"items": cached[1], "state": state})
    try:
        r = requests.get("https://api.weather.gov/alerts/active",
                         params={"area": state},
                         headers={"User-Agent": "(tempest-radar; personal use)",
                                  "Accept": "application/geo+json"}, timeout=15)
        r.raise_for_status()
        items = []
        for f in r.json().get("features", []):
            p = f.get("properties", {})
            sent = p.get("sent") or p.get("effective") or ""
            try:
                from datetime import datetime as _dt
                epoch = _dt.fromisoformat(sent).timestamp()
            except ValueError:
                epoch = 0
            items.append({
                "title": f"{p.get('event', 'Alert')} — "
                         f"{(p.get('areaDesc') or '')[:70]}",
                "link": p.get("web") or f.get("id", ""),
                "source": state, "epoch": epoch,
                "sev": p.get("severity", "Unknown")})
        rank = {"Extreme": 0, "Severe": 1, "Moderate": 2, "Minor": 3, "Unknown": 4}
        items.sort(key=lambda i: (rank.get(i["sev"], 4), -i["epoch"]))
        items = items[:15]
        _wx_cache[state] = (time.time(), items)
        return JSONResponse({"items": items, "state": state})
    except Exception as e:
        return JSONResponse({"items": None, "error": str(e)})


# ---------------------------------------------------------------------------
# Storm tracks: NEXRAD Level III storm attributes via IEM (cell positions,
# motion vectors, TVS/meso/hail flags). Client extrapolates track lines.
# NOTE: STI motion uses the FROM convention; clients project toward
# (drct + 180) % 360.
# ---------------------------------------------------------------------------
_storm_cache = {}


@app.get("/api/storm_tracks")
def api_storm_tracks(site: str):
    site = site.upper().strip()
    if not re.match(r"^[A-Z]{4}$", site):
        return JSONResponse({"error": "bad site"}, status_code=400)
    cached = _storm_cache.get(site)
    if cached and time.time() - cached[0] < 60:
        return JSONResponse({"cells": cached[1]})
    cells, err = [], None
    for url in ("https://mesonet.agron.iastate.edu/geojson/nexrad_attr.geojson",
                "https://mesonet.agron.iastate.edu/geojson/nexrad_attr.py"):
        try:
            r = requests.get(url, params={"radar": site}, timeout=12,
                             headers={"User-Agent": "(tempest-radar)"})
            r.raise_for_status()
            for f in r.json().get("features", []):
                p = f.get("properties", {})
                geo = f.get("geometry") or {}
                coords = geo.get("coordinates") or [None, None]
                if coords[0] is None:
                    continue
                cells.append({
                    "id": p.get("storm_id") or p.get("id") or "?",
                    "lat": coords[1], "lon": coords[0],
                    "drct": p.get("drct"), "sknt": p.get("sknt"),
                    "tvs": str(p.get("tvs", "NONE")).upper() not in ("NONE", "", "N"),
                    "meso": str(p.get("meso", "NONE")).upper() not in ("NONE", "", "N"),
                    "max_dbz": p.get("max_dbz"), "posh": p.get("posh"),
                    "poh": p.get("poh"), "vil": p.get("vil")})
            err = None
            break
        except Exception as e:  # noqa: BLE001
            err = str(e)
    if err:
        return JSONResponse({"cells": [], "error": err})
    # the IEM geojson endpoint may return cells nationwide — keep only those
    # within NEXRAD range (~250 km) of the requested site
    known = next((s for s in SITES if s["id"] == site), None)
    if known:
        import math as _m
        def _km(a_lat, a_lon, b_lat, b_lon):
            dlat = _m.radians(b_lat - a_lat)
            dlon = _m.radians(b_lon - a_lon)
            h = (_m.sin(dlat / 2) ** 2 + _m.cos(_m.radians(a_lat))
                 * _m.cos(_m.radians(b_lat)) * _m.sin(dlon / 2) ** 2)
            return 6371 * 2 * _m.asin(_m.sqrt(h))
        cells = [c for c in cells
                 if _km(known["lat"], known["lon"], c["lat"], c["lon"]) <= 250]
    _storm_cache[site] = (time.time(), cells)
    return JSONResponse({"cells": cells})


_tide_cache = {}


@app.get("/api/tide")
def api_tide(station: str):
    """NOAA CO-OPS tide predictions for today (hourly), 10-min cache."""
    station = re.sub(r"[^0-9]", "", station)[:10]
    if not station:
        return JSONResponse({"error": "no station"}, status_code=400)
    cached = _tide_cache.get(station)
    if cached and time.time() - cached[0] < 600:
        return JSONResponse(cached[1])
    try:
        from datetime import datetime as _dt
        day = _dt.now().strftime("%Y%m%d")
        r = requests.get(
            "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter",
            params={"product": "predictions", "application": "tempest-radar",
                    "begin_date": day, "end_date": day, "datum": "MLLW",
                    "station": station, "time_zone": "lst_ldt",
                    "units": "english", "interval": "h", "format": "json"},
            timeout=15)
        r.raise_for_status()
        out = {"predictions": [{"t": p["t"], "v": float(p["v"])}
                               for p in r.json().get("predictions", [])]}
        _tide_cache[station] = (time.time(), out)
        return JSONResponse(out)
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e)}, status_code=502)


@app.get("/wall")
def wall():
    return FileResponse(STATIC / "wall.html",
                        headers={"Cache-Control": "no-cache"})


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html",
                        headers={"Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=STATIC), name="static")
