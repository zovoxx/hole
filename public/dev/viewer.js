// Meteor viewer: every meteor from the manifest, spinning in dark fog with the game's tints.
// Uses the same modules the game will use (device, loader, meteors), so it doubles as their test page.
import * as THREE from 'three';
import { SPACE_COLOR, FOG_DENSITY } from '../game/config.js';
import { pickAssetSet, pixelRatio } from '../game/device.js';
import { loadManifest, loadMeteors } from '../game/loader.js';
import { createMeteorMesh, tintColor } from '../game/meteors.js';

const set = pickAssetSet();
const $ = (id) => document.getElementById(id);
let COLS = 5;  // 3 on portrait screens
const SPACING = 3.0;
const SCALE = { small: 1.0, big: 1.35, fragments: 0.55 };  // display sizes only; the game scales per instance
const TINT_CYCLE = ['gray', 'decoy', 'exploder'];

const renderer = new THREE.WebGLRenderer({ canvas: $('view'), antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(pixelRatio(set));
renderer.toneMapping = THREE.NeutralToneMapping;  // keeps the yellows yellow (ACES pushes them to orange)
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(SPACE_COLOR);
const fog = new THREE.FogExp2(SPACE_COLOR, FOG_DENSITY);
scene.fog = fog;
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);

scene.add(new THREE.HemisphereLight(0x3a4a6e, 0x05060a, 0.9));
const key = new THREE.DirectionalLight(0xfff1e0, 2.4);
key.position.set(-4, 5, 6);
const rim = new THREE.DirectionalLight(0x8fa8ff, 1.4);
rim.position.set(4, 2, -6);
scene.add(key, rim);

const grid = new THREE.Group();
scene.add(grid);

const state = { tint: 'mixed', shade: 0.5, distance: 0, spin: true, fog: true, yaw: 0, pitch: 0 };
let items = [];      // { mesh, index, group, pos, axis, speed, angle }
let fitDistance = 20;
let loadMs = 0;
let totalTris = 0;

for (const a of document.querySelectorAll('#sets a')) a.classList.toggle('on', a.dataset.set === set);
if (window.innerWidth < 700) {  // phones: start with the panel folded so the meteors are visible
  $('panel').classList.add('closed');
  $('toggle').textContent = 'Show';
}

async function start() {
  const t0 = performance.now();
  const manifest = await loadManifest();
  const meteors = await loadMeteors(manifest, set, (done, total) => {
    $('bar').firstElementChild.style.width = `${(100 * done) / total}%`;
  });
  loadMs = performance.now() - t0;
  const shapes = [...meteors.small, ...meteors.big, ...meteors.fragments];
  shapes.forEach((shape, i) => {
    const mesh = createMeteorMesh(shape, 1);
    mesh.count = 1;
    grid.add(mesh);
    const axis = new THREE.Vector3(Math.sin(i * 1.7), Math.cos(i * 2.3), Math.sin(i * 0.9 + 1)).normalize();
    items.push({ mesh, i, group: shape.group, pos: new THREE.Vector3(), axis,
                 speed: 0.25 + 0.2 * ((i * 7) % 5) / 4, angle: i });
    totalTris += shape.tris;
  });
  applyTints();
  resize();
  $('loading').classList.add('done');
  renderer.setAnimationLoop(frame);
}

function applyTints() {
  const c = new THREE.Color();
  for (const it of items) {
    const kind = state.tint === 'mixed' ? TINT_CYCLE[it.i % 3] : state.tint;
    it.mesh.setColorAt(0, tintColor(kind, state.shade, c));
    it.mesh.instanceColor.needsUpdate = true;
  }
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  COLS = camera.aspect < 0.8 ? 3 : 5;
  const rows = Math.ceil(items.length / COLS) || 3;
  for (const it of items) {
    const col = it.i % COLS;
    const row = Math.floor(it.i / COLS);
    it.pos.set((col - (COLS - 1) / 2) * SPACING, ((rows - 1) / 2 - row) * SPACING, 0);
  }
  const halfW = (COLS * SPACING) / 2 + 0.6;
  const halfH = (rows * SPACING) / 2 + 0.6;
  const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  fitDistance = Math.max(halfH / t, halfW / (t * camera.aspect));
}

const q = new THREE.Quaternion();
const m = new THREE.Matrix4();
const s = new THREE.Vector3();
let last = performance.now();
let fps = 60;
let statsAt = 0;

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;
  const dist = fitDistance + state.distance * state.distance * 180;
  grid.position.set(0, 0, -dist);
  grid.rotation.set(state.pitch, state.yaw, 0);
  scene.fog = state.fog ? fog : null;
  for (const it of items) {
    if (state.spin) it.angle += it.speed * dt;
    q.setFromAxisAngle(it.axis, it.angle);
    s.setScalar(SCALE[it.group] ?? 1);
    it.mesh.setMatrixAt(0, m.compose(it.pos, q, s));
    it.mesh.instanceMatrix.needsUpdate = true;
  }
  renderer.render(scene, camera);
  if (now - statsAt > 500) {
    statsAt = now;
    const info = renderer.info.render;
    $('stats').textContent = [
      `set       ${set}`,
      `meteors   ${items.length}  (${totalTris.toLocaleString('en')} tris)`,
      `draws     ${info.calls}`,
      `distance  ${Math.round(dist)} m`,
      `load      ${(loadMs / 1000).toFixed(2)} s`,
      `fps       ${Math.round(fps)}`,
    ].join('\n');
  }
}

// ---- controls
for (const b of document.querySelectorAll('#tints button')) {
  b.addEventListener('click', () => {
    state.tint = b.dataset.tint;
    for (const o of document.querySelectorAll('#tints button')) o.classList.toggle('on', o === b);
    applyTints();
  });
}
$('shade').addEventListener('input', (e) => { state.shade = Number(e.target.value); applyTints(); });
$('distance').addEventListener('input', (e) => { state.distance = Number(e.target.value); });
for (const id of ['spin', 'fog']) {
  $(id).addEventListener('click', () => {
    state[id] = !state[id];
    $(id).classList.toggle('on', state[id]);
    $(id).textContent = state[id] ? 'On' : 'Off';
  });
}
$('toggle').addEventListener('click', () => {
  const closed = $('panel').classList.toggle('closed');
  $('toggle').textContent = closed ? 'Show' : 'Hide';
});

let drag = null;
const canvas = renderer.domElement;
canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  state.yaw += (e.clientX - drag.x) * 0.006;
  state.pitch = THREE.MathUtils.clamp(state.pitch + (e.clientY - drag.y) * 0.006, -1.2, 1.2);
  drag = { x: e.clientX, y: e.clientY };
});
const endDrag = () => { drag = null; };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('dblclick', () => { state.yaw = 0; state.pitch = 0; });
window.addEventListener('resize', resize);

start().catch((err) => {
  console.error(err);
  $('error').textContent = `Could not load the meteors: ${err.message}`;
});
