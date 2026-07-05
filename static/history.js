"use strict";
/* Station history: click any card title to open a modal with charts and
   stats from the Tempest's observation archive. */

const METRICS = {
  temp:     { label: "Temperature", unit: "°F",  series: ["temp_c"],    conv: cToF },
  humidity: { label: "Humidity",    unit: "%",   series: ["rh"],        conv: v => v },
  wind:     { label: "Wind / Gust", unit: "mph", series: ["wind_avg", "wind_gust"], conv: msToMph },
  pressure: { label: "Pressure",    unit: "inHg",series: ["pressure_mb"], conv: mbToInHg, digits: 2 },
  rain:     { label: "Rainfall",    unit: "in",  series: ["rain_mm"],   conv: mmToIn, digits: 2, sum: true },
  uv:       { label: "UV Index",    unit: "",    series: ["uv"],        conv: v => v },
  solar:    { label: "Solar",       unit: "W/m²",series: ["solar"],     conv: v => v },
  strikes:  { label: "Lightning",   unit: "strikes", series: ["strikes"], conv: v => v, sum: true },
};
const CARD_METRIC = { "card-station": "temp", "card-wind": "wind",
  "card-pressure": "pressure", "card-rainsun": "rain", "card-lightning": "strikes" };

let histData = {}, histHours = 24, histMetric = "temp";

async function openHistory(metric) {
  histMetric = metric;
  $("hist-modal").hidden = false;
  renderHistTabs();
  await loadHistory();
}

async function loadHistory() {
  $("hist-stats").textContent = "loading…";
  if (!histData[histHours]) {
    try {
      const r = await fetch(`/api/history?hours=${histHours}`);
      const j = await r.json();
      if (j.error) { $("hist-stats").textContent = j.error; return; }
      histData[histHours] = j;
    } catch (e) { $("hist-stats").textContent = "history unavailable: " + e.message; return; }
  }
  drawHistory();
}

function renderHistTabs() {
  $("hist-tabs").innerHTML = Object.entries(METRICS).map(([k, m]) =>
    `<button class="hist-tab${k === histMetric ? " on" : ""}" data-m="${k}">${m.label}</button>`).join("");
  $("hist-tabs").querySelectorAll("button").forEach(b =>
    b.onclick = () => { histMetric = b.dataset.m; renderHistTabs(); drawHistory(); });
  document.querySelectorAll(".hist-period").forEach(b => {
    b.classList.toggle("on", +b.dataset.h === histHours);
    b.onclick = async () => { histHours = +b.dataset.h; renderHistTabs(); await loadHistory(); };
  });
}

function drawHistory() {
  const d = histData[histHours];
  if (!d) return;
  const m = METRICS[histMetric];
  const seriesList = m.series.map(key => (d[key] || []).map(v => v == null ? null : m.conv(v)));
  const primary = seriesList[0].filter(v => v != null);
  const dg = m.digits ?? 1;
  if (primary.length) {
    const cur = primary.at(-1), lo = Math.min(...primary), hi = Math.max(...primary);
    const agg = m.sum ? `total ${primary.reduce((a, b) => a + b, 0).toFixed(dg)}`
      : `avg ${(primary.reduce((a, b) => a + b, 0) / primary.length).toFixed(dg)}`;
    $("hist-stats").innerHTML =
      `<b>${m.label}</b> — last ${histHours}h &nbsp;·&nbsp; now ${cur.toFixed(dg)}${m.unit}` +
      ` &nbsp;·&nbsp; min ${lo.toFixed(dg)} · max ${hi.toFixed(dg)} · ${agg} ${m.unit}`;
  } else $("hist-stats").textContent = "no data in range";
  chart($("hist-canvas"), d.epochs, seriesList, m, dg);
}

function chart(cv, epochs, seriesList, m, dg) {
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height, L = 46, R = 10, T = 10, B = 22;
  ctx.clearRect(0, 0, W, H);
  const all = seriesList.flat().filter(v => v != null);
  if (all.length < 2) return;
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi - lo < 0.01) { hi += 0.5; lo -= 0.5; }
  const x = i => L + i * (W - L - R) / (epochs.length - 1);
  const y = v => T + (hi - v) / (hi - lo) * (H - T - B);

  ctx.strokeStyle = cssVar("--border"); ctx.fillStyle = cssVar("--muted");
  ctx.font = "10px sans-serif"; ctx.lineWidth = 1;
  [lo, (lo + hi) / 2, hi].forEach(v => {
    ctx.beginPath(); ctx.moveTo(L, y(v)); ctx.lineTo(W - R, y(v)); ctx.stroke();
    ctx.textAlign = "right"; ctx.fillText(v.toFixed(dg), L - 4, y(v) + 3);
  });
  [0, Math.floor(epochs.length / 2), epochs.length - 1].forEach(i => {
    const t = new Date(epochs[i] * 1000);
    ctx.textAlign = i === 0 ? "left" : i === epochs.length - 1 ? "right" : "center";
    ctx.fillText(t.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }),
                 x(i), H - 6);
  });

  const colors = [cssVar("--accent"), cssVar("--warn")];
  seriesList.forEach((vals, si) => {
    ctx.strokeStyle = colors[si] || cssVar("--good");
    ctx.lineWidth = si === 0 ? 2 : 1.4;
    ctx.beginPath();
    let started = false;
    vals.forEach((v, i) => {
      if (v == null) { started = false; return; }
      started ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v));
      started = true;
    });
    ctx.stroke();
  });

  cv.onmousemove = e => {
    const rect = cv.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (W / rect.width);
    const i = Math.round((px - L) / (W - L - R) * (epochs.length - 1));
    if (i < 0 || i >= epochs.length) return;
    const v = seriesList[0][i];
    $("hist-hover").textContent = v == null ? "" :
      `${new Date(epochs[i] * 1000).toLocaleString([], { weekday: "short",
        hour: "numeric", minute: "2-digit" })} — ${v.toFixed(dg)} ${m.unit}` +
      (seriesList[1] && seriesList[1][i] != null
        ? ` (gust ${seriesList[1][i].toFixed(dg)})` : "");
  };
  cv.onmouseleave = () => $("hist-hover").textContent = "";
}

$("hist-close").onclick = () => { $("hist-modal").hidden = true; };
$("hist-modal").addEventListener("click", e => {
  if (e.target === $("hist-modal")) $("hist-modal").hidden = true; });
document.addEventListener("keydown", e => {
  if (e.key === "Escape") $("hist-modal").hidden = true; });

document.querySelectorAll(".card .drag-handle").forEach(h => {
  h.addEventListener("click", () => {
    if (window.uiEditMode) return;
    const metric = CARD_METRIC[h.closest(".card").id];
    if (metric) openHistory(metric);
  });
});
