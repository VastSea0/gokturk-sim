from __future__ import annotations

from pathlib import Path
from typing import Optional

import cv2


class VideoFileCamera:
    """OpenCV VideoCapture wrapper for hardware-free testing."""

    def __init__(self, video_path: str, loop: bool = False) -> None:
        self.video_path = Path(video_path)
        self.loop = loop
        self.cap: Optional[cv2.VideoCapture] = None

    def start(self) -> None:
        if not self.video_path.exists():
            raise FileNotFoundError(f"Video file does not exist: {self.video_path}")
        self.cap = cv2.VideoCapture(str(self.video_path))
        if not self.cap.isOpened():
            raise RuntimeError(f"Could not open video file: {self.video_path}")

    def read(self):
        if self.cap is None:
            self.start()
        ok, frame = self.cap.read()
        if ok:
            return frame
        if self.loop:
            self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ok, frame = self.cap.read()
            return frame if ok else None
        return None

    def release(self) -> None:
        if self.cap is not None:
            self.cap.release()
            self.cap = None

