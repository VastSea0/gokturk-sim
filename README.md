# Göktürk UAV — Real-Time 3D SITL Telemetry Visualization

Real-time 3D UAV simulation visualizer that streams MAVLink telemetry from an ArduPilot SITL running inside Docker to a premium Three.js frontend via a Node.js WebSocket bridge.

```
[Docker SITL] --(UDP :14551 MAVLink)--> [Node.js Bridge] --(WS :8080 JSON)--> [Three.js Frontend]
```

## Features

- **Real-time 3D drone** — procedural quadcopter model with spinning props, LED lights, flight trail
- **Premium HUD** — glassmorphism panels with attitude indicator (ADI), battery, GPS, VFR data
- **NED → Three.js** — correct aerospace coordinate transform (roll/pitch/yaw to Y-up scene)
- **Mock mode** — synthetic sinusoidal telemetry, no Docker needed for frontend development
- **Auto-reconnect** — WebSocket client reconnects automatically on server restart

---

## Setup

### 1. Install dependencies

```bash
npm install
npm install --save-dev concurrently
```

### 2. Pull and run the ArduPilot SITL Docker image

```bash
docker pull radarku/ardupilot-sitl

docker run -it --rm \
  --platform linux/amd64 \
  -p 5760:5760 \
  -p 14550:14550/udp \
  -p 14551:14551/udp \
  radarku/ardupilot-sitl
```

> **macOS / Apple Silicon note:** The image runs under Rosetta 2 x86_64 emulation via Docker Desktop. Ensure Docker Desktop has "Use Rosetta for x86/amd64 emulation" enabled in Settings → Features in Development.

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

Open **http://localhost:5173** to see the 3D visualization.

### Option B — Live SITL mode

```bash
# 1. Start Docker SITL first (see Step 2 above)

npm run server        # Terminal 1 — MAVLink bridge (live UDP)
npm run dev           # Terminal 2 — Vite frontend
```

Or combined:

```bash
npm run start:live
```

### QGroundControl

Connect QGC to the SITL via UDP link: `localhost:14550`. Use QGC to arm the vehicle, set flight modes, and trigger takeoff missions. The 3D frontend will mirror the telemetry in real time.

---

## Architecture

| Component | File | Description |
|---|---|---|
| MAVLink Bridge | `server.js` | Node.js UDP listener + WS broadcaster |
| Frontend App | `index.js` | Three.js scene, drone model, WS client, HUD logic |
| HTML Entry | `index.html` | Canvas + HUD panel layout |
| Design System | `style.css` | Dark-mode CSS tokens, glassmorphism, animations |

### Telemetry JSON format (WS :8080)

```json
{
  "attitude":  { "roll": 0.0, "pitch": 0.0, "yaw": 0.0, "rollspeed": 0.0, "pitchspeed": 0.0, "yawspeed": 0.0 },
  "position":  { "lat": 0.0, "lon": 0.0, "alt": 0.0, "relative_alt": 0.0, "vx": 0, "vy": 0, "vz": 0 },
  "battery":   { "voltage": 0.0, "current": 0.0, "remaining": -1 },
  "vfr":       { "airspeed": 0.0, "groundspeed": 0.0, "heading": 0, "throttle": 0, "climb": 0.0 },
  "status":    { "armed": false, "mode": "STABILIZE", "connected": true },
  "timestamp": 1234567890
}
```

### MAVLink messages consumed

| MAVLink ID | Message | Fields used |
|---|---|---|
| 0  | `HEARTBEAT` | `base_mode`, `system_status` |
| 30 | `ATTITUDE` | `roll`, `pitch`, `yaw`, speeds |
| 33 | `GLOBAL_POSITION_INT` | `lat`, `lon`, `alt`, `relative_alt` |
| 1  | `SYS_STATUS` | `voltage_battery`, `current_battery`, `battery_remaining` |
| 74 | `VFR_HUD` | `airspeed`, `groundspeed`, `heading`, `throttle`, `climb` |


---

## Gelecek Yol Haritası / Future Roadmap (TODO)

- [ ] **ArduPilot yerine PX4 kullanımı (Switch to PX4 Autopilot):** ArduPilot SITL simülasyonu yerine PX4 SITL entegrasyonu gerçekleştirilecek ve MAVLink köprüsü PX4 uyumlu hale getirilecek.
- [ ] **QGroundControl Rota ve Harita Entegrasyonu (QGC Route & Map Integration):** QGroundControl üzerinde tanımlanan uçuş rotaları ve harita verileri doğrudan Three.js 3D arayüzüne aktarılarak görselleştirilecek.
- [ ] **Sanal Pixhawk ile Gerçekçi Çalıştırma Onayı (Virtual Pixhawk Validation):** Sistemin sanal bir Pixhawk (SITL/HITL) donanımı/simülasyonu ile uçtan uca gerçek zamanlı olarak kararlı çalıştığı doğrulanacak.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| No UDP packets from Docker | Ensure `-p 14551:14551/udp` is in your docker run command (the `/udp` suffix is required) |
| `localhost` vs `0.0.0.0` | Server binds to `0.0.0.0` — if still failing, try adding `--network host` to docker run |
| macOS Firewall blocking | System Settings → Network → Firewall → Allow Node.js |
| Apple Silicon emulation slow | Enable "Rosetta" in Docker Desktop → Settings → Features in Development |
| `EADDRINUSE :8080` | Kill existing node process: `lsof -ti:8080 \| xargs kill` |
| Frontend not connecting | Confirm server is running on port 8080: `lsof -i:8080` |