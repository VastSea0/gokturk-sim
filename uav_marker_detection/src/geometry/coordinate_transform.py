from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, Optional, Sequence, Tuple


EARTH_RADIUS_M = 6378137.0


@dataclass
class CameraGeometry:
    hfov_deg: float = 66.0
    vfov_deg: float = 41.0
    mount_roll_deg: float = 0.0
    mount_pitch_deg: float = 0.0
    mount_yaw_deg: float = 0.0

    @classmethod
    def from_config(cls, config: Optional[Dict[str, Any]]) -> "CameraGeometry":
        cfg = config or {}
        return cls(
            hfov_deg=float(cfg.get("hfov_deg", 66.0)),
            vfov_deg=float(cfg.get("vfov_deg", 41.0)),
            mount_roll_deg=float(cfg.get("mount_roll_deg", 0.0)),
            mount_pitch_deg=float(cfg.get("mount_pitch_deg", 0.0)),
            mount_yaw_deg=float(cfg.get("mount_yaw_deg", 0.0)),
        )


def pixel_to_ground_offset_nadir(
    center_px: Sequence[float],
    frame_shape: Sequence[int],
    altitude_m: float,
    camera: CameraGeometry,
) -> Dict[str, float]:
    """Convert pixel offset to body-frame ground offset under a nadir-camera assumption.

    Assumptions:
    - Camera optical axis points straight down.
    - Ground is locally flat.
    - altitude_m is height above the ground plane.
    - Image top is vehicle-forward and image right is vehicle-right.
    """

    height = int(frame_shape[0])
    width = int(frame_shape[1])
    cx, cy = float(center_px[0]), float(center_px[1])

    ground_width_m = 2.0 * altitude_m * math.tan(math.radians(camera.hfov_deg) / 2.0)
    ground_height_m = 2.0 * altitude_m * math.tan(math.radians(camera.vfov_deg) / 2.0)
    meters_per_px_x = ground_width_m / max(width, 1)
    meters_per_px_y = ground_height_m / max(height, 1)

    x_forward = (height / 2.0 - cy) * meters_per_px_y
    y_right = (cx - width / 2.0) * meters_per_px_x

    return {
        "x_forward": round(float(x_forward), 4),
        "y_right": round(float(y_right), 4),
        "z_down": round(float(altitude_m), 4),
    }


def rotate_body_offset_to_ned(x_forward: float, y_right: float, yaw_rad: float) -> Tuple[float, float]:
    """Rotate body-frame forward/right offset into local NED north/east offset."""

    north = math.cos(yaw_rad) * x_forward - math.sin(yaw_rad) * y_right
    east = math.sin(yaw_rad) * x_forward + math.cos(yaw_rad) * y_right
    return north, east


def add_ned_offset_to_global(lat_deg: float, lon_deg: float, north_m: float, east_m: float) -> Tuple[float, float]:
    lat_rad = math.radians(lat_deg)
    d_lat = north_m / EARTH_RADIUS_M
    d_lon = east_m / (EARTH_RADIUS_M * max(0.01, math.cos(lat_rad)))
    return math.degrees(lat_rad + d_lat), lon_deg + math.degrees(d_lon)


def estimate_positions(
    center_px: Sequence[float],
    frame_shape: Sequence[int],
    altitude_m: float,
    camera: CameraGeometry,
    telemetry: Optional[Dict[str, Any]] = None,
) -> Tuple[Dict[str, float], Optional[Dict[str, float]], Dict[str, Optional[float]]]:
    relative = pixel_to_ground_offset_nadir(center_px, frame_shape, altitude_m, camera)
    telemetry = telemetry or {}
    yaw = telemetry.get("yaw_rad")

    local_position = None
    global_position: Dict[str, Optional[float]] = {"lat": None, "lon": None, "alt": None}

    if yaw is not None:
        north, east = rotate_body_offset_to_ned(relative["x_forward"], relative["y_right"], float(yaw))
        local_n = telemetry.get("local_north_m")
        local_e = telemetry.get("local_east_m")
        local_d = telemetry.get("local_down_m")
        if local_n is not None and local_e is not None:
            local_position = {
                "north": round(float(local_n) + north, 4),
                "east": round(float(local_e) + east, 4),
                "down": round(float(local_d) + altitude_m, 4) if local_d is not None else round(float(altitude_m), 4),
            }

        lat = telemetry.get("lat")
        lon = telemetry.get("lon")
        if lat is not None and lon is not None:
            marker_lat, marker_lon = add_ned_offset_to_global(float(lat), float(lon), north, east)
            vehicle_alt = telemetry.get("alt_m")
            rel_alt = telemetry.get("relative_alt_m", altitude_m)
            marker_alt = float(vehicle_alt) - float(rel_alt) if vehicle_alt is not None else None
            global_position = {
                "lat": round(marker_lat, 8),
                "lon": round(marker_lon, 8),
                "alt": round(marker_alt, 3) if marker_alt is not None else None,
            }

    return relative, local_position, global_position
