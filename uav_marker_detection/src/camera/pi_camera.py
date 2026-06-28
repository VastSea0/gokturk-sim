from __future__ import annotations

import time
from typing import Any, Dict, Optional

import cv2


class PiCameraSource:
    """Raspberry Pi Camera source using picamera2, imported lazily for non-Pi hosts."""

    def __init__(self, config: Optional[Dict[str, Any]] = None) -> None:
        self.config = config or {}
        self.picam2: Optional[Any] = None
        self.output_format = str(self.config.get("format", "RGB888")).upper()

    def start(self) -> None:
        try:
            from picamera2 import Picamera2
        except ImportError as exc:
            raise RuntimeError(
                "picamera2 is not installed. On Raspberry Pi OS install it with: "
                "sudo apt install python3-picamera2"
            ) from exc

        width = int(self.config.get("width", 640))
        height = int(self.config.get("height", 480))
        fps = int(self.config.get("fps", 20))

        self.picam2 = Picamera2()
        video_config = self.picam2.create_video_configuration(
            main={"size": (width, height), "format": self.output_format},
            controls={"FrameRate": fps},
        )
        self.picam2.configure(video_config)
        self.picam2.start()

        warmup_frames = int(self.config.get("warmup_frames", 5))
        for _ in range(max(0, warmup_frames)):
            self.read()
            time.sleep(0.02)

    def read(self):
        if self.picam2 is None:
            self.start()
        frame = self.picam2.capture_array()
        if frame is None:
            return None
        if len(frame.shape) == 3 and frame.shape[2] == 4:
            frame = frame[:, :, :3]
            
        # Due to picamera2/libcamera packaging/driver quirks:
        # - "RGB888" config actually returns BGR-ordered array data.
        # - "BGR888" config actually returns RGB-ordered array data.
        if self.output_format.startswith("BGR"):
            return cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
        
        # For "RGB888" it is already BGR, return directly.
        return frame

    def release(self) -> None:
        if self.picam2 is not None:
            self.picam2.stop()
            self.picam2.close()
            self.picam2 = None
