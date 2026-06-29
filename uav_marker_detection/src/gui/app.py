#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path


SRC_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = SRC_DIR.parent
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from utils.config_loader import load_config


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Qt GUI for UAV red/blue marker detection")
    parser.add_argument("--config", default="config/default.yaml", help="YAML config path")
    return parser.parse_args()


def resolve_config(path_text: str) -> Path:
    path = Path(path_text)
    if path.is_absolute():
        return path
    cwd_path = Path.cwd() / path
    if cwd_path.exists():
        return cwd_path
    return PROJECT_DIR / path


def main() -> int:
    args = parse_args()
    config_path = resolve_config(args.config)
    if not config_path.exists():
        print(f"[ERROR] Config file not found: {config_path}", file=sys.stderr)
        return 2

    try:
        from gui.main_window import MainWindow
        from gui.qt_compat import QT_API, QtWidgets
    except ImportError as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 2

    config = load_config(config_path)
    app = QtWidgets.QApplication([sys.argv[0]])
    app.setApplicationName("UAV Marker Detection")
    
    try:
        from gui.style import MATERIAL3_STYLE
        app.setStyleSheet(MATERIAL3_STYLE)
    except ImportError:
        pass
        
    window = MainWindow(config=config, config_path=config_path, project_dir=PROJECT_DIR)
    window.statusBar().showMessage(f"Loaded {config_path} with {QT_API}")
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())

