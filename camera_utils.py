import cv2
import sys

def open_camera(device_index=0):
    """
    Attempts to open a camera device using multiple backends (GStreamer libcamerasrc, V4L2, default)
    and validates that frames are actively being retrieved.
    """
    # 1. Try GStreamer with libcamerasrc (Pi Camera module)
    if device_index == 0:
        print("[CAM] Trying GStreamer libcamerasrc (Pi Camera Module)...")
        pipeline = "libcamerasrc camera-name=0 ! video/x-raw, width=640, height=480, framerate=30/1 ! videoconvert ! appsink"
        try:
            cap = cv2.VideoCapture(pipeline, cv2.CAP_GSTREAMER)
            if cap.isOpened():
                ret, frame = cap.read()
                if ret and frame is not None:
                    print("[SUCCESS] Connected via GStreamer libcamerasrc.")
                    return cap
                cap.release()
        except Exception:
            pass

    # 2. Try V4L2 backend directly (for USB cameras, bypasses GStreamer CMA memory issue)
    print("[CAM] Trying V4L2 backend directly...")
    try:
        cap = cv2.VideoCapture(device_index, cv2.CAP_V4L2)
        if cap.isOpened():
            ret, frame = cap.read()
            if ret and frame is not None:
                print("[SUCCESS] Connected via V4L2.")
                return cap
            cap.release()
    except Exception:
        pass

    # 3. Fallback to default OpenCV backend
    print("[CAM] Trying default OpenCV backend...")
    try:
        cap = cv2.VideoCapture(device_index)
        if cap.isOpened():
            ret, frame = cap.read()
            if ret and frame is not None:
                print("[SUCCESS] Connected via default backend.")
                return cap
            cap.release()
    except Exception:
        pass

    return None
