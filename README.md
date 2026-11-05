# Middle East Airlines Tracker — Live & Historical

A map of **every tracked Middle East carrier in the sky — live or at any past
time**: Emirates, flydubai, Air Arabia, Qatar Airways, Saudia, Nas Air and
Etihad, each in its **own color** (click a legend chip to show/hide a carrier).
Hover any plane for its full data (callsign + flight number, route, altitude,
speed, heading, vertical rate, position, status). Each flight's path is drawn
split at the current position: **solid line = already travelled**, **dotted
line = remaining trajectory to destination**. A 💬 **chat assistant** (bottom
right) answers questions about any flight using live data.
Hover any plane for **all aviation details** (callsign + flight number, route,
position, baro/geo altitude, ground speed in kn/km/h, true track, vertical
rate, squawk, position source, aircraft category, country, last contact).
**Hover any plane** on the map to see its full data right next to it (a map
tooltip, not a side pane): callsign + flight number, route, baro/geo altitude,
speed, heading, vertical rate, status, position, country, squawk, position
source, category, last contact, ICAO24 — airborne and on-ground flights alike.
The tooltip stays open while the plane glides (the icon is only re-rendered
when its heading changes) and live-updates each refresh. Hovering a cluster
lists the flights inside; clicking a plane (or a route line/dot in Lines view,
or a sidebar row) still opens the map popup and flies to it. Planes uncluster
from zoom 7; sidebar rows keep a one-line hover summary.
Use the **status filter** (All / In the air / On the ground) to show only
airborne or only ground flights on the map, list, analytics and report.
The sidebar has three tabs: **Flights** (live list + search), **Analytics**
(per-airline counts, altitude/speed bands, top routes, highest/fastest), and
**Reports** (auto-generated Markdown report with a full flight table — copy or
download it). The 💬 chat assistant answers questions about any flight. Credential chain
(`POST /api/chat`, tried in order): the signed-in caller's gateway token
(`x-apps-token`) spent via the platform-injected apps proxy
(`__APPS_PROXY_URL`), the same token against the public API, the app's
service-account token (`MISTRAL_SA_TOKEN_PATH`), then a `MISTRAL_API_KEY` env
var. `GET /api/chat` reports which sources are available (never the values);
the chat panel shows this as its status line.
Red plane markers show real-time positions; you can zoom in/out (scroll wheel,
`+`/`-` buttons, double-click, pinch) or jump straight to any **continent**
(preset dropdown) or **country** (search box, or click the country on the map).
Click any plane or list entry to zoom to it, see altitude/speed/heading, and
draw its great-circle route (Dubai ↔ destination) plus its flown trail.
Every flight is shown with both identifiers — the ATC callsign `UAE###` and the
commercial flight number `EK###` — in the list, popups, line tooltips, marker
hover and search.

Two display formats: **map** (plane markers with clustering) or **lines**
(great-circle route lines for every flight), or both at once. The bottom bar
is a **line chart** of the typical daily schedule (airborne flights per hour)
— click it to scrub through time.

**Historical mode**: pick any date, then scrub the 24 h timeline (slider, chart
click, or ▶ play button) to replay which Emirates flights were airborne at that
moment — real OpenSky history when online, simulated schedule in demo mode.

![stack](https://img.shields.io/badge/stack-Node.js%20%2B%20Leaflet-red)

## Quick start

Requires Node.js ≥ 18. No `npm install` needed — zero dependencies (Leaflet is
vendored in `public/vendor/`).

```bash
node server.js
# then open http://localhost:3000
```

## Live movement on the map

Markers don't just jump on every poll — a `requestAnimationFrame` loop glides
each airborne plane along its true track and ground speed between updates, and
each poll corrects the position to the latest ADS-B fix. The header has two
toggles: **trails** draws a gold path behind each plane (last ~2 min of
positions), and **follow** keeps the map centered on the selected plane as it
flies.

## How it works

- `server.js` polls the [OpenSky Network](https://opensky-network.org) REST API
  (`/api/states/all`) and keeps only aircraft whose callsign starts with `UAE`
  — the Emirates ATC callsign prefix (e.g. `UAE201`).
- It also queries `/api/flights/all` (last 2 h) to attach the estimated
  departure/arrival airport of each flight, resolved via the built-in airport
  table in `lib/airports.js`.
- The browser (`public/app.js`) renders markers on a Leaflet map and refreshes
  every 45 s. Results are cached server-side (`.cache/flights.json`) so OpenSky
  rate limits are respected: if the API answers `429`, the app keeps showing
  the last good snapshot with a **CACHED** badge and honors the
  `X-Rate-Limit-Retry-After-Seconds` header.

## Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address (loopback only by default) |
| `DEMO` | `0` | `DEMO=1` serves simulated Emirates traffic (no internet needed) |
| `REFRESH_MIN_SECONDS` | `45` | Minimum seconds between upstream OpenSky calls |
| `OPENSKY_CLIENT_ID` | — | Optional OpenSky API client id (see below) |
| `OPENSKY_CLIENT_SECRET` | — | Optional OpenSky API client secret |

### OpenSky rate limits (2026)

Anonymous access: **400 credits/day** for `/states/*`; a global `/states/all`
sweep costs **4 credits** → ~100 sweeps/day. With a free OpenSky account you get
**4,000 credits/day** → comfortable 45 s polling. Since March 2026 OpenSky uses
**OAuth2 client credentials** (basic auth was retired):

1. Log in at opensky-network.org → Account → create an **API client**.
2. Export the credentials:
   ```bash
   export OPENSKY_CLIENT_ID=...
   export OPENSKY_CLIENT_SECRET=...
   node server.js
   ```

Without credentials the app works anonymously, but the upstream feed may fall
back to cached data once the daily credits run out.

## Demo mode

```bash
DEMO=1 node server.js
```

Generates ~50 simulated Emirates flights (UAE###) flying great-circle routes
out of Dubai (DXB) to major destinations, with realistic altitude/speed
profiles — useful for offline development or when the API is rate-limited.
The UI shows a **DEMO DATA** badge in that case. Historical mode (`?time=…`)
and `/api/track` also work against the simulated fleet, so the whole app is
fully usable offline (switch the basemap to "Vector only" if tiles are
unreachable; country polygons are vendored in `public/vendor/countries.geo.json`).

## Project structure

```
server.js               zero-dependency HTTP server (static + /api/*)
lib/opensky.js          OpenSky REST client (OAuth2 client-credentials or anonymous)
lib/airports.js         ICAO -> name/lat/lon table (Dubai hub + destinations)
lib/demo.js             simulated fleet generator + demo tracks (great-circle routes from DXB)
lib/schedule.js         deterministic typical daily schedule per UTC date
public/index.html       app shell (sidebar + map + timeline chart)
public/app.js           map, markers/lines, clustering, zoom controls, historical replay, chart
public/style.css        dark theme
public/vendor/          vendored Leaflet 1.9.4 + MarkerCluster 1.5.3 + world countries GeoJSON
```

## API

- `GET /api/flights` → `{ source: live|cached|demo, count, airborne, flights: [...] }`
  where each flight has `callsign, lat, lon, altitudeFt, speedKn, track,
  verticalRateFpm, onGround, lastContact, departure/arrival (+ airport info), …`
- `GET /api/flights?time=<unix-seconds>` → same payload with `historical: true`
  for any past timestamp (OpenSky `/states/all?time=…`, or simulated data in demo mode)
- `GET /api/track?icao24=<hex>&time=<unix-seconds>` → `{ path: [[ts, lat, lon, altM, track], …] }`
  (OpenSky `/tracks`, or simulated trail in demo mode)
- `GET /api/schedule?date=YYYY-MM-DD` → typical daily schedule (drives the line chart)
- `GET /api/health` → server status

## Data completeness

Every OpenSky state-vector field is collected and shown (hover tooltip / click
popup): icao24, callsign, carrier, flight number, country, position, fix time,
last contact, baro + geo altitude, on-ground, ground speed, true track,
vertical rate, sensors/receivers, squawk, SPI, position source, aircraft
category, plus estimated departure/arrival airports from `/flights/*`.

## RAG chat agent

`lib/rag.js` is an in-memory retrieval index behind `POST /api/chat`: every
`/api/flights` response (live **and** historical replays) is chunked per
flight and embedded (Mistral `mistral-embed` via the app's service-account
token or `MISTRAL_API_KEY`); the disk cache and the daily schedule are seeded
at startup. At chat time the user question is embedded and the top-8 chunks
are retrieved (cosine; keyword fallback when no embedding credentials) and
injected into the system prompt, so answers are grounded in the indexed
active + historical data. `GET /api/chat` reports credential sources and
index size; the chat panel shows both.

## Deploy to Mistral Apps (Vibe catalog)

The repo carries an `apps.json` manifest and `deploy/docker/Dockerfile`, so it
deploys to the Mistral Apps platform with the `mistral` CLI:

```bash
mistral apps deploy --yes     # builds from this repo and deploys the "production" alias
mistral apps publish          # adds the deployed app to the Vibe apps catalog
```

The platform builds the Docker image (Node 22, binds `0.0.0.0:$PORT`), runs
`node server.js`, and the gateway routes `/` to the module. Set
`OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` as app environment variables to
raise the OpenSky rate limit. `HOST` stays `127.0.0.1` for local runs and is
overridden to `0.0.0.0` inside the container.

## Data sources (no rate limits)

Primary: **OpenSky Network** (`/states/all` + `/flights/*`) — positions and
departure/arrival airports. Anonymous quota is 400 credits/day (a global
sweep costs 4), so the server caches and honors `Retry-After`.

Fallback + enrichment: **adsb.lol** (`api.adsb.lol/v2/hex/{icao24}`) — keyless
community ADS-B API with **no rate limits** for personal use. When OpenSky is
rate-limited/unreachable, the last known tracked aircraft are pulled live from
adsb.lol instead (badge shows `live via adsb.lol`); and every ~10 min the
tracked fleet is enriched from adsb.lol with fields OpenSky lacks:
**registration, aircraft type/description, operator, IAS/TAS/Mach, wind, OAT,
nav modes, RSSI** — all shown in the hover tooltip and click popup.

Other keyless options if you build on this further: adsb.fi open data
(ADS-B Exchange-compatible), avioadsb.org, and OpenSky's downloadable
aircraft-database CSV. Commercial schedule/status APIs (AviationStack,
AeroDataBox) need keys and have strict free-tier limits; airplanes.live
requires contacting them. Historical bulk data: adsb.lol/adsb.fi publish
daily tarballs; OpenSky history beyond 1 h needs Trino access.

Complete flight data programmatically: `GET /api/flights` (every field per
flight, JSON), `GET /api/track?icao24=…` (flown path), the Reports tab
(downloadable Markdown), or hover/click any plane in the UI.

## Data attribution

- Aircraft data: [The OpenSky Network](https://opensky-network.org) (CC BY-SA 4.0
  for the data; non-commercial use — commercial use requires a license).
- Map tiles: © [OpenStreetMap](https://www.openstreetmap.org/copyright)
  contributors, © [CARTO](https://carto.com/) (dark basemap).
- Map library: [Leaflet](https://leafletjs.com) (BSD-2-Clause),
  [leaflet.markercluster](https://github.com/Leaflet/leaflet.markercluster).

Unofficial fan project — not affiliated with or endorsed by Emirates.
