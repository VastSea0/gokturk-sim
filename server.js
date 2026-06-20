/**
 * server.js — Göktürk UAV MAVLink SITL Autopilot Simulator & WebSocket Bridge
 *
 * Architecture:
 *   [QGroundControl :14550] <--(MAVLink UDP 14540)--> [This Simulator] --(WS :8080 JSON)--> [Three.js Frontend]
 *
 * This server acts as a native software-in-the-loop (SITL) UAV. It simulates
 * a virtual drone, updates flight dynamics (Armed, Takeoff, Landing, RTL, Waypoints),
 * communicates with QGroundControl over MAVLink, and streams telemetry to the web UI.
 */

'use strict';

const express = require('express');
const http = require('http');
const dgram = require('dgram');
const { WebSocketServer } = require('ws');
const MAVLink = require('mavlink');

// ─── Configuration ──────────────────────────────────────────────────────────
const CONFIG = {
  udp: {
    host: '0.0.0.0',
    localPort: 14540,
    qgcHost: '127.0.0.1',
    qgcPort: 14550,
  },
  ws: {
    port: 8080,
  },
  telemetry: {
    rateHz: 20, // rate of physics solver & WS telemetry stream (50ms interval)
  }
};

// ─── Home Coordinates (Kahramanmaraş Sütçüimam University) ───────────────────
const HOME_LAT = 37.5748;
const HOME_LON = 36.9445;
const HOME_ALT = 584; // elevation in meters
const MPDL = 111319.5; // meters per degree latitude
const cosLat = Math.cos(HOME_LAT * Math.PI / 180);

// Generate default hexagonal route (used if no mission is uploaded)
const MOCK_ROUTE_RADIUS = 0.0015; // ~167 m
const MOCK_WP_COUNT = 6;
const defaultMockRoute = [];
for (let i = 0; i < MOCK_WP_COUNT; i++) {
  const angle = (i / MOCK_WP_COUNT) * Math.PI * 2;
  defaultMockRoute.push({
    seq: i,
    lat: HOME_LAT + MOCK_ROUTE_RADIUS * Math.sin(angle),
    lon: HOME_LON + MOCK_ROUTE_RADIUS * Math.cos(angle),
    alt: 50 + (i % 3) * 10,
  });
}

// ─── Simulation State ────────────────────────────────────────────────────────
let simState = {
  armed: false,
  flightMode: 'POSCTL', // PX4 custom modes: POSCTL, AUTO_TAKEOFF, AUTO_MISSION, AUTO_LAND, AUTO_RTL
  lat: HOME_LAT,
  lon: HOME_LON,
  alt: 0, // AGL relative altitude (meters)
  yaw: 0, // heading in radians
  roll: 0,
  pitch: 0,
  speed: 0,
  climb: 0,
  active_wp: 0,
  battery_remaining: 100,
  route: defaultMockRoute.slice(),
  is_taking_off: false,
  takeoff_alt: 10,
  is_landing: false,
  is_rtl: false,
  time_boot_ms: 0
};

// Target coordinates for mission/RTL
let target_lat = HOME_LAT;
let target_lon = HOME_LON;
let target_alt = 0;

// Telemetry structure shared with Frontend
let telemetry = {
  attitude: { roll: 0, pitch: 0, yaw: 0, rollspeed: 0, pitchspeed: 0, yawspeed: 0 },
  position: { lat: HOME_LAT, lon: HOME_LON, alt: HOME_ALT, relative_alt: 0, vx: 0, vy: 0, vz: 0 },
  battery:  { voltage: 16.8, current: 0.5, remaining: 100 },
  vfr:      { airspeed: 0, groundspeed: 0, heading: 0, throttle: 0, climb: 0 },
  status:   { armed: false, mode: 'POSCTL', system_status: 3, connected: true, active_wp: 0 },
  route:    simState.route,
  timestamp: Date.now(),
};

// ─── Express & HTTP & WebSocket Server ──────────────────────────────────────
const app = express();
app.get('/health', (req, res) => res.json({ status: 'running', armed: simState.armed, mode: simState.flightMode }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let connectedClients = 0;

wss.on('connection', (ws) => {
  connectedClients++;
  console.log(`[WS] Client connected (total: ${connectedClients})`);
  ws.send(JSON.stringify(telemetry));

  ws.on('message', (messageData) => {
    try {
      const data = JSON.parse(messageData);
      console.log(`[WS] Command from UI:`, data.type);
      
      switch (data.type) {
        case 'arm':
          simState.armed = !!data.value;
          if (simState.armed) {
            simState.battery_remaining = 100;
            if (simState.alt < 0.5) {
              // Trigger auto takeoff if arming on ground
              simState.is_taking_off = true;
              simState.takeoff_alt = 10;
              simState.flightMode = 'AUTO_TAKEOFF';
            }
          } else {
            simState.flightMode = 'POSCTL';
          }
          break;
        case 'reset':
          simState.armed = false;
          simState.lat = simState.route.length > 0 ? simState.route[0].lat : HOME_LAT;
          simState.lon = simState.route.length > 0 ? simState.route[0].lon : HOME_LON;
          simState.alt = 0;
          simState.yaw = 0;
          simState.roll = 0;
          simState.pitch = 0;
          simState.speed = 0;
          simState.climb = 0;
          simState.active_wp = 0;
          simState.battery_remaining = 100;
          simState.is_taking_off = false;
          simState.is_landing = false;
          simState.is_rtl = false;
          simState.flightMode = 'POSCTL';
          break;
        case 'set_route':
          if (Array.isArray(data.route)) {
            simState.route = data.route;
            simState.active_wp = 0;
            console.log(`[WS] Route updated via UI. Waypoints: ${data.route.length}`);
            if (data.route.length > 0) {
              simState.lat = data.route[0].lat;
              simState.lon = data.route[0].lon;
              simState.alt = 0;
            }
            telemetry.route = simState.route;
          }
          break;
      }
      broadcastTelemetry();
    } catch (e) {
      console.error('[WS] Failed to parse message from client:', e.message);
    }
  });

  ws.on('close', () => { connectedClients--; console.log(`[WS] Client disconnected (total: ${connectedClients})`); });
  ws.on('error', (e) => console.error('[WS] Client error:', e.message));
});

function broadcastTelemetry() {
  if (wss.clients.size === 0) return;
  telemetry.timestamp = Date.now();
  const payload = JSON.stringify(telemetry);
  wss.clients.forEach((c) => { if (c.readyState === c.OPEN) c.send(payload); });
}

server.listen(CONFIG.ws.port, () => {
  console.log(`[HTTP/WS] Express & WebSocket listening on port ${CONFIG.ws.port}`);
});

// ─── MAVLink Parser Correct Initialization ─────────────────────────────────
// corrected arguments: sysid=1, compid=1, version='v1.0', dialects=['common']
const mav = new MAVLink(1, 1, 'v1.0', ['common']);
let mavReady = false;

// ─── UDP Socket for QGroundControl MAVLink Link ──────────────────────────────
const udpSocket = dgram.createSocket('udp4');

function sendToQGC(msgBuffer) {
  udpSocket.send(msgBuffer, 0, msgBuffer.length, CONFIG.udp.qgcPort, CONFIG.udp.qgcHost, (err) => {
    if (err) console.error('[UDP] Error sending MAVLink packet:', err);
  });
}

// ─── QGC Custom Modes & Handshakes ──────────────────────────────────────────
function getHeartbeatModes() {
  let customMode = 0;
  let baseMode = 81; // MAV_MODE_FLAG_CUSTOM_MODE_ENABLED = 1, MAV_MODE_FLAG_STABILIZE_ENABLED = 16, MAV_MODE_FLAG_MANUAL_INPUT_ENABLED = 64
  
  if (simState.armed) {
    baseMode += 128; // MAV_MODE_FLAG_SAFETY_ARMED = 128
  }
  
  switch (simState.flightMode) {
    case 'POSCTL':
      customMode = (3 << 16); // Main mode 3 (POSCTL)
      break;
    case 'AUTO_TAKEOFF':
      customMode = (4 << 16) | (2 << 24); // Main mode 4 (AUTO), Sub mode 2 (TAKEOFF)
      break;
    case 'AUTO_MISSION':
      customMode = (4 << 16) | (4 << 24); // Main mode 4 (AUTO), Sub mode 4 (MISSION)
      break;
    case 'AUTO_LAND':
      customMode = (4 << 16) | (6 << 24); // Main mode 4 (AUTO), Sub mode 6 (LAND)
      break;
    case 'AUTO_RTL':
      customMode = (4 << 16) | (5 << 24); // Main mode 4 (AUTO), Sub mode 5 (RTL)
      break;
  }
  return { customMode, baseMode };
}

// ─── Flight Physics Simulation Loop (Runs at 20 Hz) ─────────────────────────
const dt = 1 / CONFIG.telemetry.rateHz; // 0.05 seconds

function updatePhysics() {
  simState.time_boot_ms += Math.round(dt * 1000);

  if (!simState.armed) {
    // Settle / descend on ground if disarmed
    simState.roll *= 0.8;
    simState.pitch *= 0.8;
    simState.speed = 0;
    simState.climb = 0;
    if (simState.alt > 0) {
      simState.alt = Math.max(0, simState.alt - 3.0 * dt);
    }
    return;
  }

  // Armed state transitions
  if (simState.is_taking_off) {
    simState.flightMode = 'AUTO_TAKEOFF';
    const dAlt = simState.takeoff_alt - simState.alt;
    simState.roll *= 0.8;
    simState.pitch *= 0.8;
    simState.speed = 0;

    if (dAlt > 0.1) {
      simState.climb = 2.0; // 2 m/s ascent
      simState.alt += simState.climb * dt;
    } else {
      simState.alt = simState.takeoff_alt;
      simState.climb = 0;
      simState.is_taking_off = false;
      console.log('[SIM] Takeoff target reached. Transitioning to POSCTL/MISSION.');
      simState.flightMode = simState.route.length > 0 ? 'AUTO_MISSION' : 'POSCTL';
    }
  } 
  else if (simState.is_landing) {
    simState.flightMode = 'AUTO_LAND';
    simState.roll *= 0.8;
    simState.pitch *= 0.8;
    simState.speed = 0;

    if (simState.alt > 0.1) {
      simState.climb = -1.5; // -1.5 m/s descent
      simState.alt += simState.climb * dt;
    } else {
      simState.alt = 0;
      simState.climb = 0;
      simState.armed = false;
      simState.is_landing = false;
      simState.flightMode = 'POSCTL';
      console.log('[SIM] Land completed. Disarmed.');
    }
  } 
  else if (simState.is_rtl) {
    simState.flightMode = 'AUTO_RTL';
    const dLat = HOME_LAT - simState.lat;
    const dLon = HOME_LON - simState.lon;
    const dx = dLat * MPDL;
    const dy = dLon * MPDL * cosLat;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Maintain a safe RTL altitude (e.g. 20 meters AGL or current, whichever is higher)
    const rtlAlt = Math.max(20, simState.alt);
    const dAlt = rtlAlt - simState.alt;
    if (Math.abs(dAlt) > 0.5) {
      simState.climb = Math.sign(dAlt) * 2.0;
      simState.alt += simState.climb * dt;
    } else {
      simState.climb = 0;
    }

    if (dist > 2) {
      const target_yaw = Math.atan2(dy, dx);
      let yaw_diff = target_yaw - simState.yaw;
      while (yaw_diff > Math.PI) yaw_diff -= Math.PI * 2;
      while (yaw_diff < -Math.PI) yaw_diff += Math.PI * 2;

      const max_turn = 2.0 * dt;
      const turn = Math.min(Math.max(yaw_diff, -max_turn), max_turn);
      simState.yaw += turn;

      simState.speed = Math.min(10, dist * 0.5);
      simState.pitch = -0.15 * (simState.speed / 10);
      simState.roll = -0.3 * (turn / max_turn);

      const vx = simState.speed * Math.cos(simState.yaw);
      const vy = simState.speed * Math.sin(simState.yaw);
      simState.lat += (vx * dt) / MPDL;
      simState.lon += (vy * dt) / (MPDL * cosLat);
    } else {
      simState.is_rtl = false;
      simState.is_landing = true;
      console.log('[SIM] RTL reached home point. Landing.');
    }
  } 
  else if (simState.route.length > 0) {
    // AUTO MISSION Mode
    simState.flightMode = 'AUTO_MISSION';
    const wp = simState.route[simState.active_wp];

    const dLat = wp.lat - simState.lat;
    const dLon = wp.lon - simState.lon;
    const dx = dLat * MPDL;
    const dy = dLon * MPDL * cosLat;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const dAlt = wp.alt - simState.alt;

    // Adjust altitude
    if (Math.abs(dAlt) > 0.5) {
      simState.climb = Math.sign(dAlt) * Math.min(2.0, Math.abs(dAlt));
      simState.alt += simState.climb * dt;
    } else {
      simState.climb = 0;
    }

    if (dist > 4.0) {
      // Heading control towards waypoint
      const target_yaw = Math.atan2(dy, dx);
      let yaw_diff = target_yaw - simState.yaw;
      while (yaw_diff > Math.PI) yaw_diff -= Math.PI * 2;
      while (yaw_diff < -Math.PI) yaw_diff += Math.PI * 2;

      const max_turn = 2.0 * dt;
      const turn = Math.min(Math.max(yaw_diff, -max_turn), max_turn);
      simState.yaw += turn;

      simState.speed = Math.min(12, dist * 0.4);
      simState.pitch = -0.15 * (simState.speed / 12);
      simState.roll = -0.3 * (turn / max_turn);

      const vx = simState.speed * Math.cos(simState.yaw);
      const vy = simState.speed * Math.sin(simState.yaw);
      simState.lat += (vx * dt) / MPDL;
      simState.lon += (vy * dt) / (MPDL * cosLat);
    } else {
      // Waypoint Reached
      console.log(`[SIM] Reached waypoint ${simState.active_wp}`);
      
      // Send MISSION_ITEM_REACHED to QGC
      mav.createMessage('MISSION_ITEM_REACHED', {
        seq: simState.active_wp
      }, (reachedMsg) => {
        sendToQGC(reachedMsg.buffer);
      });

      // Next waypoint
      simState.active_wp = (simState.active_wp + 1) % simState.route.length;
      if (simState.active_wp === 0) {
        console.log('[SIM] Mission complete! Activating RTL.');
        simState.is_rtl = true;
      }
    }
  } 
  else {
    // Hover Mode (POSCTL)
    simState.flightMode = 'POSCTL';
    simState.speed *= 0.8;
    simState.roll *= 0.8;
    simState.pitch *= 0.8;
    simState.climb = 0;
  }

  // Drain Battery
  simState.battery_remaining = Math.max(5, simState.battery_remaining - 0.01 * dt);
}

// ─── Synchronize state to Telemetry JSON ─────────────────────────────────────
function updateTelemetryObject() {
  telemetry = {
    attitude: {
      roll: simState.roll,
      pitch: simState.pitch,
      yaw: simState.yaw,
      rollspeed: 0,
      pitchspeed: 0,
      yawspeed: 0,
    },
    position: {
      lat: simState.lat,
      lon: simState.lon,
      alt: simState.alt + HOME_ALT,
      relative_alt: simState.alt,
      vx: simState.speed * Math.cos(simState.yaw) * 100,
      vy: simState.speed * Math.sin(simState.yaw) * 100,
      vz: -simState.climb * 100,
    },
    battery: {
      voltage: (simState.armed ? 15.2 : 16.8) * (simState.battery_remaining / 100),
      current: simState.armed ? (12.0 + Math.abs(simState.climb) * 4.0) : 0.5,
      remaining: Math.round(simState.battery_remaining),
    },
    vfr: {
      airspeed: simState.speed,
      groundspeed: simState.speed,
      heading: Math.round((simState.yaw * 180 / Math.PI + 360) % 360),
      throttle: simState.armed ? Math.round(40 + (simState.climb * 10) + simState.speed * 2) : 0,
      climb: simState.climb,
    },
    status: {
      armed:         simState.armed,
      mode:          simState.flightMode,
      system_status: simState.armed ? 4 : 3,
      connected:     true,
      active_wp:     simState.active_wp,
    },
    route: simState.route,
    timestamp: Date.now(),
  };
}

// ─── Handlers for incoming MAVLink packets from QGC ─────────────────────────

let uploadState = {
  active: false,
  expectedCount: 0,
  receivedCount: 0,
  items: []
};

// Send a MISSION_REQUEST_INT back to QGC
function requestMissionItemFromQGC(seq, targetSys, targetComp) {
  mav.createMessage('MISSION_REQUEST_INT', {
    target_system: targetSys,
    target_component: targetComp,
    seq: seq,
    mission_type: 0
  }, (reqMsg) => {
    sendToQGC(reqMsg.buffer);
  });
}

function setupMAVLinkListeners() {
  // ── 1. COMMAND_LONG (Arm, Takeoff, Land, RTL, Request Message)
  mav.on('COMMAND_LONG', (msg, fields) => {
    console.log(`[MAV] COMMAND_LONG: cmd=${fields.command} param1=${fields.param1}`);
    let result = 0; // MAV_RESULT_ACCEPTED

    switch (fields.command) {
      case 400: // MAV_CMD_COMPONENT_ARM_DISARM
        const arm = fields.param1 === 1;
        simState.armed = arm;
        if (arm) {
          simState.battery_remaining = 100;
          if (simState.alt < 0.5) {
            simState.is_taking_off = true;
            simState.takeoff_alt = 10;
            simState.flightMode = 'AUTO_TAKEOFF';
          }
        } else {
          simState.flightMode = 'POSCTL';
        }
        console.log(`[SIM] Arm set to: ${simState.armed}`);
        break;

      case 22: // MAV_CMD_NAV_TAKEOFF
        simState.takeoff_alt = fields.param7 || 10;
        simState.is_taking_off = true;
        simState.flightMode = 'AUTO_TAKEOFF';
        console.log(`[SIM] Takeoff initiated to ${simState.takeoff_alt}m`);
        break;

      case 21: // MAV_CMD_NAV_LAND
        simState.is_landing = true;
        simState.flightMode = 'AUTO_LAND';
        console.log(`[SIM] Land initiated`);
        break;

      case 20: // MAV_CMD_NAV_RETURN_TO_LAUNCH
        simState.is_rtl = true;
        simState.flightMode = 'AUTO_RTL';
        console.log(`[SIM] RTL initiated`);
        break;

      case 176: // MAV_CMD_DO_SET_MODE
        // Set Mode
        const mode = fields.param2;
        console.log(`[MAV] DO_SET_MODE main_mode: ${mode}`);
        break;

      case 512: // MAV_CMD_REQUEST_MESSAGE
        const reqMessageId = Math.round(fields.param1);
        if (reqMessageId === 148) { // AUTOPILOT_VERSION
          mav.createMessage('AUTOPILOT_VERSION', {
            capabilities: 0,
            flight_sw_version: 1,
            middleware_sw_version: 1,
            os_sw_version: 1,
            board_version: 1,
            flight_custom_version: [0, 0, 0, 0, 0, 0, 0, 0],
            middleware_custom_version: [0, 0, 0, 0, 0, 0, 0, 0],
            os_custom_version: [0, 0, 0, 0, 0, 0, 0, 0],
            vendor_id: 0,
            product_id: 0,
            uid: 0
          }, (versionMsg) => {
            sendToQGC(versionMsg.buffer);
          });
        }
        break;
    }

    // Acknowledge command immediately
    mav.createMessage('COMMAND_ACK', {
      command: fields.command,
      result: result,
      progress: 0,
      result_param2: 0,
      target_system: msg.system,
      target_component: msg.component
    }, (ackMsg) => {
      sendToQGC(ackMsg.buffer);
    });
  });

  // ── 2. Parameter Protocol
  mav.on('PARAM_REQUEST_LIST', (msg, fields) => {
    console.log('[MAV] QGC requested param list');
    // Send a single default parameter value to satisfy QGC
    mav.createMessage('PARAM_VALUE', {
      param_id: 'SYS_AUTOSTART',
      param_value: 1,
      param_type: 6, // INT32
      param_count: 1,
      param_index: 0
    }, (paramMsg) => {
      sendToQGC(paramMsg.buffer);
    });
  });

  mav.on('PARAM_REQUEST_READ', (msg, fields) => {
    const paramId = fields.param_id.trim();
    console.log(`[MAV] Param read: ${paramId}`);
    mav.createMessage('PARAM_VALUE', {
      param_id: paramId,
      param_value: paramId === 'SYS_AUTOSTART' ? 1 : 0,
      param_type: 6,
      param_count: 1,
      param_index: 0
    }, (paramMsg) => {
      sendToQGC(paramMsg.buffer);
    });
  });

  // ── 3. Mission Upload Protocol (QGC -> Drone)
  mav.on('MISSION_COUNT', (msg, fields) => {
    console.log(`[MAV] MISSION_COUNT: expected waypoints=${fields.count}`);
    uploadState.expectedCount = fields.count;
    uploadState.receivedCount = 0;
    uploadState.items = [];
    uploadState.active = true;

    if (fields.count > 0) {
      requestMissionItemFromQGC(0, msg.system, msg.component);
    } else {
      simState.route = [];
      telemetry.route = [];
      uploadState.active = false;
      mav.createMessage('MISSION_ACK', {
        target_system: msg.system,
        target_component: msg.component,
        type: 0, // ACCEPTED
        mission_type: 0
      }, (ackMsg) => {
        sendToQGC(ackMsg.buffer);
      });
      broadcastTelemetry();
    }
  });

  function processMissionItem(fields, targetSys, targetComp) {
    if (!uploadState.active) return;

    const lat = fields.x > 180 || fields.x < -180 ? fields.x / 1e7 : fields.x;
    const lon = fields.y > 180 || fields.y < -180 ? fields.y / 1e7 : fields.y;
    const alt = fields.z;

    const item = {
      seq: fields.seq,
      command: fields.command,
      lat: lat,
      lon: lon,
      alt: alt
    };

    uploadState.items[fields.seq] = item;
    uploadState.receivedCount++;

    console.log(`[MAV] Saved item ${fields.seq}/${uploadState.expectedCount} (cmd=${fields.command}, lat=${lat.toFixed(6)}, lon=${lon.toFixed(6)}, alt=${alt}m)`);

    if (uploadState.receivedCount < uploadState.expectedCount) {
      requestMissionItemFromQGC(uploadState.receivedCount, targetSys, targetComp);
    } else {
      // Completed upload
      simState.route = uploadState.items.filter(Boolean).map((wp) => ({
        seq: wp.seq,
        lat: wp.lat,
        lon: wp.lon,
        alt: wp.alt
      }));

      simState.active_wp = 0;
      uploadState.active = false;
      telemetry.route = simState.route;

      console.log(`[SIM] New mission upload successful! Total waypoints: ${simState.route.length}`);

      mav.createMessage('MISSION_ACK', {
        target_system: targetSys,
        target_component: targetComp,
        type: 0, // ACCEPTED
        mission_type: 0
      }, (ackMsg) => {
        sendToQGC(ackMsg.buffer);
      });

      broadcastTelemetry();
    }
  }

  mav.on('MISSION_ITEM_INT', (msg, fields) => {
    processMissionItem(fields, msg.system, msg.component);
  });

  mav.on('MISSION_ITEM', (msg, fields) => {
    processMissionItem(fields, msg.system, msg.component);
  });

  // ── 4. Mission Download Protocol (Drone -> QGC)
  mav.on('MISSION_REQUEST_LIST', (msg, fields) => {
    console.log(`[MAV] QGC requested mission list download. Count: ${simState.route.length}`);
    mav.createMessage('MISSION_COUNT', {
      target_system: msg.system,
      target_component: msg.component,
      count: simState.route.length,
      mission_type: 0
    }, (countMsg) => {
      sendToQGC(countMsg.buffer);
    });
  });

  function handleMissionItemRequest(fields, targetSys, targetComp, useInt) {
    const seq = fields.seq;
    if (seq < 0 || seq >= simState.route.length) {
      console.warn(`[MAV] Requested out of bounds waypoint seq: ${seq}`);
      return;
    }

    const wp = simState.route[seq];
    const msgType = useInt ? 'MISSION_ITEM_INT' : 'MISSION_ITEM';
    const payload = {
      target_system: targetSys,
      target_component: targetComp,
      seq: seq,
      frame: 6, // MAV_FRAME_GLOBAL_RELATIVE_ALT
      command: seq === 0 ? 22 : 16, // WP 0 takeoff, rest waypoints
      current: seq === simState.active_wp ? 1 : 0,
      autocontinue: 1,
      param1: 0,
      param2: 0,
      param3: 0,
      param4: 0,
      x: useInt ? Math.round(wp.lat * 1e7) : wp.lat,
      y: useInt ? Math.round(wp.lon * 1e7) : wp.lon,
      z: wp.alt,
      mission_type: 0
    };

    mav.createMessage(msgType, payload, (itemMsg) => {
      sendToQGC(itemMsg.buffer);
    });
  }

  mav.on('MISSION_REQUEST_INT', (msg, fields) => {
    handleMissionItemRequest(fields, msg.system, msg.component, true);
  });

  mav.on('MISSION_REQUEST', (msg, fields) => {
    handleMissionItemRequest(fields, msg.system, msg.component, false);
  });

  mav.on('MISSION_CLEAR_ALL', (msg, fields) => {
    console.log('[MAV] QGC requested mission clear');
    simState.route = [];
    telemetry.route = [];
    simState.active_wp = 0;

    mav.createMessage('MISSION_ACK', {
      target_system: msg.system,
      target_component: msg.component,
      type: 0, // ACCEPTED
      mission_type: 0
    }, (ackMsg) => {
      sendToQGC(ackMsg.buffer);
    });
    broadcastTelemetry();
  });

  mav.on('MISSION_ACK', (msg, fields) => {
    console.log(`[MAV] Mission ACK received: type=${fields.type}`);
  });
}

// ─── Initialize UDP & MAVLink Loop ──────────────────────────────────────────
mav.on('ready', () => {
  console.log('[MAV] Messages definition files parsed successfully');
  mavReady = true;

  setupMAVLinkListeners();

  // Bind local UDP receiver port (14540)
  udpSocket.on('error', (err) => {
    console.error('[UDP] Port bind failed or encountered error:', err.message);
  });

  udpSocket.on('message', (msg) => {
    // Feed incoming QGC packets into standard MAVLink parser
    mav.parse(msg);
  });

  udpSocket.bind(CONFIG.udp.localPort, CONFIG.udp.host, () => {
    console.log(`[UDP] MAVLink listener bound on port ${CONFIG.udp.localPort}`);
  });

  // Start periodic MAVLink Heartbeat & SysStatus loops to QGC (1 Hz)
  setInterval(() => {
    if (!mavReady) return;

    const { customMode, baseMode } = getHeartbeatModes();

    mav.createMessage('HEARTBEAT', {
      type: 2,             // MAV_TYPE_QUADROTOR = 2
      autopilot: 12,       // MAV_AUTOPILOT_PX4 = 12
      base_mode: baseMode,
      custom_mode: customMode,
      system_status: simState.armed ? 4 : 3, // ACTIVE = 4, STANDBY = 3
      mavlink_version: 3
    }, (msg) => {
      sendToQGC(msg.buffer);
    });

    const voltage = simState.armed ? 15.2 : 16.8;
    const current = simState.armed ? 12.5 : 0.5;
    mav.createMessage('SYS_STATUS', {
      onboard_control_sensors_present: 0,
      onboard_control_sensors_enabled: 0,
      onboard_control_sensors_health: 0,
      load: 100,
      voltage_battery: Math.round(voltage * 1000), // mV
      current_battery: Math.round(current * 100),  // cA
      battery_remaining: Math.round(simState.battery_remaining),
      drop_rate_comm: 0,
      errors_comm: 0,
      errors_count1: 0,
      errors_count2: 0,
      errors_count3: 0,
      errors_count4: 0
    }, (msg) => {
      sendToQGC(msg.buffer);
    });
  }, 1000);

  // Start high frequency loops: Physics, WS Telemetry, MAVLink Streams (10 Hz / 100ms)
  setInterval(() => {
    if (!mavReady) return;

    // 1. Run simulation physics solver
    updatePhysics();

    // 2. Synchronize simulated fields to the telemetry JSON schema
    updateTelemetryObject();

    // 3. Broadcast telemetry via WebSocket
    broadcastTelemetry();

    // 4. Stream MAVLink Attitude to QGC
    mav.createMessage('ATTITUDE', {
      time_boot_ms: simState.time_boot_ms,
      roll: simState.roll,
      pitch: simState.pitch,
      yaw: simState.yaw,
      rollspeed: 0,
      pitchspeed: 0,
      yawspeed: 0
    }, (msg) => {
      sendToQGC(msg.buffer);
    });

    // 5. Stream MAVLink Global Position to QGC
    mav.createMessage('GLOBAL_POSITION_INT', {
      time_boot_ms: simState.time_boot_ms,
      lat: Math.round(simState.lat * 1e7),
      lon: Math.round(simState.lon * 1e7),
      alt: Math.round((simState.alt + HOME_ALT) * 1000), // alt in mm MSL
      relative_alt: Math.round(simState.alt * 1000), // alt in mm AGL
      vx: Math.round(simState.speed * Math.cos(simState.yaw) * 100),
      vy: Math.round(simState.speed * Math.sin(simState.yaw) * 100),
      vz: Math.round(-simState.climb * 100),
      hdg: Math.round(((simState.yaw * 180 / Math.PI + 360) % 360) * 100)
    }, (msg) => {
      sendToQGC(msg.buffer);
    });

    // 6. Stream MAVLink VFR HUD to QGC
    mav.createMessage('VFR_HUD', {
      airspeed: simState.speed,
      groundspeed: simState.speed,
      heading: Math.round((simState.yaw * 180 / Math.PI + 360) % 360),
      throttle: simState.armed ? Math.round(40 + (simState.climb * 10) + simState.speed * 2) : 0,
      alt: simState.alt + HOME_ALT,
      climb: simState.climb
    }, (msg) => {
      sendToQGC(msg.buffer);
    });

    // 7. Stream active waypoint index
    if (simState.route.length > 0) {
      mav.createMessage('MISSION_CURRENT', {
        seq: simState.active_wp
      }, (msg) => {
        sendToQGC(msg.buffer);
      });
    }
  }, 100);
});

mav.on('error', (err) => {
  console.error('[MAV] General Parser Error:', err);
});

// Shutdown hook
process.on('SIGINT', () => {
  console.log('\n[SIM] Shutting down Native UAV SITL Simulator.');
  udpSocket.close();
  server.close();
  process.exit(0);
});
