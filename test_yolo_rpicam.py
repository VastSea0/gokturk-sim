import sys
import os
import subprocess
import time
import argparse
import shutil

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

def main():
    parser = argparse.ArgumentParser(
        description="Göktürk UAV - Raspberry Pi 5 YOLOv8 Target & Object Detector"
    )
    parser.add_argument(
        "--imgsz", type=int, default=320,
        help="Inference image size. Use 320 for maximum speed/FPS, 640 for more accuracy (default: 320)"
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
    print(f" [YOLO] Loading pre-trained YOLOv8 Nano model...")
    print("==================================================")

    # Load YOLOv8 Nano model (automatically downloads yolov8n.pt if not present)
    # The download will be directed to the workspace directory
    model = YOLO("yolov8n.pt")

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
    
    # Spawn the camera process
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )

    bytes_buffer = b''
    frame_count = 0
    start_time = time.time()

    try:
        while True:
            # Read chunk from camera output stream
            chunk = proc.stdout.read(8192)
            if not chunk:
                retcode = proc.poll()
                if retcode is not None:
                    err = proc.stderr.read().decode('utf-8', errors='ignore')
                    print(f"\n[ERROR] Camera process exited with code {retcode}.")
                    if err:
                        print(f"Details:\n{err}")
                    break
                continue

            bytes_buffer += chunk

            # Find the JPEG boundary markers
            a = bytes_buffer.find(b'\xff\xd8')
            b = bytes_buffer.find(b'\xff\xd9')

            if a != -1 and b != -1 and a < b:
                jpg_data = bytes_buffer[a:b+2]
                bytes_buffer = bytes_buffer[b+2:]

                # Decode JPEG frame
                frame = cv2.imdecode(np.frombuffer(jpg_data, dtype=np.uint8), cv2.IMREAD_COLOR)
                if frame is None:
                    continue

                # Run YOLOv8 inference
                # stream=True processes generator frames (memory efficient)
                # imgsz controls inference size for high CPU frame rates
                results = model(frame, imgsz=args.imgsz, verbose=False)
                
                # Retrieve the annotated frame with bounding boxes and labels drawn
                annotated_frame = results[0].plot()

                frame_count += 1
                if frame_count % 10 == 0:
                    elapsed = time.time() - start_time
                    fps = frame_count / elapsed
                    print(f"[STATUS] Processed {frame_count} frames (~{fps:.1f} FPS)")

                # Display the annotated frame
                if not args.no_gui:
                    cv2.imshow("Raspberry Pi 5 YOLOv8 Real-Time Detections", annotated_frame)
                    if cv2.waitKey(1) & 0xFF == ord('q'):
                        break
                else:
                    # Prevent CPU starvation
                    time.sleep(0.001)

            elif a != -1 and b != -1 and b < a:
                bytes_buffer = bytes_buffer[a:]

    except KeyboardInterrupt:
        print("\n[INFO] Exiting on user request...")
    finally:
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
