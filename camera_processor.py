import sys
import subprocess

try:
    import cv2
    import numpy as np
except ImportError:
    print("[INFO] Dependencies (opencv-python or numpy) not found. Installing now...")
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "opencv-python", "numpy"])
        import cv2
        import numpy as np
        print("[SUCCESS] Dependencies installed successfully.")
    except Exception as e:
        print(f"[ERROR] Auto-installation failed: {e}")
        print("Please install dependencies manually: pip install opencv-python numpy")
        sys.exit(1)

import urllib.request
import json
import base64
import queue
import threading
import time

# Configuration
# True: Streams camera frames from the simulation console running locally on port 8080.
# False: Uses the native camera device (e.g. Raspberry Pi HQ Camera / picamera / USB Webcam).
USE_SIMULATOR = True
SIMULATOR_URL = "http://localhost:8080/camera/stream"
CAMERA_DEVICE_INDEX = 0  # Used when USE_SIMULATOR = False

# Queues for offloading network requests to keep OpenCV loop at 30+ FPS
frame_queue = queue.Queue(maxsize=1)
detection_queue = queue.Queue(maxsize=20)

def send_detection(color, x, y):
    url = "http://localhost:8080/api/target_detection"
    data = json.dumps({"color": color, "x": x, "y": y}).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=data,
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=0.1) as response:
            response.read()
    except Exception:
        pass

def send_frame(frame):
    # Encode frame to JPEG
    ret, buffer = cv2.imencode('.jpg', frame)
    if not ret:
        return
    # Base64 encode
    base64_str = base64.b64encode(buffer).decode('utf-8')
    data_url = f"data:image/jpeg;base64,{base64_str}"
    
    url = "http://localhost:8080/api/processed_frame"
    req = urllib.request.Request(
        url,
        data=data_url.encode('utf-8'),
        headers={'Content-Type': 'text/plain'},
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=0.15) as response:
            response.read()
    except Exception:
        pass

def sender_worker():
    while True:
        # 1. Process all pending detections
        while not detection_queue.empty():
            try:
                color, x, y = detection_queue.get_nowait()
                send_detection(color, x, y)
                detection_queue.task_done()
            except Exception:
                break
        
        # 2. Process one frame
        try:
            frame = frame_queue.get(timeout=0.05)
            send_frame(frame)
            frame_queue.task_done()
        except queue.Empty:
            continue
        except Exception:
            pass

def queue_detection(color, x, y):
    try:
        detection_queue.put_nowait((color, x, y))
    except queue.Full:
        try:
            detection_queue.get_nowait()
            detection_queue.put_nowait((color, x, y))
        except Exception:
            pass

def detect_colored_squares(frame):
    """
    Detects red and blue squares in the frame.
    Processes the image exactly like it will run on the Raspberry Pi 5.
    """
    height, width = frame.shape[:2]
    
    # Convert image to HSV color space
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    
    # Define color thresholds in HSV space
    # HSV Red ranges (red wraps around 0 and 180)
    lower_red1 = np.array([0, 100, 100])
    upper_red1 = np.array([10, 255, 255])
    lower_red2 = np.array([165, 100, 100])
    upper_red2 = np.array([180, 255, 255])
    
    # HSV Blue range
    lower_blue = np.array([100, 120, 50])
    upper_blue = np.array([140, 255, 255])
    
    # Generate binary masks for red and blue
    mask_red = cv2.inRange(hsv, lower_red1, upper_red1) + cv2.inRange(hsv, lower_red2, upper_red2)
    mask_blue = cv2.inRange(hsv, lower_blue, upper_blue)
    
    # Morphological operations to clean up noise (dilation & erosion)
    kernel = np.ones((5, 5), np.uint8)
    mask_red = cv2.morphologyEx(mask_red, cv2.MORPH_OPEN, kernel)
    mask_blue = cv2.morphologyEx(mask_blue, cv2.MORPH_OPEN, kernel)
    
    # Process Red Shapes (Enemy Targets)
    contours_red, _ = cv2.findContours(mask_red, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for cnt in contours_red:
        area = cv2.contourArea(cnt)
        if area > 400:  # filter out small noise
            peri = cv2.arcLength(cnt, True)
            approx = cv2.approxPolyDP(cnt, 0.04 * peri, True)
            
            x, y, w, h = cv2.boundingRect(cnt)
            aspect_ratio = float(w) / h
            # A square will have aspect ratio close to 1.0
            if 0.75 < aspect_ratio < 1.25:
                cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 0, 255), 2)
                cv2.putText(frame, f"RED TARGET: {area:.0f}px", (x, y - 10), 
                            cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 255), 1)
                
                # Calculate normalized relative coordinates (-1.0 to 1.0)
                cx = x + w / 2.0
                cy = y + h / 2.0
                nx = (cx / width) * 2.0 - 1.0
                ny = 1.0 - (cy / height) * 2.0
                queue_detection("red", nx, ny)

    # Process Blue Shapes (Friendly Targets)
    contours_blue, _ = cv2.findContours(mask_blue, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for cnt in contours_blue:
        area = cv2.contourArea(cnt)
        if area > 400:
            peri = cv2.arcLength(cnt, True)
            approx = cv2.approxPolyDP(cnt, 0.04 * peri, True)
            
            x, y, w, h = cv2.boundingRect(cnt)
            aspect_ratio = float(w) / h
            if 0.75 < aspect_ratio < 1.25:
                cv2.rectangle(frame, (x, y), (x + w, y + h), (255, 0, 0), 2)
                cv2.putText(frame, f"BLUE TARGET: {area:.0f}px", (x, y - 10), 
                            cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 0, 0), 1)
                
                # Calculate normalized relative coordinates (-1.0 to 1.0)
                cx = x + w / 2.0
                cy = y + h / 2.0
                nx = (cx / width) * 2.0 - 1.0
                ny = 1.0 - (cy / height) * 2.0
                queue_detection("blue", nx, ny)
                
    return frame

def main():
    print("==================================================")
    print(" Göktürk UAV - Raspberry Pi 5 Python Camera Stream")
    print("==================================================")
    
    if USE_SIMULATOR:
        print(f"[CAM] Connecting to simulator stream via zero-lag parser: {SIMULATOR_URL}")
        try:
            # Open request with a reasonable timeout
            stream = urllib.request.urlopen(SIMULATOR_URL, timeout=5)
        except Exception as e:
            print(f"[ERROR] Could not connect to stream: {e}")
            print("Please ensure that 'node server.js' is running, and the flight console is open in the browser.")
            sys.exit(1)
            
        print("[SUCCESS] Video stream opened successfully.")
        print("[INFO] Press 'q' key in the pop-up window to exit.")

        # Start network sender thread
        t = threading.Thread(target=sender_worker, daemon=True)
        t.start()

        bytes_buffer = b''
        while True:
            try:
                chunk = stream.read(8192)
                if not chunk:
                    print("[WARN] Empty chunk received. Stream ended?")
                    time.sleep(1)
                    continue
                bytes_buffer += chunk
            except Exception as e:
                print(f"[WARN] Connection error during read: {e}. Reconnecting...")
                time.sleep(1)
                try:
                    stream = urllib.request.urlopen(SIMULATOR_URL, timeout=5)
                    bytes_buffer = b''
                except Exception:
                    pass
                continue
                
            # Search for start and end of JPEG frame
            a = bytes_buffer.find(b'\xff\xd8')
            b = bytes_buffer.find(b'\xff\xd9')
            if a != -1 and b != -1 and a < b:
                jpg_data = bytes_buffer[a:b+2]
                bytes_buffer = bytes_buffer[b+2:]
                
                # Decode frame
                frame = cv2.imdecode(np.frombuffer(jpg_data, dtype=np.uint8), cv2.IMREAD_COLOR)
                if frame is None:
                    continue
                
                # Run detection pipeline
                processed_frame = detect_colored_squares(frame)
                
                # Push processed frame to queue (non-blocking, drop oldest if full)
                try:
                    frame_queue.put_nowait(processed_frame)
                except queue.Full:
                    try:
                        frame_queue.get_nowait()
                        frame_queue.put_nowait(processed_frame)
                    except Exception:
                        pass
                
                # Display the processed frame
                cv2.imshow("Raspberry Pi 5 HQ Camera Output (Processed)", processed_frame)
                
                if cv2.waitKey(1) & 0xFF == ord('q'):
                    break
            elif a != -1 and b != -1 and b < a:
                # Discard corrupted bytes up to the start marker
                bytes_buffer = bytes_buffer[a:]
                
        cv2.destroyAllWindows()
        print("[CAM] Stream closed. Exiting.")
        
    else:
        print(f"[CAM] Connecting to hardware camera index: {CAMERA_DEVICE_INDEX}")
        cap = cv2.VideoCapture(CAMERA_DEVICE_INDEX)
        
        if not cap.isOpened():
            print("[ERROR] Could not open video source.")
            sys.exit(1)

        print("[SUCCESS] Video stream opened successfully.")
        print("[INFO] Press 'q' key in the pop-up window to exit.")

        # Start network sender thread
        t = threading.Thread(target=sender_worker, daemon=True)
        t.start()

        while True:
            ret, frame = cap.read()
            if not ret:
                print("[WARN] Failed to retrieve frame. Retrying...")
                cv2.waitKey(1000)
                continue
                
            # Run detection pipeline
            processed_frame = detect_colored_squares(frame)
            
            # Push processed frame to queue (non-blocking, drop oldest if full)
            try:
                frame_queue.put_nowait(processed_frame)
            except queue.Full:
                try:
                    frame_queue.get_nowait()
                    frame_queue.put_nowait(processed_frame)
                except Exception:
                    pass
            
            # Display the processed frame
            cv2.imshow("Raspberry Pi 5 HQ Camera Output (Processed)", processed_frame)
            
            # Check for exit key
            if cv2.waitKey(1) & 0xFF == ord('q'):
                break
                
        cap.release()
        cv2.destroyAllWindows()
        print("[CAM] Stream closed. Exiting.")

if __name__ == "__main__":
    main()
