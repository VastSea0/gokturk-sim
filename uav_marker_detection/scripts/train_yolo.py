#!/usr/bin/env python3
from __future__ import annotations

import argparse


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train a lightweight YOLO marker detector")
    parser.add_argument("--data", required=True, help="YOLO data.yaml path")
    parser.add_argument("--model", default="yolov8n.pt", help="Base model, e.g. yolov8n.pt or yolo11n.pt")
    parser.add_argument("--task", choices=["detect", "segment"], default="detect")
    parser.add_argument("--epochs", type=int, default=80)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--device", default=None)
    parser.add_argument("--project", default="runs/marker_yolo")
    parser.add_argument("--name", default="red_blue_markers")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        from ultralytics import YOLO
    except ImportError as exc:
        raise SystemExit("ultralytics is not installed. Run: pip install ultralytics") from exc

    model = YOLO(args.model)
    model.train(
        data=args.data,
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=args.device,
        project=args.project,
        name=args.name,
        task=args.task,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
