'use strict';

// Middle East carriers tracked by the app. ATC callsigns start with one of
// `prefixes`; the commercial flight number uses the IATA code (e.g. UAE201 -> EK201).
const CARRIERS = [
  { id: 'EK', name: 'Emirates', iata: 'EK', color: '#d71920', prefixes: ['UAE'] },
  { id: 'FZ', name: 'flydubai', iata: 'FZ', color: '#22c55e', prefixes: ['FDB'] },
  { id: 'G9', name: 'Air Arabia', iata: 'G9', color: '#fb923c', prefixes: ['ABY'] },
  { id: 'QR', name: 'Qatar Airways', iata: 'QR', color: '#c026d3', prefixes: ['QTR'] },
  { id: 'SV', name: 'Saudia', iata: 'SV', color: '#38bdf8', prefixes: ['SVA'] },
  { id: 'NA', name: 'Nas Air', iata: 'NA', color: '#a855f7', prefixes: ['NAS', 'NES'] },
  { id: 'EY', name: 'Etihad Airways', iata: 'EY', color: '#fbbf24', prefixes: ['ETD'] }
];

function carrierOf(callsign) {
  if (!callsign) return null;
  const cs = String(callsign).trim().toUpperCase();
  for (const c of CARRIERS) {
    for (const p of c.prefixes) {
      if (cs.startsWith(p)) return c;
    }
  }
  return null;
}

// Commercial flight number from a callsign, e.g. UAE201 -> EK201, QTR123 -> QR123.
function flightNumber(callsign) {
  const c = carrierOf(callsign);
  if (!c) return null;
  return c.iata + String(callsign).trim().slice(c.prefixes.find(p => String(callsign).trim().toUpperCase().startsWith(p)).length);
}

module.exports = { CARRIERS, carrierOf, flightNumber };
