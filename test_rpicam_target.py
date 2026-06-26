import cv2
import numpy as np
import sys
import argparse
import subprocess
import shutil
import time

# Import the exact target detection logic from our main processor
try:
    from camera_processor import detect_colored_squares
except ImportError:
    print("[ERROR] Could not import detect_colored_squares from camera_processor.py.")
    sys.exit(1)

def find_capture_command():
    """Finds the active rpicam-apps / libcamera-apps video tool on the system."""
    if shutil.which("rpicam-vid"):
        return "rpicam-vid"
    elif shutil.which("libcamera-vid"):
        return "libcamera-vid"
    return None

def main():
    parser = argparse.ArgumentParser(
        description="Göktürk UAV - Raspberry Pi 5 rpicam-vid Target Detector"
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
    print(" Göktürk UAV - Raspberry Pi 5 rpicam-vid Target Detector")
    print(f" [COMMAND] Using camera tool: {cmd_name}")
    print(f" [CONFIG] Headless (No GUI): {args.no_gui}")
    print("==================================================")

    # Build the rpicam-vid command to output MJPEG stream to stdout
    cmd = [
        cmd_name,
        "-t", "0",                  # Run indefinitely
        "--width", "640",
        "--height", "480",
        "--framerate", "30",
        "--codec", "mjpeg",         # Motion JPEG compression for easy streaming
        "-o", "-"                   # Pipe stream directly to stdout
    ]

    # If running headless, instruct rpicam-vid not to spawn a local window
    if args.no_gui:
        cmd.append("-n") # --nopreview

    print("[INFO] Starting rpicam process and parsing MJPEG stdout...")
    
    # Spawn the process
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
            # Read chunks from stdout
            chunk = proc.stdout.read(8192)
            if not chunk:
                # Check if process died
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
            a = bytes_buffer.find(b'\xff\xd8') # SOI (Start of Image)
            b = bytes_buffer.find(b'\xff\xd9') # EOI (End of Image)

            if a != -1 and b != -1 and a < b:
                jpg_data = bytes_buffer[a:b+2]
                bytes_buffer = bytes_buffer[b+2:]

                # Decode JPEG frame
                frame = cv2.imdecode(np.frombuffer(jpg_data, dtype=np.uint8), cv2.IMREAD_COLOR)
                if frame is None:
                    continue

                # Run target detection (identifying red and blue squares)
                processed_frame = detect_colored_squares(frame)

                frame_count += 1
                if frame_count % 30 == 0:
                    elapsed = time.time() - start_time
                    fps = frame_count / elapsed
                    print(f"[STATUS] Processed {frame_count} frames (~{fps:.1f} FPS)")

                # Display frame if windowing is enabled
                if not args.no_gui:
                    cv2.imshow("Raspberry Pi 5 rpicam Target Processing", processed_frame)
                    if cv2.waitKey(1) & 0xFF == ord('q'):
                        break
                else:
                    # Prevent CPU starvation
                    time.sleep(0.001)

            elif a != -1 and b != -1 and b < a:
                # Discard corrupted bytes up to the start marker
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
