"""Configuration for the containerized Tempest Radar web app.

Precedence: environment variables > /data/config.json > defaults.
The /data directory is a docker volume, so config and custom themes persist.
"""

import json
import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
CONFIG_PATH = DATA_DIR / "config.json"
THEMES_PATH = DATA_DIR / "themes.json"

DEFAULTS = {
    "token": "",
    "station_id": None,          # set via the in-app settings menu
    "station_label": "",      # display name; station's real name is never shown
    "show_station_marker": True,
    "location": None,
    "tide_station": "",         # {lat, lon, label} override for alerts/map center
    "radar_site": "KFWS",
    "radar_product": "N0B",
    "frame_count": 10,
    "radar_poll_s": 120,
    "alerts_poll_s": 60,
    "news_poll_s": 300,
    "news_feeds": [
        # edit freely (RSS or Atom); overridable in /data/config.json
        {"name": "Drudge", "url": "https://feeds.feedburner.com/DrudgeReportFeed"},
        {"name": "NBC DFW", "url": "https://www.nbcdfw.com/news/feed"},
        {"name": "FOX 4", "url": "https://www.fox4news.com/rss/category/news"},
    ],
    "wx_feeds": [
        {"name": "SPC Watch", "url": "https://www.spc.noaa.gov/products/spcwwrss.xml"},
        {"name": "SPC Meso", "url": "https://www.spc.noaa.gov/products/spcmdrss.xml"},
        {"name": "NHC Atlantic", "url": "https://www.nhc.noaa.gov/index-at.xml"},
    ],
}

_ENV_MAP = {
    "TEMPEST_TOKEN": ("token", str),
    "STATION_ID": ("station_id", int),
    "RADAR_SITE": ("radar_site", str),
    "RADAR_PRODUCT": ("radar_product", str),
    "FRAME_COUNT": ("frame_count", int),
}


def load() -> dict:
    cfg = dict(DEFAULTS)
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text()))
        except (json.JSONDecodeError, OSError) as e:
            print(f"[config] ignoring bad {CONFIG_PATH}: {e}")
    for env, (key, cast) in _ENV_MAP.items():
        val = os.environ.get(env)
        if val:
            try:
                cfg[key] = cast(val)
            except ValueError:
                print(f"[config] bad {env}={val!r}, ignoring")
    return cfg


def load_custom_themes() -> list:
    """User-defined themes from /data/themes.json (re-read on every request,
    so edits appear on the next browser poll — no restart needed)."""
    if not THEMES_PATH.exists():
        return []
    try:
        themes = json.loads(THEMES_PATH.read_text())
        return themes if isinstance(themes, list) else []
    except (json.JSONDecodeError, OSError) as e:
        print(f"[config] ignoring bad {THEMES_PATH}: {e}")
        return []


def save_settings(updates: dict) -> None:
    """Merge updates into /data/config.json (creates it if needed)."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    current = {}
    if CONFIG_PATH.exists():
        try:
            current = json.loads(CONFIG_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            current = {}
    current.update(updates)
    CONFIG_PATH.write_text(json.dumps(current, indent=2))
    try:
        os.chmod(CONFIG_PATH, 0o600)
    except OSError:
        pass
