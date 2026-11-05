'use strict';

// In-memory RAG index over all flight data the app collects: one chunk per
// flight per snapshot (live polls and historical replays), plus schedule
// chunks. Chunks are embedded with the Mistral embeddings API when app-level
// credentials exist (service-account token / MISTRAL_API_KEY); retrieval
// falls back to keyword scoring otherwise.

const fs = require('fs');

const API_BASE = (process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai').replace(/\/$/, '');
const MAX_CHUNKS = 6000;
const chunks = []; // { id, kind, text, vec, at }
let seq = 0;

function appEmbedCredential() {
  const saPath = process.env.MISTRAL_SA_TOKEN_PATH;
  if (saPath) {
    try {
      const t = fs.readFileSync(saPath, 'utf8').trim();
      if (t) return { token: t, base: API_BASE + '/v1' };
    } catch { /* not mounted */ }
  }
  if (process.env.MISTRAL_API_KEY) return { token: process.env.MISTRAL_API_KEY, base: API_BASE + '/v1' };
  return null;
}

async function embedTexts(texts, cred) {
  if (!cred || !texts.length) return null;
  try {
    const r = await fetch(cred.base + '/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cred.token },
      body: JSON.stringify({ model: process.env.EMBED_MODEL || 'mistral-embed', input: texts }),
      signal: AbortSignal.timeout(20000)
    });
    if (!r.ok) return null;
    const j = await r.json();
    const arr = (j.data || []).map(d => d.embedding);
    return Array.isArray(arr) && arr.length === texts.length ? arr : null;
  } catch {
    return null;
  }
}

// Complete text of one flight snapshot — every field the tracker collects.
function flightChunkText(f, label) {
  const c = f.carrier || {};
  const ap = (a, code) => (a && a.name) ? `${code} ${a.name}` : (code || '?');
  const ago = s => s == null ? 'n/a' : Math.max(0, Math.round(Date.now() / 1000 - s)) + 's ago';
  return [
    `flight ${f.callsign}/${f.flightNumber || '?'} ${c.name || ''}`,
    `icao24 ${f.icao24}`,
    `registration ${f.registration || 'n/a'}`,
    `aircraft ${f.aircraftType || 'n/a'}${f.aircraftDesc ? ' ' + f.aircraftDesc : ''}`,
    `route ${ap(f.departureAirport, f.departure)} -> ${ap(f.arrivalAirport, f.arrival)}`,
    f.lat != null ? `position ${f.lat.toFixed(4)}, ${f.lon.toFixed(4)}` : 'position n/a',
    `altitude ${f.altitudeFt != null ? f.altitudeFt + ' ft' : 'n/a'}${f.altitudeM != null ? ' (' + Math.round(f.altitudeM) + ' m baro)' : ''}${f.geoAltitudeM != null ? ', geo ' + Math.round(f.geoAltitudeM) + ' m' : ''}`,
    `on ground: ${f.onGround ? 'yes' : 'no'}`,
    `ground speed ${f.speedKn != null ? f.speedKn + ' kn' : 'n/a'}${f.speedMs != null ? ' (' + Math.round(f.speedMs * 3.6) + ' km/h, ' + f.speedMs.toFixed(1) + ' m/s)' : ''}`,
    `true track ${f.track != null ? Math.round(f.track) + ' deg' : 'n/a'}`,
    `vertical rate ${f.verticalRateFpm != null ? f.verticalRateFpm + ' fpm' : 'n/a'}${f.verticalRateMps != null ? ' (' + f.verticalRateMps.toFixed(1) + ' m/s)' : ''}`,
    `squawk ${f.squawk || 'n/a'}`, `spi ${f.spi ? 'yes' : 'no'}`,
    `position source ${['ADS-B', 'ASTERIX', 'MLAT', 'FLARM'][f.positionSource] || 'n/a'}`,
    `aircraft category ${f.category != null ? f.category : 'n/a'}`,
    `receivers ${f.sensorCount != null ? f.sensorCount : 'n/a'}`,
    `country ${f.country || 'n/a'}`,
    `last contact ${ago(f.lastContact)}`, `position fix ${ago(f.timePosition)}`,
    `snapshot ${label}`
  ].join(' | ');
}

function pushChunks(items) {
  for (const it of items) {
    const c = { id: ++seq, kind: it.kind, text: it.text, vec: null, at: Date.now() };
    chunks.push(c);
    it.chunk = c;
  }
  while (chunks.length > MAX_CHUNKS) chunks.shift();
  const texts = items.map(i => i.text);
  embedTexts(texts, appEmbedCredential()).then(vecs => {
    if (vecs) items.forEach((it, i) => { if (it.chunk) it.chunk.vec = vecs[i]; });
  }).catch(() => {});
}

// Ingest a /api/flights payload. Live snapshots replace previous live chunks;
// historical snapshots are appended (bounded).
function ingestPayload(payload, kind) {
  if (!payload || !Array.isArray(payload.flights)) return;
  if (kind === 'live' || kind === 'cache') {
    for (let i = chunks.length - 1; i >= 0; i--) {
      if (chunks[i].kind === 'live' || chunks[i].kind === 'cache') chunks.splice(i, 1);
    }
  }
  const label = `${kind} @ ${new Date(((payload.serverTime || Date.now() / 1000)) * 1000).toISOString()}`;
  pushChunks(payload.flights.map(f => ({ kind, text: flightChunkText(f, label) })));
}

function ingestText(kind, text) {
  pushChunks([{ kind, text }]);
}

function tokenize(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function kwScore(qTokens, text) {
  const t = tokenize(text);
  const set = new Set(t);
  let overlap = 0;
  for (const q of qTokens) if (set.has(q)) overlap++;
  return overlap / (1 + Math.sqrt(t.length));
}

function retrieve(query, k, queryVec) {
  k = k || 8;
  if (queryVec) {
    const scored = [];
    for (const c of chunks) if (c.vec) scored.push({ c, s: cosine(queryVec, c.vec) });
    scored.sort((a, b) => b.s - a.s);
    if (scored.length) return scored.slice(0, k).map(x => x.c);
  }
  const q = tokenize(query);
  const scored = chunks.map(c => ({ c, s: kwScore(q, c.text) }));
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, k).map(x => x.c);
}

function stats() {
  return { chunks: chunks.length, embedded: chunks.filter(c => c.vec).length, kinds: [...new Set(chunks.map(c => c.kind))] };
}

module.exports = { ingestPayload, ingestText, retrieve, stats, embedTexts, flightChunkText };
