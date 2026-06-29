"""Material 3 inspired QSS stylesheet for the UAV Marker Detection application."""

MATERIAL3_STYLE = """
/* General Application Style */
QWidget {
    background-color: #121318;
    color: #e3e2e6;
    font-family: "Segoe UI", "Roboto", "Outfit", "Helvetica Neue", sans-serif;
    font-size: 13px;
}

/* Scroll Area */
QScrollArea {
    border: none;
    background-color: #121318;
}

QScrollBar:vertical {
    border: none;
    background: #121318;
    width: 10px;
    margin: 0px;
}
QScrollBar::handle:vertical {
    background: #44474f;
    min-height: 24px;
    border-radius: 5px;
}
QScrollBar::handle:vertical:hover {
    background: #5c5f67;
}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {
    border: none;
    background: none;
    height: 0px;
}
QScrollBar::up-arrow:vertical, QScrollBar::down-arrow:vertical {
    border: none;
    background: none;
}
QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {
    background: none;
}

/* Splitter */
QSplitter::handle {
    background-color: #2e3035;
}
QSplitter::handle:horizontal {
    width: 4px;
}

/* Material 3 Card (QGroupBox) */
QGroupBox {
    background-color: #1d1e22;
    border: 1px solid #2e3035;
    border-radius: 16px;
    margin-top: 20px;
    padding: 16px;
    font-weight: 700;
    font-size: 14px;
    color: #a8c7fa; /* Material Primary color for titles */
}
QGroupBox::title {
    subcontrol-origin: margin;
    subcontrol-position: top left;
    left: 16px;
    top: 4px;
    padding: 0 6px 0 6px;
}

/* Labels */
QLabel {
    color: #c7c6ca;
    font-weight: 500;
}

/* Line Edit / Inputs */
QLineEdit {
    background-color: #2a2b2f;
    color: #e3e2e6;
    border: 1px solid #44474f;
    border-radius: 8px;
    padding: 8px 12px;
}
QLineEdit:focus {
    border: 2px solid #a8c7fa;
    background-color: #212327;
}
QLineEdit:disabled {
    background-color: #17181c;
    color: #8e9099;
    border-color: #2e3035;
}

/* Combo Box */
QComboBox {
    background-color: #2a2b2f;
    color: #e3e2e6;
    border: 1px solid #44474f;
    border-radius: 8px;
    padding: 8px 12px;
}
QComboBox:focus {
    border: 2px solid #a8c7fa;
}
QComboBox::drop-down {
    subcontrol-origin: padding;
    subcontrol-position: top right;
    width: 24px;
    border-left-width: 0px;
}
QComboBox QAbstractItemView {
    background-color: #2a2b2f;
    color: #e3e2e6;
    border: 1px solid #44474f;
    border-radius: 8px;
    selection-background-color: #3b4856;
    selection-color: #e3e2e6;
    padding: 6px;
}

/* Spinbox */
QSpinBox {
    background-color: #2a2b2f;
    color: #e3e2e6;
    border: 1px solid #44474f;
    border-radius: 8px;
    padding: 8px 12px;
}
QSpinBox:focus {
    border: 2px solid #a8c7fa;
}

/* Standard Buttons (Tonal/Secondary) */
QPushButton {
    background-color: #3b4856;
    color: #e3e2e6;
    border: none;
    border-radius: 12px;
    padding: 10px 18px;
    font-weight: 600;
    font-size: 13px;
}
QPushButton:hover {
    background-color: #495a6c;
}
QPushButton:pressed {
    background-color: #2f3a46;
}
QPushButton:disabled {
    background-color: #17181c;
    color: #8e9099;
    border-color: #2e3035;
}

/* Main Action / Primary Filled Buttons */
QPushButton#start_button, QPushButton#connect_button {
    background-color: #a8c7fa;
    color: #062e6f;
}
QPushButton#start_button:hover, QPushButton#connect_button:hover {
    background-color: #c2e7ff;
}
QPushButton#start_button:pressed, QPushButton#connect_button:pressed {
    background-color: #7da5df;
}

/* Danger / Stop / Disconnect Buttons */
QPushButton#stop_button, QPushButton#disconnect_button {
    background-color: #ffb4ab;
    color: #690005;
}
QPushButton#stop_button:hover, QPushButton#disconnect_button:hover {
    background-color: #ffdad6;
}
QPushButton#stop_button:pressed, QPushButton#disconnect_button:pressed {
    background-color: #ff8982;
}

/* Checkbox */
QCheckBox {
    spacing: 8px;
    color: #c7c6ca;
    font-weight: 500;
}
QCheckBox::indicator {
    width: 20px;
    height: 20px;
    border-radius: 6px;
    border: 2px solid #44474f;
    background-color: transparent;
}
QCheckBox::indicator:hover {
    border-color: #c7c6ca;
}
QCheckBox::indicator:checked {
    border-color: #a8c7fa;
    background-color: #a8c7fa;
}

/* Table Widget */
QTableWidget {
    background-color: #1d1e22;
    border: 1px solid #2e3035;
    border-radius: 16px;
    gridline-color: #2e3035;
    color: #e3e2e6;
    selection-background-color: #3b4856;
}
QHeaderView::section {
    background-color: #2a2b2f;
    color: #a8c7fa;
    padding: 8px;
    border: none;
    border-bottom: 2px solid #2e3035;
    font-weight: bold;
    font-size: 12px;
}
QTableCornerButton::section {
    background-color: #2a2b2f;
    border: none;
}

/* Status Bar */
QStatusBar {
    background-color: #121318;
    color: #8e9099;
    border-top: 1px solid #2e3035;
}
"""
