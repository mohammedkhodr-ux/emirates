'use strict';
/* global L */
(function () {
  var REFRESH_MS = 45000;
  var PLANE_PATH = 'M21,16v-2l-8-5V3.5C13,2.67,12.33,2,11.5,2S10,2.67,10,3.5V9l-8,5v2l8-2.5V19l-2,1.5V22l3.5-1l3.5,1v-1.5L13,19v-5.5L21,16z';

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
    lastFrame: 0
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
      if (m) m.openPopup();
      drawRoute(f);
    }
    var row = document.querySelector('.fl-item[data-icao="' + icao + '"]');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  function setBadge(p) {
    var b = $('badge');
    var map = { live: ['LIVE', 'b-live'], cached: ['CACHED', 'b-cached'], demo: ['DEMO DATA', 'b-demo'] };
    var pair = map[p.source] || ['OFFLINE', 'b-off'];
    b.textContent = pair[0];
    b.className = 'badge ' + pair[1];
    var note = $('badge-note');
    if (p.source === 'cached' && p.dataAgeSec != null) note.textContent = 'rate-limited · data ' + p.dataAgeSec + 's old';
    else if (p.retryAfterSec) note.textContent = 'rate limited, retry in ' + p.retryAfterSec + 's';
    else if (p.source === 'demo') note.textContent = 'simulated data (set DEMO=0 for live)';
    else note.textContent = '';
  }

  function apply(p) {
    state.payload = p;
    setBadge(p);
    $('stat-count').textContent = p.airborne != null ? p.airborne : p.count;
    $('stat-total').textContent = p.count;
    $('stat-updated').textContent = 'updated ' + relTime(Math.floor((p.updatedAt || Date.now()) / 1000));

    var seen = new Set();
    p.flights.forEach(function (f) {
      seen.add(f.icao24);
      var hasPos = f.lat != null && f.lon != null;
      var m = state.markers.get(f.icao24);
      if (hasPos) {
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
    if (!pts.length) { state.map.setView([24, 45], 3); return; }
    state.map.fitBounds(L.latLngBounds(pts).pad(0.12), { maxZoom: 6 });
  }

  async function tick() {
    try {
      var r = await fetch('/api/flights', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      apply(await r.json());
    } catch (e) {
      var b = $('badge');
      b.textContent = 'OFFLINE';
      b.className = 'badge b-off';
    }
    clearTimeout(state.nextTimer);
    state.nextAt = Date.now() + REFRESH_MS;
    state.nextTimer = setTimeout(tick, REFRESH_MS);
  }

  function init() {
    var std = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    });
    var dark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      subdomains: 'abcd',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>'
    });
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
    L.control.layers({ 'Standard': std, 'Dark': dark }, {}, { position: 'topright' }).addTo(state.map);
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
        if (m && m.flightData) drawRoute(m.flightData);
      });
    });

    $('search').addEventListener('input', renderList);
    $('refresh-btn').addEventListener('click', tick);
    $('trails').addEventListener('change', function (e) { setTrailsEnabled(e.target.checked); });
    $('follow').addEventListener('change', function (e) { state.follow = e.target.checked; });
    requestAnimationFrame(animateLoop);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) clearTimeout(state.nextTimer);
      else tick();
    });
    setInterval(function () {
      var el = $('stat-next');
      if (state.nextAt) el.textContent = 'refresh in ' + Math.max(0, Math.ceil((state.nextAt - Date.now()) / 1000)) + 's';
    }, 1000);

    tick();
  }

  init();
})();
