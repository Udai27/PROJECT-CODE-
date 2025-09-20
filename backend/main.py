from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
import requests
import pickle
import numpy as np
import rasterio
import tempfile
import os

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------- Load Model ----------------
with open("models/scaler.pkl", "rb") as f:
    scaler = pickle.load(f)

with open("models/model.pkl", "rb") as f:
    model = pickle.load(f)


def calculate_slope_from_dem(lat, lon):
    """Fetch DEM GeoTIFF from OpenTopography and compute slope"""
    url = f"https://portal.opentopography.org/API/globaldem?demtype=SRTMGL1_E&south={lat-0.01}&north={lat+0.01}&west={lon-0.01}&east={lon+0.01}&outputFormat=GTiff"

    with tempfile.NamedTemporaryFile(delete=False, suffix=".tif") as tmpfile:
        r = requests.get(url)
        tmpfile.write(r.content)
        path = tmpfile.name

    with rasterio.open(path) as src:
        dem = src.read(1)
        # slope in degrees
        x, y = np.gradient(dem, src.res[0], src.res[1])
        slope = np.sqrt(x*x + y*y)
        slope_deg = np.degrees(np.arctan(slope))
        avg_slope = float(np.nanmean(slope_deg))

    os.remove(path)
    return avg_slope


@app.get("/predict/auto")
def predict_auto(lat: float = Query(...), lon: float = Query(...)):
    # Weather
    weather_url = f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&hourly=temperature_2m,precipitation"
    weather = requests.get(weather_url).json()
    temp = weather["hourly"]["temperature_2m"][0]
    rain = weather["hourly"]["precipitation"][0]

    # Slope (DEM)
    slope_angle = calculate_slope_from_dem(lat, lon)

    # Seismic
    usgs_url = f"https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude={lat}&longitude={lon}&maxradiuskm=100&limit=1"
    quake = requests.get(usgs_url).json()
    seismic = quake["features"][0]["properties"]["mag"] if quake["features"] else 0.0

    # Prediction
    X = np.array([[rain, temp, slope_angle, seismic]])
    X_scaled = scaler.transform(X)
    pred = model.predict(X_scaled)[0]

    return {
        "latitude": lat,
        "longitude": lon,
        "rainfall": rain,
        "temperature": temp,
        "slope_angle": slope_angle,
        "seismic": seismic,
        "prediction": int(pred),
        "label": "⚠️ Risk" if pred == 1 else "✅ Safe"
    }


@app.get("/ping")
def ping():
    return {"message": "Backend is running!"}

