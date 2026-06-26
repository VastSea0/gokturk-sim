#!/usr/bin/env bash

set -e

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}==================================================${NC}"
echo -e "${GREEN}  Göktürk UAV - Raspberry Pi 5 Setup Script${NC}"
echo -e "${BLUE}==================================================${NC}"

# Check if running on Linux
if [ "$(uname)" != "Linux" ]; then
    echo -e "${RED}[ERROR] This setup script is intended to be run on a Raspberry Pi 5 running Linux.${NC}"
    echo -e "${YELLOW}[WARN] If you are running this on a Mac, please copy this project to your Raspberry Pi first.${NC}"
    exit 1
fi

echo -e "${BLUE}[INFO] Updating package lists...${NC}"
sudo apt-get update

echo -e "${BLUE}[INFO] Installing core system packages...${NC}"
sudo apt-get install -y python3 python3-pip python3-venv

echo -e "${BLUE}--------------------------------------------------${NC}"
echo -e "${YELLOW}Please choose an installation method for OpenCV & Numpy:${NC}"
echo -e "1) [RECOMMENDED] System-wide via apt-get (Super fast, handles GUI/X11 dependencies automatically)"
echo -e "2) Virtual Environment via pip (Installs in a localized ./venv folder)"
echo -e "${BLUE}--------------------------------------------------${NC}"
read -p "Enter choice [1 or 2]: " choice

if [ "$choice" = "1" ] || [ -z "$choice" ]; then
    echo -e "${BLUE}[INFO] Installing opencv and numpy system-wide...${NC}"
    sudo apt-get install -y python3-opencv python3-numpy
    
    # Create a helper runner script
    cat << 'EOF' > run_pi.sh
#!/usr/bin/env bash
# Runner for system-wide installation
python3 camera_processor.py "$@"
EOF
    chmod +x run_pi.sh
    echo -e "${GREEN}[SUCCESS] System-wide setup completed.${NC}"

elif [ "$choice" = "2" ]; then
    echo -e "${BLUE}[INFO] Creating Python Virtual Environment (./venv)...${NC}"
    python3 -m venv venv
    
    echo -e "${BLUE}[INFO] Activating virtual environment and installing dependencies...${NC}"
    source venv/bin/activate
    pip install --upgrade pip
    pip install opencv-python numpy
    
    # Check if GUI dependencies are installed (useful for cv2.imshow over SSH/GUI display)
    echo -e "${BLUE}[INFO] Installing system libraries required by OpenCV pip wheels...${NC}"
    sudo apt-get install -y libgl1-mesa-glx libglib2.0-0 libxcb-xinerama0
    
    # Create a helper runner script that activates the virtual environment
    cat << 'EOF' > run_pi.sh
#!/usr/bin/env bash
# Runner for virtual environment
source venv/bin/activate
python3 camera_processor.py "$@"
EOF
    chmod +x run_pi.sh
    echo -e "${GREEN}[SUCCESS] Virtual environment setup completed.${NC}"
else
    echo -e "${RED}[ERROR] Invalid choice. Exiting.${NC}"
    exit 1
fi

echo -e "${BLUE}==================================================${NC}"
echo -e "${GREEN}               Setup Complete!${NC}"
echo -e "${BLUE}==================================================${NC}"
echo -e "${YELLOW}You can now run the camera processor with your physical camera using:${NC}"
echo -e "  ${GREEN}./run_pi.sh --camera${NC}"
echo -e ""
echo -e "${YELLOW}Other helpful commands:${NC}"
echo -e "  - Run in headless mode (no GUI window, best for SSH/remote running):"
echo -e "    ${GREEN}./run_pi.sh --camera --no-gui${NC}"
echo -e "  - Run local target detection only (no communication with simulator):"
echo -e "    ${GREEN}./run_pi.sh --camera --detect-only${NC}"
echo -e "  - Stream processed detections to a simulator running on another computer (e.g. 192.168.1.100):"
echo -e "    ${GREEN}./run_pi.sh --camera --host 192.168.1.100:8080${NC}"
echo -e "  - Choose a specific hardware camera index (e.g., /dev/video2 -> index 2):"
echo -e "    ${GREEN}./run_pi.sh --camera --device 2${NC}"
echo -e "${BLUE}==================================================${NC}"
