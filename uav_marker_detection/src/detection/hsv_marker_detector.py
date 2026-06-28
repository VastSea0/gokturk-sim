from __future__ import annotations

from typing import Any, Dict, List, Optional

import cv2
import numpy as np

from .common import MarkerDetection, clamp


class HSVMarkerDetector:
    """Detect red and blue square ground markers using HSV color masks."""

    def __init__(self, config: Optional[Dict[str, Any]] = None) -> None:
        self.config = config or {}
        self.min_area_px = float(self.config.get("min_area_px", 400))
        self.max_area_fraction = float(self.config.get("max_area_fraction", 0.65))
        self.aspect_ratio_min = float(self.config.get("aspect_ratio_min", 0.60))
        self.aspect_ratio_max = float(self.config.get("aspect_ratio_max", 1.50))
        self.approx_epsilon_factor = float(self.config.get("approx_epsilon_factor", 0.06))
        # Allow 3-6 vertices to handle perspective distortion (fisheye lens)
        self.require_quadrilateral = bool(self.config.get("require_quadrilateral", False))
        self.min_vertices = int(self.config.get("min_vertices", 3))
        self.max_vertices = int(self.config.get("max_vertices", 8))
        # Lowered from 0.55 — blue cards partially occluded or with printed pattern
        # have lower fill ratios; 0.25 still filters out thin lines/noise
        self.min_extent = float(self.config.get("min_extent", 0.25))
        self.max_markers_per_color = int(self.config.get("max_markers_per_color", 8))

        kernel_size = int(self.config.get("morph_kernel_size", 5))
        kernel_size = max(1, kernel_size)
        self.kernel = np.ones((kernel_size, kernel_size), np.uint8)
        self.morph_iterations = int(self.config.get("morph_iterations", 1))

        self.red_ranges = self.config.get(
            "red_ranges",
            [
                {"lower": [0, 90, 70], "upper": [10, 255, 255]},
                {"lower": [170, 90, 70], "upper": [179, 255, 255]},
            ],
        )
        self.blue_ranges = self.config.get(
            "blue_ranges",
            # Widened range: catches real blue cards under indoor lighting.
            # H: 90-140 covers blue to blue-purple; S: 50+ excludes pale grey walls;
            # V: 30+ ensures dark-blue cards in shadow are still detected.
            [{"lower": [90, 50, 30], "upper": [140, 255, 255]}],
        )

    def detect(self, frame_bgr: np.ndarray) -> List[MarkerDetection]:
        if frame_bgr is None or frame_bgr.size == 0:
            return []

        hsv = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2HSV)
        frame_area = float(frame_bgr.shape[0] * frame_bgr.shape[1])
        detections: List[MarkerDetection] = []

        color_specs = [
            ("red_marker", self.red_ranges),
            ("blue_marker", self.blue_ranges),
        ]
        for class_name, ranges in color_specs:
            mask = self._mask_for_ranges(hsv, ranges)
            mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, self.kernel, iterations=self.morph_iterations)
            mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, self.kernel, iterations=self.morph_iterations)
            detections.extend(self._detections_from_mask(mask, class_name, frame_area))

        detections.sort(key=lambda d: d.confidence, reverse=True)
        return detections

    def _mask_for_ranges(self, hsv: np.ndarray, ranges: List[Dict[str, Any]]) -> np.ndarray:
        combined = np.zeros(hsv.shape[:2], dtype=np.uint8)
        for range_spec in ranges:
            lower = np.array(range_spec["lower"], dtype=np.uint8)
            upper = np.array(range_spec["upper"], dtype=np.uint8)
            combined = cv2.bitwise_or(combined, cv2.inRange(hsv, lower, upper))
        return combined

    def _detections_from_mask(
        self,
        mask: np.ndarray,
        class_name: str,
        frame_area: float,
    ) -> List[MarkerDetection]:
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        candidates: List[MarkerDetection] = []
        max_area_px = frame_area * self.max_area_fraction

        for contour in contours:
            area = float(cv2.contourArea(contour))
            if area < self.min_area_px or area > max_area_px:
                continue

            perimeter = cv2.arcLength(contour, True)
            if perimeter <= 0:
                continue
            approx = cv2.approxPolyDP(contour, self.approx_epsilon_factor * perimeter, True)
            vertex_count = len(approx)
            if self.require_quadrilateral and vertex_count != 4:
                continue
            # Vertex count range filter (relaxed — fisheye distorts shapes)
            if not (self.min_vertices <= vertex_count <= self.max_vertices):
                continue

            x, y, w, h = cv2.boundingRect(contour)
            if h <= 0 or w <= 0:
                continue
            aspect_ratio = float(w) / float(h)
            if aspect_ratio < self.aspect_ratio_min or aspect_ratio > self.aspect_ratio_max:
                continue

            bbox_area = float(w * h)
            extent = area / bbox_area if bbox_area > 0 else 0.0
            if extent < self.min_extent:
                continue

            moments = cv2.moments(contour)
            if moments["m00"] > 0:
                center_x = moments["m10"] / moments["m00"]
                center_y = moments["m01"] / moments["m00"]
            else:
                center_x = x + w / 2.0
                center_y = y + h / 2.0

            aspect_mid = (self.aspect_ratio_min + self.aspect_ratio_max) / 2.0
            aspect_tol = max(0.01, (self.aspect_ratio_max - self.aspect_ratio_min) / 2.0)
            aspect_score = clamp(1.0 - abs(aspect_ratio - aspect_mid) / aspect_tol)
            extent_score = clamp((extent - self.min_extent) / max(0.01, 1.0 - self.min_extent))
            area_score = clamp(area / max(self.min_area_px * 8.0, 1.0))
            vertex_score = 1.0 if vertex_count == 4 else 0.65
            quality = clamp(0.35 * aspect_score + 0.30 * extent_score + 0.20 * area_score + 0.15 * vertex_score)
            confidence = clamp(0.20 + 0.80 * quality)

            candidates.append(
                MarkerDetection(
                    class_name=class_name,
                    confidence=confidence,
                    bbox_xyxy=(int(x), int(y), int(x + w), int(y + h)),
                    center_px=(float(center_x), float(center_y)),
                    area_px=area,
                    quality=quality,
                )
            )

        candidates.sort(key=lambda d: d.confidence, reverse=True)
        return candidates[: self.max_markers_per_color]
