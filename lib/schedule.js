'use strict';

const { ROUTES, DXB } = require('./demo');
const { AIRPORTS } = require('./airports');

function hash01(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h / 4294967296;
}

function parseDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(t)) return null;
  return t;
}

// Deterministic typical daily schedule: 1-3 departures per route per UTC day.
function scheduleForDate(dateStr) {
  const dayStartMs = parseDate(dateStr);
  if (dayStartMs == null) return null;
  const dayStart = dayStartMs / 1000;
  const flights = [];
  ROUTES.forEach((r, i) => {
    const [arrIcao, fl, hours] = r;
    const arr = AIRPORTS[arrIcao];
    if (!arr) return;
    const callsign = 'UAE' + fl;
    const k = hours <= 2 ? 3 : hours >= 12 ? 2 : 1;
    const dur = hours * 3600;
    for (let j = 0; j < k; j++) {
      const jitter = (hash01(callsign + '|' + dateStr + '|' + j) - 0.5) * 1800;
      const dep = Math.round(dayStart + (j + hash01(callsign + dateStr) * 0.8) * (86400 / k) + jitter);
      flights.push({
        icao24: (0x896000 + i * 0x13).toString(16),
        callsign,
        flight: 'EK' + fl,
        departure: 'OMDB',
        arrival: arrIcao,
        depSec: dep,
        arrSec: dep + Math.round(dur),
        durationMin: Math.round(dur / 60)
      });
    }
  });
  flights.sort((a, b) => a.depSec - b.depSec);
  return { date: dateStr, source: 'demo', count: flights.length, flights };
}

module.exports = { scheduleForDate };
