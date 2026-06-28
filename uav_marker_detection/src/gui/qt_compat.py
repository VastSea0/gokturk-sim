from __future__ import annotations


try:
    from PyQt6 import QtCore, QtGui, QtWidgets

    Signal = QtCore.pyqtSignal
    Slot = QtCore.pyqtSlot
    QT_API = "PyQt6"
except ImportError:
    try:
        from PySide6 import QtCore, QtGui, QtWidgets

        Signal = QtCore.Signal
        Slot = QtCore.Slot
        QT_API = "PySide6"
    except ImportError as exc:
        raise ImportError(
            "PyQt6 or PySide6 is required for the GUI. On Raspberry Pi OS try: "
            "sudo apt install python3-pyqt6, or install PySide6 in the venv."
        ) from exc


def qt_alignment_center():
    return QtCore.Qt.AlignmentFlag.AlignCenter


def qt_keep_aspect_ratio():
    return QtCore.Qt.AspectRatioMode.KeepAspectRatio


def qt_smooth_transform():
    return QtCore.Qt.TransformationMode.SmoothTransformation

