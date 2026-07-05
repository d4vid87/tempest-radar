"""Thread-safe shared state. Workers write, the API endpoint reads."""

import threading
import time

_lock = threading.Lock()
_state = {
    "station": {},        # name, lat, lon
    "obs": {},            # last full observation (converted units done client-side)
    "wind_now": {},       # {speed_ms, dir, epoch} from rapid_wind (~3 s)
    "last_strike": {},    # {dist_km, epoch}
    "alerts": [],         # simplified NWS alerts
    "radar": {},          # {site, product, frames, mode, updated}
    "news": [],           # [{title, link, source, epoch}]
    "wx_news": [],        # severe-weather bulletins for the second ticker
    "workers": {},        # {name: status string}
    "started": time.time(),
}


def update(key, value):
    with _lock:
        _state[key] = value


def set_worker_status(name, status):
    with _lock:
        _state["workers"][name] = status


def snapshot() -> dict:
    with _lock:
        # shallow copy is enough; workers replace values wholesale
        snap = dict(_state)
        snap["workers"] = dict(_state["workers"])
        return snap
