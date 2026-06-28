import sys
import os
import subprocess
import time
import argparse
import shutil
import queue
import threading

# 1. Check and auto-install ultralytics dependency
try:
    from ultralytics import YOLO
except ImportError:
    print("[INFO] 'ultralytics' package is not installed. Installing it now...")
    is_venv = sys.prefix != sys.base_prefix
    pip_cmd = [sys.executable, "-m", "pip", "install", "ultralytics"]
    if not is_venv:
        # Avoid PEP 668 restrictions on system-wide installs
        pip_cmd.append("--break-system-packages")
    try:
        subprocess.check_call(pip_cmd)
        from ultralytics import YOLO
        print("[SUCCESS] 'ultralytics' dependency installed.")
    except Exception as e:
        print(f"[ERROR] Failed to install ultralytics automatically: {e}")
        print("Please install it manually: pip install ultralytics")
        sys.exit(1)

import cv2
import numpy as np

def find_capture_command():
    """Finds the active rpicam-apps / libcamera-apps video tool on the system."""
    if shutil.which("rpicam-vid"):
        return "rpicam-vid"
    elif shutil.which("libcamera-vid"):
        return "libcamera-vid"
    return None

class MJPEGStreamReader(threading.Thread):
    """
    Background thread to continuously read MJPEG stream from camera's stdout.
    It reconstructs JPEGs and keeps only the latest frame in a single-element queue,
    preventing any cumulative buffering delay (lag) when processing is slow.
    """
    def __init__(self, stdout):
        super().__init__()
        self.stdout = stdout
        self.queue = queue.Queue(maxsize=1)
        self.running = True
        self.daemon = True

    def run(self):
        bytes_buffer = b''
        try:
            while self.running:
                chunk = self.stdout.read(8192)
                if not chunk:
                    break
                bytes_buffer += chunk
                
                while True:
                    a = bytes_buffer.find(b'\xff\xd8')
                    b = bytes_buffer.find(b'\xff\xd9')
                    
                    if a != -1 and b != -1 and a < b:
                        jpg_data = bytes_buffer[a:b+2]
                        bytes_buffer = bytes_buffer[b+2:]
                        
                        # Overwrite the queue to hold only the most recent frame
                        if self.queue.full():
                            try:
                                self.queue.get_nowait()
                            except queue.Empty:
                                pass
                        self.queue.put_nowait(jpg_data)
                    elif a != -1 and b != -1 and b < a:
                        bytes_buffer = bytes_buffer[a:]
                        break
                    else:
                        break
        except Exception as e:
            print(f"\n[Reader Thread Error] {e}")
        finally:
            self.running = False

    def stop(self):
        self.running = False

def detect_and_count_colored_squares(src_frame, dst_frame, strict_shape=True):
    """
    Detects red and blue shapes in src_frame and draws bounding boxes on dst_frame.
    Returns:
        dst_frame: Output frame with drawn annotations.
        friend_count: Number of blue shapes (dost).
        enemy_count: Number of red shapes (düşman).
    """
    friend_count = 0
    enemy_count = 0
    
    # Convert src_frame to HSV for robust color thresholding
    hsv = cv2.cvtColor(src_frame, cv2.COLOR_BGR2HSV)
    
    # Red thresholds (two ranges due to hue wrap-around in HSV)
    lower_red1 = np.array([0, 100, 100])
    upper_red1 = np.array([10, 255, 255])
    lower_red2 = np.array([165, 100, 100])
    upper_red2 = np.array([180, 255, 255])
    
    # Blue threshold
    lower_blue = np.array([100, 120, 50])
    upper_blue = np.array([140, 255, 255])
    
    mask_red = cv2.inRange(hsv, lower_red1, upper_red1) + cv2.inRange(hsv, lower_red2, upper_red2)
    mask_blue = cv2.inRange(hsv, lower_blue, upper_blue)
    
    kernel = np.ones((5, 5), np.uint8)
    mask_red = cv2.morphologyEx(mask_red, cv2.MORPH_OPEN, kernel)
    mask_blue = cv2.morphologyEx(mask_blue, cv2.MORPH_OPEN, kernel)
    
    # Noise area threshold (smaller threshold if shape strictness is disabled)
    min_area = 400 if strict_shape else 150
    
    # Find Red (Düşman / Enemy)
    contours_red, _ = cv2.findContours(mask_red, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for cnt in contours_red:
        area = cv2.contourArea(cnt)
        if area > min_area:
            x, y, w, h = cv2.boundingRect(cnt)
            if strict_shape:
                aspect_ratio = float(w) / h
                if not (0.75 < aspect_ratio < 1.25):
                    continue
            
            enemy_count += 1
            # Draw red box and text (Düşman) on dst_frame
            cv2.rectangle(dst_frame, (x, y), (x + w, y + h), (0, 0, 255), 2)
            cv2.putText(dst_frame, "DUSMAN (RED)", (x, y - 10), 
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 2)
                
    # Find Blue (Dost / Friend)
    contours_blue, _ = cv2.findContours(mask_blue, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for cnt in contours_blue:
        area = cv2.contourArea(cnt)
        if area > min_area:
            x, y, w, h = cv2.boundingRect(cnt)
            if strict_shape:
                aspect_ratio = float(w) / h
                if not (0.75 < aspect_ratio < 1.25):
                    continue
            
            friend_count += 1
            # Draw blue box and text (Dost) on dst_frame
            cv2.rectangle(dst_frame, (x, y), (x + w, y + h), (255, 0, 0), 2)
            cv2.putText(dst_frame, "DOST (BLUE)", (x, y - 10), 
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 0, 0), 2)
                
    # Draw OSD (On-Screen Display) with count summaries
    # Draw a dark background rectangle for readability
    cv2.rectangle(dst_frame, (10, 10), (280, 70), (0, 0, 0), -1)
    cv2.putText(dst_frame, f"DOST (BLUE): {friend_count}", (20, 35), 
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 150, 50), 2)
    cv2.putText(dst_frame, f"DUSMAN (RED): {enemy_count}", (20, 60), 
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (50, 50, 255), 2)
                
    return dst_frame, friend_count, enemy_count

def main():
    parser = argparse.ArgumentParser(
        description="Göktürk UAV - Raspberry Pi 5 YOLOv8 Target & Object Detector"
    )
    parser.add_argument(
        "--imgsz", type=int, default=320,
        help="Inference image size. Use 320 for maximum speed/FPS, 640 for more accuracy (default: 320)"
    )
    parser.add_argument(
        "--format", type=str, default="pytorch", choices=["pytorch", "onnx", "ncnn"],
        help="Model format to use for inference. 'onnx' and 'ncnn' are much faster on Pi 5 CPU (default: pytorch)"
    )
    parser.add_argument(
        "--only-targets", action="store_true",
        help="Run only friend/enemy target detection, skipping YOLO inference to save CPU/RAM"
    )
    parser.add_argument(
        "--no-shape-filter", action="store_true",
        help="Disable strict square shape filtering and detect targets based on color only"
    )
    parser.add_argument(
        "--no-gui", action="store_true",
        help="Run in headless mode (disables preview window and cv2.imshow)"
    )
    args = parser.parse_args()

    cmd_name = find_capture_command()
    if cmd_name is None:
        print("[ERROR] Could not find 'rpicam-vid' or 'libcamera-vid' on your system.")
        print("Please verify your Raspberry Pi OS camera suite installation:")
        print("  sudo apt-get install -y rpicam-apps")
        sys.exit(1)

    print("==================================================")
    print(" Göktürk UAV - Raspberry Pi 5 YOLOv8 Real-Time Detector")
    print(f" [COMMAND] Using camera tool: {cmd_name}")
    if not args.only_targets:
        print(f" [YOLO] Preparing YOLOv8 Nano model in '{args.format}' format...")
    else:
        print(" [INFO] Mode: ONLY Target Detection (YOLO disabled to maximize speed)")
    print("==================================================")

    model = None
    if not args.only_targets:
        # Ensure optimized format dependencies are pre-installed
        # (Fixes PEP 668 restrictions where Ultralytics auto-install fails)
        is_venv = sys.prefix != sys.base_prefix
        if args.format == "onnx":
            try:
                import onnx
                import onnxruntime
            except ImportError:
                print("[INFO] 'onnx' or 'onnxruntime' package is not installed. Installing them now...")
                for pkg in ["onnx", "onnxruntime"]:
                    pip_cmd = [sys.executable, "-m", "pip", "install", pkg]
                    if not is_venv:
                        pip_cmd.append("--break-system-packages")
                    try:
                        subprocess.check_call(pip_cmd)
                    except Exception as e:
                        print(f"[ERROR] Failed to install {pkg}: {e}")
                        sys.exit(1)
        elif args.format == "ncnn":
            try:
                import ncnn
            except ImportError:
                print("[INFO] 'ncnn' or 'pnnx' package is not installed. Installing them now...")
                for pkg in ["ncnn", "pnnx"]:
                    pip_cmd = [sys.executable, "-m", "pip", "install", pkg]
                    if not is_venv:
                        pip_cmd.append("--break-system-packages")
                    try:
                        subprocess.check_call(pip_cmd)
                    except Exception as e:
                        print(f"[ERROR] Failed to install {pkg}: {e}")
                        sys.exit(1)

        # Automatically handle ONNX or NCNN export for optimized CPU speed
        model_name = "yolov8n.pt"
        if args.format == "onnx":
            onnx_path = "yolov8n.onnx"
            if not os.path.exists(onnx_path):
                print(f"[INFO] Exporting yolov8n.pt to ONNX format (imgsz={args.imgsz})...")
                temp_model = YOLO("yolov8n.pt")
                temp_model.export(format="onnx", imgsz=args.imgsz)
            model_name = onnx_path
        elif args.format == "ncnn":
            ncnn_path = "yolov8n_ncnn_model"
            if not os.path.exists(ncnn_path):
                print(f"[INFO] Exporting yolov8n.pt to NCNN format (imgsz={args.imgsz})...")
                temp_model = YOLO("yolov8n.pt")
                temp_model.export(format="ncnn", imgsz=args.imgsz)
            model_name = ncnn_path

        print(f"[YOLO] Loading model: {model_name}")
        model = YOLO(model_name)

    # Build the rpicam-vid command to output MJPEG stream to stdout
    cmd = [
        cmd_name,
        "-t", "0",                  # Run indefinitely
        "--width", "640",
        "--height", "480",
        "--framerate", "30",
        "--codec", "mjpeg",         # Output MJPEG stream
        "-o", "-"                   # Pipe stream directly to stdout
    ]

    # If running headless, instruct rpicam-vid not to spawn a local window
    if args.no_gui:
        cmd.append("-n")

    print("[INFO] Starting rpicam process and parsing MJPEG stdout...")
    
    # Spawn the camera process with bufsize=0 to minimize kernel-level buffering
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0
    )

    frame_count = 0
    start_time = time.time()

    # Start background reader thread to drain stdout and keep only the latest frame
    reader = MJPEGStreamReader(proc.stdout)
    reader.start()

    try:
        while True:
            # Block until a new frame is received or timeout (0.5s)
            try:
                jpg_data = reader.queue.get(timeout=0.5)
            except queue.Empty:
                # Check if camera process exited during wait
                retcode = proc.poll()
                if retcode is not None:
                    err = proc.stderr.read().decode('utf-8', errors='ignore')
                    print(f"\n[ERROR] Camera process exited with code {retcode}.")
                    if err:
                        print(f"Details:\n{err}")
                    break
                continue

            # Decode JPEG frame
            frame = cv2.imdecode(np.frombuffer(jpg_data, dtype=np.uint8), cv2.IMREAD_COLOR)
            if frame is None:
                continue

            if model is not None:
                # Run YOLOv8 inference (using format-optimized model)
                results = model(frame, imgsz=args.imgsz, verbose=False)
                # Retrieve the annotated frame with bounding boxes and labels drawn
                annotated_frame = results[0].plot()
            else:
                # Bypass YOLO and use raw frame directly
                annotated_frame = frame

            # Detect colored shapes in the clean raw frame and overlay them on the annotated frame
            annotated_frame, friend_count, enemy_count = detect_and_count_colored_squares(
                frame, annotated_frame, strict_shape=not args.no_shape_filter
            )

            frame_count += 1
            if frame_count % 10 == 0:
                elapsed = time.time() - start_time
                fps = frame_count / elapsed
                print(f"[STATUS] Processed {frame_count} frames (~{fps:.1f} FPS) | DOST: {friend_count} | DUSMAN: {enemy_count}")

            # Display the annotated frame
            if not args.no_gui:
                window_title = "Raspberry Pi 5 Target Detection Feed" if args.only_targets else "Raspberry Pi 5 YOLOv8 Real-Time Detections"
                cv2.imshow(window_title, annotated_frame)
                if cv2.waitKey(1) & 0xFF == ord('q'):
                    break
            else:
                # Prevent CPU starvation
                time.sleep(0.001)

    except KeyboardInterrupt:
        print("\n[INFO] Exiting on user request...")
    finally:
        # Stop background reader thread
        reader.stop()
        
        # Terminate camera process
        proc.terminate()
        try:
            proc.wait(timeout=1)
        except subprocess.TimeoutExpired:
            proc.kill()
        
        if not args.no_gui:
            cv2.destroyAllWindows()
        print("[INFO] Cleaned up. Done.")


if __name__ == "__main__":
    main()
