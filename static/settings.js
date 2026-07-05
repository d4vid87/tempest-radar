"use strict";
/* In-app settings: station credentials, privacy label, address-based location,
   ticker feeds. Auto-opens on first run when nothing is configured. */

let geoPick = undefined;   // undefined = unchanged, null = cleared, {}=picked

function feedsToText(feeds) {
  return (feeds || []).map(f => `${f.name} | ${f.url}`).join("\n");
}
function textToFeeds(text) {
  return text.split("\n").map(l => l.trim()).filter(Boolean).map(l => {
    const [name, ...rest] = l.split("|");
    return { name: (rest.length ? name : "feed").trim(),
             url: (rest.length ? rest.join("|") : name).trim() };
  }).filter(f => /^https?:\/\//.test(f.url));
}

async function openSettings() {
  const s = await (await fetch("/api/settings")).json();
  $("set-station").value = s.station_id ?? "";
  $("set-token").value = "";
  $("set-token").placeholder = s.has_token
    ? "leave blank to keep current token" : "paste your WeatherFlow token";
  $("set-label").value = s.station_label || "";
  $("set-marker").checked = s.show_station_marker !== false;
  $("set-tide").value = s.tide_station || "";
  $("set-news").value = feedsToText(s.news_feeds);
  $("set-wx").value = feedsToText(s.wx_feeds);
  geoPick = undefined;
  $("geo-results").innerHTML = "";
  $("geo-current").textContent = s.location
    ? `current: ${s.location.label || `${s.location.lat}, ${s.location.lon}`}  `
    : "current: using the station's own coordinates";
  if (s.location) {
    const clr = document.createElement("button");
    clr.textContent = "clear";
    clr.onclick = () => { geoPick = null;
      $("geo-current").textContent = "will use the station's own coordinates"; };
    $("geo-current").appendChild(clr);
  }
  $("set-status").textContent = s.configured ? "" :
    "First run: enter your station ID and token to connect.";
  $("settings-modal").hidden = false;
}

async function geocode() {
  const q = $("set-address").value.trim();
  if (q.length < 3) return;
  $("geo-results").innerHTML = "<div class='set-hint'>searching…</div>";
  try {
    const res = await (await fetch(`/api/geocode?q=${encodeURIComponent(q)}`)).json();
    if (res.error || !res.length) {
      $("geo-results").innerHTML = "<div class='set-hint'>no results</div>";
      return;
    }
    $("geo-results").innerHTML = "";
    res.forEach(r => {
      const b = document.createElement("button");
      b.className = "geo-hit";
      b.textContent = r.label;
      b.onclick = () => {
        geoPick = { lat: r.lat, lon: r.lon, label: r.label };
        $("geo-current").textContent = "selected: " + r.label;
        $("geo-results").innerHTML = "";
      };
      $("geo-results").appendChild(b);
    });
  } catch (e) {
    $("geo-results").innerHTML = `<div class='set-hint'>geocode failed: ${e.message}</div>`;
  }
}

async function saveSettings() {
  const body = {
    station_label: $("set-label").value,
    show_station_marker: $("set-marker").checked,
    tide_station: $("set-tide").value.trim(),
    news_feeds: textToFeeds($("set-news").value),
    wx_feeds: textToFeeds($("set-wx").value),
  };
  const sid = $("set-station").value.trim();
  if (sid) body.station_id = +sid;
  const tok = $("set-token").value.trim();
  if (tok) body.token = tok;
  if (geoPick !== undefined) body.location = geoPick;
  $("set-status").textContent = "saving…";
  try {
    const r = await (await fetch("/api/settings", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body) })).json();
    $("set-status").textContent = r.message || r.error || "saved";
    if (r.ok) setTimeout(() => { $("settings-modal").hidden = true; }, 1200);
  } catch (e) {
    $("set-status").textContent = "save failed: " + e.message;
  }
}

$("settings-btn").onclick = openSettings;
$("settings-close").onclick = () => { $("settings-modal").hidden = true; };
$("settings-modal").addEventListener("click", e => {
  if (e.target === $("settings-modal")) $("settings-modal").hidden = true; });
$("set-geocode").onclick = geocode;
$("set-address").addEventListener("keydown", e => { if (e.key === "Enter") geocode(); });
$("settings-save").onclick = saveSettings;

// first-run: open settings automatically if the app isn't configured
fetch("/api/settings").then(r => r.json()).then(s => {
  if (!s.configured) openSettings();
}).catch(() => {});
