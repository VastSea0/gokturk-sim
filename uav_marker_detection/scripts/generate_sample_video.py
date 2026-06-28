#!/usr/bin/env python3
from __future__ import annotations

import os
from pathlib import Path
import cv2
import numpy as np


def main() -> int:
    output_dir = Path("sample_data")
    output_dir.mkdir(parents=True, exist_ok=True)
    video_path = output_dir / "test.mp4"

    width, height = 640, 480
    fps = 20
    duration_sec = 5
    num_frames = fps * duration_sec

    # Define BGR colors
    bg_color = (45, 95, 45)      # Dark green (grass/terrain)
    red_color = (0, 0, 255)     # Red marker
    blue_color = (255, 0, 0)    # Blue marker
    white_color = (245, 245, 245) # White border for marker

    # Initialize video writer
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(str(video_path), fourcc, fps, (width, height))
    if not out.isOpened():
        print("[ERROR] Failed to open VideoWriter with mp4v codec.")
        return 1

    print(f"[INFO] Generating {num_frames} frames of synthetic video...")

    # Marker sizes (perfect square of 60x60 pixels)
    marker_size = 60

    # Paths for moving markers
    # Red marker moves from left to right in the upper half
    # Blue marker moves from right to left in the lower half
    for i in range(num_frames):
        # Create base background frame
        frame = np.zeros((height, width, 3), dtype=np.uint8)
        frame[:] = bg_color

        # Add some random noise to resemble actual ground terrain
        noise = np.zeros(frame.shape, dtype=np.float32)
        cv2.randn(noise, (0, 0, 0), (8, 8, 8))
        frame = np.clip(frame.astype(np.float32) + noise, 0, 255).astype(np.uint8)

        # Red marker center
        rx = int(100 + (width - 200) * (i / num_frames))
        ry = int(120 + 20 * np.sin(2 * np.pi * i / 40))

        # Draw red marker: solid square, then a thin white outline to match typical real markers
        cv2.rectangle(
            frame,
            (rx - marker_size // 2, ry - marker_size // 2),
            (rx + marker_size // 2, ry + marker_size // 2),
            red_color,
            -1
        )
        cv2.rectangle(
            frame,
            (rx - marker_size // 2, ry - marker_size // 2),
            (rx + marker_size // 2, ry + marker_size // 2),
            white_color,
            2
        )

        # Blue marker center
        bx = int((width - 100) - (width - 200) * (i / num_frames))
        by = int(320 + 30 * np.cos(2 * np.pi * i / 50))

        # Draw blue marker
        cv2.rectangle(
            frame,
            (bx - marker_size // 2, by - marker_size // 2),
            (bx + marker_size // 2, by + marker_size // 2),
            blue_color,
            -1
        )
        cv2.rectangle(
            frame,
            (bx - marker_size // 2, by - marker_size // 2),
            (bx + marker_size // 2, by + marker_size // 2),
            white_color,
            2
        )

        # Write frame to video file
        out.write(frame)

    out.release()
    print(f"[SUCCESS] Synthetic video written to {video_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
