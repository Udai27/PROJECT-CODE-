# split_drone_dataset.py
import os, shutil, random

SRC = r"datasets\drone_dataset_raw"   # yahan unzip hua data hai
DST = r"datasets\drone_dataset"       # final structure yahan बनेगा
CLASSES = ["safe", "risk"]            # folder ke naam isi tarah hone chahiye
SPLIT = 0.2                           # 20% val

def ensure_dir(p):
    os.makedirs(p, exist_ok=True)

# final folders
for s in ["train", "val"]:
    for c in CLASSES:
        ensure_dir(os.path.join(DST, s, c))

# har class ke liye files uthao
for c in CLASSES:
    src_dir = os.path.join(SRC, c)
    files = [f for f in os.listdir(src_dir) if f.lower().endswith((".jpg",".jpeg",".png",".bmp"))]
    random.shuffle(files)

    k = int(len(files) * SPLIT)
    val_files = set(files[:k])

    for f in files:
        src = os.path.join(src_dir, f)
        split = "val" if f in val_files else "train"
        dst = os.path.join(DST, split, c, f)
        shutil.copy2(src, dst)

print("✅ Split complete. Final tree at:", DST)