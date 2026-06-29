from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional


@dataclass
class TelemetryState:
    connected: bool = False
    link_open: bool = False
    simulated: bool = False
    connection_string: Optional[str] = None
    baud: Optional[int] = None
    last_update_s: Optional[float] = None
    last_message_age_s: Optional[float] = None
    last_heartbeat_age_s: Optional[float] = None
    mode: Optional[str] = None
    armed: Optional[bool] = None
    system_status: Optional[int] = None
    mav_type: Optional[int] = None
    autopilot: Optional[int] = None
    roll_rad: Optional[float] = None
    pitch_rad: Optional[float] = None
    yaw_rad: Optional[float] = None
    rollspeed_rad_s: Optional[float] = None
    pitchspeed_rad_s: Optional[float] = None
    yawspeed_rad_s: Optional[float] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    alt_m: Optional[float] = None
    relative_alt_m: Optional[float] = None
    local_north_m: Optional[float] = None
    local_east_m: Optional[float] = None
    local_down_m: Optional[float] = None
    local_vx_m_s: Optional[float] = None
    local_vy_m_s: Optional[float] = None
    local_vz_m_s: Optional[float] = None
    vx_m_s: Optional[float] = None
    vy_m_s: Optional[float] = None
    vz_m_s: Optional[float] = None
    heading_deg: Optional[float] = None
    airspeed_m_s: Optional[float] = None
    groundspeed_m_s: Optional[float] = None
    climb_m_s: Optional[float] = None
    throttle_pct: Optional[float] = None
    battery_voltage_v: Optional[float] = None
    battery_current_a: Optional[float] = None
    battery_remaining_pct: Optional[int] = None
    battery_temperature_c: Optional[float] = None
    gps_fix_type: Optional[int] = None
    satellites_visible: Optional[int] = None
    gps_hdop: Optional[float] = None
    gps_vdop: Optional[float] = None
    gps_ground_speed_m_s: Optional[float] = None
    gps_cog_deg: Optional[float] = None
    pressure_abs_hpa: Optional[float] = None
    pressure_diff_hpa: Optional[float] = None
    temperature_c: Optional[float] = None
    rc_rssi: Optional[int] = None
    ekf_flags: Optional[int] = None
    messages: Optional[Dict[str, Dict[str, Any]]] = None
    message_counts: Optional[Dict[str, int]] = None
    last_error: Optional[str] = None

    @classmethod
    def from_bridge(cls, telemetry: Dict[str, Any], status: Dict[str, Any]) -> "TelemetryState":
        last_message_age = status.get("last_message_age_s")
        last_update_s = time.time() - float(last_message_age) if last_message_age is not None else None
        return cls(
            connected=bool(status.get("connected")),
            link_open=bool(status.get("link_open")),
            simulated=False,
            connection_string=status.get("connection_string"),
            baud=status.get("baud"),
            last_update_s=last_update_s,
            last_message_age_s=last_message_age,
            last_heartbeat_age_s=status.get("last_heartbeat_age_s"),
            mode=telemetry.get("mode"),
            armed=telemetry.get("armed"),
            system_status=telemetry.get("system_status"),
            mav_type=telemetry.get("mav_type"),
            autopilot=telemetry.get("autopilot"),
            roll_rad=telemetry.get("roll_rad"),
            pitch_rad=telemetry.get("pitch_rad"),
            yaw_rad=telemetry.get("yaw_rad"),
            rollspeed_rad_s=telemetry.get("rollspeed_rad_s"),
            pitchspeed_rad_s=telemetry.get("pitchspeed_rad_s"),
            yawspeed_rad_s=telemetry.get("yawspeed_rad_s"),
            lat=telemetry.get("lat"),
            lon=telemetry.get("lon"),
            alt_m=telemetry.get("alt_m"),
            relative_alt_m=telemetry.get("relative_alt_m"),
            local_north_m=telemetry.get("local_north_m"),
            local_east_m=telemetry.get("local_east_m"),
            local_down_m=telemetry.get("local_down_m"),
            local_vx_m_s=telemetry.get("local_vx_m_s"),
            local_vy_m_s=telemetry.get("local_vy_m_s"),
            local_vz_m_s=telemetry.get("local_vz_m_s"),
            vx_m_s=telemetry.get("vx_m_s"),
            vy_m_s=telemetry.get("vy_m_s"),
            vz_m_s=telemetry.get("vz_m_s"),
            heading_deg=telemetry.get("heading_deg"),
            airspeed_m_s=telemetry.get("airspeed_m_s"),
            groundspeed_m_s=telemetry.get("groundspeed_m_s"),
            climb_m_s=telemetry.get("climb_m_s"),
            throttle_pct=telemetry.get("throttle_pct"),
            battery_voltage_v=telemetry.get("battery_voltage_v"),
            battery_current_a=telemetry.get("battery_current_a"),
            battery_remaining_pct=telemetry.get("battery_remaining_pct"),
            battery_temperature_c=telemetry.get("battery_temperature_c"),
            gps_fix_type=telemetry.get("gps_fix_type"),
            satellites_visible=telemetry.get("satellites_visible"),
            gps_hdop=telemetry.get("gps_hdop"),
            gps_vdop=telemetry.get("gps_vdop"),
            gps_ground_speed_m_s=telemetry.get("gps_ground_speed_m_s"),
            gps_cog_deg=telemetry.get("gps_cog_deg"),
            pressure_abs_hpa=telemetry.get("pressure_abs_hpa"),
            pressure_diff_hpa=telemetry.get("pressure_diff_hpa"),
            temperature_c=telemetry.get("temperature_c"),
            rc_rssi=telemetry.get("rc_rssi"),
            ekf_flags=telemetry.get("ekf_flags"),
            messages=telemetry.get("messages") or {},
            message_counts=status.get("message_counts") or telemetry.get("message_counts") or {},
            last_error=status.get("last_error"),
        )

    @classmethod
    def simulated_state(cls, frame_id: int = 0) -> "TelemetryState":
        yaw = math.radians((frame_id * 2) % 360)
        return cls(
            connected=True,
            link_open=True,
            simulated=True,
            connection_string="simulated",
            baud=None,
            last_update_s=time.time(),
            last_message_age_s=0.0,
            last_heartbeat_age_s=0.0,
            mode="SIM",
            armed=False,
            system_status=4,
            mav_type=2,
            autopilot=12,
            roll_rad=0.0,
            pitch_rad=0.0,
            yaw_rad=yaw,
            rollspeed_rad_s=0.0,
            pitchspeed_rad_s=0.0,
            yawspeed_rad_s=0.01,
            lat=37.3914,
            lon=36.8522,
            alt_m=520.0,
            relative_alt_m=20.0,
            local_north_m=float(frame_id) * 0.05,
            local_east_m=0.0,
            local_down_m=-20.0,
            local_vx_m_s=0.5,
            local_vy_m_s=0.0,
            local_vz_m_s=0.0,
            heading_deg=math.degrees(yaw),
            airspeed_m_s=14.2,
            groundspeed_m_s=13.8,
            climb_m_s=0.0,
            throttle_pct=38.0,
            battery_voltage_v=15.6,
            battery_current_a=4.2,
            battery_remaining_pct=78,
            gps_fix_type=3,
            satellites_visible=14,
            gps_hdop=0.8,
            messages={
                "HEARTBEAT": {"mode": "SIM", "armed": False},
                "VFR_HUD": {"airspeed": 14.2, "groundspeed": 13.8, "throttle": 38, "climb": 0.0},
                "SYS_STATUS": {"voltage_battery": 15600, "current_battery": 420, "battery_remaining": 78},
            },
            message_counts={"HEARTBEAT": frame_id, "VFR_HUD": frame_id, "SYS_STATUS": frame_id},
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
            "local_vx_m_s": self.local_vx_m_s,
            "local_vy_m_s": self.local_vy_m_s,
            "local_vz_m_s": self.local_vz_m_s,
            "heading_deg": self.heading_deg,
            "airspeed_m_s": self.airspeed_m_s,
            "groundspeed_m_s": self.groundspeed_m_s,
            "climb_m_s": self.climb_m_s,
            "battery_voltage_v": self.battery_voltage_v,
            "battery_remaining_pct": self.battery_remaining_pct,
        }

    def status_line(self) -> str:
        if self.simulated:
            return "SIM telemetry active"
        if self.connected:
            return "MAVLink connected/open"
        if self.last_error:
            return self.last_error
        return "MAVLink disconnected"
