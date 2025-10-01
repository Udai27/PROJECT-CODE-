// backend/server.js
require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const csv = require("csv-parser");
const { spawn } = require("child_process");  // 🔹 Python call के लिए

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8000;
const OPENWEATHER_KEY = process.env.OPENWEATHER_API_KEY || "";

// ✅ Jaipur default fallback
const DEFAULT_COORDS = {
  lat: parseFloat(process.env.DEFAULT_LAT) || 26.9124,
  lon: parseFloat(process.env.DEFAULT_LON) || 75.7873,
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

// ==========================
// Personnel Tracking Routes
// ==========================

// in-memory workers data (auto-generate)
function generateWorkers(count = 12) {
  const workers = [];
  for (let i = 1; i <= count; i++) {
    const riskTypes = ["SAFE", "CAUTION", "EMERGENCY"];
    const risk = riskTypes[Math.floor(Math.random() * riskTypes.length)];
    workers.push({
      id: i,
      x: Math.floor(Math.random() * 100),
      y: Math.floor(Math.random() * 100),
      zone: `Zone ${String.fromCharCode(65 + (i % 5))}`,
      risk,
      risk_score: Math.floor(Math.random() * 100),
    });
  }
  return workers;
}

// store alerts
let alerts = [];

// GET /api/personnel/live
app.get("/api/personnel/live", (req, res) => {
  const count = parseInt(req.query.count) || 12;
  const only = (req.query.only || "").toUpperCase();

  let workers = generateWorkers(count);
  if (only) {
    workers = workers.filter((w) => w.risk === only.toUpperCase());
  }

  const totals = {
    safe: workers.filter((w) => w.risk === "SAFE").length,
    caution: workers.filter((w) => w.risk === "CAUTION").length,
    emergency: workers.filter((w) => w.risk === "EMERGENCY").length,
  };

  // create alerts for caution/emergency workers
  alerts = workers
    .filter((w) => w.risk !== "SAFE")
    .map((w) => ({
      title: `Status Alert: Worker ${w.id}`,
      sector: w.zone,
      timestamp: new Date().toISOString(),
      severity: w.risk === "EMERGENCY" ? "critical" : "warning",
      status: "active",
    }));

  res.json({
    updated: new Date().toISOString(),
    workers,
    totals,
  });
});

// GET /api/personnel/alerts
app.get("/api/personnel/alerts", (req, res) => {
  res.json({ alerts });
});

// ==================================================
// 🔹 Alerts API (AlertManagement.js के लिए)
// ==================================================
app.get("/api/alerts", (req, res) => {
  const alerts = [
    {
      id: "AL-101",
      title: "Landslide Risk in Zone A",
      description: "Increased rainfall and slope instability detected",
      sector: "Zone A",
      sensor: "Rainfall + Slope Sensor",
      assigned: "Team Alpha",
      severity: "critical",
      status: "active",
      actions: ["Inspect site", "Evacuate workers", "Deploy drones"],
      timestamp: new Date().toISOString(),
    },
    {
      id: "AL-102",
      title: "Seismic Activity in Zone B",
      description: "Minor tremors recorded in the last 24h",
      sector: "Zone B",
      sensor: "Seismic Sensor",
      assigned: "Team Bravo",
      severity: "warning",   // 👈 small
      status: "active",
      actions: ["Check sensor logs", "Update risk map"],
      timestamp: new Date().toISOString(),
    },
    {
      id: "AL-103",
      title: "Soil Moisture Alert in Zone C",
      description: "Soil saturation levels crossed threshold",
      sector: "Zone C",
      sensor: "Soil Sensor",
      assigned: "Team Charlie",
      severity: "critical",
      status: "in-progress",  // 👈 small
      actions: ["Monitor continuously", "Prepare evacuation plan"],
      timestamp: new Date().toISOString(),
    },
  ];

  res.json({ alerts });
});

// ==========================
// 2D Maps & Risk Analysis Routes
// ==========================

// Dummy city data (later CSV/DB से भी जोड़ सकते हो)
const sampleCities = [
  { city: "Jaipur", lat: 26.9124, lon: 75.7873 },
  { city: "Delhi", lat: 28.7041, lon: 77.1025 },
  { city: "Mumbai", lat: 19.076, lon: 72.8777 },
  { city: "Bengaluru", lat: 12.9716, lon: 77.5946 },
  { city: "Chennai", lat: 13.0827, lon: 80.2707 },
];

// Risk generator
function getRiskFromScore(score) {
  if (score > 70) return "HIGH";
  if (score > 40) return "MEDIUM";
  return "LOW";
}

// GET /api/cities-risk → सभी cities के लिए risk markers
app.get("/api/cities-risk", async (req, res) => {
  try {
    const results = await Promise.all(
      sampleCities.map(async (c) => {
        const weather = await fetchOpenWeather(c.lat, c.lon);
        const openMeteo = await fetchOpenMeteo(c.lat, c.lon);
        const seismic = await fetchSeismicByLocation(c.lat, c.lon);

        const risk = computeRiskScore({ weather, openMeteo, seismic });

        return {
          city: c.city,
          lat: c.lat,
          lon: c.lon,
          risk: risk.level,
          score: risk.score,
          updated: nowISO(),
        };
      })
    );

    res.json({ results });
  } catch (err) {
    console.error("Error in /api/cities-risk:", err.message);
    res.status(500).json({ error: "Failed to fetch cities risk" });
  }
});

// GET /api/telemetry?lat=..&lon=..
app.get("/api/telemetry", async (req, res) => {
  const lat = parseFloat(req.query.lat) || DEFAULT_COORDS.lat;
  const lon = parseFloat(req.query.lon) || DEFAULT_COORDS.lon;

  try {
    const weather = await fetchOpenWeather(lat, lon);
    const openMeteo = await fetchOpenMeteo(lat, lon);
    const seismic = await fetchSeismicByLocation(lat, lon);

    const risk = computeRiskScore({ weather, openMeteo, seismic });

    res.json({
      coords: { lat, lon },
      weather,
      precipitation_24h_mm: openMeteo?.precipitation_24h_mm ?? null,
      soil: { moisture_pct: openMeteo?.soil_moisture_pct ?? null },
      seismic,
      risk,
      updated: nowISO(),
    });
  } catch (err) {
    console.error("Error in /api/telemetry:", err.message);
    res.status(500).json({ error: "Failed to fetch telemetry" });
  }
});

// --- OpenMeteo API
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

// --- USGS Seismic API
async function fetchSeismicByLocation(lat, lon, radiusKm = 200) {
  try {
    const start = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${start}&latitude=${lat}&longitude=${lon}&maxradiuskm=${radiusKm}&minmagnitude=0.5`;

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
    console.warn("fetchSeismicByLocation error:", e.message);
    return { strongest_mag: 0, count: 0, last_event: null };
  }
}

// --- Risk Score Calculation
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

// --- Risk Timeline Generator
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

// ==================================================
// 🔹 Personnel Tracking Simulation
// ==================================================
let workerId = 1;

// function generateWorkers(count = 10) {
//   const risks = ["SAFE", "CAUTION", "EMERGENCY"];
//   const workers = [];

//   for (let i = 0; i < count; i++) {
//     const risk = risks[Math.floor(Math.random() * risks.length)];
//     workers.push({
//       id: workerId++, // dynamic worker numbering
//       name: `Worker ${workerId}`, // 👈 Name replaced with Worker X
//       x: Math.random() * 100,
//       y: Math.random() * 100,
//       risk,
//       risk_score: Math.floor(Math.random() * 100),
//       zone: `Zone ${String.fromCharCode(65 + (i % 5))}`,
//     });
//   }

//   return workers;
// }

app.get("/api/personnel/live", (req, res) => {
  const count = parseInt(req.query.count) || 12;
  const only = req.query.only;

  let workers = generateWorkers(count);

  if (only) {
    workers = workers.filter((w) => w.risk.toLowerCase() === only.toLowerCase());
  }

  const totals = {
    safe: workers.filter((w) => w.risk === "SAFE").length,
    caution: workers.filter((w) => w.risk === "CAUTION").length,
    emergency: workers.filter((w) => w.risk === "EMERGENCY").length,
  };

  res.json({
    updated: nowISO(),
    workers,
    totals,
  });
});

app.get("/api/personnel/alerts", (req, res) => {
  const alerts = generateWorkers(5) // 5 random alerts
    .filter((w) => w.risk === "CAUTION" || w.risk === "EMERGENCY")
    .map((w) => ({
      title: `Status Alert: Worker ${w.id}`,
      sector: w.zone,
      timestamp: nowISO(),
      severity: w.risk === "EMERGENCY" ? "critical" : "warning",
      status: "active",
    }));

  res.json({ alerts });
});

// ==================================================
// 🔹 Risk API
// ==================================================
app.get("/api/risk", async (req, res) => {
  const lat = parseFloat(req.query.lat) || DEFAULT_COORDS.lat;
  const lon = parseFloat(req.query.lon) || DEFAULT_COORDS.lon;

  try {
    const weather = await fetchOpenWeather(lat, lon);
    const openMeteo = await fetchOpenMeteo(lat, lon);
    const seismic = await fetchSeismicByLocation(lat, lon);

    const risk = computeRiskScore({ weather, openMeteo, seismic });
    const timeline = generateRiskTimeline(risk.score);

    res.json({
      coords: { lat, lon },
      weather,
      openMeteo,
      seismic,
      risk,
      timeline,
      fetched_at: nowISO(),
    });
  } catch (err) {
    console.error("Error in /api/risk:", err.message);
    res.status(500).json({ error: "Failed to compute risk" });
  }
});

// ==================================================
// 🔹 ML Prediction API (Python से call करके)
// ==================================================
app.post("/api/predict", (req, res) => {
  const { rainfall, temperature, slope, seismic } = req.body;

  const py = spawn("python", [
    "predict.py",
    rainfall,
    temperature,
    slope,
    seismic,
  ]);

  let dataString = "";

  py.stdout.on("data", (data) => {
    dataString += data.toString();
  });

  py.on("close", (code) => {
    try {
      const result = JSON.parse(dataString.replace(/'/g, '"'));
      res.json(result);
    } catch (err) {
      console.error("Prediction error:", err.message);
      res.status(500).json({ error: "Prediction failed" });
    }
  });
});

// ==================================================
// 🔹 Test Route (GET) → Browser से check करने के लिए
// ==================================================
app.get("/api/predict/test", (req, res) => {
  const py = spawn("python", [
    "predict.py",
    50,   // rainfall (dummy)
    28,   // temperature (dummy)
    42,   // slope (dummy)
    2.0   // seismic (dummy)
  ]);

  let dataString = "";

  py.stdout.on("data", (data) => {
    dataString += data.toString();
  });

  py.on("close", (code) => {
    try {
      const result = JSON.parse(dataString.replace(/'/g, '"'));
      res.json(result);
    } catch (err) {
      console.error("Prediction error:", err.message);
      res.status(500).json({ error: "Prediction failed" });
    }
  });
});

// ==================================================
// 🔹 AI Assistant API (Overview.js ke liye)
// ==================================================
// ==================================================
// 🔹 AI Assistant API (Overview.js ke liye)
// ==================================================
// ==================================================
// 🔹 AI Assistant API (Overview.js ke liye)
// ==================================================
app.post("/api/assistant", async (req, res) => {
  const { query, history } = req.body;
  const lat = DEFAULT_COORDS.lat;
  const lon = DEFAULT_COORDS.lon;

  try {
    // Step 1: Live telemetry data lao
    const weather = await fetchOpenWeather(lat, lon);
    const openMeteo = await fetchOpenMeteo(lat, lon);
    const seismic = await fetchSeismicByLocation(lat, lon);
    const risk = computeRiskScore({ weather, openMeteo, seismic });

    let answer = "";
    const q = query.toLowerCase();

    // =========================
    // Smart QnA categories
    // =========================

    // --- Risk & Prediction
    if (q.includes("risk")) {
      answer = `📊 Current risk level is **${risk.level}** with a risk score of ${risk.score}%.`;
    } 
    else if (q.includes("prediction") || q.includes("forecast")) {
      answer = `🔮 AI predicts risk trend for next 48–72 hours is around ${risk.score}%, category **${risk.level}**.`;
    }

    // --- Weather
    else if (q.includes("rain") || q.includes("rainfall")) {
      answer = `🌧 Rainfall in last 24h: ${openMeteo?.precipitation_24h_mm ?? "—"} mm.`;
    } 
    else if (q.includes("temperature") || q.includes("heat") || q.includes("cold")) {
      answer = `🌡 Current temperature: ${weather?.temperature_c ?? "—"} °C.`;
    } 
    else if (q.includes("humidity")) {
      answer = `💧 Current humidity: ${weather?.humidity_pct ?? "—"}%.`;
    } 
    else if (q.includes("wind")) {
      answer = `🍃 Wind speed: ${weather?.wind_speed_ms ?? "—"} m/s.`;
    } 
    else if (q.includes("soil")) {
      answer = `🌱 Soil moisture: ${openMeteo?.soil_moisture_pct ?? "—"}%.`;
    }

    // --- Seismic
    else if (q.includes("seismic") || q.includes("earthquake") || q.includes("tremor")) {
      answer = `🌍 Seismic activity: strongest magnitude in last 24h = ${seismic?.strongest_mag ?? "0"} (events: ${seismic?.count ?? 0}).`;
    }

    // --- Alerts / Workers
    else if (q.includes("alert")) {
      answer = `🚨 Currently there are ${alerts.length} active alerts in different zones.`;
    }
    else if (q.includes("worker") || q.includes("personnel")) {
      answer = "👷 Workers are being monitored live with zones and risk scores. Unsafe workers trigger instant alerts.";
    }

    // --- Safety & Prevention
    // --- Safety & Prevention (risk based)
else if (q.includes("safety") || q.includes("prevent") || q.includes("measure")) {
    let risk = telemetry?.riskScore || 0; // <-- risk score jo tum fetch kar rahi ho
    let level = "Low";

    if (risk >= 0 && risk <= 45) {
        level = "Low";
        answer = `🟢 Current Risk Level: LOW (${risk}). Preventive measures: regular slope inspections, basic monitoring, and maintaining proper drainage.`;
    } else if (risk > 45 && risk <= 70) {
        level = "Medium";
        answer = `🟠 Current Risk Level: MEDIUM (${risk}). Preventive measures: increase monitoring frequency, restrict worker access to high-risk zones, and ensure emergency drills are prepared.`;
    } else if (risk > 70) {
        level = "High";
        answer = `🔴 Current Risk Level: HIGH (${risk}). Preventive measures: immediate evacuation of workers, deploy emergency response teams, and suspend mining operations until safety is restored.`;
    }
}

    // --- System details
    else if (q.includes("system") || q.includes("project") || q.includes("dashboard")) {
      answer = "⚙ This system integrates weather, soil, seismic and AI prediction models into a real-time Mine Safety Dashboard.";
    }
    else if (q.includes("future") || q.includes("improve") || q.includes("work")) {
      answer = "📌 Future work includes: adding more sensors, real drone integration, historical rockfall dataset learning, and advanced predictive AI models.";
    }

    // --- Greetings & small talk
    else if (q.includes("hello") || q.includes("hi")) {
      answer = "👋 Hello! I am your Mine Safety Assistant. Ask me about risk, rainfall, weather, soil, seismic activity, alerts, or preventive measures.";
    }
    else if (q.includes("who are you")) {
      answer = "🤖 I am Mine Safety AI Assistant, built to support your project with real-time risk answers.";
    }
    else if (q.includes("bye")) {
      answer = "👋 Goodbye! Stay safe and keep monitoring the mine risks.";
    }
    else if (q.includes("thanks") || q.includes("thank you")) {
      answer = "🙏 You're welcome! Happy to assist.";
    }

    // --- Fallback
    else {
      answer = `🤖 I couldn’t find exact data for "${query}". But I can tell you about **risk, rainfall, weather, soil, seismic, alerts, workers, safety, and preventive measures**.`;
    }

    res.json({ answer });
  } catch (err) {
    console.error("AI Assistant error:", err.message);
    res.status(500).json({ answer: "⚠ AI Assistant failed to fetch data." });
  }
});
// ==================================================
// 🔹 WebSocket Setup for Live Alerts
// ==================================================
const server = http.createServer(app);
// 👇 yeh change karo
const wss = new WebSocket.Server({ server, path: "/ws" });

// 👇 aur upar add kar do ek simple GET /
app.get("/", (req, res) => {
  res.send("✅ Backend running, WebSocket path /ws");
});
// Client connections
wss.on("connection", (ws) => {
  console.log("🔌 New WebSocket client connected");

  ws.send(JSON.stringify({ msg: "Connected to RockGuard WS server" }));

  ws.on("close", () => {
    console.log("❌ WebSocket client disconnected");
  });
});
// Function to broadcast alerts
function broadcastAlert(alert) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(alert));
    }
  });
}
// Example: generate & broadcast random alert every 30s
setInterval(() => {
  const alert = {
    id: "AL-" + Math.floor(Math.random() * 1000),
    title: "Random Test Alert",
    description: "Auto-generated alert for demo",
    sector: "Zone " + String.fromCharCode(65 + Math.floor(Math.random() * 5)),
    sensor: "Test Sensor",
    assigned: "Demo Team",
    severity: ["critical", "warning", "info"][Math.floor(Math.random() * 3)],
    status: ["active", "in-progress", "resolved"][Math.floor(Math.random() * 3)],
    actions: ["Check logs", "Inspect site", "Report status"],
    timestamp: new Date().toISOString(),
  };

  console.log("📢 Broadcasting alert:", alert.id);
  broadcastAlert(alert);
}, 30000);

// ==================================================

// ✅ Root route for judges (Backend Home Page)
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>MineMinds Backend API</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; background: #f9fafb; color: #111827; }
          h1 { color: #2563eb; }
          ul { line-height: 1.8; }
          li { margin-bottom: 6px; }
          .ok { color: green; font-weight: bold; }
        </style>
      </head>
      <body>
        <h1>🚀 MineMinds Backend API</h1>
        <p class="ok">✅ Backend is running successfully</p>
        <h3>Available Endpoints:</h3>
        <ul>
          <li><a href="/api/personnel/live">/api/personnel/live</a></li>
          <li><a href="/api/personnel/alerts">/api/personnel/alerts</a></li>
          <li><a href="/api/risk">/api/risk</a></li>
          <li><a href="/api/predict">/api/predict</a></li>
          <li><a href="/api/assistant">/api/assistant</a></li>
          <li><a href="/api/alerts">/api/alerts</a></li>
        </ul>
      </body>
    </html>
  `);
});
// ==================================================
server.listen(PORT, () => {
  console.log(`🚀 Server + WS running on http://localhost:${PORT}`);
  console.log(`✅ Available endpoints:
    /api/personnel/live
    /api/personnel/alerts
    /api/risk
    /api/predict
    /api/assistant
    /api/alerts
  `);
});
  