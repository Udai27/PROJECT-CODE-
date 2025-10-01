# train_drone_model.py
import os
import tensorflow as tf
from tensorflow.keras.preprocessing.image import ImageDataGenerator
from tensorflow.keras.models import Sequential
from tensorflow.keras.layers import Conv2D, MaxPooling2D, Flatten, Dense, Dropout
from tensorflow.keras.optimizers import Adam

# ---------------- Paths ----------------
# Dataset ko is folder me unzip kar:
# datasets/drone_dataset/train/safe
# datasets/drone_dataset/train/risk
# datasets/drone_dataset/val/safe
# datasets/drone_dataset/val/risk
dataset_dir = "datasets/drone_dataset"
model_dir = "models"
os.makedirs(model_dir, exist_ok=True)

# ---------------- Data Generators ----------------
img_size = (128, 128)   # sabhi images resize
batch_size = 16

# Train & validation ke liye augmentation
train_datagen = ImageDataGenerator(
    rescale=1.0/255,
    rotation_range=20,
    zoom_range=0.2,
    horizontal_flip=True
)

val_datagen = ImageDataGenerator(
    rescale=1.0/255
)

train_gen = train_datagen.flow_from_directory(
    os.path.join(dataset_dir, "train"),
    target_size=img_size,
    batch_size=batch_size,
    class_mode="binary"
)

val_gen = val_datagen.flow_from_directory(
    os.path.join(dataset_dir, "val"),
    target_size=img_size,
    batch_size=batch_size,
    class_mode="binary"
)

# ---------------- CNN Model ----------------
model = Sequential([
    Conv2D(32, (3,3), activation="relu", input_shape=(128,128,3)),
    MaxPooling2D((2,2)),

    Conv2D(64, (3,3), activation="relu"),
    MaxPooling2D((2,2)),

    Conv2D(128, (3,3), activation="relu"),
    MaxPooling2D((2,2)),

    Flatten(),
    Dense(128, activation="relu"),
    Dropout(0.5),
    Dense(1, activation="sigmoid")   # Binary: Safe(0) / Risk(1)
])

model.compile(
    optimizer=Adam(learning_rate=0.0001),
    loss="binary_crossentropy",
    metrics=["accuracy"]
)

# ---------------- Training ----------------
history = model.fit(
    train_gen,
    validation_data=val_gen,
    epochs=10
)

# ---------------- Save Model ----------------
model_path = os.path.join(model_dir, "drone_model.h5")
model.save(model_path)
print(f"✅ Training complete! Model saved at {model_path}")

# ---------------- Class Indices ----------------
print("Class mapping:", train_gen.class_indices)

