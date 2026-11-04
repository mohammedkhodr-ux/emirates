import base64
import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from . import sim

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(BASE_DIR, "static")

LIVE_CACHE = {"ts": 0, "payload": None}
CACHE_TTL = 15

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".map": "application/json",
}


def opensky_states(time_param=None):
    if os.environ.get("DISABLE_LIVE"):
        return None
    url = "https://opensky-network.org/api/states/all"
    if time_param:
        url += "?time=%d" % int(time_param)
    req = urllib.request.Request(url, headers={"User-Agent": "emirates-tracker/1.0"})
    user = os.environ.get("OPEN_SKY_USER")
    pw = os.environ.get("OPEN_SKY_PASS")
    if user and pw:
        token = base64.b64encode((user + ":" + pw).encode()).decode()
        req.add_header("Authorization", "Basic " + token)
    with urllib.request.urlopen(req, timeout=12) as resp:
        data = json.loads(resp.read().decode())
    flights = []
    for s in data.get("states") or []:
        callsign = (s[1] or "").strip().upper()
        if not callsign.startswith("UAE"):
            continue
        if s[6] is None or s[5] is None:
            continue
        flights.append({
            "callsign": callsign,
            "flight": "EK" + callsign[3:],
            "icao24": s[0],
            "lat": round(s[6], 5),
            "lon": round(s[5], 5),
            "altitude_m": round(s[7]) if s[7] else None,
            "altitude_ft": round(s[7] * 3.28084) if s[7] else None,
            "speed_kmh": round(s[9] * 3.6) if s[9] else None,
            "heading": round(s[10]) if s[10] is not None else None,
            "on_ground": bool(s[8]),
            "origin": None,
            "destination": None,
            "dep": None,
            "arr": None,
            "source": "opensky",
        })
    flights.sort(key=lambda f: f["callsign"])
    return {"time": int(data.get("time") or time.time()), "source": "opensky", "count": len(flights), "flights": flights}


def flights_payload(time_param=None):
    now = int(time.time())
    if time_param is None or int(time_param) >= now - 30:
        if LIVE_CACHE["payload"] and now - LIVE_CACHE["ts"] < CACHE_TTL:
            return LIVE_CACHE["payload"]
        live = opensky_states()
        if live:
            LIVE_CACHE.update(ts=now, payload=live)
            return live
        payload = {
            "time": now,
            "source": "sample",
            "count": 0,
            "flights": sim.active_flights(now),
            "note": "Live feed unavailable; showing simulated schedule data. Set OPEN_SKY_USER/OPEN_SKY_PASS or remove DISABLE_LIVE for real data.",
        }
        payload["count"] = len(payload["flights"])
        LIVE_CACHE.update(ts=now, payload=payload)
        return payload
    live = opensky_states(time_param)
    if live:
        return live
    flights = sim.active_flights(time_param)
    return {"time": int(time_param), "source": "sample", "count": len(flights), "flights": flights}


def valid_date(s):
    try:
        datetime.strptime(s, "%Y-%m-%d")
        return True
    except (ValueError, TypeError):
        return False


class Handler(BaseHTTPRequestHandler):
    server_version = "EmiratesTracker/1.0"

    def log_message(self, fmt, *args):
        pass

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _static(self, path):
        if path in ("/", "/index.html"):
            path = "/index.html"
        rel = path.lstrip("/")
        if rel.startswith("static/"):
            rel = rel[len("static/"):]
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            self._json({"error": "not found"}, 404)
            return
        ext = os.path.splitext(full)[1].lower()
        with open(full, "rb") as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        try:
            if path == "/api/health":
                self._json({"ok": True, "time": int(time.time())})
            elif path == "/api/meta":
                self._json({
                    "airports": sim.AIRPORTS_LIST,
                    "route_count": len(sim.ROUTES),
                    "live_enabled": not os.environ.get("DISABLE_LIVE"),
                    "opensky_auth": bool(os.environ.get("OPEN_SKY_USER")),
                    "server_time": int(time.time()),
                })
            elif path == "/api/flights":
                t = qs.get("time", [None])[0]
                t = int(t) if t and t.isdigit() else None
                self._json(flights_payload(t))
            elif path == "/api/flights/day":
                date_str = qs.get("date", [datetime.now(timezone.utc).strftime("%Y-%m-%d")])[0]
                if not valid_date(date_str):
                    self._json({"error": "date must be YYYY-MM-DD"}, 400)
                    return
                flights = sim.day_flights(date_str)
                self._json({"date": date_str, "source": "sample", "count": len(flights), "flights": flights})
            elif path == "/api/track":
                callsign = qs.get("callsign", [""])[0]
                date_str = qs.get("date", [datetime.now(timezone.utc).strftime("%Y-%m-%d")])[0]
                if not valid_date(date_str):
                    self._json({"error": "date must be YYYY-MM-DD"}, 400)
                    return
                track = sim.track(callsign, date_str)
                if not track:
                    self._json({"error": "flight not found", "callsign": callsign, "date": date_str}, 404)
                    return
                self._json(track)
            else:
                self._static(path)
        except BrokenPipeError:
            pass
        except Exception as exc:
            self._json({"error": str(exc)}, 500)


def make_server(host, port):
    return ThreadingHTTPServer((host, port), Handler)
