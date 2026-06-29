#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_DIR}"

python3 -m venv .venv
# shellcheck disable=SC1091
source ".venv/bin/activate"

python3 -m pip install --upgrade pip
python3 -m pip install -r requirements.txt PySide6

if [[ "${1:-}" == "--with-yolo" ]]; then
  python3 -m pip install ultralytics
fi

PYTHONPATH=src python3 - <<'PY'
from gui.qt_compat import QT_API
print(f"[OK] GUI dependency ready: {QT_API}")
PY

echo "[DONE] Mac GUI environment is ready."
echo "Run: ./scripts/run_macbook_gui.sh"
