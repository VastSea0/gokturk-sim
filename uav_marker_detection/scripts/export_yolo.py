#!/usr/bin/env python3
from __future__ import annotations

import argparse


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export YOLO marker model for Raspberry Pi inference")
    parser.add_argument("--weights", required=True)
    parser.add_argument("--format", default="onnx", choices=["onnx", "ncnn", "tflite", "openvino", "torchscript"])
    parser.add_argument("--imgsz", type=int, default=320)
    parser.add_argument("--half", action="store_true")
    parser.add_argument("--int8", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        from ultralytics import YOLO
    except ImportError as exc:
        raise SystemExit("ultralytics is not installed. Run: pip install ultralytics") from exc

    model = YOLO(args.weights)
    output = model.export(format=args.format, imgsz=args.imgsz, half=args.half, int8=args.int8)
    print(f"[DONE] Exported model: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

