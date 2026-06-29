from __future__ import annotations

import datetime as dt
from typing import Any, Dict, List, Optional

from .qt_compat import QtWidgets


class DetectionPanel(QtWidgets.QWidget):
    """Live table of current frame marker detections."""

    HEADERS = ["Class", "Conf", "Shape", "BBox", "Center", "Relative m", "Local NED", "Global", "Time"]

    def __init__(self, parent: Optional[QtWidgets.QWidget] = None) -> None:
        super().__init__(parent)
        self.summary_label = QtWidgets.QLabel("No detections")
        self.summary_label.setStyleSheet("font-weight: 600;")

        self.table = QtWidgets.QTableWidget(0, len(self.HEADERS))
        self.table.setHorizontalHeaderLabels(self.HEADERS)
        self.table.verticalHeader().setVisible(False)
        self.table.setAlternatingRowColors(True)
        self.table.setEditTriggers(QtWidgets.QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setSelectionBehavior(QtWidgets.QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setWordWrap(False)
        self.table.horizontalHeader().setStretchLastSection(True)
        self.table.horizontalHeader().setSectionResizeMode(QtWidgets.QHeaderView.ResizeMode.ResizeToContents)

        layout = QtWidgets.QVBoxLayout(self)
        layout.setContentsMargins(8, 16, 8, 8)
        layout.setSpacing(12)
        layout.addWidget(self.summary_label)
        layout.addWidget(self.table)

    def update_result(self, result: Dict[str, Any]) -> None:
        detections: List[Dict[str, Any]] = result.get("detections", [])
        timestamp = float(result.get("timestamp", 0.0) or 0.0)
        time_text = dt.datetime.fromtimestamp(timestamp).strftime("%H:%M:%S.%f")[:-3] if timestamp else "-"
        self.summary_label.setText(f"Frame {result.get('frame_id', '-')}: {len(detections)} marker(s)")
        self.table.setRowCount(len(detections))

        for row, detection in enumerate(detections):
            relative = detection.get("relative_position_m") or {}
            local = detection.get("local_position_ned_m") or {}
            global_pos = detection.get("global_position") or {}
            values = [
                detection.get("class", "-"),
                f"{float(detection.get('confidence', 0.0)):.2f}",
                self._shape_text(detection.get("shape")),
                self._list_text(detection.get("bbox_xyxy")),
                self._list_text(detection.get("center_px")),
                self._relative_text(relative),
                self._local_text(local),
                self._global_text(global_pos),
                time_text,
            ]
            for col, value in enumerate(values):
                self.table.setItem(row, col, QtWidgets.QTableWidgetItem(value))

    def reset(self) -> None:
        self.summary_label.setText("No detections")
        self.table.setRowCount(0)

    def _list_text(self, value: Any) -> str:
        if not isinstance(value, list):
            return "-"
        return ", ".join(str(v) for v in value)

    def _shape_text(self, value: Any) -> str:
        if not isinstance(value, dict):
            return "-"
        name = value.get("name", "shape")
        score = value.get("score")
        if score is None:
            return str(name)
        return f"{name} {float(score):.2f}"

    def _relative_text(self, value: Dict[str, Any]) -> str:
        if not value:
            return "-"
        return "x={x_forward} y={y_right} z={z_down}".format(
            x_forward=value.get("x_forward"),
            y_right=value.get("y_right"),
            z_down=value.get("z_down"),
        )

    def _local_text(self, value: Dict[str, Any]) -> str:
        if not value:
            return "-"
        return "N={north} E={east} D={down}".format(
            north=value.get("north"),
            east=value.get("east"),
            down=value.get("down"),
        )

    def _global_text(self, value: Dict[str, Any]) -> str:
        if not value or value.get("lat") is None:
            return "-"
        return "lat={lat} lon={lon} alt={alt}".format(
            lat=value.get("lat"),
            lon=value.get("lon"),
            alt=value.get("alt"),
        )
