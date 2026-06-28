#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Raspberry Pi marker inference with HSV/color/YOLO backends")
    parser.add_argument("--config", default="config/default.yaml")
    parser.add_argument("--detector", choices=["color", "hsv", "yolo", "yolo_seg"], default="color")
    parser.add_argument("--weights", default="")
    parser.add_argument("--source", choices=["pi", "video"], default="pi")
    parser.add_argument("--video", default="")
    parser.add_argument("--mavlink", default="")
    parser.add_argument("--draw-debug", action="store_true")
    parser.add_argument("--debug-view", choices=["overlay", "mask_overlay", "mask_red", "mask_blue", "mask_combined"], default="overlay")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    cmd = [
        sys.executable,
        "src/main.py",
        "--config",
        args.config,
        "--detector",
        args.detector,
        "--source",
        args.source,
    ]
    if args.weights:
        cmd.extend(["--weights", args.weights])
    if args.video:
        cmd.extend(["--video", args.video])
    if args.mavlink:
        cmd.extend(["--mavlink", args.mavlink])
    if args.draw_debug:
        cmd.append("--draw-debug")
    cmd.extend(["--debug-view", args.debug_view])
    return subprocess.call(cmd, cwd=str(ROOT))


if __name__ == "__main__":
    raise SystemExit(main())
