// Asset viewer: every meteor from the manifest, spinning in dark fog with the game's tints, the space sprites
// (haze behind, dust among the rocks, an explosion flash that lights the rocks) and the music with an
// intensity slider. Uses the same modules the game will use (device, loader, meteors, sprites, audio), so it
// doubles as their test page.
import * as THREE from 'three';
import { SPACE_COLOR, FOG_DENSITY, SPRITES, MUSIC } from '../game/config.js';
import { pickAssetSet, pixelRatio } from '../game/device.js';
import { loadManifest, loadMeteors } from '../game/loader.js';
import { createMeteorMesh, tintColor } from '../game/meteors.js';
import { loadSprites, spriteMaterial } from '../game/sprites.js';
import { Music, unlockAudio, musicFormat } from '../game/audio.js';

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
const spriteLayer = new THREE.Group();  // inside the grid, so it moves and fogs with the meteors
grid.add(spriteLayer);

const state = { tint: 'mixed', shade: 0.5, distance: 0, spin: true, fog: true, sprites: true, yaw: 0, pitch: 0 };
let items = [];      // { mesh, index, group, pos, axis, speed, angle }
let floaters = [];   // dust and haze sprites: { sprite, base, phase, spin }
let flash = null;    // { sprite, light, t, next }
let manifest = null;
let audio = null;    // { ctx, music }
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
  manifest = await loadManifest();
  const counts = { meteors: [0, 1], sprites: [0, 1] };
  const progress = (key) => (done, total) => {
    counts[key] = [done, total];
    const d = counts.meteors[0] + counts.sprites[0];
    const t = counts.meteors[1] + counts.sprites[1];
    $('bar').firstElementChild.style.width = `${(100 * d) / t}%`;
  };
  const [meteors, sprites] = await Promise.all([loadMeteors(manifest, set, progress('meteors')),
                                                loadSprites(manifest, set, progress('sprites'))]);
  loadMs = performance.now() - t0;
  addSprites(sprites);
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

// Haze far behind the meteors, two copies of every dust wisp among and in front of them, and one flash.
function addSprites(sprites) {
  sprites.haze.forEach((s, i) => {
    const sprite = new THREE.Sprite(spriteMaterial(s.texture, { ...SPRITES.haze, rotation: i * 1.3 }));
    floaters.push({ sprite, base: new THREE.Vector3(i % 2 ? 10 : -9, i % 2 ? -4 : 4, -26 - 6 * i), scale: 34,
                    phase: i * 2.0, spin: i % 2 ? -0.01 : 0.012 });
  });
  const n = sprites.dust.length;
  for (let j = 0; j < 2 * n; j++) {
    const s = sprites.dust[j % n];
    const sprite = new THREE.Sprite(spriteMaterial(s.texture, { ...SPRITES.dust, rotation: j * 2.1 }));
    floaters.push({ sprite, base: new THREE.Vector3(Math.sin(j * 2.4) * 9, Math.cos(j * 1.7) * 5, -7 + 9 * Math.sin(j * 0.9)),
                    scale: 5 + 2.5 * (j % 3), phase: j * 0.7, spin: 0.04 * Math.sin(j * 1.3) });
  }
  for (const f of floaters) {
    f.sprite.scale.setScalar(f.scale);
    spriteLayer.add(f.sprite);
  }
  if (sprites.flash.length) {
    const sprite = new THREE.Sprite(spriteMaterial(sprites.flash[0].texture, { ...SPRITES.flash, additive: true }));
    sprite.visible = false;
    const light = new THREE.PointLight(SPRITES.flash.color, 0, 14, 2);
    spriteLayer.add(sprite, light);
    flash = { sprite, light, t: 0, next: 1.0, at: new THREE.Vector3() };
  }
}

function updateSprites(dt, now) {
  spriteLayer.visible = state.sprites;
  const t = now / 1000;
  for (const f of floaters) {
    f.sprite.position.set(f.base.x + 0.6 * Math.sin(t * 0.11 + f.phase), f.base.y + 0.4 * Math.cos(t * 0.09 + f.phase),
                          f.base.z);
    f.sprite.material.rotation += f.spin * dt;
  }
  if (!flash) return;
  flash.next -= dt;
  if (flash.next <= 0 && items.length) {  // blow up next to a random meteor every few seconds
    const it = items[Math.floor(Math.random() * items.length)];
    flash.at.copy(it.pos).add(new THREE.Vector3(0.6, 0.4, 1.4));
    flash.t = 0;
    flash.next = 2.5 + Math.random() * 2;
  }
  flash.t += dt;
  const k = flash.t < 0.05 ? flash.t / 0.05 : Math.exp(-(flash.t - 0.05) * 5);  // fast rise, soft fade
  const on = state.sprites && k > 0.01;
  flash.sprite.visible = on;
  flash.sprite.position.copy(flash.at);
  flash.sprite.scale.setScalar(2.5 + 5 * Math.sqrt(Math.min(1, flash.t / 0.25)));
  flash.sprite.material.opacity = k;
  flash.light.position.copy(flash.at);
  flash.light.intensity = on ? 120 * k : 0;
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
  if (!w || !h) return;  // hidden tab: wait for the next resize
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
  updateSprites(dt, now);
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
      `music     ${musicLine()}`,
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
// ---- music: loaded on the first Play (browsers only start audio after a tap or click)
function musicLine() {
  if (!audio) return manifest?.music?.length ? `${manifest.music.length} loops, ${musicFormat()}` : 'none';
  if (audio.loading) return 'loading';
  const m = audio.music;
  const p = m.position();
  const ok = m.loops.filter((l) => l.buffer).length;
  return `L${m.intensity.toFixed(2)} ${Math.floor(p / 60)}:${(p % 60).toFixed(1).padStart(4, '0')} (${ok}/${m.loops.length})`;
}

$('music').addEventListener('click', async () => {
  if (!audio) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    unlockAudio(ctx);
    audio = { ctx, music: new Music(ctx, { fadeSeconds: 2, volume: MUSIC.volume }), loading: true };
    $('music').textContent = 'Loading';
    await audio.music.load(manifest ?? { music: [] }, set);
    audio.loading = false;
  } else {
    unlockAudio(audio.ctx);
  }
  const m = audio.music;
  if (m.playing) {
    m.stop(0.4);
  } else {
    m.intensity = Number($('intensity').value);
    m.start();
  }
  $('music').textContent = m.playing ? 'Stop' : 'Play';
  $('music').classList.toggle('on', m.playing);
});
$('intensity').addEventListener('input', (e) => audio?.music.setIntensity(Number(e.target.value)));

for (const id of ['spin', 'fog', 'sprites']) {
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
