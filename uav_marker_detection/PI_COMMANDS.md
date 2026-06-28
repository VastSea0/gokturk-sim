# Raspberry Pi Quick Commands

Use this file when you just want to run the marker detection system on the Raspberry Pi without remembering all commands.

## One-Time Setup

```bash
cd ~/gokturk-uav/uav_marker_detection
chmod +x scripts/*.sh scripts/*.py
./scripts/pi_quick_run.sh install
```

If you also want YOLO support:

```bash
./scripts/pi_quick_run.sh install-yolo
```

## Fast Smoke Test Without Camera

Generates a sample video and runs the default `color` detector:

```bash
./scripts/pi_quick_run.sh smoke
```

## Run With Raspberry Pi Camera

Headless/terminal mode:

```bash
./scripts/pi_quick_run.sh camera
```

With OpenCV preview window:

```bash
./scripts/pi_quick_run.sh camera-debug
```

Blue mask debug view:

```bash
./scripts/pi_quick_run.sh blue-mask
```

## GUI

```bash
./scripts/pi_quick_run.sh gui
```

## Record Dataset Video

```bash
./scripts/pi_quick_run.sh record
```

Custom duration and output:

```bash
./scripts/pi_quick_run.sh record 120 dataset_raw/videos/test_001.mp4
```

## UDP JSON Output

```bash
./scripts/pi_quick_run.sh udp
```

Custom UDP destination:

```bash
./scripts/pi_quick_run.sh udp 192.168.1.20 15000
```

## Pixhawk MAVLink Serial

Default serial command uses `/dev/ttyUSB0` at `57600` baud:

```bash
./scripts/pi_quick_run.sh mavlink
```

Custom port and baudrate:

```bash
./scripts/pi_quick_run.sh mavlink /dev/ttyUSB0 115200
```

## YOLO / YOLO Segmentation

After training/exporting a model:

```bash
./scripts/pi_quick_run.sh yolo models/best.pt
./scripts/pi_quick_run.sh yolo-seg models/best-seg.pt
```

## Help

```bash
./scripts/pi_quick_run.sh help
```

