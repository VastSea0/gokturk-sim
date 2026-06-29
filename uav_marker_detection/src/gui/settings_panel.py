from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Optional

from .qt_compat import Signal, QtWidgets


class SettingsPanel(QtWidgets.QGroupBox):
    """Runtime camera/detector/output controls."""

    start_requested = Signal(dict)
    stop_requested = Signal()

    MODES = {
        "Camera + processing": "camera_processing",
        "Camera + JSON log": "camera_json",
        "Camera + UDP output": "camera_udp",
        "Camera + Pixhawk/MAVLink": "camera_mavlink",
        "Simulation/video test": "video_test",
    }

    def __init__(self, config: Dict[str, Any], project_dir: Path, parent: Optional[QtWidgets.QWidget] = None) -> None:
        super().__init__("Run settings", parent)
        self.config = config
        self.project_dir = project_dir

        self.mode_combo = QtWidgets.QComboBox()
        self.mode_combo.addItems(list(self.MODES.keys()))

        self.source_combo = QtWidgets.QComboBox()
        self.source_combo.addItems(["pi", "webcam", "video"])

        self.video_edit = QtWidgets.QLineEdit(str(project_dir / "sample_data" / "test.mp4"))
        self.video_browse_button = QtWidgets.QPushButton("Browse")

        self.detector_combo = QtWidgets.QComboBox()
        self.detector_combo.addItems(["hybrid", "color", "hsv", "yolo", "yolo_seg"])
        yolo_cfg = config.get("detection", {}).get("yolo", {})
        self.weights_edit = QtWidgets.QLineEdit(str(project_dir / yolo_cfg.get("weights_path", "models/best.pt")))
        self.weights_browse_button = QtWidgets.QPushButton("Browse")
        self.debug_view_combo = QtWidgets.QComboBox()
        self.debug_view_combo.addItems(["overlay", "mask_overlay", "mask_red", "mask_blue", "mask_combined"])

        json_cfg = config.get("communication", {}).get("json", {})
        udp_cfg = config.get("communication", {}).get("udp", {})
        self.json_check = QtWidgets.QCheckBox("JSON log")
        self.json_check.setChecked(False)
        self.json_path_edit = QtWidgets.QLineEdit(str(project_dir / json_cfg.get("path", "logs/marker_detections.jsonl")))

        self.udp_check = QtWidgets.QCheckBox("UDP JSON")
        self.udp_check.setChecked(bool(udp_cfg.get("enabled", False)))
        self.udp_host_edit = QtWidgets.QLineEdit(str(udp_cfg.get("host", "127.0.0.1")))
        self.udp_port_spin = QtWidgets.QSpinBox()
        self.udp_port_spin.setRange(1, 65535)
        self.udp_port_spin.setValue(int(udp_cfg.get("port", 15000)))

        self.draw_check = QtWidgets.QCheckBox("Draw overlay")
        self.draw_check.setChecked(True)

        post_cfg = config.get("postprocess", {})
        square_cfg = post_cfg.get("square_filter", {})
        nms_cfg = post_cfg.get("nms", {})
        self.shape_filter_check = QtWidgets.QCheckBox("2x2 square shape filter")
        self.shape_filter_check.setChecked(bool(square_cfg.get("enabled", False)))
        self.nms_check = QtWidgets.QCheckBox("NMS")
        self.nms_check.setChecked(bool(nms_cfg.get("enabled", False)))
 
        self.invert_colors_check = QtWidgets.QCheckBox("Invert colors (Red/Blue swap)")
        self.invert_colors_check.setChecked(False)
 
        self.swap_labels_check = QtWidgets.QCheckBox("Swap Red/Blue labels")
        self.swap_labels_check.setChecked(False)

        self.start_button = QtWidgets.QPushButton("Start")
        self.start_button.setObjectName("start_button")
        self.stop_button = QtWidgets.QPushButton("Stop")
        self.stop_button.setObjectName("stop_button")

        form = QtWidgets.QFormLayout()
        form.setSpacing(10)
        form.addRow("Mode", self.mode_combo)
        form.addRow("Source", self.source_combo)
        form.addRow("Video", self._row(self.video_edit, self.video_browse_button))
        form.addRow("Detector", self.detector_combo)
        form.addRow("YOLO weights", self._row(self.weights_edit, self.weights_browse_button))
        form.addRow("Debug view", self.debug_view_combo)
        form.addRow("", self.json_check)
        form.addRow("JSON path", self.json_path_edit)
        form.addRow("", self.udp_check)
        form.addRow("UDP host", self.udp_host_edit)
        form.addRow("UDP port", self.udp_port_spin)
        form.addRow("", self.draw_check)
        form.addRow("", self.shape_filter_check)
        form.addRow("", self.nms_check)
        form.addRow("", self.invert_colors_check)
        form.addRow("", self.swap_labels_check)
 
        buttons = QtWidgets.QHBoxLayout()
        buttons.setSpacing(10)
        buttons.addWidget(self.start_button)
        buttons.addWidget(self.stop_button)

        layout = QtWidgets.QVBoxLayout(self)
        layout.setContentsMargins(16, 24, 16, 16)
        layout.setSpacing(16)
        layout.addLayout(form)
        layout.addLayout(buttons)

        self.mode_combo.currentTextChanged.connect(self._mode_changed)
        self.video_browse_button.clicked.connect(self._browse_video)
        self.weights_browse_button.clicked.connect(self._browse_weights)
        self.start_button.clicked.connect(self._emit_start)
        self.stop_button.clicked.connect(self.stop_requested.emit)
        self.detector_combo.currentTextChanged.connect(self._detector_changed)
        self._mode_changed(self.mode_combo.currentText())
        self._detector_changed(self.detector_combo.currentText())

    def runtime_settings(self) -> Dict[str, Any]:
        mode = self.MODES[self.mode_combo.currentText()]
        source = self.source_combo.currentText()
        if mode == "video_test":
            source = "video"

        return {
            "mode": mode,
            "source": source,
            "video": self.video_edit.text().strip(),
            "detector": self.detector_combo.currentText(),
            "weights": self.weights_edit.text().strip(),
            "json": {
                "enabled": self.json_check.isChecked() or mode == "camera_json",
                "path": self.json_path_edit.text().strip(),
            },
            "udp": {
                "enabled": self.udp_check.isChecked() or mode == "camera_udp",
                "host": self.udp_host_edit.text().strip(),
                "port": self.udp_port_spin.value(),
                "broadcast": False,
            },
            "draw": self.draw_check.isChecked(),
            "debug_view": self.debug_view_combo.currentText(),
            "postprocess": {
                "square_filter": {"enabled": self.shape_filter_check.isChecked()},
                "nms": {"enabled": self.nms_check.isChecked()},
            },
            "invert_colors": self.invert_colors_check.isChecked(),
            "swap_labels": self.swap_labels_check.isChecked(),
        }

    def _emit_start(self) -> None:
        self.start_requested.emit(self.runtime_settings())

    def _mode_changed(self, text: str) -> None:
        mode = self.MODES[text]
        if mode == "camera_processing":
            self.json_check.setChecked(False)
            self.udp_check.setChecked(False)
        if mode == "video_test":
            self.source_combo.setCurrentText("video")
            self.json_check.setChecked(False)
            self.udp_check.setChecked(False)
        if mode == "camera_json":
            self.json_check.setChecked(True)
            self.udp_check.setChecked(False)
        if mode == "camera_udp":
            self.json_check.setChecked(False)
            self.udp_check.setChecked(True)
        if mode == "camera_mavlink":
            self.json_check.setChecked(False)
            self.udp_check.setChecked(False)

    def _detector_changed(self, text: str) -> None:
        yolo_enabled = text in {"hybrid", "yolo", "yolo_seg"}
        self.weights_edit.setEnabled(yolo_enabled)
        self.weights_browse_button.setEnabled(yolo_enabled)

    def _browse_video(self) -> None:
        path, _ = QtWidgets.QFileDialog.getOpenFileName(
            self,
            "Select video file",
            str(self.project_dir / "sample_data"),
            "Video files (*.mp4 *.avi *.mov *.mkv);;All files (*)",
        )
        if path:
            self.video_edit.setText(path)

    def _browse_weights(self) -> None:
        path, _ = QtWidgets.QFileDialog.getOpenFileName(
            self,
            "Select YOLO weights",
            str(self.project_dir),
            "Model weights (*.pt);;All files (*)",
        )
        if path:
            self.weights_edit.setText(path)

    def _row(self, first: QtWidgets.QWidget, second: QtWidgets.QWidget) -> QtWidgets.QWidget:
        widget = QtWidgets.QWidget()
        layout = QtWidgets.QHBoxLayout(widget)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(first)
        layout.addWidget(second)
        return widget
