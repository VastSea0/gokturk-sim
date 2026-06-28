from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from detection.hsv_marker_detector import HSVMarkerDetector


def test_hsv_detector_finds_red_and_blue_squares() -> None:
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    frame[:] = (45, 95, 45)
    cv2.rectangle(frame, (80, 90), (180, 190), (0, 0, 255), -1)
    cv2.rectangle(frame, (360, 230), (470, 340), (255, 0, 0), -1)

    detections = HSVMarkerDetector({"min_area_px": 300}).detect(frame)
    classes = {d.class_name for d in detections}

    assert "red_marker" in classes
    assert "blue_marker" in classes
    assert all(d.confidence > 0.5 for d in detections)


def test_hsv_detector_rejects_long_rectangles() -> None:
    frame = np.zeros((240, 320, 3), dtype=np.uint8)
    cv2.rectangle(frame, (30, 90), (230, 125), (0, 0, 255), -1)

    detections = HSVMarkerDetector({"min_area_px": 100}).detect(frame)

    assert detections == []

