#!/usr/bin/env bash

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to run the setup/installation
run_setup() {
    echo -e "${BLUE}==================================================${NC}"
    echo -e "${GREEN}  Göktürk UAV - Raspberry Pi 5 Dependency Setup${NC}"
    echo -e "${BLUE}==================================================${NC}"

    if [ "$(uname)" != "Linux" ]; then
        echo -e "${RED}[ERROR] Setup must be run on the Raspberry Pi 5 (Linux).${NC}"
        exit 1
    fi

    echo -e "${BLUE}[INFO] Updating package lists...${NC}"
    sudo apt-get update

    echo -e "${BLUE}[INFO] Installing core system packages...${NC}"
    sudo apt-get install -y python3 python3-pip python3-venv

    echo -e "${BLUE}--------------------------------------------------${NC}"
    echo -e "${YELLOW}Please choose an OpenCV & Numpy installation method:${NC}"
    echo -e "1) [RECOMMENDED] System-wide via apt-get (Super fast, handles window GUI libraries)"
    echo -e "2) Virtual Environment via pip (Installs in local ./venv directory)"
    echo -e "${BLUE}--------------------------------------------------${NC}"
    read -p "Enter choice [1 or 2]: " choice

    if [ "$choice" = "1" ] || [ -z "$choice" ]; then
        echo -e "${BLUE}[INFO] Installing opencv and numpy system-wide...${NC}"
        sudo apt-get install -y python3-opencv python3-numpy
        echo -e "${GREEN}[SUCCESS] System-wide dependencies installed.${NC}"
    elif [ "$choice" = "2" ]; then
        echo -e "${BLUE}[INFO] Creating Virtual Environment (./venv)...${NC}"
        python3 -m venv venv
        source venv/bin/activate
        pip install --upgrade pip
        pip install opencv-python numpy
        echo -e "${BLUE}[INFO] Installing system libraries for pip wheels...${NC}"
        sudo apt-get install -y libgl1-mesa-glx libglib2.0-0 libxcb-xinerama0
        echo -e "${GREEN}[SUCCESS] Virtual environment dependencies installed.${NC}"
    else
        echo -e "${RED}[ERROR] Invalid choice.${NC}"
        exit 1
    fi
    echo -e "${GREEN}[SUCCESS] Setup complete! You can now run normally.${NC}"
    echo -e "${BLUE}==================================================${NC}"
}

# Check if user explicitly asked for setup
if [ "$1" = "--setup" ] || [ "$1" = "-s" ] || [ "$1" = "--install" ]; then
    run_setup
    exit 0
fi

# Clean arguments: remove standalone '--' if present (e.g. npm/yarn style separators)
args=()
for arg in "$@"; do
    if [ "$arg" != "--" ]; then
        args+=("$arg")
    fi
done

# Determine if we need to use the virtual environment
if [ -d "venv" ] && [ -f "venv/bin/activate" ]; then
    source venv/bin/activate
fi

# Check if python dependencies are available
if python3 -c "import cv2, numpy" 2>/dev/null; then
    # Run the Python script directly, forwarding all cleaned command-line arguments
    python3 camera_processor.py "${args[@]}"
else
    # Dependencies are missing
    echo -e "${YELLOW}[WARN] OpenCV or Numpy not found in Python environment.${NC}"
    echo -e "${BLUE}[INFO] To install dependencies, run:${NC}"
    echo -e "  ${GREEN}./run_pi.sh --setup${NC}"
    echo -e ""
    read -p "Would you like to run setup now? (y/N): " run_now
    if [[ "$run_now" =~ ^[Yy]$ ]]; then
        run_setup
        # Activate virtual env if that's what was set up
        if [ -d "venv" ] && [ -f "venv/bin/activate" ]; then
            source venv/bin/activate
        fi
        python3 camera_processor.py "${args[@]}"
    else
        echo -e "${RED}[ERROR] Cannot run camera processor without dependencies. Exiting.${NC}"
        exit 1
    fi
fi
