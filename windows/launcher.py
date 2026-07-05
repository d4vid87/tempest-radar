"""Windows tray launcher for Tempest Radar.

Runs the FastAPI app with uvicorn in a background thread, opens the browser,
and sits in the system tray (pystray). Data (config, radar cache, icons)
lives in %LOCALAPPDATA%\\TempestRadar.
"""

import os
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

PORT = int(os.environ.get("PORT", "5555"))
URL = f"http://localhost:{PORT}/"

# Data dir must be set before app modules import config.
if "DATA_DIR" not in os.environ:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / ".tempest-radar")
    os.environ["DATA_DIR"] = str(Path(base) / "TempestRadar")
Path(os.environ["DATA_DIR"]).mkdir(parents=True, exist_ok=True)

# Make the bundled app importable both frozen and from a source checkout.
BASE = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(BASE))


def _open_browser():
    if not os.environ.get("TEMPEST_NO_BROWSER"):
        webbrowser.open(URL)


def _healthy() -> bool:
    try:
        urllib.request.urlopen(f"http://localhost:{PORT}/healthz", timeout=1)
        return True
    except Exception:
        return False


def main():
    if _healthy():  # already running — just open the console
        _open_browser()
        return

    import uvicorn
    from app import app  # noqa: deferred so DATA_DIR is set first

    server = uvicorn.Server(uvicorn.Config(
        app, host="0.0.0.0", port=PORT, log_level="warning"))
    t = threading.Thread(target=server.run, daemon=True)
    t.start()

    for _ in range(120):
        if _healthy():
            break
        time.sleep(0.5)
    _open_browser()

    try:
        import pystray
        from PIL import Image, ImageDraw
    except Exception:
        # No tray available (e.g. headless smoke test) — just block.
        try:
            while t.is_alive():
                time.sleep(3600)
        except KeyboardInterrupt:
            server.should_exit = True
        return

    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((4, 4, 60, 60), outline=(0, 230, 118, 255), width=4)
    d.ellipse((18, 18, 46, 46), outline=(0, 230, 118, 180), width=3)
    d.line((32, 32, 54, 12), fill=(0, 230, 118, 255), width=4)
    d.ellipse((29, 29, 35, 35), fill=(0, 230, 118, 255))

    def quit_app(icon, item):
        server.should_exit = True
        icon.stop()

    icon = pystray.Icon("TempestRadar", img, "Tempest Radar", menu=pystray.Menu(
        pystray.MenuItem("Open console", lambda: webbrowser.open(URL), default=True),
        pystray.MenuItem("Open wall", lambda: webbrowser.open(URL + "wall")),
        pystray.MenuItem("Open data folder",
                         lambda: os.startfile(os.environ["DATA_DIR"])  # noqa
                         if hasattr(os, "startfile") else None),
        pystray.MenuItem("Quit", quit_app),
    ))
    try:
        icon.run()
    except Exception:
        # Tray unavailable (no interactive desktop) — keep serving.
        try:
            while t.is_alive():
                time.sleep(3600)
        except KeyboardInterrupt:
            server.should_exit = True


if __name__ == "__main__":
    main()
