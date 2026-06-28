from __future__ import annotations

from typing import Optional

import cv2
import numpy as np

from .qt_compat import QtCore, QtGui, QtWidgets, qt_alignment_center, qt_keep_aspect_ratio, qt_smooth_transform


class VideoWidget(QtWidgets.QLabel):
    """Aspect-ratio preserving OpenCV frame preview widget."""

    def __init__(self, parent: Optional[QtWidgets.QWidget] = None) -> None:
        super().__init__(parent)
        self.setMinimumSize(640, 360)
        self.setAlignment(qt_alignment_center())
        self.setStyleSheet("background: #0b0f14; color: #9ca3af; border: 1px solid #243042;")
        self.setText("Camera preview is stopped")
        self._pixmap: Optional[QtGui.QPixmap] = None

    def set_frame(self, frame_bgr: np.ndarray) -> None:
        if frame_bgr is None or frame_bgr.size == 0:
            return
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        height, width, channels = rgb.shape
        bytes_per_line = channels * width
        image = QtGui.QImage(
            rgb.data,
            width,
            height,
            bytes_per_line,
            QtGui.QImage.Format.Format_RGB888,
        ).copy()
        self._pixmap = QtGui.QPixmap.fromImage(image)
        self._update_scaled_pixmap()

    def clear_frame(self) -> None:
        self._pixmap = None
        self.setText("Camera preview is stopped")

    def resizeEvent(self, event: QtGui.QResizeEvent) -> None:
        super().resizeEvent(event)
        self._update_scaled_pixmap()

    def _update_scaled_pixmap(self) -> None:
        if self._pixmap is None:
            return
        scaled = self._pixmap.scaled(self.size(), qt_keep_aspect_ratio(), qt_smooth_transform())
        self.setPixmap(scaled)

