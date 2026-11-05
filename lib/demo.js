'use strict';

const { AIRPORTS } = require('./airports');

const DXB = { lat: 25.2532, lon: 55.3657 };

// [arrivalIcao, flightNumber, flightHours, cruiseFt] — Emirates trunk routes (also used by the schedule chart).
const ROUTES = [
  ['LHR', 201, 6.9, 37000], ['LHR', 202, 6.8, 39000],
  ['JFK', 211, 13.9, 37000], ['EWR', 212, 13.5, 39000],
  ['LAX', 221, 15.8, 39000], ['SFO', 222, 15.2, 37000],
  ['IAD', 231, 13.2, 37000], ['ORD', 235, 13.9, 39000],
  ['BOS', 239, 8.0, 37000], ['YYZ', 241, 12.9, 39000],
  ['SEA', 242, 15.3, 37000], ['IAH', 243, 14.2, 39000],
  ['GRU', 251, 14.5, 37000], ['EZE', 252, 16.6, 37000],
  ['CDG', 301, 6.9, 37000], ['FRA', 303, 7.6, 39000],
  ['AMS', 305, 7.4, 37000], ['MAD', 307, 7.2, 37000],
  ['ZRH', 309, 7.6, 39000], ['MUC', 311, 7.6, 37000],
  ['FCO', 313, 8.0, 39000], ['IST', 315, 4.9, 37000],
  ['SIN', 321, 9.5, 39000], ['BKK', 341, 9.3, 37000],
  ['KUL', 351, 9.6, 39000], ['CGK', 361, 10.0, 37000],
  ['HKG', 371, 10.0, 39000], ['PEK', 381, 10.6, 39000],
  ['ICN', 391, 10.6, 39000], ['NRT', 401, 11.6, 39000],
  ['DEL', 421, 8.9, 39000], ['BOM', 431, 4.2, 37000],
  ['BLR', 435, 4.4, 37000], ['MAA', 441, 4.6, 39000],
  ['DOH', 501, 1.0, 35000], ['RUH', 511, 1.9, 35000],
  ['JED', 515, 1.8, 35000], ['KWI', 521, 1.0, 33000],
  ['BAH', 525, 0.9, 33000], ['MCT', 531, 1.1, 33000],
  ['JNB', 601, 10.0, 37000], ['CPT', 603, 10.9, 37000],
  ['LOS', 611, 7.0, 37000], ['NBO', 621, 7.6, 37000],
  ['CAI', 631, 5.2, 37000], ['MRU', 701, 5.9, 37000],
  ['SYD', 801, 17.0, 39000], ['MEL', 803, 17.6, 39000],
  ['AKL', 809, 21.5, 41000], ['PER', 811, 10.7, 39000]
];

// Simulated fleets of the tracked Middle East carriers.
// [prefix, hubIcao, country, [[arrIcao, flightNo, hours, cruiseFt], ...]]
const FLEETS = [
  { prefix: 'UAE', hub: 'OMDB', country: 'United Arab Emirates', routes: ROUTES.map(r => [r[0], r[1], r[2], r[3]]) },
  { prefix: 'FDB', hub: 'OMDB', country: 'United Arab Emirates', routes: [
    ['LHR', 301, 6.8, 37000], ['DEL', 303, 8.6, 37000], ['BOM', 311, 4.2, 35000],
    ['IST', 321, 4.9, 35000], ['DOH', 331, 1.0, 31000], ['KWI', 341, 1.0, 31000],
    ['RUH', 351, 1.9, 33000], ['JED', 361, 1.8, 33000], ['MCT', 371, 1.1, 31000],
    ['CAI', 381, 5.2, 35000], ['AMM', 391, 1.1, 31000], ['BKK', 395, 9.3, 37000]
  ] },
  { prefix: 'ABY', hub: 'SHJ', country: 'United Arab Emirates', routes: [
    ['LHR', 401, 7.2, 35000], ['DEL', 411, 8.9, 37000], ['BOM', 421, 4.4, 33000],
    ['CAI', 431, 4.6, 33000], ['AMM', 441, 0.9, 29000], ['RUH', 451, 1.7, 31000],
    ['IST', 471, 5.3, 35000], ['KWI', 481, 1.2, 31000]
  ] },
  { prefix: 'QTR', hub: 'DOH', country: 'Qatar', routes: [
    ['LHR', 601, 6.7, 37000], ['JFK', 611, 13.5, 39000], ['CDG', 621, 6.7, 37000],
    ['FRA', 631, 7.4, 39000], ['SIN', 641, 9.3, 39000], ['BOM', 651, 3.9, 35000],
    ['IST', 661, 4.2, 35000], ['RUH', 671, 1.7, 33000], ['LAX', 681, 15.6, 39000],
    ['DEL', 691, 9.0, 37000]
  ] },
  { prefix: 'SVA', hub: 'RUH', country: 'Saudi Arabia', routes: [
    ['LHR', 701, 9.3, 39000], ['JFK', 711, 14.0, 39000], ['CDG', 721, 8.5, 37000],
    ['DEL', 731, 9.2, 37000], ['BOM', 741, 4.6, 35000], ['CAI', 751, 4.4, 35000],
    ['IST', 761, 5.6, 37000], ['JED', 771, 0.7, 29000], ['OMDB', 781, 1.9, 33000],
    ['DOH', 791, 0.8, 29000]
  ] },
  { prefix: 'NAS', hub: 'RUH', country: 'Saudi Arabia', routes: [
    ['JED', 801, 0.7, 29000], ['OMDB', 811, 1.9, 31000], ['DOH', 821, 0.8, 29000],
    ['CAI', 831, 4.4, 33000], ['IST', 841, 5.6, 35000]
  ] },
  { prefix: 'ETD', hub: 'OMAA', country: 'United Arab Emirates', routes: [
    ['LHR', 901, 6.8, 37000], ['JFK', 911, 13.6, 39000], ['CDG', 921, 6.8, 37000],
    ['FRA', 931, 7.5, 39000], ['SIN', 941, 9.4, 39000], ['BOM', 951, 4.3, 35000],
    ['IST', 961, 4.8, 35000], ['TLV', 971, 3.7, 35000], ['OMDB', 981, 0.8, 29000],
    ['DOH', 991, 1.1, 31000]
  ] }
];

const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;

function gcPoint(a, b, f) {
  const p1 = toRad(a.lat), l1 = toRad(a.lon), p2 = toRad(b.lat), l2 = toRad(b.lon);
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2
  ));
  if (!d) return { lat: a.lat, lon: a.lon };
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
  const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
  const z = A * Math.sin(p1) + B * Math.sin(p2);
  return { lat: toDeg(Math.atan2(z, Math.hypot(x, y))), lon: toDeg(Math.atan2(y, x)) };
}

function bearing(a, b) {
  const p1 = toRad(a.lat), p2 = toRad(b.lat), dl = toRad(b.lon - a.lon);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function distNm(a, b) {
  const p1 = toRad(a.lat), l1 = toRad(a.lon), p2 = toRad(b.lat), l2 = toRad(b.lon);
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2
  ));
  return d * 3440.065;
}

// Flattened fleet list: [prefix, hub, country, arrIcao, flightNo, hours, cruiseFt]
function fleetList() {
  const out = [];
  for (const f of FLEETS) {
    for (const r of f.routes) out.push([f.prefix, f.hub, f.country, r[0], r[1], r[2], r[3]]);
  }
  return out;
}

const FLEET = fleetList();

function icaoForIndex(i) {
  return (0x896000 + i * 0x13).toString(16);
}

// Simulated fleet of all tracked Middle East carriers, each on great-circle
// routes out of its hub.
function demoFlights(nowSec) {
  const out = [];
  FLEET.forEach((r, i) => {
    const [prefix, hubIcao, country, arrIcao, fl, hours, cruiseFt] = r;
    const hub = AIRPORTS[hubIcao];
    const arr = AIRPORTS[arrIcao];
    if (!hub || !arr) return;
    const dur = hours * 3600;
    const phase = ((nowSec / dur) + i * 0.618034) % 1;
    const p = gcPoint(hub, arr, phase);
    const cruiseM = cruiseFt / 3.28084;
    let altM, vr;
    if (phase < 0.1) { altM = cruiseM * (phase / 0.1); vr = 8; }
    else if (phase > 0.9) { altM = cruiseM * ((1 - phase) / 0.1); vr = -8; }
    else { altM = cruiseM; vr = 0; }
    const speedMs = (distNm(hub, arr) * 1852 / dur) * (1 + 0.03 * Math.sin(i));
    out.push({
      icao24: icaoForIndex(i),
      callsign: prefix + fl,
      country,
      timePosition: nowSec,
      lastContact: nowSec,
      lon: p.lon,
      lat: p.lat,
      altitudeM: altM,
      altitudeFt: Math.round(altM * 3.28084),
      onGround: false,
      speedMs,
      speedKn: Math.round(speedMs * 1.94384),
      track: bearing(gcPoint(hub, arr, Math.max(0, phase - 0.001)), gcPoint(hub, arr, Math.min(1, phase + 0.001))),
      verticalRateMps: vr,
      verticalRateFpm: Math.round(vr * 196.85),
      geoAltitudeM: altM + 30,
      squawk: null,
      spi: false,
      positionSource: 0,
      category: 4,
      sensors: [101, 202, 303],
      sensorCount: 3,
      departure: hubIcao,
      arrival: arrIcao
    });
  });
  out.push({
    icao24: '896ff0', callsign: 'UAE8AB', country: 'United Arab Emirates',
    timePosition: nowSec, lastContact: nowSec,
    lon: 55.3414, lat: 25.2567,
    altitudeM: 0, altitudeFt: 0, onGround: true,
    speedMs: 0, speedKn: 0, track: 90,
    verticalRateMps: 0, verticalRateFpm: 0,
    geoAltitudeM: 0, squawk: null, spi: false, positionSource: 0, category: 4,
    sensors: [101], sensorCount: 1,
    departure: null, arrival: null
  });
  return out;
}

// Breadcrumb trail of one simulated aircraft over the ~3 h around timeSec.
function demoTrack(icao24, timeSec) {
  const idx = FLEET.findIndex((r, i) => icaoForIndex(i) === String(icao24).toLowerCase());
  if (idx === -1) return null;
  const [prefix, hubIcao, , arrIcao, fl, hours, cruiseFt] = FLEET[idx];
  const hub = AIRPORTS[hubIcao];
  const arr = AIRPORTS[arrIcao];
  if (!hub || !arr) return null;
  const dur = hours * 3600;
  const phase = ((timeSec / dur) + idx * 0.618034) % 1;
  const cruiseM = (cruiseFt || 37000) / 3.28084;
  const pts = [];
  const back = Math.min(phase, 3 * 3600 / dur);
  for (let p = phase - back; p <= phase + 1e-9; p += (10 * 60) / dur) {
    const pp = Math.max(0, Math.min(1, p));
    const pos = gcPoint(hub, arr, pp);
    let altM;
    if (pp < 0.1) altM = cruiseM * (pp / 0.1);
    else if (pp > 0.9) altM = cruiseM * ((1 - pp) / 0.1);
    else altM = cruiseM;
    pts.push([
      Math.round(timeSec - (phase - pp) * dur),
      Number(pos.lat.toFixed(5)),
      Number(pos.lon.toFixed(5)),
      Math.round(altM),
      Math.round(bearing(gcPoint(hub, arr, Math.max(0, pp - 0.001)), gcPoint(hub, arr, Math.min(1, pp + 0.001))))
    ]);
  }
  return {
    icao24: icaoForIndex(idx),
    callsign: prefix + fl,
    departure: hubIcao,
    arrival: arrIcao,
    source: 'demo',
    path: pts
  };
}

module.exports = { demoFlights, demoTrack, ROUTES, DXB, FLEETS, gcPoint, bearing, icaoForIndex };
