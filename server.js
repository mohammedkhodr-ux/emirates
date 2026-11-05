'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { OpenskyClient } = require('./lib/opensky');
const { demoFlights, demoTrack } = require('./lib/demo');
const { scheduleForDate } = require('./lib/schedule');
const { airportInfo } = require('./lib/airports');
const { CARRIERS, carrierOf, flightNumber } = require('./lib/carriers');
const rag = require('./lib/rag');

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

// Tracked Middle East carriers are matched by ATC callsign prefix (see lib/carriers.js).
function isTracked(callsign) { return !!carrierOf(callsign); }
function carrierTag(f) {
  const c = carrierOf(f.callsign);
  return c ? { id: c.id, name: c.name, iata: c.iata, color: c.color } : null;
}

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
    carrier: carrierTag({ callsign }),
    flightNumber: flightNumber(callsign),
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
    sensors: Array.isArray(s[12]) ? s[12] : null,
    sensorCount: Array.isArray(s[12]) ? s[12].length : null,
    departure: r && r.estDepartureAirport ? r.estDepartureAirport : null,
    arrival: r && r.estArrivalAirport ? r.estArrivalAirport : null
  });
}

function demoPayload(nowMs) {
  const nowSec = Math.floor(nowMs / 1000);
  const flights = demoFlights(nowSec)
    .filter(f => isTracked(f.callsign))
    .map(f => enrich({ ...f, carrier: carrierTag(f), flightNumber: flightNumber(f.callsign) }));
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
    .filter(s => s[1] && isTracked(String(s[1]).trim()))
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

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function flightsContext(flights, nowSec) {
  return flights.slice(0, 150).map(f => {
    const c = f.carrier || carrierOf(f.callsign) || { name: 'unknown' };
    return `${f.callsign}/${f.flightNumber || ''} ${c.name} ${f.departure || '?'}->${f.arrival || '?'} ` +
      `pos=${f.lat != null ? f.lat.toFixed(2) + ',' + f.lon.toFixed(2) : 'n/a'} ` +
      `alt=${f.altitudeFt != null ? f.altitudeFt + 'ft' : 'n/a'} ` +
      `spd=${f.speedKn != null ? f.speedKn + 'kn' : 'n/a'} ` +
      `hdg=${f.track != null ? Math.round(f.track) + 'deg' : 'n/a'} ` +
      `vr=${f.verticalRateFpm != null ? f.verticalRateFpm + 'fpm' : 'n/a'} ` +
      `${f.onGround ? 'on-ground' : 'airborne'} ` +
      `last=${f.lastContact ? Math.max(0, nowSec - f.lastContact) + 's-ago' : 'n/a'} icao24=${f.icao24}`;
  }).join('\n');
}

const API_BASE = (process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai').replace(/\/$/, '');

// Credential candidates for the chat agent, in priority order. Never log or
// return token values — only the `via` label and host names.
function chatCredentialCandidates(req) {
  const out = [];
  const callerToken = req.headers['x-apps-token'] || req.headers['x-space-token'] || null;
  // The platform injects __APPS_PROXY_URL / __SPACES_PROXY_URL into the app when
  // a gateway fronts it; the caller token is spent against that proxy URL.
  const proxyUrl = process.env.__APPS_PROXY_URL || process.env.__SPACES_PROXY_URL || process.env.APPS_PROXY_URL || null;
  if (callerToken && proxyUrl) out.push({ token: callerToken, base: proxyUrl.replace(/\/$/, '') + '/v1', via: 'gateway-caller-proxy' });
  if (callerToken) out.push({ token: callerToken, base: API_BASE + '/v1', via: 'gateway-caller-direct' });
  const saPath = process.env.MISTRAL_SA_TOKEN_PATH || null;
  if (saPath) {
    try {
      const t = fs.readFileSync(saPath, 'utf8').trim();
      if (t) out.push({ token: t, base: API_BASE + '/v1', via: 'service-account' });
    } catch { /* token file not mounted here */ }
  }
  if (process.env.MISTRAL_API_KEY) out.push({ token: process.env.MISTRAL_API_KEY, base: API_BASE + '/v1', via: 'env-key' });
  return out;
}

function chatDebug(req) {
  const proxyUrl = process.env.__APPS_PROXY_URL || process.env.__SPACES_PROXY_URL || process.env.APPS_PROXY_URL || null;
  return {
    hasGatewayToken: !!(req.headers['x-apps-token'] || req.headers['x-space-token']),
    proxyHost: proxyUrl ? new URL(proxyUrl).host : null,
    hasServiceAccountToken: !!process.env.MISTRAL_SA_TOKEN_PATH,
    hasEnvKey: !!process.env.MISTRAL_API_KEY,
    apiBaseHost: new URL(API_BASE).host
  };
}

// Chat agent: answers questions about the currently tracked flights.
// Uses the caller's gateway token (x-apps-token, spent via the apps proxy) so
// usage is billed to the calling user; falls back to the app's service-account
// token or a MISTRAL_API_KEY env var.
async function handleChat(req, res) {
  try {
    const data = JSON.parse(await readBody(req, 65536) || '{}');
    const messages = Array.isArray(data.messages) ? data.messages.slice(-12) : [];
    if (!messages.length || typeof messages[messages.length - 1].content !== 'string') {
      sendJson(res, 400, { error: 'messages[] with role/content required' });
      return;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const model = process.env.CHAT_MODEL || 'mistral-small-latest';
    const candidates = chatCredentialCandidates(req);
    if (!candidates.length) {
      sendJson(res, 503, { error: 'no model credentials available (open the app via its gateway URL, or set MISTRAL_API_KEY on the app)', debug: chatDebug(req), index: rag.stats() });
      return;
    }
    // RAG: retrieve the most relevant indexed chunks (active + historical
    // flight data, schedules) for the user's question and ground the answer
    // in them.
    const lastUser = messages[messages.length - 1].content || '';
    const qCred = candidates[0] || null;
    let qVec = null;
    if (qCred) {
      const v = await rag.embedTexts([lastUser], { token: qCred.token, base: qCred.base });
      if (v) qVec = v[0];
    }
    const top = rag.retrieve(lastUser, 8, qVec);
    const idx = rag.stats();
    const flights = (cache && cache.flights) || demoPayload(Date.now()).flights;
    const carrierCounts = {};
    flights.forEach(f => { const n = (f.carrier && f.carrier.name) || 'unknown'; carrierCounts[n] = (carrierCounts[n] || 0) + 1; });
    const snapshotLine = `snapshot UTC ${new Date(nowSec * 1000).toISOString()}: ${flights.length} tracked flights (${flights.filter(f => !f.onGround).length} airborne) — ` +
      Object.entries(carrierCounts).map(([k, v]) => `${k}: ${v}`).join(', ');
    const sys = {
      role: 'system',
      content: 'You are a concise flight-data assistant for a live Middle East airline tracker ' +
        '(Emirates, flydubai, Air Arabia, Qatar Airways, Saudia, Nas Air, Etihad). ' +
        'A retrieval index over ACTIVE and HISTORICAL flight data (every snapshot the tracker collected, plus schedules) is provided below. ' +
        'Answer using ONLY the RETRIEVED CONTEXT, cite flights by callsign (e.g. UAE201 / EK201), and say when the context lacks the answer.\n\n' +
        snapshotLine + '\n\n' +
        'RETRIEVED CONTEXT (top ' + top.length + ' of ' + idx.chunks + ' indexed chunks, ' + idx.embedded + ' embedded):\n' +
        (top.map(c => c.text).join('\n') || '(index empty)')
    };
    let lastErr = 'unknown', lastStatus = 0;
    for (const c of candidates) {
      let r;
      try {
        r = await fetch(c.base + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.token },
          body: JSON.stringify({ model, messages: [sys, ...messages], temperature: 0.3, max_tokens: 500 }),
          signal: AbortSignal.timeout(30000)
        });
      } catch (e) {
        lastErr = String((e && e.message) || e);
        continue;
      }
      if (r.ok) {
        const j = await r.json();
        const reply = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
        sendJson(res, 200, { reply, via: c.via, retrieved: top.length, index: idx });
        return;
      }
      const t = await r.text().catch(() => '');
      lastStatus = r.status;
      lastErr = 'HTTP ' + r.status + ': ' + t.slice(0, 300);
      if (r.status !== 401 && r.status !== 403) break; // real API error, not an auth one
    }
    sendJson(res, 502, {
      error: 'model API failed: ' + lastErr,
      debug: { ...chatDebug(req), lastStatus },
      rag: { retrieved: top.length, index: idx, preview: top.length ? top[0].text.slice(0, 200) : null }
    });
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) });
  }
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
      .filter(s => s[1] && isTracked(String(s[1]).trim()))
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
      const result = timeSec && timeSec < Math.floor(Date.now() / 1000) - 60
        ? await getFlightsAt(timeSec)
        : await getFlights();
      try { rag.ingestPayload(result, timeSec ? 'history' : 'live'); } catch { /* index is best-effort */ }
      sendJson(res, 200, result);
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
  if (p === '/api/carriers') {
    sendJson(res, 200, { carriers: CARRIERS });
    return;
  }
  if (p === '/api/chat' && req.method === 'GET') {
    const c = chatCredentialCandidates(req);
    sendJson(res, 200, { ok: c.length > 0, sources: c.map(x => x.via), debug: chatDebug(req), index: rag.stats() });
    return;
  }
  if (p === '/api/chat' && req.method === 'POST') {
    await handleChat(req, res);
    return;
  }
  if (p === '/api/health') {
    sendJson(res, 200, { ok: true, demo: DEMO, hasCache: !!cache, coolingDown: cooldownUntil > Date.now() });
    return;
  }
  serveStatic(req, res, p);
});

// Seed the RAG index with the disk cache and today's schedule.
try {
  if (cache) rag.ingestPayload(cache, 'cache');
  const sched = scheduleForDate(new Date().toISOString().slice(0, 10));
  if (sched && sched.flights) {
    for (const f of sched.flights) {
      rag.ingestText('schedule', `scheduled flight ${f.callsign}/${f.flight} ${f.departure} -> ${f.arrival}, dep ${new Date(f.depSec * 1000).toISOString()}, arr ${new Date(f.arrSec * 1000).toISOString()}, duration ${f.durationMin} min, date ${sched.date}`);
    }
  }
} catch { /* index seeding is best-effort */ }

server.listen(PORT, HOST, () => {
  console.log(`Middle East flight tracker running at http://${HOST}:${PORT}  (demo=${DEMO}, min upstream interval=${MIN_UPSTREAM_MS / 1000}s, rag chunks=${rag.stats().chunks})`);
});
