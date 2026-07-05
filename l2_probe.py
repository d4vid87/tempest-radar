#!/usr/bin/env python3
"""Probe both Level 2 discovery sources. Run anywhere: python3 l2_probe.py KFWS"""
import re, sys, urllib.request
from datetime import datetime, timedelta, timezone
site = (sys.argv[1] if len(sys.argv) > 1 else "KFWS").upper()
day = datetime.now(timezone.utc)

def get(url):
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            return r.status, r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")[:300]
    except Exception as e:
        return None, repr(e)

print("== S3 ==")
s, body = get(f"https://noaa-nexrad-level2.s3.amazonaws.com/?list-type=2"
              f"&prefix={day:%Y/%m/%d}/{site}/&max-keys=5")
print("status:", s, "| keys:", len(re.findall(r"<Key>", body or "")) if s == 200 else body[:200])

print("== THREDDS ==")
for cat in (f"https://thredds.ucar.edu/thredds/catalog/nexrad/level2/{site}/{day:%Y%m%d}/catalog.xml",
            f"https://thredds.ucar.edu/thredds/catalog/nexrad/level2/{day:%Y%m%d}/{site}/catalog.xml"):
    s, body = get(cat)
    paths = re.findall(r'urlPath="([^"]+)"', body or "") if s == 200 else []
    print(f"status {s}  paths {len(paths)}  {cat}")
    if paths:
        print("  newest:", sorted(paths)[-1])
        break
