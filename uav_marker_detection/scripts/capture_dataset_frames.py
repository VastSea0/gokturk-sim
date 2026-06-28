#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import cv2

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from camera.pi_camera import PiCameraSource
from camera.video_file_camera import VideoFileCamera


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Capture frames for red/blue marker datasets")
    parser.add_argument("--source", choices=["video", "pi"], default="video")
    parser.add_argument("--video", help="Input video path for --source video")
    parser.add_argument("--output", default="dataset_raw/frames", help="Output image directory")
    parser.add_argument("--every-n", type=int, default=10, help="Save every Nth frame")
    parser.add_argument("--max-images", type=int, default=500, help="Stop after saving this many images")
    parser.add_argument("--prefix", default="marker", help="Output filename prefix")
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--fps", type=int, default=20)
    parser.add_argument("--show", action="store_true", help="Preview frames while capturing")
    return parser.parse_args()


def build_source(args: argparse.Namespace):
    if args.source == "video":
        if not args.video:
            raise ValueError("--video is required with --source video")
        return VideoFileCamera(args.video)
    return PiCameraSource({"width": args.width, "height": args.height, "fps": args.fps, "format": "RGB888"})


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    source = build_source(args)
    source.start()

    frame_id = 0
    saved = 0
    try:
        while saved < args.max_images:
            frame = source.read()
            if frame is None:
                break
            frame_id += 1
            if frame_id % max(1, args.every_n) == 0:
                path = output_dir / f"{args.prefix}_{int(time.time())}_{frame_id:06d}.jpg"
                cv2.imwrite(str(path), frame)
                saved += 1
                print(f"[SAVE] {path}")

            if args.show:
                cv2.imshow("Dataset capture", frame)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
    finally:
        source.release()
        if args.show:
            cv2.destroyAllWindows()
    print(f"[DONE] saved={saved} output={output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

