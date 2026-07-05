"""NWS active-alerts poller (plain threads)."""

import threading

import requests

import state

NWS_URL = "https://api.weather.gov/alerts/active"
HEADERS = {"User-Agent": "(tempest-radar web; personal use)",
           "Accept": "application/geo+json"}
SEVERITY_RANK = {"Extreme": 0, "Severe": 1, "Moderate": 2, "Minor": 3, "Unknown": 4}


def _simplify(f):
    p = f.get("properties", {})
    return {
        "id": f.get("id", ""),
        "event": p.get("event", "Alert"),
        "severity": p.get("severity", "Unknown"),
        "headline": p.get("headline") or p.get("event", ""),
        "description": (p.get("description") or "")[:2000],
        "instruction": (p.get("instruction") or "")[:1000],
        "expires": p.get("expires", ""),
        "message_type": p.get("messageType", ""),
        "geometry": f.get("geometry"),
    }


class AlertsWorker(threading.Thread):
    daemon = True

    def __init__(self, lat, lon, poll_s=60):
        super().__init__(name="alerts")
        self.lat, self.lon, self.poll_s = lat, lon, poll_s
        self._stop = threading.Event()

    def stop(self):
        self._stop.set()

    def run(self):
        while not self._stop.is_set():
            try:
                r = requests.get(NWS_URL, params={"point": f"{self.lat},{self.lon}"},
                                 headers=HEADERS, timeout=15)
                r.raise_for_status()
                alerts = sorted((_simplify(f) for f in r.json().get("features", [])),
                                key=lambda a: SEVERITY_RANK.get(a["severity"], 4))
                state.update("alerts", alerts)
                state.set_worker_status("alerts", f"ok, {len(alerts)} active")
            except Exception as e:  # noqa: BLE001
                state.set_worker_status("alerts", f"error: {e}")
            if self._stop.wait(self.poll_s):
                return
