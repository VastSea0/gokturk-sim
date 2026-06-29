#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path
from typing import Any, Dict, Optional


SRC_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = SRC_DIR.parent
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from utils.config_loader import load_config
from utils.platform_profile import default_camera_source, platform_profile_name


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Qt GUI for UAV red/blue marker detection")
    parser.add_argument("--config", default="config/default.yaml", help="YAML config path")
    parser.add_argument("--source", choices=["auto", "pi", "webcam", "video"], default="auto")
    parser.add_argument("--detector", choices=["auto", "color", "hsv", "hybrid", "yolo", "yolo_seg"], default="auto")
    parser.add_argument("--weights", help="YOLO/hybrid weights path")
    parser.add_argument("--video", help="Video path for simulation/video test mode")
    parser.add_argument("--camera-index", type=int, help="OpenCV webcam index on Mac/Linux")
    parser.add_argument("--mavlink", help="Auto-connect GUI MAVLink panel, e.g. udpin:0.0.0.0:14550")
    parser.add_argument("--mavlink-baud", type=int, default=57600)
    parser.add_argument("--auto-connect-mavlink", action="store_true")
    return parser.parse_args()


def resolve_config(path_text: str) -> Path:
    path = Path(path_text)
    if path.is_absolute():
        return path
    cwd_path = Path.cwd() / path
    if cwd_path.exists():
        return cwd_path
    return PROJECT_DIR / path


def resolve_project_path(path_text: Optional[str]) -> Optional[Path]:
    if not path_text:
        return None
    path = Path(path_text).expanduser()
    if path.is_absolute():
        return path
    return PROJECT_DIR / path


def find_latest_weights() -> Optional[Path]:
    candidates = []
    model_path = PROJECT_DIR / "models" / "best.pt"
    if model_path.exists():
        candidates.append(model_path)
    candidates.extend(PROJECT_DIR.glob("runs/**/weights/best.pt"))
    candidates = [path for path in candidates if path.exists()]
    if not candidates:
        return None
    return max(candidates, key=lambda path: path.stat().st_mtime)


def yolo_runtime_available() -> bool:
    return importlib.util.find_spec("ultralytics") is not None


def resolve_initial_settings(config: Dict[str, Any], args: argparse.Namespace) -> Dict[str, Any]:
    gui_cfg = config.get("gui", {}) or {}
    source = args.source
    if source == "auto":
        source = str(gui_cfg.get("default_source", "auto"))
    if source == "auto":
        source = default_camera_source()

    weights_path = resolve_project_path(args.weights)
    if weights_path is None:
        configured_weights = (
            config.get("detection", {}).get("hybrid", {}).get("weights_path")
            or config.get("detection", {}).get("yolo", {}).get("weights_path")
        )
        candidate = resolve_project_path(configured_weights)
        if candidate is not None and candidate.exists():
            weights_path = candidate
    if weights_path is None or not weights_path.exists():
        weights_path = find_latest_weights()

    detector = args.detector
    if detector == "auto":
        detector = str(gui_cfg.get("default_detector", "auto"))
    if detector == "auto":
        detector = "hybrid" if weights_path is not None and yolo_runtime_available() else "color"

    video_path = resolve_project_path(args.video) if args.video else resolve_project_path(gui_cfg.get("default_video", "sample_data/test.mp4"))
    camera_index = args.camera_index
    if camera_index is None:
        camera_index = int(gui_cfg.get("default_camera_index", 0))

    return {
        "source": source,
        "detector": detector,
        "weights": str(weights_path) if weights_path is not None else "",
        "video": str(video_path) if video_path is not None else "",
        "camera_index": camera_index,
        "platform_profile": platform_profile_name(),
        "mavlink": args.mavlink,
        "mavlink_baud": int(args.mavlink_baud),
        "auto_connect_mavlink": bool(args.auto_connect_mavlink or args.mavlink),
    }


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
    initial_settings = resolve_initial_settings(config, args)
    app = QtWidgets.QApplication([sys.argv[0]])
    app.setApplicationName("UAV Marker Detection")
    
    try:
        from gui.style import MATERIAL3_STYLE
        app.setStyleSheet(MATERIAL3_STYLE)
    except ImportError:
        pass
        
    window = MainWindow(
        config=config,
        config_path=config_path,
        project_dir=PROJECT_DIR,
        initial_settings=initial_settings,
    )
    window.statusBar().showMessage(
        f"Loaded {config_path} with {QT_API} | profile={initial_settings.get('platform_profile')}"
    )
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
