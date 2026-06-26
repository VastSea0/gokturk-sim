import cv2
import sys
import argparse
import time
from camera_utils import open_camera

def main():
    parser = argparse.ArgumentParser(description="Göktürk UAV - Raspberry Pi 5 Simple Camera Test")
    parser.add_argument("--device", type=int, default=0, help="Camera device index (default: 0)")
    parser.add_argument("--no-gui", action="store_true", help="Run without displaying a GUI window")
    args = parser.parse_args()

    print("==================================================")
    print(" Göktürk UAV - Raspberry Pi 5 Camera Test")
    print(f" [CONFIG] Camera Device Index: {args.device}")
    print(f" [CONFIG] Headless (No GUI): {args.no_gui}")
    print("==================================================")

    cap = open_camera(args.device)
    if cap is None:
        print("[ERROR] Could not open video source via any backend.")
        sys.exit(1)

    print("[SUCCESS] Camera stream started.")
    if not args.no_gui:
        print("[INFO] Press 'q' key in the video window to exit.")
    else:
        print("[INFO] Headless mode active. Press Ctrl+C to exit.")

    try:
        frame_count = 0
        start_time = time.time()

        while True:
            ret, frame = cap.read()
            if not ret:
                print("[WARN] Failed to retrieve frame. Retrying...")
                time.sleep(1)
                continue

            frame_count += 1
            if frame_count % 30 == 0:
                elapsed = time.time() - start_time
                fps = frame_count / elapsed
                print(f"[STATUS] Received {frame_count} frames (~{fps:.1f} FPS)")

            if not args.no_gui:
                cv2.imshow("Raspberry Pi 5 Raw Camera Feed", frame)
                if cv2.waitKey(1) & 0xFF == ord('q'):
                    break
            else:
                time.sleep(0.01)

    except KeyboardInterrupt:
        print("\n[INFO] Test stopped by user.")
    finally:
        cap.release()
        if not args.no_gui:
            cv2.destroyAllWindows()
        print("[INFO] Resources released. Exiting.")

if __name__ == "__main__":
    main()
