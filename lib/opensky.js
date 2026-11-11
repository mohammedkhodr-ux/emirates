'use strict';

const API_BASE = 'https://opensky-network.org/api';
const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

// Minimal OpenSky Network REST client. Anonymous by default; if
// OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET are provided, uses the OAuth2
// client-credentials flow (Bearer token, refreshed before expiry).
class OpenskyClient {
  constructor(opts = {}) {
    this.clientId = opts.clientId || null;
    this.clientSecret = opts.clientSecret || null;
    this.timeoutMs = opts.timeoutMs || 20000;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async getToken() {
    if (!this.clientId || !this.clientSecret) return null;
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt) return this.token;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret
    });
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!res.ok) throw new Error('OpenSky token request failed: HTTP ' + res.status);
    const json = await res.json();
    if (!json.access_token) throw new Error('OpenSky token response missing access_token');
    this.token = json.access_token;
    const expiresIn = Number(json.expires_in || 1800);
    this.tokenExpiresAt = now + Math.max(60, expiresIn - 60) * 1000;
    return this.token;
  }

  async authHeaders() {
    try {
      const t = await this.getToken();
      return t ? { Authorization: 'Bearer ' + t } : {};
    } catch {
      return {};
    }
  }

  async fetchStatesAll(timeSec) {
    let url = API_BASE + '/states/all?extended=1';
    if (timeSec) url += '&time=' + Math.floor(timeSec);
    return fetch(url, {
      headers: await this.authHeaders(),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
  }

  // Recent flights (last `windowSec` seconds) -> departure/arrival airports per callsign.
  async fetchRecentFlights(windowSec) {
    const end = Math.floor(Date.now() / 1000);
    return this.fetchFlightsRange(end - windowSec, end);
  }

  async fetchFlightsRange(begin, end) {
    return fetch(`${API_BASE}/flights/all?begin=${Math.floor(begin)}&end=${Math.floor(end)}`, {
      headers: await this.authHeaders(),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
  }

  // Breadcrumb track of one aircraft around `timeSec` (requires auth for good data).
  async fetchTrack(icao24, timeSec) {
    const t = timeSec || Math.floor(Date.now() / 1000);
    return fetch(`${API_BASE}/tracks?icao24=${encodeURIComponent(icao24)}&time=${t}`, {
      headers: await this.authHeaders(),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
  }
}

module.exports = { OpenskyClient };
