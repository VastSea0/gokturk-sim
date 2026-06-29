from __future__ import annotations

import glob
import math
import time
from typing import Any, Dict, Optional

from communication.telemetry_state import TelemetryState

from .qt_compat import Signal, QtWidgets


class ConnectionPanel(QtWidgets.QGroupBox):
    """Pixhawk/PX4 MAVLink connection controls."""

    connect_requested = Signal(dict)
    disconnect_requested = Signal()

    def __init__(self, parent: Optional[QtWidgets.QWidget] = None) -> None:
        super().__init__("Pixhawk / MAVLink", parent)

        self.type_combo = QtWidgets.QComboBox()
        self.type_combo.addItems(["serial", "udp", "simulation"])

        self.serial_port_combo = QtWidgets.QComboBox()
        self.serial_port_combo.setEditable(True)
        self.refresh_ports()
        if self.serial_port_combo.findText("/dev/ttyUSB0") < 0:
            self.serial_port_combo.insertItem(0, "/dev/ttyUSB0")
        self.serial_port_combo.setCurrentText("/dev/ttyUSB0")

        self.baud_combo = QtWidgets.QComboBox()
        self.baud_combo.addItems(["57600", "115200"])
        self.baud_combo.setCurrentText("57600")

        self.udp_edit = QtWidgets.QLineEdit("udpin:0.0.0.0:14550")
        self.status_label = QtWidgets.QLabel("Disconnected")
        self.status_label.setStyleSheet("color: #b91c1c; font-weight: 600;")
        self.summary_label = QtWidgets.QLabel("Telemetry: -")
        self.summary_label.setWordWrap(True)

        self.telemetry_table = QtWidgets.QTableWidget(0, 2)
        self.telemetry_table.setHorizontalHeaderLabels(["Field", "Value"])
        self.telemetry_table.verticalHeader().setVisible(False)
        self.telemetry_table.setMinimumHeight(360)
        try:
            self.telemetry_table.setEditTriggers(QtWidgets.QAbstractItemView.EditTrigger.NoEditTriggers)
            self.telemetry_table.setSelectionBehavior(QtWidgets.QAbstractItemView.SelectionBehavior.SelectRows)
            self.telemetry_table.horizontalHeader().setSectionResizeMode(0, QtWidgets.QHeaderView.ResizeMode.ResizeToContents)
            self.telemetry_table.horizontalHeader().setSectionResizeMode(1, QtWidgets.QHeaderView.ResizeMode.Stretch)
        except AttributeError:
            pass
        self._last_table_update_s = 0.0

        self.connect_button = QtWidgets.QPushButton("Connect")
        self.connect_button.setObjectName("connect_button")
        self.disconnect_button = QtWidgets.QPushButton("Disconnect")
        self.disconnect_button.setObjectName("disconnect_button")
        self.refresh_button = QtWidgets.QPushButton("Refresh ports")
        self.refresh_button.setObjectName("refresh_button")

        form = QtWidgets.QFormLayout()
        form.setSpacing(10)
        form.addRow("Type", self.type_combo)
        form.addRow("Serial port", self.serial_port_combo)
        form.addRow("Baudrate", self.baud_combo)
        form.addRow("UDP", self.udp_edit)
        form.addRow("Status", self.status_label)
        form.addRow("Summary", self.summary_label)

        button_row = QtWidgets.QHBoxLayout()
        button_row.setSpacing(10)
        button_row.addWidget(self.connect_button)
        button_row.addWidget(self.disconnect_button)
        button_row.addWidget(self.refresh_button)

        layout = QtWidgets.QVBoxLayout(self)
        layout.setContentsMargins(16, 24, 16, 16)
        layout.setSpacing(16)
        layout.addLayout(form)
        layout.addWidget(self.telemetry_table)
        layout.addLayout(button_row)

        self.connect_button.clicked.connect(self._emit_connect)
        self.disconnect_button.clicked.connect(self.disconnect_requested.emit)
        self.refresh_button.clicked.connect(self.refresh_ports)
        self.type_combo.currentTextChanged.connect(self._update_enabled_fields)
        self._update_enabled_fields()

    def refresh_ports(self) -> None:
        current = self.serial_port_combo.currentText() if hasattr(self, "serial_port_combo") else "/dev/ttyUSB0"
        patterns = ["/dev/ttyUSB*", "/dev/ttyACM*", "/dev/ttyAMA*", "/dev/serial/by-id/*"]
        ports = []
        for pattern in patterns:
            ports.extend(sorted(glob.glob(pattern)))
        if not ports:
            ports = ["/dev/ttyUSB0", "/dev/ttyAMA0"]
        self.serial_port_combo.clear()
        self.serial_port_combo.addItems(ports)
        self.serial_port_combo.setCurrentText(current if current else ports[0])

    def update_telemetry(self, state: TelemetryState) -> None:
        if state.simulated:
            self.status_label.setText("SIM telemetry")
            self.status_label.setStyleSheet("color: #2563eb; font-weight: 600;")
        elif state.connected:
            self.status_label.setText("Heartbeat OK")
            self.status_label.setStyleSheet("color: #15803d; font-weight: 600;")
        elif state.link_open:
            self.status_label.setText("Link open, waiting heartbeat")
            self.status_label.setStyleSheet("color: #ca8a04; font-weight: 600;")
        else:
            self.status_label.setText("Disconnected")
            self.status_label.setStyleSheet("color: #b91c1c; font-weight: 600;")

        yaw = f"{math.degrees(state.yaw_rad):.1f} deg" if state.yaw_rad is not None else "-"
        alt = f"{state.relative_alt_m:.2f} m AGL" if state.relative_alt_m is not None else "-"
        airspeed = f"{state.airspeed_m_s:.2f} m/s" if state.airspeed_m_s is not None else "-"
        battery = "-"
        if state.battery_voltage_v is not None:
            battery = f"{state.battery_voltage_v:.2f} V"
            if state.battery_remaining_pct is not None:
                battery += f" / {state.battery_remaining_pct}%"
        pos = "-"
        if state.lat is not None and state.lon is not None:
            pos = f"{state.lat:.7f}, {state.lon:.7f}"
        self.summary_label.setText(
            f"Mode: {state.mode or '-'} | Armed: {self._format_bool(state.armed)}\n"
            f"Airspeed: {airspeed} | Alt: {alt} | Yaw: {yaw}\n"
            f"Battery: {battery}\n"
            f"Pos: {pos}"
        )

        now = time.monotonic()
        if now - self._last_table_update_s >= 0.2 or state.simulated:
            self._last_table_update_s = now
            self._update_table(state)

    def _emit_connect(self) -> None:
        conn_type = self.type_combo.currentText()
        config: Dict[str, Any] = {
            "type": conn_type,
            "baud": int(self.baud_combo.currentText()),
            "send_statustext": True,
            "heartbeat_timeout_s": 0,
        }
        if conn_type == "serial":
            config["enabled"] = True
            config["connection_string"] = self.serial_port_combo.currentText()
        elif conn_type == "udp":
            config["enabled"] = True
            config["connection_string"] = self.udp_edit.text().strip()
        else:
            config["enabled"] = False
            config["simulation"] = True
            config["connection_string"] = "simulated"
        self.connect_requested.emit(config)

    def _update_enabled_fields(self) -> None:
        conn_type = self.type_combo.currentText()
        serial_enabled = conn_type == "serial"
        udp_enabled = conn_type == "udp"
        self.serial_port_combo.setEnabled(serial_enabled)
        self.baud_combo.setEnabled(serial_enabled)
        self.udp_edit.setEnabled(udp_enabled)

    def _update_table(self, state: TelemetryState) -> None:
        rows = self._telemetry_rows(state)
        self.telemetry_table.setRowCount(len(rows))
        for row_index, (name, value) in enumerate(rows):
            self.telemetry_table.setItem(row_index, 0, QtWidgets.QTableWidgetItem(str(name)))
            self.telemetry_table.setItem(row_index, 1, QtWidgets.QTableWidgetItem(self._format_value(value, name)))

    def _telemetry_rows(self, state: TelemetryState):
        rows = [
            ("link.connected", state.connected),
            ("link.open", state.link_open),
            ("link.connection", state.connection_string),
            ("link.baud", state.baud),
            ("link.last_message_age_s", state.last_message_age_s),
            ("link.last_heartbeat_age_s", state.last_heartbeat_age_s),
            ("vehicle.mode", state.mode),
            ("vehicle.armed", state.armed),
            ("vehicle.system_status", state.system_status),
            ("vehicle.mav_type", state.mav_type),
            ("vehicle.autopilot", state.autopilot),
            ("attitude.roll_deg", self._deg(state.roll_rad)),
            ("attitude.pitch_deg", self._deg(state.pitch_rad)),
            ("attitude.yaw_deg", self._deg(state.yaw_rad)),
            ("attitude.rollspeed_rad_s", state.rollspeed_rad_s),
            ("attitude.pitchspeed_rad_s", state.pitchspeed_rad_s),
            ("attitude.yawspeed_rad_s", state.yawspeed_rad_s),
            ("position.lat", state.lat),
            ("position.lon", state.lon),
            ("position.alt_m", state.alt_m),
            ("position.relative_alt_m", state.relative_alt_m),
            ("position.local_north_m", state.local_north_m),
            ("position.local_east_m", state.local_east_m),
            ("position.local_down_m", state.local_down_m),
            ("velocity.local_vx_m_s", state.local_vx_m_s),
            ("velocity.local_vy_m_s", state.local_vy_m_s),
            ("velocity.local_vz_m_s", state.local_vz_m_s),
            ("velocity.global_vx_m_s", state.vx_m_s),
            ("velocity.global_vy_m_s", state.vy_m_s),
            ("velocity.global_vz_m_s", state.vz_m_s),
            ("flight.airspeed_m_s", state.airspeed_m_s),
            ("flight.groundspeed_m_s", state.groundspeed_m_s),
            ("flight.heading_deg", state.heading_deg),
            ("flight.climb_m_s", state.climb_m_s),
            ("flight.throttle_pct", state.throttle_pct),
            ("battery.voltage_v", state.battery_voltage_v),
            ("battery.current_a", state.battery_current_a),
            ("battery.remaining_pct", state.battery_remaining_pct),
            ("battery.temperature_c", state.battery_temperature_c),
            ("gps.fix_type", state.gps_fix_type),
            ("gps.satellites_visible", state.satellites_visible),
            ("gps.hdop", state.gps_hdop),
            ("gps.vdop", state.gps_vdop),
            ("gps.ground_speed_m_s", state.gps_ground_speed_m_s),
            ("gps.cog_deg", state.gps_cog_deg),
            ("sensors.pressure_abs_hpa", state.pressure_abs_hpa),
            ("sensors.pressure_diff_hpa", state.pressure_diff_hpa),
            ("sensors.temperature_c", state.temperature_c),
            ("radio.rc_rssi", state.rc_rssi),
            ("estimator.ekf_flags", state.ekf_flags),
        ]

        message_counts = state.message_counts or {}
        if message_counts:
            rows.append(("messages.seen", ", ".join(sorted(message_counts.keys()))))
            for msg_type in sorted(message_counts):
                rows.append((f"messages.{msg_type}.count", message_counts[msg_type]))

        raw_messages = state.messages or {}
        for msg_type in sorted(raw_messages):
            payload = raw_messages[msg_type] or {}
            for key in sorted(payload):
                rows.append((f"RAW.{msg_type}.{key}", payload[key]))

        return rows[:500]

    def _format_value(self, value: Any, name: str = "") -> str:
        if value is None:
            return "-"
        if isinstance(value, bool):
            return self._format_bool(value)
        if isinstance(value, float):
            if math.isnan(value) or math.isinf(value):
                return "-"
            if name.endswith(".lat") or name.endswith(".lon"):
                return f"{value:.7f}"
            return f"{value:.3f}"
        if isinstance(value, (list, tuple)):
            if len(value) > 16:
                return ", ".join(self._format_value(item) for item in value[:16]) + ", ..."
            return ", ".join(self._format_value(item) for item in value)
        if isinstance(value, dict):
            parts = [f"{key}={self._format_value(item)}" for key, item in list(value.items())[:12]]
            if len(value) > 12:
                parts.append("...")
            return ", ".join(parts)
        return str(value)

    def _format_bool(self, value: Optional[bool]) -> str:
        if value is None:
            return "-"
        return "yes" if value else "no"

    def _deg(self, rad: Optional[float]) -> Optional[float]:
        return None if rad is None else math.degrees(rad)
