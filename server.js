/**
 * server.js — Göktürk UAV MAVLink → WebSocket Bridge (PX4 Edition)
 *
 * Architecture:
 *   [PX4 SITL Docker] --(UDP :14540 MAVLink)--> [This Server] --(WS :8080 JSON)--> [Three.js Frontend]
 *
 * Usage:
 *   node server.js           → Live mode (expects PX4 SITL on UDP :14540)
 *   node server.js --mock    → Mock mode (generates synthetic telemetry, no Docker needed)
 */

'use strict';

// ─── PX4 Flight Mode Decoder ─────────────────────────────────────────────────
// PX4 encodes flight modes as a 32-bit custom_mode field:
//   Byte layout (little-endian uint32):
//     bits  0–15: reserved
//     bits 16–23: main_mode
//     bits 24–31: sub_mode

const PX4_MAIN_MODES = {
  1: 'MANUAL',
  2: 'ALTCTL',
  3: 'POSCTL',
  4: 'AUTO',
  5: 'ACRO',
  6: 'OFFBOARD',
  7: 'STABILIZED',
  8: 'RATTITUDE',
  10: 'TERMINATION',
};

const PX4_AUTO_SUB_MODES = {
  1: 'READY',
  2: 'TAKEOFF',
  3: 'LOITER',
  4: 'MISSION',
  5: 'RTL',
  6: 'LAND',
  7: 'FOLLOW_TARGET',
  8: 'PRECLAND',
  9: 'VTOL_TAKEOFF',
};

/**
 * Decode PX4 custom_mode uint32 into a human-readable mode string.
 * @param {number} customMode - The 32-bit custom_mode field from HEARTBEAT.
 * @returns {string} Human-readable mode name.
 */
function decodePX4Mode(customMode) {
  // Extract main_mode (byte 2, bits 16–23) and sub_mode (byte 3, bits 24–31)
  const mainMode = (customMode >> 16) & 0xFF;
  const subMode  = (customMode >> 24) & 0xFF;

  const mainName = PX4_MAIN_MODES[mainMode];
  if (!mainName) return `MODE_${customMode}`;

  // AUTO mode has sub-modes
  if (mainMode === 4 && subMode > 0) {
    const subName = PX4_AUTO_SUB_MODES[subMode] || `SUB_${subMode}`;
    return `AUTO_${subName}`;
  }

  return mainName;
}

const dgram   = require('dgram');
const { WebSocketServer } = require('ws');
const MAVLink = require('mavlink');

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  udp: {
    host: '0.0.0.0',   // Bind to all interfaces so Docker host-port-forward reaches us
    port: 14540,        // PX4 SITL companion API output port (QGC connects on 14550)
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
  status:   { armed: false, mode: 'UNKNOWN', system_status: 0, connected: false, active_wp: -1 },
  route:    [],          // Array of { seq, lat, lon, alt } waypoints from mission
  timestamp: Date.now(),
};

// Map base_mode bitmask to arm state (same for ArduPilot & PX4)
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
// Also generates a synthetic mission route with 6 waypoints.

if (IS_MOCK) {
  console.log('[MOCK] Mock mode active — generating synthetic telemetry');

  let t = 0; // time accumulator (seconds)
  const HOME_LAT = 37.5748; // Kahramanmaraş Sütçüimam University (KSU Avşar Campus)
  const HOME_LON = 36.9445;

  // ── Synthetic Mission Route ──────────────────────────────────────────────
  // 6 waypoints forming a hexagonal pattern around the home position
  const MOCK_ROUTE_RADIUS = 0.0015; // ~167 m
  const MOCK_WP_COUNT = 6;
  const mockRoute = [];
  for (let i = 0; i < MOCK_WP_COUNT; i++) {
    const angle = (i / MOCK_WP_COUNT) * Math.PI * 2;
    mockRoute.push({
      seq: i,
      lat: HOME_LAT + MOCK_ROUTE_RADIUS * Math.sin(angle),
      lon: HOME_LON + MOCK_ROUTE_RADIUS * Math.cos(angle),
      alt: 50 + (i % 3) * 10, // Vary altitude: 50, 60, 70, 50, 60, 70 m
    });
  }
  console.log(`[MOCK] Generated ${mockRoute.length} synthetic waypoints`);

  // Cycle active waypoint every ~8 seconds
  let mockActiveWp = 0;
  setInterval(() => {
    mockActiveWp = (mockActiveWp + 1) % MOCK_WP_COUNT;
  }, 8000);

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
        mode:          'AUTO_MISSION',
        system_status: 4, // MAV_STATE_ACTIVE
        connected:     true,
        active_wp:     mockActiveWp,
      },
      route: mockRoute,
      timestamp: Date.now(),
    };
  }, 50); // 20 Hz update rate

  process.on('SIGINT', () => {
    console.log('\n[MOCK] Shutting down mock server');
    process.exit(0);
  });
}

// ─── Live MAVLink Mode ────────────────────────────────────────────────────────
// Connects to PX4 SITL via UDP, parses MAVLink binary packets,
// and updates the shared telemetry state.

else {
  console.log(`[UDP] Binding MAVLink listener on ${CONFIG.udp.host}:${CONFIG.udp.port}`);
  console.log('[MAV] Waiting for MAVLink parser to initialize...');

  // Initialize the MAVLink parser
  // Args: sysid=1, compid=1, version="v1.0", definitions=["common"]
  // PX4 uses the common MAVLink dialect (not ardupilotmega)
  const mav = new MAVLink(null, 1, 1, 'v1.0', ['common']);

  // ── Mission Download State ──────────────────────────────────────────────
  let missionExpectedCount = 0;
  let missionItems = [];
  let missionDownloading = false;
  let udpSocket = null;       // set after bind
  let sitlRemote = null;      // { address, port } of the SITL sender

  /**
   * Send a MAVLink message buffer to the SITL via UDP.
   * Requires that we have received at least one packet so we know the remote address.
   */
  function sendToSitl(msgBuffer) {
    if (!udpSocket || !sitlRemote) return;
    udpSocket.send(msgBuffer, 0, msgBuffer.length, sitlRemote.port, sitlRemote.address);
  }

  /**
   * Request the full mission item list from the flight controller.
   */
  function requestMissionList() {
    if (missionDownloading) return;
    missionDownloading = true;
    missionItems = [];
    missionExpectedCount = 0;

    mav.createMessage('MISSION_REQUEST_LIST', {
      target_system:    1,
      target_component: 1,
      mission_type:     0, // MAV_MISSION_TYPE_MISSION
    }, (msg) => {
      console.log('[MISSION] Requesting mission list from FC...');
      sendToSitl(msg.buffer);
    });
  }

  /**
   * Request a single mission item by sequence number.
   */
  function requestMissionItem(seq) {
    // Try MISSION_REQUEST_INT first (preferred), fall back to MISSION_REQUEST
    const msgName = mav.getMessageID('MISSION_REQUEST_INT') >= 0
      ? 'MISSION_REQUEST_INT'
      : 'MISSION_REQUEST';

    mav.createMessage(msgName, {
      target_system:    1,
      target_component: 1,
      seq:              seq,
      mission_type:     0,
    }, (msg) => {
      sendToSitl(msg.buffer);
    });
  }

  /**
   * Send MISSION_ACK after receiving all items.
   */
  function sendMissionAck() {
    mav.createMessage('MISSION_ACK', {
      target_system:    1,
      target_component: 1,
      type:             0, // MAV_MISSION_ACCEPTED
      mission_type:     0,
    }, (msg) => {
      sendToSitl(msg.buffer);
    });
  }

  /**
   * Process a received mission item and store it.
   */
  function handleMissionItem(fields) {
    const item = {
      seq: fields.seq,
      lat: fields.x !== undefined ? fields.x / 1e7 : (fields.lat || 0),
      lon: fields.y !== undefined ? fields.y / 1e7 : (fields.lon || 0),
      alt: fields.z || 0,
    };

    // Only store NAV waypoints with valid coordinates (command 16 = MAV_CMD_NAV_WAYPOINT,
    // 22 = TAKEOFF, 21 = LAND, 20 = RTL, etc.)
    const navCommands = [16, 17, 18, 19, 20, 21, 22, 31, 82, 84, 85, 112, 113, 115, 195];
    if (navCommands.includes(fields.command) && (item.lat !== 0 || item.lon !== 0)) {
      missionItems.push(item);
    }

    // Request next item or finalize
    if (fields.seq + 1 < missionExpectedCount) {
      requestMissionItem(fields.seq + 1);
    } else {
      // All items received
      sendMissionAck();
      missionDownloading = false;

      // Sort by sequence and update telemetry
      missionItems.sort((a, b) => a.seq - b.seq);
      telemetry.route = missionItems.slice();
      console.log(`[MISSION] Downloaded ${telemetry.route.length} waypoints from FC`);
      telemetry.route.forEach((wp, i) => {
        console.log(`  WP${i}: seq=${wp.seq} lat=${wp.lat.toFixed(7)} lon=${wp.lon.toFixed(7)} alt=${wp.alt}m`);
      });
    }
  }

  mav.on('ready', () => {
    console.log('[MAV] MAVLink parser ready — starting UDP socket');

    // ── UDP Socket ──────────────────────────────────────────────────────────
    udpSocket = dgram.createSocket('udp4');

    udpSocket.on('error', (err) => {
      console.error('[UDP] Socket error:', err.message);
      udpSocket.close();
    });

    udpSocket.on('message', (data, rinfo) => {
      // Remember the remote address so we can send messages back
      if (!sitlRemote) {
        sitlRemote = { address: rinfo.address, port: rinfo.port };
        console.log(`[UDP] SITL remote detected at ${rinfo.address}:${rinfo.port}`);
      }
      // Feed raw bytes into the MAVLink parser
      mav.parse(data);
    });

    udpSocket.bind(CONFIG.udp.port, CONFIG.udp.host, () => {
      const addr = udpSocket.address();
      console.log(`[UDP] Listening for MAVLink packets on ${addr.address}:${addr.port}`);
      console.log('[UDP] Waiting for PX4 SITL packets...');
      console.log('[UDP] Ensure PX4 SITL is sending to this port via:');
      console.log('       docker run --rm -it \\');
      console.log('         -p 14540:14540/udp \\');
      console.log('         -p 14550:14550/udp \\');
      console.log('         px4io/px4-dev-simulation-focal \\');
      console.log('         bash -c "make px4_sitl gazebo"');
    });

    // ── Heartbeat ────────────────────────────────────────────────────────────
    let initialMissionRequested = false;

    mav.on('HEARTBEAT', (_msg, fields) => {
      const armed = isArmed(fields.base_mode);
      const mode  = decodePX4Mode(fields.custom_mode);

      if (armed !== telemetry.status.armed || mode !== telemetry.status.mode) {
        console.log(`[MAV] State: ${armed ? 'ARMED' : 'DISARMED'} | Mode: ${mode}`);
      }

      telemetry.status.armed         = armed;
      telemetry.status.mode          = mode;
      telemetry.status.system_status = fields.system_status;
      telemetry.status.connected     = true;

      // Request mission list once on first heartbeat
      if (!initialMissionRequested) {
        initialMissionRequested = true;
        // Small delay to ensure the parser is fully synced
        setTimeout(requestMissionList, 2000);
      }
    });

    // ── Mission Protocol Handlers ────────────────────────────────────────────

    // MISSION_COUNT — FC tells us how many items are in the mission
    mav.on('MISSION_COUNT', (_msg, fields) => {
      missionExpectedCount = fields.count;
      console.log(`[MISSION] FC reports ${fields.count} mission items`);
      if (fields.count > 0) {
        requestMissionItem(0);
      } else {
        missionDownloading = false;
        telemetry.route = [];
      }
    });

    // MISSION_ITEM_INT — preferred mission item format (int32 lat/lon × 1E7)
    mav.on('MISSION_ITEM_INT', (_msg, fields) => {
      handleMissionItem(fields);
    });

    // MISSION_ITEM — legacy fallback (float lat/lon)
    mav.on('MISSION_ITEM', (_msg, fields) => {
      // Convert float lat/lon to the same format
      const converted = { ...fields };
      if (converted.x !== undefined) {
        // Legacy format uses float x/y directly as lat/lon degrees
        converted.x = Math.round(converted.x * 1e7);
        converted.y = Math.round(converted.y * 1e7);
      }
      handleMissionItem(converted);
    });

    // MISSION_ACK — FC acknowledges our transaction; may also signal a new upload from QGC
    mav.on('MISSION_ACK', (_msg, fields) => {
      if (fields.type === 0) {
        console.log('[MISSION] FC acknowledged mission transaction');
      } else {
        console.warn(`[MISSION] FC NACK: type=${fields.type}`);
      }
    });

    // MISSION_CURRENT — tracks the currently active waypoint during flight
    mav.on('MISSION_CURRENT', (_msg, fields) => {
      if (telemetry.status.active_wp !== fields.seq) {
        console.log(`[MISSION] Active waypoint changed: ${fields.seq}`);
        telemetry.status.active_wp = fields.seq;
      }
    });

    // Detect new mission uploads from QGC by listening for MISSION_ITEM writes
    // When QGC uploads, it sends MISSION_COUNT first; re-download after a short delay
    let missionRedownloadTimer = null;
    const origMissionCountHandler = mav.listeners('MISSION_COUNT');
    mav.on('MISSION_COUNT', (_msg, fields) => {
      // If we're not currently downloading, someone (QGC) uploaded a new mission
      if (!missionDownloading && initialMissionRequested) {
        console.log('[MISSION] New mission upload detected from QGC, re-downloading...');
        clearTimeout(missionRedownloadTimer);
        missionRedownloadTimer = setTimeout(requestMissionList, 3000);
      }
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
