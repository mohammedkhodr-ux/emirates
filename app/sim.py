import hashlib
import json
import math
import os
from datetime import datetime, timedelta, timezone

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

with open(os.path.join(BASE_DIR, "data", "airports.json")) as fh:
    AIRPORTS_LIST = json.load(fh)
AIRPORTS = {a["iata"]: a for a in AIRPORTS_LIST}

with open(os.path.join(BASE_DIR, "data", "routes.json")) as fh:
    ROUTES = json.load(fh)

EARTH_R_KM = 6371.0
CRUISE_KMH = 880.0
CRUISE_M = 11000.0
DAY_CACHE = {}


def _hash01(*parts):
    digest = hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()
    return int(digest[:8], 16) / 0xFFFFFFFF


def _to_vec(lat, lon):
    lat_r = math.radians(lat)
    lon_r = math.radians(lon)
    return (math.cos(lat_r) * math.cos(lon_r), math.cos(lat_r) * math.sin(lon_r), math.sin(lat_r))


def _to_latlon(v):
    x, y, z = v
    lat = math.degrees(math.asin(max(-1.0, min(1.0, z))))
    lon = math.degrees(math.atan2(y, x))
    return lat, lon


def gc_distance_km(a, b):
    lat1, lon1 = math.radians(a["lat"]), math.radians(a["lon"])
    lat2, lon2 = math.radians(b["lat"]), math.radians(b["lon"])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_R_KM * math.asin(math.sqrt(h))


def slerp(a, b, t):
    va = _to_vec(a["lat"], a["lon"])
    vb = _to_vec(b["lat"], b["lon"])
    dot = max(-1.0, min(1.0, sum(x * y for x, y in zip(va, vb))))
    omega = math.acos(dot)
    if omega < 1e-9:
        return a["lat"], a["lon"]
    so = math.sin(omega)
    ka = math.sin((1 - t) * omega) / so
    kb = math.sin(t * omega) / so
    v = tuple(ka * x + kb * y for x, y in zip(va, vb))
    return _to_latlon(v)


def bearing_deg(a, b):
    lat1, lon1 = math.radians(a["lat"]), math.radians(a["lon"])
    lat2, lon2 = math.radians(b["lat"]), math.radians(b["lon"])
    dlon = lon2 - lon1
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def route_points(a, b, n=96):
    return [slerp(a, b, i / (n - 1)) for i in range(n)]


def expand_day(date_str):
    if date_str in DAY_CACHE:
        return DAY_CACHE[date_str]
    day = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    flights = []
    seq = 0
    for route in ROUTES:
        origin = AIRPORTS[route["from"]]
        dest = AIRPORTS[route["to"]]
        dist = gc_distance_km(origin, dest)
        duration_s = dist / CRUISE_KMH * 3600.0 + 1800.0
        for dep in route["deps"]:
            seq += 1
            number = "%03d" % seq
            callsign = "UAE" + number
            hh, mm = dep.split(":")
            jitter_s = (_hash01(callsign, date_str) - 0.5) * 1800.0
            dep_epoch = int(day.timestamp() + int(hh) * 3600 + int(mm) * 60 + jitter_s)
            flights.append({
                "callsign": callsign,
                "flight": "EK" + number,
                "origin": route["from"],
                "destination": route["to"],
                "origin_name": origin["name"] + " (" + origin["city"] + ")",
                "dest_name": dest["name"] + " (" + dest["city"] + ")",
                "dep": dep_epoch,
                "arr": dep_epoch + int(duration_s),
                "distance_km": round(dist),
            })
    DAY_CACHE[date_str] = flights
    return flights


def _position(flight, t):
    p = (t - flight["dep"]) / (flight["arr"] - flight["dep"])
    if p < 0 or p > 1:
        return None
    origin = AIRPORTS[flight["origin"]]
    dest = AIRPORTS[flight["destination"]]
    lat, lon = slerp(origin, dest, p)
    if p < 0.08:
        alt = CRUISE_M * (p / 0.08)
    elif p > 0.92:
        alt = CRUISE_M * ((1 - p) / 0.08)
    else:
        alt = CRUISE_M
    nlat, nlon = slerp(origin, dest, min(1.0, p + 0.002))
    heading = bearing_deg({"lat": lat, "lon": lon}, {"lat": nlat, "lon": nlon})
    return {
        "callsign": flight["callsign"],
        "flight": flight["flight"],
        "origin": flight["origin"],
        "destination": flight["destination"],
        "origin_name": flight["origin_name"],
        "dest_name": flight["dest_name"],
        "lat": round(lat, 5),
        "lon": round(lon, 5),
        "altitude_m": round(alt),
        "altitude_ft": round(alt * 3.28084),
        "speed_kmh": round(CRUISE_KMH),
        "heading": round(heading),
        "progress": round(p, 4),
        "dep": flight["dep"],
        "arr": flight["arr"],
        "on_ground": p < 0.01 or p > 0.99,
        "source": "sample",
    }


def active_flights(t):
    t = int(t)
    date_str = datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%d")
    prev_str = (datetime.fromtimestamp(t, tz=timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")
    out = []
    for flight in expand_day(date_str) + expand_day(prev_str):
        if flight["dep"] <= t <= flight["arr"]:
            pos = _position(flight, t)
            if pos:
                out.append(pos)
    out.sort(key=lambda f: f["callsign"])
    return out


def day_flights(date_str):
    return expand_day(date_str)


def _normalize_callsign(callsign):
    cs = callsign.strip().upper()
    if cs.startswith("EK"):
        cs = "UAE" + cs[2:]
    if cs.startswith("UAE") and cs[3:].isdigit():
        cs = "UAE%03d" % int(cs[3:])
    return cs


def find_flight(callsign, date_str):
    cs = _normalize_callsign(callsign)
    for flight in expand_day(date_str):
        if flight["callsign"] == cs:
            return flight
    prev = (datetime.strptime(date_str, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
    for flight in expand_day(prev):
        if flight["callsign"] == cs and flight["arr"] > int(datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()):
            return flight
    return None


def track(callsign, date_str):
    flight = find_flight(callsign, date_str)
    if not flight:
        return None
    points = []
    t = flight["dep"]
    while t <= flight["arr"]:
        pos = _position(flight, t)
        if pos:
            points.append([pos["lat"], pos["lon"], pos["altitude_m"], t, pos["heading"]])
        t += 300
    return {"callsign": flight["callsign"], "flight": flight["flight"], "origin": flight["origin"], "destination": flight["destination"], "source": "sample", "points": points}
