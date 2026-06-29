#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_DIR}"

if [ -d ".venv" ]; then
  # shellcheck disable=SC1091
  source ".venv/bin/activate"
fi

CONNECTION="${1:-${MAVLINK_CONNECTION:-udpin:0.0.0.0:14550}}"
TIMEOUT="${TIMEOUT:-45}"

echo "[INFO] Raspberry Pi IP addresses:"
hostname -I 2>/dev/null || true
echo "[INFO] Monitoring MAVLink: ${CONNECTION}"
echo "[INFO] Tip: if this says WAIT forever, Pixhawk/PX4 is not sending heartbeat to this Pi/port."

exec python3 scripts/mavlink_diagnostics.py --connection "${CONNECTION}" --timeout "${TIMEOUT}"
