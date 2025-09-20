import pickle
import numpy as np
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression

# ---------------- Sample Training Data ----------------
# Columns: [Rainfall (mm), Temperature (°C), Slope (°), Seismic Magnitude]
X = np.array([
    [10, 25, 28, 0.0],   # Safe
    [20, 27, 30, 0.5],   # Safe
    [50, 30, 38, 1.8],   # Risk
    [70, 32, 40, 2.0],   # Risk
    [15, 24, 25, 0.2],   # Safe
    [60, 35, 42, 3.0],   # Risk
])

# Labels: 0 = Safe, 1 = Risk
y = np.array([0, 0, 1, 1, 0, 1])

# ---------------- Train Scaler ----------------
scaler = StandardScaler()
X_scaled = scaler.fit_transform(X)

# ---------------- Train Model ----------------
model = LogisticRegression()
model.fit(X_scaled, y)

# ---------------- Save Scaler & Model ----------------
with open("models/scaler.pkl", "wb") as f:
    pickle.dump(scaler, f)

with open("models/model.pkl", "wb") as f:
    pickle.dump(model, f)

print("✅ Model training complete! scaler.pkl and model.pkl saved in models/")
