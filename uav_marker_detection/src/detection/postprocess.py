from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Sequence

import cv2
import numpy as np

from .common import MarkerDetection, clamp


class DetectionPostProcessor:
    """Optional detection post-processing shared by CLI and GUI.

    Shape filtering focuses the pipeline on roughly square 2x2 m color markers.
    NMS removes duplicate overlapping boxes after detector fusion.
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None) -> None:
        self.config = config or {}
        square_cfg = self.config.get("square_filter", {}) or {}
        nms_cfg = self.config.get("nms", {}) or {}

        self.square_enabled = bool(square_cfg.get("enabled", False))
        self.target_shape_name = str(square_cfg.get("target_shape_name", "square_2m_marker"))
        self.max_square_aspect_ratio = float(square_cfg.get("max_aspect_ratio", 1.45))
        self.min_rectangularity = float(square_cfg.get("min_rectangularity", 0.50))
        self.min_extent = float(square_cfg.get("min_extent", 0.35))
        self.min_shape_score = float(square_cfg.get("min_shape_score", 0.55))

        self.nms_enabled = bool(nms_cfg.get("enabled", False))
        self.nms_iou_threshold = float(nms_cfg.get("iou_threshold", 0.45))
        self.nms_class_aware = bool(nms_cfg.get("class_aware", True))

    def apply(self, detections: Iterable[MarkerDetection]) -> List[MarkerDetection]:
        processed = list(detections)
        if self.square_enabled:
            processed = self._filter_square_markers(processed)
        if self.nms_enabled:
            processed = self._nms(processed)
        return processed

    def _filter_square_markers(self, detections: Sequence[MarkerDetection]) -> List[MarkerDetection]:
        kept: List[MarkerDetection] = []
        for detection in detections:
            metrics = self._shape_metrics(detection)
            aspect_ok = metrics["aspect_ratio"] <= self.max_square_aspect_ratio
            rectangularity_ok = metrics["rectangularity"] >= self.min_rectangularity
            extent_ok = metrics["extent"] >= self.min_extent
            score_ok = metrics["shape_score"] >= self.min_shape_score
            if not (aspect_ok and rectangularity_ok and extent_ok and score_ok):
                continue
            detection.shape_name = self.target_shape_name
            detection.shape_score = metrics["shape_score"]
            detection.shape_metrics = metrics
            kept.append(detection)
        return kept

    def _shape_metrics(self, detection: MarkerDetection) -> Dict[str, float]:
        x1, y1, x2, y2 = detection.bbox_xyxy
        width = max(1.0, float(x2 - x1))
        height = max(1.0, float(y2 - y1))
        bbox_area = max(1.0, width * height)
        extent = clamp(float(detection.area_px) / bbox_area)

        aspect_ratio = max(width / height, height / width)
        rectangularity = extent
        vertex_count = 0.0

        if detection.mask_polygon and len(detection.mask_polygon) >= 3:
            points = np.array(detection.mask_polygon, dtype=np.float32).reshape((-1, 1, 2))
            contour_area = abs(float(cv2.contourArea(points)))
            rect = cv2.minAreaRect(points)
            rect_w, rect_h = rect[1]
            if rect_w > 1.0 and rect_h > 1.0:
                aspect_ratio = max(float(rect_w) / float(rect_h), float(rect_h) / float(rect_w))
                rectangularity = clamp(contour_area / max(1.0, float(rect_w) * float(rect_h)))
            epsilon = 0.04 * cv2.arcLength(points, True)
            approx = cv2.approxPolyDP(points, epsilon, True)
            vertex_count = float(len(approx))

        aspect_score = clamp(1.0 - (aspect_ratio - 1.0) / max(0.01, self.max_square_aspect_ratio - 1.0))
        rectangularity_score = clamp((rectangularity - self.min_rectangularity) / max(0.01, 1.0 - self.min_rectangularity))
        extent_score = clamp((extent - self.min_extent) / max(0.01, 1.0 - self.min_extent))
        if vertex_count > 0:
            vertex_score = clamp(1.0 - abs(vertex_count - 4.0) / 8.0)
        else:
            vertex_score = 0.50

        shape_score = clamp(
            0.45 * aspect_score
            + 0.25 * rectangularity_score
            + 0.15 * extent_score
            + 0.15 * vertex_score
        )
        return {
            "aspect_ratio": aspect_ratio,
            "rectangularity": rectangularity,
            "extent": extent,
            "vertices": vertex_count,
            "shape_score": shape_score,
        }

    def _nms(self, detections: Sequence[MarkerDetection]) -> List[MarkerDetection]:
        kept: List[MarkerDetection] = []
        for detection in sorted(detections, key=lambda item: item.confidence, reverse=True):
            should_keep = True
            for other in kept:
                if self.nms_class_aware and detection.class_name != other.class_name:
                    continue
                if self._iou(detection.bbox_xyxy, other.bbox_xyxy) >= self.nms_iou_threshold:
                    should_keep = False
                    break
            if should_keep:
                kept.append(detection)
        return kept

    @staticmethod
    def _iou(a: Sequence[int], b: Sequence[int]) -> float:
        ax1, ay1, ax2, ay2 = a
        bx1, by1, bx2, by2 = b
        ix1 = max(ax1, bx1)
        iy1 = max(ay1, by1)
        ix2 = min(ax2, bx2)
        iy2 = min(ay2, by2)
        iw = max(0, ix2 - ix1)
        ih = max(0, iy2 - iy1)
        intersection = float(iw * ih)
        if intersection <= 0:
            return 0.0
        area_a = float(max(0, ax2 - ax1) * max(0, ay2 - ay1))
        area_b = float(max(0, bx2 - bx1) * max(0, by2 - by1))
        return intersection / max(1.0, area_a + area_b - intersection)
