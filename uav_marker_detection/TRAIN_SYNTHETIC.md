# Synthetic Marker Dataset and Training

This workflow creates a local YOLO dataset for the safe red/blue ground-marker detection system.

Classes:

- `red_marker`: red 2x2 m square marker, role label `enemy`
- `blue_marker`: blue 2x2 m square marker, role label `friendly`

The model only detects and reports markers. It does not send flight-control, guidance, engagement, or autonomous action commands.

## One Command

From `uav_marker_detection/`:

```bash
chmod +x scripts/run_synthetic_marker_pipeline.sh
./scripts/run_synthetic_marker_pipeline.sh quick
```

This generates a 900-image synthetic detection dataset and trains `yolov8n.pt` for 5 epochs. On the MacBook Air M4 used here, the 5-epoch smoke training finished in about 4 minutes using Apple MPS.

For dataset generation only:

```bash
./scripts/run_synthetic_marker_pipeline.sh dataset-only
```

For a longer local run:

```bash
EPOCHS=50 COUNT=3000 IMGSZ=640 ./scripts/run_synthetic_marker_pipeline.sh full
```

## What Was Generated Locally

The current local test generated:

```text
datasets/uav_markers_synth_detect/
  data.yaml
  dataset_summary.json
  preview_contact_sheet.jpg
  images/train,val,test
  labels/train,val,test
```

Summary from the generated 900-image detection dataset:

```text
train: 675 images
val:   162 images
test:   63 images
red_marker objects:  1098
blue_marker objects: 1086
```

Preview:

```text
datasets/uav_markers_synth_detect/preview_contact_sheet.jpg
```

Generated datasets and training runs are ignored by git because they can become large.

## Manual Commands

Install training dependency:

```bash
python3 -m pip install --user ultralytics
```

Generate detection dataset:

```bash
python3 scripts/generate_uav_synthetic_markers.py \
  --output datasets/uav_markers_synth_detect \
  --count 900 \
  --width 640 \
  --height 480 \
  --task detect \
  --clean \
  --seed 42
```

Train a quick YOLOv8n smoke model:

```bash
python3 scripts/train_yolo.py \
  --data datasets/uav_markers_synth_detect/data.yaml \
  --model yolov8n.pt \
  --task detect \
  --epochs 5 \
  --imgsz 320 \
  --batch 16 \
  --device mps \
  --project runs/synth_marker_test \
  --name yolo8n_5ep
```

Use `--device cpu` on machines without Apple MPS or CUDA.

Validate:

```bash
python3 scripts/validate_yolo.py \
  --weights runs/synth_marker_test/yolo8n_5ep/weights/best.pt \
  --data datasets/uav_markers_synth_detect/data.yaml \
  --imgsz 320 \
  --device mps
```

Run inference on a video:

```bash
python3 src/main.py \
  --config config/default.yaml \
  --detector yolo \
  --weights runs/synth_marker_test/yolo8n_5ep/weights/best.pt \
  --source video \
  --video sample_data/test.mp4
```

Run inference on Raspberry Pi Camera:

```bash
python3 src/main.py \
  --config config/default.yaml \
  --detector yolo \
  --weights runs/synth_marker_test/yolo8n_5ep/weights/best.pt \
  --source pi
```

## Local Test Result

A 5-epoch YOLOv8n smoke training run completed successfully on this Mac:

```text
weights: runs/detect/runs/synth_marker_test/yolo8n_5ep/weights/best.pt
all:        P 0.994, R 0.987, mAP50 0.995, mAP50-95 0.920
red_marker:  P 0.999, R 0.990, mAP50 0.995, mAP50-95 0.928
blue_marker: P 0.990, R 0.985, mAP50 0.994, mAP50-95 0.913
```

These are synthetic validation metrics only. They prove the pipeline works, not that the model is flight-ready.

## Segmentation Dataset Option

If bbox detection is not enough, generate polygon labels for YOLO segmentation:

```bash
python3 scripts/generate_uav_synthetic_markers.py \
  --output datasets/uav_markers_synth_segment \
  --count 1200 \
  --width 640 \
  --height 480 \
  --task segment \
  --clean \
  --seed 43
```

Train with:

```bash
python3 scripts/train_yolo.py \
  --data datasets/uav_markers_synth_segment/data.yaml \
  --model yolov8n-seg.pt \
  --task segment \
  --epochs 50 \
  --imgsz 640 \
  --batch 16 \
  --device mps \
  --project runs/synth_marker_seg \
  --name yolo8n_seg
```

## Colab Recommendation

Short experiments are feasible on this MacBook Air M4. Use Google Colab for longer training runs, larger datasets, or segmentation models.

Suggested Colab flow:

1. Upload or clone this repository.
2. Generate or upload `datasets/uav_markers_synth_detect`.
3. Install Ultralytics:

```bash
pip install ultralytics
```

4. Train:

```python
from ultralytics import YOLO

model = YOLO("yolov8n.pt")
model.train(
    data="/content/gokturk-uav/uav_marker_detection/datasets/uav_markers_synth_detect/data.yaml",
    epochs=80,
    imgsz=640,
    batch=16,
    device=0,
    project="/content/runs",
    name="uav_markers_yolov8n",
)
```

5. Download `runs/uav_markers_yolov8n/weights/best.pt`.

## Next Real-World Step

Synthetic data is useful for bootstrapping, but the serious model should mix synthetic data with real Raspberry Pi Camera frames:

```bash
python3 scripts/capture_dataset_frames.py --source pi --output datasets/pi_frames_raw
```

Label real frames as `red_marker` and `blue_marker`, then train on the combined dataset. Real frames should include motion blur, different altitudes, sunlight/clouds, shadows, tilted camera views, and realistic ground backgrounds.
