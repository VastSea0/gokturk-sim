from __future__ import annotations

import math
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from geometry.coordinate_transform import (
    CameraGeometry,
    add_ned_offset_to_global,
    pixel_to_ground_offset_nadir,
    rotate_body_offset_to_ned,
)


def test_center_pixel_maps_to_zero_offset() -> None:
    rel = pixel_to_ground_offset_nadir((320, 240), (480, 640, 3), 20.0, CameraGeometry())

    assert abs(rel["x_forward"]) < 1e-6
    assert abs(rel["y_right"]) < 1e-6
    assert rel["z_down"] == 20.0


def test_pixel_right_maps_to_positive_y_right() -> None:
    rel = pixel_to_ground_offset_nadir((420, 240), (480, 640, 3), 20.0, CameraGeometry())

    assert rel["y_right"] > 0
    assert abs(rel["x_forward"]) < 1e-6


def test_body_offset_rotates_with_yaw() -> None:
    north, east = rotate_body_offset_to_ned(10.0, 0.0, math.radians(90))

    assert abs(north) < 1e-6
    assert abs(east - 10.0) < 1e-6


def test_global_offset_changes_lat_and_lon() -> None:
    lat, lon = add_ned_offset_to_global(37.0, 36.0, 10.0, 10.0)

    assert lat > 37.0
    assert lon > 36.0

