from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import cv2

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from camera.pi_camera import PiCameraSource
from camera.video_file_camera import VideoFileCamera
from camera.webcam_camera import WebcamCamera
from communication.json_logger import JSONLogger
from communication.mavlink_bridge import MavlinkBridge
from communication.udp_bridge import UDPJsonBridge
from detection.adaptive_color_detector import AdaptiveColorMarkerDetector
from detection.hybrid_marker_detector import HybridMarkerDetector
from detection.hsv_marker_detector import HSVMarkerDetector
from detection.yolo_marker_detector import YOLOMarkerDetector
from geometry.coordinate_transform import CameraGeometry, estimate_positions
from tracking.centroid_tracker import CentroidTracker
from utils.config_loader import get_nested, load_config
from utils.draw_debug import draw_detections
from utils.fps import FPSCounter


LOGGER = logging.getLogger("uav_marker_detection")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="UAV red/blue ground marker detection for Raspberry Pi 5")
    parser.add_argument("--config", default="config/default.yaml", help="YAML config path")
    parser.add_argument("--detector", choices=["color", "hsv", "yolo", "yolo_seg", "hybrid"], default="color", help="Detector backend")
    parser.add_argument("--source", choices=["pi", "video", "webcam"], default="pi", help="Input source")
    parser.add_argument("--video", help="Video path when --source video is used")
    parser.add_argument("--camera-index", type=int, default=0, help="OpenCV webcam index when --source webcam is used")
    parser.add_argument("--loop-video", action="store_true", help="Loop video input")
    parser.add_argument("--weights", help="YOLO weights path when --detector yolo is used")
    parser.add_argument("--mavlink", help="Override MAVLink connection string and enable bridge")
    parser.add_argument("--mavlink-baud", type=int, help="Override MAVLink serial baudrate")
    parser.add_argument("--json-log", help="Override JSONL log path")
    parser.add_argument("--no-json-log", action="store_true", help="Disable JSONL logging")
    parser.add_argument("--udp-host", help="Enable UDP JSON output and set host")
    parser.add_argument("--udp-port", type=int, help="Enable UDP JSON output and set port")
    parser.add_argument("--show", action="store_true", help="Show OpenCV debug window")
    parser.add_argument("--draw-debug", action="store_true", help="Draw boxes on debug output")
    parser.add_argument("--debug-view", choices=["overlay", "mask_overlay", "mask_red", "mask_blue", "mask_combined"], default="overlay")
    parser.add_argument("--no-tracking", action="store_true", help="Disable temporal smoothing/tracking")
    parser.add_argument("--print-empty", action="store_true", help="Print frames even when no marker is detected")
    parser.add_argument("--max-frames", type=int, help="Stop after N frames, useful for tests")
    parser.add_argument("--log-level", default="INFO", choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    return parser.parse_args()


def build_detector(args: argparse.Namespace, config: Dict[str, Any]):
    if args.detector == "color":
        return AdaptiveColorMarkerDetector(get_nested(config, "detection.color", {}))
    if args.detector == "hsv":
        return HSVMarkerDetector(get_nested(config, "detection.hsv", {}))
    weights = args.weights
    if args.detector == "hybrid":
        yolo_config = get_nested(config, "detection.hybrid", {})
        if not weights:
            weights = yolo_config.get("weights_path") or get_nested(config, "detection.yolo.weights_path", None)
        if not weights:
            raise ValueError("--weights or detection.hybrid.weights_path is required when --detector hybrid is selected")
        return HybridMarkerDetector(weights, yolo_config)
    yolo_config = get_nested(config, "detection.yolo_seg" if args.detector == "yolo_seg" else "detection.yolo", {})
    if not weights:
        weights = yolo_config.get("weights_path")
    if not weights:
        raise ValueError("--weights or detection.*.weights_path is required when --detector yolo or yolo_seg is selected")
    return YOLOMarkerDetector(weights, yolo_config)


def build_source(args: argparse.Namespace, config: Dict[str, Any]):
    if args.source == "video":
        if not args.video:
            raise ValueError("--video is required when --source video is selected")
        return VideoFileCamera(args.video, loop=args.loop_video)
    if args.source == "webcam":
        camera_cfg = get_nested(config, "camera", {})
        return WebcamCamera(
            camera_index=args.camera_index,
            width=int(camera_cfg.get("width", 640)),
            height=int(camera_cfg.get("height", 480)),
            fps=int(camera_cfg.get("fps", 20)),
        )
    return PiCameraSource(get_nested(config, "camera", {}))


def maybe_resize(frame, resize_width: int):
    if not resize_width or resize_width <= 0 or frame.shape[1] == resize_width:
        return frame
    scale = resize_width / float(frame.shape[1])
    resize_height = max(1, int(frame.shape[0] * scale))
    return cv2.resize(frame, (resize_width, resize_height), interpolation=cv2.INTER_AREA)


def frame_result(
    frame_id: int,
    detections,
    frame_shape,
    geometry_config: Dict[str, Any],
    telemetry: Dict[str, Any],
) -> Dict[str, Any]:
    camera = CameraGeometry.from_config(geometry_config.get("camera", {}))
    default_altitude = float(geometry_config.get("default_altitude_m", 20.0))
    altitude_m = telemetry.get("relative_alt_m") or default_altitude

    detection_payloads: List[Dict[str, Any]] = []
    for detection in detections:
        relative, local_position, global_position = estimate_positions(
            detection.center_px,
            frame_shape,
            float(altitude_m),
            camera,
            telemetry,
        )
        detection_payloads.append(
            detection.as_dict(
                relative_position_m=relative,
                local_position_ned_m=local_position,
                global_position=global_position,
            )
        )

    return {
        "timestamp": time.time(),
        "frame_id": frame_id,
        "detections": detection_payloads,
    }


def apply_cli_overrides(args: argparse.Namespace, config: Dict[str, Any]) -> Dict[str, Any]:
    communication = config.setdefault("communication", {})
    console_cfg = communication.setdefault("console", {})
    json_cfg = communication.setdefault("json", {})
    udp_cfg = communication.setdefault("udp", {})
    mav_cfg = communication.setdefault("mavlink", {})
    debug_cfg = config.setdefault("debug", {})
    tracking_cfg = config.setdefault("tracking", {})

    if args.print_empty:
        console_cfg["print_empty_frames"] = True
    if args.json_log:
        json_cfg["enabled"] = True
        json_cfg["path"] = args.json_log
    if args.no_json_log:
        json_cfg["enabled"] = False
    if args.udp_host:
        udp_cfg["enabled"] = True
        udp_cfg["host"] = args.udp_host
    if args.udp_port:
        udp_cfg["enabled"] = True
        udp_cfg["port"] = args.udp_port
    if args.mavlink:
        mav_cfg["enabled"] = True
        mav_cfg["connection_string"] = args.mavlink
    if args.mavlink_baud:
        mav_cfg["baud"] = args.mavlink_baud
    if args.show:
        debug_cfg["show_window"] = True
        debug_cfg["draw"] = True
    if args.draw_debug:
        debug_cfg["draw"] = True
    if args.debug_view:
        debug_cfg["view"] = args.debug_view
    if args.no_tracking:
        tracking_cfg["enabled"] = False
    return config


def main() -> int:
    args = parse_args()
    logging.basicConfig(level=getattr(logging, args.log_level), format="[%(levelname)s] %(message)s")

    config_path = Path(args.config)
    if not config_path.is_absolute():
        config_path = Path.cwd() / config_path
    config = apply_cli_overrides(args, load_config(config_path))

    detector = build_detector(args, config)
    source = build_source(args, config)

    json_cfg = get_nested(config, "communication.json", {})
    udp_cfg = get_nested(config, "communication.udp", {})
    mav_cfg = get_nested(config, "communication.mavlink", {})
    console_cfg = get_nested(config, "communication.console", {})
    debug_cfg = get_nested(config, "debug", {})
    processing_cfg = get_nested(config, "processing", {})
    geometry_cfg = get_nested(config, "geometry", {})
    tracking_cfg = get_nested(config, "tracking", {})

    json_logger = JSONLogger(json_cfg.get("path"), enabled=bool(json_cfg.get("enabled", False)))
    udp_bridge = UDPJsonBridge(
        udp_cfg.get("host", "127.0.0.1"),
        int(udp_cfg.get("port", 15000)),
        enabled=bool(udp_cfg.get("enabled", False)),
        broadcast=bool(udp_cfg.get("broadcast", False)),
    )
    mavlink_bridge = MavlinkBridge(mav_cfg)
    tracker = None
    if bool(tracking_cfg.get("enabled", True)):
        tracker = CentroidTracker(
            max_distance_px=float(tracking_cfg.get("max_distance_px", 90.0)),
            max_missed=int(tracking_cfg.get("max_missed", 6)),
            smoothing_alpha=float(tracking_cfg.get("smoothing_alpha", 0.45)),
            stale_confidence_decay=float(tracking_cfg.get("stale_confidence_decay", 0.65)),
        )

    frame_id = 0
    fps_counter = FPSCounter()
    max_fps = float(processing_cfg.get("max_fps", 0) or 0)
    min_frame_interval = 1.0 / max_fps if max_fps > 0 else 0.0
    last_frame_time = 0.0
    resize_width = int(processing_cfg.get("resize_width", 0) or 0)
    show_window = bool(debug_cfg.get("show_window", False))
    draw_debug = bool(debug_cfg.get("draw", False))
    debug_view = str(debug_cfg.get("view", "overlay"))
    print_empty = bool(console_cfg.get("print_empty_frames", False))
    save_debug_frames = bool(debug_cfg.get("save_debug_frames", False))
    debug_frame_interval = int(debug_cfg.get("debug_frame_interval", 30))
    debug_frame_dir = Path(debug_cfg.get("debug_frame_dir", "logs/debug_frames"))

    try:
        source.start()
        json_logger.start()
        mavlink_bridge.connect()
        if save_debug_frames:
            debug_frame_dir.mkdir(parents=True, exist_ok=True)

        LOGGER.info("Started marker detection: detector=%s source=%s", args.detector, args.source)

        while True:
            now = time.monotonic()
            if min_frame_interval > 0 and now - last_frame_time < min_frame_interval:
                time.sleep(min_frame_interval - (now - last_frame_time))
            last_frame_time = time.monotonic()

            frame = source.read()
            if frame is None:
                LOGGER.info("Input stream ended.")
                break
            frame_id += 1
            frame = maybe_resize(frame, resize_width)

            detections = detector.detect(frame)
            if tracker is not None:
                detections = tracker.update(detections, frame_id)
            telemetry = mavlink_bridge.poll_telemetry()
            result = frame_result(frame_id, detections, frame.shape, geometry_cfg, telemetry)

            if result["detections"] or print_empty:
                print(json.dumps(result, ensure_ascii=False), flush=True)
            json_logger.write(result)
            udp_bridge.send(result)
            mavlink_bridge.send_detection_summary(result)

            fps = fps_counter.update()
            debug_frame = frame
            if draw_debug and debug_view != "overlay" and hasattr(detector, "debug_view"):
                debug_frame = detector.debug_view(frame, debug_view)
            if draw_debug:
                debug_frame = draw_detections(frame, detections, fps=fps)
            if save_debug_frames and draw_debug and frame_id % max(1, debug_frame_interval) == 0:
                cv2.imwrite(str(debug_frame_dir / f"frame_{frame_id:06d}.jpg"), debug_frame)
            if show_window:
                cv2.imshow("UAV Marker Detection", debug_frame)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break

            if args.max_frames and frame_id >= args.max_frames:
                break

    except KeyboardInterrupt:
        LOGGER.info("Interrupted by user.")
    finally:
        source.release()
        json_logger.close()
        udp_bridge.close()
        mavlink_bridge.close()
        if show_window:
            cv2.destroyAllWindows()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
