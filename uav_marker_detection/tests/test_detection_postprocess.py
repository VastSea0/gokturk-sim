from __future__ import annotations

import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from detection.common import MarkerDetection
from detection.postprocess import DetectionPostProcessor


def _detection(class_name: str, confidence: float, bbox, polygon=None) -> MarkerDetection:
    x1, y1, x2, y2 = bbox
    return MarkerDetection(
        class_name=class_name,
        confidence=confidence,
        bbox_xyxy=bbox,
        center_px=((x1 + x2) / 2.0, (y1 + y2) / 2.0),
        area_px=float((x2 - x1) * (y2 - y1)),
        quality=confidence,
        mask_polygon=polygon,
    )


def test_square_filter_keeps_square_and_rejects_long_rectangle() -> None:
    post = DetectionPostProcessor(
        {
            "square_filter": {"enabled": True, "max_aspect_ratio": 1.35, "min_shape_score": 0.55},
            "nms": {"enabled": False},
        }
    )
    square = _detection("blue_marker", 0.9, (10, 10, 110, 110), [(10, 10), (110, 10), (110, 110), (10, 110)])
    rectangle = _detection("blue_marker", 0.9, (10, 10, 210, 90), [(10, 10), (210, 10), (210, 90), (10, 90)])

    result = post.apply([square, rectangle])

    assert result == [square]
    assert square.shape_name == "square_2m_marker"
    assert square.shape_score is not None


def test_nms_suppresses_lower_confidence_overlap_per_class() -> None:
    post = DetectionPostProcessor(
        {
            "square_filter": {"enabled": False},
            "nms": {"enabled": True, "iou_threshold": 0.4, "class_aware": True},
        }
    )
    high = _detection("red_marker", 0.9, (10, 10, 110, 110))
    low = _detection("red_marker", 0.6, (20, 20, 120, 120))
    other_class = _detection("blue_marker", 0.5, (20, 20, 120, 120))

    result = post.apply([low, other_class, high])

    assert high in result
    assert low not in result
    assert other_class in result
