"""IEM radar frame discovery — supercell-wx-inspired edition.

Adds to the proven strategy chain (scan list → accumulate → latest-only):
  - live reconfiguration: switch radar site or product without a restart
  - product discovery: asks IEM which products the current site serves
  - deeper loops: keeps up to MAX_FRAMES scans (client picks how many to show)
"""

import math
import re
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

import requests

import state

BASE = "https://mesonet.agron.iastate.edu"
LIST_URLS = (f"{BASE}/json/radar.py", f"{BASE}/json/radar")
MAX_FRAMES = 50
SITE_RE = re.compile(r"^[A-Z]{3,4}$")
PROD_RE = re.compile(r"^[A-Z0-9]{2,4}$")


def _normalize_ts(raw):
    digits = re.sub(r"\D", "", str(raw))
    return digits[:12] if len(digits) >= 12 else None


def _tile_xy(lat, lon, z):
    x = int((lon + 180) / 360 * 2 ** z)
    y = int((1 - math.log(math.tan(math.radians(lat)) +
                          1 / math.cos(math.radians(lat))) / math.pi) / 2 * 2 ** z)
    return x, y


class RadarWorker(threading.Thread):
    daemon = True

    def __init__(self, site, product="N0B", poll_s=120, lat=32.6, lon=-97.3):
        super().__init__(name="radar")
        self._lock = threading.Lock()
        self.site, self.product = site, product
        self.poll_s = poll_s
        self.lat, self.lon = lat, lon
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._seen = deque(maxlen=MAX_FRAMES)
        self._products_cache = {}   # site -> [product codes]

    def stop(self):
        self._stop.set()
        self._wake.set()

    def reconfigure(self, site=None, product=None, lat=None, lon=None):
        """Switch radar site and/or product; takes effect immediately."""
        with self._lock:
            if site and SITE_RE.match(site):
                if site != self.site:
                    self._seen.clear()
                self.site = site
            if product and PROD_RE.match(product):
                if product != self.product:
                    self._seen.clear()
                self.product = product
            if lat is not None:
                self.lat = lat
            if lon is not None:
                self.lon = lon
        state.set_worker_status("radar", f"switching to {self.site} {self.product}…")
        self._wake.set()

    def _cfg(self):
        with self._lock:
            return self.site, self.product, self.lat, self.lon

    # -- strategies ----------------------------------------------------------
    def _try_list(self, radar_id, product):
        end = datetime.now(timezone.utc)
        start = end - timedelta(hours=3)
        for url in LIST_URLS:
            try:
                r = requests.get(url, params={
                    "operation": "list", "radar": radar_id, "product": product,
                    "start": start.strftime("%Y-%m-%dT%H:%MZ"),
                    "end": end.strftime("%Y-%m-%dT%H:%MZ")}, timeout=12)
                r.raise_for_status()
                stamps = sorted(filter(None, (
                    _normalize_ts(s.get("ts", "")) for s in r.json().get("scans", []))))
                return stamps[-MAX_FRAMES:]
            except Exception:  # noqa: BLE001
                continue
        return []

    def _discover_products(self, site):
        if site in self._products_cache:
            return self._products_cache[site]
        codes = []
        for rid in {site, site[1:] if len(site) == 4 else site}:
            try:
                r = requests.get(LIST_URLS[0], params={
                    "operation": "available", "radar": rid,
                    "start": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")},
                    timeout=12)
                r.raise_for_status()
                for p in r.json().get("products", []):
                    code = p.get("id") or p.get("product") or p.get("code")
                    if code and str(code) not in codes:
                        codes.append(str(code))
                if codes:
                    break
            except Exception:  # noqa: BLE001
                continue
        self._products_cache[site] = codes
        return codes

    def _scan_list_strategy(self, site, product):
        radar_ids = [site] + ([site[1:]] if len(site) == 4 else [])
        products = [product] + (["N0Q"] if product != "N0Q" else [])
        for rid in radar_ids:
            for prod in products:
                stamps = self._try_list(rid, prod)
                if stamps:
                    return stamps, prod
        for prod in self._discover_products(site):
            if prod in products:
                continue
            stamps = self._try_list(site, prod)
            if stamps:
                return stamps, prod
        return None

    def _latest_ts_via_metadata(self, site, product):
        candidates = [f"{BASE}/data/gis/images/4326/ridge/{site}/{product}_0.json"]
        if len(site) == 4:
            candidates.append(
                f"{BASE}/data/gis/images/4326/ridge/{site[1:]}/{product}_0.json")
        for url in candidates:
            try:
                r = requests.get(url, timeout=10)
                if r.ok:
                    m = re.search(r"\d{4}-?\d{2}-?\d{2}[T ]?\d{2}:?\d{2}", r.text)
                    if m:
                        ts = _normalize_ts(m.group(0))
                        if ts:
                            return ts
            except Exception:  # noqa: BLE001
                continue
        return None

    def _latest_ts_via_tile_header(self, site, product, lat, lon):
        x, y = _tile_xy(lat, lon, 8)
        try:
            r = requests.get(
                f"{BASE}/cache/tile.py/1.0.0/ridge::{site}-{product}-0"
                f"/8/{x}/{y}.png", timeout=12)
            lm = r.headers.get("last-modified")
            if r.ok and lm:
                return parsedate_to_datetime(lm).astimezone(timezone.utc)\
                       .strftime("%Y%m%d%H%M")
        except Exception:  # noqa: BLE001
            pass
        return None

    def _tile_exists(self, site, product, ts, lat, lon):
        x, y = _tile_xy(lat, lon, 8)
        try:
            r = requests.get(
                f"{BASE}/cache/tile.py/1.0.0/ridge::{site}-{product}-{ts}"
                f"/8/{x}/{y}.png", timeout=12)
            return r.ok and "image" in r.headers.get("content-type", "") \
                and len(r.content) > 200
        except Exception:  # noqa: BLE001
            return False

    def _publish(self, site, product, frames, mode):
        state.update("radar", {
            "site": site, "product": product, "frames": frames, "mode": mode,
            "products": self._products_cache.get(site, []),
            "updated": time.time()})
        n = len([f for f in frames if f != "0"])
        state.set_worker_status("radar", f"{site} {product}: {mode}, "
                                         f"{n or 'live'} frame(s)")

    # -- thread body -----------------------------------------------------------
    def run(self):
        # publish the configured site right away so the UI selects it
        # (and centers/tiles on it) even before the first frames arrive
        site, product, _, _ = self._cfg()
        self._publish(site, product, [], "starting")
        while not self._stop.is_set():
            site, product, lat, lon = self._cfg()
            try:
                self._discover_products(site)   # populate the product dropdown
                result = self._scan_list_strategy(site, product)
                # a reconfigure may have landed mid-fetch; if so, restart loop
                if (site, product) != (self._cfg()[0], self._cfg()[1]):
                    continue
                if result:
                    stamps, prod = result
                    with self._lock:
                        if prod != self.product:
                            self.product = prod
                    self._publish(site, prod, stamps, "scan list")
                else:
                    ts = (self._latest_ts_via_metadata(site, product)
                          or self._latest_ts_via_tile_header(site, product, lat, lon))
                    if ts and ts not in self._seen \
                            and self._tile_exists(site, product, ts, lat, lon):
                        self._seen.append(ts)
                    if self._seen:
                        self._publish(site, product, sorted(self._seen), "accumulating")
                    else:
                        self._publish(site, product, ["0"], "latest only")
            except Exception as e:  # noqa: BLE001
                print(f"[radar] {e!r}")
                state.set_worker_status("radar", f"error: {e}")
            self._wake.wait(self.poll_s)
            self._wake.clear()
