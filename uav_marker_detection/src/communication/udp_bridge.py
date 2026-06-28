from __future__ import annotations

import json
import socket
from typing import Any, Dict


class UDPJsonBridge:
    """Send detection results as JSON datagrams to a ground endpoint."""

    def __init__(self, host: str, port: int, enabled: bool = False, broadcast: bool = False) -> None:
        self.host = host
        self.port = int(port)
        self.enabled = enabled
        self.broadcast = broadcast
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        if broadcast:
            self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)

    def send(self, payload: Dict[str, Any]) -> None:
        if not self.enabled:
            return
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.sock.sendto(data, (self.host, self.port))

    def close(self) -> None:
        self.sock.close()

