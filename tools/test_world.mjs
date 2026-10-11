#!/usr/bin/env node
// Fast checks of the game logic in Node, no browser (Contoo 1): the flight model, the difficulty curve and the
// meteor field (even density at every distance flying straight and turning, nothing pops into view, nothing
// comes from behind, the density gives the planned seconds between rocks in your path).
// Usage: node tools/test_world.mjs   (Node 20.6+; uses the vendored three.js, no npm packages)
import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const threeUrl = pathToFileURL(path.join(ROOT, 'game/vendor/three.module.js')).href;
// the game imports 'three' through the page's import map; map it the same way here
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, n) {
  return s === 'three' ? { url: ${JSON.stringify(threeUrl)}, shortCircuit: true } : n(s, c); }`)}`);
const THREE = await import(threeUrl);
const game = (f) => import(pathToFileURL(path.join(ROOT, 'game', f)).href);
const { createFlight, stepFlight } = await game('flight.js');
const { knobs } = await game('difficulty.js');
const { MeteorField } = await game('world.js');
const { WORLD, FLIGHT } = await game('config.js');

let failures = 0;
function check(ok, what, detail = '') {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${what}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
const DEG = Math.PI / 180;
const dt = 1 / 60;

console.log('flight');
{
  const f = createFlight();
  for (let i = 0; i < 18; i++) stepFlight(f, { x: 1, y: 0 }, dt);
  check(Math.abs(f.cx - 0.5) < 1e-9, 'circle: half its range in 0.3 s', f.cx.toFixed(4));
  for (let i = 0; i < 60; i++) stepFlight(f, { x: 0, y: 0 }, dt);
  check(Math.abs(f.cx - 0.5) < 1e-9, 'circle stays where it is left');
  for (let i = 0; i < 18; i++) stepFlight(f, { x: 1, y: 1 }, dt);
  check(Math.abs(Math.hypot(f.cx - 0.5, f.cy) - 0.5) < 1e-9, 'diagonals move at the same constant speed');
  for (let i = 0; i < 120; i++) stepFlight(f, { x: 1, y: 0 }, dt);
  check(Math.abs(Math.hypot(f.cx, f.cy) - 1) < 1e-9, 'circle stays inside its range');
  const g = createFlight();
  for (let i = 0; i < 120; i++) stepFlight(g, { x: 1, y: 0 }, dt);
  check(Math.abs(g.wx - FLIGHT.maxTurnRate) < 1e-9, 'top turn rate reached', `${g.wx} °/s`);
  let crossed = null;
  let reversed = null;
  for (let i = 1; i < 240; i++) {
    stepFlight(g, { x: -1, y: 0 }, dt);
    if (crossed === null && g.cx <= 0) crossed = i * dt;
    if (reversed === null && g.wx < 0) reversed = i * dt;
  }
  check(reversed - crossed > 0.35 && reversed - crossed < 0.65, 'full counter-steer: keeps turning the old way ~0.5 s',
    `circle crosses at ${crossed.toFixed(2)} s, turn reverses at ${reversed.toFixed(2)} s`);
  const h = createFlight();
  stepFlight(h, { x: 0, y: 0.02 / (dt / FLIGHT.circleSeconds) }, dt);
  check(h.ty === 0, 'no pull inside the dead zone');
}

console.log('difficulty');
{
  let prev = knobs(0);
  let ok = true;
  for (let t = 1; t <= 1800; t++) {
    const k = knobs(t);
    if (!(k.D > prev.D && k.speed > prev.speed && k.pathGap < prev.pathGap)) ok = false;
    prev = k;
  }
  check(ok, 'one smooth curve: D, speed rise and the gap shrinks every second for 30 minutes',
    `t=60: ${knobs(60).speed.toFixed(0)} m/s gap ${knobs(60).pathGap.toFixed(1)} s; t=600: ${knobs(600).speed.toFixed(0)} m/s gap ${knobs(600).pathGap.toFixed(1)} s`);
}

// a field with the real collision data and plain geometry
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/manifest.json'), 'utf8'));
const geo = new THREE.IcosahedronGeometry(1, 1);
const mat = new THREE.MeshStandardMaterial();
const shape = (e) => ({ id: e.id, geometry: geo, material: mat, collisionRadius: e.collisionRadius,
                        collisionSpheres: e.collisionSpheres });

function simulate({ turn = 0, speed = 40, gap = 8, seconds = 45, aspect = 16 / 9, hits = false }) {
  const field = new MeteorField(new THREE.Scene(), { small: manifest.meteors.small.map(shape),
                                                     big: manifest.meteors.big.map(shape) });
  const cam = new THREE.PerspectiveCamera(60, aspect, 0.3, 1400);
  field.setView(cam);
  const q = new THREE.Quaternion();
  const fwd = new THREE.Vector3();
  const frustum = new THREE.Frustum();
  const pv = new THREE.Matrix4();
  const move = new THREE.Vector3();
  const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0.3, 1, 0).normalize(), -turn * DEG * dt);
  const update = () => {
    fwd.set(0, 0, -1).applyQuaternion(q);
    cam.quaternion.copy(q);
    cam.updateMatrixWorld();
    frustum.setFromProjectionMatrix(pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  };
  update();
  field.setDensity(speed, gap);
  field.reset(fwd, frustum, { speed });
  const R = WORLD.radius;
  const bands = [50, 120, 180, 230, 270];
  const counts = new Array(bands.length - 1).fill(0);
  let samples = 0;
  let pops = 0;
  let behind = 0;
  let hitCount = 0;
  const known = new Set(field.rocks);
  for (let i = 0; i < seconds * 60; i++) {
    if (turn) q.multiply(yaw);
    update();
    move.copy(fwd).multiplyScalar(speed * dt);
    const hit = field.update(dt, { fwd, frustum, move, speed, collide: hits });
    if (hit && i > 600) hitCount++;
    if (hit) field.rocks.splice(field.rocks.indexOf(hit), 1);
    for (const r of field.rocks) {
      if (known.has(r)) continue;
      known.add(r);
      // a new rock in view must appear at the far edge, faded out
      if (field.visible(r, frustum) && (r.fade > 0 || r.p.length() < R - WORLD.fadeBand - 1)) pops++;
      // nothing comes from behind: every rock moves backward relative to the player
      if (r.v.dot(fwd) >= speed) behind++;
    }
    if (i > 60 * 10 && i % 10 === 0) {
      samples++;
      for (const r of field.rocks) {
        if (!frustum.containsPoint(r.p)) continue;
        const d = r.p.length();
        for (let b = 0; b < counts.length; b++) if (d >= bands[b] && d < bands[b + 1]) counts[b]++;
      }
    }
  }
  const tv = Math.tan(30 * DEG);
  const omega = 4 * Math.asin(Math.sin(Math.atan(tv)) * Math.sin(Math.atan(tv * aspect)));
  const ratios = counts.map((c, b) => c / samples / (field.density * omega * (bands[b + 1] ** 3 - bands[b] ** 3) / 3));
  return { ratios, pops, behind, hitCount, field };
}

console.log('meteor field');
for (const [label, opts] of [['straight', {}], ['turning 35°/s', { turn: 35 }], ['turning 70°/s at 70 m/s', { turn: 70, speed: 70, gap: 3 }],
                             ['portrait phone, turning', { turn: 50, aspect: 0.46 }]]) {
  const r = simulate(opts);
  check(r.ratios.every((x) => x > 0.85 && x < 1.15), `${label}: even density in view at every distance (±15%)`,
    r.ratios.map((x) => x.toFixed(2)).join(' '));
  check(r.pops === 0, `${label}: nothing pops into view`, `${r.pops}`);
  check(r.behind === 0, `${label}: nothing comes from behind`, `${r.behind}`);
}
{
  const r = simulate({ seconds: 1210, hits: true, gap: 8 });
  const seen = 1200 / Math.max(1, r.hitCount);
  check(seen > 8 * 0.83 && seen < 8 * 1.2, 'flying straight, a rock is in your path about every pathGap seconds',
    `one per ${seen.toFixed(2)} s for a planned 8 s (${r.hitCount} rocks)`);
}

console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
