#!/usr/bin/env python3
from __future__ import annotations

import argparse


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate a trained YOLO marker model")
    parser.add_argument("--weights", required=True)
    parser.add_argument("--data", required=True)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--conf", type=float, default=0.25)
    parser.add_argument("--iou", type=float, default=0.45)
    parser.add_argument("--device", default=None)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        from ultralytics import YOLO
    except ImportError as exc:
        raise SystemExit("ultralytics is not installed. Run: pip install ultralytics") from exc

    model = YOLO(args.weights)
    metrics = model.val(data=args.data, imgsz=args.imgsz, conf=args.conf, iou=args.iou, device=args.device)
    print(metrics)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

