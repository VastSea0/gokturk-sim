/**
 * server.js — Göktürk UAV MAVLink → WebSocket Bridge
 *
 * Architecture:
 *   [Docker SITL] --(UDP :14551 MAVLink)--> [This Server] --(WS :8080 JSON)--> [Three.js Frontend]
 *
 * Usage:
 *   node server.js           → Live mode (expects SITL on UDP :14551)
 *   node server.js --mock    → Mock mode (generates synthetic telemetry, no Docker needed)
 */

'use strict';

const dgram   = require('dgram');
const { WebSocketServer } = require('ws');
const MAVLink = require('mavlink');

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  udp: {
    host: '0.0.0.0',   // Bind to all interfaces so Docker host-port-forward reaches us
    port: 14551,        // ArduPilot SITL output port (NOT 14550 which QGC uses)
  },
  ws: {
    port: 8080,
  },
  telemetry: {
    broadcastHz: 20,    // How often to push telemetry to frontend clients
  },
};

const IS_MOCK = process.argv.includes('--mock');

// ─── Shared Telemetry State ───────────────────────────────────────────────────
// This object is continuously updated by MAVLink listeners (or mock generator)
// and broadcast to WebSocket clients on a fixed interval.

let telemetry = {
  attitude: { roll: 0, pitch: 0, yaw: 0, rollspeed: 0, pitchspeed: 0, yawspeed: 0 },
  position: { lat: 0, lon: 0, alt: 0, relative_alt: 0, vx: 0, vy: 0, vz: 0 },
  battery:  { voltage: 0, current: 0, remaining: -1 },
  vfr:      { airspeed: 0, groundspeed: 0, heading: 0, throttle: 0, climb: 0 },
  status:   { armed: false, mode: 'UNKNOWN', system_status: 0, connected: false },
  timestamp: Date.now(),
};

// Map ArduPilot base_mode bitmask to human-readable arm state
function isArmed(base_mode) {
  return (base_mode & 128) !== 0; // MAV_MODE_FLAG_SAFETY_ARMED = 128
}

// ─── WebSocket Server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: CONFIG.ws.port });
let connectedClients = 0;

wss.on('connection', (ws) => {
  connectedClients++;
  console.log(`[WS] Client connected (total: ${connectedClients})`);

  // Send current state immediately on connect
  ws.send(JSON.stringify(telemetry));

  ws.on('close', () => {
    connectedClients--;
    console.log(`[WS] Client disconnected (total: ${connectedClients})`);
  });

  ws.on('error', (err) => {
    console.error('[WS] Client error:', err.message);
  });
});

wss.on('error', (err) => {
  console.error('[WS] Server error:', err.message);
});

/** Broadcast current telemetry state to all connected clients. */
function broadcastTelemetry() {
  if (wss.clients.size === 0) return;
  telemetry.timestamp = Date.now();
  const payload = JSON.stringify(telemetry);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  });
}

// Start broadcast loop at configured Hz
const broadcastInterval = Math.round(1000 / CONFIG.telemetry.broadcastHz);
setInterval(broadcastTelemetry, broadcastInterval);

console.log(`[WS] WebSocket server listening on ws://localhost:${CONFIG.ws.port}`);

// ─── Mock Mode ────────────────────────────────────────────────────────────────
// Generates synthetic sinusoidal telemetry so you can develop and test the
// Three.js frontend without needing the Docker SITL running.

if (IS_MOCK) {
  console.log('[MOCK] Mock mode active — generating synthetic telemetry');

  let t = 0; // time accumulator (seconds)
  const HOME_LAT = 39.9334; // Ankara, Turkey (approximate)
  const HOME_LON = 32.8597;

  setInterval(() => {
    t += 0.05;

    // Simulate a gentle oscillating flight
    const altitude   = 50 + Math.sin(t * 0.3) * 10;        // 40–60 m
    const roll       = Math.sin(t * 0.7) * 0.35;            // ±20°
    const pitch      = Math.sin(t * 0.5) * 0.2;             // ±11°
    const yaw        = (t * 0.2) % (Math.PI * 2);           // slowly rotating
    const groundspeed = 8 + Math.sin(t * 0.4) * 3;          // 5–11 m/s
    const airspeed   = groundspeed + 1.5;
    const throttle   = Math.round(40 + Math.sin(t * 0.6) * 20); // 20–60%

    // Simulate circular orbit around home
    const orbitRadius = 0.001; // ~111 m
    const lat = HOME_LAT + orbitRadius * Math.sin(t * 0.15);
    const lon = HOME_LON + orbitRadius * Math.cos(t * 0.15);

    telemetry = {
      attitude: {
        roll,
        pitch,
        yaw,
        rollspeed:  Math.cos(t * 0.7) * 0.1,
        pitchspeed: Math.cos(t * 0.5) * 0.05,
        yawspeed:   0.2,
      },
      position: {
        lat,
        lon,
        alt:          altitude + 800, // MSL (Ankara ~880 m ASL)
        relative_alt: altitude,
        vx: Math.sin(yaw) * groundspeed * 100,  // cm/s
        vy: Math.cos(yaw) * groundspeed * 100,
        vz: Math.sin(t * 0.3) * 30,
      },
      battery: {
        voltage:   16.4 - t * 0.002,  // Slowly draining 4S pack
        current:   12.5 + Math.sin(t) * 2,
        remaining: Math.max(0, Math.round(100 - t * 0.1)),
      },
      vfr: {
        airspeed,
        groundspeed,
        heading:  Math.round((yaw * 180 / Math.PI + 360) % 360),
        throttle,
        climb:    Math.cos(t * 0.3) * 1.5,
      },
      status: {
        armed:         true,
        mode:          'AUTO',
        system_status: 4, // MAV_STATE_ACTIVE
        connected:     true,
      },
      timestamp: Date.now(),
    };
  }, 50); // 20 Hz update rate

  process.on('SIGINT', () => {
    console.log('\n[MOCK] Shutting down mock server');
    process.exit(0);
  });
}

// ─── Live MAVLink Mode ────────────────────────────────────────────────────────
// Connects to ArduPilot SITL via UDP, parses MAVLink binary packets,
// and updates the shared telemetry state.

else {
  console.log(`[UDP] Binding MAVLink listener on ${CONFIG.udp.host}:${CONFIG.udp.port}`);
  console.log('[MAV] Waiting for MAVLink parser to initialize...');

  // Initialize the MAVLink parser
  // Args: sysid=1, compid=1, version="v1.0", definitions=["common","ardupilotmega"]
  const mav = new MAVLink(null, 1, 1, 'v1.0', ['common', 'ardupilotmega']);

  mav.on('ready', () => {
    console.log('[MAV] MAVLink parser ready — starting UDP socket');

    // ── UDP Socket ──────────────────────────────────────────────────────────
    const udpSocket = dgram.createSocket('udp4');

    udpSocket.on('error', (err) => {
      console.error('[UDP] Socket error:', err.message);
      udpSocket.close();
    });

    udpSocket.on('message', (data) => {
      // Feed raw bytes into the MAVLink parser
      mav.parse(data);
    });

    udpSocket.bind(CONFIG.udp.port, CONFIG.udp.host, () => {
      const addr = udpSocket.address();
      console.log(`[UDP] Listening for MAVLink packets on ${addr.address}:${addr.port}`);
      console.log('[UDP] Make sure Docker is running: docker run -it --rm --platform linux/amd64 \\');
      console.log('       -p 14550:14550/udp -p 14551:14551/udp radarku/ardupilot-sitl');
    });

    // ── Heartbeat ────────────────────────────────────────────────────────────
    mav.on('HEARTBEAT', (_msg, fields) => {
      telemetry.status.armed         = isArmed(fields.base_mode);
      telemetry.status.system_status = fields.system_status;
      telemetry.status.connected     = true;
    });

    // ── Attitude ─────────────────────────────────────────────────────────────
    // All values are in radians — sent as-is; frontend handles axis conversion
    mav.on('ATTITUDE', (_msg, fields) => {
      telemetry.attitude = {
        roll:       fields.roll,
        pitch:      fields.pitch,
        yaw:        fields.yaw,
        rollspeed:  fields.rollspeed,
        pitchspeed: fields.pitchspeed,
        yawspeed:   fields.yawspeed,
      };
    });

    // ── Global Position ───────────────────────────────────────────────────────
    // lat/lon come as int32 scaled ×1E7; alt/relative_alt as int32 ×1000 (mm → m)
    mav.on('GLOBAL_POSITION_INT', (_msg, fields) => {
      telemetry.position = {
        lat:          fields.lat          / 1e7,
        lon:          fields.lon          / 1e7,
        alt:          fields.alt          / 1000, // MSL meters
        relative_alt: fields.relative_alt / 1000, // AGL meters
        vx:           fields.vx,
        vy:           fields.vy,
        vz:           fields.vz,
      };
    });

    // ── System Status (Battery) ───────────────────────────────────────────────
    // voltage in mV, current in cA
    mav.on('SYS_STATUS', (_msg, fields) => {
      telemetry.battery = {
        voltage:   fields.voltage_battery   / 1000, // mV → V
        current:   fields.current_battery   / 100,  // cA → A
        remaining: fields.battery_remaining,         // percent (0–100 or -1 unknown)
      };
    });

    // ── VFR HUD ──────────────────────────────────────────────────────────────
    mav.on('VFR_HUD', (_msg, fields) => {
      telemetry.vfr = {
        airspeed:    fields.airspeed,
        groundspeed: fields.groundspeed,
        heading:     fields.heading,
        throttle:    fields.throttle,
        climb:       fields.climb,
      };
    });

    // ── Connection timeout watchdog ──────────────────────────────────────────
    // Mark as disconnected if no heartbeat arrives within 5 seconds
    let lastHeartbeat = Date.now();
    mav.on('HEARTBEAT', () => { lastHeartbeat = Date.now(); });
    setInterval(() => {
      if (Date.now() - lastHeartbeat > 5000) {
        if (telemetry.status.connected) {
          console.warn('[MAV] No heartbeat received in 5s — marking as disconnected');
          telemetry.status.connected = false;
          telemetry.status.armed     = false;
        }
      }
    }, 2000);
  });

  mav.on('error', (err) => {
    console.error('[MAV] Parser error:', err);
  });

  process.on('SIGINT', () => {
    console.log('\n[LIVE] Shutting down MAVLink bridge');
    process.exit(0);
  });
}
