// backend/syntheticSensors.js
function randomInRange(min, max) {
  return +(Math.random() * (max - min) + min).toFixed(2);
}

function generateSensorSnapshot() {
  return {
    timestamp: new Date().toISOString(),

    tiltmeter: {
      sector: "North Slope",
      value: randomInRange(1.5, 6.0), // degrees
      threshold: 5.0,
      unit: "°",
    },

    piezometer: {
      sector: "Groundwater Zone",
      value: randomInRange(8, 20), // meters
      threshold: 18.0,
      unit: "m",
    },

    crackmeter: {
      sector: "Critical Zone",
      value: randomInRange(1, 5), // mm
      threshold: 3.0,
      unit: "mm",
    },

    gnss: {
      sector: "Mine Perimeter",
      value: randomInRange(1, 7), // cm
      threshold: 5.0,
      unit: "cm",
    },

    vibration: {
      sector: "Blast Zone",
      value: randomInRange(0.5, 2.5), // mm/s
      threshold: 2.0,
      unit: "mm/s",
    },

    weather: {
      temperature: randomInRange(20, 38), // °C
      humidity: randomInRange(30, 85), // %
      rainfall: randomInRange(0, 15), // mm
      wind: randomInRange(1, 8), // m/s
    },
  };
}

// ✅ optional helper: batch of N points (charts me trend ke liye)
function generateBatchSnapshots(n = 10) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    const snap = generateSensorSnapshot();
    snap.timestamp = new Date(Date.now() - (n - i) * 60000).toISOString();
    arr.push(snap);
  }
  return arr;
}

module.exports = { generateSensorSnapshot, generateBatchSnapshots };
