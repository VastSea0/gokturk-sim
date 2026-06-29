from __future__ import annotations

from typing import Any, Dict, List, Optional

import cv2
import numpy as np

from .common import MarkerDetection, clamp


class AdaptiveColorMarkerDetector:
    """Shape-tolerant red/blue marker detector using HSV + normalized RGB + Lab cues.

    This is a real-time bootstrap detector for Raspberry Pi 5 and a stronger
    fallback/debug path than plain HSV. It does not require markers to be square.
    The production path for high clutter is still a trained YOLO/YOLO-seg model.
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None) -> None:
        self.config = config or {}
        self.min_area_px = float(self.config.get("min_area_px", 220))
        self.max_area_fraction = float(self.config.get("max_area_fraction", 0.70))
        self.min_color_fill = float(self.config.get("min_color_fill", 0.18))
        self.max_aspect_ratio = float(self.config.get("max_aspect_ratio", 7.0))
        self.blur_kernel_size = int(self.config.get("blur_kernel_size", 3))
        self.morph_kernel_size = int(self.config.get("morph_kernel_size", 5))
        self.morph_iterations = int(self.config.get("morph_iterations", 2))
        self.max_markers_per_color = int(self.config.get("max_markers_per_color", 12))
        self.use_clahe = bool(self.config.get("use_clahe", True))

        self.red_hsv_ranges = self.config.get(
            "red_hsv_ranges",
            [
                {"lower": [0, 45, 35], "upper": [18, 255, 255]},
                {"lower": [160, 45, 35], "upper": [179, 255, 255]},
            ],
        )
        self.blue_hsv_ranges = self.config.get(
            "blue_hsv_ranges",
            [{"lower": [82, 35, 25], "upper": [148, 255, 255]}],
        )

        self.red_dominance_min = float(self.config.get("red_dominance_min", 0.055))
        self.blue_dominance_min = float(self.config.get("blue_dominance_min", 0.045))
        self.min_channel_value = float(self.config.get("min_channel_value", 28))
        self.red_lab_a_min = float(self.config.get("red_lab_a_min", 142))
        self.blue_lab_b_max = float(self.config.get("blue_lab_b_max", 122))

        kernel_size = max(1, self.morph_kernel_size)
        self.kernel = np.ones((kernel_size, kernel_size), np.uint8)
        self.last_masks: Dict[str, np.ndarray] = {}

    def detect(self, frame_bgr: np.ndarray) -> List[MarkerDetection]:
        if frame_bgr is None or frame_bgr.size == 0:
            self.last_masks = {}
            return []

        work = self._preprocess(frame_bgr)
        hsv = cv2.cvtColor(work, cv2.COLOR_BGR2HSV)
        lab = cv2.cvtColor(work, cv2.COLOR_BGR2LAB)
        bgr_float = work.astype(np.float32)
        b = bgr_float[:, :, 0]
        g = bgr_float[:, :, 1]
        r = bgr_float[:, :, 2]
        total = np.maximum(r + g + b, 1.0)
        rn = r / total
        gn = g / total
        bn = b / total

        red_hsv = self._mask_for_ranges(hsv, self.red_hsv_ranges)
        blue_hsv = self._mask_for_ranges(hsv, self.blue_hsv_ranges)

        red_dominance = ((rn - np.maximum(gn, bn)) > self.red_dominance_min) & (r > self.min_channel_value)
        blue_dominance = ((bn - np.maximum(rn, gn)) > self.blue_dominance_min) & (b > self.min_channel_value)
        red_lab = lab[:, :, 1] > self.red_lab_a_min
        blue_lab = lab[:, :, 2] < self.blue_lab_b_max

        # Red is intentionally stricter than blue: skin, wood, and warm indoor
        # surfaces can satisfy one cue, but real red tape/marker material should
        # satisfy hue, channel dominance, and Lab redness together.
        red_mask = cv2.bitwise_and(red_hsv, ((red_dominance & red_lab).astype(np.uint8) * 255))
        blue_mask = cv2.bitwise_and(blue_hsv, ((blue_dominance | blue_lab).astype(np.uint8) * 255))

        red_mask = self._clean_mask(red_mask)
        blue_mask = self._clean_mask(blue_mask)
        self.last_masks = {
            "red_marker": red_mask,
            "blue_marker": blue_mask,
            "combined": cv2.bitwise_or(red_mask, blue_mask),
        }

        frame_area = float(frame_bgr.shape[0] * frame_bgr.shape[1])
        detections: List[MarkerDetection] = []
        detections.extend(self._detections_from_mask(red_mask, frame_bgr, "red_marker", frame_area))
        detections.extend(self._detections_from_mask(blue_mask, frame_bgr, "blue_marker", frame_area))
        detections.sort(key=lambda item: item.confidence, reverse=True)
        return detections

    def debug_view(self, frame_bgr: np.ndarray, mode: str) -> np.ndarray:
        if mode == "mask_red":
            return self._mask_to_bgr(self.last_masks.get("red_marker"), (0, 0, 255), frame_bgr)
        if mode == "mask_blue":
            return self._mask_to_bgr(self.last_masks.get("blue_marker"), (255, 80, 0), frame_bgr)
        if mode == "mask_combined":
            combined = self.last_masks.get("combined")
            return self._mask_to_bgr(combined, (0, 255, 255), frame_bgr)
        if mode == "mask_overlay":
            overlay = frame_bgr.copy()
            red = self.last_masks.get("red_marker")
            blue = self.last_masks.get("blue_marker")
            if red is not None:
                overlay[red > 0] = (0, 0, 255)
            if blue is not None:
                overlay[blue > 0] = (255, 80, 0)
            return cv2.addWeighted(overlay, 0.45, frame_bgr, 0.55, 0)
        return frame_bgr

    def _preprocess(self, frame_bgr: np.ndarray) -> np.ndarray:
        work = frame_bgr
        if self.blur_kernel_size > 1:
            kernel = self.blur_kernel_size if self.blur_kernel_size % 2 == 1 else self.blur_kernel_size + 1
            work = cv2.GaussianBlur(work, (kernel, kernel), 0)
        if not self.use_clahe:
            return work
        lab = cv2.cvtColor(work, cv2.COLOR_BGR2LAB)
        l_channel, a_channel, b_channel = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        l_channel = clahe.apply(l_channel)
        return cv2.cvtColor(cv2.merge((l_channel, a_channel, b_channel)), cv2.COLOR_LAB2BGR)

    def _mask_for_ranges(self, hsv: np.ndarray, ranges: List[Dict[str, Any]]) -> np.ndarray:
        combined = np.zeros(hsv.shape[:2], dtype=np.uint8)
        for range_spec in ranges:
            lower = np.array(range_spec["lower"], dtype=np.uint8)
            upper = np.array(range_spec["upper"], dtype=np.uint8)
            combined = cv2.bitwise_or(combined, cv2.inRange(hsv, lower, upper))
        return combined

    def _clean_mask(self, mask: np.ndarray) -> np.ndarray:
        cleaned = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, self.kernel, iterations=self.morph_iterations)
        cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_OPEN, self.kernel, iterations=1)
        return cleaned

    def _detections_from_mask(
        self,
        mask: np.ndarray,
        frame_bgr: np.ndarray,
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
            x, y, w, h = cv2.boundingRect(contour)
            if w <= 0 or h <= 0:
                continue
            aspect = max(float(w) / float(h), float(h) / float(w))
            if aspect > self.max_aspect_ratio:
                continue

            roi_mask = mask[y : y + h, x : x + w]
            color_fill = float(cv2.countNonZero(roi_mask)) / float(max(1, w * h))
            if color_fill < self.min_color_fill:
                continue

            moments = cv2.moments(contour)
            if moments["m00"] > 0:
                center_x = moments["m10"] / moments["m00"]
                center_y = moments["m01"] / moments["m00"]
            else:
                center_x = x + w / 2.0
                center_y = y + h / 2.0

            color_score = clamp((color_fill - self.min_color_fill) / max(0.01, 0.75 - self.min_color_fill))
            area_score = clamp(area / max(self.min_area_px * 10.0, 1.0))
            aspect_score = clamp(1.0 - (aspect - 1.0) / max(1.0, self.max_aspect_ratio - 1.0))
            quality = clamp(0.50 * color_score + 0.30 * area_score + 0.20 * aspect_score)
            confidence = clamp(0.15 + 0.85 * quality)

            polygon = self._contour_polygon(contour, offset=(0, 0))
            candidates.append(
                MarkerDetection(
                    class_name=class_name,
                    confidence=confidence,
                    bbox_xyxy=(int(x), int(y), int(x + w), int(y + h)),
                    center_px=(float(center_x), float(center_y)),
                    area_px=area,
                    quality=quality,
                    mask_polygon=polygon,
                    detector_name="adaptive_color",
                )
            )

        candidates.sort(key=lambda item: item.confidence, reverse=True)
        return candidates[: self.max_markers_per_color]

    def _contour_polygon(self, contour: np.ndarray, offset=(0, 0)) -> List:
        epsilon = 0.015 * cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, epsilon, True)
        points = approx.reshape(-1, 2)
        if len(points) > 24:
            step = max(1, len(points) // 24)
            points = points[::step]
        ox, oy = offset
        return [(float(point[0] + ox), float(point[1] + oy)) for point in points]

    def _mask_to_bgr(self, mask: Optional[np.ndarray], color, frame_bgr: np.ndarray) -> np.ndarray:
        if mask is None:
            return np.zeros_like(frame_bgr)
        output = np.zeros_like(frame_bgr)
        output[mask > 0] = color
        return output
