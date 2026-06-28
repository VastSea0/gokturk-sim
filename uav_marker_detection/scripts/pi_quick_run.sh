#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_DIR}"

if [ -d ".venv" ] && [ -f ".venv/bin/activate" ]; then
  # shellcheck disable=SC1091
  source ".venv/bin/activate"
fi

CONFIG="${CONFIG:-config/default.yaml}"
DETECTOR="${DETECTOR:-color}"
VIDEO="${VIDEO:-sample_data/test.mp4}"

usage() {
  cat <<'EOF'
UAV Marker Detection Raspberry Pi quick runner

Usage:
  ./scripts/pi_quick_run.sh <command> [args]

Commands:
  install                 Install Pi dependencies
  install-yolo            Install Pi dependencies + Ultralytics YOLO
  smoke                   Generate sample video and test default color detector
  camera                  Run Pi Camera detector in terminal/headless mode
  camera-debug            Run Pi Camera detector with preview overlay
  blue-mask               Show/debug blue color mask from Pi Camera
  video [path]            Run detector on a video file
  gui                     Start Qt GUI
  record [sec] [path]     Record Pi Camera video for dataset collection
  udp [host] [port]       Run Pi Camera detector and send UDP JSON
  mavlink [port] [baud]   Run Pi Camera detector with Pixhawk serial MAVLink
  yolo <weights>          Run YOLO detection model on Pi Camera
  yolo-seg <weights>      Run YOLO segmentation model on Pi Camera
  help                    Show this help

Examples:
  ./scripts/pi_quick_run.sh smoke
  ./scripts/pi_quick_run.sh camera
  ./scripts/pi_quick_run.sh blue-mask
  ./scripts/pi_quick_run.sh mavlink /dev/ttyUSB0 57600
  ./scripts/pi_quick_run.sh udp 192.168.1.20 15000
EOF
}

require_python() {
  command -v python3 >/dev/null 2>&1 || {
    echo "[ERROR] python3 not found"
    exit 1
  }
}

cmd="${1:-help}"
shift || true

case "${cmd}" in
  install)
    chmod +x scripts/install_pi5.sh
    exec scripts/install_pi5.sh
    ;;

  install-yolo)
    chmod +x scripts/install_pi5.sh
    exec scripts/install_pi5.sh --with-yolo
    ;;

  smoke)
    require_python
    python3 scripts/generate_sample_video.py
    exec python3 src/main.py \
      --config "${CONFIG}" \
      --detector "${DETECTOR}" \
      --source video \
      --video "${VIDEO}" \
      --draw-debug \
      --print-empty \
      --max-frames 100
    ;;

  camera)
    require_python
    exec python3 src/main.py \
      --config "${CONFIG}" \
      --detector "${DETECTOR}" \
      --source pi
    ;;

  camera-debug)
    require_python
    exec python3 src/main.py \
      --config "${CONFIG}" \
      --detector "${DETECTOR}" \
      --source pi \
      --draw-debug \
      --show
    ;;

  blue-mask)
    require_python
    exec python3 src/main.py \
      --config "${CONFIG}" \
      --detector color \
      --source pi \
      --draw-debug \
      --debug-view mask_blue \
      --show
    ;;

  video)
    require_python
    input_video="${1:-${VIDEO}}"
    exec python3 src/main.py \
      --config "${CONFIG}" \
      --detector "${DETECTOR}" \
      --source video \
      --video "${input_video}" \
      --loop-video \
      --draw-debug
    ;;

  gui)
    require_python
    exec python3 src/gui/app.py --config "${CONFIG}"
    ;;

  record)
    require_python
    duration="${1:-60}"
    output="${2:-dataset_raw/videos/pi_marker_capture.mp4}"
    exec python3 scripts/record_pi_camera_video.py \
      --duration "${duration}" \
      --output "${output}"
    ;;

  udp)
    require_python
    host="${1:-127.0.0.1}"
    port="${2:-15000}"
    exec python3 src/main.py \
      --config "${CONFIG}" \
      --detector "${DETECTOR}" \
      --source pi \
      --udp-host "${host}" \
      --udp-port "${port}"
    ;;

  mavlink)
    require_python
    serial_port="${1:-/dev/ttyUSB0}"
    baud="${2:-57600}"
    exec python3 src/main.py \
      --config "${CONFIG}" \
      --detector "${DETECTOR}" \
      --source pi \
      --mavlink "${serial_port}" \
      --mavlink-baud "${baud}" \
      --log-level INFO
    ;;

  yolo)
    require_python
    weights="${1:-}"
    if [ -z "${weights}" ]; then
      echo "[ERROR] Missing YOLO weights path"
      echo "Example: ./scripts/pi_quick_run.sh yolo models/best.pt"
      exit 2
    fi
    exec python3 src/main.py \
      --config "${CONFIG}" \
      --detector yolo \
      --weights "${weights}" \
      --source pi
    ;;

  yolo-seg)
    require_python
    weights="${1:-}"
    if [ -z "${weights}" ]; then
      echo "[ERROR] Missing YOLO segmentation weights path"
      echo "Example: ./scripts/pi_quick_run.sh yolo-seg models/best-seg.pt"
      exit 2
    fi
    exec python3 src/main.py \
      --config "${CONFIG}" \
      --detector yolo_seg \
      --weights "${weights}" \
      --source pi
    ;;

  help|-h|--help)
    usage
    ;;

  *)
    echo "[ERROR] Unknown command: ${cmd}"
    usage
    exit 2
    ;;
esac
