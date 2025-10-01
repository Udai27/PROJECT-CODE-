import pickle
import numpy as np
import pandas as pd
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix
import os

# ---------------- Option 1: Load from CSV if available ----------------
dataset_path = "datasets/rockfall_data.csv"   # <-- apna dataset ka path de yaha
if os.path.exists(dataset_path):
    data = pd.read_csv(dataset_path)

    # ⚡ Columns adjust kar dataset ke hisab se
    X = data[["temperature_c", "wind_speed_ms", "soil_moisture_pct",
              "humidity_pct", "rainfall_mm", "seismic_mag"]].values
    y = data["rockfall_occurred"].values
else:
    # ---------------- Option 2: Fallback on Sample Training Data ----------------
    # Columns: [Temperature (°C), Wind Speed (m/s), Soil Moisture (%), Humidity (%), Rainfall (mm), Seismic Magnitude]
    X = np.array([
        [25, 3, 20, 45, 10, 0.0],   # Safe
        [27, 4, 25, 50, 20, 0.5],   # Safe
        [30, 6, 40, 70, 50, 1.8],   # Risk
        [32, 7, 45, 80, 70, 2.0],   # Risk
        [24, 2, 18, 40, 15, 0.2],   # Safe
        [35, 8, 50, 85, 60, 3.0],   # Risk
        [29, 5, 35, 65, 40, 1.5],   # Risk
        [26, 3, 22, 48, 12, 0.3],   # Safe
    ])
    # Labels: 0 = Safe, 1 = Risk
    y = np.array([0, 0, 1, 1, 0, 1, 1, 0])

# ---------------- Train/Test Split ----------------
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42, stratify=y
)

# ---------------- Train Scaler ----------------
scaler = StandardScaler()
X_train_scaled = scaler.fit_transform(X_train)
X_test_scaled = scaler.transform(X_test)

# ---------------- Train Models ----------------
# Purana Logistic Regression
log_model = LogisticRegression(max_iter=1000)
log_model.fit(X_train_scaled, y_train)

# Naya option: Random Forest (zyada powerful)
rf_model = RandomForestClassifier(n_estimators=200, random_state=42)
rf_model.fit(X_train_scaled, y_train)

# ---------------- Evaluate Models ----------------
log_acc = accuracy_score(y_test, log_model.predict(X_test_scaled))
rf_acc = accuracy_score(y_test, rf_model.predict(X_test_scaled))

print("\n📊 Model Performance:")
print(f"Logistic Regression Accuracy: {log_acc:.2f}")
print(f"Random Forest Accuracy: {rf_acc:.2f}")

print("\nClassification Report (RandomForest):")
print(classification_report(y_test, rf_model.predict(X_test_scaled)))
print("\nConfusion Matrix (RandomForest):")
print(confusion_matrix(y_test, rf_model.predict(X_test_scaled)))

# ---------------- Ensure "models" folder exists ----------------
os.makedirs("models", exist_ok=True)

# ---------------- Save Scaler & Model ----------------
with open("models/scaler.pkl", "wb") as f:
    pickle.dump(scaler, f)

# Purana Logistic Regression save karna ho to:
with open("models/model_logistic.pkl", "wb") as f:
    pickle.dump(log_model, f)

# Naya RandomForest save karna ho to:
with open("models/model.pkl", "wb") as f:
    pickle.dump(rf_model, f)

print("\n✅ Model training complete! scaler.pkl, model.pkl (RandomForest), and model_logistic.pkl saved in models/")

