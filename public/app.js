'use strict';
/* global L */
(function () {
  var REFRESH_MS = 45000;
  var PLANE_PATH = 'M21,16v-2l-8-5V3.5C13,2.67,12.33,2,11.5,2S10,2.67,10,3.5V9l-8,5v2l8-2.5V19l-2,1.5V22l3.5-1l3.5,1v-1.5L13,19v-5.5L21,16z';

  var CONTINENTS = {
    world: [[-85, -180], [85, 180]],
    africa: [[-35, -20], [38, 52]],
    europe: [[34, -12], [72, 45]],
    asia: [[-2, 25], [78, 180]],
    mideast: [[12, 25], [45, 63]],
    namerica: [[13, -170], [73, -52]],
    samerica: [[-57, -82], [14, -34]],
    oceania: [[-48, 108], [2, 180]]
  };

  var state = {
    payload: null,
    map: null,
    cluster: null,
    markers: new Map(),
    selected: null,
    routeLayer: null,
    fitted: false,
    nextAt: 0,
    nextTimer: null,
    trails: new Map(),
    trailLayers: new Map(),
    lastSample: new Map(),
    showTrails: true,
    follow: false,
    lastFrame: 0,
    allRoutesLayer: null,
    selTrailLayer: null,
    countryLayer: null,
    countryIndex: {},
    mode: 'live',
    playing: false,
    playTimer: null,
    histDate: null,
    histMin: 0,
    view: 'both',
    schedule: null,
    tileErrors: 0,
    offlineBasemap: false
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtInt(n) { return n == null ? '—' : Number(n).toLocaleString('en-US'); }
  function fmtAlt(f) { return f.altitudeFt != null ? fmtInt(f.altitudeFt) + ' ft' : '—'; }
  function fmtSpd(f) { return f.speedKn != null ? fmtInt(f.speedKn) + ' kn' : '—'; }
  function fmtVr(f) { return f.verticalRateFpm != null ? (f.verticalRateFpm > 0 ? '+' : '') + fmtInt(f.verticalRateFpm) + ' fpm' : '—'; }
  function fmtHdg(f) { return f.track != null ? Math.round(f.track) + '°' : '—'; }
  function relTime(sec) {
    if (!sec) return '—';
    var d = Math.floor(Date.now() / 1000) - sec;
    if (d < 0) return 'just now';
    if (d < 60) return d + 's ago';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    return Math.floor(d / 3600) + 'h ago';
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function fmtHM(min) { return pad2(Math.floor(min / 60)) + ':' + pad2(min % 60) + ' UTC'; }
  function histEpoch() {
    return Math.floor(Date.parse(state.histDate + 'T00:00:00Z') / 1000) + state.histMin * 60;
  }

  function planeIcon(f) {
    var rot = f.track != null ? f.track : 0;
    return L.divIcon({
      className: 'plane-wrap',
      html: '<div class="plane' + (f.onGround ? ' ground' : '') + '" style="transform:rotate(' + rot + 'deg)">' +
        '<svg viewBox="0 0 24 24" width="28" height="28"><path d="' + PLANE_PATH + '"/></svg></div>',
      iconSize: [34, 34],
      iconAnchor: [17, 17],
      popupAnchor: [0, -16]
    });
  }

  function airportLabel(ap, code) {
    if (ap && ap.lat != null) return esc(ap.name) + ' (' + esc(code) + ')';
    return esc(code || '—');
  }
  function routeText(f) {
    if (!f.departure && !f.arrival) return '—';
    return esc(f.departure || '?') + ' → ' + esc(f.arrival || '?');
  }

  function popupHtml(f) {
    function row(k, v) { return '<tr><td>' + k + '</td><td>' + v + '</td></tr>'; }
    return '<div class="popup">' +
      '<div class="popup-head"><span class="cs">' + esc(f.callsign) + '</span><span class="tag">Emirates</span></div>' +
      '<div class="popup-route">' + airportLabel(f.departureAirport, f.departure) + ' → ' + airportLabel(f.arrivalAirport, f.arrival) + '</div>' +
      '<table class="popup-table">' +
      row('Position', f.lat != null ? f.lat.toFixed(4) + ', ' + f.lon.toFixed(4) : '—') +
      row('Altitude', fmtAlt(f)) +
      row('Ground speed', fmtSpd(f)) +
      row('Vertical rate', fmtVr(f)) +
      row('Heading', fmtHdg(f)) +
      row('Status', f.onGround ? 'On ground' : 'Airborne') +
      row('Last contact', relTime(f.lastContact)) +
      (f.squawk ? row('Squawk', esc(f.squawk)) : '') +
      row('ICAO24', esc(f.icao24)) +
      '</table>' +
      '<button class="route-btn" data-icao="' + esc(f.icao24) + '">Show route on map</button>' +
      '</div>';
  }

  function toRad(d) { return d * Math.PI / 180; }
  function toDeg(r) { return r * 180 / Math.PI; }
  function greatCircle(a, b, n) {
    var p1 = toRad(a.lat), l1 = toRad(a.lon), p2 = toRad(b.lat), l2 = toRad(b.lon);
    var d = 2 * Math.asin(Math.sqrt(
      Math.sin((p2 - p1) / 2) * Math.sin((p2 - p1) / 2) +
      Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) * Math.sin((l2 - l1) / 2)
    ));
    var pts = [];
    if (!d) return [[a.lat, a.lon]];
    for (var i = 0; i <= n; i++) {
      var f = i / n;
      var A = Math.sin((1 - f) * d) / Math.sin(d);
      var B = Math.sin(f * d) / Math.sin(d);
      var x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
      var y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
      var z = A * Math.sin(p1) + B * Math.sin(p2);
      pts.push([toDeg(Math.atan2(z, Math.hypot(x, y))), toDeg(Math.atan2(y, x))]);
    }
    return pts;
  }

  // Dead-reckoning: move a latlng `distM` meters along `bearingDeg`.
  function destinationPoint(ll, distM, bearingDeg) {
    var R = 6371000, d = distM / R, th = bearingDeg * Math.PI / 180;
    var p1 = ll.lat * Math.PI / 180, l1 = ll.lng * Math.PI / 180;
    var p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(th));
    var l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return L.latLng(p2 * 180 / Math.PI, ((l2 * 180 / Math.PI) + 540) % 360 - 180);
  }

  function pushTrail(icao, ll, now) {
    if (!state.showTrails) return;
    var last = state.lastSample.get(icao) || 0;
    if (now - last < 1000) return;
    state.lastSample.set(icao, now);
    var t = state.trails.get(icao) || [];
    var prev = t[t.length - 1];
    if (!prev || prev.distanceTo(ll) > 30) t.push(ll);
    if (t.length > 120) t = t.slice(t.length - 120);
    state.trails.set(icao, t);
    if (t.length >= 2) {
      var pl = state.trailLayers.get(icao);
      if (!pl) {
        pl = L.polyline(t, { color: '#d4af37', weight: 2, opacity: 0.55 });
        pl.addTo(state.map);
        state.trailLayers.set(icao, pl);
      } else pl.setLatLngs(t);
    }
  }

  function dropTrail(icao) {
    var pl = state.trailLayers.get(icao);
    if (pl) { state.map.removeLayer(pl); state.trailLayers.delete(icao); }
    state.trails.delete(icao);
    state.lastSample.delete(icao);
  }

  function setTrailsEnabled(on) {
    state.showTrails = on;
    if (!on) {
      state.trailLayers.forEach(function (pl) { state.map.removeLayer(pl); });
      state.trailLayers.clear();
      state.lastSample.clear();
    }
  }

  // Continuous live movement: every frame, glide each airborne plane along its
  // heading/speed from its current displayed position. Poll results correct
  // the position in apply(), so movement stays accurate.
  function animateLoop() {
    var now = performance.now();
    var dt = state.lastFrame ? (now - state.lastFrame) / 1000 : 0;
    state.lastFrame = now;
    state.markers.forEach(function (m, icao) {
      var f = m.flightData;
      if (!f || f.lat == null || f.onGround || !f.speedMs || f.track == null) return;
      m.setLatLng(destinationPoint(m.getLatLng(), f.speedMs * dt, f.track));
      m.setIcon(planeIcon(f));
      pushTrail(icao, m.getLatLng(), now);
      if (state.follow && state.selected === icao) state.map.panTo(m.getLatLng(), { animate: false });
    });
    requestAnimationFrame(animateLoop);
  }

  function drawRoute(f) {
    if (state.routeLayer) { state.map.removeLayer(state.routeLayer); state.routeLayer = null; }
    var dep = f.departureAirport, arr = f.arrivalAirport;
    if (!dep || !arr || dep.lat == null || arr.lat == null) return;
    var g = L.layerGroup();
    L.polyline(greatCircle({ lat: dep.lat, lon: dep.lon }, { lat: arr.lat, lon: arr.lon }, 80), {
      color: '#d4af37', weight: 2.5, dashArray: '6 8', opacity: 0.9
    }).addTo(g);
    [[dep, f.departure], [arr, f.arrival]].forEach(function (pair) {
      var ap = pair[0], code = pair[1];
      L.circleMarker([ap.lat, ap.lon], { radius: 6, color: '#d4af37', weight: 2, fillColor: '#d4af37', fillOpacity: 0.9 })
        .addTo(g)
        .bindTooltip(esc(ap.name) + ' (' + esc(code) + ')', { direction: 'top' });
    });
    g.addTo(state.map);
    state.routeLayer = g;
  }

  function drawAllRoutes() {
    if (state.allRoutesLayer) { state.map.removeLayer(state.allRoutesLayer); state.allRoutesLayer = null; }
    if (state.view === 'markers' || !state.payload) return;
    var g = L.layerGroup();
    state.payload.flights.forEach(function (f) {
      var dep = f.departureAirport, arr = f.arrivalAirport;
      if (!dep || !arr || dep.lat == null || arr.lat == null) return;
      var selected = state.selected === f.icao24;
      var line = L.polyline(greatCircle({ lat: dep.lat, lon: dep.lon }, { lat: arr.lat, lon: arr.lon }, 64), {
        color: selected ? '#d71920' : 'rgba(212,175,55,0.45)',
        weight: selected ? 3 : 1.4,
        dashArray: selected ? null : '4 7',
        opacity: 0.9,
        interactive: state.view === 'lines'
      });
      if (state.view === 'lines') {
        line.on('click', function () { select(f.icao24, false); });
        line.bindTooltip(esc(f.callsign) + ' · ' + routeText(f), { direction: 'top', sticky: true });
      }
      line.addTo(g);
      if (f.lat != null && f.lon != null) {
        L.circleMarker([f.lat, f.lon], {
          radius: selected ? 6 : 3.5,
          color: selected ? '#fff' : '#d4af37',
          fillColor: selected ? '#d71920' : '#d4af37',
          fillOpacity: 0.95, weight: 1.5,
          interactive: state.view === 'lines'
        }).on('click', function () { select(f.icao24, false); }).addTo(g);
      }
    });
    g.addTo(state.map);
    state.allRoutesLayer = g;
  }

  async function drawSelTrail(icao24) {
    if (state.selTrailLayer) { state.map.removeLayer(state.selTrailLayer); state.selTrailLayer = null; }
    var t = state.mode === 'live' ? Math.floor(Date.now() / 1000) : histEpoch();
    try {
      var r = await fetch('/api/track?icao24=' + encodeURIComponent(icao24) + '&time=' + t, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var data = await r.json();
      if (!data.path || data.path.length < 2) return;
      var g = L.layerGroup();
      L.polyline(data.path.map(function (p) { return [p[1], p[2]]; }), { color: '#d71920', weight: 3, opacity: 0.95 }).addTo(g);
      var first = data.path[0], last = data.path[data.path.length - 1];
      L.circleMarker([first[1], first[2]], { radius: 5, color: '#238636', fillColor: '#238636', fillOpacity: 1 }).addTo(g);
      L.circleMarker([last[1], last[2]], { radius: 5, color: '#d71920', fillColor: '#d71920', fillOpacity: 1 }).addTo(g);
      g.addTo(state.map);
      state.selTrailLayer = g;
    } catch (e) { /* track unavailable — route line stays */ }
  }

  function stopPlay() {
    state.playing = false;
    var pb = $('play-btn');
    if (pb) pb.textContent = '▶';
    if (state.playTimer) { clearInterval(state.playTimer); state.playTimer = null; }
  }

  function setMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode;
    stopPlay();
    $('mode-live').classList.toggle('active', mode === 'live');
    $('mode-hist').classList.toggle('active', mode === 'historical');
    $('hist-panel').classList.toggle('hidden', mode !== 'historical');
    clearTimeout(state.nextTimer);
    tick();
    drawChart();
  }

  async function loadSchedule(dateStr) {
    try {
      var r = await fetch('/api/schedule?date=' + encodeURIComponent(dateStr), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      state.schedule = await r.json();
    } catch (e) {
      state.schedule = null;
    }
    drawChart();
  }

  function drawChart() {
    var cv = $('chart');
    if (!cv || !state.map) return;
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth || 600, h = cv.clientHeight || 64;
    cv.width = w * dpr; cv.height = h * dpr;
    var ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    if (!state.schedule || !state.schedule.flights || !state.histDate) return;
    var padL = 34, padR = 10, padT = 6, padB = 15;
    var iw = w - padL - padR, ih = h - padT - padB;
    var buckets = new Array(48).fill(0);
    var dayStart = Date.parse(state.histDate + 'T00:00:00Z') / 1000;
    state.schedule.flights.forEach(function (f) {
      for (var b = 0; b < 48; b++) {
        var bs = dayStart + b * 1800, be = bs + 1800;
        if (f.depSec < be && f.arrSec > bs) buckets[b]++;
      }
    });
    var max = Math.max(1, Math.max.apply(null, buckets));
    ctx.strokeStyle = '#30363d';
    ctx.fillStyle = '#8b949e';
    ctx.font = '9px ui-monospace, monospace';
    ctx.lineWidth = 1;
    for (var hh = 0; hh <= 24; hh += 6) {
      var x = padL + iw * hh / 24;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ih); ctx.stroke();
      ctx.fillText(pad2(hh) + ':00', x - 9, h - 4);
    }
    ctx.beginPath();
    buckets.forEach(function (c, i) {
      var bx = padL + iw * (i + 0.5) / 48;
      var by = padT + ih - (c / max) * ih;
      if (i === 0) ctx.moveTo(bx, by); else ctx.lineTo(bx, by);
    });
    ctx.strokeStyle = '#d4af37';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.lineTo(padL + iw, padT + ih);
    ctx.lineTo(padL, padT + ih);
    ctx.closePath();
    ctx.fillStyle = 'rgba(212,175,55,0.16)';
    ctx.fill();
    var curMin = state.mode === 'historical'
      ? state.histMin
      : (Math.floor(Date.now() / 1000) - dayStart) / 60;
    if (curMin >= 0 && curMin <= 1440) {
      var cx = padL + iw * curMin / 1440;
      ctx.strokeStyle = '#d71920';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, padT + ih); ctx.stroke();
    }
  }

  function map_fitCountry(feature) {
    var layer = L.geoJSON(feature);
    state.map.fitBounds(layer.getBounds(), { padding: [28, 28] });
  }

  function loadCountries() {
    fetch('/vendor/countries.geo.json').then(function (r) { return r.json(); }).then(function (gj) {
      state.countryLayer = L.geoJSON(gj, {
        style: { color: 'rgba(110,140,190,0.4)', weight: 0.8, fillColor: '#182236', fillOpacity: 0.3 },
        onEachFeature: function (feature, layer) {
          var name = feature.properties.name;
          state.countryIndex[name] = feature;
          layer.on('click', function () {
            layer.setStyle({ fillColor: '#d4af37', fillOpacity: 0.18 });
            setTimeout(function () { layer.setStyle({ fillColor: '#182236', fillOpacity: 0.3 }); }, 900);
            map_fitCountry(feature);
          });
        }
      });
      state.map.addLayer(state.countryLayer);
      var dl = $('countries-list');
      gj.features.forEach(function (f) {
        var opt = document.createElement('option');
        opt.value = f.properties.name;
        dl.appendChild(opt);
      });
    }).catch(function () { /* country overlay optional */ });
  }

  function onTileError() {
    state.tileErrors++;
    if (state.tileErrors > 10 && !state.offlineBasemap) {
      state.offlineBasemap = true;
      state.map.eachLayer(function (l) {
        if (l instanceof L.TileLayer) state.map.removeLayer(l);
      });
      var note = $('badge-note');
      if (note && state.mode === 'live' && (!state.payload || state.payload.source === 'live')) {
        note.textContent = 'tiles unreachable — vector basemap';
      }
    }
  }

  function select(icao, fly) {
    var flights = state.payload ? state.payload.flights : [];
    var f = null;
    for (var i = 0; i < flights.length; i++) if (flights[i].icao24 === icao) { f = flights[i]; break; }
    if (!f) return;
    state.selected = icao;
    var rows = document.querySelectorAll('.fl-item');
    for (var j = 0; j < rows.length; j++) rows[j].classList.toggle('active', rows[j].dataset.icao === icao);
    var m = state.markers.get(icao);
    if (f.lat != null && f.lon != null) {
      if (fly !== false) state.map.flyTo([f.lat, f.lon], Math.max(state.map.getZoom(), 7), { duration: 0.5 });
      if (m && state.view !== 'lines') m.openPopup();
      drawRoute(f);
      drawSelTrail(icao);
    }
    drawAllRoutes();
    var row = document.querySelector('.fl-item[data-icao="' + icao + '"]');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  function setBadge(p) {
    var b = $('badge');
    var map = {
      live: [p.historical ? 'HISTORY' : 'LIVE', p.historical ? 'b-hist' : 'b-live'],
      cached: ['CACHED', 'b-cached'],
      demo: [p.historical ? 'HISTORY·DEMO' : 'DEMO DATA', p.historical ? 'b-hist' : 'b-demo']
    };
    var pair = map[p.source] || ['OFFLINE', 'b-off'];
    b.textContent = pair[0];
    b.className = 'badge ' + pair[1];
    var note = $('badge-note');
    if (p.note) note.textContent = p.note;
    else if (p.source === 'cached' && p.dataAgeSec != null) note.textContent = 'rate-limited · data ' + p.dataAgeSec + 's old';
    else if (p.retryAfterSec) note.textContent = 'rate limited, retry in ' + p.retryAfterSec + 's';
    else if (p.source === 'demo') note.textContent = 'simulated data (set DEMO=0 for live)';
    else note.textContent = '';
  }

  function apply(p) {
    state.payload = p;
    setBadge(p);
    $('stat-count').textContent = p.airborne != null ? p.airborne : p.count;
    $('stat-total').textContent = p.count;
    var asOf = p.serverTime || Math.floor((p.updatedAt || Date.now()) / 1000);
    $('stat-updated').textContent = (p.historical ? 'as of ' : 'updated ') +
      new Date(asOf * 1000).toISOString().slice(0, 10) + ' ' + fmtHM((asOf % 86400) / 60 | 0);

    var useCluster = state.view !== 'lines';
    if (useCluster && !state.map.hasLayer(state.cluster)) state.map.addLayer(state.cluster);
    if (!useCluster && state.map.hasLayer(state.cluster)) state.map.removeLayer(state.cluster);

    var seen = new Set();
    p.flights.forEach(function (f) {
      seen.add(f.icao24);
      var hasPos = f.lat != null && f.lon != null;
      var m = state.markers.get(f.icao24);
      if (hasPos && useCluster) {
        if (!m) {
          m = L.marker([f.lat, f.lon], { icon: planeIcon(f), title: f.callsign });
          m.on('click', function () { select(f.icao24); });
          m.bindPopup(function () { return popupHtml(m.flightData); }, { maxWidth: 290 });
          state.cluster.addLayer(m);
          state.markers.set(f.icao24, m);
        } else {
          m.setLatLng([f.lat, f.lon]);
          m.setIcon(planeIcon(f));
        }
        m.flightData = f;
        if (m.isPopupOpen()) m.setPopupContent(popupHtml(f));
      } else if (m) {
        state.cluster.removeLayer(m);
        state.markers.delete(f.icao24);
      }
    });
    state.markers.forEach(function (m, icao) {
      if (!seen.has(icao)) { state.cluster.removeLayer(m); state.markers.delete(icao); dropTrail(icao); }
    });

    drawAllRoutes();
    renderList();
    if (!state.fitted && p.flights.some(function (f) { return f.lat != null; })) {
      fitAll();
      state.fitted = true;
    }
  }

  function renderList() {
    var q = ($('search').value || '').trim().toLowerCase();
    var list = $('flight-list');
    list.innerHTML = '';
    var flights = (state.payload ? state.payload.flights : []).slice()
      .sort(function (a, b) { return a.callsign.localeCompare(b.callsign); });
    var shown = 0;
    flights.forEach(function (f) {
      var hay = (f.callsign + ' ' + (f.departure || '') + ' ' + (f.arrival || '') + ' ' +
        (f.departureAirport ? f.departureAirport.name : '') + ' ' +
        (f.arrivalAirport ? f.arrivalAirport.name : '')).toLowerCase();
      if (q && hay.indexOf(q) === -1) return;
      shown++;
      var div = document.createElement('div');
      div.className = 'fl-item' + (state.selected === f.icao24 ? ' active' : '');
      div.dataset.icao = f.icao24;
      div.innerHTML =
        '<div class="fl-top"><span class="fl-cs">' + esc(f.callsign) + '</span><span class="fl-alt">' + fmtAlt(f) + '</span></div>' +
        '<div class="fl-route">' + routeText(f) + '</div>' +
        '<div class="fl-meta">' + fmtSpd(f) + (f.onGround ? ' · on ground' : '') + '</div>';
      div.addEventListener('click', function () { select(f.icao24); });
      list.appendChild(div);
    });
    $('stat-shown').textContent = shown;
  }

  function fitAll() {
    var pts = [];
    state.markers.forEach(function (m) { pts.push(m.getLatLng()); });
    if (state.payload) {
      state.payload.flights.forEach(function (f) { if (f.lat != null) pts.push([f.lat, f.lon]); });
    }
    if (!pts.length) { state.map.setView([24, 45], 3); return; }
    state.map.fitBounds(L.latLngBounds(pts).pad(0.12), { maxZoom: 6 });
  }

  async function tick() {
    try {
      var url = state.mode === 'live' ? '/api/flights' : '/api/flights?time=' + histEpoch();
      var r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      apply(await r.json());
    } catch (e) {
      var b = $('badge');
      b.textContent = 'OFFLINE';
      b.className = 'badge b-off';
    }
    clearTimeout(state.nextTimer);
    if (state.mode === 'live') {
      state.nextAt = Date.now() + REFRESH_MS;
      state.nextTimer = setTimeout(tick, REFRESH_MS);
    }
  }

  function init() {
    var now = new Date();
    state.histDate = todayStr();
    state.histMin = now.getUTCHours() * 60 + now.getUTCMinutes();

    var vectorOnly = L.layerGroup();
    var std = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    });
    var dark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      subdomains: 'abcd',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>'
    });
    std.on('tileerror', onTileError);
    dark.on('tileerror', onTileError);
    state.map = L.map('map', {
      center: [24, 45],
      zoom: 3,
      minZoom: 2,
      maxZoom: 19,
      zoomControl: true,
      scrollWheelZoom: true,
      doubleClickZoom: true,
      worldCopyJump: true,
      layers: [std]
    });
    L.control.layers({ 'Standard': std, 'Dark': dark, 'Vector only (offline)': vectorOnly }, {}, { position: 'topright' }).addTo(state.map);
    state.cluster = L.markerClusterGroup({
      maxClusterRadius: 55,
      disableClusteringAtZoom: 9,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false
    });
    state.map.addLayer(state.cluster);

    var FitControl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function () {
        var c = L.DomUtil.create('div', 'leaflet-bar');
        c.innerHTML = '<a href="#" class="fit-btn" title="Fit all Emirates aircraft">⤢</a>';
        L.DomEvent.disableClickPropagation(c);
        L.DomEvent.on(c, 'click', function (e) { e.preventDefault(); fitAll(); });
        return c;
      }
    });
    state.map.addControl(new FitControl());

    state.map.on('popupopen', function (e) {
      var el = e.popup.getElement();
      var btn = el && el.querySelector('.route-btn');
      if (btn) btn.addEventListener('click', function () {
        var m = state.markers.get(btn.dataset.icao);
        if (m && m.flightData) { drawRoute(m.flightData); drawSelTrail(btn.dataset.icao); }
      });
    });

    $('search').addEventListener('input', renderList);
    $('refresh-btn').addEventListener('click', tick);
    $('trails').addEventListener('change', function (e) { setTrailsEnabled(e.target.checked); });
    $('follow').addEventListener('change', function (e) { state.follow = e.target.checked; });
    requestAnimationFrame(animateLoop);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) clearTimeout(state.nextTimer);
      else if (state.mode === 'live') tick();
    });
    setInterval(function () {
      var el = $('stat-next');
      if (state.nextAt && state.mode === 'live') el.textContent = 'refresh in ' + Math.max(0, Math.ceil((state.nextAt - Date.now()) / 1000)) + 's';
      else el.textContent = '';
    }, 1000);

    $('mode-live').addEventListener('click', function () { setMode('live'); });
    $('mode-hist').addEventListener('click', function () { setMode('historical'); });

    var dateInput = $('hist-date');
    dateInput.value = state.histDate;
    dateInput.max = todayStr();
    dateInput.addEventListener('change', function () {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput.value)) return;
      state.histDate = dateInput.value;
      loadSchedule(state.histDate);
      tick();
    });

    var slider = $('time-slider');
    slider.value = state.histMin;
    $('hist-time').textContent = fmtHM(state.histMin);
    var sliderTimer = null;
    slider.addEventListener('input', function () {
      state.histMin = parseInt(slider.value, 10);
      $('hist-time').textContent = fmtHM(state.histMin);
      drawChart();
      if (sliderTimer) clearTimeout(sliderTimer);
      sliderTimer = setTimeout(function () { if (state.mode === 'historical') tick(); }, 250);
    });

    $('play-btn').addEventListener('click', function () {
      if (state.playing) { stopPlay(); return; }
      if (state.mode !== 'historical') setMode('historical');
      state.playing = true;
      $('play-btn').textContent = '⏸';
      state.playTimer = setInterval(function () {
        state.histMin = (state.histMin + 10) % 1440;
        slider.value = state.histMin;
        $('hist-time').textContent = fmtHM(state.histMin);
        drawChart();
        tick();
      }, 450);
    });

    $('continent').addEventListener('change', function (e) {
      var b = CONTINENTS[e.target.value];
      if (b) state.map.fitBounds(b, { padding: [16, 16] });
    });

    $('country-search').addEventListener('change', function (e) {
      var f = state.countryIndex[e.target.value];
      if (f) map_fitCountry(f);
    });

    $('view-format').addEventListener('change', function (e) {
      state.view = e.target.value;
      apply(state.payload || { flights: [] });
    });

    $('chart').addEventListener('click', function (e) {
      var cv = e.target;
      var rect = cv.getBoundingClientRect();
      var padL = 34, padR = 10;
      var frac = (e.clientX - rect.left - padL) / Math.max(1, rect.width - padL - padR);
      var min = Math.max(0, Math.min(1439, Math.round(frac * 1440)));
      if (state.mode !== 'historical') setMode('historical');
      state.histMin = min;
      slider.value = min;
      $('hist-time').textContent = fmtHM(min);
      drawChart();
      tick();
    });

    window.addEventListener('resize', drawChart);

    loadCountries();
    loadSchedule(state.histDate);
    tick();
  }

  init();
})();
