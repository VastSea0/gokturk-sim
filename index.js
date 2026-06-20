/**
 * index.js — Göktürk UAV Three.js Frontend
 *
 * Major features:
 *  1. Realistic sky dome (Three.js Sky shader with sun position)
 *  2. Dynamic satellite tile manager (Esri / Google, zoom 15-19, auto-load/unload)
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

const MPDL            = 111319.5; // metres per degree latitude

let runwayGroup = null;
const runwaySettings = {
  show: true,
  autoAlign: true,
  heading: 0,
  length: 300,
  width: 20,
  offsetX: 0,
  offsetZ: 0
};

// Satellite tile config — defaults (overridable via UI)
const DEFAULT_TILE_ZOOM = 17;
const DEFAULT_TILE_GRID_HALF = 5;     // (2*5+1)=11×11 = 121 tiles
const TILE_PROVIDERS = {
  esri:   { name: 'Esri World Imagery',   label: 'ESRI' },
  google: { name: 'Google Satellite',      label: 'GOOGLE' },
};

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

// ─── Dynamic Tile Manager ──────────────────────────────────────────────────────
/**
 * Dynamically loads / unloads satellite map tiles as the drone moves.
 * Supports Esri World Imagery and Google Satellite providers.
 * Manages GPU memory by disposing textures & geometry of off-screen tiles.
 *
 * Usage:
 *   const tm = new TileManager(scene, refLat, refLon);
 *   // each frame or periodically:
 *   tm.update(currentLat, currentLon);
 *   // switch provider:
 *   tm.setProvider('google');
 *   // change zoom:
 *   tm.setZoom(18);
 */
class TileManager {
  constructor(targetScene, refLat, refLon) {
    this.scene    = targetScene;
    this.refLat   = refLat;
    this.refLon   = refLon;
    this.zoom     = DEFAULT_TILE_ZOOM;
    this.gridHalf = DEFAULT_TILE_GRID_HALF;
    this.provider = 'esri';    // 'esri' | 'google'
    this.tiles    = new Map(); // key "z/tx/ty" → { mesh, state:'loading'|'ready' }
    this.texLoader = new THREE.TextureLoader();
    this.lastCx   = null;      // last centre tile X (to avoid redundant updates)
    this.lastCy   = null;
    this._pendingCount = 0;
    this._readyCount   = 0;
  }

  /** Build a tile image URL with Vite-proxy awareness. */
  _tileUrl(z, ty, tx) {
    const isDev = ['5173','5174','5175','5176'].includes(location.port);
    switch (this.provider) {
      case 'google':
        return isDev
          ? `/google-tiles/vt/lyrs=s&x=${tx}&y=${ty}&z=${z}`
          : `https://mt1.google.com/vt/lyrs=s&x=${tx}&y=${ty}&z=${z}`;
      case 'esri':
      default:
        return isDev
          ? `/esri-tiles/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${tx}`
          : `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${tx}`;
    }
  }

  /** Call every frame (internally rate-limits). Loads new tiles, removes distant. */
  update(lat, lon) {
    const cx = lonToTileX(lon, this.zoom);
    const cy = latToTileY(lat, this.zoom);

    // Skip if centre tile hasn't changed
    if (cx === this.lastCx && cy === this.lastCy) return;
    this.lastCx = cx;
    this.lastCy = cy;

    const neededKeys = new Set();

    for (let dy = -this.gridHalf; dy <= this.gridHalf; dy++) {
      for (let dx = -this.gridHalf; dx <= this.gridHalf; dx++) {
        const tx = cx + dx;
        const ty = cy + dy;
        const key = `${this.zoom}/${tx}/${ty}`;
        neededKeys.add(key);

        if (!this.tiles.has(key)) {
          this._loadTile(tx, ty, key);
        }
      }
    }

    // Remove tiles that are no longer needed
    for (const [key, entry] of this.tiles) {
      if (!neededKeys.has(key)) {
        this._disposeTile(key, entry);
      }
    }

    this._updateLoadingUI();
  }

  /** Load a single tile and place it in the scene. */
  _loadTile(tx, ty, key) {
    // Mark as loading (null mesh)
    this.tiles.set(key, { mesh: null, state: 'loading' });
    this._pendingCount++;

    const nw  = tileNW(tx,     ty,     this.zoom);
    const se  = tileNW(tx + 1, ty + 1, this.zoom);
    const nwW = geoToWorld(nw.lat, nw.lon, this.refLat, this.refLon);
    const seW = geoToWorld(se.lat, se.lon, this.refLat, this.refLon);

    const tileW  = seW.x - nwW.x;
    const tileD  = nwW.z - seW.z;
    const tileCx = (nwW.x + seW.x) / 2;
    const tileCz = (nwW.z + seW.z) / 2;

    const url = this._tileUrl(this.zoom, ty, tx);

    this.texLoader.load(
      url,
      (tex) => {
        // Tile may have been disposed while loading
        if (!this.tiles.has(key)) { tex.dispose(); return; }

        tex.colorSpace      = THREE.SRGBColorSpace;
        tex.minFilter       = THREE.LinearMipmapLinearFilter;
        tex.generateMipmaps = true;
        tex.anisotropy      = Math.min(4, renderer.capabilities.getMaxAnisotropy());

        const geo  = new THREE.PlaneGeometry(Math.abs(tileW), Math.abs(tileD));
        const mat  = new THREE.MeshLambertMaterial({ map: tex });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x    = -Math.PI / 2;
        mesh.position.set(tileCx, 0, tileCz);
        mesh.receiveShadow = true;
        this.scene.add(mesh);

        this.tiles.set(key, { mesh, state: 'ready' });
        this._pendingCount--;
        this._readyCount++;
        this._updateLoadingUI();
      },
      undefined,
      () => {
        // On error, fall back to plain terrain colour
        if (!this.tiles.has(key)) return;

        const geo  = new THREE.PlaneGeometry(Math.abs(tileW), Math.abs(tileD));
        const mat  = new THREE.MeshLambertMaterial({ color: 0x5a7a3a });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(tileCx, 0, tileCz);
        this.scene.add(mesh);

        this.tiles.set(key, { mesh, state: 'ready' });
        this._pendingCount--;
        this._readyCount++;
        this._updateLoadingUI();
      }
    );
  }

  /** Dispose a tile's GPU resources and remove from scene + map. */
  _disposeTile(key, entry) {
    if (entry && entry.mesh) {
      this.scene.remove(entry.mesh);
      if (entry.mesh.material.map) entry.mesh.material.map.dispose();
      entry.mesh.material.dispose();
      entry.mesh.geometry.dispose();
    }
    this.tiles.delete(key);
  }

  /** Update the on-screen loading indicator. */
  _updateLoadingUI() {
    const el = document.getElementById('tile-loading');
    if (!el) return;
    if (this._pendingCount > 0) {
      el.textContent = `Loading map… ${this._pendingCount} tiles`;
      el.style.opacity = '1';
    } else {
      el.textContent = `Map ✓ ${this._readyCount} tiles`;
      setTimeout(() => { el.style.opacity = '0'; }, 1200);
    }
  }

  /** Switch tile provider (clears all tiles and reloads). */
  setProvider(provider) {
    if (this.provider === provider) return;
    this.provider = provider;
    this._clearAll();
    // Update attribution text
    const attr = document.getElementById('map-attribution');
    if (attr) {
      attr.textContent = provider === 'google'
        ? 'Map data © Google'
        : 'Esri, Maxar, Earthstar Geographics';
    }
  }

  /** Change zoom level (clears all tiles and reloads). */
  setZoom(zoom) {
    zoom = Math.max(15, Math.min(19, zoom));
    if (this.zoom === zoom) return;
    this.zoom = zoom;
    this._clearAll();
  }

  /** Remove and dispose every tile. Forces full re-download on next update(). */
  _clearAll() {
    for (const [key, entry] of this.tiles) {
      this._disposeTile(key, entry);
    }
    this.tiles.clear();
    this.lastCx = null;
    this.lastCy = null;
    this._pendingCount = 0;
    this._readyCount   = 0;
  }
}

/** Global TileManager instance (created when home position is known). */
let tileManager = null;

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

const MAX_TRAIL_POINTS = 300;
const trailPoints = [];

const trailGeo = new THREE.BufferGeometry();
const trailMat = new THREE.LineBasicMaterial({
  vertexColors: true,
  transparent: true,
  opacity: 0.9
});
const trailLine = new THREE.Line(trailGeo, trailMat);
scene.add(trailLine);

const curtainGeo = new THREE.BufferGeometry();
const curtainMat = new THREE.MeshBasicMaterial({
  vertexColors: true,
  transparent: true,
  opacity: 0.25,
  side: THREE.DoubleSide,
  depthWrite: false,
  blending: THREE.AdditiveBlending
});
const trailCurtain = new THREE.Mesh(curtainGeo, curtainMat);
scene.add(trailCurtain);

function appendTrail(x, y, z) {
  trailPoints.push(new THREE.Vector3(x, y, z));
  if (trailPoints.length > MAX_TRAIL_POINTS) {
    trailPoints.shift();
  }

  const N = trailPoints.length;
  if (N < 2) return;

  // ── Update Trail Line ───────────────────────────────────────────────
  const linePositions = new Float32Array(N * 3);
  const lineColors = new Float32Array(N * 3);

  for (let i = 0; i < N; i++) {
    const p = trailPoints[i];
    const t = i / (N - 1 || 1); // Age factor [0, 1]

    linePositions[i * 3] = p.x;
    linePositions[i * 3 + 1] = p.y;
    linePositions[i * 3 + 2] = p.z;

    // Fade to brand amber (RGB: 0.96, 0.62, 0.04)
    lineColors[i * 3] = 0.96 * t;
    lineColors[i * 3 + 1] = 0.62 * t;
    lineColors[i * 3 + 2] = 0.04 * t;
  }

  trailGeo.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
  trailGeo.setAttribute('color', new THREE.BufferAttribute(lineColors, 3));
  trailGeo.computeBoundingBox();
  trailGeo.computeBoundingSphere();

  // ── Update Trail Curtain ─────────────────────────────────────────────
  const curtainPositions = new Float32Array(N * 2 * 3);
  const curtainColors = new Float32Array(N * 2 * 3);
  const curtainIndices = [];

  for (let i = 0; i < N; i++) {
    const p = trailPoints[i];
    const t = i / (N - 1 || 1); // Age factor [0, 1]

    // Top vertex (flight path)
    const idxTop = i * 2;
    curtainPositions[idxTop * 3] = p.x;
    curtainPositions[idxTop * 3 + 1] = p.y;
    curtainPositions[idxTop * 3 + 2] = p.z;

    curtainColors[idxTop * 3] = 0.96 * t;
    curtainColors[idxTop * 3 + 1] = 0.62 * t;
    curtainColors[idxTop * 3 + 2] = 0.04 * t;

    // Bottom vertex (ground projection)
    const idxBot = i * 2 + 1;
    curtainPositions[idxBot * 3] = p.x;
    curtainPositions[idxBot * 3 + 1] = 0.15; // slightly above ground to prevent z-fighting
    curtainPositions[idxBot * 3 + 2] = p.z;

    // Bottom color: black (blends to 0 in Additive Blending)
    curtainColors[idxBot * 3] = 0;
    curtainColors[idxBot * 3 + 1] = 0;
    curtainColors[idxBot * 3 + 2] = 0;

    if (i < N - 1) {
      const t0 = i * 2;
      const b0 = i * 2 + 1;
      const t1 = (i + 1) * 2;
      const b1 = (i + 1) * 2 + 1;

      // Quad triangles
      curtainIndices.push(t0, b0, t1);
      curtainIndices.push(b0, b1, t1);
    }
  }

  curtainGeo.setAttribute('position', new THREE.BufferAttribute(curtainPositions, 3));
  curtainGeo.setAttribute('color', new THREE.BufferAttribute(curtainColors, 3));
  curtainGeo.setIndex(curtainIndices);
  curtainGeo.computeBoundingBox();
  curtainGeo.computeBoundingSphere();
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

// Slope-based Segment Materials
const SEGMENT_CLIMB_MAT = new THREE.LineBasicMaterial({
  color: 0x10b981, linewidth: 2, transparent: true, opacity: 0.85
});
const SEGMENT_DESCEND_MAT = new THREE.LineBasicMaterial({
  color: 0xf59e0b, linewidth: 2, transparent: true, opacity: 0.85
});
const SEGMENT_CRUISE_MAT = new THREE.LineBasicMaterial({
  color: 0x38bdf8, linewidth: 2, transparent: true, opacity: 0.85
});

const CONE_CLIMB_MAT = new THREE.MeshBasicMaterial({
  color: 0x10b981, transparent: true, opacity: 0.8, side: THREE.DoubleSide
});
const CONE_DESCEND_MAT = new THREE.MeshBasicMaterial({
  color: 0xf59e0b, transparent: true, opacity: 0.8, side: THREE.DoubleSide
});
const CONE_CRUISE_MAT = new THREE.MeshBasicMaterial({
  color: 0x38bdf8, transparent: true, opacity: 0.8, side: THREE.DoubleSide
});

const WP_LABEL_CANVAS_SIZE = 64;

function createSegmentLabelSprite(text, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  
  // Capsule background
  ctx.beginPath();
  ctx.roundRect(4, 4, 120, 24, 12);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
  ctx.fill();
  ctx.strokeStyle = `rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}, 0.8)`;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  
  // Text
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 10px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 16);
  
  const tex = new THREE.CanvasTexture(canvas);
  const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.scale.set(6, 1.5, 1);
  return sprite;
}

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

function updateActiveWaypoint(activeSeq) {
  wpMeshes.forEach((mesh) => {
    if (mesh.userData.wpSeq === activeSeq) {
      mesh.material = WP_MAT_ACTIVE;
    } else {
      mesh.material = WP_MAT_INACTIVE;
    }
  });
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
    if (!wp || (wp.lat === 0 && wp.lon === 0)) return; // Skip dummy coordinates (e.g. Home position metadata or RTL without explicit coordinates)
    const world = geoToWorld(wp.lat, wp.lon, refLat, refLon);
    const alt = wp.alt || 50;
    const pos = new THREE.Vector3(world.x, alt, world.z);
    pathPoints.push(pos);

    // ── Waypoint sphere (Use WP_MAT_INACTIVE directly, no clone) ───────────
    const sphere = new THREE.Mesh(wpSphereGeo, WP_MAT_INACTIVE);
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
    for (let i = 0; i < pathPoints.length - 1; i++) {
      const pStart = pathPoints[i];
      const pEnd = pathPoints[i+1];
      const dAlt = pEnd.y - pStart.y;
      
      let matLine = SEGMENT_CRUISE_MAT;
      let matCone = CONE_CRUISE_MAT;
      let typeLabel = "CRUISE";
      
      if (dAlt > 2) {
        matLine = SEGMENT_CLIMB_MAT;
        matCone = CONE_CLIMB_MAT;
        typeLabel = `CLIMB (+${Math.round(dAlt)}m)`;
      } else if (dAlt < -2) {
        matLine = SEGMENT_DESCEND_MAT;
        matCone = CONE_DESCEND_MAT;
        typeLabel = `DESCEND (-${Math.round(Math.abs(dAlt))}m)`;
      } else {
        typeLabel = `CRUISE (${Math.round(pStart.y)}m)`;
      }
      
      // Segment line
      const segGeo = new THREE.BufferGeometry().setFromPoints([pStart, pEnd]);
      const segLine = new THREE.Line(segGeo, matLine);
      routeGroup.add(segLine);
      
      // Direction cone in the middle of segment
      const midPoint = new THREE.Vector3().addVectors(pStart, pEnd).multiplyScalar(0.5);
      const coneGeo = new THREE.ConeGeometry(0.8, 3.0, 8);
      const coneMesh = new THREE.Mesh(coneGeo, matCone);
      coneMesh.position.copy(midPoint);
      
      const direction = new THREE.Vector3().subVectors(pEnd, pStart).normalize();
      coneMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
      routeGroup.add(coneMesh);

      // Add segment slope label
      const labelSprite = createSegmentLabelSprite(typeLabel, matCone.color);
      labelSprite.position.copy(midPoint).y += 2.5;
      routeGroup.add(labelSprite);
    }

    // Close the loop if more than 2 waypoints (mission typically returns to start)
    if (pathPoints.length > 2) {
      const pStart = pathPoints[pathPoints.length - 1];
      const pEnd = pathPoints[0];
      const dAlt = pEnd.y - pStart.y;
      
      let matLine = WP_LINE_MAT.clone();
      matLine.opacity = 0.4;
      
      const loopGeo = new THREE.BufferGeometry().setFromPoints([pStart, pEnd]);
      const loopLine = new THREE.Line(loopGeo, matLine);
      routeGroup.add(loopLine);

      // 3D cone for RTL loop back
      const midPoint = new THREE.Vector3().addVectors(pStart, pEnd).multiplyScalar(0.5);
      const coneGeo = new THREE.ConeGeometry(0.6, 2.2, 8);
      const coneMesh = new THREE.Mesh(coneGeo, new THREE.MeshBasicMaterial({
        color: 0xf59e0b, transparent: true, opacity: 0.4, side: THREE.DoubleSide
      }));
      coneMesh.position.copy(midPoint);
      const direction = new THREE.Vector3().subVectors(pEnd, pStart).normalize();
      coneMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
      routeGroup.add(coneMesh);

      const labelSprite = createSegmentLabelSprite("RTL", new THREE.Color(0xf59e0b));
      labelSprite.position.copy(midPoint).y += 2.2;
      labelSprite.material.opacity = 0.4;
      routeGroup.add(labelSprite);
    }
  }

  console.log(`[ROUTE] Built ${route.length} waypoint markers in 3D scene`);
}

// ─── Runway (Pist) Construction ──────────────────────────────────────────────
function createRunway(options = {}) {
  // If runway exists, remove it first
  if (runwayGroup) {
    scene.remove(runwayGroup);
    runwayGroup.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    });
    runwayGroup = null;
  }

  if (!options.show) return;

  const length = options.length || 300;
  const width = options.width || 20;
  const heading = options.heading || 0; // degrees
  const offsetX = options.offsetX || 0;
  const offsetZ = options.offsetZ || 0;

  runwayGroup = new THREE.Group();
  runwayGroup.name = 'runway';

  // Asphalt plane
  const asphaltGeo = new THREE.PlaneGeometry(width, length);
  const asphaltMat = new THREE.MeshStandardMaterial({
    color: 0x0f172a, // premium dark slate
    roughness: 0.85,
    metalness: 0.1,
  });
  const asphalt = new THREE.Mesh(asphaltGeo, asphaltMat);
  asphalt.rotation.x = -Math.PI / 2;
  asphalt.receiveShadow = true;
  runwayGroup.add(asphalt);

  // Markings (Y=0.01 relative to asphalt)
  const markingHeight = 0.015;
  const whiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const redMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });
  const greenMat = new THREE.MeshBasicMaterial({ color: 0x10b981 });

  // Border lines
  const borderGeo = new THREE.PlaneGeometry(0.3, length);
  const leftBorder = new THREE.Mesh(borderGeo, whiteMat);
  leftBorder.rotation.x = -Math.PI / 2;
  leftBorder.position.set(-width / 2 + 0.3, markingHeight, 0);
  runwayGroup.add(leftBorder);

  const rightBorder = new THREE.Mesh(borderGeo, whiteMat);
  rightBorder.rotation.x = -Math.PI / 2;
  rightBorder.position.set(width / 2 - 0.3, markingHeight, 0);
  runwayGroup.add(rightBorder);

  // Center dashed line
  const dashLength = 10;
  const dashGap = 10;
  const totalDashes = Math.floor(length / (dashLength + dashGap));
  const dashGeo = new THREE.PlaneGeometry(0.35, dashLength);

  for (let i = 0; i < totalDashes; i++) {
    const dash = new THREE.Mesh(dashGeo, whiteMat);
    dash.rotation.x = -Math.PI / 2;
    const zPos = -length / 2 + i * (dashLength + dashGap) + dashLength / 2;
    dash.position.set(0, markingHeight, zPos);
    runwayGroup.add(dash);
  }

  // Threshold piano keys
  const stripeWidth = 0.6;
  const stripeLength = 10;
  const stripeGap = 0.4;
  const stripeGeo = new THREE.PlaneGeometry(stripeWidth, stripeLength);
  const numStripes = 6;
  const startX = -((numStripes - 1) * (stripeWidth + stripeGap)) / 2;

  for (let end = -1; end <= 1; end += 2) {
    const zPos = end * (length / 2 - stripeLength / 2 - 2);
    for (let i = 0; i < numStripes; i++) {
      const stripe = new THREE.Mesh(stripeGeo, whiteMat);
      stripe.rotation.x = -Math.PI / 2;
      stripe.position.set(startX + i * (stripeWidth + stripeGap), markingHeight, zPos);
      runwayGroup.add(stripe);
    }
  }

  // Runway edge lights (spheres)
  const lightCount = Math.floor(length / 20);
  const lightGeo = new THREE.SphereGeometry(0.12, 8, 8);
  for (let i = 0; i <= lightCount; i++) {
    const zPos = -length / 2 + i * (length / lightCount);
    
    // Left edge
    const lLight = new THREE.Mesh(lightGeo, whiteMat);
    lLight.position.set(-width / 2, 0.1, zPos);
    runwayGroup.add(lLight);

    // Right edge
    const rLight = new THREE.Mesh(lightGeo, whiteMat);
    rLight.position.set(width / 2, 0.1, zPos);
    runwayGroup.add(rLight);
  }

  // End lights (Green = start, Red = end)
  for (let i = -3; i <= 3; i++) {
    const xPos = i * (width / 8);
    
    // Threshold start (Green)
    const gLight = new THREE.Mesh(lightGeo, greenMat);
    gLight.position.set(xPos, 0.1, length / 2);
    runwayGroup.add(gLight);

    // Threshold end (Red)
    const rLight = new THREE.Mesh(lightGeo, redMat);
    rLight.position.set(xPos, 0.1, -length / 2);
    runwayGroup.add(rLight);
  }

  // Rotate group
  runwayGroup.rotation.y = -heading * Math.PI / 180;
  
  let posX = offsetX;
  let posZ = offsetZ;
  if (options.autoAlign && options.posWp0X !== undefined) {
    posX += options.posWp0X;
    posZ += options.posWp0Z;
  }
  runwayGroup.position.set(posX, 0.16, posZ);

  scene.add(runwayGroup);
}

// ─── QGroundControl Plan Parser ──────────────────────────────────────────────
function parseQGCPlan(jsonText) {
  const data = JSON.parse(jsonText);
  if (!data || (data.fileType !== 'Plan' && !data.mission)) {
    throw new Error('Not a valid QGroundControl Plan file');
  }

  const route = [];
  let seq = 0;

  if (data.mission && Array.isArray(data.mission.items)) {
    data.mission.items.forEach((item) => {
      if (item.type === 'SimpleItem' && Array.isArray(item.params)) {
        const cmd = item.command;
        const lat = item.params[4];
        const lon = item.params[5];
        const alt = item.params[6];

        if (typeof lat === 'number' && typeof lon === 'number' && lat !== 0 && lon !== 0) {
          route.push({
            seq: seq++,
            lat: lat,
            lon: lon,
            alt: typeof alt === 'number' ? alt : 50,
            command: cmd
          });
        }
      }
    });
  }

  return { route };
}

// Helper to send command to websocket
function sendWsCommand(command) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(command));
  }
}

// Runway Auto-Align vector math
function triggerAutoAlign(route) {
  if (route && route.length >= 2) {
    const wp0 = route[0];
    const wp1 = route[1];
    const dx = (wp1.lon - wp0.lon) * MPDL * Math.cos(wp0.lat * Math.PI / 180);
    const dz = -(wp1.lat - wp0.lat) * MPDL;
    
    let headingRad = Math.atan2(dx, -dz);
    let headingDeg = headingRad * 180 / Math.PI;
    if (headingDeg < 0) headingDeg += 360;
    
    runwaySettings.heading = Math.round(headingDeg);
    
    if (homeLat !== null) {
      const worldWp0 = geoToWorld(wp0.lat, wp0.lon, homeLat, homeLon);
      runwaySettings.posWp0X = worldWp0.x;
      runwaySettings.posWp0Z = worldWp0.z;
    }
    
    const elHeading = document.getElementById('runway-heading');
    const elHeadingVal = document.getElementById('val-runway-heading');
    if (elHeading) elHeading.value = runwaySettings.heading;
    if (elHeadingVal) elHeadingVal.textContent = `${runwaySettings.heading}°`;
  }
}

// ─── Runway Controls Binding ─────────────────────────────────────────────────
function initSimulationAndRunway() {
  createRunway(runwaySettings);

  const elShow = document.getElementById('runway-show');
  const elAutoAlign = document.getElementById('runway-auto-align');
  const elHeading = document.getElementById('runway-heading');
  const elHeadingVal = document.getElementById('val-runway-heading');
  const elLength = document.getElementById('runway-length');
  const elLengthVal = document.getElementById('val-runway-length');
  const elWidth = document.getElementById('runway-width');
  const elWidthVal = document.getElementById('val-runway-width');
  const elOffsetX = document.getElementById('runway-offset-x');
  const elOffsetXVal = document.getElementById('val-runway-offset-x');
  const elOffsetZ = document.getElementById('runway-offset-z');
  const elOffsetZVal = document.getElementById('val-runway-offset-z');

  elShow.addEventListener('change', (e) => {
    runwaySettings.show = e.target.checked;
    createRunway(runwaySettings);
  });

  elAutoAlign.addEventListener('change', (e) => {
    runwaySettings.autoAlign = e.target.checked;
    elHeading.disabled = runwaySettings.autoAlign;
    if (runwaySettings.autoAlign && lastTelemetry && lastTelemetry.route) {
      triggerAutoAlign(lastTelemetry.route);
    }
    createRunway(runwaySettings);
  });

  elHeading.addEventListener('input', (e) => {
    runwaySettings.heading = parseInt(e.target.value, 10);
    elHeadingVal.textContent = `${runwaySettings.heading}°`;
    createRunway(runwaySettings);
  });

  elLength.addEventListener('input', (e) => {
    runwaySettings.length = parseInt(e.target.value, 10);
    elLengthVal.textContent = `${runwaySettings.length}m`;
    createRunway(runwaySettings);
  });

  elWidth.addEventListener('input', (e) => {
    runwaySettings.width = parseInt(e.target.value, 10);
    elWidthVal.textContent = `${runwaySettings.width}m`;
    createRunway(runwaySettings);
  });

  elOffsetX.addEventListener('input', (e) => {
    runwaySettings.offsetX = parseInt(e.target.value, 10);
    elOffsetXVal.textContent = `${runwaySettings.offsetX}m`;
    createRunway(runwaySettings);
  });

  elOffsetZ.addEventListener('input', (e) => {
    runwaySettings.offsetZ = parseInt(e.target.value, 10);
    elOffsetZVal.textContent = `${runwaySettings.offsetZ}m`;
    createRunway(runwaySettings);
  });

  // Simulation bindings
  const elBtnArm = document.getElementById('btn-arm');
  const elBtnReset = document.getElementById('btn-reset');
  const elBtnUpload = document.getElementById('btn-upload');
  const elInputUpload = document.getElementById('plan-upload-input');
  const elPlanInfo = document.getElementById('plan-info');

  elBtnArm.addEventListener('click', () => {
    const isCurrentlyArmed = lastTelemetry && lastTelemetry.status.armed;
    sendWsCommand({
      type: 'arm',
      value: !isCurrentlyArmed
    });
  });

  elBtnReset.addEventListener('click', () => {
    sendWsCommand({ type: 'reset' });
    trailPoints.length = 0;
    // Disposing old attributes to clear the canvas visually
    if (trailGeo.attributes.position) {
      trailGeo.removeAttribute('position');
      trailGeo.removeAttribute('color');
    }
    if (curtainGeo.attributes.position) {
      curtainGeo.removeAttribute('position');
      curtainGeo.removeAttribute('color');
      if (curtainGeo.index) curtainGeo.setIndex([]);
    }
  });

  elBtnUpload.addEventListener('click', () => {
    elInputUpload.click();
  });

  elInputUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const plan = parseQGCPlan(event.target.result);
        if (plan.route.length === 0) {
          alert('Plan dosyasında geçerli waypoint bulunamadı.');
          return;
        }

        elPlanInfo.textContent = `${file.name} (${plan.route.length} WP)`;
        sendWsCommand({
          type: 'set_route',
          route: plan.route
        });
        
        if (runwaySettings.autoAlign) {
          triggerAutoAlign(plan.route);
          createRunway(runwaySettings);
        }
      } catch (err) {
        alert(`Plan yükleme hatası: ${err.message}`);
        console.error(err);
      }
    };
    reader.readAsText(file);
  });
}

// ─── Map Controls Binding ─────────────────────────────────────────────────────
function initMapControls() {
  const elProvider = document.getElementById('map-provider');
  const elZoom     = document.getElementById('map-zoom');
  const elZoomVal  = document.getElementById('val-map-zoom');

  if (elProvider) {
    elProvider.addEventListener('change', (e) => {
      if (tileManager) {
        tileManager.setProvider(e.target.value);
        // Force re-download at current drone position
        tileManager.lastCx = null;
        tileManager.lastCy = null;
      }
    });
  }

  if (elZoom) {
    elZoom.addEventListener('input', (e) => {
      const z = parseInt(e.target.value, 10);
      if (elZoomVal) elZoomVal.textContent = z;
      if (tileManager) {
        tileManager.setZoom(z);
        // Force re-download at current drone position
        tileManager.lastCx = null;
        tileManager.lastCy = null;
      }
    });
  }
}

// ─── Smooth State ─────────────────────────────────────────────────────────────

let smoothRoll = 0, smoothPitch = 0, smoothYaw = 0, smoothAlt = 10;
let homeLat = null, homeLon = null;
// tilesLoaded replaced by tileManager !== null check

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
    console.log('[WS] Connected to ' + WS_URL);
    setConnectionUI(true);
    wsPingSent = performance.now();
  };

  ws.onmessage = (event) => {
    const now    = performance.now();
    wsLatencyMs  = Math.round(now - wsPingSent);
    wsPingSent   = now;
    // Log occasionally to prevent spam, but still provide confirmation
    if (Math.random() < 0.05) {
      console.log('[WS] Received telemetry frame. Latency: ' + wsLatencyMs + 'ms');
    }
    try { 
      lastTelemetry = JSON.parse(event.data); 
    } catch(err) {
      console.error('[WS] JSON parse error: ', err, event.data);
    }
  };

  ws.onclose = (event) => {
    isConnected = false;
    console.log('[WS] Disconnected from ' + WS_URL + ', code: ' + event.code + ', reason: ' + event.reason);
    setConnectionUI(false);
    setTimeout(connectWebSocket, WS_RECONNECT_MS);
  };

  ws.onerror = (err) => {
    console.error('[WS] Error: ', err);
    ws.close();
  };
}

function setConnectionUI(connected) {
  elConnDot.className     = connected ? 'dot dot--connected' : 'dot dot--disconnected';
  elConnLabel.textContent = connected ? 'LIVE TELEMETRY' : 'DISCONNECTED';
  elConnLabel.style.color = connected ? 'var(--color-green)' : '';

  const elWarn = document.getElementById('connection-warning');
  if (elWarn) {
    elWarn.style.display = connected ? 'none' : 'flex';
  }
}

initSimulationAndRunway();
initMapControls();
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
  altTrend:     document.getElementById('alt-trend'),
  uavIcon:      document.getElementById('uav-icon'),
  uavStateText: document.getElementById('uav-state-text'),
  uavActionText:document.getElementById('uav-action-text'),
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

  // ── Altitude Trend Arrow ──
  if (t.vfr.climb > 0.25) {
    el.altTrend.textContent = '▲';
    el.altTrend.className = 'trend-indicator trend-up';
  } else if (t.vfr.climb < -0.25) {
    el.altTrend.textContent = '▼';
    el.altTrend.className = 'trend-indicator trend-down';
  } else {
    el.altTrend.textContent = '―';
    el.altTrend.className = 'trend-indicator trend-level';
  }

  el.groundspeed.textContent = `${t.vfr.groundspeed.toFixed(2)} m/s`;
  el.airspeed.textContent    = `${t.vfr.airspeed.toFixed(2)} m/s`;
  el.heading.textContent     = `${t.vfr.heading}°`;
  el.climb.textContent       = `${t.vfr.climb >= 0 ? '+' : ''}${t.vfr.climb.toFixed(2)} m/s`;
  el.climb.className = 'data-value' + (t.vfr.climb > 0.3 ? ' text-green' : t.vfr.climb < -0.3 ? ' text-red' : '');
  el.throttle.textContent      = `${t.vfr.throttle}%`;
  el.throttleFill.style.width  = `${t.vfr.throttle}%`;

  // ── UAV Top Status Widget Updates ──
  if (el.uavStateText && el.uavActionText && el.uavIcon) {
    if (!t.status.armed) {
      el.uavIcon.textContent = '🔒';
      el.uavStateText.textContent = 'DISARMED';
      el.uavStateText.className = 'widget-value text-red';
      el.uavActionText.textContent = 'STANDBY ON GROUND';
      el.uavActionText.className = 'widget-value text-muted';
    } else {
      el.uavStateText.textContent = 'ARMED';
      el.uavStateText.className = 'widget-value text-green';

      const mode = t.status.mode || 'POSCTL';
      const climb = t.vfr.climb;
      let verticalState = 'CRUISING';
      let verticalColor = 'text-teal';

      if (climb > 0.25) {
        verticalState = 'CLIMBING';
        verticalColor = 'text-green';
      } else if (climb < -0.25) {
        verticalState = 'DESCENDING';
        verticalColor = 'text-red';
      }

      switch (mode) {
        case 'AUTO_TAKEOFF':
          el.uavIcon.textContent = '🛫';
          el.uavActionText.textContent = 'TAKEOFF (CLIMBING)';
          el.uavActionText.className = 'widget-value text-green';
          break;
        case 'AUTO_LAND':
          el.uavIcon.textContent = '🛬';
          el.uavActionText.textContent = 'LANDING (DESCENDING)';
          el.uavActionText.className = 'widget-value text-red';
          break;
        case 'AUTO_RTL':
          el.uavIcon.textContent = '🏠';
          el.uavActionText.textContent = `RETURNING HOME (RTL) — ${verticalState}`;
          el.uavActionText.className = `widget-value ${verticalColor}`;
          break;
        case 'AUTO_MISSION':
          el.uavIcon.textContent = '🎯';
          el.uavActionText.textContent = `MISSION WP ${t.status.active_wp} — ${verticalState}`;
          el.uavActionText.className = `widget-value ${verticalColor}`;
          break;
        default:
          el.uavIcon.textContent = '🚁';
          el.uavActionText.textContent = `MANUAL HOVER — ${verticalState}`;
          el.uavActionText.className = `widget-value ${verticalColor}`;
          break;
      }
    }
  }

  if (t.status.armed) {
    el.armLabel.textContent = 'ARMED';
    el.armPill.className    = 'status-pill armed';
  } else {
    el.armLabel.textContent = 'DISARMED';
    el.armPill.className    = 'status-pill disarmed';
  }
  el.modeLabel.textContent = t.status.mode || '---';
  elWsLatency.textContent  = isConnected ? `WS: ${wsLatencyMs} ms` : 'WS: ---';

  const elBtnArm = document.getElementById('btn-arm');
  if (elBtnArm) {
    if (t.status.armed) {
      elBtnArm.textContent = 'DISARM VEHICLE';
      elBtnArm.classList.add('armed-btn');
    } else {
      elBtnArm.textContent = 'ARM VEHICLE';
      elBtnArm.classList.remove('armed-btn');
    }
  }

  // ── Map tile count ─────────────────────────────────────────────────────
  const elTileCount = document.getElementById('val-tile-count');
  if (elTileCount && tileManager) {
    elTileCount.textContent = tileManager.tiles.size;
  }
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

    // ── Dynamic tile manager: create on first position, update each frame ─
    if (t.position.lat !== 0) {
      if (!tileManager) {
        homeLat = t.position.lat;
        homeLon = t.position.lon;
        tileManager = new TileManager(scene, homeLat, homeLon);
        // Apply saved UI settings
        const provEl = document.getElementById('map-provider');
        if (provEl) tileManager.setProvider(provEl.value);
        const zoomEl = document.getElementById('map-zoom');
        if (zoomEl) tileManager.setZoom(parseInt(zoomEl.value));
      }
      tileManager.update(t.position.lat, t.position.lon);
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
    droneGroup.position.y = smoothAlt + 0.63; // 0.63m offset to place landing feet perfectly on the ground

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
        
        if (runwaySettings.autoAlign) {
          triggerAutoAlign(t.route);
          createRunway(runwaySettings);
        }
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
