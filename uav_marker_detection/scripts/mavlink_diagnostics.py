#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path
from typing import Dict, List

SRC_DIR = Path(__file__).resolve().parents[1] / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from communication.mavlink_bridge import MavlinkBridge


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Diagnose Pixhawk/PX4 MAVLink telemetry on Raspberry Pi")
    parser.add_argument("--connection", default="udpin:0.0.0.0:14550")
    parser.add_argument("--baud", type=int, default=57600)
    parser.add_argument("--timeout", type=float, default=45.0)
    parser.add_argument("--ports", default="14550,14540,14551,14552")
    parser.add_argument("--auto-udp", action="store_true", help="Try common UDP listen ports until heartbeat is found")
    parser.add_argument("--rate", type=int, default=5)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    connections = [args.connection]
    if args.auto_udp:
        connections = [f"udpin:0.0.0.0:{int(port.strip())}" for port in args.ports.split(",") if port.strip()]

    for connection in connections:
        print(f"[INFO] Listening MAVLink on {connection}")
        ok = monitor_connection(connection, args.baud, args.timeout if not args.auto_udp else min(args.timeout, 15.0), args.rate)
        if ok:
            return 0
        print(f"[WARN] No heartbeat on {connection}")
    return 1


def monitor_connection(connection: str, baud: int, timeout_s: float, rate_hz: int) -> bool:
    bridge = MavlinkBridge(
        {
            "enabled": True,
            "connection_string": connection,
            "baud": baud,
            "heartbeat_timeout_s": 0,
            "auto_request_streams": True,
            "request_stream_rate_hz": rate_hz,
            "reconnect_enabled": True,
            "heartbeat_loss_timeout_s": 8.0,
            "no_message_timeout_s": 8.0,
            "reconnect_interval_s": 3.0,
            "send_statustext": False,
        }
    )
    bridge.connect()
    start = time.monotonic()
    last_print_s = 0.0
    last_counts: Dict[str, int] = {}
    saw_heartbeat = False

    try:
        while time.monotonic() - start < timeout_s:
            telemetry = bridge.poll_telemetry(max_messages=200)
            status = bridge.status()
            counts = status.get("message_counts", {})
            new_types = [name for name, count in counts.items() if count != last_counts.get(name)]
            if new_types:
                last_counts = dict(counts)
                print("[MSG] " + ", ".join(f"{name}:{counts[name]}" for name in sorted(new_types)))

            if status.get("connected"):
                saw_heartbeat = True

            now = time.monotonic()
            if now - last_print_s >= 1.0:
                last_print_s = now
                print_summary(status, telemetry)
            time.sleep(0.05)
    except KeyboardInterrupt:
        print("[INFO] Interrupted")
    finally:
        bridge.close()
    return saw_heartbeat


def print_summary(status: Dict, telemetry: Dict) -> None:
    heartbeat_age = status.get("last_heartbeat_age_s")
    msg_age = status.get("last_message_age_s")
    mode = telemetry.get("mode") or "-"
    armed = telemetry.get("armed")
    airspeed = fmt(telemetry.get("airspeed_m_s"), "m/s")
    groundspeed = fmt(telemetry.get("groundspeed_m_s"), "m/s")
    rel_alt = fmt(telemetry.get("relative_alt_m"), "m")
    battery = fmt(telemetry.get("battery_voltage_v"), "V")
    sats = telemetry.get("satellites_visible")
    print(
        "[STAT] "
        f"heartbeat={'OK' if status.get('connected') else 'WAIT'} "
        f"hb_age={fmt(heartbeat_age, 's')} msg_age={fmt(msg_age, 's')} "
        f"mode={mode} armed={armed} "
        f"airspeed={airspeed} groundspeed={groundspeed} rel_alt={rel_alt} "
        f"battery={battery} sats={sats if sats is not None else '-'}"
    )
    if status.get("last_error"):
        print(f"[ERR] {status['last_error']}")


def fmt(value, unit: str = "") -> str:
    if value is None:
        return "-"
    if isinstance(value, float):
        text = f"{value:.2f}"
    else:
        text = str(value)
    return f"{text}{unit}" if unit else text


if __name__ == "__main__":
    raise SystemExit(main())
