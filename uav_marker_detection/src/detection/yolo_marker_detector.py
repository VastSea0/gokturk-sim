from __future__ import annotations

from typing import Any, Dict, List, Optional

import numpy as np

from .common import MarkerDetection, bbox_center, clamp


class YOLOMarkerDetector:
    """Optional Ultralytics YOLO detector for trained red/blue marker models."""

    def __init__(self, weights_path: str, config: Optional[Dict[str, Any]] = None) -> None:
        self.config = config or {}
        self.weights_path = weights_path
        self.confidence_threshold = float(self.config.get("confidence_threshold", 0.35))
        self.iou_threshold = float(self.config.get("iou_threshold", 0.45))
        self.image_size = int(self.config.get("image_size", 320))
        self.task = str(self.config.get("task", "detect"))
        self.class_names = {int(k): v for k, v in self.config.get("class_names", {0: "red_marker", 1: "blue_marker"}).items()}

        try:
            from ultralytics import YOLO
        except ImportError as exc:
            raise RuntimeError(
                "ultralytics is not installed. Install it only when YOLO is needed: "
                "pip install ultralytics"
            ) from exc

        self.model = YOLO(weights_path)

    def detect(self, frame_bgr: np.ndarray) -> List[MarkerDetection]:
        results = self.model(frame_bgr, imgsz=self.image_size, conf=self.confidence_threshold, iou=self.iou_threshold, verbose=False)
        if not results:
            return []

        detections: List[MarkerDetection] = []
        boxes = getattr(results[0], "boxes", None)
        if boxes is None:
            return detections

        masks = getattr(results[0], "masks", None)
        polygons = []
        if masks is not None and getattr(masks, "xy", None) is not None:
            polygons = masks.xy

        for index, box in enumerate(boxes):
            conf = float(box.conf[0])
            if conf < self.confidence_threshold:
                continue
            cls_id = int(box.cls[0])
            class_name = self._normalize_class_name(cls_id)
            if class_name not in {"red_marker", "blue_marker"}:
                continue
            xyxy = box.xyxy[0].detach().cpu().numpy().astype(float)
            x1, y1, x2, y2 = xyxy.tolist()
            area = max(0.0, (x2 - x1) * (y2 - y1))
            polygon = None
            if index < len(polygons):
                polygon = [(float(point[0]), float(point[1])) for point in polygons[index]]
            detections.append(
                MarkerDetection(
                    class_name=class_name,
                    confidence=clamp(conf),
                    bbox_xyxy=(int(x1), int(y1), int(x2), int(y2)),
                    center_px=bbox_center((x1, y1, x2, y2)),
                    area_px=area,
                    quality=clamp(conf),
                    mask_polygon=polygon,
                    detector_name="yolo_seg" if polygon else "yolo",
                )
            )

        detections.sort(key=lambda d: d.confidence, reverse=True)
        return detections

    def _normalize_class_name(self, cls_id: int) -> str:
        if cls_id in self.class_names:
            return self.class_names[cls_id]
        model_names = getattr(self.model, "names", {})
        raw_name = str(model_names.get(cls_id, cls_id)).lower()
        if raw_name in {"red", "red_square", "red-marker", "red_marker"}:
            return "red_marker"
        if raw_name in {"blue", "blue_square", "blue-marker", "blue_marker"}:
            return "blue_marker"
        return raw_name
