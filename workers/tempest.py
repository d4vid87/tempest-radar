"""WeatherFlow Tempest worker (plain threads, no Qt)."""

import json
import threading
import time

import requests
import websocket

import state

REST_BASE = "https://swd.weatherflow.com/swd/rest"
WS_URL = "wss://ws.weatherflow.com/swd/data?token={token}"

OBS = {
    "epoch": 0, "wind_lull": 1, "wind_avg": 2, "wind_gust": 3, "wind_dir": 4,
    "pressure_mb": 6, "temp_c": 7, "rh": 8, "lux": 9, "uv": 10, "solar": 11,
    "rain_mm": 12, "precip_type": 13, "strike_dist_km": 14, "strike_count": 15,
    "battery_v": 16,
}


def fetch_station_meta(station_id: int, token: str) -> dict:
    r = requests.get(f"{REST_BASE}/stations/{station_id}",
                     params={"token": token}, timeout=15)
    r.raise_for_status()
    st = r.json()["stations"][0]
    device_id = None
    for dev in st.get("devices", []):
        if dev.get("device_type") == "ST":
            device_id = dev["device_id"]
            break
    if device_id is None and st.get("devices"):
        device_id = st["devices"][-1]["device_id"]
    return {
        "name": st.get("public_name") or st.get("name") or f"Station {station_id}",
        "lat": st.get("latitude"), "lon": st.get("longitude"),
        "device_id": device_id,
    }


def seed_observation(station_id: int, token: str):
    """Populate state with the latest REST observation at startup."""
    try:
        r = requests.get(f"{REST_BASE}/observations/station/{station_id}",
                         params={"token": token}, timeout=15)
        r.raise_for_status()
        obs = (r.json().get("obs") or [None])[0]
        if not obs:
            return
        state.update("obs", {
            "epoch": obs.get("timestamp"),
            "temp_c": obs.get("air_temperature"),
            "rh": obs.get("relative_humidity"),
            "wind_avg": obs.get("wind_avg"),
            "wind_gust": obs.get("wind_gust"),
            "wind_dir": obs.get("wind_direction"),
            "pressure_mb": obs.get("sea_level_pressure") or obs.get("station_pressure"),
            "uv": obs.get("uv"),
            "solar": obs.get("solar_radiation"),
            "rain_mm": obs.get("precip_accum_local_day", 0),
            "strike_count": obs.get("lightning_strike_count_last_3hr", 0),
            "strike_dist_km": obs.get("lightning_strike_last_distance"),
            "feels_c": obs.get("feels_like"),
        })
        state.update("wind_now", {
            "speed_ms": obs.get("wind_avg"),
            "dir": obs.get("wind_direction"),
            "epoch": obs.get("timestamp"),
        })
    except Exception as e:  # noqa: BLE001
        print(f"[tempest] seed failed: {e!r}")


class TempestWorker(threading.Thread):
    daemon = True

    def __init__(self, token: str, device_id: int):
        super().__init__(name="tempest")
        self.token, self.device_id = token, device_id
        self._stop = threading.Event()
        self._ws = None
        self._pressure_hist = []

    def stop(self):
        self._stop.set()
        if self._ws:
            try:
                self._ws.close()
            except Exception:  # noqa: BLE001
                pass

    def _on_open(self, ws):
        state.set_worker_status("tempest", "live")
        ws.send(json.dumps({"type": "listen_start", "device_id": self.device_id, "id": "o"}))
        ws.send(json.dumps({"type": "listen_rapid_start", "device_id": self.device_id, "id": "w"}))

    def _on_message(self, ws, message):
        try:
            msg = json.loads(message)
        except json.JSONDecodeError:
            return
        t = msg.get("type")
        if t == "obs_st" and msg.get("obs"):
            row = msg["obs"][0]
            parsed = {k: (row[i] if i < len(row) else None) for k, i in OBS.items()}
            # keep a small pressure history for the sparkline (~4 h)
            if parsed.get("pressure_mb") is not None:
                self._pressure_hist.append(parsed["pressure_mb"])
                self._pressure_hist = self._pressure_hist[-240:]
            parsed["pressure_hist"] = list(self._pressure_hist)
            state.update("obs", parsed)
        elif t == "rapid_wind" and msg.get("ob"):
            epoch, speed, direction = msg["ob"][:3]
            state.update("wind_now", {"speed_ms": speed, "dir": direction, "epoch": epoch})
        elif t == "evt_strike" and msg.get("evt"):
            state.update("last_strike",
                         {"dist_km": msg["evt"][1], "epoch": msg["evt"][0]})

    def run(self):
        backoff = 2
        while not self._stop.is_set():
            try:
                state.set_worker_status("tempest", "connecting")
                self._ws = websocket.WebSocketApp(
                    WS_URL.format(token=self.token),
                    on_open=self._on_open,
                    on_message=self._on_message,
                    on_error=lambda w, e: state.set_worker_status("tempest", f"error: {e}"),
                    on_close=lambda w, *a: state.set_worker_status("tempest", "disconnected"),
                )
                self._ws.run_forever(ping_interval=30, ping_timeout=10)
                backoff = 2
            except Exception as e:  # noqa: BLE001
                state.set_worker_status("tempest", f"error: {e}")
            if self._stop.wait(backoff):
                break
            backoff = min(backoff * 2, 60)
