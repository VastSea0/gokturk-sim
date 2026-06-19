/**
 * server.js — Göktürk UAV MAVLink → WebSocket Bridge (PX4 Edition)
 *
 * Architecture:
 *   [PX4 SITL Docker] --(UDP :14540 MAVLink)--> [This Server] --(WS :8080 JSON)--> [Three.js Frontend]
 *
 * Usage:
 *   node server.js           → Live mode (expects PX4 SITL on UDP :14540)
 *   node server.js --mock    → Mock mode (generates synthetic telemetry, no Docker needed)
 *
 * MAVLink parsing: Native binary parser (MAVLink v1 + v2 framing) — no npm XML dependency.
 * Message IDs handled:
 *   #0   HEARTBEAT
 *   #30  ATTITUDE
 *   #33  GLOBAL_POSITION_INT
 *   #1   SYS_STATUS
 *   #74  VFR_HUD
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
  ws.send(JSON.stringify(telemetry));
  ws.on('close',  () => { connectedClients--; console.log(`[WS] Client disconnected (total: ${connectedClients})`); });
  ws.on('error',  (e) => console.error('[WS] Client error:', e.message));
});

function broadcastTelemetry() {
  if (wss.clients.size === 0) return;
  telemetry.timestamp = Date.now();
  const payload = JSON.stringify(telemetry);
  wss.clients.forEach((c) => { if (c.readyState === c.OPEN) c.send(payload); });
}

setInterval(broadcastTelemetry, Math.round(1000 / CONFIG.broadcastHz));
console.log(`[WS] WebSocket server listening on ws://localhost:${CONFIG.ws.port}`);

// ─── MAVLink Binary Parser ─────────────────────────────────────────────────────
/**
 * Lightweight stateful MAVLink v1 + v2 frame parser.
 * Calls onMessage(msgId, payload) for each validated frame.
 *
 * MAVLink v1 frame:  0xFE | LEN | SEQ | SYS | COMP | MSGID(1) | PAYLOAD(LEN) | CRC(2)
 * MAVLink v2 frame:  0xFD | LEN | INCOMP | COMP_FLAGS | SEQ | SYS | COMP | MSGID(3) | PAYLOAD(LEN) | CRC(2) [+SIG(13)]
 */
class MAVLinkParser {
  constructor(onMessage) {
    this._onMessage = onMessage;
    this._buf = Buffer.alloc(512);
    this._pos = 0;
    this._state = 'IDLE';
    this._expected = 0; // total expected frame bytes after magic byte
    this._isV2 = false;
  }

  feed(data) {
    for (let i = 0; i < data.length; i++) {
      const b = data[i];

      if (this._state === 'IDLE') {
        if (b === 0xFE) {          // MAVLink v1 magic
          this._isV2 = false;
          this._buf[0] = b;
          this._pos = 1;
          this._state = 'ACCUMULATE';
          this._expected = null;  // learn from byte 1
        } else if (b === 0xFD) {  // MAVLink v2 magic
          this._isV2 = true;
          this._buf[0] = b;
          this._pos = 1;
          this._state = 'ACCUMULATE';
          this._expected = null;
        }
        continue;
      }

      if (this._state === 'ACCUMULATE') {
        this._buf[this._pos] = b;
        this._pos++;

        // Learn total frame length once we have the payload-length byte
        if (this._pos === 2 && this._expected === null) {
          const payloadLen = b; // byte 1 = LEN
          if (this._isV2) {
            // v2 header = 10 bytes, crc = 2, optional sig = 0 (we won't validate)
            this._expected = 1 + 1 + 4 + 1 + 1 + 3 + payloadLen + 2; // total after magic
          } else {
            // v1 header = 6 bytes, crc = 2
            this._expected = 1 + 1 + 1 + 1 + 1 + payloadLen + 2; // total after magic
          }
        }

        // When we've accumulated the full frame:
        if (this._expected !== null && this._pos >= this._expected + 1) {
          this._processFrame();
          this._state = 'IDLE';
          this._pos = 0;
          this._expected = null;
        }
      }
    }
  }

  _processFrame() {
    const buf = this._buf;

    if (this._isV2) {
      // v2: magic(1) len(1) incompat(1) compat(1) seq(1) sysid(1) compid(1) msgid(3) payload(len) crc(2)
      const payloadLen = buf[1];
      const msgId      = buf[7] | (buf[8] << 8) | (buf[9] << 16);
      const payload    = Buffer.from(buf.subarray(10, 10 + payloadLen));
      this._onMessage(msgId, payload);
    } else {
      // v1: magic(1) len(1) seq(1) sysid(1) compid(1) msgid(1) payload(len) crc(2)
      const payloadLen = buf[1];
      const msgId      = buf[5];
      const payload    = Buffer.from(buf.subarray(6, 6 + payloadLen));
      this._onMessage(msgId, payload);
    }
  }
}

// ─── Message Decoders ─────────────────────────────────────────────────────────
// Each function reads the raw payload Buffer and returns the fields we care about.
// Field byte offsets match MAVLink XML definitions (fields sorted by type size, large first).

/** HEARTBEAT (#0) — 9 bytes
 *  uint32 custom_mode | uint8 type | uint8 autopilot | uint8 base_mode | uint8 system_status | uint8 mavlink_version
 */
function decodeHeartbeat(p) {
  if (p.length < 9) return null;
  return {
    custom_mode:    p.readUInt32LE(0),
    type:           p[4],
    autopilot:      p[5],
    base_mode:      p[6],
    system_status:  p[7],
  };
}

/** SYS_STATUS (#1) — 31 bytes (only need fields at specific offsets)
 *  uint32 sensors_present(×3) ... uint16 voltage_battery | int16 current_battery ... int8 battery_remaining
 *  Sorted fields (by type size): 3×uint32(0–11), 3×uint16(12–17), then ints, then uint8s.
 *  voltage_battery at offset 12, current_battery at offset 14, battery_remaining at offset 30.
 */
function decodeSysStatus(p) {
  if (p.length < 31) return null;
  return {
    voltage_battery:  p.readUInt16LE(12),   // mV
    current_battery:  p.readInt16LE(14),    // cA (-1 = unknown)
    battery_remaining:p.readInt8(30),       // % (-1 = unknown)
  };
}

/** ATTITUDE (#30) — 28 bytes
 *  uint32 time_boot_ms | float roll | float pitch | float yaw | float rollspeed | float pitchspeed | float yawspeed
 */
function decodeAttitude(p) {
  if (p.length < 28) return null;
  return {
    roll:       p.readFloatLE(4),
    pitch:      p.readFloatLE(8),
    yaw:        p.readFloatLE(12),
    rollspeed:  p.readFloatLE(16),
    pitchspeed: p.readFloatLE(20),
    yawspeed:   p.readFloatLE(24),
  };
}

/** GLOBAL_POSITION_INT (#33) — 28 bytes
 *  uint32 time_boot_ms | int32 lat | int32 lon | int32 alt | int32 relative_alt | int16 vx | int16 vy | int16 vz | uint16 hdg
 */
function decodeGlobalPositionInt(p) {
  if (p.length < 28) return null;
  return {
    lat:          p.readInt32LE(4),
    lon:          p.readInt32LE(8),
    alt:          p.readInt32LE(12),
    relative_alt: p.readInt32LE(16),
    vx:           p.readInt16LE(20),
    vy:           p.readInt16LE(22),
    vz:           p.readInt16LE(24),
  };
}

/** VFR_HUD (#74) — 20 bytes
 *  float airspeed | float groundspeed | float alt | float climb | int16 heading | uint16 throttle
 */
function decodeVfrHud(p) {
  if (p.length < 20) return null;
  return {
    airspeed:    p.readFloatLE(0),
    groundspeed: p.readFloatLE(4),
    alt:         p.readFloatLE(8),
    climb:       p.readFloatLE(12),
    heading:     p.readInt16LE(16),
    throttle:    p.readUInt16LE(18),
  };
}

// ─── Live MAVLink Mode ────────────────────────────────────────────────────────
if (!IS_MOCK) {
  const parser = new MAVLinkParser((msgId, payload) => {
    switch (msgId) {
      case 0: { // HEARTBEAT
        const f = decodeHeartbeat(payload);
        if (!f) break;
        const armed = isArmed(f.base_mode);
        const mode  = ARDUCOPTER_MODES[f.custom_mode] || `MODE_${f.custom_mode}`;
        if (armed !== telemetry.status.armed || mode !== telemetry.status.mode) {
          console.log(`[MAV] State: ${armed ? 'ARMED' : 'DISARMED'} | Mode: ${mode}`);
        }
        telemetry.status.armed         = armed;
        telemetry.status.mode          = mode;
        telemetry.status.system_status = f.system_status;
        telemetry.status.connected     = true;
        lastHeartbeat                  = Date.now();
        break;
      }
      case 30: { // ATTITUDE
        const f = decodeAttitude(payload);
        if (!f) break;
        telemetry.attitude = f;
        break;
      }
      case 33: { // GLOBAL_POSITION_INT
        const f = decodeGlobalPositionInt(payload);
        if (!f) break;
        telemetry.position = {
          lat:          f.lat          / 1e7,
          lon:          f.lon          / 1e7,
          alt:          f.alt          / 1000,
          relative_alt: f.relative_alt / 1000,
          vx: f.vx, vy: f.vy, vz: f.vz,
        };
        break;
      }
      case 1: { // SYS_STATUS
        const f = decodeSysStatus(payload);
        if (!f) break;
        telemetry.battery = {
          voltage:   f.voltage_battery  / 1000,
          current:   f.current_battery  / 100,
          remaining: f.battery_remaining,
        };
        break;
      }
      case 74: { // VFR_HUD
        const f = decodeVfrHud(payload);
        if (!f) break;
        telemetry.vfr = {
          airspeed:    f.airspeed,
          groundspeed: f.groundspeed,
          heading:     f.heading,
          throttle:    f.throttle,
          climb:       f.climb,
        };
        break;
      }
    }
  });

  // Heartbeat watchdog
  let lastHeartbeat = Date.now();
  setInterval(() => {
    if (Date.now() - lastHeartbeat > 5000 && telemetry.status.connected) {
      console.warn('[MAV] No heartbeat for 5s — marking disconnected');
      telemetry.status.connected = false;
      telemetry.status.armed     = false;
    }
  }, 2000);

  // UDP socket
  const udpSocket = dgram.createSocket('udp4');

  udpSocket.on('error', (err) => {
    console.error('[UDP] Socket error:', err.message);
    udpSocket.close();
  });

  udpSocket.on('message', (data, rinfo) => {
    parser.feed(data);
  });

  udpSocket.bind(CONFIG.udp.port, CONFIG.udp.host, () => {
    const addr = udpSocket.address();
    console.log(`[UDP] Listening for MAVLink on ${addr.address}:${addr.port}`);
    console.log('[UDP] Now start the SITL Docker container:');
    console.log('');
    console.log('  docker run -it --rm --platform linux/amd64 \\');
    console.log('    -e LAT=37.5748 -e LON=36.9445 -e ALT=584 -e DIR=0 \\');
    console.log('    radarku/ardupilot-sitl \\');
    console.log('    --out=udp:host.docker.internal:14550 \\');
    console.log('    --out=udp:host.docker.internal:14551');
    console.log('');
    console.log('[UDP] QGC: connect via UDP link to localhost:14550');
    console.log('[UDP] Waiting for packets...');
  });

  process.on('SIGINT', () => {
    console.log('\n[LIVE] Shutting down');
    process.exit(0);
  });
}

// ─── Mock Mode ────────────────────────────────────────────────────────────────
// Generates synthetic sinusoidal telemetry so you can develop and test the
// Three.js frontend without needing the Docker SITL running.
// Also generates a synthetic mission route with 6 waypoints.

if (IS_MOCK) {
  console.log('[MOCK] Mock mode active — generating synthetic telemetry');

  let t = 0;
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
    const altitude    = 50 + Math.sin(t * 0.3) * 10;
    const roll        = Math.sin(t * 0.7) * 0.35;
    const pitch       = Math.sin(t * 0.5) * 0.2;
    const yaw         = (t * 0.2) % (Math.PI * 2);
    const groundspeed = 8 + Math.sin(t * 0.4) * 3;
    const airspeed    = groundspeed + 1.5;
    const throttle    = Math.round(40 + Math.sin(t * 0.6) * 20);
    const lat         = HOME_LAT + 0.001 * Math.sin(t * 0.15);
    const lon         = HOME_LON + 0.001 * Math.cos(t * 0.15);

    telemetry = {
      attitude: {
        roll, pitch, yaw,
        rollspeed: Math.cos(t * 0.7) * 0.1,
        pitchspeed: Math.cos(t * 0.5) * 0.05,
        yawspeed: 0.2,
      },
      position: {
        lat, lon,
        alt:          altitude + 584,
        relative_alt: altitude,
        vx: Math.sin(yaw) * groundspeed * 100,
        vy: Math.cos(yaw) * groundspeed * 100,
        vz: Math.sin(t * 0.3) * 30,
      },
      battery: {
        voltage:   16.4 - t * 0.002,
        current:   12.5 + Math.sin(t) * 2,
        remaining: Math.max(0, Math.round(100 - t * 0.1)),
      },
      vfr: {
        airspeed, groundspeed,
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
  }, 50);

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
