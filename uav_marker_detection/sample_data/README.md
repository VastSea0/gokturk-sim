# Sample Data

Place short test videos or still captures here, for example:

```bash
sample_data/test.mp4
sample_data/pi_camera_ground_test_001.mp4
```

Hardware-free smoke test:

```bash
python3 scripts/generate_sample_video.py
python3 src/main.py --config config/default.yaml --detector hsv --source video --video sample_data/test.mp4 --max-frames 100
```

GUI smoke test:

```bash
python3 src/gui/app.py --config config/default.yaml
```

Select `Simulation/video test`, keep `sample_data/test.mp4`, and press `Start`.

The repository does not include flight imagery. Use `scripts/capture_dataset_frames.py` to collect frames from real camera/video inputs.
