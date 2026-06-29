from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from detection.adaptive_color_detector import AdaptiveColorMarkerDetector


def _motion_blur(frame, kernel_size=9):
    kernel = np.zeros((kernel_size, kernel_size), dtype=np.float32)
    kernel[kernel_size // 2, :] = 1.0
    kernel /= kernel_size
    return cv2.filter2D(frame, -1, kernel)


def test_adaptive_color_detector_finds_blue_under_motion_blur() -> None:
    frame = np.zeros((360, 480, 3), dtype=np.uint8)
    frame[:] = (55, 95, 60)
    cv2.rectangle(frame, (250, 160), (350, 230), (240, 70, 10), -1)
    blurred = _motion_blur(frame)

    detections = AdaptiveColorMarkerDetector({"min_area_px": 120}).detect(blurred)
    classes = {d.class_name for d in detections}

    assert "blue_marker" in classes


def test_adaptive_color_detector_finds_red_and_blue_without_square_requirement() -> None:
    frame = np.zeros((400, 600, 3), dtype=np.uint8)
    frame[:] = (85, 95, 80)
    red_poly = np.array([[60, 80], [180, 70], [210, 140], [90, 175]], dtype=np.int32)
    blue_poly = np.array([[330, 210], [500, 230], [470, 300], [310, 285]], dtype=np.int32)
    cv2.fillConvexPoly(frame, red_poly, (0, 0, 230))
    cv2.fillConvexPoly(frame, blue_poly, (230, 65, 15))

    detections = AdaptiveColorMarkerDetector({"min_area_px": 120}).detect(frame)
    classes = {d.class_name for d in detections}

    assert "red_marker" in classes
    assert "blue_marker" in classes


def test_adaptive_color_detector_ignores_skin_like_red_but_finds_large_blue() -> None:
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    frame[:] = (220, 218, 208)
    cv2.rectangle(frame, (330, 80), (560, 440), (235, 70, 10), -1)
    cv2.rectangle(frame, (40, 160), (260, 390), (80, 135, 195), -1)

    detections = AdaptiveColorMarkerDetector(
        {
            "min_area_px": 500,
            "max_area_fraction": 0.85,
            "min_color_fill": 0.18,
            "red_dominance_min": 0.12,
            "red_lab_a_min": 150,
            "blue_dominance_min": 0.08,
        }
    ).detect(frame)

    assert any(d.class_name == "blue_marker" for d in detections)
    assert not any(d.class_name == "red_marker" for d in detections)
