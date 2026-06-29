#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_DIR}"

SOURCE="${SOURCE:-webcam}"
CAMERA_INDEX="${CAMERA_INDEX:-0}"
VIDEO="${VIDEO:-sample_data/test.mp4}"
CONFIG="${CONFIG:-config/default.yaml}"
WEIGHTS="${WEIGHTS:-}"
DETECTOR="${DETECTOR:-hybrid}"
MAX_FRAMES="${MAX_FRAMES:-}"
DRAW_DEBUG="${DRAW_DEBUG:-1}"
SHOW_WINDOW="${SHOW_WINDOW:-1}"
JSON_LOG="${JSON_LOG:-logs/macbook_yolo_detections.jsonl}"

if [[ -z "${WEIGHTS}" ]]; then
  WEIGHTS="$(find runs -path '*/weights/best.pt' -type f 2>/dev/null | sort | tail -n 1 || true)"
fi

if [[ -z "${WEIGHTS}" || ! -f "${WEIGHTS}" ]]; then
  echo "[ERROR] No trained YOLO weights found."
  echo "        First run:"
  echo "        ./scripts/run_synthetic_marker_pipeline.sh quick"
  echo
  echo "        Or pass a checkpoint explicitly:"
  echo "        WEIGHTS=/path/to/best.pt ./scripts/run_macbook_yolo.sh"
  exit 1
fi

cmd=(
  python3 src/main.py
  --config "${CONFIG}"
  --detector "${DETECTOR}"
  --weights "${WEIGHTS}"
  --source "${SOURCE}"
  --json-log "${JSON_LOG}"
)

if [[ "${SOURCE}" == "webcam" ]]; then
  cmd+=(--camera-index "${CAMERA_INDEX}")
elif [[ "${SOURCE}" == "video" ]]; then
  cmd+=(--video "${VIDEO}" --loop-video)
else
  echo "[ERROR] SOURCE must be webcam or video on MacBook. Got: ${SOURCE}"
  exit 2
fi

if [[ "${SHOW_WINDOW}" == "1" ]]; then
  cmd+=(--show)
fi

if [[ "${DRAW_DEBUG}" == "1" ]]; then
  cmd+=(--draw-debug)
fi

if [[ -n "${MAX_FRAMES}" ]]; then
  cmd+=(--max-frames "${MAX_FRAMES}")
fi

echo "[INFO] Running MacBook YOLO marker detector"
echo "[INFO] Detector: ${DETECTOR}"
echo "[INFO] Source: ${SOURCE}"
echo "[INFO] Weights: ${WEIGHTS}"
echo "[INFO] JSON log: ${JSON_LOG}"
echo "[INFO] Press q in the OpenCV window to quit."
echo
printf '[CMD] '
printf '%q ' "${cmd[@]}"
echo

"${cmd[@]}"
