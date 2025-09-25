// backend/server.js
require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8000;
const OPENWEATHER_KEY = process.env.OPENWEATHER_API_KEY || "";
const DEFAULT_COORDS = {
  lat: parseFloat(process.env.DEFAULT_LAT) || 26.8829,
  lon: parseFloat(process.env.DEFAULT_LON) || 75.7957,
};

// ---------------- Helpers ----------------
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const nowISO = () => new Date().toISOString();

// --- Weather API
async function fetchOpenWeather(lat, lon) {
  if (!OPENWEATHER_KEY) return null;
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=metric&appid=${OPENWEATHER_KEY}`;
    const r = await axios.get(url, { timeout: 8000 });
    const d = r.data;
    return {
      temperature_c: d.main?.temp ?? null,
      wind_speed_ms: d.wind?.speed ?? null,
      humidity_pct: d.main?.humidity ?? null,
      rain_1h_mm: d.rain?.["1h"] ?? 0,
      rain_3h_mm: d.rain?.["3h"] ?? 0,
    };
  } catch (e) {
    console.warn("fetchOpenWeather error:", e.message);
    return null;
  }
}

// --- OpenMeteo
async function fetchOpenMeteo(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=precipitation,soil_moisture_0_1cm&past_days=2&timezone=UTC`;
    const r = await axios.get(url, { timeout: 10000 });
    const precip = r.data?.hourly?.precipitation || [];
    const soil = r.data?.hourly?.soil_moisture_0_1cm || [];

    let rain24 = 0;
    if (precip.length >= 24) {
      rain24 = precip.slice(-24).reduce((s, v) => s + (Number(v) || 0), 0);
      rain24 = +rain24.toFixed(2);
    }
    let soilPct = null;
    if (soil.length) {
      soilPct = Math.round(clamp(soil[soil.length - 1] * 100, 0, 100));
    }

    return { precipitation_24h_mm: rain24, soil_moisture_pct: soilPct };
  } catch (e) {
    console.warn("fetchOpenMeteo error:", e.message);
    return null;
  }
}

// --- USGS Seismic feed
async function fetchSeismicIndia() {
  try {
    const start = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${start}&minmagnitude=0.5&minlatitude=6&maxlatitude=37&minlongitude=68&maxlongitude=97`;
    const r = await axios.get(url, { timeout: 10000 });
    const features = r.data?.features || [];
    let strongest = 0;
    let latestEvent = null;
    features.forEach((f) => {
      const m = f.properties?.mag;
      if (typeof m === "number" && m > strongest) strongest = m;
      if (!latestEvent || f.properties?.time > latestEvent.time) {
        latestEvent = {
          mag: f.properties?.mag,
          place: f.properties?.place,
          time: new Date(f.properties?.time).toISOString(),
        };
      }
    });
    return {
      strongest_mag: strongest || 0,
      count: features.length,
      last_event: latestEvent,
    };
  } catch (e) {
    console.warn("fetchSeismicIndia error:", e.message);
    return { strongest_mag: 0, count: 0, last_event: null };
  }
}

// --- Risk Score
function computeRiskScore({ weather, openMeteo, seismic }) {
  const windNorm =
    weather?.wind_speed_ms != null ? clamp(weather.wind_speed_ms / 20) : 0;
  const humNorm =
    weather?.humidity_pct != null ? clamp(weather.humidity_pct / 100) : 0;
  const tempNorm =
    weather?.temperature_c != null ? clamp((weather.temperature_c + 10) / 50) : 0;
  const rainNorm =
    openMeteo?.precipitation_24h_mm != null
      ? clamp(openMeteo.precipitation_24h_mm / 40)
      : 0;
  const soilNorm =
    openMeteo?.soil_moisture_pct != null
      ? clamp(openMeteo.soil_moisture_pct / 100)
      : 0;
  const seisNorm =
    seismic?.strongest_mag != null ? clamp(seismic.strongest_mag / 6) : 0;
  const score =
    clamp(
      seisNorm * 0.4 +
        rainNorm * 0.25 +
        soilNorm * 0.15 +
        windNorm * 0.1 +
        (humNorm * 0.05 + tempNorm * 0.05),
      0,
      1
    ) * 100;
  return {
    score: +score.toFixed(1),
    level: score > 70 ? "HIGH" : score > 45 ? "MEDIUM" : "LOW",
  };
}

// --- Timeline generator
function generateRiskTimeline(baseScore) {
  const timeline = [];
  let current = baseScore;
  for (let h = 0; h <= 24; h += 4) {
    const variation = (Math.random() * 0.2 - 0.1) * baseScore;
    const next = clamp((current + variation) / 100, 0, 1) * 100;
    timeline.push({
      time: `${String(h).padStart(2, "0")}:00`,
      value: +next.toFixed(1),
    });
    current = next;
  }
  return timeline;
}

// ---------------- Telemetry ----------------
let currentTelemetry = null;

async function buildTelemetry(lat = DEFAULT_COORDS.lat, lon = DEFAULT_COORDS.lon) {
  const [weather, openMeteo, seismic] = await Promise.all([
    fetchOpenWeather(lat, lon),
    fetchOpenMeteo(lat, lon),
    fetchSeismicIndia(),
  ]);
  const risk = computeRiskScore({ weather, openMeteo, seismic });
  return {
    timestamp: nowISO(),
    lat,
    lon,
    weather,
    precipitation_24h_mm:
      openMeteo?.precipitation_24h_mm ?? weather?.rain_1h_mm ?? 0,
    soil: { moisture_pct: openMeteo?.soil_moisture_pct ?? null },
    seismic,
    risk,
    riskTimeline: generateRiskTimeline(risk.score),
  };
}

// ---------------- Personnel + Alerts Integration ----------------
let alertsStore = [];

// Random worker generator
function generatePersonnel(count = 12) {
  const risks = ["SAFE", "CAUTION", "EMERGENCY"];
  return Array.from({ length: count }).map((_, i) => {
    const risk = risks[Math.floor(Math.random() * risks.length)];
    return {
      id: i + 1,
      name: `Worker ${i + 1}`,
      role: i % 3 === 0 ? "Supervisor" : "Operator",
      zone: (i % 5) + 1,
      x: Math.random() * 100,
      y: Math.random() * 100,
      risk,
      risk_score: Math.floor(Math.random() * 100),
    };
  });
}

// ✅ Live personnel API
app.get("/api/personnel/live", (req, res) => {
  const count = parseInt(req.query.count) || 12;
  const only = (req.query.only || "").toUpperCase();

  const workers = generatePersonnel(count);
  let filtered = workers;
  if (only) filtered = workers.filter((w) => w.risk === only);

  const totals = {
    safe: filtered.filter((w) => w.risk === "SAFE").length,
    caution: filtered.filter((w) => w.risk === "CAUTION").length,
    emergency: filtered.filter((w) => w.risk === "EMERGENCY").length,
  };

  alertsStore = workers
    .filter((w) => w.risk === "CAUTION" || w.risk === "EMERGENCY")
    .map((w) => ({
      id: `ALT-W-${w.id}`,
      title: `${w.risk} detected for ${w.name}`,
      severity: w.risk === "EMERGENCY" ? "critical" : "warning",
      status: "active",
      description: `${w.name} in Zone ${w.zone} at risk level: ${w.risk}`,
      sector: `Sector ${w.zone}`,
      sensor: "Personnel Tracker",
      assigned: "Supervisor",
      actions:
        w.risk === "EMERGENCY"
          ? ["Evacuate worker", "Send medical team", "Alert supervisor"]
          : ["Inspect worker", "Advise caution", "Log activity"],
      timestamp: new Date().toLocaleString(),
    }));

  res.json({
    updated: new Date().toISOString(),
    workers: filtered,
    totals,
  });
});

// ✅ Recent personnel alerts
app.get("/api/personnel/alerts", (req, res) => {
  res.json({ alerts: alertsStore });
});

// ✅ Combined system alerts
app.get("/api/alerts", (req, res) => {
  const staticAlerts = [
    {
      id: "ALT-001",
      title: "Crackmeter Threshold Exceeded",
      severity: "critical",
      status: "active",
      description:
        "Crackmeter CM-07 in Sector 7 shows 4.2mm displacement, exceeding threshold",
      sector: "Sector 7",
      sensor: "Crackmeter CM-07",
      assigned: "John Smith",
      actions: ["Evacuate area", "Inspect slope", "Contact supervisor"],
      timestamp: new Date().toLocaleString(),
    },
  ];
  res.json({ alerts: [...staticAlerts, ...alertsStore] });
});
// ✅ Test SMS endpoint
app.get("/api/test-sms", async (req, res) => {
  try {
    const client = require("twilio")(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    const msg = await client.messages.create({
      body: "🚨 Test Alert: This is a test SOS message from Rockfall System",
      from: process.env.TWILIO_PHONE,
      to: process.env.ALERT_PHONE,
    });

    res.json({ ok: true, sid: msg.sid });
  } catch (e) {
    console.error("SMS test error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------- Endpoints ----------------
app.get("/api/telemetry", async (req, res) => {
  try {
    const snapshot = await buildTelemetry();
    currentTelemetry = snapshot;
    res.json(snapshot);
  } catch (e) {
    res.status(500).json({ error: "failed to fetch telemetry" });
  }
});

app.get("/api/predictive", async (req, res) => {
  try {
    if (!currentTelemetry) {
      currentTelemetry = await buildTelemetry();
    }
    const snapshot = currentTelemetry;

    res.json({
      probability: snapshot.risk?.score || 0,
      predictedEventWindow:
        snapshot.risk?.level === "HIGH"
          ? "48–72 hours"
          : snapshot.risk?.level === "MEDIUM"
          ? "72–96 hours"
          : "Low risk – No event expected",
      timeline: snapshot.riskTimeline || [],
      rainfallForecast: [
        { time: "Day 1", rainfall: Math.round(Math.random() * 20) },
        { time: "Day 2", rainfall: Math.round(Math.random() * 20) },
        { time: "Day 3", rainfall: Math.round(Math.random() * 20) },
        { time: "Day 4", rainfall: Math.round(Math.random() * 20) },
        { time: "Day 5", rainfall: Math.round(Math.random() * 20) },
      ],
      seismicData: [
        { zone: "Zone A", mag: snapshot.seismic?.strongest_mag || 2.5 },
        { zone: "Zone B", mag: Math.random() * 5 },
        { zone: "Zone C", mag: Math.random() * 5 },
        { zone: "Zone D", mag: Math.random() * 5 },
      ],
    });
  } catch (e) {
    console.error("Error in /api/predictive:", e.message);
    res.status(500).json({ error: "failed to build predictive analytics" });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true, ts: nowISO() }));

// ✅ Risk factors endpoint
app.get("/api/risk-factors", async (req, res) => {
  try {
    const snapshot = await buildTelemetry();

    const factors = [
      {
        factor: "Rainfall",
        impact:
          snapshot.precipitation_24h_mm != null
            ? Math.round(snapshot.precipitation_24h_mm)
            : 0,
      },
      {
        factor: "Soil Moisture",
        impact:
          snapshot.soil?.moisture_pct != null ? snapshot.soil.moisture_pct : 0,
      },
      {
        factor: "Seismic Activity",
        impact:
          snapshot.seismic?.strongest_mag != null
            ? Math.round(snapshot.seismic.strongest_mag * 10)
            : 0,
      },
      {
        factor: "Wind Speed",
        impact:
          snapshot.weather?.wind_speed_ms != null
            ? Math.round(snapshot.weather.wind_speed_ms * 5)
            : 0,
      },
      {
        factor: "Temperature",
        impact:
          snapshot.weather?.temperature_c != null
            ? Math.round(snapshot.weather.temperature_c)
            : 0,
      },
    ];

    res.json({ updated: nowISO(), factors });
  } catch (e) {
    console.error("risk-factors error:", e.message);
    res.status(500).json({ error: "failed to fetch risk factors" });
  }
});

// ✅ NEW: Risk Trend (Last 7 Days)
app.get("/api/risk-trend", async (req, res) => {
  try {
    const snapshot = await buildTelemetry();
    const baseScore = snapshot?.risk?.score || 30;
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

    const trend = days.map((d, i) => {
      const variation = (Math.random() * 0.2 - 0.1) * baseScore;
      return {
        day: d,
        risk: Math.max(0, Math.round(baseScore + variation + i * 2 - 6)),
      };
    });

    res.json(trend);
  } catch (e) {
    console.error("risk-trend error:", e.message);
    res.status(500).json({ error: "failed to fetch risk trend" });
  }
});

// ✅ NEW: Cities Risk endpoint
app.get("/api/cities-risk", async (req, res) => {
  try {
    const cities = [
      { city: "Jaipur", lat: 26.9124, lon: 75.7873 },
      { city: "Mumbai", lat: 19.0760, lon: 72.8777 },
      { city: "Nagpur", lat: 21.1458, lon: 79.0882 },
      { city: "Delhi", lat: 28.7041, lon: 77.1025 },
      { city: "Kolkata", lat: 22.5726, lon: 88.3639 },
    ];

    const results = [];

    for (const c of cities) {
      const telemetry = await buildTelemetry(c.lat, c.lon);
      results.push({
        city: c.city,
        lat: c.lat,
        lon: c.lon,
        risk: telemetry.risk?.level || "UNKNOWN",
        score: telemetry.risk?.score || 0,
        updated: nowISO(),
      });
    }

    res.json({ results });
  } catch (e) {
    console.error("cities-risk error:", e.message);
    res.status(500).json({ error: "failed to fetch cities risk" });
  }
});

// ✅ NEW: Synthetic Sensor Data endpoint
app.get("/api/sensors", (req, res) => {
  const sensors = {
    tiltmeters: {
      sector: "Sector 7 - North Slope",
      current: +(Math.random() * 5).toFixed(2),
      threshold: 5.0,
      unit: "°",
    },
    piezometers: {
      sector: "Sector 5 - Groundwater",
      current: +(12 + Math.random() * 8).toFixed(2),
      threshold: 18.0,
      unit: "m",
    },
    vibrations: {
      sector: "Sector 3 - Blast Zone",
      current: +(Math.random() * 2).toFixed(2),
      threshold: 2.0,
      unit: " mm/s",
    },
    crackmeters: {
      sector: "Sector 7 - Critical Zone",
      current: +(Math.random() * 6).toFixed(2),
      threshold: 3.0,
      unit: " mm",
    },
    weather: {
      sector: "Central Platform",
      temperature: 10 + Math.floor(Math.random() * 20),
      humidity: 40 + Math.floor(Math.random() * 50),
    },
    gnss: {
      sector: "Mine Perimeter",
      current: +(Math.random() * 5).toFixed(2),
      threshold: 5.0,
      unit: " cm",
    },
  };

  res.json({ updated: nowISO(), sensors });
});

// ---------------- WebSocket ----------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket client connected");
  ws.send(JSON.stringify({ ok: true, msg: "Welcome WebSocket client!" }));
});

// ---------------- Start Server ----------------
server.listen(PORT, () => {
  console.log(`✅ Realtime telemetry server running at http://localhost:${PORT}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `❌ Port ${PORT} already in use. Please stop other process or change PORT.`
    );
    process.exit(1);
  } else {
    throw err;
  }
});