from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


BBox = Tuple[int, int, int, int]
Point = Tuple[float, float]


@dataclass
class MarkerDetection:
    """Detector-neutral marker result in processed-frame pixel coordinates."""

    class_name: str
    confidence: float
    bbox_xyxy: BBox
    center_px: Point
    area_px: float
    quality: float
    track_id: Optional[int] = None
    stale_frames: int = 0
    mask_polygon: Optional[List[Point]] = None
    detector_name: Optional[str] = None

    def as_dict(
        self,
        relative_position_m: Optional[Dict[str, Optional[float]]] = None,
        global_position: Optional[Dict[str, Optional[float]]] = None,
        local_position_ned_m: Optional[Dict[str, Optional[float]]] = None,
    ) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "class": self.class_name,
            "confidence": round(float(self.confidence), 4),
            "bbox_xyxy": [int(v) for v in self.bbox_xyxy],
            "center_px": [round(float(self.center_px[0]), 2), round(float(self.center_px[1]), 2)],
            "quality": round(float(self.quality), 4),
            "area_px": round(float(self.area_px), 2),
            "stale_frames": int(self.stale_frames),
            "relative_position_m": relative_position_m
            or {"x_forward": None, "y_right": None, "z_down": None},
            "global_position": global_position or {"lat": None, "lon": None, "alt": None},
        }
        if self.track_id is not None:
            result["track_id"] = int(self.track_id)
        if self.detector_name:
            result["detector"] = self.detector_name
        if self.mask_polygon:
            result["mask_polygon"] = [
                [round(float(point[0]), 2), round(float(point[1]), 2)] for point in self.mask_polygon
            ]
        if local_position_ned_m is not None:
            result["local_position_ned_m"] = local_position_ned_m
        return result


def clamp(value: float, minimum: float = 0.0, maximum: float = 1.0) -> float:
    return max(minimum, min(maximum, value))


def detections_to_dicts(detections: Iterable[MarkerDetection]) -> List[Dict[str, Any]]:
    return [d.as_dict() for d in detections]


def xywh_to_xyxy(x: float, y: float, w: float, h: float) -> BBox:
    return int(x), int(y), int(x + w), int(y + h)


def bbox_center(bbox: Sequence[float]) -> Point:
    x1, y1, x2, y2 = bbox
    return (float(x1 + x2) / 2.0, float(y1 + y2) / 2.0)
