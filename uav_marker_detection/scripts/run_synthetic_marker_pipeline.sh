#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_DIR}"

display_path() {
  local path="$1"
  if [[ "${path}" = /* ]]; then
    echo "${path}"
  else
    echo "${PROJECT_DIR}/${path}"
  fi
}

MODE="${1:-quick}"
DATASET_DIR="${DATASET_DIR:-datasets/uav_markers_synth_detect}"
MODEL="${MODEL:-yolov8n.pt}"
DEVICE="${DEVICE:-auto}"
BATCH="${BATCH:-16}"
RUN_NAME="${RUN_NAME:-uav_markers_synth_${MODE}}"
PROJECT="${PROJECT:-runs/synth_marker_pipeline}"

if [[ "${DEVICE}" == "auto" ]]; then
  if python3 - <<'PY'
import torch
raise SystemExit(0 if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available() else 1)
PY
  then
    DEVICE="mps"
  else
    DEVICE="cpu"
  fi
fi

case "${MODE}" in
  quick)
    COUNT="${COUNT:-900}"
    EPOCHS="${EPOCHS:-5}"
    IMGSZ="${IMGSZ:-320}"
    ;;
  full)
    COUNT="${COUNT:-4000}"
    EPOCHS="${EPOCHS:-80}"
    IMGSZ="${IMGSZ:-640}"
    ;;
  dataset-only)
    COUNT="${COUNT:-900}"
    EPOCHS="${EPOCHS:-0}"
    IMGSZ="${IMGSZ:-320}"
    ;;
  *)
    echo "Usage: $0 [quick|full|dataset-only]"
    echo
    echo "Examples:"
    echo "  ./scripts/run_synthetic_marker_pipeline.sh quick"
    echo "  EPOCHS=50 COUNT=3000 IMGSZ=640 ./scripts/run_synthetic_marker_pipeline.sh full"
    echo "  ./scripts/run_synthetic_marker_pipeline.sh dataset-only"
    exit 2
    ;;
esac

echo "[INFO] Project: ${PROJECT_DIR}"
echo "[INFO] Mode: ${MODE}"
echo "[INFO] Dataset: ${DATASET_DIR}"
echo "[INFO] Device: ${DEVICE}"

python3 -m pip show ultralytics >/dev/null 2>&1 || {
  echo "[INFO] Installing ultralytics for local training/inference..."
  python3 -m pip install --user ultralytics
}

echo "[INFO] Generating synthetic UAV marker dataset..."
python3 scripts/generate_uav_synthetic_markers.py \
  --output "${DATASET_DIR}" \
  --count "${COUNT}" \
  --width 640 \
  --height 480 \
  --task detect \
  --clean \
  --seed 42

echo "[INFO] Dataset ready:"
echo "       $(display_path "${DATASET_DIR}")/data.yaml"
echo "       $(display_path "${DATASET_DIR}")/preview_contact_sheet.jpg"

if [[ "${MODE}" == "dataset-only" ]]; then
  echo "[DONE] Dataset generated only. No training was run."
  exit 0
fi

echo "[INFO] Training YOLO detector..."
python3 scripts/train_yolo.py \
  --data "${DATASET_DIR}/data.yaml" \
  --model "${MODEL}" \
  --task detect \
  --epochs "${EPOCHS}" \
  --imgsz "${IMGSZ}" \
  --batch "${BATCH}" \
  --device "${DEVICE}" \
  --project "${PROJECT}" \
  --name "${RUN_NAME}"

BEST_WEIGHTS="${PROJECT}/${RUN_NAME}/weights/best.pt"

echo "[INFO] Validating best checkpoint..."
python3 scripts/validate_yolo.py \
  --weights "${BEST_WEIGHTS}" \
  --data "${DATASET_DIR}/data.yaml" \
  --imgsz "${IMGSZ}" \
  --device "${DEVICE}"

echo "[DONE] Synthetic pipeline complete."
echo "       Dataset: $(display_path "${DATASET_DIR}")"
echo "       Weights: $(display_path "${BEST_WEIGHTS}")"
echo
echo "Run on a video:"
echo "  python3 src/main.py --config config/default.yaml --detector yolo --weights ${BEST_WEIGHTS} --source video --video sample_data/test.mp4"
echo
echo "Run on Raspberry Pi camera:"
echo "  python3 src/main.py --config config/default.yaml --detector yolo --weights ${BEST_WEIGHTS} --source pi"
