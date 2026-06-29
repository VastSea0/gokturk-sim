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
        controls = self._camera_controls(fps)

        self.picam2 = Picamera2()
        video_config = self.picam2.create_video_configuration(
            main={"size": (width, height), "format": self.output_format},
            controls=controls,
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
        # Strip alpha if present (RGBA)
        if len(frame.shape) == 3 and frame.shape[2] == 4:
            frame = frame[:, :, :3]
        # picamera2 on Pi 5 / PiSP:
        # - BGR888 config → actual BGR data (pass through to OpenCV directly)
        # - RGB888 config → actual BGR data (same physical layout, pass through)
        # No channel conversion needed for either format.
        return frame

    def release(self) -> None:
        if self.picam2 is not None:
            self.picam2.stop()
            self.picam2.close()
            self.picam2 = None

    def _camera_controls(self, fps: int) -> Dict[str, Any]:
        controls: Dict[str, Any] = {"FrameRate": fps}
        control_cfg = self.config.get("controls", {}) or {}
        if "awb_enable" in control_cfg:
            controls["AwbEnable"] = bool(control_cfg["awb_enable"])
        if "ae_enable" in control_cfg:
            controls["AeEnable"] = bool(control_cfg["ae_enable"])
        if "exposure_time_us" in control_cfg and control_cfg["exposure_time_us"]:
            controls["ExposureTime"] = int(control_cfg["exposure_time_us"])
        if "analogue_gain" in control_cfg and control_cfg["analogue_gain"]:
            controls["AnalogueGain"] = float(control_cfg["analogue_gain"])
        return controls
