from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any, Dict, Optional

import cv2

from camera.pi_camera import PiCameraSource
from camera.video_file_camera import VideoFileCamera
from camera.webcam_camera import WebcamCamera
from communication.mavlink_bridge import MavlinkBridge
from communication.target_reporter import TargetReporter
from communication.telemetry_state import TelemetryState
from detection.adaptive_color_detector import AdaptiveColorMarkerDetector
from detection.hybrid_marker_detector import HybridMarkerDetector
from detection.hsv_marker_detector import HSVMarkerDetector
from detection.postprocess import DetectionPostProcessor
from detection.yolo_marker_detector import YOLOMarkerDetector
from main import frame_result, maybe_resize
from tracking.centroid_tracker import CentroidTracker
from utils.config_loader import get_nested
from utils.draw_debug import draw_detections
from utils.fps import FPSCounter

from .connection_panel import ConnectionPanel
from .detection_panel import DetectionPanel
from .qt_compat import QtCore, QtWidgets
from .settings_panel import SettingsPanel
from .video_widget import VideoWidget


class MainWindow(QtWidgets.QMainWindow):
    """Operator GUI for live camera preview, marker detection, and safe reporting."""

    def __init__(self, config: Dict[str, Any], config_path: Path, project_dir: Path) -> None:
        super().__init__()
        self.config = copy.deepcopy(config)
        self.config_path = config_path
        self.project_dir = project_dir

        self.setWindowTitle("UAV Marker Detection")
        self.resize(1320, 780)

        self.video_widget = VideoWidget()
        self.settings_panel = SettingsPanel(self.config, self.project_dir)
        self.connection_panel = ConnectionPanel()
        self.detection_panel = DetectionPanel()
        self.runtime_label = QtWidgets.QLabel("FPS: - | Model: - | Camera: stopped | Telemetry: disconnected")
        self.runtime_label.setStyleSheet("font-weight: 600;")

        side_widget = QtWidgets.QWidget()
        side_layout = QtWidgets.QVBoxLayout(side_widget)
        side_layout.addWidget(self.runtime_label)
        side_layout.addWidget(self.settings_panel)
        side_layout.addWidget(self.connection_panel)
        side_layout.addWidget(self.detection_panel, 1)

        scroll = QtWidgets.QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(side_widget)
        scroll.setMinimumWidth(470)

        splitter = QtWidgets.QSplitter()
        splitter.addWidget(self.video_widget)
        splitter.addWidget(scroll)
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 1)
        self.setCentralWidget(splitter)

        self.timer = QtCore.QTimer(self)
        self.timer.timeout.connect(self.process_frame)
        self.timer.setInterval(int(get_nested(self.config, "gui.update_interval_ms", 33)))
        self.telemetry_timer = QtCore.QTimer(self)
        self.telemetry_timer.timeout.connect(self.refresh_telemetry_panel)
        self.telemetry_timer.setInterval(200)

        self.source: Optional[Any] = None
        self.detector: Optional[Any] = None
        self.postprocessor: Optional[DetectionPostProcessor] = None
        self.tracker: Optional[CentroidTracker] = None
        self.reporter: Optional[TargetReporter] = None
        self.mavlink_bridge = MavlinkBridge(get_nested(self.config, "communication.mavlink", {}))
        self.simulated_telemetry = False
        self.frame_id = 0
        self.fps_counter = FPSCounter()
        self.last_fps = 0.0
        self.last_telemetry_state = TelemetryState()
        self.last_runtime_settings: Dict[str, Any] = {}

        self.settings_panel.start_requested.connect(self.start_processing)
        self.settings_panel.stop_requested.connect(self.stop_processing)
        self.connection_panel.connect_requested.connect(self.connect_mavlink)
        self.connection_panel.disconnect_requested.connect(self.disconnect_mavlink)

        self.statusBar().showMessage("Ready")
        self.connection_panel.update_telemetry(TelemetryState())
        self.telemetry_timer.start()

    def start_processing(self, settings: Dict[str, Any]) -> None:
        self.stop_processing()
        self.last_runtime_settings = settings
        try:
            self.detector = self._build_detector(settings)
            self.postprocessor = self._build_postprocessor(settings)
            self.tracker = self._build_tracker()
            self.source = self._build_source(settings)
            self.source.start()
            self.reporter = self._build_reporter(settings)
            self.reporter.start()
        except Exception as exc:
            self._show_error("Could not start processing", exc)
            self.stop_processing()
            return

        self.frame_id = 0
        self.fps_counter = FPSCounter()
        self.timer.start()
        self.statusBar().showMessage(f"Running: {settings.get('mode')} / {settings.get('source')}")
        self._update_runtime_label(0.0, "starting", TelemetryState())

    def stop_processing(self) -> None:
        self.timer.stop()
        if self.source is not None:
            try:
                self.source.release()
            except Exception:
                pass
        if self.reporter is not None:
            self.reporter.close()
        self.source = None
        self.detector = None
        self.postprocessor = None
        self.tracker = None
        self.reporter = None
        self.video_widget.clear_frame()
        self.detection_panel.reset()
        self.statusBar().showMessage("Stopped")
        self._update_runtime_label(0.0, "stopped", TelemetryState())

    def process_frame(self) -> None:
        if self.source is None or self.detector is None:
            return

        frame = self.source.read()
        if frame is None:
            self.statusBar().showMessage("Input stream ended")
            self.stop_processing()
            return

        self.frame_id += 1
        resize_width = int(get_nested(self.config, "processing.resize_width", 0) or 0)
        frame = maybe_resize(frame, resize_width)
 
        # Invert colors (swap Red and Blue channels) if requested by the user
        if self.last_runtime_settings.get("invert_colors", False):
            frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
 
        detections = self.detector.detect(frame)
        if self.postprocessor is not None:
            detections = self.postprocessor.apply(detections)
        if self.tracker is not None:
            detections = self.tracker.update(detections, self.frame_id)
 
        # Swap Red (enemy) and Blue (ally) labels if requested by the user
        if self.last_runtime_settings.get("swap_labels", False):
            for d in detections:
                if d.class_name == "red_marker":
                    d.class_name = "blue_marker"
                elif d.class_name == "blue_marker":
                    d.class_name = "red_marker"

        telemetry_state = self._current_telemetry_state()
        result = frame_result(
            self.frame_id,
            detections,
            frame.shape,
            get_nested(self.config, "geometry", {}),
            telemetry_state.as_telemetry_dict(),
        )
        self.detection_panel.update_result(result)
        self.last_telemetry_state = telemetry_state
        self.connection_panel.update_telemetry(telemetry_state)

        if self.reporter is not None:
            self.reporter.report(result)

        fps = self.fps_counter.update()
        self.last_fps = fps
        display_frame = frame
        debug_view = self.last_runtime_settings.get("debug_view", "overlay")
        if debug_view != "overlay" and hasattr(self.detector, "debug_view"):
            display_frame = self.detector.debug_view(frame, debug_view)
        if self.last_runtime_settings.get("draw", True):
            display_frame = draw_detections(frame, detections, fps=fps)
        self.video_widget.set_frame(display_frame)
        self._update_runtime_label(fps, "running", telemetry_state)

    def connect_mavlink(self, mav_config: Dict[str, Any]) -> None:
        if mav_config.get("simulation"):
            self.mavlink_bridge.disconnect()
            self.simulated_telemetry = True
            self.connection_panel.update_telemetry(TelemetryState.simulated_state(self.frame_id))
            self.last_telemetry_state = TelemetryState.simulated_state(self.frame_id)
            self.statusBar().showMessage("Simulated telemetry enabled")
            return

        self.simulated_telemetry = False
        config = copy.deepcopy(get_nested(self.config, "communication.mavlink", {}))
        config.update(mav_config)
        config["enabled"] = True
        self.mavlink_bridge.configure(config)
        self.mavlink_bridge.connect()
        telemetry = self.mavlink_bridge.poll_telemetry()
        state = TelemetryState.from_bridge(telemetry, self.mavlink_bridge.status())
        self.last_telemetry_state = state
        self.connection_panel.update_telemetry(state)
        self.statusBar().showMessage(state.status_line())

    def disconnect_mavlink(self) -> None:
        self.simulated_telemetry = False
        self.mavlink_bridge.disconnect()
        self.last_telemetry_state = TelemetryState()
        self.connection_panel.update_telemetry(self.last_telemetry_state)
        self.statusBar().showMessage("MAVLink disconnected")

    def closeEvent(self, event) -> None:
        self.stop_processing()
        self.mavlink_bridge.close()
        super().closeEvent(event)

    def _build_detector(self, settings: Dict[str, Any]):
        detector_name = settings.get("detector", "hsv")
        if detector_name == "color":
            return AdaptiveColorMarkerDetector(get_nested(self.config, "detection.color", {}))
        if detector_name == "hsv":
            return HSVMarkerDetector(get_nested(self.config, "detection.hsv", {}))
        weights = settings.get("weights")
        if detector_name == "hybrid":
            hybrid_config = get_nested(self.config, "detection.hybrid", {})
            if not weights:
                weights = hybrid_config.get("weights_path") or get_nested(self.config, "detection.yolo.weights_path", None)
            if not weights:
                raise ValueError("YOLO weights path is required for hybrid detector")
            return HybridMarkerDetector(weights, hybrid_config)
        yolo_config = get_nested(self.config, "detection.yolo_seg" if detector_name == "yolo_seg" else "detection.yolo", {})
        if not weights:
            weights = yolo_config.get("weights_path")
        if not weights:
            raise ValueError("YOLO weights path is required")
        return YOLOMarkerDetector(weights, yolo_config)

    def _build_source(self, settings: Dict[str, Any]):
        source_name = settings.get("source", "pi")
        if source_name == "video":
            video_path = settings.get("video")
            if not video_path:
                raise ValueError("Video path is required for video mode")
            return VideoFileCamera(video_path, loop=True)
        if source_name == "webcam":
            camera_cfg = get_nested(self.config, "camera", {})
            return WebcamCamera(
                camera_index=0,
                width=int(camera_cfg.get("width", 640)),
                height=int(camera_cfg.get("height", 480)),
                fps=int(camera_cfg.get("fps", 20)),
            )
        return PiCameraSource(get_nested(self.config, "camera", {}))

    def _build_tracker(self) -> CentroidTracker:
        tracking_cfg = get_nested(self.config, "tracking", {})
        return CentroidTracker(
            max_distance_px=float(tracking_cfg.get("max_distance_px", 90.0)),
            max_missed=int(tracking_cfg.get("max_missed", 6)),
            smoothing_alpha=float(tracking_cfg.get("smoothing_alpha", 0.45)),
            stale_confidence_decay=float(tracking_cfg.get("stale_confidence_decay", 0.65)),
        )

    def _build_postprocessor(self, settings: Dict[str, Any]) -> DetectionPostProcessor:
        post_cfg = copy.deepcopy(get_nested(self.config, "postprocess", {}))
        runtime_cfg = settings.get("postprocess", {}) or {}
        for section_name in ("square_filter", "nms"):
            section = post_cfg.setdefault(section_name, {})
            section.update(runtime_cfg.get(section_name, {}) or {})
        return DetectionPostProcessor(post_cfg)

    def _build_reporter(self, settings: Dict[str, Any]) -> TargetReporter:
        use_mavlink = settings.get("mode") == "camera_mavlink"
        return TargetReporter(
            json_config=settings.get("json", {}),
            udp_config=settings.get("udp", {}),
            mavlink_bridge=self.mavlink_bridge if use_mavlink else None,
        )

    def _current_telemetry_state(self) -> TelemetryState:
        if self.simulated_telemetry:
            return TelemetryState.simulated_state(self.frame_id)
        telemetry = self.mavlink_bridge.poll_telemetry()
        return TelemetryState.from_bridge(telemetry, self.mavlink_bridge.status())

    def refresh_telemetry_panel(self) -> None:
        if not self.simulated_telemetry and not self.mavlink_bridge.is_link_open():
            return
        telemetry_state = self._current_telemetry_state()
        self.last_telemetry_state = telemetry_state
        self.connection_panel.update_telemetry(telemetry_state)
        camera_state = "running" if self.timer.isActive() else "stopped"
        self._update_runtime_label(self.last_fps, camera_state, telemetry_state)

    def _show_error(self, title: str, exc: Exception) -> None:
        details = str(exc)
        QtWidgets.QMessageBox.critical(self, title, details)
        self.statusBar().showMessage(f"{title}: {details}")

    def _update_runtime_label(self, fps: float, camera_state: str, telemetry_state: TelemetryState) -> None:
        detector_name = self.last_runtime_settings.get("detector", "-")
        if telemetry_state.simulated:
            telemetry_text = "sim"
        elif telemetry_state.connected:
            telemetry_text = "heartbeat"
        elif telemetry_state.link_open:
            telemetry_text = "link open"
        else:
            telemetry_text = "disconnected"
        self.runtime_label.setText(
            f"FPS: {fps:.1f} | Model: {detector_name} | Camera: {camera_state} | Telemetry: {telemetry_text}"
        )
