/**
 * server.js — Göktürk UAV MAVLink → WebSocket Bridge
 *
 * Architecture:
 *   [Docker SITL] --(UDP :14551 MAVLink)--> [This Server] --(WS :8080 JSON)--> [Three.js Frontend]
 *
 * Usage:
 *   node server.js           → Live mode (expects SITL on UDP :14551)
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

const dgram = require('dgram');
const { WebSocketServer } = require('ws');

// ─── ArduCopter Flight Mode Map ───────────────────────────────────────────────
const ARDUCOPTER_MODES = {
   0: 'STABILIZE',  1: 'ACRO',        2: 'ALT_HOLD',   3: 'AUTO',
   4: 'GUIDED',     5: 'LOITER',      6: 'RTL',         7: 'CIRCLE',
   9: 'LAND',      11: 'DRIFT',      13: 'SPORT',      14: 'FLIP',
  15: 'AUTOTUNE',  16: 'POSHOLD',    17: 'BRAKE',      18: 'THROW',
  19: 'AVOID_ADSB',20: 'GUIDED_NOGPS',21:'SMART_RTL',  22: 'FLOWHOLD',
  23: 'FOLLOW',    24: 'ZIGZAG',     25: 'SYSTEMID',   26: 'AUTOROTATE',
  27: 'AUTO_RTL',
};

// ─── Configuration ────────────────────────────────────────────────────────────
const CONFIG = {
  udp: { host: '0.0.0.0', port: 14551 },
  ws:  { port: 8080 },
  broadcastHz: 20,
};

const IS_MOCK = process.argv.includes('--mock');

// ─── Shared Telemetry State ───────────────────────────────────────────────────
let telemetry = {
  attitude: { roll: 0, pitch: 0, yaw: 0, rollspeed: 0, pitchspeed: 0, yawspeed: 0 },
  position: { lat: 0, lon: 0, alt: 0, relative_alt: 0, vx: 0, vy: 0, vz: 0 },
  battery:  { voltage: 0, current: 0, remaining: -1 },
  vfr:      { airspeed: 0, groundspeed: 0, heading: 0, throttle: 0, climb: 0 },
  status:   { armed: false, mode: 'UNKNOWN', system_status: 0, connected: false },
  timestamp: Date.now(),
};

function isArmed(base_mode) { return (base_mode & 128) !== 0; }

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
else {
  console.log('[MOCK] Mock mode active — generating synthetic telemetry');

  let t = 0;
  const HOME_LAT = 37.5748; // Kahramanmaraş Sütçüimam University (KSU Avşar Campus)
  const HOME_LON = 36.9445;

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
        armed: true, mode: 'AUTO', system_status: 4, connected: true,
      },
      timestamp: Date.now(),
    };
  }, 50);

  process.on('SIGINT', () => { console.log('\n[MOCK] Shutting down'); process.exit(0); });
}
