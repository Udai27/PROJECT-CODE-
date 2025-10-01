import sys
import pickle
import numpy as np

# Load trained model and scaler
with open("models/scaler.pkl", "rb") as f:
    scaler = pickle.load(f)

with open("models/model.pkl", "rb") as f:
    model = pickle.load(f)

# Read inputs from Node.js
rainfall = float(sys.argv[1])
temperature = float(sys.argv[2])
slope = float(sys.argv[3])
seismic = float(sys.argv[4])

X = np.array([[rainfall, temperature, slope, seismic]])
X_scaled = scaler.transform(X)

# Predict
prob = model.predict_proba(X_scaled)[0][1]
risk = int(model.predict(X_scaled)[0])

print({"risk": risk, "probability": round(float(prob), 2)})