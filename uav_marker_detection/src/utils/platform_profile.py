from __future__ import annotations

import platform
from pathlib import Path


def is_macos() -> bool:
    return platform.system() == "Darwin"


def is_raspberry_pi() -> bool:
    for path in (Path("/proc/device-tree/model"), Path("/proc/cpuinfo")):
        try:
            text = path.read_text(errors="ignore").lower()
        except OSError:
            continue
        if "raspberry pi" in text:
            return True
    return False


def platform_profile_name() -> str:
    if is_raspberry_pi():
        return "raspberry_pi"
    if is_macos():
        return "macbook"
    return platform.system().lower() or "unknown"


def default_camera_source() -> str:
    if is_raspberry_pi():
        return "pi"
    return "webcam"
