from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional


class JSONLogger:
    """Append newline-delimited JSON detection results."""

    def __init__(self, path: Optional[str], enabled: bool = True) -> None:
        self.enabled = enabled and bool(path)
        self.path = Path(path) if path else None
        self.handle = None

    def start(self) -> None:
        if not self.enabled or self.path is None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = open(self.path, "a", encoding="utf-8")

    def write(self, payload: Dict[str, Any]) -> None:
        if not self.enabled:
            return
        if self.handle is None:
            self.start()
        self.handle.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
        self.handle.flush()

    def close(self) -> None:
        if self.handle is not None:
            self.handle.close()
            self.handle = None

