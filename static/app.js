const CONTINENTS = {
  world: [[-85, -180], [85, 180]],
  africa: [[-35, -20], [38, 52]],
  europe: [[34, -12], [72, 45]],
  asia: [[-2, 25], [78, 180]],
  mideast: [[12, 25], [45, 63]],
  namerica: [[13, -170], [73, -52]],
  samerica: [[-57, -82], [14, -34]],
  oceania: [[-48, 108], [2, 180]]
};

const state = {
  mode: "live",
  view: "both",
  basemap: "dark",
  payload: null,
  dayFlights: [],
  histDate: null,
  histMin: null,
  playing: false,
  selected: null,
  airports: {},
  countries: null,
  countryIndex: {}
};

const map = L.map("map", { zoomControl: false, worldCopyJump: true, minZoom: 2, maxZoom: 12 })
  .setView([24, 30], 3);
L.control.zoom({ position: "bottomright" }).addTo(map);

const tileLayers = {
  dark: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap &copy; CARTO", maxZoom: 19, subdomains: "abcd"
  }),
  osm: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors", maxZoom: 19
  })
};
let activeTile = null;
let tileErrors = 0;

function setBasemap(name) {
  state.basemap = name;
  if (activeTile) { map.removeLayer(activeTile); activeTile = null; }
  tileErrors = 0;
  if (tileLayers[name]) {
    activeTile = tileLayers[name].addTo(map);
    activeTile.on("tileerror", () => {
      tileErrors++;
      if (tileErrors > 8 && state.basemap !== "vector") {
        document.getElementById("basemap").value = "vector";
        setBasemap("vector");
        setBadge("tiles unavailable (offline?) — vector basemap", "sample");
      }
    });
  }
}

let countryLayer = null;
function loadCountries() {
  fetch("/static/vendor/countries.geo.json").then(r => r.json()).then(gj => {
    state.countries = gj;
    countryLayer = L.geoJSON(gj, {
      style: { color: "rgba(110,140,190,0.45)", weight: 0.8, fillColor: "#16233a", fillOpacity: 0.25 },
      onEachFeature: (feature, layer) => {
        const name = feature.properties.name;
        state.countryIndex[name] = feature;
        layer.on("click", () => {
          layer.setStyle({ fillColor: "#d4af37", fillOpacity: 0.15 });
          setTimeout(() => layer.setStyle({ fillColor: "#16233a", fillOpacity: 0.25 }), 900);
          map.fitBounds(layer.getBounds(), { padding: [24, 24] });
        });
      }
    }).addTo(map);
    const dl = document.getElementById("countries-list");
    gj.features.forEach(f => {
      const opt = document.createElement("option");
      opt.value = f.properties.name;
      dl.appendChild(opt);
    });
  }).catch(() => setBadge("countries data failed to load", "error"));
}

const flightsLayer = L.layerGroup().addTo(map);
const routesLayer = L.layerGroup().addTo(map);
const trailLayer = L.layerGroup().addTo(map);
const airportsLayer = L.layerGroup();

function setBadge(text, cls) {
  const b = document.getElementById("source-badge");
  b.textContent = text;
  b.className = "badge" + (cls ? " " + cls : "");
}

function fmtHM(epoch) {
  const d = new Date(epoch * 1000);
  return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0") + " UTC";
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function histEpoch() {
  const base = Date.parse(state.histDate + "T00:00:00Z") / 1000;
  return base + state.histMin * 60;
}

function slerp(a, b, t) {
  const toVec = ll => {
    const la = ll[0] * Math.PI / 180, lo = ll[1] * Math.PI / 180;
    return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  };
  const va = toVec(a), vb = toVec(b);
  let dot = va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2];
  dot = Math.max(-1, Math.min(1, dot));
  const om = Math.acos(dot);
  if (om < 1e-9) return a.slice();
  const so = Math.sin(om), ka = Math.sin((1 - t) * om) / so, kb = Math.sin(t * om) / so;
  const v = [ka * va[0] + kb * vb[0], ka * va[1] + kb * vb[1], ka * va[2] + kb * vb[2]];
  return [Math.atan2(v[2], Math.sqrt(v[0] * v[0] + v[1] * v[1])) * 180 / Math.PI, Math.atan2(v[1], v[0]) * 180 / Math.PI];
}

function greatCircle(a, b, n) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push(slerp(a, b, i / (n - 1)));
  return pts;
}

async function loadMeta() {
  const meta = await (await fetch("/api/meta")).json();
  meta.airports.forEach(a => { state.airports[a.iata] = a; });
}

async function loadDay(dateStr) {
  const d = await (await fetch("/api/flights/day?date=" + dateStr)).json();
  state.dayFlights = d.flights;
  drawChart();
}

async function fetchFlights() {
  let url = "/api/flights";
  if (state.mode === "historical") url += "?time=" + histEpoch();
  try {
    const p = await (await fetch(url)).json();
    state.payload = p;
    renderFlights();
    document.getElementById("updated").textContent =
      "updated " + fmtHM(p.time) + " · " + p.count + " airborne";
    setBadge(p.source === "opensky" ? "LIVE · OpenSky Network" : "SIMULATED SCHEDULE", p.source === "opensky" ? "" : "sample");
  } catch (e) {
    setBadge("connection error", "error");
  }
}

function planeIcon(f) {
  const cls = "plane" + (state.selected === f.callsign ? " selected" : "") + (f.on_ground ? " on-ground" : "");
  const rot = f.heading != null ? f.heading : 0;
  return L.divIcon({
    className: "",
    html: '<div class="' + cls + '" style="transform: rotate(' + rot + 'deg)">✈</div>',
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });
}

function renderFlights() {
  const p = state.payload;
  if (!p) return;
  flightsLayer.clearLayers();
  routesLayer.clearLayers();
  trailLayer.clearLayers();
  const showMarkers = state.view !== "lines";
  const showLines = state.view !== "markers";
  p.flights.forEach(f => {
    if (showMarkers && f.lat != null && f.lon != null) {
      const m = L.marker([f.lat, f.lon], { icon: planeIcon(f) });
      m.on("click", () => selectFlight(f));
      m.bindPopup("<b>" + f.flight + "</b> (" + f.callsign + ")<br>" +
        (f.origin && f.destination ? f.origin + " → " + f.destination + "<br>" : "") +
        (f.altitude_ft != null ? "Alt " + f.altitude_ft.toLocaleString() + " ft<br>" : "") +
        (f.speed_kmh != null ? "GS " + f.speed_kmh + " km/h" : ""));
      m.addTo(flightsLayer);
    }
    if (showLines && f.origin && f.destination && state.airports[f.origin] && state.airports[f.destination]) {
      const a = state.airports[f.origin], b = state.airports[f.destination];
      const pts = greatCircle([a.lat, a.lon], [b.lat, b.lon], 64);
      const selected = state.selected === f.callsign;
      L.polyline(pts, {
        color: selected ? "#d71920" : "rgba(212,175,55,0.55)",
        weight: selected ? 3 : 1.4,
        dashArray: selected ? null : "5 6",
        interactive: false
      }).addTo(routesLayer);
      L.circleMarker([a.lat, a.lon], { radius: 3, color: "#d4af37", fillOpacity: 0.9 }).addTo(routesLayer);
      L.circleMarker([b.lat, b.lon], { radius: 3, color: "#d4af37", fillOpacity: 0.9 }).addTo(routesLayer);
    }
  });
  if (state.selected) {
    const f = p.flights.find(x => x.callsign === state.selected);
    if (f) loadTrail(f);
  }
}

async function selectFlight(f) {
  state.selected = f.callsign;
  const body = document.getElementById("panel-body");
  document.getElementById("panel-title").textContent = f.flight + " · " + f.callsign;
  document.getElementById("panel").classList.remove("hidden");
  body.innerHTML = "<table>" +
    (f.origin && f.destination ? '<tr><td>Route</td><td class="route-line">' + f.origin + " → " + f.destination + "</td></tr>" : "") +
    (f.origin_name ? "<tr><td>From</td><td>" + f.origin_name + "</td></tr>" : "") +
    (f.dest_name ? "<tr><td>To</td><td>" + f.dest_name + "</td></tr>" : "") +
    "<tr><td>Position</td><td>" + (f.lat != null ? f.lat.toFixed(3) + ", " + f.lon.toFixed(3) : "n/a") + "</td></tr>" +
    "<tr><td>Altitude</td><td>" + (f.altitude_ft != null ? f.altitude_ft.toLocaleString() + " ft" : "n/a") + "</td></tr>" +
    "<tr><td>Speed</td><td>" + (f.speed_kmh != null ? f.speed_kmh + " km/h" : "n/a") + "</td></tr>" +
    "<tr><td>Heading</td><td>" + (f.heading != null ? f.heading + "°" : "n/a") + "</td></tr>" +
    "<tr><td>Status</td><td>" + (f.on_ground ? "on ground" : "airborne") + "</td></tr>" +
    (f.dep ? "<tr><td>Departed</td><td>" + fmtHM(f.dep) + "</td></tr>" : "") +
    (f.arr ? "<tr><td>Arrives</td><td>" + fmtHM(f.arr) + "</td></tr>" : "") +
    "<tr><td>Source</td><td>" + f.source + "</td></tr></table>";
  renderFlights();
  loadTrail(f);
}

async function loadTrail(f) {
  trailLayer.clearLayers();
  try {
    const t = await (await fetch("/api/track?callsign=" + encodeURIComponent(f.callsign) + "&date=" + state.histDate)).json();
    if (t.points && t.points.length > 1) {
      const pts = t.points.map(p => [p[0], p[1]]);
      L.polyline(pts, { color: "#d71920", weight: 2.5, opacity: 0.9 }).addTo(trailLayer);
      const cur = t.points.reduce((best, p) => {
        const now = state.mode === "historical" ? histEpoch() : Math.floor(Date.now() / 1000);
        return Math.abs(p[3] - now) < Math.abs(best[3] - now) ? p : best;
      });
      L.circleMarker([cur[0], cur[1]], { radius: 6, color: "#fff", fillColor: "#d71920", fillOpacity: 1 }).addTo(trailLayer);
    }
  } catch (e) { /* no track available */ }
}

function drawChart() {
  const cv = document.getElementById("chart");
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!state.dayFlights.length) return;
  const buckets = new Array(48).fill(0);
  const dayStart = Date.parse(state.histDate + "T00:00:00Z") / 1000;
  state.dayFlights.forEach(f => {
    for (let b = 0; b < 48; b++) {
      const bs = dayStart + b * 1800, be = bs + 1800;
      if (f.dep < be && f.arr > bs) buckets[b]++;
    }
  });
  const max = Math.max(1, ...buckets);
  const padL = 30, padR = 8, padT = 6, padB = 16;
  const iw = w - padL - padR, ih = h - padT - padB;
  ctx.strokeStyle = "#263149";
  ctx.fillStyle = "#8b98ad";
  ctx.font = "10px ui-monospace, monospace";
  for (let hh = 0; hh <= 24; hh += 6) {
    const x = padL + iw * hh / 24;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ih); ctx.stroke();
    ctx.fillText(String(hh).padStart(2, "0") + ":00", x - 10, h - 3);
  }
  ctx.beginPath();
  buckets.forEach((c, i) => {
    const x = padL + iw * (i + 0.5) / 48;
    const y = padT + ih - (c / max) * ih;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#d4af37";
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.lineTo(padL + iw, padT + ih);
  ctx.lineTo(padL, padT + ih);
  ctx.closePath();
  ctx.fillStyle = "rgba(212,175,55,0.18)";
  ctx.fill();
  const curMin = state.mode === "historical" ? state.histMin : (Date.now() / 1000 - dayStart) / 60;
  if (curMin >= 0 && curMin <= 1440) {
    const x = padL + iw * curMin / 1440;
    ctx.strokeStyle = "#d71920";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ih); ctx.stroke();
  }
}

function setMode(mode) {
  state.mode = mode;
  document.getElementById("mode-live").classList.toggle("active", mode === "live");
  document.getElementById("mode-hist").classList.toggle("active", mode === "historical");
  document.getElementById("hist-controls").classList.toggle("hidden", mode !== "historical");
  if (mode === "historical") {
    stopPlay();
    fetchFlights();
  } else {
    stopPlay();
    fetchFlights();
  }
  drawChart();
}

function stopPlay() {
  state.playing = false;
  document.getElementById("play").textContent = "▶";
  if (state.playTimer) { clearInterval(state.playTimer); state.playTimer = null; }
}

function initControls() {
  document.getElementById("mode-live").onclick = () => setMode("live");
  document.getElementById("mode-hist").onclick = () => setMode("historical");
  document.getElementById("refresh").onclick = () => fetchFlights();

  document.getElementById("continent").onchange = e => {
    const b = CONTINENTS[e.target.value];
    if (b) map.fitBounds(b, { padding: [16, 16] });
  };

  document.getElementById("country-search").onchange = e => {
    const f = state.countryIndex[e.target.value];
    if (f) {
      const layer = L.geoJSON(f);
      map.fitBounds(layer.getBounds(), { padding: [30, 30] });
    }
  };

  document.getElementById("view-format").onchange = e => {
    state.view = e.target.value;
    renderFlights();
  };

  document.getElementById("basemap").onchange = e => setBasemap(e.target.value);

  document.getElementById("show-airports").onchange = e => {
    if (e.target.checked) {
      Object.values(state.airports).forEach(a => {
        L.circleMarker([a.lat, a.lon], {
          radius: a.iata === "DXB" ? 6 : 3.5,
          color: a.iata === "DXB" ? "#d71920" : "#4da3ff",
          fillOpacity: 0.9, weight: 1
        }).bindTooltip(a.iata + " — " + a.city, { direction: "top" }).addTo(airportsLayer);
      });
      airportsLayer.addTo(map);
    } else {
      map.removeLayer(airportsLayer);
    }
  };

  const dateInput = document.getElementById("hist-date");
  dateInput.value = state.histDate;
  dateInput.onchange = () => {
    state.histDate = dateInput.value;
    loadDay(state.histDate);
    fetchFlights();
  };

  const slider = document.getElementById("time-slider");
  const timeLabel = document.getElementById("hist-time");
  const applySlider = () => {
    state.histMin = parseInt(slider.value, 10);
    timeLabel.textContent = String(Math.floor(state.histMin / 60)).padStart(2, "0") + ":" +
      String(state.histMin % 60).padStart(2, "0") + " UTC";
    drawChart();
  };
  let sliderTimer = null;
  slider.oninput = () => {
    applySlider();
    if (sliderTimer) clearTimeout(sliderTimer);
    sliderTimer = setTimeout(() => { if (state.mode === "historical") fetchFlights(); }, 200);
  };

  document.getElementById("play").onclick = () => {
    if (state.playing) { stopPlay(); return; }
    if (state.mode !== "historical") setMode("historical");
    state.playing = true;
    document.getElementById("play").textContent = "⏸";
    state.playTimer = setInterval(() => {
      state.histMin = (state.histMin + 10) % 1440;
      slider.value = state.histMin;
      applySlider();
      fetchFlights();
    }, 450);
  };

  document.getElementById("panel-close").onclick = () => {
    state.selected = null;
    document.getElementById("panel").classList.add("hidden");
    trailLayer.clearLayers();
    renderFlights();
  };

  document.getElementById("chart").onclick = e => {
    const cv = e.target;
    const rect = cv.getBoundingClientRect();
    const padL = 30, padR = 8;
    const frac = (e.clientX - rect.left - padL) / (rect.width - padL - padR);
    const min = Math.max(0, Math.min(1439, Math.round(frac * 1440)));
    if (state.mode !== "historical") setMode("historical");
    slider.value = min;
    applySlider();
    fetchFlights();
  };

  window.addEventListener("resize", drawChart);
}

async function init() {
  state.histDate = todayStr();
  const now = new Date();
  state.histMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  document.getElementById("time-slider").value = state.histMin;
  document.getElementById("hist-time").textContent =
    String(now.getUTCHours()).padStart(2, "0") + ":" + String(now.getUTCMinutes()).padStart(2, "0") + " UTC";

  setBasemap("dark");
  initControls();
  await loadMeta();
  await loadDay(state.histDate);
  await fetchFlights();
  loadCountries();
  setInterval(() => { if (state.mode === "live") fetchFlights(); }, 15000);
}

init();
