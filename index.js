/**
 * index.js — Göktürk UAV Three.js Frontend
 *
 * Major features:
 *  1. Realistic sky dome (Three.js Sky shader with sun position)
 *  2. ESRI World Imagery satellite tiles as 3D ground (7×7 at zoom 16)
 *  3. Hemisphere + directional lighting matched to sky sun
 *  4. Procedural quadcopter drone model
 *  5. NED → Three.js Y-up coordinate transforms
 *  6. WebSocket telemetry from Node.js bridge
 *  7. Full HUD with ADI, battery, position, VFR panels
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { Timer } from 'three';

// ─── Constants ────────────────────────────────────────────────────────────────

const WS_URL          = 'ws://localhost:8080';
const WS_RECONNECT_MS = 3000;
const SMOOTH_ALPHA    = 0.08;   // Drone rotation lerp factor
const CAMERA_DISTANCE = 8;
const RAD_TO_DEG      = 180 / Math.PI;

// Satellite tile config
const TILE_ZOOM       = 16;     // Zoom level 16 → ~488m per tile at lat 37°
const TILE_GRID_HALF  = 3;      // Load (2*3+1)=7×7 = 49 tiles → ~3.4km coverage

// ─── Renderer ─────────────────────────────────────────────────────────────────

const canvas   = document.getElementById('canvas-3d');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFShadowMap;
renderer.toneMapping       = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;

// ─── Scene ────────────────────────────────────────────────────────────────────

const scene = new THREE.Scene();
// Very light haze only in the far distance — won't darken mid-range
scene.fog = new THREE.Fog(0xc8dff5, 400, 1800);

// ─── Camera ───────────────────────────────────────────────────────────────────

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 4000);
camera.position.set(0, CAMERA_DISTANCE * 0.6, CAMERA_DISTANCE);

// ─── Orbit Controls ───────────────────────────────────────────────────────────

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping  = true;
controls.dampingFactor  = 0.06;
controls.minDistance    = 2;
controls.maxDistance    = 800;
controls.maxPolarAngle  = Math.PI * 0.82;
controls.panSpeed       = 0.6;

// ─── Sky Dome ─────────────────────────────────────────────────────────────────

const sky = new Sky();
sky.scale.setScalar(450000);
scene.add(sky);

const skyUniforms = sky.material.uniforms;
skyUniforms['turbidity'].value       = 2.5;    // atmospheric haze
skyUniforms['rayleigh'].value        = 0.6;    // sky blueness
skyUniforms['mieCoefficient'].value  = 0.004;  // aerosol density
skyUniforms['mieDirectionalG'].value = 0.82;   // sun halo tightness

// Sun position — 55° elevation, slightly south-west (typical afternoon in Turkey)
const SUN_VEC = new THREE.Vector3();
const sunPhi   = THREE.MathUtils.degToRad(90 - 55);  // 90 - elevation
const sunTheta = THREE.MathUtils.degToRad(200);       // azimuth
SUN_VEC.setFromSphericalCoords(1, sunPhi, sunTheta);
skyUniforms['sunPosition'].value.copy(SUN_VEC);

// ─── Lighting ─────────────────────────────────────────────────────────────────

// Hemisphere light — sky colour above, warm earth bounce below
const hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x8b7355, 0.9);
scene.add(hemiLight);

// Sun directional light — matched to sky sun position
const sunLight = new THREE.DirectionalLight(0xfff8e7, 2.5);
sunLight.position.copy(SUN_VEC).multiplyScalar(500);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.near   = 1;
sunLight.shadow.camera.far    = 600;
sunLight.shadow.camera.left   = -120;
sunLight.shadow.camera.right  = 120;
sunLight.shadow.camera.top    = 120;
sunLight.shadow.camera.bottom = -120;
sunLight.shadow.bias = -0.0003;
scene.add(sunLight);

// Soft fill light from opposite side (prevents pure black shadows)
const fillLight = new THREE.DirectionalLight(0xd4eaff, 0.6);
fillLight.position.set(-SUN_VEC.x * 200, 100, -SUN_VEC.z * 200);
scene.add(fillLight);

// ─── Geo ↔ World Coordinate Helpers ──────────────────────────────────────────

/** Convert lat/lon to Three.js XZ world metres relative to a reference origin. */
function geoToWorld(lat, lon, refLat, refLon) {
  const MPDL = 111319.5; // metres per degree latitude
  return {
    x:  (lon - refLon) * MPDL * Math.cos(refLat * Math.PI / 180),
    z: -(lat - refLat) * MPDL,
  };
}

/** Web-Mercator tile X from longitude. */
function lonToTileX(lon, zoom) {
  return Math.floor((lon + 180) / 360 * (1 << zoom));
}

/** Web-Mercator tile Y from latitude. */
function latToTileY(lat, zoom) {
  const sinLat = Math.sin(lat * Math.PI / 180);
  return Math.floor(
    (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * (1 << zoom)
  );
}

/** Return the NW-corner lat/lon of a tile (tx, ty) at zoom z. */
function tileNW(tx, ty, z) {
  const n   = 1 << z;
  const lon = tx / n * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n))) * RAD_TO_DEG;
  return { lat, lon };
}

// ─── Satellite Tile Loader ─────────────────────────────────────────────────────
/**
 * Fetches ESRI World Imagery tiles for a 7×7 grid centred on (homeLat, homeLon)
 * and places each as a textured PlaneGeometry in the Three.js scene.
 *
 * ESRI World Imagery URL format: /tile/{z}/{y}/{x}  (note: y before x)
 * Attribution required: "Esri, Maxar, Earthstar Geographics, and the GIS User Community"
 */
function loadSatelliteTiles(homeLat, homeLon) {
  const cx = lonToTileX(homeLon, TILE_ZOOM);
  const cy = latToTileY(homeLat, TILE_ZOOM);

  const texLoader = new THREE.TextureLoader();

  let loaded = 0;
  const total = (TILE_GRID_HALF * 2 + 1) ** 2;

  for (let dy = -TILE_GRID_HALF; dy <= TILE_GRID_HALF; dy++) {
    for (let dx = -TILE_GRID_HALF; dx <= TILE_GRID_HALF; dx++) {
      const tx = cx + dx;
      const ty = cy + dy;

      // Tile geographic corners
      const nw = tileNW(tx,     ty,     TILE_ZOOM);
      const se = tileNW(tx + 1, ty + 1, TILE_ZOOM);

      // Convert corners to world space
      const nwW = geoToWorld(nw.lat, nw.lon, homeLat, homeLon);
      const seW = geoToWorld(se.lat, se.lon, homeLat, homeLon);

      const tileW = seW.x - nwW.x;           // east-west extent (metres)
      const tileD = nwW.z - seW.z;           // north-south extent (metres, positive)
      const tileCx = (nwW.x + seW.x) / 2;
      const tileCz = (nwW.z + seW.z) / 2;

      // Use Vite proxy in dev (avoids CORS); direct URL in production
      const isDev = location.port === '5173';
      const url   = isDev
        ? `/esri-tiles/ArcGIS/rest/services/World_Imagery/MapServer/tile/${TILE_ZOOM}/${ty}/${tx}`
        : `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${TILE_ZOOM}/${ty}/${tx}`;

      texLoader.load(
        url,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.minFilter  = THREE.LinearMipmapLinearFilter;
          tex.generateMipmaps = true;

          const geo  = new THREE.PlaneGeometry(tileW, tileD);
          const mat  = new THREE.MeshLambertMaterial({ map: tex });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.rotation.x    = -Math.PI / 2;
          mesh.position.set(tileCx, 0, tileCz);
          mesh.receiveShadow = true;
          scene.add(mesh);

          loaded++;
          const pct = Math.round(loaded / total * 100);
          const loadEl = document.getElementById('tile-loading');
          if (loadEl) {
            loadEl.textContent = loaded < total ? `Loading map… ${pct}%` : '';
            if (loaded >= total) setTimeout(() => { loadEl.style.opacity = '0'; }, 800);
          }
        },
        undefined,
        () => {
          // On error, fall back to a plain grass-coloured tile
          const geo  = new THREE.PlaneGeometry(tileW, tileD);
          const mat  = new THREE.MeshLambertMaterial({ color: 0x5a7a3a });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.rotation.x = -Math.PI / 2;
          mesh.position.set(tileCx, 0, tileCz);
          scene.add(mesh);
          loaded++;
        }
      );
    }
  }
}

// ─── Fine Reference Grid (very subtle, drawn on top of satellite) ─────────────

const gridHelper = new THREE.GridHelper(600, 120, 0x000000, 0x000000);
gridHelper.material.opacity    = 0.08;
gridHelper.material.transparent = true;
gridHelper.position.y = 0.15;
scene.add(gridHelper);

// ─── Drone Model ──────────────────────────────────────────────────────────────

const droneGroup = new THREE.Group();
scene.add(droneGroup);

const bodyMat = new THREE.MeshStandardMaterial({
  color: 0x1e293b, roughness: 0.3, metalness: 0.85,
});
const accentMat = new THREE.MeshStandardMaterial({
  color: 0xf59e0b, roughness: 0.2, metalness: 0.9,
  emissive: new THREE.Color(0xf59e0b), emissiveIntensity: 0.2,
});
const armMat = new THREE.MeshStandardMaterial({
  color: 0x0f172a, roughness: 0.4, metalness: 0.7,
});
const propMat = new THREE.MeshStandardMaterial({
  color: 0x334155, roughness: 0.2, metalness: 0.5,
  transparent: true, opacity: 0.85,
});

// Fuselage
const upperBody = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.12, 0.5), bodyMat);
upperBody.position.y = 0.08;
upperBody.castShadow = true;
droneGroup.add(upperBody);

const battPod = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.1, 0.38),
  new THREE.MeshStandardMaterial({ color: 0x1e3a5f, roughness: 0.25, metalness: 0.6 }));
battPod.position.y = -0.01;
battPod.castShadow = true;
droneGroup.add(battPod);

// Amber top strip
const strip = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.018, 0.06), accentMat);
strip.position.set(0, 0.15, 0);
droneGroup.add(strip);

// Camera dome
const dome = new THREE.Mesh(
  new THREE.SphereGeometry(0.07, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.05, metalness: 0.8 })
);
dome.rotation.x = Math.PI;
dome.position.set(0, 0.04, 0.22);
droneGroup.add(dome);

// Lens
const lens = new THREE.Mesh(
  new THREE.CircleGeometry(0.03, 12),
  new THREE.MeshStandardMaterial({
    color: 0x0e7490, roughness: 0, metalness: 1,
    emissive: new THREE.Color(0x22d3ee), emissiveIntensity: 0.3,
  })
);
lens.rotation.x = Math.PI / 2;
lens.position.set(0, 0.04, 0.29);
droneGroup.add(lens);

// Arms & propellers
const ARM_LENGTH  = 0.8;
const propGroups  = [];
const armDefs = [
  { angle:  Math.PI / 4,              ledColor: 0x22d3ee }, // FL — teal
  { angle: -Math.PI / 4,              ledColor: 0x22d3ee }, // FR — teal
  { angle:  Math.PI + Math.PI / 4,    ledColor: 0xef4444 }, // RL — red
  { angle:  Math.PI - Math.PI / 4,    ledColor: 0xef4444 }, // RR — red
];

armDefs.forEach(({ angle, ledColor }) => {
  const tip = new THREE.Vector3(
    Math.sin(angle) * ARM_LENGTH, 0, -Math.cos(angle) * ARM_LENGTH
  );

  // Arm tube
  const armGeo  = new THREE.CylinderGeometry(0.025, 0.035, ARM_LENGTH, 8);
  const armMesh = new THREE.Mesh(armGeo, armMat);
  armMesh.position.copy(tip.clone().multiplyScalar(0.5));
  armMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), tip.clone().normalize());
  armMesh.castShadow = true;
  droneGroup.add(armMesh);

  // Motor
  const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.05, 0.06, 16), bodyMat);
  motor.position.copy(tip).setY(tip.y + 0.03);
  motor.castShadow = true;
  droneGroup.add(motor);

  // Motor ring
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.008, 8, 24), accentMat);
  ring.position.copy(tip);
  ring.rotation.x = Math.PI / 2;
  droneGroup.add(ring);

  // Propeller group
  const propGroup = new THREE.Group();
  propGroup.position.copy(tip).setY(tip.y + 0.075);
  droneGroup.add(propGroup);
  propGroups.push(propGroup);

  [0, Math.PI].forEach((ba) => {
    const bladeGeo = new THREE.CylinderGeometry(0.01, 0.04, 0.38, 8);
    bladeGeo.applyMatrix4(new THREE.Matrix4().makeScale(1, 1, 0.22));
    const blade = new THREE.Mesh(bladeGeo, propMat);
    blade.rotation.y = ba;
    blade.position.set(Math.sin(ba) * 0.19, 0, -Math.cos(ba) * 0.19);
    blade.rotation.z = 0.1;
    propGroup.add(blade);
  });

  // LED
  const led = new THREE.Mesh(
    new THREE.SphereGeometry(0.018, 8, 8),
    new THREE.MeshStandardMaterial({
      color: ledColor, emissive: new THREE.Color(ledColor),
      emissiveIntensity: 2, roughness: 0, metalness: 0,
    })
  );
  led.position.copy(tip).setY(tip.y + 0.04);
  droneGroup.add(led);

  const ledLight = new THREE.PointLight(ledColor, 1.0, 1.5);
  ledLight.position.copy(led.position);
  droneGroup.add(ledLight);
});

// Body underside glow
const bodyGlow = new THREE.PointLight(0x60a5fa, 0.4, 2);
bodyGlow.position.set(0, -0.15, 0);
droneGroup.add(bodyGlow);

// Landing legs
[[ 0.18, -0.12], [-0.18, -0.12], [ 0.18, 0.12], [-0.18, 0.12]].forEach(([lx, lz]) => {
  const leg  = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.18, 6), armMat);
  leg.position.set(lx, -0.09, lz);
  leg.rotation.x = 0.15;
  droneGroup.add(leg);
  const foot = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 8), armMat);
  foot.position.set(lx, -0.18, lz + 0.02);
  droneGroup.add(foot);
});

droneGroup.scale.setScalar(3.5);
droneGroup.position.set(0, 10, 0);

// ─── Shadow blob ─────────────────────────────────────────────────────────────

const shadowMat  = new THREE.MeshBasicMaterial({
  color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false,
});
const shadowBlob = new THREE.Mesh(new THREE.CircleGeometry(1, 32), shadowMat);
shadowBlob.rotation.x = -Math.PI / 2;
shadowBlob.position.y = 0.2;
scene.add(shadowBlob);

// ─── Flight-path Trail ────────────────────────────────────────────────────────

const TRAIL_LEN   = 200;
const trailPos    = new Float32Array(TRAIL_LEN * 3);
const trailGeo    = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
trailGeo.setDrawRange(0, 0);

const trailLine = new THREE.Line(trailGeo,
  new THREE.LineBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.55 })
);
scene.add(trailLine);

let trailIdx   = 0;
let trailCount = 0;

function appendTrail(x, y, z) {
  const i = (trailIdx % TRAIL_LEN) * 3;
  trailPos[i] = x; trailPos[i+1] = y; trailPos[i+2] = z;
  trailIdx++;
  trailCount = Math.min(trailCount + 1, TRAIL_LEN);
  trailGeo.setDrawRange(0, trailCount);
  trailGeo.attributes.position.needsUpdate = true;
}

// ─── Mission Route & Waypoint Rendering ───────────────────────────────────────

const routeGroup = new THREE.Group();
routeGroup.name = 'missionRoute';
scene.add(routeGroup);

let lastRouteJSON = '';      // JSON cache to detect changes
let lastActiveWp  = -1;      // last rendered active waypoint
let wpMeshes      = [];      // references to waypoint sphere meshes for highlighting
let wpGlowLights  = [];      // point lights on each waypoint

// Materials
const WP_MAT_INACTIVE = new THREE.MeshStandardMaterial({
  color: 0x38bdf8, roughness: 0.3, metalness: 0.4,
  emissive: new THREE.Color(0x38bdf8), emissiveIntensity: 0.4,
});
const WP_MAT_ACTIVE = new THREE.MeshStandardMaterial({
  color: 0x4ade80, roughness: 0.15, metalness: 0.5,
  emissive: new THREE.Color(0x4ade80), emissiveIntensity: 1.0,
});
const WP_LINE_MAT = new THREE.LineBasicMaterial({
  color: 0xf59e0b, linewidth: 2, transparent: true, opacity: 0.85,
});
const WP_DROP_MAT = new THREE.LineDashedMaterial({
  color: 0x94a3b8, dashSize: 1, gapSize: 0.5, transparent: true, opacity: 0.4,
});
const WP_LABEL_CANVAS_SIZE = 64;

/**
 * Create a small canvas texture with a waypoint number label.
 */
function createWpLabelSprite(seq) {
  const canvas = document.createElement('canvas');
  canvas.width = WP_LABEL_CANVAS_SIZE;
  canvas.height = WP_LABEL_CANVAS_SIZE;
  const ctx = canvas.getContext('2d');

  // Circle background
  ctx.beginPath();
  ctx.arc(32, 32, 28, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.8)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Number
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 22px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(seq), 32, 33);

  const tex = new THREE.CanvasTexture(canvas);
  const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.scale.set(3, 3, 1);
  return sprite;
}

/**
 * Build the full 3D route from telemetry.route waypoints.
 * Called when the route data changes.
 */
function buildRouteVisuals(route, refLat, refLon) {
  // Clear previous
  while (routeGroup.children.length > 0) {
    const child = routeGroup.children[0];
    routeGroup.remove(child);
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (child.material.map) child.material.map.dispose();
      child.material.dispose();
    }
  }
  wpMeshes = [];
  wpGlowLights = [];

  if (!route || route.length === 0) return;

  const wpSphereGeo = new THREE.SphereGeometry(1.2, 16, 12);
  const pathPoints = [];

  route.forEach((wp, i) => {
    const world = geoToWorld(wp.lat, wp.lon, refLat, refLon);
    const alt = wp.alt || 50;
    const pos = new THREE.Vector3(world.x, alt, world.z);
    pathPoints.push(pos);

    // ── Waypoint sphere ──────────────────────────────────────────────────
    const sphere = new THREE.Mesh(wpSphereGeo, WP_MAT_INACTIVE.clone());
    sphere.position.copy(pos);
    sphere.castShadow = true;
    sphere.userData.wpSeq = wp.seq;
    routeGroup.add(sphere);
    wpMeshes.push(sphere);

    // ── Glow point light ─────────────────────────────────────────────────
    const glow = new THREE.PointLight(0x38bdf8, 0.6, 15);
    glow.position.copy(pos);
    routeGroup.add(glow);
    wpGlowLights.push(glow);

    // ── Vertical drop-line to ground ─────────────────────────────────────
    const dropGeo = new THREE.BufferGeometry().setFromPoints([
      pos, new THREE.Vector3(world.x, 0.5, world.z),
    ]);
    const dropLine = new THREE.Line(dropGeo, WP_DROP_MAT.clone());
    dropLine.computeLineDistances();
    routeGroup.add(dropLine);

    // ── Label sprite above waypoint ───────────────────────────────────────
    const label = createWpLabelSprite(i);
    label.position.set(world.x, alt + 3.5, world.z);
    routeGroup.add(label);
  });

  // ── Path line connecting waypoints sequentially ────────────────────────
  if (pathPoints.length >= 2) {
    const pathGeo = new THREE.BufferGeometry().setFromPoints(pathPoints);
    const pathLine = new THREE.Line(pathGeo, WP_LINE_MAT);
    routeGroup.add(pathLine);

    // Close the loop if more than 2 waypoints (mission typically returns to start)
    if (pathPoints.length > 2) {
      const loopGeo = new THREE.BufferGeometry().setFromPoints([
        pathPoints[pathPoints.length - 1], pathPoints[0],
      ]);
      const loopLine = new THREE.Line(loopGeo, WP_LINE_MAT.clone());
      loopLine.material.opacity = 0.4;
      routeGroup.add(loopLine);
    }
  }

  console.log(`[ROUTE] Built ${route.length} waypoint markers in 3D scene`);
}

/**
 * Update the active waypoint highlight.
 */
function updateActiveWaypoint(activeSeq) {
  wpMeshes.forEach((mesh, i) => {
    const isActive = mesh.userData.wpSeq === activeSeq;
    mesh.material.color.set(isActive ? 0x4ade80 : 0x38bdf8);
    mesh.material.emissive.set(isActive ? 0x4ade80 : 0x38bdf8);
    mesh.material.emissiveIntensity = isActive ? 1.2 : 0.4;
    mesh.scale.setScalar(isActive ? 1.5 : 1.0);

    if (wpGlowLights[i]) {
      wpGlowLights[i].color.set(isActive ? 0x4ade80 : 0x38bdf8);
      wpGlowLights[i].intensity = isActive ? 2.0 : 0.6;
      wpGlowLights[i].distance = isActive ? 25 : 15;
    }
  });
}

// ─── Smooth State ─────────────────────────────────────────────────────────────

let smoothRoll = 0, smoothPitch = 0, smoothYaw = 0, smoothAlt = 10;
let homeLat = null, homeLon = null;
let tilesLoaded = false;

// ─── WebSocket Client ─────────────────────────────────────────────────────────

let ws            = null;
let lastTelemetry = null;
let wsPingSent    = 0;
let wsLatencyMs   = 0;
let isConnected   = false;

const elConnDot   = document.getElementById('conn-dot');
const elConnLabel = document.getElementById('conn-label');
const elWsLatency = document.getElementById('ws-latency');

function connectWebSocket() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    isConnected = true;
    setConnectionUI(true);
    wsPingSent = performance.now();
  };

  ws.onmessage = (event) => {
    const now    = performance.now();
    wsLatencyMs  = Math.round(now - wsPingSent);
    wsPingSent   = now;
    try { lastTelemetry = JSON.parse(event.data); } catch {}
  };

  ws.onclose = () => {
    isConnected = false;
    setConnectionUI(false);
    setTimeout(connectWebSocket, WS_RECONNECT_MS);
  };

  ws.onerror = () => ws.close();
}

function setConnectionUI(connected) {
  elConnDot.className     = connected ? 'dot dot--connected' : 'dot dot--disconnected';
  elConnLabel.textContent = connected ? 'LIVE TELEMETRY' : 'DISCONNECTED';
  elConnLabel.style.color = connected ? 'var(--color-green)' : '';
}

connectWebSocket();

// ─── Attitude Indicator (ADI) ─────────────────────────────────────────────────

const adiCanvas = document.getElementById('adi-canvas');
const adiCtx    = adiCanvas.getContext('2d');
const ADI_W = adiCanvas.width, ADI_H = adiCanvas.height;
const ADI_CX = ADI_W / 2, ADI_CY = ADI_H / 2, ADI_R = ADI_W / 2 - 4;

function drawADI(roll, pitch) {
  adiCtx.clearRect(0, 0, ADI_W, ADI_H);
  adiCtx.save();
  adiCtx.beginPath();
  adiCtx.arc(ADI_CX, ADI_CY, ADI_R, 0, Math.PI * 2);
  adiCtx.clip();

  adiCtx.translate(ADI_CX, ADI_CY);
  adiCtx.rotate(-roll);

  const pitchPx = pitch * ADI_R * 1.5;

  // Sky
  const skyG = adiCtx.createLinearGradient(0, -ADI_R, 0, pitchPx);
  skyG.addColorStop(0, '#0c4a6e'); skyG.addColorStop(0.6, '#0ea5e9'); skyG.addColorStop(1, '#7dd3fc');
  adiCtx.fillStyle = skyG;
  adiCtx.fillRect(-ADI_R, -ADI_R, ADI_R*2, ADI_R + pitchPx);

  // Ground
  const gndG = adiCtx.createLinearGradient(0, pitchPx, 0, ADI_R);
  gndG.addColorStop(0, '#854d0e'); gndG.addColorStop(1, '#451a03');
  adiCtx.fillStyle = gndG;
  adiCtx.fillRect(-ADI_R, pitchPx, ADI_R*2, ADI_R);

  // Horizon
  adiCtx.strokeStyle = 'rgba(255,255,255,0.9)'; adiCtx.lineWidth = 2;
  adiCtx.beginPath(); adiCtx.moveTo(-ADI_R, pitchPx); adiCtx.lineTo(ADI_R, pitchPx); adiCtx.stroke();

  // Pitch marks
  adiCtx.strokeStyle = 'rgba(255,255,255,0.5)'; adiCtx.lineWidth = 1;
  adiCtx.fillStyle = 'rgba(255,255,255,0.7)'; adiCtx.font = '9px JetBrains Mono,monospace'; adiCtx.textAlign = 'center';
  for (let d = -30; d <= 30; d += 10) {
    if (d === 0) continue;
    const py = pitchPx + (d * Math.PI/180) * ADI_R * 1.5;
    const w  = d % 20 === 0 ? 28 : 18;
    adiCtx.beginPath(); adiCtx.moveTo(-w, py); adiCtx.lineTo(w, py); adiCtx.stroke();
    if (Math.abs(py) < ADI_R * 0.9) adiCtx.fillText(String(Math.abs(d)), w+8, py+3);
  }
  adiCtx.restore();

  // Fixed aircraft symbol
  adiCtx.save(); adiCtx.translate(ADI_CX, ADI_CY);
  adiCtx.strokeStyle = '#f59e0b'; adiCtx.lineWidth = 2.5; adiCtx.lineCap = 'round';
  adiCtx.beginPath(); adiCtx.moveTo(-28,0); adiCtx.lineTo(-8,0); adiCtx.lineTo(-8,5); adiCtx.stroke();
  adiCtx.beginPath(); adiCtx.moveTo(28,0);  adiCtx.lineTo(8,0);  adiCtx.lineTo(8,5);  adiCtx.stroke();
  adiCtx.beginPath(); adiCtx.arc(0,0,3,0,Math.PI*2);
  adiCtx.fillStyle = '#f59e0b'; adiCtx.fill();
  adiCtx.restore();

  // Border
  adiCtx.beginPath(); adiCtx.arc(ADI_CX, ADI_CY, ADI_R, 0, Math.PI*2);
  adiCtx.strokeStyle = 'rgba(255,255,255,0.14)'; adiCtx.lineWidth = 2; adiCtx.stroke();
}

// ─── HUD DOM Refs ─────────────────────────────────────────────────────────────

const el = {
  roll:         document.getElementById('val-roll'),
  pitch:        document.getElementById('val-pitch'),
  yaw:          document.getElementById('val-yaw'),
  voltage:      document.getElementById('val-voltage'),
  current:      document.getElementById('val-current'),
  battPct:      document.getElementById('battery-pct'),
  battFill:     document.getElementById('battery-fill'),
  lat:          document.getElementById('val-lat'),
  lon:          document.getElementById('val-lon'),
  alt:          document.getElementById('val-alt'),
  altMsl:       document.getElementById('val-alt-msl'),
  groundspeed:  document.getElementById('val-groundspeed'),
  airspeed:     document.getElementById('val-airspeed'),
  heading:      document.getElementById('val-heading'),
  climb:        document.getElementById('val-climb'),
  throttle:     document.getElementById('val-throttle'),
  throttleFill: document.getElementById('throttle-fill'),
  armPill:      document.getElementById('arm-pill'),
  armLabel:     document.getElementById('arm-label'),
  modeLabel:    document.getElementById('mode-label'),
};

function updateHUD(t) {
  const rollDeg  = (t.attitude.roll  * RAD_TO_DEG).toFixed(1);
  const pitchDeg = (t.attitude.pitch * RAD_TO_DEG).toFixed(1);
  const yawDeg   = ((t.attitude.yaw  * RAD_TO_DEG + 360) % 360).toFixed(1);

  el.roll.textContent  = `${rollDeg}°`;
  el.pitch.textContent = `${pitchDeg}°`;
  el.yaw.textContent   = `${yawDeg}°`;
  el.roll.className    = 'data-value' + (Math.abs(t.attitude.roll)  > 0.52 ? ' text-amber' : '');
  el.pitch.className   = 'data-value' + (Math.abs(t.attitude.pitch) > 0.35 ? ' text-amber' : '');

  drawADI(t.attitude.roll, t.attitude.pitch);

  const pct = t.battery.remaining;
  el.battPct.textContent = pct >= 0 ? `${pct}%` : '--%';
  el.voltage.textContent = t.battery.voltage  > 0 ? `${t.battery.voltage.toFixed(1)}V`  : '--.-V';
  el.current.textContent = t.battery.current  > 0 ? `${t.battery.current.toFixed(1)}A`  : '--.-A';
  if (pct >= 0) {
    el.battFill.style.transform  = `scaleX(${pct / 100})`;
    const hue = pct > 50 ? 142 : pct > 20 ? 45 : 0;
    el.battFill.style.background = `linear-gradient(90deg,hsl(${hue},70%,40%),hsl(${hue},70%,55%))`;
    el.battPct.style.color = pct < 20 ? '#fca5a5' : '#fff';
  }

  el.lat.textContent    = t.position.lat !== 0 ? `${t.position.lat.toFixed(6)}°` : '--.------°';
  el.lon.textContent    = t.position.lon !== 0 ? `${t.position.lon.toFixed(6)}°` : '--.------°';
  el.alt.textContent    = `${t.position.relative_alt.toFixed(1)} m`;
  el.altMsl.textContent = `${t.position.alt.toFixed(1)} m`;
  el.alt.className      = 'data-value' + (t.position.relative_alt > 80 ? ' text-amber' : '');

  el.groundspeed.textContent = `${t.vfr.groundspeed.toFixed(2)} m/s`;
  el.airspeed.textContent    = `${t.vfr.airspeed.toFixed(2)} m/s`;
  el.heading.textContent     = `${t.vfr.heading}°`;
  el.climb.textContent       = `${t.vfr.climb >= 0 ? '+' : ''}${t.vfr.climb.toFixed(2)} m/s`;
  el.climb.className = 'data-value' + (t.vfr.climb > 0.3 ? ' text-green' : t.vfr.climb < -0.3 ? ' text-red' : '');
  el.throttle.textContent      = `${t.vfr.throttle}%`;
  el.throttleFill.style.width  = `${t.vfr.throttle}%`;

  if (t.status.armed) {
    el.armLabel.textContent = 'ARMED';
    el.armPill.className    = 'status-pill armed';
  } else {
    el.armLabel.textContent = 'DISARMED';
    el.armPill.className    = 'status-pill disarmed';
  }
  el.modeLabel.textContent = t.status.mode || '---';
  elWsLatency.textContent  = isConnected ? `WS: ${wsLatencyMs} ms` : 'WS: ---';
}

// ─── UTC Clock ────────────────────────────────────────────────────────────────

const elClock = document.getElementById('clock');
function updateClock() {
  const n  = new Date();
  const hh = String(n.getUTCHours()).padStart(2,'0');
  const mm = String(n.getUTCMinutes()).padStart(2,'0');
  const ss = String(n.getUTCSeconds()).padStart(2,'0');
  elClock.textContent = `${hh}:${mm}:${ss} UTC`;
}
setInterval(updateClock, 1000);
updateClock();

// ─── Resize ───────────────────────────────────────────────────────────────────

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─── Map Attribution ──────────────────────────────────────────────────────────
// Required by ESRI terms of service
(function() {
  const attr = document.createElement('div');
  attr.id = 'map-attribution';
  attr.textContent = '© Esri, Maxar, Earthstar Geographics';
  Object.assign(attr.style, {
    position:'fixed', bottom:'42px', right:'8px',
    fontSize:'9px', color:'rgba(255,255,255,0.35)',
    fontFamily:'sans-serif', pointerEvents:'none', zIndex:'60',
  });
  document.body.appendChild(attr);
})();

// ─── Tile loading indicator ───────────────────────────────────────────────────
(function() {
  const el = document.createElement('div');
  el.id = 'tile-loading';
  Object.assign(el.style, {
    position:'fixed', top:'60px', left:'50%', transform:'translateX(-50%)',
    background:'rgba(14,21,32,0.85)', color:'#f59e0b',
    padding:'6px 16px', borderRadius:'20px', fontSize:'11px',
    fontFamily:'JetBrains Mono,monospace', fontWeight:'600',
    backdropFilter:'blur(8px)', border:'1px solid rgba(245,158,11,0.25)',
    transition:'opacity 1s', zIndex:'120', letterSpacing:'0.08em',
  });
  el.textContent = 'Loading map…';
  document.body.appendChild(el);
})();

// ─── Animation Loop ───────────────────────────────────────────────────────────

const timer = new Timer();
let trailTimer = 0;

function animate() {
  requestAnimationFrame(animate);
  timer.update();
  const delta = timer.getDelta();
  trailTimer += delta;

  if (lastTelemetry) {
    const t = lastTelemetry;

    // ── Load satellite tiles once we have a home position ─────────────────
    if (!tilesLoaded && t.position.lat !== 0) {
      homeLat = t.position.lat;
      homeLon = t.position.lon;
      loadSatelliteTiles(homeLat, homeLon);
      tilesLoaded = true;
    }

    // ── Attitude smoothing (NED → Three.js Y-up) ─────────────────────────
    // roll  → Z axis (bank right = +Z)
    // pitch → X axis (nose-up = -X)
    // yaw   → Y axis (clockwise heading = -Y)
    smoothRoll  += (t.attitude.roll  - smoothRoll)  * SMOOTH_ALPHA;
    smoothPitch += (t.attitude.pitch - smoothPitch) * SMOOTH_ALPHA;
    smoothAlt   += (Math.max(0, t.position.relative_alt) - smoothAlt) * SMOOTH_ALPHA;

    let yawDelta = t.attitude.yaw - smoothYaw;
    if (yawDelta >  Math.PI) yawDelta -= Math.PI * 2;
    if (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
    smoothYaw += yawDelta * SMOOTH_ALPHA;

    droneGroup.rotation.set(-smoothPitch, -smoothYaw, smoothRoll, 'ZYX');
    droneGroup.position.y = smoothAlt;

    // ── GPS position → XZ world ──────────────────────────────────────────
    if (homeLat !== null && t.position.lat !== 0) {
      const wp = geoToWorld(t.position.lat, t.position.lon, homeLat, homeLon);
      droneGroup.position.x = wp.x;
      droneGroup.position.z = wp.z;
    }

    // ── Shadow blob (scales down with altitude) ───────────────────────────
    const shadowScale = Math.max(0.15, 1 - smoothAlt / 100);
    shadowBlob.position.x = droneGroup.position.x;
    shadowBlob.position.z = droneGroup.position.z;
    shadowBlob.scale.setScalar(shadowScale * 5);
    shadowMat.opacity = shadowScale * 0.3;

    // ── Trail (every 250 ms) ──────────────────────────────────────────────
    if (trailTimer > 0.25) {
      appendTrail(droneGroup.position.x, droneGroup.position.y, droneGroup.position.z);
      trailTimer = 0;
    }

    // ── Route / Waypoint Visualization ────────────────────────────────────
    if (homeLat !== null && t.route && t.route.length > 0) {
      const routeJSON = JSON.stringify(t.route);
      if (routeJSON !== lastRouteJSON) {
        lastRouteJSON = routeJSON;
        buildRouteVisuals(t.route, homeLat, homeLon);
        lastActiveWp = -1; // force active wp update
      }
      // Update active waypoint highlight
      const currentWp = t.status?.active_wp ?? -1;
      if (currentWp !== lastActiveWp) {
        lastActiveWp = currentWp;
        updateActiveWaypoint(currentWp);
      }

      // Pulse active waypoint glow
      wpMeshes.forEach((mesh, i) => {
        if (mesh.userData.wpSeq === currentWp) {
          const pulse = 1.3 + Math.sin(performance.now() * 0.004) * 0.3;
          mesh.scale.setScalar(pulse);
          if (wpGlowLights[i]) {
            wpGlowLights[i].intensity = 1.5 + Math.sin(performance.now() * 0.004) * 0.8;
          }
        }
      });
    }

    updateHUD(t);
  }

  // ── Propeller spin (fast when armed, slow idle otherwise) ─────────────
  const propSpeed = lastTelemetry?.status.armed ? 18 : 1.5;
  propGroups.forEach((pg, i) => {
    pg.rotation.y += delta * propSpeed * ((i === 0 || i === 3) ? 1 : -1);
  });

  // ── Camera soft-follows drone ─────────────────────────────────────────
  controls.target.lerp(droneGroup.position, 0.04);
  controls.update();

  renderer.render(scene, camera);
}

animate();
