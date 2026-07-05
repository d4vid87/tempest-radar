"""Breaking news worker.

Fetches a configurable list of RSS/Atom feeds (weather-first defaults: SPC
mesoscale discussions, SPC watches, NHC tropical, plus one general world feed)
and publishes a merged, newest-first headline list. Parsing uses stdlib
ElementTree — headlines and links only, no article content.
"""

import threading
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import requests

import state

HEADERS = {"User-Agent": "(tempest-radar web; personal use)"}
ATOM = "{http://www.w3.org/2005/Atom}"
MAX_ITEMS = 30


def _parse_date(text):
    if not text:
        return 0
    text = text.strip()
    try:  # RFC 822 (RSS)
        return parsedate_to_datetime(text).timestamp()
    except (TypeError, ValueError):
        pass
    try:  # ISO 8601 (Atom)
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0


def _parse_feed(xml_text, source):
    items = []
    root = ET.fromstring(xml_text)
    # RSS 2.0
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        epoch = _parse_date(item.findtext("pubDate"))
        if title:
            items.append({"title": title, "link": link,
                          "source": source, "epoch": epoch})
    # Atom
    for entry in root.iter(f"{ATOM}entry"):
        title = (entry.findtext(f"{ATOM}title") or "").strip()
        link_el = entry.find(f"{ATOM}link")
        link = link_el.get("href", "") if link_el is not None else ""
        epoch = _parse_date(entry.findtext(f"{ATOM}updated")
                            or entry.findtext(f"{ATOM}published"))
        if title:
            items.append({"title": title, "link": link,
                          "source": source, "epoch": epoch})
    return items


class NewsWorker(threading.Thread):
    daemon = True

    def __init__(self, feeds, poll_s=300, state_key="news"):
        super().__init__(name=state_key)
        self.feeds = feeds
        self.poll_s = poll_s
        self.state_key = state_key
        self._stop = threading.Event()

    def stop(self):
        self._stop.set()

    def run(self):
        while not self._stop.is_set():
            merged, errors = [], 0
            for feed in self.feeds:
                try:
                    r = requests.get(feed["url"], headers=HEADERS, timeout=15)
                    r.raise_for_status()
                    merged.extend(_parse_feed(r.text, feed.get("name", "feed")))
                except Exception as e:  # noqa: BLE001
                    errors += 1
                    print(f"[news] {feed.get('name')}: {e!r}")
            merged.sort(key=lambda i: i["epoch"], reverse=True)
            state.update(self.state_key, merged[:MAX_ITEMS])
            status = f"ok, {len(merged[:MAX_ITEMS])} headlines"
            if errors:
                status += f" ({errors} feed(s) failing)"
            state.set_worker_status(self.state_key, status)
            if self._stop.wait(self.poll_s):
                return
