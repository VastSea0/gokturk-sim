#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_DIR}"

if [ -d ".venv" ]; then
  # shellcheck disable=SC1091
  source ".venv/bin/activate"
fi

python3 - <<'PY'
try:
    import PyQt6  # noqa: F401
except ImportError:
    try:
        import PySide6  # noqa: F401
    except ImportError:
        raise SystemExit(
            "[ERROR] PyQt6/PySide6 is not installed.\n"
            "        Mac: ./scripts/install_mac_gui.sh\n"
            "        Raspberry Pi: sudo apt install python3-pyqt6"
        )
PY

exec python3 src/gui/app.py "$@"
