# Göktürk UAV — Real-Time 3D SITL Telemetry Visualization

Real-time 3D UAV simulation visualizer that streams MAVLink telemetry from a PX4 SITL running inside Docker to a premium Three.js frontend via a Node.js WebSocket bridge. Mission waypoints uploaded from QGroundControl are rendered live in the 3D scene.

```
[PX4 SITL Docker] --(UDP :14540 MAVLink)--> [Node.js Bridge] --(WS :8080 JSON)--> [Three.js Frontend]
                                                 ↑
                                  [QGroundControl :14550]
```

## Features

- **Real-time 3D drone** — procedural quadcopter model with spinning props, LED lights, flight trail
- **Mission route visualization** — 3D waypoint markers, path lines, and active waypoint glow synced from QGroundControl
- **EO payload camera simulator** — drone-mounted pan/tilt/FOV gimbal feed with horizon stabilization, PNG capture, and a browser frame API for future computer-vision pipelines
- **Premium HUD** — glassmorphism panels with attitude indicator (ADI), battery, GPS, VFR data
- **PX4 flight mode decoding** — custom_mode main/sub byte parsing (MANUAL, POSCTL, AUTO_MISSION, AUTO_RTL, etc.)
- **MAVLink mission protocol** — downloads mission items from FC and re-syncs when QGC uploads new missions
- **NED → Three.js** — correct aerospace coordinate transform (roll/pitch/yaw to Y-up scene)
- **Mock mode** — synthetic telemetry + 6-waypoint hexagonal mission route, no Docker needed for frontend dev
- **Auto-reconnect** — WebSocket client reconnects automatically on server restart

---

## Setup

### 1. Install dependencies

```bash
npm install
npm install --save-dev concurrently
```

### 2. Start Docker Desktop

Ensure Docker Desktop is running before starting the SITL simulation:

- **macOS:** Open Docker Desktop from Applications.
- **Apple Silicon:** Enable "Use Rosetta for x86/amd64 emulation" in Docker Desktop → Settings → Features in Development.

### 3. Pull and run the PX4 SITL Docker image

```bash
# Pull the PX4 development simulation image
docker pull px4io/px4-dev-simulation-focal

# Run PX4 SITL with Gazebo (ports forwarded for companion API + QGC)
docker run -it --rm \
  --platform linux/amd64 \
  -p 14540:14540/udp \
  -p 14550:14550/udp \
  px4io/px4-dev-simulation-focal \
  bash -c "cd /root/PX4-Autopilot && make px4_sitl gazebo"
```

> **Port mapping:**
> - `14540/udp` — PX4 companion API output → our Node.js MAVLink bridge listens here
> - `14550/udp` — QGroundControl connects here to upload missions and control the vehicle

> **Firewall note:** If UDP packets don't arrive, go to System Settings → Network → Firewall and ensure Node.js is allowed incoming connections.

---

## Running

### Option A — Mock mode (no Docker required)

Launches both the mock server and the Vite frontend:

```bash
npm run server:mock   # Terminal 1 — MAVLink bridge (mock)
npm run dev           # Terminal 2 — Vite frontend
```

Or combined:

```bash
npm start
```

Open **http://localhost:5173** to see the 3D visualization with synthetic waypoints.

### Option B — Live PX4 SITL mode

```bash
# 1. Start Docker PX4 SITL first (see Step 3 above)

npm run server        # Terminal 1 — MAVLink bridge (live UDP :14540)
npm run dev           # Terminal 2 — Vite frontend
```

Or combined:

```bash
npm run start:live
```

### QGroundControl

Connect QGC to the PX4 SITL via UDP link: `localhost:14550`. Use QGC to:
1. Arm the vehicle and set flight modes
2. Upload a mission plan (waypoints appear in the 3D scene automatically)
3. Start the mission — active waypoint pulses green in real time

---

## Architecture

| Component | File | Description |
|---|---|---|
| MAVLink Bridge | `server.js` | Node.js UDP listener + WS broadcaster + mission protocol |
| Frontend App | `index.js` | Three.js scene, drone model, route renderer, WS client, HUD |
| HTML Entry | `index.html` | Canvas + HUD panel layout |
| Design System | `style.css` | Dark-mode CSS tokens, glassmorphism, animations |

### Payload camera frame API

The simulated EO camera is exposed as `window.gokturkPayloadCamera` for future
OpenCV.js, TensorFlow.js, ONNX Runtime Web, or WebSocket streaming integrations:

```js
// Read one RGBA frame.
const imageData = window.gokturkPayloadCamera.captureImageData(640, 360);

// Subscribe without forcing pixel readback on every rendered frame.
const unsubscribe = window.gokturkPayloadCamera.onFrame(({ getImageData, state }) => {
  const frame = getImageData(320, 180);
  // Run detection/tracking here.
}, { fps: 5 });

// Save or upload an encoded frame.
const pngBlob = await window.gokturkPayloadCamera.captureBlob();
```

### Telemetry JSON format (WS :8080)

```json
{
  "attitude":  { "roll": 0.0, "pitch": 0.0, "yaw": 0.0, "rollspeed": 0.0, "pitchspeed": 0.0, "yawspeed": 0.0 },
  "position":  { "lat": 0.0, "lon": 0.0, "alt": 0.0, "relative_alt": 0.0, "vx": 0, "vy": 0, "vz": 0 },
  "battery":   { "voltage": 0.0, "current": 0.0, "remaining": -1 },
  "vfr":       { "airspeed": 0.0, "groundspeed": 0.0, "heading": 0, "throttle": 0, "climb": 0.0 },
  "status":    { "armed": false, "mode": "MANUAL", "connected": true, "active_wp": -1 },
  "route":     [{ "seq": 0, "lat": 37.5748, "lon": 36.9445, "alt": 50 }],
  "timestamp": 1234567890
}
```

### MAVLink messages consumed

| MAVLink ID | Message | Fields used |
|---|---|---|
| 0  | `HEARTBEAT` | `base_mode`, `custom_mode` (PX4 main/sub mode decoding) |
| 30 | `ATTITUDE` | `roll`, `pitch`, `yaw`, speeds |
| 33 | `GLOBAL_POSITION_INT` | `lat`, `lon`, `alt`, `relative_alt` |
| 1  | `SYS_STATUS` | `voltage_battery`, `current_battery`, `battery_remaining` |
| 74 | `VFR_HUD` | `airspeed`, `groundspeed`, `heading`, `throttle`, `climb` |
| 44 | `MISSION_COUNT` | `count` |
| 73 | `MISSION_ITEM_INT` | `seq`, `command`, `x`, `y`, `z` |
| 42 | `MISSION_CURRENT` | `seq` (active waypoint) |
| 47 | `MISSION_ACK` | `type` |

---

## Gelecek Yol Haritası / Future Roadmap (TODO)

- [x] **ArduPilot yerine PX4 kullanımı (Switch to PX4 Autopilot):** ArduPilot SITL simülasyonu yerine PX4 SITL entegrasyonu gerçekleştirildi ve MAVLink köprüsü PX4 uyumlu hale getirildi.
- [x] **QGroundControl Rota ve Harita Entegrasyonu (QGC Route & Map Integration):** QGroundControl üzerinde tanımlanan uçuş rotaları ve harita verileri doğrudan Three.js 3D arayüzüne aktarılarak görselleştiriliyor.
- [ ] **Sanal Pixhawk ile Gerçekçi Çalıştırma Onayı (Virtual Pixhawk Validation):** Sistemin sanal bir Pixhawk (SITL/HITL) donanımı/simülasyonu ile uçtan uca gerçek zamanlı olarak kararlı çalıştığı doğrulanacak.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Docker daemon not running | Open Docker Desktop before running any `docker` commands |
| No UDP packets from Docker | Ensure `-p 14540:14540/udp` is in your docker run command (the `/udp` suffix is required) |
| `localhost` vs `0.0.0.0` | Server binds to `0.0.0.0` — if still failing, try adding `--network host` to docker run |
| macOS Firewall blocking | System Settings → Network → Firewall → Allow Node.js |
| Apple Silicon emulation slow | Enable "Rosetta" in Docker Desktop → Settings → Features in Development |
| `EADDRINUSE :8080` | Kill existing node process: `lsof -ti:8080 \| xargs kill` |
| Frontend not connecting | Confirm server is running on port 8080: `lsof -i:8080` |
| QGC mission not showing in 3D | Wait for heartbeat sync (~2s), then re-upload mission in QGC |
