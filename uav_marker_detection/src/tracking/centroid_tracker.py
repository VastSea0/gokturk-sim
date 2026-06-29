from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from detection.common import MarkerDetection, clamp


@dataclass
class _Track:
    track_id: int
    class_name: str
    bbox_xyxy: Tuple[float, float, float, float]
    center_px: Tuple[float, float]
    confidence: float
    quality: float
    area_px: float
    mask_polygon: Optional[List[Tuple[float, float]]]
    shape_name: Optional[str] = None
    shape_score: Optional[float] = None
    shape_metrics: Optional[Dict[str, float]] = None
    missed: int = 0
    last_frame_id: int = 0


class CentroidTracker:
    """Small dependency-free tracker with bbox/center smoothing and lost-frame hold."""

    def __init__(
        self,
        max_distance_px: float = 90.0,
        max_missed: int = 6,
        smoothing_alpha: float = 0.45,
        stale_confidence_decay: float = 0.65,
    ) -> None:
        self.max_distance_px = float(max_distance_px)
        self.max_missed = int(max_missed)
        self.smoothing_alpha = clamp(float(smoothing_alpha), 0.01, 1.0)
        self.stale_confidence_decay = clamp(float(stale_confidence_decay), 0.05, 1.0)
        self._tracks: Dict[int, _Track] = {}
        self._next_id = 1

    def update(self, detections: List[MarkerDetection], frame_id: int) -> List[MarkerDetection]:
        unmatched_track_ids = set(self._tracks.keys())
        unmatched_detection_indices = set(range(len(detections)))
        candidate_pairs = []

        for track_id, track in self._tracks.items():
            for index, detection in enumerate(detections):
                if track.class_name != detection.class_name:
                    continue
                distance = self._distance(track.center_px, detection.center_px)
                dynamic_gate = max(self.max_distance_px, self._track_gate(track))
                if distance <= dynamic_gate:
                    candidate_pairs.append((distance, track_id, index))

        candidate_pairs.sort(key=lambda item: item[0])
        for _distance, track_id, index in candidate_pairs:
            if track_id not in unmatched_track_ids or index not in unmatched_detection_indices:
                continue
            self._update_track(self._tracks[track_id], detections[index], frame_id)
            unmatched_track_ids.remove(track_id)
            unmatched_detection_indices.remove(index)

        for index in sorted(unmatched_detection_indices):
            self._create_track(detections[index], frame_id)

        for track_id in list(unmatched_track_ids):
            track = self._tracks[track_id]
            track.missed += 1
            if track.missed > self.max_missed:
                del self._tracks[track_id]

        return self._active_detections()

    def reset(self) -> None:
        self._tracks.clear()

    def _create_track(self, detection: MarkerDetection, frame_id: int) -> None:
        track = _Track(
            track_id=self._next_id,
            class_name=detection.class_name,
            bbox_xyxy=tuple(float(v) for v in detection.bbox_xyxy),
            center_px=(float(detection.center_px[0]), float(detection.center_px[1])),
            confidence=float(detection.confidence),
            quality=float(detection.quality),
            area_px=float(detection.area_px),
            mask_polygon=detection.mask_polygon,
            shape_name=detection.shape_name,
            shape_score=detection.shape_score,
            shape_metrics=detection.shape_metrics,
            missed=0,
            last_frame_id=frame_id,
        )
        self._tracks[self._next_id] = track
        self._next_id += 1

    def _update_track(self, track: _Track, detection: MarkerDetection, frame_id: int) -> None:
        alpha = self.smoothing_alpha
        track.bbox_xyxy = tuple(
            alpha * float(new_value) + (1.0 - alpha) * float(old_value)
            for old_value, new_value in zip(track.bbox_xyxy, detection.bbox_xyxy)
        )
        track.center_px = (
            alpha * float(detection.center_px[0]) + (1.0 - alpha) * track.center_px[0],
            alpha * float(detection.center_px[1]) + (1.0 - alpha) * track.center_px[1],
        )
        track.confidence = max(float(detection.confidence), 0.70 * track.confidence + 0.30 * float(detection.confidence))
        track.quality = max(float(detection.quality), 0.70 * track.quality + 0.30 * float(detection.quality))
        track.area_px = alpha * float(detection.area_px) + (1.0 - alpha) * track.area_px
        track.mask_polygon = detection.mask_polygon
        track.shape_name = detection.shape_name
        track.shape_score = detection.shape_score
        track.shape_metrics = detection.shape_metrics
        track.missed = 0
        track.last_frame_id = frame_id

    def _active_detections(self) -> List[MarkerDetection]:
        detections = []
        for track in self._tracks.values():
            stale_factor = self.stale_confidence_decay ** track.missed
            bbox = tuple(int(round(value)) for value in track.bbox_xyxy)
            detections.append(
                MarkerDetection(
                    class_name=track.class_name,
                    confidence=clamp(track.confidence * stale_factor),
                    bbox_xyxy=bbox,
                    center_px=(float(track.center_px[0]), float(track.center_px[1])),
                    area_px=float(track.area_px),
                    quality=clamp(track.quality * stale_factor),
                    track_id=track.track_id,
                    stale_frames=track.missed,
                    mask_polygon=track.mask_polygon,
                    detector_name="tracked",
                    shape_name=track.shape_name,
                    shape_score=track.shape_score,
                    shape_metrics=track.shape_metrics,
                )
            )
        detections.sort(key=lambda item: (item.stale_frames, -item.confidence))
        return detections

    def _distance(self, first, second) -> float:
        return math.hypot(float(first[0]) - float(second[0]), float(first[1]) - float(second[1]))

    def _track_gate(self, track: _Track) -> float:
        x1, y1, x2, y2 = track.bbox_xyxy
        return 1.75 * max(abs(x2 - x1), abs(y2 - y1))
