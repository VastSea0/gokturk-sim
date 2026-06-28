from __future__ import annotations

import time
from collections import deque


class FPSCounter:
    def __init__(self, window: int = 30) -> None:
        self.timestamps: deque[float] = deque(maxlen=max(2, window))

    def update(self) -> float:
        now = time.monotonic()
        self.timestamps.append(now)
        if len(self.timestamps) < 2:
            return 0.0
        elapsed = self.timestamps[-1] - self.timestamps[0]
        if elapsed <= 0:
            return 0.0
        return (len(self.timestamps) - 1) / elapsed

