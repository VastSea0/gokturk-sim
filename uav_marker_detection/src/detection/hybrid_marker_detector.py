from __future__ import annotations

from typing import Any, Dict, List, Optional

import cv2

from .adaptive_color_detector import AdaptiveColorMarkerDetector
from .common import MarkerDetection
from .yolo_marker_detector import YOLOMarkerDetector


class HybridMarkerDetector:
    """YOLO detector with color verification and adaptive color fallback.

    The synthetic YOLO model is useful, but a short synthetic-only run can miss
    real camera color/materials and occasionally hallucinate small boxes. This
    detector keeps YOLO predictions only when the predicted class has matching
    red/blue pixels inside the bbox, then adds high-confidence color detections
    that YOLO missed. It is still reporting-only and does not control the UAV.
    """

    def __init__(self, weights_path: str, config: Optional[Dict[str, Any]] = None) -> None:
        self.config = config or {}
        yolo_config = dict(self.config.get("yolo", {}))
        yolo_config.setdefault("confidence_threshold", self.config.get("confidence_threshold", 0.35))
        yolo_config.setdefault("iou_threshold", self.config.get("iou_threshold", 0.45))
        yolo_config.setdefault("image_size", self.config.get("image_size", 320))
        yolo_config.setdefault("class_names", self.config.get("class_names", {0: "red_marker", 1: "blue_marker"}))

        color_config = dict(self.config.get("color", {}))
        self.yolo = YOLOMarkerDetector(weights_path, yolo_config)
        self.color = AdaptiveColorMarkerDetector(color_config)

        self.require_yolo_color_match = bool(self.config.get("require_yolo_color_match", True))
        self.yolo_min_color_fill = float(self.config.get("yolo_min_color_fill", 0.08))
        self.color_min_confidence = float(self.config.get("color_min_confidence", 0.72))
        self.color_min_area_fraction = float(self.config.get("color_min_area_fraction", 0.002))
        self.merge_iou_threshold = float(self.config.get("merge_iou_threshold", 0.25))

    def detect(self, frame_bgr: np.ndarray) -> List[MarkerDetection]:
        color_detections = self.color.detect(frame_bgr)
        yolo_detections = self.yolo.detect(frame_bgr)
        frame_area = float(frame_bgr.shape[0] * frame_bgr.shape[1])

        merged: List[MarkerDetection] = []
        for detection in yolo_detections:
            if self._yolo_detection_is_valid(detection):
                detection.detector_name = "hybrid_yolo"
                merged.append(detection)

        min_color_area = frame_area * self.color_min_area_fraction
        for detection in color_detections:
            if detection.confidence < self.color_min_confidence:
                continue
            if detection.area_px < min_color_area:
                continue
            if self._has_overlap(detection, merged):
                continue
            detection.detector_name = "hybrid_color"
            merged.append(detection)

        merged.sort(key=lambda item: (item.confidence, item.area_px), reverse=True)
        return merged

    def debug_view(self, frame_bgr: np.ndarray, mode: str) -> np.ndarray:
        return self.color.debug_view(frame_bgr, mode)

    def _yolo_detection_is_valid(self, detection: MarkerDetection) -> bool:
        if not self.require_yolo_color_match:
            return True

        mask = self.color.last_masks.get(detection.class_name)
        if mask is None:
            return False

        x1, y1, x2, y2 = detection.bbox_xyxy
        height, width = mask.shape[:2]
        x1 = max(0, min(width - 1, int(x1)))
        x2 = max(0, min(width, int(x2)))
        y1 = max(0, min(height - 1, int(y1)))
        y2 = max(0, min(height, int(y2)))
        if x2 <= x1 or y2 <= y1:
            return False

        roi = mask[y1:y2, x1:x2]
        color_fill = float(cv2.countNonZero(roi)) / float(max(1, roi.size))
        return color_fill >= self.yolo_min_color_fill

    def _has_overlap(self, detection: MarkerDetection, existing: List[MarkerDetection]) -> bool:
        return any(
            detection.class_name == other.class_name
            and self._iou(detection.bbox_xyxy, other.bbox_xyxy) >= self.merge_iou_threshold
            for other in existing
        )

    @staticmethod
    def _iou(a, b) -> float:
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
