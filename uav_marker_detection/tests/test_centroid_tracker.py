from __future__ import annotations

import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from detection.common import MarkerDetection
from tracking.centroid_tracker import CentroidTracker


def _det(x1, y1, x2, y2):
    return MarkerDetection(
        class_name="blue_marker",
        confidence=0.9,
        bbox_xyxy=(x1, y1, x2, y2),
        center_px=((x1 + x2) / 2.0, (y1 + y2) / 2.0),
        area_px=float((x2 - x1) * (y2 - y1)),
        quality=0.9,
    )


def test_tracker_smooths_and_keeps_short_lost_detections() -> None:
    tracker = CentroidTracker(max_distance_px=80, max_missed=2, smoothing_alpha=0.5)
    first = tracker.update([_det(100, 100, 150, 150)], frame_id=1)
    second = tracker.update([_det(120, 100, 170, 150)], frame_id=2)
    lost = tracker.update([], frame_id=3)

    assert first[0].track_id == second[0].track_id
    assert second[0].center_px[0] < 145.0
    assert lost[0].stale_frames == 1
    assert lost[0].track_id == first[0].track_id

