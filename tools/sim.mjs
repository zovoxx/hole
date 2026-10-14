// Shared harness for the Node checks (Contoo 4): loads the game's own modules with the vendored three.js (no
// browser, no npm packages) and runs a whole run the way main.js does (the difficulty, the flight model, the pull
// of massive meteors, the field, the walls), with plain geometry and the manifest's real collision data.
//   import { THREE, mod, game } from './sim.mjs';
//   const g = game({ aspect: 16 / 9 });  g.start();  const hit = g.step({ x: 0, y: 0 });
import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const threeUrl = pathToFileURL(path.join(ROOT, 'game/vendor/three.module.js')).href;
// the game imports 'three' through the page's import map; map it the same way here
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, n) {
  return s === 'three' ? { url: ${JSON.stringify(threeUrl)}, shortCircuit: true } : n(s, c); }`)}`);
export const THREE = await import(threeUrl);
const load = (f) => import(pathToFileURL(path.join(ROOT, 'game', f)).href);
export const mod = {
  config: await load('config.js'),
  flight: await load('flight.js'),
  difficulty: await load('difficulty.js'),
  world: await load('world.js'),
  walls: await load('walls.js'),
  gravity: await load('gravity.js'),
  meteors: await load('meteors.js'),
};
export const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/manifest.json'), 'utf8'));

const { WORLD, CAMERA, GRAVITY } = mod.config;
const { createFlight, resetFlight, stepFlight } = mod.flight;
const { knobs } = mod.difficulty;
const DEG = Math.PI / 180;

const geo = new THREE.IcosahedronGeometry(1, 1);
const mat = new THREE.MeshStandardMaterial();
const shape = (e) => ({ id: e.id, geometry: geo, material: mat, collisionRadius: e.collisionRadius,
                        collisionSpheres: e.collisionSpheres, sizeInRock: e.sizeInRock });
export const shapes = () => ({ small: manifest.meteors.small.map(shape), big: manifest.meteors.big.map(shape),
                               fragments: manifest.meteors.fragments.map(shape) });

// The camera's vertical fov for a screen aspect, as main.js resize() sets it.
export function fovFor(aspect) {
  const t = (deg) => Math.tan((deg * DEG) / 2);
  let tv;
  if (aspect >= 1) {
    tv = t(CAMERA.fovShort);
    if (tv * aspect > t(CAMERA.fovLongMax)) tv = t(CAMERA.fovLongMax) / aspect;
  } else {
    tv = Math.min(t(CAMERA.fovShort) / aspect, t(CAMERA.fovLongMax));
  }
  return (2 * Math.atan(tv)) / DEG;
}

// How much of a rock shows through the fog at distance d (m) from its surface: 1 - the FogExp2 factor.
export const FOG = Math.sqrt(-Math.log(WORLD.fogAtRadius)) / WORLD.radius;
export const fogVisibility = (d) => Math.exp(-((FOG * Math.max(0, d)) ** 2));

// A whole run as main.js plays it (mode 'run'): every frame the difficulty, the flight model, the pull, the field
// and the walls. step(held) runs one frame and returns the rock that hit you (or null).
export function game({ aspect = 16 / 9, dt = 1 / 60 } = {}) {
  const field = new mod.world.MeteorField(new THREE.Scene(), shapes());
  const walls = new mod.walls.Walls(field);
  const cam = new THREE.PerspectiveCamera(fovFor(aspect), aspect, CAMERA.near, CAMERA.far);
  cam.updateProjectionMatrix();
  field.setView(cam);
  const g = {
    field, walls, cam, dt, runTime: 0, k: knobs(0), speed: 40,
    f: createFlight(), q: new THREE.Quaternion(), fwd: new THREE.Vector3(0, 0, -1), frustum: new THREE.Frustum(),
    drift: new THREE.Vector3(), pull: { gx: 0, gy: 0, strength: 0 }, move: new THREE.Vector3(),
  };
  const pv = new THREE.Matrix4();
  const driftT = new THREE.Vector3();
  const dq = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  g.view = () => {
    g.fwd.set(0, 0, -1).applyQuaternion(g.q);
    cam.quaternion.copy(g.q);
    cam.updateMatrixWorld();
    g.frustum.setFromProjectionMatrix(pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  };
  // a fresh run (main.js startRun(true))
  g.start = () => {
    resetFlight(g.f);
    g.q.identity();
    g.runTime = 0;
    g.k = knobs(0);
    g.speed = g.k.speed;
    g.drift.set(0, 0, 0);
    g.pull = { gx: 0, gy: 0, strength: 0 };
    field.setDifficulty(g.k);
    g.view();
    field.reset(g.fwd, g.frustum, { speed: g.speed });
    walls.reset();
    walls.begin(g.k);
    field.begin();
  };
  g.step = (held = { x: 0, y: 0 }) => {
    g.runTime += dt;
    g.k = knobs(g.runTime);
    g.speed = g.k.speed;
    field.setDifficulty(g.k);
    stepFlight(g.f, held, dt);
    g.pull = field.playerPull(g.fwd, g.q, driftT);
    g.drift.lerp(driftT, 1 - Math.exp(-dt / GRAVITY.player.driftSeconds));
    const ax = (g.f.wy + g.pull.gy) * DEG * dt;
    const ay = -(g.f.wx + g.pull.gx) * DEG * dt;
    const a = Math.hypot(ax, ay);
    if (a > 0) {
      g.q.multiply(dq.setFromAxisAngle(axis.set(ax / a, ay / a, 0), a));
      g.q.normalize();
    }
    g.view();
    g.move.copy(g.fwd).multiplyScalar(g.speed * dt).addScaledVector(g.drift, dt);
    const hit = field.update(dt, { fwd: g.fwd, frustum: g.frustum, move: g.move, speed: g.speed });
    walls.update(dt, { runTime: g.runTime, k: g.k, speed: g.speed, q: g.q, flight: g.f, drift: g.drift, fwd: g.fwd,
                       frustum: g.frustum, move: g.move, spawn: true });
    return hit;
  };
  return g;
}

// Deterministic Math.random for reproducible audits (the game uses Math.random everywhere).
export function seedRandom(seed) {
  let s = seed >>> 0;
  Math.random = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
