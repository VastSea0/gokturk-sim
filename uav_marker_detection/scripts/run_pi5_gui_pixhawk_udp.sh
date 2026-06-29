#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_DIR}"

PORT="${PORT:-14550}"
CONNECTION="${MAVLINK_CONNECTION:-udpin:0.0.0.0:${PORT}}"

exec "${SCRIPT_DIR}/run_gui.sh" \
  --source pi \
  --mavlink "${CONNECTION}" \
  --auto-connect-mavlink \
  "$@"
