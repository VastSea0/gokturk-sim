from __future__ import annotations

import glob
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

        self.udp_edit = QtWidgets.QLineEdit("udp:127.0.0.1:14550")
        self.status_label = QtWidgets.QLabel("Disconnected")
        self.status_label.setStyleSheet("color: #b91c1c; font-weight: 600;")
        self.telemetry_label = QtWidgets.QLabel("Telemetry: -")
        self.telemetry_label.setWordWrap(True)

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
        form.addRow("Telemetry", self.telemetry_label)

        button_row = QtWidgets.QHBoxLayout()
        button_row.setSpacing(10)
        button_row.addWidget(self.connect_button)
        button_row.addWidget(self.disconnect_button)
        button_row.addWidget(self.refresh_button)

        layout = QtWidgets.QVBoxLayout(self)
        layout.setContentsMargins(16, 24, 16, 16)
        layout.setSpacing(16)
        layout.addLayout(form)
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
            self.status_label.setText("Connected/open")
            self.status_label.setStyleSheet("color: #15803d; font-weight: 600;")
        else:
            self.status_label.setText("Disconnected")
            self.status_label.setStyleSheet("color: #b91c1c; font-weight: 600;")

        yaw = f"{state.yaw_rad:.3f} rad" if state.yaw_rad is not None else "-"
        alt = f"{state.relative_alt_m:.2f} m AGL" if state.relative_alt_m is not None else "-"
        pos = "-"
        if state.lat is not None and state.lon is not None:
            pos = f"{state.lat:.7f}, {state.lon:.7f}"
        self.telemetry_label.setText(f"Yaw: {yaw}\nAlt: {alt}\nPos: {pos}")

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

