'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { OpenskyClient } = require('./lib/opensky');
const { demoFlights, demoTrack } = require('./lib/demo');
const { scheduleForDate } = require('./lib/schedule');
const { airportInfo } = require('./lib/airports');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DEMO = process.env.DEMO === '1';
const MIN_UPSTREAM_MS = Math.max(5, Number(process.env.REFRESH_MIN_SECONDS || 45)) * 1000;
const CACHE_FILE = path.join(__dirname, '.cache', 'flights.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const client = new OpenskyClient({
  clientId: process.env.OPENSKY_CLIENT_ID || null,
  clientSecret: process.env.OPENSKY_CLIENT_SECRET || null
});

// Emirates operates under the ATC callsign prefix "UAE" (e.g. UAE201).
const EMIRATES_CALLSIGN = /^UAE/i;

let cache = loadCache();
let lastUpstreamAt = 0;
let cooldownUntil = 0;
let inflight = null;

const HIST_MIN_MS = 10000;
let lastHistAt = 0;
const histCache = new Map();

function loadCache() {
  try {
    const p = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (p && Array.isArray(p.flights)) return p;
  } catch { /* no cache yet */ }
  return null;
}

function saveCache(p) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(p));
  } catch { /* best effort */ }
}

function enrich(f) {
  return { ...f, departureAirport: airportInfo(f.departure), arrivalAirport: airportInfo(f.arrival) };
}

function mapState(s, routesByCallsign) {
  const callsign = (s[1] || '').trim();
  const r = routesByCallsign.get(callsign);
  const altM = s[7];
  const vel = s[9];
  const vr = s[11];
  return enrich({
    icao24: s[0],
    callsign,
    country: s[2] || null,
    timePosition: s[3] ?? null,
    lastContact: s[4] ?? null,
    lon: s[5] ?? null,
    lat: s[6] ?? null,
    altitudeM: altM ?? null,
    altitudeFt: altM != null ? Math.round(altM * 3.28084) : null,
    onGround: !!s[8],
    speedMs: vel ?? null,
    speedKn: vel != null ? Math.round(vel * 1.94384) : null,
    track: s[10] ?? null,
    verticalRateMps: vr ?? null,
    verticalRateFpm: vr != null ? Math.round(vr * 196.85) : null,
    geoAltitudeM: s[13] ?? null,
    squawk: s[14] ?? null,
    spi: !!s[15],
    positionSource: s[16] ?? null,
    category: s[17] ?? null,
    departure: r && r.estDepartureAirport ? r.estDepartureAirport : null,
    arrival: r && r.estArrivalAirport ? r.estArrivalAirport : null
  });
}

function demoPayload(nowMs) {
  const nowSec = Math.floor(nowMs / 1000);
  const flights = demoFlights(nowSec)
    .filter(f => EMIRATES_CALLSIGN.test(f.callsign))
    .map(enrich);
  flights.sort((a, b) => a.callsign.localeCompare(b.callsign));
  return {
    source: 'demo',
    serverTime: nowSec,
    updatedAt: nowMs,
    count: flights.length,
    airborne: flights.filter(f => !f.onGround).length,
    flights
  };
}

function cachedPayload(p, retryAfterSec) {
  return {
    ...p,
    source: p.source === 'live' ? 'cached' : p.source,
    dataAgeSec: Math.round((Date.now() - p.updatedAt) / 1000),
    retryAfterSec: retryAfterSec || null
  };
}

async function fetchUpstream() {
  const now = Date.now();
  const statesRes = await client.fetchStatesAll();
  if (statesRes.status === 429) {
    const ra = Number(statesRes.headers.get('x-rate-limit-retry-after-seconds')) || 3600;
    cooldownUntil = now + Math.min(ra, 86400) * 1000;
    return { cooldownSec: Math.ceil((cooldownUntil - now) / 1000) };
  }
  if (!statesRes.ok) return { error: statesRes.status };
  const data = await statesRes.json();

  const routesByCallsign = new Map();
  try {
    const fr = await client.fetchRecentFlights(2 * 3600);
    if (fr.ok) {
      const fj = await fr.json();
      for (const fl of fj || []) {
        if (fl && fl.callsign) routesByCallsign.set(String(fl.callsign).trim(), fl);
      }
    }
  } catch { /* route info is best-effort */ }

  const flights = (data.states || [])
    .filter(s => s[1] && EMIRATES_CALLSIGN.test(String(s[1]).trim()))
    .map(s => mapState(s, routesByCallsign));
  flights.sort((a, b) => a.callsign.localeCompare(b.callsign));

  return {
    payload: {
      source: 'live',
      serverTime: data.time ?? Math.floor(now / 1000),
      updatedAt: now,
      count: flights.length,
      airborne: flights.filter(f => !f.onGround).length,
      flights
    }
  };
}

async function getFlights() {
  const now = Date.now();
  if (DEMO) return demoPayload(now);
  const throttled = now < cooldownUntil || now - lastUpstreamAt < MIN_UPSTREAM_MS;
  if (throttled) {
    const retryAfterSec = now < cooldownUntil ? Math.ceil((cooldownUntil - now) / 1000) : null;
    if (cache) return cachedPayload(cache, retryAfterSec);
    return { ...demoPayload(now), retryAfterSec };
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetchUpstream();
      lastUpstreamAt = now;
      if (r.cooldownSec) {
        if (cache) return cachedPayload(cache, r.cooldownSec);
        return { ...demoPayload(now), retryAfterSec: r.cooldownSec };
      }
      if (r.error) {
        if (cache) return cachedPayload(cache);
        return demoPayload(now);
      }
      cache = r.payload;
      saveCache(r.payload);
      return r.payload;
    } catch {
      lastUpstreamAt = now;
      if (cache) return cachedPayload(cache);
      return demoPayload(now);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    headers['Cache-Control'] = filePath.includes(`${path.sep}vendor${path.sep}`) ? 'public, max-age=86400' : 'no-cache';
    res.writeHead(200, headers);
    res.end(data);
  });
}

async function routesByCallsignAround(timeSec) {
  const map = new Map();
  try {
    const fr = await client.fetchFlightsRange(timeSec - 2 * 3600, timeSec + 300);
    if (fr.ok) {
      const fj = await fr.json();
      for (const fl of fj || []) {
        if (fl && fl.callsign) map.set(String(fl.callsign).trim(), fl);
      }
    }
  } catch { /* route info is best-effort */ }
  return map;
}

function statesPayload(data, updatedAtMs, historical, timeSec) {
  return routesByCallsignAround(timeSec || Math.floor(Date.now() / 1000)).then(routes => {
    const flights = (data.states || [])
      .filter(s => s[1] && EMIRATES_CALLSIGN.test(String(s[1]).trim()))
      .map(s => mapState(s, routes));
    flights.sort((a, b) => a.callsign.localeCompare(b.callsign));
    return {
      source: 'live',
      historical: !!historical,
      serverTime: data.time ?? timeSec ?? Math.floor(updatedAtMs / 1000),
      updatedAt: updatedAtMs,
      count: flights.length,
      airborne: flights.filter(f => !f.onGround).length,
      flights
    };
  });
}

// Flights airborne at an arbitrary past timestamp (OpenSky history, or demo data).
async function getFlightsAt(timeSec) {
  timeSec = Math.floor(timeSec);
  if (DEMO) {
    const p = demoPayload(timeSec * 1000);
    return { ...p, historical: true, serverTime: timeSec };
  }
  const bucket = Math.floor(timeSec / 300);
  if (histCache.has(bucket)) return histCache.get(bucket);
  const now = Date.now();
  if (now - lastHistAt < HIST_MIN_MS && histCache.size) {
    const nearest = histCache.get(Math.floor((timeSec - 300) / 300)) || histCache.get(Math.floor((timeSec + 300) / 300));
    if (nearest) return nearest;
  }
  lastHistAt = now;
  try {
    const res = await client.fetchStatesAll(timeSec);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const payload = await statesPayload(data, now, true, timeSec);
    histCache.set(bucket, payload);
    if (histCache.size > 500) histCache.delete(histCache.keys().next().value);
    return payload;
  } catch {
    const p = demoPayload(timeSec * 1000);
    return { ...p, historical: true, serverTime: timeSec, note: 'history unavailable, simulated data' };
  }
}

async function getTrack(icao24, timeSec) {
  if (DEMO) {
    const t = demoTrack(icao24, timeSec || Math.floor(Date.now() / 1000));
    if (t) return t;
    throw new Error('unknown icao24');
  }
  const res = await client.fetchTrack(icao24, timeSec);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const path = (data.path || []).map(p => [
    p[0],
    p[1] != null ? Number(p[1].toFixed(5)) : null,
    p[2] != null ? Number(p[2].toFixed(5)) : null,
    p[3] != null ? Math.round(p[3]) : null,
    p[4] != null ? Math.round(p[4]) : null
  ]);
  return {
    icao24: data.icao24,
    callsign: data.callsign || null,
    departure: data.departure_airport || null,
    arrival: data.arrival_airport || null,
    source: 'live',
    path
  };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  if (p === '/api/flights') {
    try {
      const timeParam = u.searchParams.get('time');
      const timeSec = timeParam && /^\d+$/.test(timeParam) ? Number(timeParam) : null;
      if (timeSec && timeSec < Math.floor(Date.now() / 1000) - 60) {
        sendJson(res, 200, await getFlightsAt(timeSec));
      } else {
        sendJson(res, 200, await getFlights());
      }
    } catch (e) {
      sendJson(res, 500, { error: String((e && e.message) || e) });
    }
    return;
  }
  if (p === '/api/track') {
    try {
      const icao24 = u.searchParams.get('icao24') || '';
      const timeParam = u.searchParams.get('time');
      const timeSec = timeParam && /^\d+$/.test(timeParam) ? Number(timeParam) : Math.floor(Date.now() / 1000);
      if (!icao24) { sendJson(res, 400, { error: 'icao24 required' }); return; }
      sendJson(res, 200, await getTrack(icao24, timeSec));
    } catch (e) {
      sendJson(res, 502, { error: String((e && e.message) || e) });
    }
    return;
  }
  if (p === '/api/schedule') {
    const date = u.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    const sched = scheduleForDate(date);
    if (!sched) { sendJson(res, 400, { error: 'date must be YYYY-MM-DD' }); return; }
    sendJson(res, 200, sched);
    return;
  }
  if (p === '/api/health') {
    sendJson(res, 200, { ok: true, demo: DEMO, hasCache: !!cache, coolingDown: cooldownUntil > Date.now() });
    return;
  }
  serveStatic(req, res, p);
});

server.listen(PORT, HOST, () => {
  console.log(`Emirates Live Tracker running at http://${HOST}:${PORT}  (demo=${DEMO}, min upstream interval=${MIN_UPSTREAM_MS / 1000}s)`);
});
