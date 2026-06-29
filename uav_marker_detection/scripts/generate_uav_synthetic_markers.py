#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import random
import shutil
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

import cv2
import numpy as np


CLASS_NAMES = ["red_marker", "blue_marker"]
CLASS_ROLES = {
    0: "enemy",
    1: "friendly",
}
COLORS_BGR = {
    0: (0, 0, 235),
    1: (235, 80, 10),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate realistic synthetic UAV red/blue 2x2m marker dataset in YOLO format"
    )
    parser.add_argument("--output", default="datasets/uav_markers_synth")
    parser.add_argument("--count", type=int, default=1200)
    parser.add_argument("--width", type=int, default=960)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--task", choices=["detect", "segment"], default="detect")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--val-ratio", type=float, default=0.18)
    parser.add_argument("--test-ratio", type=float, default=0.07)
    parser.add_argument("--min-markers", type=int, default=1)
    parser.add_argument("--max-markers", type=int, default=4)
    parser.add_argument("--clean", action="store_true", help="Remove output dir before generating")
    parser.add_argument("--preview-count", type=int, default=24)
    return parser.parse_args()


def split_name(index: int, total: int, val_ratio: float, test_ratio: float) -> str:
    frac = index / max(1, total)
    if frac < 1.0 - val_ratio - test_ratio:
        return "train"
    if frac < 1.0 - test_ratio:
        return "val"
    return "test"


def make_ground_texture(width: int, height: int) -> np.ndarray:
    base_choices = [
        np.array([58, 102, 55], dtype=np.uint8),   # grass
        np.array([92, 82, 68], dtype=np.uint8),    # dry dirt
        np.array([112, 112, 108], dtype=np.uint8), # concrete
        np.array([70, 76, 80], dtype=np.uint8),    # asphalt
        np.array([72, 112, 86], dtype=np.uint8),   # mixed field
    ]
    base = np.zeros((height, width, 3), dtype=np.uint8)
    base[:] = random.choice(base_choices)

    sigma = random.uniform(8, 28)
    gray_noise = np.zeros((height, width), dtype=np.float32)
    cv2.randn(gray_noise, 0, sigma)
    chroma_noise = np.zeros((height, width, 3), dtype=np.float32)
    cv2.randn(chroma_noise, (0, 0, 0), (sigma * 0.12, sigma * 0.12, sigma * 0.12))
    noise = gray_noise[:, :, None] + chroma_noise
    image = np.clip(base.astype(np.float32) + noise, 0, 255).astype(np.uint8)

    for scale in [0.25, 0.5, 1.0]:
        small_w = max(8, int(width * scale / 8))
        small_h = max(8, int(height * scale / 8))
        low_gray = np.random.default_rng(random.randint(0, 1_000_000)).normal(0, 18, (small_h, small_w))
        low = np.repeat(low_gray[:, :, None], 3, axis=2)
        low = cv2.resize(low.astype(np.float32), (width, height), interpolation=cv2.INTER_CUBIC)
        image = np.clip(image.astype(np.float32) + low * (0.35 / scale), 0, 255).astype(np.uint8)

    draw_random_ground_features(image)
    return image


def draw_random_ground_features(image: np.ndarray) -> None:
    height, width = image.shape[:2]
    ground_palette = [
        (42, 82, 38),    # dark grass
        (64, 112, 58),   # grass
        (86, 92, 72),    # dry grass
        (104, 88, 68),   # dirt
        (124, 120, 112), # concrete
        (64, 68, 70),    # asphalt
        (118, 130, 96),  # pale vegetation
    ]
    for _ in range(random.randint(8, 24)):
        color = random.choice(ground_palette)
        color = tuple(int(np.clip(color[c] + random.randint(-18, 18), 0, 255)) for c in range(3))
        p1 = (random.randint(-width // 5, width), random.randint(-height // 5, height))
        p2 = (random.randint(0, width + width // 5), random.randint(0, height + height // 5))
        cv2.line(image, p1, p2, color, random.randint(1, 8), cv2.LINE_AA)

    for _ in range(random.randint(2, 8)):
        center = (random.randint(0, width), random.randint(0, height))
        axes = (random.randint(15, 120), random.randint(8, 80))
        angle = random.uniform(0, 180)
        color = random.choice(ground_palette)
        color = tuple(int(np.clip(color[c] + random.randint(-20, 20), 0, 255)) for c in range(3))
        cv2.ellipse(image, center, axes, angle, 0, 360, color, -1, cv2.LINE_AA)


def marker_size_px(width: int, height: int) -> float:
    # Simulates a 2x2m marker seen from different UAV altitudes/FOVs.
    short_side = min(width, height)
    return random.uniform(short_side * 0.045, short_side * 0.19)


def random_marker_polygon(width: int, height: int) -> np.ndarray:
    size = marker_size_px(width, height)
    margin = int(size * 1.2)
    cx = random.randint(margin, max(margin + 1, width - margin))
    cy = random.randint(margin, max(margin + 1, height - margin))
    half = size / 2.0
    square = np.array(
        [[-half, -half], [half, -half], [half, half], [-half, half]],
        dtype=np.float32,
    )
    angle = math.radians(random.uniform(-75, 75))
    rot = np.array([[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]], dtype=np.float32)
    points = square @ rot.T

    perspective_strength = random.uniform(0.02, 0.32) * size
    points += np.array(
        [[random.uniform(-perspective_strength, perspective_strength), random.uniform(-perspective_strength, perspective_strength)]
         for _ in range(4)],
        dtype=np.float32,
    )
    points += np.array([cx, cy], dtype=np.float32)
    points[:, 0] = np.clip(points[:, 0], 1, width - 2)
    points[:, 1] = np.clip(points[:, 1], 1, height - 2)
    return points.astype(np.int32)


def draw_marker(image: np.ndarray, cls_id: int, polygon: np.ndarray) -> None:
    color = COLORS_BGR[cls_id]
    marker_layer = image.copy()
    cv2.fillConvexPoly(marker_layer, polygon, color)
    alpha = random.uniform(0.82, 1.0)
    cv2.addWeighted(marker_layer, alpha, image, 1.0 - alpha, 0, image)

    if random.random() < 0.70:
        border_color = (235, 235, 235)
        cv2.polylines(image, [polygon], True, border_color, random.choice([1, 2, 3]), cv2.LINE_AA)

    if random.random() < 0.35:
        x, y, w, h = cv2.boundingRect(polygon)
        for _ in range(random.randint(1, 3)):
            p1 = (random.randint(x, x + max(1, w)), random.randint(y, y + max(1, h)))
            p2 = (random.randint(x, x + max(1, w)), random.randint(y, y + max(1, h)))
            cv2.line(image, p1, p2, (40, 40, 40), random.randint(1, 3), cv2.LINE_AA)


def apply_scene_augmentations(image: np.ndarray) -> np.ndarray:
    image = apply_shadow(image)
    alpha = random.uniform(0.55, 1.45)
    beta = random.randint(-35, 35)
    image = cv2.convertScaleAbs(image, alpha=alpha, beta=beta)

    if random.random() < 0.45:
        k = random.choice([3, 5, 7])
        image = cv2.GaussianBlur(image, (k, k), 0)

    if random.random() < 0.55:
        image = apply_motion_blur(image, random.choice([5, 7, 9, 11, 13]), random.uniform(0, 180))

    if random.random() < 0.35:
        image = apply_vignette(image)

    if random.random() < 0.45:
        noise = np.zeros(image.shape, dtype=np.float32)
        cv2.randn(noise, (0, 0, 0), (random.uniform(3, 13),) * 3)
        image = np.clip(image.astype(np.float32) + noise, 0, 255).astype(np.uint8)

    if random.random() < 0.35:
        encode_param = [int(cv2.IMWRITE_JPEG_QUALITY), random.randint(45, 90)]
        ok, encoded = cv2.imencode(".jpg", image, encode_param)
        if ok:
            image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    return image


def apply_shadow(image: np.ndarray) -> np.ndarray:
    if random.random() > 0.55:
        return image
    height, width = image.shape[:2]
    overlay = image.copy()
    points = np.array(
        [
            [random.randint(-width // 4, width), random.randint(-height // 4, height)],
            [random.randint(0, width + width // 4), random.randint(-height // 4, height)],
            [random.randint(0, width + width // 4), random.randint(0, height + height // 4)],
            [random.randint(-width // 4, width), random.randint(0, height + height // 4)],
        ],
        dtype=np.int32,
    )
    cv2.fillConvexPoly(overlay, points, (15, 15, 15))
    return cv2.addWeighted(overlay, random.uniform(0.10, 0.32), image, random.uniform(0.68, 0.90), 0)


def apply_motion_blur(image: np.ndarray, kernel_size: int, angle_deg: float) -> np.ndarray:
    kernel = np.zeros((kernel_size, kernel_size), dtype=np.float32)
    kernel[kernel_size // 2, :] = 1.0
    rotation = cv2.getRotationMatrix2D((kernel_size / 2.0, kernel_size / 2.0), angle_deg, 1.0)
    kernel = cv2.warpAffine(kernel, rotation, (kernel_size, kernel_size))
    kernel /= max(kernel.sum(), 1.0)
    return cv2.filter2D(image, -1, kernel)


def apply_vignette(image: np.ndarray) -> np.ndarray:
    height, width = image.shape[:2]
    x = cv2.getGaussianKernel(width, width / random.uniform(1.8, 3.2))
    y = cv2.getGaussianKernel(height, height / random.uniform(1.8, 3.2))
    mask = y @ x.T
    mask = mask / mask.max()
    strength = random.uniform(0.25, 0.55)
    vignette = (1.0 - strength) + strength * mask
    return np.clip(image.astype(np.float32) * vignette[:, :, None], 0, 255).astype(np.uint8)


def bbox_from_polygon(polygon: np.ndarray, width: int, height: int) -> Tuple[int, int, int, int]:
    x, y, w, h = cv2.boundingRect(polygon)
    x1 = max(0, x)
    y1 = max(0, y)
    x2 = min(width - 1, x + w)
    y2 = min(height - 1, y + h)
    return x1, y1, x2, y2


def yolo_detect_label(cls_id: int, bbox: Sequence[int], width: int, height: int) -> str:
    x1, y1, x2, y2 = bbox
    xc = ((x1 + x2) / 2.0) / width
    yc = ((y1 + y2) / 2.0) / height
    bw = max(1, x2 - x1) / width
    bh = max(1, y2 - y1) / height
    return f"{cls_id} {xc:.6f} {yc:.6f} {bw:.6f} {bh:.6f}"


def yolo_segment_label(cls_id: int, polygon: np.ndarray, width: int, height: int) -> str:
    coords: List[str] = []
    for point in polygon.reshape(-1, 2):
        coords.append(f"{float(point[0]) / width:.6f}")
        coords.append(f"{float(point[1]) / height:.6f}")
    return f"{cls_id} " + " ".join(coords)


def draw_preview_box(image: np.ndarray, label: str, bbox: Sequence[int], polygon: np.ndarray) -> None:
    cls_id = int(label.split()[0])
    color = COLORS_BGR[cls_id]
    x1, y1, x2, y2 = bbox
    cv2.rectangle(image, (x1, y1), (x2, y2), color, 2)
    cv2.polylines(image, [polygon], True, color, 2)
    text = f"{CLASS_NAMES[cls_id]} ({CLASS_ROLES[cls_id]})"
    cv2.putText(image, text, (x1, max(18, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.48, color, 2, cv2.LINE_AA)


def write_data_yaml(root: Path, task: str) -> None:
    text = (
        f"path: {root.resolve()}\n"
        f"# task: {task}\n"
        "train: images/train\n"
        "val: images/val\n"
        "test: images/test\n"
        "names:\n"
        "  0: red_marker\n"
        "  1: blue_marker\n"
    )
    (root / "data.yaml").write_text(text, encoding="utf-8")


def create_contact_sheet(previews: List[np.ndarray], output_path: Path, thumb_w: int = 240) -> None:
    if not previews:
        return
    thumbs = []
    for image in previews:
        scale = thumb_w / image.shape[1]
        thumb_h = int(image.shape[0] * scale)
        thumbs.append(cv2.resize(image, (thumb_w, thumb_h), interpolation=cv2.INTER_AREA))
    cols = 4
    rows = math.ceil(len(thumbs) / cols)
    thumb_h = thumbs[0].shape[0]
    sheet = np.zeros((rows * thumb_h, cols * thumb_w, 3), dtype=np.uint8)
    sheet[:] = (20, 20, 20)
    for index, thumb in enumerate(thumbs):
        row = index // cols
        col = index % cols
        sheet[row * thumb_h : (row + 1) * thumb_h, col * thumb_w : (col + 1) * thumb_w] = thumb
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output_path), sheet)


def main() -> int:
    args = parse_args()
    random.seed(args.seed)
    root = Path(args.output)
    if args.clean and root.exists():
        shutil.rmtree(root)
    for split in ["train", "val", "test"]:
        (root / "images" / split).mkdir(parents=True, exist_ok=True)
        (root / "labels" / split).mkdir(parents=True, exist_ok=True)

    class_counts: Dict[str, int] = {name: 0 for name in CLASS_NAMES}
    split_counts: Dict[str, int] = {"train": 0, "val": 0, "test": 0}
    previews: List[np.ndarray] = []

    order = list(range(args.count))
    random.shuffle(order)
    for out_index, _ in enumerate(order):
        split = split_name(out_index, args.count, args.val_ratio, args.test_ratio)
        image = make_ground_texture(args.width, args.height)
        labels: List[str] = []
        preview = image.copy()
        marker_count = random.randint(args.min_markers, args.max_markers)

        occupied: List[Tuple[int, int, int, int]] = []
        for _ in range(marker_count):
            cls_id = random.randint(0, 1)
            polygon = random_marker_polygon(args.width, args.height)
            bbox = bbox_from_polygon(polygon, args.width, args.height)
            if too_much_overlap(bbox, occupied):
                continue
            occupied.append(bbox)
            draw_marker(image, cls_id, polygon)
            class_counts[CLASS_NAMES[cls_id]] += 1
            if args.task == "segment":
                labels.append(yolo_segment_label(cls_id, polygon, args.width, args.height))
            else:
                labels.append(yolo_detect_label(cls_id, bbox, args.width, args.height))
            draw_preview_box(preview, labels[-1], bbox, polygon)

        image = apply_scene_augmentations(image)
        if not labels:
            continue

        stem = f"uav_marker_{out_index:06d}"
        cv2.imwrite(str(root / "images" / split / f"{stem}.jpg"), image)
        (root / "labels" / split / f"{stem}.txt").write_text("\n".join(labels) + "\n", encoding="utf-8")
        split_counts[split] += 1
        if len(previews) < args.preview_count:
            previews.append(preview)

    write_data_yaml(root, args.task)
    create_contact_sheet(previews, root / "preview_contact_sheet.jpg")
    summary = {
        "task": args.task,
        "image_size": [args.width, args.height],
        "requested_images": args.count,
        "written_images": sum(split_counts.values()),
        "splits": split_counts,
        "classes": CLASS_NAMES,
        "roles": CLASS_ROLES,
        "object_counts": class_counts,
    }
    (root / "dataset_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    print(f"[DATA] {root / 'data.yaml'}")
    print(f"[PREVIEW] {root / 'preview_contact_sheet.jpg'}")
    return 0


def too_much_overlap(bbox: Sequence[int], occupied: List[Sequence[int]]) -> bool:
    for other in occupied:
        if iou(bbox, other) > 0.20:
            return True
    return False


def iou(first: Sequence[int], second: Sequence[int]) -> float:
    ax1, ay1, ax2, ay2 = first
    bx1, by1, bx2, by2 = second
    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)
    iw = max(0, ix2 - ix1)
    ih = max(0, iy2 - iy1)
    inter = iw * ih
    area_a = max(1, (ax2 - ax1) * (ay2 - ay1))
    area_b = max(1, (bx2 - bx1) * (by2 - by1))
    return inter / float(area_a + area_b - inter)


if __name__ == "__main__":
    raise SystemExit(main())
