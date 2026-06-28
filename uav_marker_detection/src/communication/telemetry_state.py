from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional


@dataclass
class TelemetryState:
    connected: bool = False
    simulated: bool = False
    connection_string: Optional[str] = None
    baud: Optional[int] = None
    last_update_s: Optional[float] = None
    roll_rad: Optional[float] = None
    pitch_rad: Optional[float] = None
    yaw_rad: Optional[float] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    alt_m: Optional[float] = None
    relative_alt_m: Optional[float] = None
    local_north_m: Optional[float] = None
    local_east_m: Optional[float] = None
    local_down_m: Optional[float] = None
    last_error: Optional[str] = None

    @classmethod
    def from_bridge(cls, telemetry: Dict[str, Any], status: Dict[str, Any]) -> "TelemetryState":
        last_message_age = status.get("last_message_age_s")
        last_update_s = time.time() - float(last_message_age) if last_message_age is not None else None
        return cls(
            connected=bool(status.get("connected") or status.get("link_open")),
            simulated=False,
            connection_string=status.get("connection_string"),
            baud=status.get("baud"),
            last_update_s=last_update_s,
            roll_rad=telemetry.get("roll_rad"),
            pitch_rad=telemetry.get("pitch_rad"),
            yaw_rad=telemetry.get("yaw_rad"),
            lat=telemetry.get("lat"),
            lon=telemetry.get("lon"),
            alt_m=telemetry.get("alt_m"),
            relative_alt_m=telemetry.get("relative_alt_m"),
            local_north_m=telemetry.get("local_north_m"),
            local_east_m=telemetry.get("local_east_m"),
            local_down_m=telemetry.get("local_down_m"),
            last_error=status.get("last_error"),
        )

    @classmethod
    def simulated_state(cls, frame_id: int = 0) -> "TelemetryState":
        yaw = math.radians((frame_id * 2) % 360)
        return cls(
            connected=True,
            simulated=True,
            connection_string="simulated",
            baud=None,
            last_update_s=time.time(),
            roll_rad=0.0,
            pitch_rad=0.0,
            yaw_rad=yaw,
            lat=37.3914,
            lon=36.8522,
            alt_m=520.0,
            relative_alt_m=20.0,
            local_north_m=float(frame_id) * 0.05,
            local_east_m=0.0,
            local_down_m=-20.0,
        )

    def as_telemetry_dict(self) -> Dict[str, Any]:
        return {
            "roll_rad": self.roll_rad,
            "pitch_rad": self.pitch_rad,
            "yaw_rad": self.yaw_rad,
            "lat": self.lat,
            "lon": self.lon,
            "alt_m": self.alt_m,
            "relative_alt_m": self.relative_alt_m,
            "local_north_m": self.local_north_m,
            "local_east_m": self.local_east_m,
            "local_down_m": self.local_down_m,
        }

    def status_line(self) -> str:
        if self.simulated:
            return "SIM telemetry active"
        if self.connected:
            return "MAVLink connected/open"
        if self.last_error:
            return self.last_error
        return "MAVLink disconnected"

