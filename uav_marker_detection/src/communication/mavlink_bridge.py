from __future__ import annotations

import logging
import time
from typing import Any, Dict, Optional


LOGGER = logging.getLogger(__name__)


class MavlinkBridge:
    """Minimal MAVLink bridge for telemetry readback and safe marker reporting.

    This class intentionally sends no movement, mission, arming, targeting, or
    guidance commands. It only reads telemetry and can emit STATUSTEXT summaries.
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None) -> None:
        self.enabled = False
        self.connection_string = None
        self.baud = 57600
        self.heartbeat_timeout_s = 0.0
        self.send_statustext_enabled = True
        self.statustext_min_interval_s = 1.0
        self.auto_request_streams = True
        self.request_stream_rate_hz = 5
        self.master: Optional[Any] = None
        self.mavutil: Optional[Any] = None
        self.last_statustext_s = 0.0
        self.last_message_s: Optional[float] = None
        self.last_heartbeat_s: Optional[float] = None
        self.last_error: Optional[str] = None
        self.streams_requested = False
        self.message_counts: Dict[str, int] = {}
        self.message_timestamps: Dict[str, float] = {}
        self.telemetry: Dict[str, Any] = {
            "mode": None,
            "armed": None,
            "system_status": None,
            "mav_type": None,
            "autopilot": None,
            "roll_rad": None,
            "pitch_rad": None,
            "yaw_rad": None,
            "rollspeed_rad_s": None,
            "pitchspeed_rad_s": None,
            "yawspeed_rad_s": None,
            "lat": None,
            "lon": None,
            "alt_m": None,
            "relative_alt_m": None,
            "local_north_m": None,
            "local_east_m": None,
            "local_down_m": None,
            "local_vx_m_s": None,
            "local_vy_m_s": None,
            "local_vz_m_s": None,
            "vx_m_s": None,
            "vy_m_s": None,
            "vz_m_s": None,
            "heading_deg": None,
            "airspeed_m_s": None,
            "groundspeed_m_s": None,
            "climb_m_s": None,
            "throttle_pct": None,
            "battery_voltage_v": None,
            "battery_current_a": None,
            "battery_remaining_pct": None,
            "battery_temperature_c": None,
            "gps_fix_type": None,
            "satellites_visible": None,
            "gps_hdop": None,
            "gps_vdop": None,
            "gps_ground_speed_m_s": None,
            "gps_cog_deg": None,
            "pressure_abs_hpa": None,
            "pressure_diff_hpa": None,
            "temperature_c": None,
            "rc_rssi": None,
            "ekf_flags": None,
            "messages": {},
            "message_counts": {},
        }
        self.configure(config or {})

    def configure(self, config: Dict[str, Any]) -> None:
        cfg = config or {}
        self.enabled = bool(cfg.get("enabled", False))
        self.connection_string = cfg.get("connection_string")
        self.baud = int(cfg.get("baud", 57600))
        self.heartbeat_timeout_s = float(cfg.get("heartbeat_timeout_s", 0))
        self.send_statustext_enabled = bool(cfg.get("send_statustext", True))
        self.statustext_min_interval_s = float(cfg.get("statustext_min_interval_s", 1.0))
        self.auto_request_streams = bool(cfg.get("auto_request_streams", True))
        self.request_stream_rate_hz = int(cfg.get("request_stream_rate_hz", 5))
        self.last_error = None

    def connect(self) -> None:
        self.close()
        if not self.enabled:
            return
        if not self.connection_string:
            self.last_error = "MAVLink connection string is empty"
            LOGGER.warning("%s; continuing without MAVLink.", self.last_error)
            self.enabled = False
            return
        try:
            from pymavlink import mavutil
        except ImportError:
            self.last_error = "pymavlink is not installed"
            LOGGER.warning("%s; continuing without MAVLink.", self.last_error)
            self.enabled = False
            return

        try:
            self.mavutil = mavutil
            self.master = mavutil.mavlink_connection(
                self.connection_string,
                baud=self.baud,
                source_system=191,
                source_component=191,
            )
            if self.heartbeat_timeout_s > 0:
                heartbeat = self.master.wait_heartbeat(timeout=self.heartbeat_timeout_s)
                if heartbeat is not None:
                    now = time.monotonic()
                    self.last_heartbeat_s = now
                    self.last_message_s = now
                    self._handle_heartbeat(heartbeat, now)
                    self._request_telemetry_streams()
            LOGGER.info("MAVLink bridge connected: %s", self.connection_string)
        except Exception as exc:
            self.last_error = f"Could not open MAVLink connection {self.connection_string}: {exc}"
            LOGGER.warning("%s", self.last_error)
            self.master = None
            self.enabled = False

    def poll_telemetry(self, max_messages: int = 100) -> Dict[str, Any]:
        if not self.enabled or self.master is None:
            return dict(self.telemetry)

        for _ in range(max_messages):
            msg = self.master.recv_match(blocking=False)
            if msg is None:
                break
            msg_type = msg.get_type()
            if msg_type == "BAD_DATA":
                continue
            now = time.monotonic()
            self.last_message_s = now
            self.message_counts[msg_type] = self.message_counts.get(msg_type, 0) + 1
            self.message_timestamps[msg_type] = now
            self.telemetry["message_counts"] = dict(self.message_counts)
            self._store_raw_message(msg_type, msg)
            if msg_type == "HEARTBEAT":
                self.last_heartbeat_s = now
                self._handle_heartbeat(msg, now)
                self._request_telemetry_streams()
            if msg_type == "ATTITUDE":
                self.telemetry["roll_rad"] = float(msg.roll)
                self.telemetry["pitch_rad"] = float(msg.pitch)
                self.telemetry["yaw_rad"] = float(msg.yaw)
                self.telemetry["rollspeed_rad_s"] = float(msg.rollspeed)
                self.telemetry["pitchspeed_rad_s"] = float(msg.pitchspeed)
                self.telemetry["yawspeed_rad_s"] = float(msg.yawspeed)
            elif msg_type == "GLOBAL_POSITION_INT":
                self.telemetry["lat"] = float(msg.lat) / 1e7
                self.telemetry["lon"] = float(msg.lon) / 1e7
                self.telemetry["alt_m"] = float(msg.alt) / 1000.0
                self.telemetry["relative_alt_m"] = float(msg.relative_alt) / 1000.0
                self.telemetry["vx_m_s"] = float(msg.vx) / 100.0
                self.telemetry["vy_m_s"] = float(msg.vy) / 100.0
                self.telemetry["vz_m_s"] = float(msg.vz) / 100.0
                self.telemetry["heading_deg"] = None if int(msg.hdg) == 65535 else float(msg.hdg) / 100.0
            elif msg_type == "LOCAL_POSITION_NED":
                self.telemetry["local_north_m"] = float(msg.x)
                self.telemetry["local_east_m"] = float(msg.y)
                self.telemetry["local_down_m"] = float(msg.z)
                self.telemetry["local_vx_m_s"] = float(msg.vx)
                self.telemetry["local_vy_m_s"] = float(msg.vy)
                self.telemetry["local_vz_m_s"] = float(msg.vz)
            elif msg_type == "VFR_HUD":
                self.telemetry["airspeed_m_s"] = float(msg.airspeed)
                self.telemetry["groundspeed_m_s"] = float(msg.groundspeed)
                self.telemetry["heading_deg"] = float(msg.heading)
                self.telemetry["throttle_pct"] = float(msg.throttle)
                self.telemetry["climb_m_s"] = float(msg.climb)
                self.telemetry["alt_m"] = float(msg.alt)
            elif msg_type == "SYS_STATUS":
                self.telemetry["battery_voltage_v"] = self._mv_to_v(msg.voltage_battery)
                self.telemetry["battery_current_a"] = self._ca_to_a(msg.current_battery)
                self.telemetry["battery_remaining_pct"] = None if int(msg.battery_remaining) < 0 else int(msg.battery_remaining)
                self.telemetry["system_load_pct"] = float(msg.load) / 10.0
            elif msg_type == "BATTERY_STATUS":
                self.telemetry["battery_current_a"] = self._ca_to_a(msg.current_battery)
                self.telemetry["battery_remaining_pct"] = None if int(msg.battery_remaining) < 0 else int(msg.battery_remaining)
                if hasattr(msg, "temperature") and int(msg.temperature) not in (-1, 32767):
                    self.telemetry["battery_temperature_c"] = float(msg.temperature) / 100.0
                voltages = [int(v) for v in getattr(msg, "voltages", []) if 0 < int(v) < 65535]
                if voltages:
                    self.telemetry["battery_voltage_v"] = sum(voltages) / 1000.0
            elif msg_type == "GPS_RAW_INT":
                self.telemetry["gps_fix_type"] = int(msg.fix_type)
                self.telemetry["satellites_visible"] = int(msg.satellites_visible)
                self.telemetry["gps_hdop"] = None if int(msg.eph) == 65535 else float(msg.eph) / 100.0
                self.telemetry["gps_vdop"] = None if int(msg.epv) == 65535 else float(msg.epv) / 100.0
                self.telemetry["gps_ground_speed_m_s"] = None if int(msg.vel) == 65535 else float(msg.vel) / 100.0
                self.telemetry["gps_cog_deg"] = None if int(msg.cog) == 65535 else float(msg.cog) / 100.0
            elif msg_type in {"SCALED_PRESSURE", "SCALED_PRESSURE2", "SCALED_PRESSURE3"}:
                self.telemetry["pressure_abs_hpa"] = float(msg.press_abs)
                self.telemetry["pressure_diff_hpa"] = float(msg.press_diff)
                self.telemetry["temperature_c"] = float(msg.temperature) / 100.0
            elif msg_type == "HIGHRES_IMU":
                self.telemetry["pressure_abs_hpa"] = float(msg.abs_pressure)
                self.telemetry["pressure_diff_hpa"] = float(msg.diff_pressure)
                self.telemetry["temperature_c"] = float(msg.temperature)
            elif msg_type == "RC_CHANNELS":
                self.telemetry["rc_rssi"] = None if int(msg.rssi) == 255 else int(msg.rssi)
            elif msg_type in {"EKF_STATUS_REPORT", "ESTIMATOR_STATUS"}:
                self.telemetry["ekf_flags"] = int(getattr(msg, "flags", 0))
        return dict(self.telemetry)

    def _handle_heartbeat(self, msg: Any, now: float) -> None:
        self.telemetry["mav_type"] = int(getattr(msg, "type", 0))
        self.telemetry["autopilot"] = int(getattr(msg, "autopilot", 0))
        self.telemetry["base_mode"] = int(getattr(msg, "base_mode", 0))
        self.telemetry["custom_mode"] = int(getattr(msg, "custom_mode", 0))
        self.telemetry["system_status"] = int(getattr(msg, "system_status", 0))
        self.telemetry["armed"] = self._is_armed(int(getattr(msg, "base_mode", 0)))
        if self.mavutil is not None:
            try:
                self.telemetry["mode"] = self.mavutil.mode_string_v10(msg)
            except Exception:
                pass

    def _request_telemetry_streams(self) -> None:
        if not self.auto_request_streams or self.streams_requested or self.master is None or self.mavutil is None:
            return
        target_system = int(getattr(self.master, "target_system", 0) or 1)
        target_component = int(getattr(self.master, "target_component", 0) or 1)
        rate_hz = max(1, int(self.request_stream_rate_hz))
        try:
            self.master.mav.request_data_stream_send(
                target_system,
                target_component,
                self.mavutil.mavlink.MAV_DATA_STREAM_ALL,
                rate_hz,
                1,
            )
        except Exception as exc:
            LOGGER.debug("MAVLink request_data_stream failed: %s", exc)

        message_names = [
            "HEARTBEAT",
            "ATTITUDE",
            "GLOBAL_POSITION_INT",
            "LOCAL_POSITION_NED",
            "VFR_HUD",
            "SYS_STATUS",
            "BATTERY_STATUS",
            "GPS_RAW_INT",
            "SCALED_PRESSURE",
            "HIGHRES_IMU",
            "RC_CHANNELS",
            "NAV_CONTROLLER_OUTPUT",
            "EKF_STATUS_REPORT",
            "ESTIMATOR_STATUS",
        ]
        for name in message_names:
            msg_id = getattr(self.mavutil.mavlink, f"MAVLINK_MSG_ID_{name}", None)
            if msg_id is None:
                continue
            try:
                self.master.mav.command_long_send(
                    target_system,
                    target_component,
                    self.mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL,
                    0,
                    int(msg_id),
                    1_000_000.0 / rate_hz,
                    0,
                    0,
                    0,
                    0,
                    0,
                )
            except Exception as exc:
                LOGGER.debug("MAVLink SET_MESSAGE_INTERVAL failed for %s: %s", name, exc)
        self.streams_requested = True

    def is_link_open(self) -> bool:
        return self.enabled and self.master is not None

    def has_recent_heartbeat(self, timeout_s: float = 3.0) -> bool:
        if self.last_heartbeat_s is None:
            return False
        return (time.monotonic() - self.last_heartbeat_s) <= timeout_s

    def status(self) -> Dict[str, Any]:
        return {
            "enabled": self.enabled,
            "link_open": self.is_link_open(),
            "connected": self.has_recent_heartbeat(),
            "connection_string": self.connection_string,
            "baud": self.baud,
            "last_message_age_s": self._age(self.last_message_s),
            "last_heartbeat_age_s": self._age(self.last_heartbeat_s),
            "message_counts": dict(self.message_counts),
            "last_error": self.last_error,
        }

    def _age(self, timestamp_s: Optional[float]) -> Optional[float]:
        if timestamp_s is None:
            return None
        return max(0.0, time.monotonic() - timestamp_s)

    def send_detection_summary(self, result: Dict[str, Any]) -> None:
        if not self.enabled or self.master is None or not self.send_statustext_enabled:
            return
        detections = result.get("detections", [])
        if not detections:
            return
        now = time.monotonic()
        if now - self.last_statustext_s < self.statustext_min_interval_s:
            return
        self.last_statustext_s = now

        summary_parts = []
        for detection in detections[:3]:
            center = detection.get("center_px", [None, None])
            summary_parts.append(
                f"{detection.get('class')} c={detection.get('confidence'):.2f} px=({center[0]},{center[1]})"
            )
        text = "MARKER " + "; ".join(summary_parts)
        self._send_statustext(text[:50])

    def _send_statustext(self, text: str) -> None:
        try:
            from pymavlink import mavutil

            severity = mavutil.mavlink.MAV_SEVERITY_INFO
            payload = text.encode("utf-8")
            self.master.mav.statustext_send(severity, payload)
        except Exception as exc:
            LOGGER.debug("STATUSTEXT send failed: %s", exc)

    def close(self) -> None:
        if self.master is not None:
            try:
                self.master.close()
            except Exception:
                pass
        self.master = None
        self.mavutil = None
        self.last_message_s = None
        self.last_heartbeat_s = None
        self.streams_requested = False

    def disconnect(self) -> None:
        self.close()
        self.enabled = False

    def _store_raw_message(self, msg_type: str, msg: Any) -> None:
        try:
            payload = msg.to_dict()
        except Exception:
            return
        payload.pop("mavpackettype", None)
        sanitized = {key: self._sanitize_value(value) for key, value in payload.items()}
        messages = dict(self.telemetry.get("messages", {}))
        sanitized["_count"] = self.message_counts.get(msg_type, 0)
        sanitized["_age_s"] = 0.0
        messages[msg_type] = sanitized
        self.telemetry["messages"] = messages

    def _sanitize_value(self, value: Any) -> Any:
        if isinstance(value, bytes):
            return value.decode("utf-8", errors="replace").rstrip("\x00")
        if isinstance(value, (list, tuple)):
            return [self._sanitize_value(item) for item in value]
        if isinstance(value, dict):
            return {str(key): self._sanitize_value(item) for key, item in value.items()}
        return value

    def _is_armed(self, base_mode: int) -> bool:
        if self.mavutil is None:
            return False
        return bool(base_mode & self.mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)

    def _mv_to_v(self, value: Any) -> Optional[float]:
        ivalue = int(value)
        if ivalue <= 0 or ivalue == 65535:
            return None
        return float(ivalue) / 1000.0

    def _ca_to_a(self, value: Any) -> Optional[float]:
        ivalue = int(value)
        if ivalue < 0:
            return None
        return float(ivalue) / 100.0
