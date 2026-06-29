# Run the Trained Marker Model on MacBook

This runs the same detection/reporting pipeline used for Raspberry Pi, but with an OpenCV webcam or video source instead of Pi Camera.

The system only detects and reports `red_marker` and `blue_marker`. It does not send flight control, guidance, engagement, or autonomous action commands.

## 1. Train or Locate Weights

If you already ran the synthetic quick pipeline, the script will auto-pick the newest `runs/**/weights/best.pt`.

If not, run:

```bash
cd uav_marker_detection
chmod +x scripts/run_synthetic_marker_pipeline.sh
./scripts/run_synthetic_marker_pipeline.sh quick
```

## 2. Run with MacBook Camera

Allow camera access for Terminal/Codex in macOS:

```text
System Settings > Privacy & Security > Camera
```

Then:

```bash
cd uav_marker_detection
chmod +x scripts/run_macbook_yolo.sh
./scripts/run_macbook_yolo.sh
```

Press `q` in the OpenCV window to quit.

The MacBook runner uses `DETECTOR=hybrid` by default. Hybrid mode runs the trained YOLO model, rejects YOLO boxes that do not contain matching red/blue pixels, and adds high-confidence adaptive color detections that YOLO misses. This is the recommended live test mode for the current synthetic-only model.

If the wrong camera opens:

```bash
CAMERA_INDEX=1 ./scripts/run_macbook_yolo.sh
```

## 3. Run with Sample Video

```bash
SOURCE=video ./scripts/run_macbook_yolo.sh
```

Or with another video:

```bash
SOURCE=video VIDEO=/path/to/test.mp4 ./scripts/run_macbook_yolo.sh
```

## 4. Run with Explicit Weights

```bash
WEIGHTS=runs/synth_marker_pipeline/uav_markers_synth_quick/weights/best.pt ./scripts/run_macbook_yolo.sh
```

Force raw YOLO only, useful for debugging false positives:

```bash
DETECTOR=yolo ./scripts/run_macbook_yolo.sh
```

## 5. Direct Python Commands

Webcam:

```bash
python3 src/main.py \
  --config config/default.yaml \
  --detector hybrid \
  --weights runs/synth_marker_pipeline/uav_markers_synth_quick/weights/best.pt \
  --source webcam \
  --camera-index 0 \
  --show \
  --draw-debug
```

Video:

```bash
python3 src/main.py \
  --config config/default.yaml \
  --detector yolo \
  --weights runs/synth_marker_pipeline/uav_markers_synth_quick/weights/best.pt \
  --source video \
  --video sample_data/test.mp4 \
  --loop-video \
  --show \
  --draw-debug
```

## 6. Logs

Default MacBook script JSON output:

```text
logs/macbook_yolo_detections.jsonl
```

Each detection contains class, confidence, bbox, center pixel, timestamp, relative coordinate estimate, and null global coordinates unless telemetry is connected.
