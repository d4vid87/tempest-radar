"""NEXRAD Level 2 — rebuilt on MetPy (supercell-wx philosophy: a proven
decoder feeding a GPU renderer with proper color tables).

- Discovery/download: Unidata THREDDS (verified working), S3 fallback
- Decoding: metpy.io.Level2File — the community-standard Archive II parser,
  which handles split cuts, SAILS, VCP quirks, and all message variants
- Output: sweeps quantized to uint8 on fixed physical ranges, resampled to a
  uniform 720-radial grid, ready for the WebGL painter
- Animation: the last N volumes are listed so the client can loop them
"""

import io
import re
import threading
from collections import OrderedDict
from datetime import datetime, timedelta, timezone

import numpy as np
import requests

import state

THREDDS = "https://thredds.ucar.edu/thredds"
S3 = "https://noaa-nexrad-level2.s3.amazonaws.com"
UA = {"User-Agent": "(tempest-radar level2; personal use)"}

# fixed physical ranges per moment: raw 0 = no data, raw 2..255 spans [lo, hi]
RANGES = {
    "REF": (-32.0, 94.5), "VEL": (-101.0, 101.0), "SW": (0.0, 40.0),
    "ZDR": (-8.0, 8.0), "PHI": (0.0, 360.0), "RHO": (0.2, 1.05),
    "CFP": (0.0, 100.0),
}


# ---------------------------------------------------------------- discovery
def list_recent_volumes(site: str, n: int = 6) -> list[dict]:
    """Newest→oldest capped at n. THREDDS primary, S3 fallback."""
    errors, paths = [], []
    now = datetime.now(timezone.utc)
    for day in (now - timedelta(days=1), now):        # ascending after sort
        cat = f"{THREDDS}/catalog/nexrad/level2/{site}/{day:%Y%m%d}/catalog.xml"
        try:
            r = requests.get(cat, headers=UA, timeout=15)
            if r.ok:
                paths += [p for p in re.findall(r'urlPath="([^"]+)"', r.text)
                          if site in p]
            else:
                errors.append(f"THREDDS HTTP {r.status_code}")
        except Exception as e:  # noqa: BLE001
            errors.append(f"THREDDS {type(e).__name__}")
    if paths:
        vols = []
        for p in sorted(paths)[-n:]:
            m = re.search(r"(\d{8})_(\d{4})", p)
            t = (datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M")
                 .replace(tzinfo=timezone.utc).isoformat()) if m else None
            vols.append({"id": p, "url": f"{THREDDS}/fileServer/{p}", "time": t})
        return vols
    # S3 fallback (anonymous listing is currently denied, but policies change)
    for day in (now, now - timedelta(days=1)):
        prefix = f"{day:%Y/%m/%d}/{site}/"
        try:
            r = requests.get(S3 + "/", params={"list-type": "2",
                             "prefix": prefix, "max-keys": "1000"},
                             headers=UA, timeout=15)
            if r.ok:
                keys = [k for k in re.findall(r"<Key>([^<]+)</Key>", r.text)
                        if not k.endswith("MDM") and not k.endswith(".tar")]
                if keys:
                    return [{"id": k, "url": f"{S3}/{k}", "time": None}
                            for k in sorted(keys)[-n:]]
            errors.append(f"S3 HTTP {r.status_code}")
        except Exception as e:  # noqa: BLE001
            errors.append(f"S3 {type(e).__name__}")
    raise ValueError("; ".join(dict.fromkeys(errors))[:300] or "no volumes")


# ---------------------------------------------------------------- decoding
def _moments_of(ray):
    """MetPy ray tuple: index 4 is the dict of data moments."""
    try:
        return ray[4]
    except (IndexError, TypeError):
        return {}


def parse_volume(raw: bytes, fallback_latlon=(None, None)) -> dict:
    from metpy.io import Level2File   # imported lazily; heavy module
    f = Level2File(io.BytesIO(raw))

    lat, lon = fallback_latlon
    try:
        vol_const = f.sweeps[0][0][1]
        plat, plon = float(vol_const.lat), float(vol_const.lon)
        # accept only plausible radar coordinates; a mis-mapped block can
        # yield numeric garbage like (0, 0) that would silently anchor the
        # overlay in the middle of the ocean
        if 5.0 < abs(plat) < 75.0 and 5.0 < abs(plon) < 180.0:
            lat, lon = plat, plon
    except Exception:  # noqa: BLE001 - fall back to the curated site coords
        pass
    if lat is None or lon is None:
        raise ValueError("radar coordinates unavailable — add this site with "
                         "lat/lon to extra_sites in /data/config.json")

    tilts = []          # merged: [{"angle", "moments": {name: sweep_idx}}]
    for si, sweep in enumerate(f.sweeps):
        if not sweep:
            continue
        try:
            ang = round(float(np.median([r[0].el_angle for r in sweep])), 2)
        except Exception:  # noqa: BLE001
            continue
        if not (-1.0 < ang < 60.0) or len(sweep) < 10:
            continue
        moms = set()
        for r in sweep[:3]:
            moms |= {k.decode().strip() if isinstance(k, bytes) else str(k)
                     for k in _moments_of(r).keys()}
        moms &= set(RANGES)
        if not moms:
            continue
        if tilts and abs(tilts[-1]["angle"] - ang) < 0.15:
            for m in moms:
                tilts[-1]["moments"].setdefault(m, si)
        else:
            tilts.append({"angle": ang, "moments": {m: si for m in moms}})
    if not tilts:
        raise ValueError("volume decoded but no usable sweeps")
    return {"file": f, "lat": lat, "lon": lon, "tilts": tilts}


def build_sweep(vol: dict, sweep_idx: int, moment: str) -> dict:
    """Quantize one sweep onto a uniform 720-radial uint8 grid."""
    mb = moment.encode() if isinstance(moment, str) else moment
    sweep = vol["file"].sweeps[sweep_idx]
    rays = []
    for r in sweep:
        md = _moments_of(r)
        key = mb if mb in md else (mb + b" " if (mb + b" ") in md else None)
        if key:
            rays.append((r[0].az_angle, md[key]))
    if not rays:
        raise ValueError(f"{moment} not present in sweep")

    hdr = rays[0][1][0]
    first_m = float(hdr.first_gate) * 1000.0     # MetPy reports km
    spacing_m = float(hdr.gate_width) * 1000.0
    ngates = max(len(np.asarray(d[1]).ravel()) for _, d in rays)
    lo, hi = RANGES[moment]

    # Quantize every radial once, then GATHER: each of the 720 output rows
    # takes its nearest radial by azimuth (wraparound-aware). Scatter-by-
    # rounding leaves collision gaps (black spokes); gathering cannot.
    rays.sort(key=lambda t: t[0] % 360.0)
    az_arr = np.array([a % 360.0 for a, _ in rays])
    nrays = len(rays)
    Q = np.zeros((nrays, ngates), dtype=np.uint8)
    vmin, vmax = np.inf, -np.inf
    for k, (az, (mh, data)) in enumerate(rays):
        vals = np.ma.filled(np.ma.masked_invalid(
            np.ma.asarray(data, dtype=np.float64)), np.nan).ravel()
        finite = vals[np.isfinite(vals)]
        if finite.size:
            vmin = min(vmin, float(finite.min()))
            vmax = max(vmax, float(finite.max()))
        q = np.clip((vals - lo) / (hi - lo), 0.0, 1.0) * 253.0 + 2.0
        q = np.where(np.isfinite(vals), q, 0.0).astype(np.uint8)
        Q[k, :len(q)] = q
    targets = np.arange(720) * 0.5 + 0.25
    pos = np.searchsorted(az_arr, targets)
    left = (pos - 1) % nrays
    right = pos % nrays
    dl = np.abs(targets - az_arr[left]);  dl = np.minimum(dl, 360.0 - dl)
    dr = np.abs(targets - az_arr[right]); dr = np.minimum(dr, 360.0 - dr)
    grid = Q[np.where(dl <= dr, left, right)]
    pct = round(100.0 * float(np.count_nonzero(grid)) / grid.size, 1)

    return {"rows": 720, "ngates": ngates, "first_m": first_m,
            "spacing_m": spacing_m, "lo": lo, "hi": hi, "moment": moment,
            "radar_lat": vol["lat"], "radar_lon": vol["lon"],
            "pct_echo": pct,
            "vmin": None if not np.isfinite(vmin) else round(vmin, 1),
            "vmax": None if not np.isfinite(vmax) else round(vmax, 1),
            "grid": grid.tobytes()}


# ---------------------------------------------------------------- store
class L2Store:
    def __init__(self, site_coords=None):
        self._lock = threading.Lock()
        self._raw = OrderedDict()      # vol id -> bytes           (max 8)
        self._parsed = OrderedDict()   # vol id -> parsed volume   (max 3)
        self._sweeps = OrderedDict()   # (id, idx, moment) -> dict (max 24)
        self._site_coords = site_coords or {}
        self.status = "idle"

    def _set_status(self, s):
        self.status = s
        state.set_worker_status("level2", s)

    def _lru(self, od, key, maxlen, build):
        if key in od:
            od.move_to_end(key)
            return od[key]
        val = build()
        od[key] = val
        while len(od) > maxlen:
            od.popitem(last=False)
        return val

    def _get_parsed(self, site, vol_ref):
        vid = vol_ref["id"]
        def fetch_raw():
            self._set_status(f"downloading {vid.rsplit('/', 1)[-1]}")
            r = requests.get(vol_ref["url"], headers=UA, timeout=90)
            r.raise_for_status()
            return r.content
        raw = self._lru(self._raw, vid, 8, fetch_raw)
        def parse():
            self._set_status(f"decoding {len(raw)//1024} KB")
            coords = self._site_coords.get(site, (None, None))
            v = parse_volume(raw, fallback_latlon=coords)
            self._set_status("ok")
            return v
        return self._lru(self._parsed, vid, 3, parse)

    def index(self, site):
        with self._lock:
            vols = list_recent_volumes(site)
            latest = self._get_parsed(site, vols[-1])
            return {"volumes": vols,
                    "radar_lat": latest["lat"], "radar_lon": latest["lon"],
                    "tilts": [{"angle": t["angle"],
                               "moments": sorted(t["moments"])}
                              for t in latest["tilts"]]}

    def sweep(self, site, vol_id, vol_url, angle, moment):
        with self._lock:
            vol = self._get_parsed(site, {"id": vol_id, "url": vol_url})
            tilt = min(vol["tilts"], key=lambda t: abs(t["angle"] - angle))
            if moment not in tilt["moments"]:
                available = next((t for t in vol["tilts"]
                                  if moment in t["moments"]
                                  and abs(t["angle"] - angle) < 0.3), None)
                if available is None:
                    raise ValueError(f"{moment} not at {angle}° in this volume")
                tilt = available
            key = (vol_id, tilt["moments"][moment], moment)
            sw = self._lru(self._sweeps, key, 24,
                           lambda: build_sweep(vol, tilt["moments"][moment], moment))
            sw = dict(sw)
            sw["angle"] = tilt["angle"]
            m = re.search(r"(\d{8})_(\d{4})", vol_id)
            sw["time"] = (datetime.strptime(m.group(1) + m.group(2),
                          "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
                          .isoformat()) if m else None
            return sw

    def debug(self, site):
        with self._lock:
            vols = list_recent_volumes(site)
            latest = self._get_parsed(site, vols[-1])
            return {"volume": vols[-1]["id"],
                    "tilts": latest["tilts"],
                    "lat": latest["lat"], "lon": latest["lon"]}


# ---------------------------------------------------------------------------
# Binary artifact format (plan §2.3.A): "RDR1" magic, uint32-LE header length,
# UTF-8 JSON header, raw uint8 polar grid (rows × ngates). Gzip via middleware.
# ---------------------------------------------------------------------------
import json as _json
import struct as _struct

MAGIC = b"RDR1"


def pack_artifact(sweep: dict) -> bytes:
    grid = sweep.pop("grid")
    header = _json.dumps(sweep).encode()
    return MAGIC + _struct.pack("<I", len(header)) + header + grid


def unpack_artifact(buf: bytes) -> tuple[dict, bytes]:
    """Reference decoder (mirrors the client) — used by tests."""
    assert buf[:4] == MAGIC, "bad magic"
    (hlen,) = _struct.unpack_from("<I", buf, 4)
    header = _json.loads(buf[8:8 + hlen])
    return header, buf[8 + hlen:]
