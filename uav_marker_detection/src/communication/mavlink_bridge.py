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
        cfg = config or {}
        self.enabled = bool(cfg.get("enabled", False))
        self.connection_string = cfg.get("connection_string")
        self.baud = int(cfg.get("baud", 57600))
        self.heartbeat_timeout_s = float(cfg.get("heartbeat_timeout_s", 0))
        self.send_statustext_enabled = bool(cfg.get("send_statustext", True))
        self.statustext_min_interval_s = float(cfg.get("statustext_min_interval_s", 1.0))
        self.master: Optional[Any] = None
        self.last_statustext_s = 0.0
        self.telemetry: Dict[str, Any] = {
            "roll_rad": None,
            "pitch_rad": None,
            "yaw_rad": None,
            "lat": None,
            "lon": None,
            "alt_m": None,
            "relative_alt_m": None,
            "local_north_m": None,
            "local_east_m": None,
            "local_down_m": None,
        }

    def connect(self) -> None:
        if not self.enabled:
            return
        if not self.connection_string:
            LOGGER.warning("MAVLink enabled but connection_string is empty; continuing without MAVLink.")
            self.enabled = False
            return
        try:
            from pymavlink import mavutil
        except ImportError:
            LOGGER.warning("pymavlink is not installed; continuing without MAVLink.")
            self.enabled = False
            return

        try:
            self.master = mavutil.mavlink_connection(
                self.connection_string,
                baud=self.baud,
                source_system=191,
                source_component=191,
            )
            if self.heartbeat_timeout_s > 0:
                self.master.wait_heartbeat(timeout=self.heartbeat_timeout_s)
            LOGGER.info("MAVLink bridge connected: %s", self.connection_string)
        except Exception as exc:
            LOGGER.warning("Could not open MAVLink connection %s: %s", self.connection_string, exc)
            self.master = None
            self.enabled = False

    def poll_telemetry(self, max_messages: int = 20) -> Dict[str, Any]:
        if not self.enabled or self.master is None:
            return dict(self.telemetry)

        for _ in range(max_messages):
            msg = self.master.recv_match(blocking=False)
            if msg is None:
                break
            msg_type = msg.get_type()
            if msg_type == "BAD_DATA":
                continue
            if msg_type == "ATTITUDE":
                self.telemetry["roll_rad"] = float(msg.roll)
                self.telemetry["pitch_rad"] = float(msg.pitch)
                self.telemetry["yaw_rad"] = float(msg.yaw)
            elif msg_type == "GLOBAL_POSITION_INT":
                self.telemetry["lat"] = float(msg.lat) / 1e7
                self.telemetry["lon"] = float(msg.lon) / 1e7
                self.telemetry["alt_m"] = float(msg.alt) / 1000.0
                self.telemetry["relative_alt_m"] = float(msg.relative_alt) / 1000.0
            elif msg_type == "LOCAL_POSITION_NED":
                self.telemetry["local_north_m"] = float(msg.x)
                self.telemetry["local_east_m"] = float(msg.y)
                self.telemetry["local_down_m"] = float(msg.z)
            elif msg_type == "VFR_HUD" and self.telemetry.get("alt_m") is None:
                self.telemetry["alt_m"] = float(msg.alt)
        return dict(self.telemetry)

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
        self.master = None
