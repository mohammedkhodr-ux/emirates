# Emirates Flight Tracker

A self-contained web app that tracks **live and historical Emirates flights (EK flight numbers, `UAE` callsign prefix)** around the world on an interactive zoomable map.

- **Live mode** — real aircraft positions from the free [OpenSky Network](https://opensky-network.org/) ADS-B feed (all callsigns starting with `UAE`), refreshed every 15 s. Falls back to a realistic simulated schedule if the feed is unreachable.
- **Historical mode** — pick any date and scrub a 24 h timeline (slider, chart click, or play button) to replay every Emirates flight that was airborne at that moment.
- **Zoom anywhere** — continent presets, a country search box, or click any country on the map to zoom to it. Mouse wheel zoom works at every level.
- **Map or line format** — toggle between plane markers, great-circle route lines, or both; the bottom panel is a line chart of airborne flights per hour for the selected day.

## Run

Requires only Python 3.8+ (standard library only, no pip installs):

```bash
python3 run.py            # serves http://127.0.0.1:8000
python3 run.py --port 9000
```

Open http://127.0.0.1:8000 in a browser.

## Real data (optional)

Live/historical positions come from OpenSky's free API. Anonymous access works with tight rate limits; for higher limits set credentials:

```bash
export OPEN_SKY_USER=your_opensky_username
export OPEN_SKY_PASS=your_opensky_password
python3 run.py
```

- `GET /api/flights` — live flights (uses OpenSky when reachable, else the built-in simulated schedule)
- `GET /api/flights?time=<unix epoch>` — flights airborne at any past moment (OpenSky history or simulation)
- `GET /api/flights/day?date=YYYY-MM-DD` — full simulated schedule for a day
- `GET /api/track?callsign=UAE001&date=YYYY-MM-DD` — breadcrumb track of one flight
- `GET /api/meta` — airports and route metadata

To use a different feed (FlightRadar24, ADS-B Exchange, Aviationstack, or your own CSV export), adapt `opensky_states()` in `app/server.py`; the frontend only consumes the JSON schema above. Set `DISABLE_LIVE=1` to force simulated data.

## How the simulated data works

`app/sim.py` expands `app/data/routes.json` (Emirates route network with daily departure times) into flight instances per UTC day, then interpolates each flight along its great-circle path at 880 km/h cruise with a climb/cruise/descent altitude profile. Because it is deterministic per date, the same date always replays identically — live mode is simply "the schedule at the current time."

## Stack

- Backend: Python standard library (`http.server`) — zero dependencies
- Frontend: vanilla JS + [Leaflet 1.9.4](https://leafletjs.com/) (vendored in `static/vendor/`), world country boundaries vendored from [world.geo.json](https://github.com/johan/world.geo.json)
- Basemap tiles: CARTO dark or OpenStreetMap (loaded at runtime; if offline, switch the basemap to "Vector (offline)" and the app still works fully)

## Layout

```
run.py                  entry point
app/server.py           HTTP server + API + OpenSky proxy
app/sim.py              geo math + deterministic schedule simulation
app/data/airports.json  Emirates destinations (87 airports)
app/data/routes.json    route network with daily departures
static/index.html       UI shell
static/app.js           map, timeline, playback, chart
static/styles.css       dark theme
static/vendor/          Leaflet + countries.geo.json (offline-capable)
```
