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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Record Raspberry Pi Camera video for marker dataset collection")
    parser.add_argument("--output", default="dataset_raw/videos/pi_marker_capture.mp4")
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--fps", type=int, default=20)
    parser.add_argument("--duration", type=float, default=60.0)
    parser.add_argument("--show", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    source = PiCameraSource({"width": args.width, "height": args.height, "fps": args.fps, "format": "BGR888"})
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(str(output_path), fourcc, args.fps, (args.width, args.height))
    if not writer.isOpened():
        raise SystemExit(f"Could not open output video writer: {output_path}")

    source.start()
    start_s = time.monotonic()
    frames = 0
    try:
        while time.monotonic() - start_s < args.duration:
            frame = source.read()
            if frame is None:
                continue
            if frame.shape[1] != args.width or frame.shape[0] != args.height:
                frame = cv2.resize(frame, (args.width, args.height), interpolation=cv2.INTER_AREA)
            writer.write(frame)
            frames += 1
            if args.show:
                cv2.imshow("Pi Camera dataset recording", frame)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
    finally:
        source.release()
        writer.release()
        if args.show:
            cv2.destroyAllWindows()

    print(f"[DONE] Recorded {frames} frames to {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

