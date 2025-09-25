from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import httpx, asyncio, math, os
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv
from .sensors.manager import SensorManager
load_dotenv()

app = FastAPI(title="Rockfall Realtime API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000","http://127.0.0.1:3000",
        "http://localhost:3006","http://127.0.0.1:3006",
        "http://localhost:3008","http://127.0.0.1:3008",
        "http://localhost:5173","http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
@app.get("/health")
def health_check():
    return {"status": "ok"}

# ---- WS client set ----
WS_CLIENTS: set[WebSocket] = set()
sensor_manager = SensorManager()

def _level(score: float) -> str:
    if score >= 70: return "HIGH"
    if score >= 40: return "MEDIUM"
    return "LOW"

class TelemetryResponse(BaseModel):
    coords: dict
    weather: dict
    rain_24h_mm: float
    seismic: dict
    risk: dict
    series: dict
    local_sensors: dict

# -------- helpers -------
async def fetch_open_meteo(lat: float, lon: float):
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": lat, "longitude": lon,
        "hourly": "precipitation,temperature_2m,relative_humidity_2m,wind_speed_10m",
        "current": "temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation",
        "timezone": "auto", "past_days": 1
    }
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(url, params=params)
        r.raise_for_status()
        j = r.json()
    hourly = j.get("hourly", {})
    precip = hourly.get("precipitation", []) or []
    rain_24h = float(sum(p or 0 for p in precip))
    cur = j.get("current", {})
    wx = {
        "temperature_c": cur.get("temperature_2m"),
        "humidity_pct": cur.get("relative_humidity_2m"),
        "wind_speed_ms": cur.get("wind_speed_10m"),
        "precip_rate_mm": cur.get("precipitation", 0.0),
    }
    times = hourly.get("time", []) or []
    labels, risk_pts, ai_pts = [], [], []
    want_times = ["00:00","04:00","08:00","12:00","16:00","20:00"]
    for want in want_times:
        idx = next((i for i,t in enumerate(times) if t.endswith(want)), None)
        p = float(precip[idx] or 0.0) if idx is not None and idx < len(precip) else 0.0
        rscore = 40.0 + min(40.0, p*10.0)
        ascore = min(85.0, rscore + 5.0)
        labels.append(want)
        risk_pts.append(round(rscore,1))
        ai_pts.append(round(ascore,1))
    return wx, rain_24h, {"labels": labels, "risk": risk_pts, "ai": ai_pts}

async def fetch_usgs(lat: float, lon: float, radius_km: int = 200, hours: int = 24):
    start = (datetime.now(timezone.utc) - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
    url = "https://earthquake.usgs.gov/fdsnws/event/1/query"
    params = {
        "format": "geojson", "starttime": start,
        "latitude": lat, "longitude": lon, "maxradiuskm": radius_km
    }
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(url, params=params)
        r.raise_for_status()
        j = r.json()
    feats = j.get("features", []) or []
    events = []
    strongest = 0.0
    for f in feats:
        props = f.get("properties", {}) or {}
        geom = f.get("geometry", {}) or {}
        c = geom.get("coordinates", [None, None, None])
        mag = float(props.get("mag") or 0.0)
        strongest = max(strongest, mag)
        events.append({
            "time": datetime.utcfromtimestamp((props.get("time") or 0)/1000).isoformat()+"Z",
            "magnitude": mag,
            "depth_km": float(c[2]) if len(c)>2 and c[2] is not None else None,
            "place": props.get("place"),
            "lat": float(c[1]) if len(c)>1 and c[1] is not None else None,
            "lon": float(c[0]) if len(c)>0 and c[0] is not None else None,
        })
    return {"count_last_24h": len(events), "strongest_mag": round(strongest,1), "events": events[:20]}

def compute_risk(wx: dict, rain_24h: float, seismic: dict, local: dict) -> dict:
    precip_rate = float(wx.get("precip_rate_mm") or 0.0)
    wind = float(wx.get("wind_speed_ms") or 0.0)
    rain_factor = min(100.0, rain_24h * 4.0)
    rate_boost  = min(30.0, precip_rate * 6.0)
    wind_factor = min(30.0, wind * 1.5)
    seis_mag    = float(seismic.get("strongest_mag") or 0.0)
    seis_count  = float(seismic.get("count_last_24h") or 0.0)
    seismic_factor = min(100.0, seis_mag*15.0 + min(20.0, seis_count*1.5))

    # Local sensor factor (normalize roughly to 0-100)
    crack = float(local.get("crackmeter", 0))
    vib   = float(local.get("vibration", 0))
    piezo = float(local.get("piezometer", 0))
    tilt  = float(local.get("tiltmeter", 0))
    # Assume thresholds: crack 25, vibration 12, piezo 20, tilt 25 (tune later)
    local_factor = min(100.0,
        (max(0.0, crack/25.0)*60.0) +
        (max(0.0, vib/12.0)*20.0) +
        (max(0.0, piezo/20.0)*10.0) +
        (max(0.0, tilt/25.0)*10.0)
    )

    score = 0.4*(rain_factor + rate_boost) + 0.25*seismic_factor + 0.15*wind_factor + 0.20*local_factor
    score = max(0.0, min(100.0, score))
    return {
        "score": round(score, 1),
        "level": "HIGH" if score>=70 else ("MEDIUM" if score>=40 else "LOW"),
        "factors": {
            "rain_24h": round(rain_24h,2),
            "precip_rate": precip_rate,
            "wind_speed": wind,
            "seismic_strongest_mag": seis_mag,
            "seismic_count_24h": seis_count,
            "local_factor": round(local_factor,1),
        }
    }

# -------- lifecycle: start sensor backends --------
@app.on_event("startup")
async def _startup():
    # When local sensors update, push to all WS clients
    def broadcaster(payload: dict):
        msg = {"type":"sensors","data":payload}
        data = json_dumps(msg)
        # schedule async send
        asyncio.create_task(_ws_broadcast(data))
    sensor_manager.set_on_update(broadcaster)
    await sensor_manager.start()

@app.on_event("shutdown")
async def _shutdown():
    await sensor_manager.stop()

# -------- WebSocket for live local sensors --------
async def _ws_broadcast(text: str):
    dead = []
    for ws in WS_CLIENTS:
        try:
            await ws.send_text(text)
        except Exception:
            dead.append(ws)
    for ws in dead:
        WS_CLIENTS.discard(ws)

@app.websocket("/ws/sensors")
async def sensors_ws(ws: WebSocket):
    await ws.accept()
    WS_CLIENTS.add(ws)
    # send snapshot immediately
    snap = await sensor_manager.snapshot()
    await ws.send_text(json_dumps({"type":"sensors","data":snap}))
    try:
        while True:
            await ws.receive_text()  # ignore pings/msgs
    except WebSocketDisconnect:
        WS_CLIENTS.discard(ws)

# -------- REST: local sensors snapshot --------
@app.get("/api/sensors/local")
async def local_snapshot():
    return await sensor_manager.snapshot()

# -------- REST: external telemetry + fused risk --------
import json
def json_dumps(o): return json.dumps(o, separators=(",", ":"))

@app.get("/api/telemetry", response_model=TelemetryResponse)
async def telemetry(
    lat: float = Query(...),
    lon: float = Query(...),
    radius_km: int = Query(200, ge=10, le=500)
):
    wx, rain_24h, series = await fetch_open_meteo(lat, lon)
    seismic = await fetch_usgs(lat, lon, radius_km=radius_km, hours=24)
    local = await sensor_manager.snapshot()
    risk = compute_risk(wx, rain_24h, seismic, local)
    return {
        "coords": {"lat": lat, "lon": lon},
        "weather": wx,
        "rain_24h_mm": round(rain_24h,2),
        "seismic": seismic,
        "risk": risk,
        "series": series,
        "local_sensors": local
    }

