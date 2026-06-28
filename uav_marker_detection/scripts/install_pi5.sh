#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WITH_YOLO=0

for arg in "$@"; do
  if [ "$arg" = "--with-yolo" ]; then
    WITH_YOLO=1
  fi
done

cd "${PROJECT_DIR}"

echo "[INFO] Updating apt package index"
sudo apt-get update

echo "[INFO] Installing Raspberry Pi camera and OpenCV packages"
sudo apt-get install -y \
  python3 \
  python3-pip \
  python3-venv \
  python3-numpy \
  python3-opencv \
  python3-yaml \
  python3-picamera2 \
  libatlas-base-dev \
  libopenblas-dev

echo "[INFO] Installing Qt GUI bindings"
if ! sudo apt-get install -y python3-pyqt6; then
  echo "[WARN] python3-pyqt6 was not available via apt. GUI can still run if PyQt6 or PySide6 is installed in the venv."
fi

sudo apt-get install -y rpicam-apps || sudo apt-get install -y libcamera-apps || true

echo "[INFO] Creating Python virtualenv with system site packages"
python3 -m venv --system-site-packages .venv
# shellcheck disable=SC1091
source .venv/bin/activate
python3 -m pip install --upgrade pip
python3 -m pip install PyYAML pymavlink pytest

if ! python3 -c "import cv2" >/dev/null 2>&1; then
  echo "[WARN] apt OpenCV not visible in venv; installing opencv-python wheel"
  python3 -m pip install opencv-python numpy
fi

if [ "${WITH_YOLO}" -eq 1 ]; then
  echo "[INFO] Installing optional Ultralytics YOLO dependency"
  python3 -m pip install ultralytics
fi

chmod +x scripts/run_pi5.sh scripts/capture_dataset_frames.py scripts/generate_synthetic_dataset.py scripts/train_yolo.py

echo "[TEST] Import check"
python3 - <<'PY'
import cv2
import numpy
import yaml
from pymavlink import mavutil
print("OpenCV", cv2.__version__)
print("NumPy", numpy.__version__)
print("PyYAML", yaml.__version__)
print("pymavlink OK")
PY

echo "[DONE] Install complete"
echo "Run: ./scripts/run_pi5.sh --config config/default.yaml --detector hsv --source pi"
echo "GUI: python3 src/gui/app.py --config config/default.yaml"
