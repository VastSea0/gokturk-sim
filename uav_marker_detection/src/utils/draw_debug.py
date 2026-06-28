from __future__ import annotations

from typing import Iterable, Optional

import cv2
import numpy as np

from detection.common import MarkerDetection


COLORS = {
    "red_marker": (0, 0, 255),
    "blue_marker": (255, 80, 0),
}


def draw_detections(
    frame_bgr: np.ndarray,
    detections: Iterable[MarkerDetection],
    fps: Optional[float] = None,
) -> np.ndarray:
    output = frame_bgr.copy()
    for detection in detections:
        x1, y1, x2, y2 = detection.bbox_xyxy
        color = COLORS.get(detection.class_name, (0, 255, 255))
        label = f"{detection.class_name} {detection.confidence:.2f}"
        cv2.rectangle(output, (x1, y1), (x2, y2), color, 2)
        cv2.circle(output, (int(detection.center_px[0]), int(detection.center_px[1])), 4, color, -1)
        text_y = max(16, y1 - 8)
        cv2.putText(output, label, (x1, text_y), cv2.FONT_HERSHEY_SIMPLEX, 0.45, color, 1, cv2.LINE_AA)
    if fps is not None:
        cv2.putText(output, f"FPS {fps:.1f}", (10, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
    return output

