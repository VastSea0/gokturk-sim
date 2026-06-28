from __future__ import annotations

from typing import Any, Dict, Optional

from .json_logger import JSONLogger
from .mavlink_bridge import MavlinkBridge
from .udp_bridge import UDPJsonBridge


class TargetReporter:
    """Fan out marker reports to JSONL, UDP JSON, and safe MAVLink debug output."""

    def __init__(
        self,
        json_config: Optional[Dict[str, Any]] = None,
        udp_config: Optional[Dict[str, Any]] = None,
        mavlink_bridge: Optional[MavlinkBridge] = None,
    ) -> None:
        json_config = json_config or {}
        udp_config = udp_config or {}
        self.json_logger = JSONLogger(json_config.get("path"), enabled=bool(json_config.get("enabled", False)))
        self.udp_bridge = UDPJsonBridge(
            udp_config.get("host", "127.0.0.1"),
            int(udp_config.get("port", 15000)),
            enabled=bool(udp_config.get("enabled", False)),
            broadcast=bool(udp_config.get("broadcast", False)),
        )
        self.mavlink_bridge = mavlink_bridge

    def start(self) -> None:
        self.json_logger.start()

    def report(self, payload: Dict[str, Any]) -> None:
        self.json_logger.write(payload)
        self.udp_bridge.send(payload)
        if self.mavlink_bridge is not None:
            self.mavlink_bridge.send_detection_summary(payload)

    def close(self) -> None:
        self.json_logger.close()
        self.udp_bridge.close()
