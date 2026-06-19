/**
 * index.js — Göktürk UAV Three.js Frontend
 *
 * Responsibilities:
 *  1. Build a premium 3D scene (sky, ground grid, lighting, shadows)
 *  2. Procedurally construct a detailed quadcopter drone model
 *  3. Connect to the Node.js WebSocket bridge and stream live telemetry
 *  4. Apply NED → Three.js Y-up coordinate transforms to the drone mesh
 *  5. Update all HUD DOM elements at 60 fps
 *  6. Draw a 2D attitude indicator (ADI) on a canvas element
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ─── Constants & Config ───────────────────────────────────────────────────────

const WS_URL          = 'ws://localhost:8080';
const WS_RECONNECT_MS = 3000;  // Reconnect delay (ms) after disconnect
const SMOOTH_ALPHA    = 0.08;  // Lerp factor for smooth drone rotation (0=frozen, 1=instant)
const CAMERA_DISTANCE = 8;     // Meters from drone in follow mode
const GRID_SIZE       = 500;   // Metres — infinite-feel ground grid
const RAD_TO_DEG      = 180 / Math.PI;

// ─── Scene Setup ─────────────────────────────────────────────────────────────

const canvas   = document.getElementById('canvas-3d');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
renderer.toneMapping       = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;

const scene = new THREE.Scene();

// Deep-space gradient background
const bgGradient = new THREE.Color(0x080c12);
scene.background = bgGradient;
scene.fog        = new THREE.Fog(0x080c12, 120, 500);

// ── Camera ────────────────────────────────────────────────────────────────────
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, CAMERA_DISTANCE * 0.6, CAMERA_DISTANCE);

// ── Orbit Controls ────────────────────────────────────────────────────────────
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping    = true;
controls.dampingFactor    = 0.06;
controls.minDistance      = 2;
controls.maxDistance      = 80;
controls.maxPolarAngle    = Math.PI * 0.85;
controls.enablePan        = true;
controls.panSpeed         = 0.6;

// ─── Lighting ─────────────────────────────────────────────────────────────────

// Ambient — low-level fill so dark areas aren't pure black
const ambientLight = new THREE.AmbientLight(0x1a2840, 0.8);
scene.add(ambientLight);

// Key light — sun-like from above and slightly south
const sunLight = new THREE.DirectionalLight(0xfff5e6, 1.8);
sunLight.position.set(40, 80, 40);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.near   = 1;
sunLight.shadow.camera.far    = 300;
sunLight.shadow.camera.left   = -50;
sunLight.shadow.camera.right  = 50;
sunLight.shadow.camera.top    = 50;
sunLight.shadow.camera.bottom = -50;
sunLight.shadow.bias = -0.0003;
scene.add(sunLight);

// Rim light — cold blue from behind for depth separation
const rimLight = new THREE.DirectionalLight(0x22d3ee, 0.4);
rimLight.position.set(-30, 20, -40);
scene.add(rimLight);

// ─── Ground Grid ──────────────────────────────────────────────────────────────

// Primary grid — large divisions
const gridHelper = new THREE.GridHelper(GRID_SIZE, 100, 0x1e293b, 0x0f172a);
gridHelper.position.y = 0;
scene.add(gridHelper);

// Secondary grid — finer detail close to origin
const fineGrid = new THREE.GridHelper(50, 50, 0x1e3a5f, 0x0a1628);
fineGrid.position.y = 0.01; // Slightly above coarse grid to prevent z-fighting
scene.add(fineGrid);

// Ground plane — receives shadows
const groundGeo  = new THREE.PlaneGeometry(GRID_SIZE, GRID_SIZE);
const groundMat  = new THREE.MeshLambertMaterial({ color: 0x050a0f, transparent: true, opacity: 0.95 });
const groundMesh = new THREE.Mesh(groundGeo, groundMat);
groundMesh.rotation.x = -Math.PI / 2;
groundMesh.receiveShadow = true;
scene.add(groundMesh);

// ─── Compass Rose (XZ plane markers) ─────────────────────────────────────────

function makeCompassArrow(color, rotY, label) {
  const dir    = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(0, rotY, 0));
  const origin = new THREE.Vector3(0, 0.05, 0);
  const arrow  = new THREE.ArrowHelper(dir, origin, 18, color, 2.5, 1.2);
  scene.add(arrow);
}

makeCompassArrow(0xef4444, 0,              'N'); // North — red
makeCompassArrow(0x64748b, Math.PI,        'S');
makeCompassArrow(0x64748b, -Math.PI / 2,   'E');
makeCompassArrow(0x64748b, Math.PI / 2,    'W');

// ─── Procedural Drone Model ───────────────────────────────────────────────────
// A stylized quadcopter built entirely with Three.js geometries — no external
// file required. All parts are children of a root `droneGroup` so that applying
// rotations to droneGroup affects the whole craft.

const droneGroup = new THREE.Group();
scene.add(droneGroup);

// ── Materials ──────────────────────────────────────────────────────────────
const bodyMat = new THREE.MeshStandardMaterial({
  color:     0x1e293b,
  roughness: 0.3,
  metalness: 0.85,
  envMapIntensity: 0.6,
});
const accentMat = new THREE.MeshStandardMaterial({
  color:     0xf59e0b,
  roughness: 0.2,
  metalness: 0.9,
  emissive:  new THREE.Color(0xf59e0b),
  emissiveIntensity: 0.15,
});
const armMat = new THREE.MeshStandardMaterial({
  color:     0x0f172a,
  roughness: 0.4,
  metalness: 0.7,
});
const propMat = new THREE.MeshStandardMaterial({
  color:     0x334155,
  roughness: 0.2,
  metalness: 0.5,
  transparent: true,
  opacity: 0.85,
});

// ── Central fuselage ────────────────────────────────────────────────────────
// Upper body — slightly flattened hexagonal prism approximated with a box
const upperBodyGeo  = new THREE.BoxGeometry(0.4, 0.12, 0.5);
const upperBodyMesh = new THREE.Mesh(upperBodyGeo, bodyMat);
upperBodyMesh.position.y = 0.08;
upperBodyMesh.castShadow = true;
droneGroup.add(upperBodyMesh);

// Lower battery pod
const batteryGeo  = new THREE.BoxGeometry(0.28, 0.1, 0.38);
const batteryMesh = new THREE.Mesh(batteryGeo, new THREE.MeshStandardMaterial({
  color:     0x1e3a5f,
  roughness: 0.25,
  metalness: 0.6,
}));
batteryMesh.position.y = -0.01;
batteryMesh.castShadow = true;
droneGroup.add(batteryMesh);

// Amber accent strip on top
const stripGeo  = new THREE.BoxGeometry(0.38, 0.018, 0.06);
const stripMesh = new THREE.Mesh(stripGeo, accentMat);
stripMesh.position.set(0, 0.15, 0);
droneGroup.add(stripMesh);

// Camera / sensor dome (front)
const domeGeo  = new THREE.SphereGeometry(0.07, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
const domeMesh = new THREE.Mesh(domeGeo, new THREE.MeshStandardMaterial({
  color:     0x0f172a,
  roughness: 0.05,
  metalness: 0.8,
}));
domeMesh.rotation.x = Math.PI;
domeMesh.position.set(0, 0.04, 0.22);
droneGroup.add(domeMesh);

// Camera lens (small teal circle)
const lensGeo  = new THREE.CircleGeometry(0.03, 12);
const lensMesh = new THREE.Mesh(lensGeo, new THREE.MeshStandardMaterial({
  color:     0x0e7490,
  roughness: 0.0,
  metalness: 1.0,
  emissive:  new THREE.Color(0x22d3ee),
  emissiveIntensity: 0.3,
}));
lensMesh.rotation.x = Math.PI / 2;
lensMesh.position.set(0, 0.04, 0.29);
droneGroup.add(lensMesh);

// ── Motor arms & propellers ──────────────────────────────────────────────────
// Arm positions relative to body centre (quadX layout)
const ARM_ANGLE  = Math.PI / 4;  // 45° from forward
const ARM_LENGTH = 0.8;

const armPositions = [
  { angle: ARM_ANGLE,              ledColor: 0x22d3ee, id: 'FL' },  // Front-Left  — teal
  { angle: -ARM_ANGLE,             ledColor: 0x22d3ee, id: 'FR' },  // Front-Right — teal
  { angle: Math.PI + ARM_ANGLE,    ledColor: 0xef4444, id: 'RL' },  // Rear-Left   — red
  { angle: Math.PI - ARM_ANGLE,    ledColor: 0xef4444, id: 'RR' },  // Rear-Right  — red
];

const propGroups = []; // Store propeller groups for animation

armPositions.forEach(({ angle, ledColor, id }) => {
  const armTip = new THREE.Vector3(
    Math.sin(angle) * ARM_LENGTH,
    0,
    -Math.cos(angle) * ARM_LENGTH,
  );

  // ── Arm tube ────────────────────────────────────────────────────────────
  const armDir    = armTip.clone().normalize();
  const armCenter = armTip.clone().multiplyScalar(0.5);
  const armGeo    = new THREE.CylinderGeometry(0.025, 0.035, ARM_LENGTH, 8);
  const armMesh   = new THREE.Mesh(armGeo, armMat);

  // Rotate cylinder to point from centre to tip
  armMesh.position.copy(armCenter);
  armMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), armDir);
  armMesh.castShadow = true;
  droneGroup.add(armMesh);

  // ── Motor housing ────────────────────────────────────────────────────────
  const motorGeo  = new THREE.CylinderGeometry(0.055, 0.05, 0.06, 16);
  const motorMesh = new THREE.Mesh(motorGeo, bodyMat);
  motorMesh.position.copy(armTip);
  motorMesh.position.y += 0.03;
  motorMesh.castShadow = true;
  droneGroup.add(motorMesh);

  // Motor bottom ring (accent colour)
  const ringGeo  = new THREE.TorusGeometry(0.055, 0.008, 8, 24);
  const ringMesh = new THREE.Mesh(ringGeo, accentMat);
  ringMesh.position.copy(armTip);
  ringMesh.rotation.x = Math.PI / 2;
  droneGroup.add(ringMesh);

  // ── Propeller group ──────────────────────────────────────────────────────
  const propGroup = new THREE.Group();
  propGroup.position.copy(armTip);
  propGroup.position.y += 0.075;
  droneGroup.add(propGroup);
  propGroups.push(propGroup);

  // Two blades per propeller (rotated 180° apart)
  [-0, Math.PI].forEach((bladeAngle) => {
    // Blade shape: elongated rounded shape using a tapered cylinder
    const bladeGeo = new THREE.CylinderGeometry(0.01, 0.04, 0.38, 8);
    // Apply taper: scale X to make it blade-like
    bladeGeo.applyMatrix4(new THREE.Matrix4().makeScale(1, 1, 0.22));
    const bladeMesh = new THREE.Mesh(bladeGeo, propMat);
    bladeMesh.rotation.y = bladeAngle;
    bladeMesh.position.x = Math.sin(bladeAngle) * 0.19;
    bladeMesh.position.z = -Math.cos(bladeAngle) * 0.19;
    bladeMesh.rotation.z = 0.1; // slight pitch angle
    propGroup.add(bladeMesh);
  });

  // ── LED light at arm tip ──────────────────────────────────────────────────
  const ledGeo  = new THREE.SphereGeometry(0.018, 8, 8);
  const ledMat  = new THREE.MeshStandardMaterial({
    color:             ledColor,
    emissive:          new THREE.Color(ledColor),
    emissiveIntensity: 1.5,
    roughness:         0,
    metalness:         0,
  });
  const ledMesh = new THREE.Mesh(ledGeo, ledMat);
  ledMesh.position.copy(armTip);
  ledMesh.position.y += 0.04;
  droneGroup.add(ledMesh);

  // Point light at LED position (short range glow)
  const ledLight       = new THREE.PointLight(ledColor, 0.8, 1.2);
  ledLight.position.copy(armTip);
  ledLight.position.y += 0.04;
  droneGroup.add(ledLight);
});

// ── Body underside lighting (downward glow) ──────────────────────────────────
const bodyGlow = new THREE.PointLight(0x0ea5e9, 0.5, 2);
bodyGlow.position.set(0, -0.15, 0);
droneGroup.add(bodyGlow);

// ── Landing legs ─────────────────────────────────────────────────────────────
const legPositions = [
  [ 0.18, -0.12],
  [-0.18, -0.12],
  [ 0.18,  0.12],
  [-0.18,  0.12],
];
legPositions.forEach(([lx, lz]) => {
  const legGeo  = new THREE.CylinderGeometry(0.01, 0.01, 0.18, 6);
  const legMesh = new THREE.Mesh(legGeo, armMat);
  legMesh.position.set(lx, -0.09, lz);
  legMesh.rotation.x = 0.15;
  droneGroup.add(legMesh);
  // Foot
  const footGeo  = new THREE.SphereGeometry(0.018, 8, 8);
  const footMesh = new THREE.Mesh(footGeo, armMat);
  footMesh.position.set(lx, -0.18, lz + 0.02);
  droneGroup.add(footMesh);
});

// Scale up the entire model to a reasonable scene size
droneGroup.scale.setScalar(3.5);
droneGroup.position.y = 5; // Initial display height

// ─── Shadow Under Drone ───────────────────────────────────────────────────────
// Fake ground shadow blob that scales with altitude
const shadowGeo  = new THREE.CircleGeometry(1, 32);
const shadowMat  = new THREE.MeshBasicMaterial({
  color:       0x000000,
  transparent: true,
  opacity:     0.4,
  depthWrite:  false,
});
const shadowBlob = new THREE.Mesh(shadowGeo, shadowMat);
shadowBlob.rotation.x = -Math.PI / 2;
shadowBlob.position.y = 0.01;
scene.add(shadowBlob);

// ─── Flight Path Trail ────────────────────────────────────────────────────────
// Keeps the last N positions and draws a smooth trail line
const TRAIL_LENGTH      = 200;
const trailPositions    = new Float32Array(TRAIL_LENGTH * 3);
const trailGeo          = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
trailGeo.setDrawRange(0, 0);
const trailMat  = new THREE.LineBasicMaterial({
  color:       0xf59e0b,
  transparent: true,
  opacity:     0.4,
  linewidth:   1,
});
const trailLine = new THREE.Line(trailGeo, trailMat);
scene.add(trailLine);

let trailIndex = 0;
let trailCount = 0;

function appendTrail(x, y, z) {
  const idx = (trailIndex % TRAIL_LENGTH) * 3;
  trailPositions[idx]     = x;
  trailPositions[idx + 1] = y;
  trailPositions[idx + 2] = z;
  trailIndex++;
  trailCount = Math.min(trailCount + 1, TRAIL_LENGTH);
  trailGeo.setDrawRange(0, trailCount);
  trailGeo.attributes.position.needsUpdate = true;
}

// ─── Smoothed Telemetry State ─────────────────────────────────────────────────
// These are the display-space values we lerp toward each frame.
let smoothRoll = 0, smoothPitch = 0, smoothYaw = 0, smoothAlt = 5;

// Home position for relative lat/lon → metres conversion
// Set on first valid GPS lock
let homeLat = null, homeLon = null;

/** Convert lat/lon degrees to metres relative to home origin. */
function latLonToMetres(lat, lon) {
  const METRES_PER_DEG_LAT = 111319.5;
  const latM = (lat - homeLat) * METRES_PER_DEG_LAT;
  const lonM = (lon - homeLon) * METRES_PER_DEG_LAT * Math.cos(homeLat * Math.PI / 180);
  return { x: lonM, z: -latM }; // NED: East → +X, North → +Z (negated for Three.js)
}

// ─── WebSocket Client ─────────────────────────────────────────────────────────

let ws             = null;
let lastTelemetry  = null;
let wsPingSent     = 0;
let wsLatencyMs    = 0;
let isConnected    = false;

const elConnDot    = document.getElementById('conn-dot');
const elConnLabel  = document.getElementById('conn-label');
const elWsLatency  = document.getElementById('ws-latency');

function connectWebSocket() {
  console.log(`[WS] Connecting to ${WS_URL}…`);
  ws = new WebSocket(WS_URL);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    console.log('[WS] Connected');
    isConnected = true;
    setConnectionUI(true);
    wsPingSent = performance.now();
  };

  ws.onmessage = (event) => {
    const now = performance.now();
    wsLatencyMs = Math.round(now - wsPingSent);
    wsPingSent  = now;

    try {
      lastTelemetry = JSON.parse(event.data);
      if (lastTelemetry.status) {
        lastTelemetry.status.connected = true;
      }
    } catch (e) {
      console.warn('[WS] Failed to parse message:', e);
    }
  };

  ws.onclose = () => {
    console.warn('[WS] Disconnected — retrying in', WS_RECONNECT_MS, 'ms');
    isConnected = false;
    setConnectionUI(false);
    setTimeout(connectWebSocket, WS_RECONNECT_MS);
  };

  ws.onerror = (err) => {
    console.error('[WS] Error:', err);
    ws.close();
  };
}

function setConnectionUI(connected) {
  elConnDot.className   = connected ? 'dot dot--connected' : 'dot dot--disconnected';
  elConnLabel.textContent = connected ? 'LIVE TELEMETRY' : 'DISCONNECTED';
  if (connected) {
    elConnLabel.style.color = 'var(--color-green)';
  } else {
    elConnLabel.style.color = '';
  }
}

connectWebSocket();

// ─── Attitude Indicator (ADI) Canvas ─────────────────────────────────────────

const adiCanvas = document.getElementById('adi-canvas');
const adiCtx    = adiCanvas.getContext('2d');
const ADI_W     = adiCanvas.width;
const ADI_H     = adiCanvas.height;
const ADI_CX    = ADI_W / 2;
const ADI_CY    = ADI_H / 2;
const ADI_R     = ADI_W / 2 - 4;

function drawADI(rollRad, pitchRad) {
  adiCtx.clearRect(0, 0, ADI_W, ADI_H);

  // Clip to circle
  adiCtx.save();
  adiCtx.beginPath();
  adiCtx.arc(ADI_CX, ADI_CY, ADI_R, 0, Math.PI * 2);
  adiCtx.clip();

  // Translate and rotate for attitude
  adiCtx.translate(ADI_CX, ADI_CY);
  adiCtx.rotate(-rollRad);

  const pitchOffsetPx = pitchRad * ADI_R * 1.5; // Pitch scaling

  // Sky half — deep blue gradient
  const skyGrad = adiCtx.createLinearGradient(0, -ADI_R, 0, pitchOffsetPx);
  skyGrad.addColorStop(0,   '#0c4a6e');
  skyGrad.addColorStop(0.5, '#0ea5e9');
  skyGrad.addColorStop(1,   '#38bdf8');
  adiCtx.fillStyle = skyGrad;
  adiCtx.fillRect(-ADI_R, -ADI_R, ADI_R * 2, ADI_R + pitchOffsetPx);

  // Ground half — warm earth
  const gndGrad = adiCtx.createLinearGradient(0, pitchOffsetPx, 0, ADI_R);
  gndGrad.addColorStop(0, '#854d0e');
  gndGrad.addColorStop(1, '#451a03');
  adiCtx.fillStyle = gndGrad;
  adiCtx.fillRect(-ADI_R, pitchOffsetPx, ADI_R * 2, ADI_R);

  // Horizon line
  adiCtx.strokeStyle = 'rgba(255,255,255,0.8)';
  adiCtx.lineWidth   = 2;
  adiCtx.beginPath();
  adiCtx.moveTo(-ADI_R, pitchOffsetPx);
  adiCtx.lineTo(ADI_R, pitchOffsetPx);
  adiCtx.stroke();

  // Pitch marks (every 10°)
  adiCtx.fillStyle   = 'rgba(255,255,255,0.65)';
  adiCtx.font        = '9px JetBrains Mono, monospace';
  adiCtx.textAlign   = 'center';
  adiCtx.strokeStyle = 'rgba(255,255,255,0.5)';
  adiCtx.lineWidth   = 1;
  for (let deg = -30; deg <= 30; deg += 10) {
    if (deg === 0) continue;
    const py    = pitchOffsetPx + (deg * Math.PI / 180) * ADI_R * 1.5;
    const width = deg % 20 === 0 ? 28 : 18;
    adiCtx.beginPath();
    adiCtx.moveTo(-width, py);
    adiCtx.lineTo(width, py);
    adiCtx.stroke();
    if (Math.abs(py) < ADI_R * 0.92) {
      adiCtx.fillText(String(Math.abs(deg)), width + 8, py + 3);
    }
  }

  adiCtx.restore();

  // Fixed aircraft symbol (always centered, drawn outside the clip rotation)
  adiCtx.save();
  adiCtx.translate(ADI_CX, ADI_CY);
  adiCtx.strokeStyle = '#f59e0b';
  adiCtx.lineWidth   = 2.5;
  adiCtx.lineCap     = 'round';
  // Left wing
  adiCtx.beginPath();
  adiCtx.moveTo(-28, 0); adiCtx.lineTo(-8, 0); adiCtx.lineTo(-8, 5);
  adiCtx.stroke();
  // Right wing
  adiCtx.beginPath();
  adiCtx.moveTo(28, 0); adiCtx.lineTo(8, 0); adiCtx.lineTo(8, 5);
  adiCtx.stroke();
  // Centre dot
  adiCtx.beginPath();
  adiCtx.arc(0, 0, 3, 0, Math.PI * 2);
  adiCtx.fillStyle = '#f59e0b';
  adiCtx.fill();
  adiCtx.restore();

  // Border
  adiCtx.save();
  adiCtx.beginPath();
  adiCtx.arc(ADI_CX, ADI_CY, ADI_R, 0, Math.PI * 2);
  adiCtx.strokeStyle = 'rgba(255,255,255,0.12)';
  adiCtx.lineWidth   = 2;
  adiCtx.stroke();
  adiCtx.restore();
}

// ─── HUD DOM Update ───────────────────────────────────────────────────────────

const el = {
  roll:        document.getElementById('val-roll'),
  pitch:       document.getElementById('val-pitch'),
  yaw:         document.getElementById('val-yaw'),
  voltage:     document.getElementById('val-voltage'),
  current:     document.getElementById('val-current'),
  battPct:     document.getElementById('battery-pct'),
  battFill:    document.getElementById('battery-fill'),
  lat:         document.getElementById('val-lat'),
  lon:         document.getElementById('val-lon'),
  alt:         document.getElementById('val-alt'),
  altMsl:      document.getElementById('val-alt-msl'),
  groundspeed: document.getElementById('val-groundspeed'),
  airspeed:    document.getElementById('val-airspeed'),
  heading:     document.getElementById('val-heading'),
  climb:       document.getElementById('val-climb'),
  throttle:    document.getElementById('val-throttle'),
  throttleFill:document.getElementById('throttle-fill'),
  armPill:     document.getElementById('arm-pill'),
  armLabel:    document.getElementById('arm-label'),
  modeLabel:   document.getElementById('mode-label'),
};

function updateHUD(t) {
  // ── Attitude ──────────────────────────────────────────────────────────────
  const rollDeg  = (t.attitude.roll  * RAD_TO_DEG).toFixed(1);
  const pitchDeg = (t.attitude.pitch * RAD_TO_DEG).toFixed(1);
  const yawDeg   = ((t.attitude.yaw  * RAD_TO_DEG + 360) % 360).toFixed(1);

  el.roll.textContent  = `${rollDeg}°`;
  el.pitch.textContent = `${pitchDeg}°`;
  el.yaw.textContent   = `${yawDeg}°`;

  // Color-code extreme attitudes
  el.roll.className  = 'data-value' + (Math.abs(t.attitude.roll)  > 0.52 ? ' text-amber' : '');
  el.pitch.className = 'data-value' + (Math.abs(t.attitude.pitch) > 0.35 ? ' text-amber' : '');

  // ── ADI ───────────────────────────────────────────────────────────────────
  drawADI(t.attitude.roll, t.attitude.pitch);

  // ── Battery ───────────────────────────────────────────────────────────────
  const pct = t.battery.remaining;
  el.battPct.textContent  = pct >= 0 ? `${pct}%` : '--%';
  el.voltage.textContent  = t.battery.voltage  > 0 ? `${t.battery.voltage.toFixed(1)}V`  : '--.-V';
  el.current.textContent  = t.battery.current  > 0 ? `${t.battery.current.toFixed(1)}A`  : '--.-A';

  if (pct >= 0) {
    el.battFill.style.transform = `scaleX(${pct / 100})`;
    const hue = pct > 50 ? 142 : pct > 20 ? 45 : 0;
    el.battFill.style.background = `linear-gradient(90deg, hsl(${hue},70%,40%), hsl(${hue},70%,55%))`;
    el.battPct.style.color = pct < 20 ? '#fca5a5' : '#fff';
  }

  // ── Position ──────────────────────────────────────────────────────────────
  el.lat.textContent    = t.position.lat !== 0 ? `${t.position.lat.toFixed(6)}°` : '--.------°';
  el.lon.textContent    = t.position.lon !== 0 ? `${t.position.lon.toFixed(6)}°` : '--.------°';
  el.alt.textContent    = `${t.position.relative_alt.toFixed(1)} m`;
  el.altMsl.textContent = `${t.position.alt.toFixed(1)} m`;

  // Color-code altitude warnings
  el.alt.className = 'data-value' + (t.position.relative_alt > 80 ? ' text-amber' : '');

  // ── VFR / Flight ──────────────────────────────────────────────────────────
  el.groundspeed.textContent = `${t.vfr.groundspeed.toFixed(2)} m/s`;
  el.airspeed.textContent    = `${t.vfr.airspeed.toFixed(2)} m/s`;
  el.heading.textContent     = `${t.vfr.heading}°`;
  el.climb.textContent       = `${t.vfr.climb >= 0 ? '+' : ''}${t.vfr.climb.toFixed(2)} m/s`;
  el.climb.className = 'data-value' + (t.vfr.climb > 0.3 ? ' text-green' : t.vfr.climb < -0.3 ? ' text-red' : '');

  el.throttle.textContent           = `${t.vfr.throttle}%`;
  el.throttleFill.style.width       = `${t.vfr.throttle}%`;

  // ── Arm / Mode ────────────────────────────────────────────────────────────
  if (t.status.armed) {
    el.armLabel.textContent = 'ARMED';
    el.armPill.className    = 'status-pill armed';
  } else {
    el.armLabel.textContent = 'DISARMED';
    el.armPill.className    = 'status-pill disarmed';
  }
  el.modeLabel.textContent = t.status.mode || '---';

  // ── WS Latency ────────────────────────────────────────────────────────────
  elWsLatency.textContent = isConnected ? `WS: ${wsLatencyMs} ms` : 'WS: ---';
}

// ─── UTC Clock ─────────────────────────────────────────────────────────────────
const elClock = document.getElementById('clock');
function updateClock() {
  const now = new Date();
  const hh  = String(now.getUTCHours()).padStart(2, '0');
  const mm  = String(now.getUTCMinutes()).padStart(2, '0');
  const ss  = String(now.getUTCSeconds()).padStart(2, '0');
  elClock.textContent = `${hh}:${mm}:${ss} UTC`;
}
setInterval(updateClock, 1000);
updateClock();

// ─── Resize Handler ───────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─── Animation Loop ───────────────────────────────────────────────────────────

const clock = new THREE.Clock();
let trailTimer = 0;

function animate() {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();
  const time  = clock.getElapsedTime();
  trailTimer += delta;

  // ── Process incoming telemetry ────────────────────────────────────────────
  if (lastTelemetry) {
    const t = lastTelemetry;

    // ── NED → Three.js axis conversion ──────────────────────────────────────
    // ArduPilot NED convention:   X=North, Y=East, Z=Down
    // Three.js Y-up convention:   X=Right, Y=Up, Z=Toward-viewer
    //
    // Mapping:
    //   roll  (rotation around NED-X / north axis) → Three.js Z-axis rotation
    //   pitch (rotation around NED-Y / east axis)  → Three.js X-axis rotation (negated)
    //   yaw   (rotation around NED-Z / down axis)  → Three.js Y-axis rotation (negated)

    const targetRoll  = t.attitude.roll;
    const targetPitch = t.attitude.pitch;
    const targetYaw   = t.attitude.yaw;
    const targetAlt   = Math.max(0, t.position.relative_alt);

    // Smooth lerp to avoid jerky jumps from discrete telemetry packets
    smoothRoll  += (targetRoll  - smoothRoll)  * SMOOTH_ALPHA;
    smoothPitch += (targetPitch - smoothPitch) * SMOOTH_ALPHA;
    smoothAlt   += (targetAlt   - smoothAlt)   * SMOOTH_ALPHA;

    // Yaw requires special handling to avoid 359°→1° flip artifacts
    let yawDelta = targetYaw - smoothYaw;
    if (yawDelta > Math.PI)  yawDelta -= Math.PI * 2;
    if (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
    smoothYaw += yawDelta * SMOOTH_ALPHA;

    // Apply rotation to drone (Euler order ZYX is natural for aerospace)
    droneGroup.rotation.set(
      -smoothPitch,  // pitch  → X (inverted: nose-up is positive in NED, -X in Three.js)
      -smoothYaw,    // yaw    → Y (inverted: clockwise heading → -Y in Three.js)
       smoothRoll,   // roll   → Z (banking right → +Z in Three.js)
      'ZYX',
    );

    // Apply altitude to Y position
    droneGroup.position.y = smoothAlt;

    // Apply lat/lon to X/Z (relative to home)
    if (t.position.lat !== 0 && t.position.lon !== 0) {
      if (homeLat === null) {
        homeLat = t.position.lat;
        homeLon = t.position.lon;
      }
      const pos = latLonToMetres(t.position.lat, t.position.lon);
      droneGroup.position.x = pos.x;
      droneGroup.position.z = pos.z;
    }

    // ── Shadow blob ─────────────────────────────────────────────────────────
    const shadowScale = Math.max(0.2, 1 - smoothAlt / 80);
    shadowBlob.position.x = droneGroup.position.x;
    shadowBlob.position.z = droneGroup.position.z;
    shadowBlob.scale.setScalar(shadowScale * 4);
    shadowMat.opacity = shadowScale * 0.35;

    // ── Flight path trail (every 200ms) ─────────────────────────────────────
    if (trailTimer > 0.2) {
      appendTrail(droneGroup.position.x, droneGroup.position.y, droneGroup.position.z);
      trailTimer = 0;
    }

    // ── HUD update ───────────────────────────────────────────────────────────
    updateHUD(t);
  }

  // ── Propeller animation ───────────────────────────────────────────────────
  const propSpeed = lastTelemetry?.status.armed ? 15 : 2;
  propGroups.forEach((pg, i) => {
    // Alternate spin directions (CW/CCW) for quad X layout realism
    const dir = (i === 0 || i === 3) ? 1 : -1;
    pg.rotation.y += delta * propSpeed * dir;
  });

  // ── Camera: soft-follow the drone ────────────────────────────────────────
  controls.target.lerp(droneGroup.position, 0.04);
  controls.update();

  // ── Subtle sky hue shift (day/night-ish ambiance) ─────────────────────────
  const hue = (Math.sin(time * 0.01) * 0.5 + 0.5) * 0.05;
  scene.fog.color.setHSL(0.6 + hue, 0.4, 0.03);

  renderer.render(scene, camera);
}

animate();
