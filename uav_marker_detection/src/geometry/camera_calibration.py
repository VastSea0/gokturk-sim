from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Union

import cv2
import numpy as np


@dataclass
class CameraCalibration:
    camera_matrix: np.ndarray
    dist_coeffs: np.ndarray

    @classmethod
    def from_opencv_yaml(cls, path: Union[str, Path]) -> "CameraCalibration":
        fs = cv2.FileStorage(str(path), cv2.FILE_STORAGE_READ)
        if not fs.isOpened():
            raise FileNotFoundError(f"Could not open calibration file: {path}")
        camera_matrix = fs.getNode("camera_matrix").mat()
        dist_coeffs = fs.getNode("dist_coeffs").mat()
        fs.release()
        if camera_matrix is None or dist_coeffs is None:
            raise ValueError("Calibration YAML must contain camera_matrix and dist_coeffs nodes")
        return cls(camera_matrix=camera_matrix, dist_coeffs=dist_coeffs)

    def undistort(self, frame: np.ndarray) -> np.ndarray:
        return cv2.undistort(frame, self.camera_matrix, self.dist_coeffs)


def load_calibration_if_available(path: Optional[str]) -> Optional[CameraCalibration]:
    if not path:
        return None
    calibration_path = Path(path)
    if not calibration_path.exists():
        raise FileNotFoundError(f"Calibration file does not exist: {calibration_path}")
    return CameraCalibration.from_opencv_yaml(calibration_path)
