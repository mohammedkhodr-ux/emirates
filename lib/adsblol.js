'use strict';

// adsb.lol (api.adsb.lol/v2) — keyless community ADS-B API, no rate limits for
// personal use. Same readsb schema as adsb.fi/airplanes.live mirrors, but
// richer than OpenSky: includes registration (r), aircraft type (t), full
// description (desc), operator (ownOp), IAS/TAS/Mach, wind, OAT, nav modes…
// Used to enrich tracked flights and as a fallback source when OpenSky is
// rate-limited or down.

const BASE = process.env.ADSB_BASE || 'https://api.adsb.lol/v2';

async function fetchHex(hex, timeoutMs = 10000) {
  const r = await fetch(`${BASE}/hex/${String(hex).toLowerCase()}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error('adsb.lol HTTP ' + r.status);
  const j = await r.json();
  return (j.ac && j.ac[0]) || null;
}

async function fetchMany(hexes, concurrency = 8) {
  const out = new Map();
  const list = [...new Set(hexes)].filter(Boolean);
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const hex = list[i++];
      try {
        const ac = await fetchHex(hex);
        if (ac) out.set(hex, ac);
      } catch { /* skip */ }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, worker));
  return out;
}

// readsb category letter -> OpenSky-style numeric category (approximate)
const CATEGORY_MAP = {
  A1: 2, A2: 3, A3: 4, A4: 6, A5: 6, A6: 6, A7: 7,
  B1: 3, B2: 4, B3: 4, B4: 6, B5: 6, B6: 7,
  C1: 8, C2: 8, D1: 10, D2: 10, D3: 10, D4: 10
};

// Map one readsb aircraft record to the tracker's flight shape.
function mapAc(ac, nowSec) {
  const onGround = ac.alt_baro === 'ground';
  const altFt = onGround ? 0 : (typeof ac.alt_baro === 'number' ? ac.alt_baro : null);
  const gs = typeof ac.gs === 'number' ? ac.gs : null;
  const vrFpm = typeof ac.baro_rate === 'number' ? ac.baro_rate : null;
  return {
    icao24: String(ac.hex || '').toLowerCase(),
    callsign: String(ac.flight || '').trim(),
    registration: ac.r || null,
    aircraftType: ac.t || null,
    aircraftDesc: ac.desc || null,
    operator: ac.ownOp || null,
    country: null,
    lat: typeof ac.lat === 'number' ? ac.lat : null,
    lon: typeof ac.lon === 'number' ? ac.lon : null,
    altitudeFt: altFt,
    altitudeM: altFt != null ? altFt / 3.28084 : null,
    geoAltitudeM: typeof ac.alt_geom === 'number' ? ac.alt_geom / 3.28084 : null,
    onGround,
    speedKn: gs,
    speedMs: gs != null ? gs / 1.94384 : null,
    iasKn: typeof ac.ias === 'number' ? ac.ias : null,
    tasKn: typeof ac.tas === 'number' ? ac.tas : null,
    mach: typeof ac.mach === 'number' ? ac.mach : null,
    track: typeof ac.track === 'number' ? ac.track : (typeof ac.true_heading === 'number' ? ac.true_heading : null),
    verticalRateFpm: vrFpm,
    verticalRateMps: vrFpm != null ? vrFpm / 196.85 : null,
    squawk: ac.squawk || null,
    spi: !!ac.spi,
    positionSource: (ac.type === 'mlat' || (Array.isArray(ac.mlat) && ac.mlat.length)) ? 2 : 0,
    category: CATEGORY_MAP[ac.category] ?? null,
    categoryCode: ac.category || null,
    sensors: null,
    sensorCount: null,
    rssi: typeof ac.rssi === 'number' ? ac.rssi : null,
    navQnh: typeof ac.nav_qnh === 'number' ? ac.nav_qnh : null,
    navAltitudeMcpFt: typeof ac.nav_altitude_mcp === 'number' ? ac.nav_altitude_mcp : null,
    navAltitudeFmsFt: typeof ac.nav_altitude_fms === 'number' ? ac.nav_altitude_fms : null,
    navHeading: typeof ac.nav_heading === 'number' ? ac.nav_heading : null,
    navModes: Array.isArray(ac.nav_modes) ? ac.nav_modes : null,
    windDir: typeof ac.wd === 'number' ? ac.wd : null,
    windSpdKn: typeof ac.ws === 'number' ? ac.ws : null,
    oatC: typeof ac.oat === 'number' ? ac.oat : null,
    tatC: typeof ac.tat === 'number' ? ac.tat : null,
    roll: typeof ac.roll === 'number' ? ac.roll : null,
    nic: typeof ac.nic === 'number' ? ac.nic : null,
    sil: typeof ac.sil === 'number' ? ac.sil : null,
    lastContact: nowSec - (typeof ac.seen === 'number' ? ac.seen : 0),
    timePosition: typeof ac.seen_pos === 'number' ? nowSec - ac.seen_pos : null,
    departure: null,
    arrival: null
  };
}

module.exports = { BASE, fetchHex, fetchMany, mapAc };
