from __future__ import annotations

from typing import Optional

import cv2


class WebcamCamera:
    """OpenCV webcam source for Mac/Linux development without Raspberry Pi hardware."""

    def __init__(self, camera_index: int = 0, width: int = 640, height: int = 480, fps: int = 20) -> None:
        self.camera_index = int(camera_index)
        self.width = int(width)
        self.height = int(height)
        self.fps = int(fps)
        self.cap: Optional[cv2.VideoCapture] = None

    def start(self) -> None:
        self.cap = cv2.VideoCapture(self.camera_index)
        if not self.cap.isOpened():
            raise RuntimeError(
                f"Could not open webcam index {self.camera_index}. "
                "On macOS, allow Terminal/Codex camera access in System Settings > Privacy & Security > Camera."
            )
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        self.cap.set(cv2.CAP_PROP_FPS, self.fps)

    def read(self):
        if self.cap is None:
            self.start()
        ok, frame = self.cap.read()
        return frame if ok else None

    def release(self) -> None:
        if self.cap is not None:
            self.cap.release()
            self.cap = None
