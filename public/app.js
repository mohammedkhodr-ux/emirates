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
    offlineBasemap: false,
    carriers: [],
    hiddenCarriers: new Set(),
    visibleFlights: []
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

  function colorOf(f) { return (f.carrier && f.carrier.color) || '#d71920'; }

  function planeIcon(f) {
    var rot = f.track != null ? f.track : 0;
    var color = f.onGround ? '#7d8590' : colorOf(f);
    return L.divIcon({
      className: 'plane-wrap',
      html: '<div class="plane' + (f.onGround ? ' ground' : '') + '" style="transform:rotate(' + rot + 'deg)">' +
        '<svg viewBox="0 0 24 24" width="28" height="28" style="fill:' + color + '"><path d="' + PLANE_PATH + '"/></svg></div>',
      iconSize: [34, 34],
      iconAnchor: [17, 17],
      popupAnchor: [0, -16]
    });
  }

  function posSourceName(n) {
    return ['ADS-B', 'ASTERIX', 'MLAT', 'FLARM'][n] != null ? ['ADS-B', 'ASTERIX', 'MLAT', 'FLARM'][n] : '—';
  }
  function categoryName(c) {
    return ['no info', 'no category', 'light', 'small', 'large', 'high-vortex large', 'heavy', 'high-performance',
      'rotorcraft', 'glider', 'lighter-than-air', 'parachutist', 'ultralight', 'reserved', 'UAV', 'space',
      'emergency vehicle', 'service vehicle', 'point obstacle', 'cluster obstacle', 'line obstacle'][c] || '—';
  }

  // Hover tooltip: every aviation detail available for the flight.
  function tooltipHtml(f) {
    function row(k, v) { return '<tr><td>' + k + '</td><td>' + v + '</td></tr>'; }
    return '<div class="tip"><table class="tip-table">' +
      row('Flight', '<b style="color:' + esc(colorOf(f)) + '">' + esc(f.callsign) + '</b> / <span class="ek">' + esc(ekOf(f)) + '</span>' + (f.carrier ? ' · ' + esc(f.carrier.name) : '')) +
      row('Route', airportLabel(f.departureAirport, f.departure) + ' → ' + airportLabel(f.arrivalAirport, f.arrival)) +
      row('Position', f.lat != null ? f.lat.toFixed(4) + ', ' + f.lon.toFixed(4) : '—') +
      row('Altitude', fmtAlt(f) + (f.altitudeM != null ? ' (' + fmtInt(Math.round(f.altitudeM)) + ' m)' : '')) +
      row('Geo altitude', f.geoAltitudeM != null ? fmtInt(Math.round(f.geoAltitudeM)) + ' m (' + fmtInt(Math.round(f.geoAltitudeM * 3.28084)) + ' ft)' : '—') +
      row('Ground speed', fmtSpd(f) + (f.speedMs != null ? ' (' + fmtInt(Math.round(f.speedMs * 3.6)) + ' km/h, ' + f.speedMs.toFixed(1) + ' m/s)' : '')) +
      row('True track', fmtHdg(f)) +
      row('Vertical rate', fmtVr(f) + (f.verticalRateMps != null ? ' (' + f.verticalRateMps.toFixed(1) + ' m/s)' : '')) +
      row('Status', f.onGround ? 'On ground' : 'Airborne') +
      row('Registered', esc(f.country || '—')) +
      row('Squawk', esc(f.squawk || '—')) +
      row('Position source', posSourceName(f.positionSource)) +
      row('Aircraft category', categoryName(f.category)) +
      row('Last contact', relTime(f.lastContact) + (f.timePosition ? ' (fix ' + relTime(f.timePosition) + ')' : '')) +
      row('ICAO24', esc(f.icao24)) +
      '</table></div>';
  }

  function airportLabel(ap, code) {
    if (ap && ap.lat != null) return esc(ap.name) + ' (' + esc(code) + ')';
    return esc(code || '—');
  }
  function routeText(f) {
    if (!f.departure && !f.arrival) return '—';
    return esc(f.departure || '?') + ' → ' + esc(f.arrival || '?');
  }

  // ATC callsign is e.g. UAE###; the commercial flight number is EK### (per-carrier IATA).
  function ekOf(f) { return f.flightNumber || (f.callsign ? f.callsign.replace(/^UAE/i, 'EK') : ''); }

  function popupHtml(f) {
    function row(k, v) { return '<tr><td>' + k + '</td><td>' + v + '</td></tr>'; }
    return '<div class="popup">' +
      '<div class="popup-head"><span class="cs" style="color:' + esc(colorOf(f)) + '">' + esc(f.callsign) + '</span><span class="ek">' + esc(ekOf(f)) + '</span><span class="tag">' + esc(f.carrier ? f.carrier.name : 'Airline') + '</span></div>' +
      '<div class="popup-route">' + airportLabel(f.departureAirport, f.departure) + ' → ' + airportLabel(f.arrivalAirport, f.arrival) + '</div>' +
      '<table class="popup-table">' +
      row('Position', f.lat != null ? f.lat.toFixed(4) + ', ' + f.lon.toFixed(4) : '—') +
      row('Altitude', fmtAlt(f) + (f.altitudeM != null ? ' (' + fmtInt(Math.round(f.altitudeM)) + ' m)' : '')) +
      row('Geo altitude', f.geoAltitudeM != null ? fmtInt(Math.round(f.geoAltitudeM)) + ' m' : '—') +
      row('Ground speed', fmtSpd(f) + (f.speedMs != null ? ' (' + fmtInt(Math.round(f.speedMs * 3.6)) + ' km/h)' : '')) +
      row('True track', fmtHdg(f)) +
      row('Vertical rate', fmtVr(f) + (f.verticalRateMps != null ? ' (' + f.verticalRateMps.toFixed(1) + ' m/s)' : '')) +
      row('Status', f.onGround ? 'On ground' : 'Airborne') +
      row('Registered in', esc(f.country || '—')) +
      row('Position source', posSourceName(f.positionSource)) +
      row('Aircraft category', categoryName(f.category)) +
      row('Last contact', relTime(f.lastContact) + (f.timePosition ? ' · fix ' + relTime(f.timePosition) : '')) +
      row('Squawk', esc(f.squawk || '—')) +
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

  // Planned path of one flight split at the current position:
  // flown = departure -> current position, remaining = current position -> destination.
  function routeSegments(f) {
    var dep = f.departureAirport, arr = f.arrivalAirport;
    if (!dep || !arr || dep.lat == null || arr.lat == null) return null;
    var pts = greatCircle({ lat: dep.lat, lon: dep.lon }, { lat: arr.lat, lon: arr.lon }, 64);
    if (f.lat == null || f.lon == null) return { flown: null, remaining: pts };
    var pos = L.latLng(f.lat, f.lon), best = 0, bestD = Infinity;
    for (var i = 0; i < pts.length; i++) {
      var d = pos.distanceTo(L.latLng(pts[i][0], pts[i][1]));
      if (d < bestD) { bestD = d; best = i; }
    }
    return {
      flown: pts.slice(0, best + 1).concat([[f.lat, f.lon]]),
      remaining: [[f.lat, f.lon]].concat(pts.slice(best + 1))
    };
  }

  function drawRoute(f) {
    if (state.routeLayer) { state.map.removeLayer(state.routeLayer); state.routeLayer = null; }
    var seg = routeSegments(f);
    if (!seg) return;
    var g = L.layerGroup();
    if (seg.flown && seg.flown.length >= 2) {
      L.polyline(seg.flown, { color: '#d4af37', weight: 3, opacity: 0.95 }).addTo(g);
    }
    if (seg.remaining && seg.remaining.length >= 2) {
      L.polyline(seg.remaining, { color: '#d4af37', weight: 2.5, dashArray: '6 8', opacity: 0.9 }).addTo(g);
    }
    var dep = f.departureAirport, arr = f.arrivalAirport;
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
    var flights = state.visibleFlights || [];
    if (state.view === 'markers' || !flights.length) return;
    var g = L.layerGroup();
    flights.forEach(function (f) {
      var seg = routeSegments(f);
      if (!seg) return;
      var selected = state.selected === f.icao24;
      var color = selected ? '#ffffff' : colorOf(f);
      var interactive = state.view === 'lines';
      function bind(l) {
        if (!interactive) return;
        l.on('click', function () { select(f.icao24, false); });
        l.bindTooltip(function () { return tooltipHtml(f); }, { direction: 'top', sticky: true, className: 'plane-tip' });
      }
      if (seg.flown && seg.flown.length >= 2) {
        bind(L.polyline(seg.flown, { color: color, weight: selected ? 3 : 2, opacity: 0.95, interactive: interactive }).addTo(g));
      }
      if (seg.remaining && seg.remaining.length >= 2) {
        bind(L.polyline(seg.remaining, { color: color, weight: selected ? 2.5 : 1.4, dashArray: '4 7', opacity: 0.8, interactive: interactive }).addTo(g));
      }
      if (f.lat != null && f.lon != null) {
        var cm = L.circleMarker([f.lat, f.lon], {
          radius: selected ? 6 : 3.5,
          color: '#fff',
          fillColor: selected ? '#ffffff' : colorOf(f),
          fillOpacity: 0.95, weight: 1.5,
          interactive: interactive
        }).addTo(g);
        if (interactive) {
          cm.on('click', function () { select(f.icao24, false); });
          cm.bindTooltip(function () { return tooltipHtml(f); }, { direction: 'top', className: 'plane-tip' });
        }
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
    var flights = state.visibleFlights || [];
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

    state.visibleFlights = (p.flights || []).filter(function (f) {
      return !(f.carrier && state.hiddenCarriers.has(f.carrier.id));
    });

    var useCluster = state.view !== 'lines';
    if (useCluster && !state.map.hasLayer(state.cluster)) state.map.addLayer(state.cluster);
    if (!useCluster && state.map.hasLayer(state.cluster)) state.map.removeLayer(state.cluster);

    var seen = new Set();
    state.visibleFlights.forEach(function (f) {
      seen.add(f.icao24);
      var hasPos = f.lat != null && f.lon != null;
      var m = state.markers.get(f.icao24);
      if (hasPos && useCluster) {
        if (!m) {
          m = L.marker([f.lat, f.lon], { icon: planeIcon(f), title: f.callsign + ' / ' + ekOf(f) });
          m.on('click', function () { select(f.icao24); });
          m.bindPopup(function () { return popupHtml(m.flightData); }, { maxWidth: 290 });
          m.bindTooltip(function () { return tooltipHtml(m.flightData); }, { sticky: true, direction: 'top', className: 'plane-tip' });
          state.cluster.addLayer(m);
          state.markers.set(f.icao24, m);
        } else {
          m.setLatLng([f.lat, f.lon]);
          m.setIcon(planeIcon(f));
        }
        m.flightData = f;
        if (m.isPopupOpen()) m.setPopupContent(popupHtml(f));
        if (m.isTooltipOpen()) m.setTooltipContent(tooltipHtml(f));
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
    renderLegend();
    renderAnalytics();
    renderReport();
    if (!state.fitted && state.visibleFlights.some(function (f) { return f.lat != null; })) {
      fitAll();
      state.fitted = true;
    }
  }

  function renderList() {
    var q = ($('search').value || '').trim().toLowerCase();
    var list = $('flight-list');
    list.innerHTML = '';
    var flights = (state.visibleFlights || []).slice()
      .sort(function (a, b) { return a.callsign.localeCompare(b.callsign); });
    var shown = 0;
    flights.forEach(function (f) {
      var hay = (f.callsign + ' ' + ekOf(f) + ' ' + (f.departure || '') + ' ' + (f.arrival || '') + ' ' +
        (f.departureAirport ? f.departureAirport.name : '') + ' ' +
        (f.arrivalAirport ? f.arrivalAirport.name : '')).toLowerCase();
      if (q && hay.indexOf(q) === -1) return;
      shown++;
      var div = document.createElement('div');
      div.className = 'fl-item' + (state.selected === f.icao24 ? ' active' : '');
      div.dataset.icao = f.icao24;
      div.innerHTML =
        '<div class="fl-top"><span><span class="fl-cs">' + esc(f.callsign) + '</span><span class="fl-ek">' + esc(ekOf(f)) + '</span></span><span class="fl-alt">' + fmtAlt(f) + '</span></div>' +
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
    if (state.visibleFlights) {
      state.visibleFlights.forEach(function (f) { if (f.lat != null) pts.push([f.lat, f.lon]); });
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

  function loadCarriers() {
    fetch('/api/carriers', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      state.carriers = (j && j.carriers) || [];
      renderLegend();
    }).catch(function () {
      state.carriers = [
        { id: 'EK', name: 'Emirates', color: '#d71920' },
        { id: 'FZ', name: 'flydubai', color: '#22c55e' },
        { id: 'G9', name: 'Air Arabia', color: '#fb923c' },
        { id: 'QR', name: 'Qatar Airways', color: '#c026d3' },
        { id: 'SV', name: 'Saudia', color: '#38bdf8' },
        { id: 'NA', name: 'Nas Air', color: '#a855f7' },
        { id: 'EY', name: 'Etihad Airways', color: '#fbbf24' }
      ];
      renderLegend();
    });
  }

  function renderLegend() {
    var el = $('legend');
    if (!el) return;
    el.innerHTML = '';
    var counts = {};
    (state.visibleFlights || []).forEach(function (f) { if (f.carrier) counts[f.carrier.id] = (counts[f.carrier.id] || 0) + 1; });
    (state.carriers || []).forEach(function (c) {
      var b = document.createElement('button');
      b.className = 'chip' + (state.hiddenCarriers.has(c.id) ? ' off' : '');
      b.title = 'Show / hide ' + c.name;
      b.innerHTML = '<span class="dot" style="background:' + esc(c.color) + '"></span>' + esc(c.name) + ' <b>' + (counts[c.id] || 0) + '</b>';
      b.addEventListener('click', function () {
        if (state.hiddenCarriers.has(c.id)) state.hiddenCarriers.delete(c.id);
        else state.hiddenCarriers.add(c.id);
        renderLegend();
        if (state.payload) apply(state.payload);
      });
      el.appendChild(b);
    });
  }

  var chat = { history: [], sending: false };

  function chatScroll() { var l = $('chat-log'); if (l) l.scrollTop = l.scrollHeight; }
  function chatAdd(role, text) {
    var l = $('chat-log');
    if (!l) return null;
    var d = document.createElement('div');
    d.className = 'msg ' + role;
    d.textContent = text;
    l.appendChild(d);
    chatScroll();
    return d;
  }

  async function chatSend(text) {
    text = (text || '').trim();
    if (!text || chat.sending) return;
    chat.sending = true;
    chat.history.push({ role: 'user', content: text });
    chatAdd('user', text);
    var pending = chatAdd('bot', '…');
    try {
      var r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: chat.history })
      });
      var j = await r.json();
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      chat.history.push({ role: 'assistant', content: j.reply });
      if (pending) pending.textContent = j.reply;
      chatScroll();
    } catch (e) {
      if (pending) pending.textContent = '⚠ ' + e.message;
      chatScroll();
    } finally {
      chat.sending = false;
      var inp = $('chat-input');
      if (inp) inp.focus();
    }
  }

  function initChat() {
    var toggle = $('chat-toggle'), panel = $('chat-panel');
    if (!toggle || !panel) return;
    toggle.addEventListener('click', function () {
      panel.classList.toggle('hidden');
      var inp = $('chat-input');
      if (inp && !panel.classList.contains('hidden')) inp.focus();
    });
    $('chat-close').addEventListener('click', function () { panel.classList.add('hidden'); });
    $('chat-send').addEventListener('click', function () { chatSend($('chat-input').value); $('chat-input').value = ''; });
    $('chat-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { chatSend(e.target.value); e.target.value = ''; }
    });
    var quick = document.querySelectorAll('.chat-quick button');
    for (var i = 0; i < quick.length; i++) {
      quick[i].addEventListener('click', function () { chatSend(this.dataset.q); });
    }
  }

  function initTabs() {
    var tabs = [['tab-flights', 'pane-flights'], ['tab-analytics', 'pane-analytics'], ['tab-reports', 'pane-reports']];
    tabs.forEach(function (t) {
      $(t[0]).addEventListener('click', function () {
        tabs.forEach(function (x) {
          $(x[0]).classList.toggle('active', x[0] === t[0]);
          $(x[1]).classList.toggle('hidden', x[1] !== t[1]);
        });
      });
    });
  }

  function bar(label, count, max, color) {
    var pct = max ? Math.round(count / max * 100) : 0;
    return '<div class="bar-row"><span class="bar-label">' + esc(label) + '</span>' +
      '<span class="bar-track"><span class="bar-fill" style="width:' + pct + '%;background:' + (color || '#d4af37') + '"></span></span>' +
      '<span class="bar-num">' + count + '</span></div>';
  }

  function carrierColor(id) {
    var c = (state.carriers || []).find(function (x) { return x.id === id; });
    return c ? c.color : '#d4af37';
  }

  function renderAnalytics() {
    var el = $('pane-analytics');
    if (!el) return;
    var flights = state.visibleFlights || [];
    var airborne = flights.filter(function (f) { return !f.onGround; });
    var ground = flights.length - airborne.length;
    var byCarrier = {}, altBands = [0, 0, 0, 0, 0], spdBands = [0, 0, 0, 0], routes = {};
    var maxAlt = -1, maxAltF = null, maxSpd = -1, maxSpdF = null, climbing = 0, descending = 0, altSum = 0, altN = 0;
    flights.forEach(function (f) {
      var cid = f.carrier ? f.carrier.id : '??';
      byCarrier[cid] = (byCarrier[cid] || 0) + 1;
      if (f.onGround) return;
      if (f.altitudeFt != null) {
        altSum += f.altitudeFt; altN++;
        if (f.altitudeFt < 10000) altBands[0]++; else if (f.altitudeFt < 20000) altBands[1]++;
        else if (f.altitudeFt < 30000) altBands[2]++; else if (f.altitudeFt < 40000) altBands[3]++; else altBands[4]++;
        if (f.altitudeFt > maxAlt) { maxAlt = f.altitudeFt; maxAltF = f; }
      }
      if (f.speedKn != null) {
        if (f.speedKn < 300) spdBands[0]++; else if (f.speedKn < 450) spdBands[1]++;
        else if (f.speedKn < 550) spdBands[2]++; else spdBands[3]++;
        if (f.speedKn > maxSpd) { maxSpd = f.speedKn; maxSpdF = f; }
      }
      if (f.verticalRateFpm > 500) climbing++; else if (f.verticalRateFpm < -500) descending++;
      routes[(f.departure || '?') + '→' + (f.arrival || '?')] = (routes[(f.departure || '?') + '→' + (f.arrival || '?')] || 0) + 1;
    });
    var html = '<h3>Overview</h3><div class="cards">' +
      card('Tracked', flights.length) + card('Airborne', airborne.length) + card('On ground', ground) +
      card('Climbing', climbing) + card('Descending', descending) +
      card('Avg cruise alt', altN ? fmtInt(Math.round(altSum / altN)) + ' ft' : '—') +
      card('Highest', maxAltF ? esc(maxAltF.callsign) + ' ' + fmtInt(maxAlt) + ' ft' : '—') +
      card('Fastest', maxSpdF ? esc(maxSpdF.callsign) + ' ' + fmtInt(maxSpd) + ' kn' : '—') +
      '</div>';
    var cids = Object.keys(byCarrier).sort(function (a, b) { return byCarrier[b] - byCarrier[a]; });
    var cMax = Math.max(1, ...cids.map(function (c) { return byCarrier[c]; }));
    html += '<h3>Flights per airline</h3>';
    cids.forEach(function (c) {
      var name = (state.carriers.find(function (x) { return x.id === c; }) || {}).name || c;
      html += bar(name, byCarrier[c], cMax, carrierColor(c));
    });
    var aMax = Math.max(1, ...altBands);
    html += '<h3>Altitude bands (airborne)</h3>' +
      bar('< 10,000 ft', altBands[0], aMax) + bar('10–20k ft', altBands[1], aMax) +
      bar('20–30k ft', altBands[2], aMax) + bar('30–40k ft', altBands[3], aMax) + bar('> 40,000 ft', altBands[4], aMax);
    var sMax = Math.max(1, ...spdBands);
    html += '<h3>Ground speed bands (airborne)</h3>' +
      bar('< 300 kn', spdBands[0], sMax) + bar('300–450 kn', spdBands[1], sMax) +
      bar('450–550 kn', spdBands[2], sMax) + bar('> 550 kn', spdBands[3], sMax);
    var rts = Object.keys(routes).sort(function (a, b) { return routes[b] - routes[a]; }).slice(0, 8);
    var rMax = Math.max(1, ...rts.map(function (r) { return routes[r]; }));
    html += '<h3>Top routes</h3>';
    rts.forEach(function (r) { html += bar(r, routes[r], rMax, '#38bdf8'); });
    el.innerHTML = html;
  }

  function card(label, value) {
    return '<div class="card"><span class="card-num">' + value + '</span><span class="card-label">' + esc(label) + '</span></div>';
  }

  function renderReport() {
    var el = $('report-text');
    if (!el) return;
    var p = state.payload || {};
    var flights = state.visibleFlights || [];
    var airborne = flights.filter(function (f) { return !f.onGround; });
    var byCarrier = {};
    flights.forEach(function (f) { var c = f.carrier ? f.carrier.name : 'Unknown'; byCarrier[c] = (byCarrier[c] || 0) + 1; });
    var routes = {};
    flights.forEach(function (f) { var r = (f.departure || '?') + '→' + (f.arrival || '?'); routes[r] = (routes[r] || 0) + 1; });
    var maxAltF = null, maxSpdF = null;
    airborne.forEach(function (f) {
      if (f.altitudeFt != null && (!maxAltF || f.altitudeFt > maxAltF.altitudeFt)) maxAltF = f;
      if (f.speedKn != null && (!maxSpdF || f.speedKn > maxSpdF.speedKn)) maxSpdF = f;
    });
    var L = [];
    L.push('# Middle East Airlines — flight report');
    L.push('');
    L.push('- Generated (UTC): ' + new Date().toISOString());
    L.push('- Snapshot: ' + (p.source || 'unknown') + (p.historical ? ' · historical as of ' + new Date((p.serverTime || 0) * 1000).toISOString() : '') + (p.dataAgeSec != null ? ' · cached ' + p.dataAgeSec + 's old' : ''));
    L.push('- Tracked flights: ' + flights.length + ' (' + airborne.length + ' airborne, ' + (flights.length - airborne.length) + ' on ground)');
    if (maxAltF) L.push('- Highest: ' + maxAltF.callsign + ' / ' + ekOf(maxAltF) + ' at ' + fmtInt(maxAltF.altitudeFt) + ' ft');
    if (maxSpdF) L.push('- Fastest: ' + maxSpdF.callsign + ' / ' + ekOf(maxSpdF) + ' at ' + fmtInt(maxSpdF.speedKn) + ' kn');
    L.push('');
    L.push('## Flights per airline');
    L.push('');
    L.push('| Airline | Flights |');
    L.push('|---|---|');
    Object.keys(byCarrier).sort(function (a, b) { return byCarrier[b] - byCarrier[a]; }).forEach(function (c) {
      L.push('| ' + c + ' | ' + byCarrier[c] + ' |');
    });
    L.push('');
    L.push('## Top routes');
    L.push('');
    L.push('| Route | Flights |');
    L.push('|---|---|');
    Object.keys(routes).sort(function (a, b) { return routes[b] - routes[a]; }).slice(0, 10).forEach(function (r) {
      L.push('| ' + r + ' | ' + routes[r] + ' |');
    });
    L.push('');
    L.push('## All flights');
    L.push('');
    L.push('| Callsign | Flight no | Airline | Route | Alt (ft) | Speed (kn) | Hdg | V/S (fpm) | Status | Position |');
    L.push('|---|---|---|---|---|---|---|---|---|---|');
    flights.slice().sort(function (a, b) { return a.callsign.localeCompare(b.callsign); }).forEach(function (f) {
      L.push('| ' + f.callsign + ' | ' + ekOf(f) + ' | ' + (f.carrier ? f.carrier.name : '') + ' | ' +
        (f.departure || '?') + '→' + (f.arrival || '?') + ' | ' + (f.altitudeFt != null ? f.altitudeFt : '—') + ' | ' +
        (f.speedKn != null ? f.speedKn : '—') + ' | ' + (f.track != null ? Math.round(f.track) + '°' : '—') + ' | ' +
        (f.verticalRateFpm != null ? f.verticalRateFpm : '—') + ' | ' + (f.onGround ? 'ground' : 'airborne') + ' | ' +
        (f.lat != null ? f.lat.toFixed(2) + ',' + f.lon.toFixed(2) : '—') + ' |');
    });
    L.push('');
    L.push('Data: OpenSky Network · unofficial tracker, not affiliated with the airlines.');
    el.textContent = L.join('\n');
  }

  function initReports() {
    $('report-download').addEventListener('click', function () {
      var blob = new Blob([$('report-text').textContent], { type: 'text/markdown' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'flight-report-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.md';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });
    $('report-copy').addEventListener('click', function () {
      var t = $('report-text').textContent;
      if (navigator.clipboard) navigator.clipboard.writeText(t);
      this.textContent = '✓ Copied';
      var btn = this;
      setTimeout(function () { btn.textContent = '⧉ Copy'; }, 1500);
    });
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

    loadCarriers();
    initChat();
    initTabs();
    initReports();
    loadCountries();
    loadSchedule(state.histDate);
    tick();
  }

  init();
})();
