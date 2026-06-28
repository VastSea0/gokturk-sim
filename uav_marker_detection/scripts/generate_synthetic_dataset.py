#!/usr/bin/env python3
from __future__ import annotations

import argparse
import math
import random
from pathlib import Path
from typing import List, Tuple

import cv2
import numpy as np


CLASS_NAMES = ["red_marker", "blue_marker"]
COLORS_BGR = {
    0: (0, 0, 230),
    1: (230, 70, 0),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate synthetic YOLO data for red/blue square markers")
    parser.add_argument("--output", default="synthetic_marker_dataset")
    parser.add_argument("--count", type=int, default=600)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--val-ratio", type=float, default=0.2)
    parser.add_argument("--test-ratio", type=float, default=0.1)
    return parser.parse_args()


def make_background(width: int, height: int) -> np.ndarray:
    base = np.zeros((height, width, 3), dtype=np.uint8)
    palette = [
        np.array([55, 95, 55], dtype=np.uint8),
        np.array([95, 90, 80], dtype=np.uint8),
        np.array([120, 120, 115], dtype=np.uint8),
        np.array([80, 110, 70], dtype=np.uint8),
    ]
    color = random.choice(palette)
    base[:] = color
    sigma = random.uniform(6, 22)
    noise = np.zeros(base.shape, dtype=np.float32)
    cv2.randn(noise, (0, 0, 0), (sigma, sigma, sigma))
    image = np.clip(base.astype(np.float32) + noise, 0, 255).astype(np.uint8)

    for _ in range(random.randint(3, 10)):
        x1 = random.randint(0, width - 1)
        y1 = random.randint(0, height - 1)
        x2 = min(width - 1, max(0, x1 + random.randint(-180, 180)))
        y2 = min(height - 1, max(0, y1 + random.randint(-180, 180)))
        line_color = tuple(int(np.clip(int(color[i]) + random.randint(-35, 35), 0, 255)) for i in range(3))
        cv2.line(image, (x1, y1), (x2, y2), line_color, random.randint(1, 4))
    return image


def random_marker_polygon(width: int, height: int) -> Tuple[np.ndarray, Tuple[int, int, int, int]]:
    size = random.randint(max(24, width // 18), max(38, width // 5))
    cx = random.randint(size, width - size)
    cy = random.randint(size, height - size)
    half = size / 2.0
    pts = np.array(
        [[-half, -half], [half, -half], [half, half], [-half, half]],
        dtype=np.float32,
    )
    angle = random.uniform(-50, 50) * math.pi / 180.0
    rot = np.array([[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]], dtype=np.float32)
    pts = pts @ rot.T
    perspective = np.array(
        [[random.uniform(-0.22, 0.22), random.uniform(-0.22, 0.22)] for _ in range(4)],
        dtype=np.float32,
    ) * size
    pts = pts + perspective + np.array([cx, cy], dtype=np.float32)
    pts[:, 0] = np.clip(pts[:, 0], 0, width - 1)
    pts[:, 1] = np.clip(pts[:, 1], 0, height - 1)
    x, y, w, h = cv2.boundingRect(pts.astype(np.int32))
    return pts.astype(np.int32), (x, y, x + w, y + h)


def apply_augmentations(image: np.ndarray) -> np.ndarray:
    alpha = random.uniform(0.65, 1.35)
    beta = random.randint(-25, 25)
    image = cv2.convertScaleAbs(image, alpha=alpha, beta=beta)
    if random.random() < 0.35:
        k = random.choice([3, 5])
        image = cv2.GaussianBlur(image, (k, k), 0)
    if random.random() < 0.45:
        overlay = image.copy()
        x1 = random.randint(0, image.shape[1] - 1)
        x2 = random.randint(0, image.shape[1] - 1)
        cv2.rectangle(overlay, (min(x1, x2), 0), (max(x1, x2), image.shape[0]), (20, 20, 20), -1)
        image = cv2.addWeighted(overlay, random.uniform(0.10, 0.28), image, 1.0 - random.uniform(0.10, 0.28), 0)
    return image


def yolo_label(cls_id: int, bbox: Tuple[int, int, int, int], width: int, height: int) -> str:
    x1, y1, x2, y2 = bbox
    xc = ((x1 + x2) / 2.0) / width
    yc = ((y1 + y2) / 2.0) / height
    bw = (x2 - x1) / width
    bh = (y2 - y1) / height
    return f"{cls_id} {xc:.6f} {yc:.6f} {bw:.6f} {bh:.6f}"


def split_name(index: int, count: int, val_ratio: float, test_ratio: float) -> str:
    frac = index / max(count, 1)
    if frac < 1.0 - val_ratio - test_ratio:
        return "train"
    if frac < 1.0 - test_ratio:
        return "val"
    return "test"


def main() -> int:
    args = parse_args()
    random.seed(args.seed)
    root = Path(args.output)

    for split in ["train", "val", "test"]:
        (root / "images" / split).mkdir(parents=True, exist_ok=True)
        (root / "labels" / split).mkdir(parents=True, exist_ok=True)

    indices = list(range(args.count))
    random.shuffle(indices)
    for out_index, _ in enumerate(indices):
        split = split_name(out_index, args.count, args.val_ratio, args.test_ratio)
        image = make_background(args.width, args.height)
        labels: List[str] = []
        for _marker in range(random.randint(1, 3)):
            cls_id = random.randint(0, 1)
            polygon, bbox = random_marker_polygon(args.width, args.height)
            cv2.fillConvexPoly(image, polygon, COLORS_BGR[cls_id])
            cv2.polylines(image, [polygon], True, (245, 245, 245), random.choice([1, 2]))
            labels.append(yolo_label(cls_id, bbox, args.width, args.height))
        image = apply_augmentations(image)

        stem = f"synthetic_{out_index:06d}"
        cv2.imwrite(str(root / "images" / split / f"{stem}.jpg"), image)
        (root / "labels" / split / f"{stem}.txt").write_text("\n".join(labels) + "\n", encoding="utf-8")

    data_yaml = (
        f"path: {root.resolve()}\n"
        "train: images/train\n"
        "val: images/val\n"
        "test: images/test\n"
        "names:\n"
        "  0: red_marker\n"
        "  1: blue_marker\n"
    )
    (root / "data.yaml").write_text(data_yaml, encoding="utf-8")
    print(f"[DONE] Generated {args.count} synthetic images at {root}")
    print(f"[DATA] {root / 'data.yaml'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
