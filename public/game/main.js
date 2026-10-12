// Hole: boot, game states (loading -> start -> run -> hit -> over -> run ...) and the main loop.
import * as THREE from 'three';
import { SPACE_COLOR, WORLD, CAMERA, LIGHTS, RUN, GRAVITY } from './config.js';
import { pickAssetSet, pixelRatio, hasTouch } from './device.js';
import { loadManifest, loadMeteors } from './loader.js';
import { loadSprites } from './sprites.js';
import { createFlight, resetFlight, stepFlight } from './flight.js';
import { knobs } from './difficulty.js';
import { MeteorField } from './world.js';
import { createStars, Motes, Murk } from './space.js';
import { Fx } from './fx.js';
import { Input } from './input.js';
import { UI, loadBest, saveBest } from './ui.js';

const DEG = Math.PI / 180;
const params = new URLSearchParams(window.location.search);
const DEBUG = params.has('debug');
const set = pickAssetSet();
const touch = hasTouch() || params.get('touch') === '1';

const ui = new UI({ touch });
const input = new Input(ui.buttons, onPress);
input.touchEnabled = touch;

// ---- renderer, scene, camera (the camera never uses lookAt: orientation is a quaternion turned by pitch/yaw)
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(pixelRatio(set));
// No tone mapping: the scene is dark, the yellows stay yellow (Contoo 2), and fog blends linearly into exactly
// the background colour, so a fully fogged rock is gone. (Neutral tone mapping squares the contrast of very dark
// colours: fogged rocks stood out as dark or dithered silhouettes.)
renderer.toneMapping = THREE.NoToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color(SPACE_COLOR);
scene.fog = new THREE.FogExp2(SPACE_COLOR, Math.sqrt(-Math.log(WORLD.fogAtRadius)) / WORLD.radius);
const camera = new THREE.PerspectiveCamera(CAMERA.fovShort, 1, CAMERA.near, CAMERA.far);
scene.add(camera);

// Lights ride with the camera: rocks look the same whichever way you face (no fixed up anywhere).
camera.add(new THREE.AmbientLight(LIGHTS.ambient.color, LIGHTS.ambient.intensity));
for (const l of [LIGHTS.key, LIGHTS.rim]) {
  const light = new THREE.DirectionalLight(l.color, l.intensity);
  light.position.set(0, 0, 0);
  light.target.position.set(...l.dir);
  camera.add(light, light.target);
}

scene.add(createStars(renderer.getPixelRatio()));  // around the origin, where the camera always is
const motes = new Motes(set);
scene.add(motes.points);

// ---- game state
const flight = createFlight();
const q = new THREE.Quaternion();        // where the player faces
const kick = new THREE.Quaternion();     // visual camera offset (hit kick); never touches the HUD
const fxKick = new THREE.Quaternion();   // explosion kicks (fx.js)
const drift = new THREE.Vector3();       // sideways drift from a massive meteor's pull (world m/s)
const driftTarget = new THREE.Vector3();
const fwd = new THREE.Vector3(0, 0, -1);
const move = new THREE.Vector3();
const frustum = new THREE.Frustum();
const projView = new THREE.Matrix4();
const kickAxis = new THREE.Vector3();
const dq = new THREE.Quaternion();
const axis = new THREE.Vector3();

let field = null;
let murk = null;
let fx = null;
let pull = { gx: 0, gy: 0, strength: 0 };
let mode = 'loading';
let runTime = 0;       // seconds survived this run (the timer)
let modeTime = 0;      // seconds since the mode began
let speed = 40;
let best = loadBest();
let lastHit = null;
let openT = 1;         // view opening after a restart (0 -> 1)
let last = performance.now();
let fps = 60;
let rendering = true;  // tests switch it off (?debug): software GL in headless browsers takes ~0.3 s per frame

function setMode(next) {
  mode = next;
  modeTime = 0;
  ui.show(next);
  input.measure();
}

// ---- boot
async function boot() {
  resize();
  ui.show('loading');
  const manifest = await loadManifest();
  const counts = { meteors: [0, 15], sprites: [0, 7] };
  const progress = (key) => (done, total) => {
    counts[key] = [done, total];
    ui.progress((counts.meteors[0] + counts.sprites[0]) / (counts.meteors[1] + counts.sprites[1]));
  };
  const [shapes, sprites] = await Promise.all([
    loadMeteors(manifest, set, progress('meteors')),
    loadSprites(manifest, set, progress('sprites')),
  ]);
  field = new MeteorField(scene, shapes, { set, fogDensity: scene.fog.density });
  murk = new Murk(scene, sprites);
  fx = new Fx(scene, sprites.flash, scene.fog.density);
  resize();
  updateCamera();
  speed = WORLD.attractSpeed;
  field.setDifficulty(knobs(0));
  field.setDensity(speed, knobs(0).pathGap);
  field.reset(fwd, frustum, { speed, attract: true });
  murk.reset(fwd, frustum, field.cosKeep);
  renderer.compile(scene, camera);
  ui.setBest(best);
  setMode('start');
  renderer.setAnimationLoop(frame);
}

// ---- presses: start, restart
function onPress(e) {
  if (e.target?.closest?.('.fs')) return;
  if (mode === 'start') {
    startRun(false);
  } else if (mode === 'over' && modeTime >= RUN.restartLock) {
    startRun(true);
  }
}

function startRun(fresh) {
  resetFlight(flight);
  runTime = 0;
  speed = knobs(0).speed;
  drift.set(0, 0, 0);
  pull = { gx: 0, gy: 0, strength: 0 };
  field.setDifficulty(knobs(0));
  if (fresh) {  // a new run: fresh space behind the closed view, which then opens
    kick.identity();
    fx.clear();
    updateCamera();
    field.reset(fwd, frustum, { speed });
    murk.reset(fwd, frustum, field.cosKeep);
    openT = 0;
  }
  field.begin();
  input.measure();
  setMode('run');
}

// ---- main loop: frame() keeps time and draws; tick() is one step of the game
let manual = false;    // tests drive the clock with hole.advance() (?debug)

function frame(now) {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;
  if (!manual) tick(dt);
  if (rendering) renderer.render(scene, camera);
  if (DEBUG) debugLine(now);
}

function tick(dt) {
  modeTime += dt;
  const held = input.update();

  if (mode === 'start') {
    speed = WORLD.attractSpeed;
    step(dt, { attract: true, collide: false });
  } else if (mode === 'run') {
    runTime += dt;
    const k = knobs(runTime);
    speed = k.speed;
    field.setDifficulty(k);
    stepFlight(flight, held, dt);
    // a massive meteor's pull: an extra turn toward it and a sideways drag (gravity.js)
    pull = field.playerPull(fwd, q, driftTarget);
    drift.lerp(driftTarget, 1 - Math.exp(-dt / GRAVITY.player.driftSeconds));
    turn(dt, pull.gx, pull.gy);
    const hit = step(dt, { collide: true });
    if (hit) onHit(hit);
  } else if (mode === 'hit') {
    hitEffect(dt);
    if (modeTime >= RUN.hitSeconds) setMode('over');
  }

  // the view opening at the start of a fresh run
  if (openT < 1) {
    openT = Math.min(1, openT + dt / RUN.openSeconds);
    const e = 1 - (1 - openT) ** 2;
    ui.setEdge(0.35 + 0.65 * e, 0.92 * (1 - e));
  }

  ui.setCircle(flight.cx, flight.cy);
  ui.setTimer(runTime);
}

// Pitch and yaw in camera space only: the camera never rolls by itself. gx, gy: the extra turn of a pull (°/s).
function turn(dt, gx = 0, gy = 0) {
  const ax = (flight.wy + gy) * DEG * dt;    // pitch up = +x
  const ay = -(flight.wx + gx) * DEG * dt;   // yaw right = -y
  const angle = Math.hypot(ax, ay);
  if (angle > 0) {
    q.multiply(dq.setFromAxisAngle(axis.set(ax / angle, ay / angle, 0), angle));
    q.normalize();
  }
}

function updateCamera() {
  fwd.set(0, 0, -1).applyQuaternion(q);
  camera.quaternion.copy(q).multiply(kick).multiply(fx ? fx.kickRotation(fxKick) : fxKick);
  camera.updateMatrixWorld();
  projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projView);
}

// Moves space by one frame. Returns the rock that hit the player, if any.
function step(dt, { attract = false, collide = true, timeScale = 1, flySpeed = speed }) {
  updateCamera();
  move.copy(fwd).multiplyScalar(flySpeed * dt).addScaledVector(drift, dt);
  const hit = field.update(dt, { fwd, frustum, move, speed, timeScale, collide, attract });
  for (const e of field.events) fx.explode(e.p, e.s);
  fx.update(dt * timeScale, move);
  murk.update(dt, { move, fwd, frustum, cosKeep: field.cosKeep });
  motes.update(move);
  field.render(frustum);
  return hit;
}

// ---- hit: a short recoil, a kick of the view and the view closing in; then the game-over screen
function onHit(rock) {
  lastHit = { speed, t: runTime, type: rock.type };
  const isNew = runTime > best;
  if (isNew) {
    best = runTime;
    saveBest(best);
  }
  ui.gameOver(runTime, best, isNew);
  ui.setBest(best);
  kickAxis.set(Math.random() - 0.5, Math.random() - 0.5, 0).normalize();
  setMode('hit');
}

function hitEffect(dt) {
  const t = modeTime;
  // bounce back off the rock and come to a stop; the turn dies out
  const recoil = -RUN.recoil * lastHit.speed * Math.exp(-t / RUN.recoilSeconds);
  flight.wx *= Math.exp(-dt / 0.12);
  flight.wy *= Math.exp(-dt / 0.12);
  drift.multiplyScalar(Math.exp(-dt / 0.15));
  turn(dt);
  const wobble = RUN.kickDegrees * DEG * Math.exp(-t / 0.22) * Math.sin(2 * Math.PI * 7 * t + 0.6);
  kick.setFromAxisAngle(kickAxis, wobble);
  step(dt, { collide: false, timeScale: Math.exp(-t / 0.15), flySpeed: recoil });
  const k = Math.min(1, t / RUN.hitSeconds);
  const e = 1 - (1 - k) ** 3;
  ui.setEdge(1 - 0.65 * e, 0.92 * e);
}

// ---- layout
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  const aspect = w / h;
  const t = (deg) => Math.tan((deg * DEG) / 2);
  let tv;
  if (aspect >= 1) {  // landscape: the height shows fovShort, unless the width would pass fovLongMax
    tv = t(CAMERA.fovShort);
    if (tv * aspect > t(CAMERA.fovLongMax)) tv = t(CAMERA.fovLongMax) / aspect;
  } else {            // portrait: the width shows fovShort, the height at most fovLongMax
    tv = Math.min(t(CAMERA.fovShort) / aspect, t(CAMERA.fovLongMax));
  }
  camera.fov = (2 * Math.atan(tv)) / DEG;
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  field?.setView(camera, h * renderer.getPixelRatio(), frustum);
  motes.resize(camera, h * renderer.getPixelRatio());
  ui.layout();
  input.measure();
}
window.addEventListener('resize', resize);
window.visualViewport?.addEventListener('resize', resize);

// ---- debug read-outs (?debug) and a small handle for tests
let debugEl = null;
let debugAt = 0;
function debugLine(now) {
  if (now - debugAt < 250) return;
  debugAt = now;
  if (!debugEl) {
    debugEl = document.createElement('pre');
    debugEl.id = 'debug';
    document.body.append(debugEl);
  }
  const k = knobs(runTime);
  const s = field.stats;
  const t = s.types;
  debugEl.textContent = `${set} ${Math.round(fps)} fps  D ${k.D.toFixed(2)}  ${speed.toFixed(0)} m/s  gap ${k.pathGap.toFixed(1)} s\n`
    + `meteors ${s.alive}/${s.target} drawn ${s.drawn}  size×${field.sizeFactor.toFixed(2)}  calls ${renderer.info.render.calls}\n`
    + `decoy ${t.decoy} exploder ${t.exploder} big ${t.big} massive ${t.massive} frag ${t.frag}  booms ${s.explosions}  next massive ${field.massiveIn.toFixed(0)} s\n`
    + `circle ${flight.cx.toFixed(2)},${flight.cy.toFixed(2)}  turn ${flight.wx.toFixed(0)},${flight.wy.toFixed(0)} °/s  pull ${pull.strength.toFixed(2)} (${pull.gx.toFixed(0)},${pull.gy.toFixed(0)} °/s) drift ${drift.length().toFixed(1)} m/s`;
}

window.hole = {
  get mode() { return mode; },
  get time() { return runTime; },
  get best() { return best; },
  get speed() { return speed; },
  get fps() { return fps; },
  flight,
  get field() { return field; },
  get fwd() { return fwd.clone(); },
  get pull() { return pull; },
  get drift() { return drift.clone(); },
  get lastHit() { return lastHit; },
  get fx() { return fx; },
  ui,
  input,
  renderer,
  ...(DEBUG ? {
    placeAhead: (dist, size) => field.placeAhead(fwd, dist, size),
    place: (opts) => field.place(fwd, opts),
    // An empty stage for screenshots and tests: no field rocks, no massive meteors, only placed rocks hit.
    stage: () => {
      field.clear();
      fx.clear();
      field.densityScale = 0;
      field.autoMassive = false;
      field.testOnly = true;
    },
    spawnMassive: (opts) => field.spawnMassive(fwd, opts),
    camera,
    scene,
    setRendering: (on) => { rendering = on; },
    setTestOnly: (on) => { field.testOnly = on; },
    // Fixed-step clock for tests: stops the real-time clock and runs `seconds` of game in 1/60 s steps.
    advance: (seconds, stepSeconds = 1 / 60) => {
      manual = true;
      for (let t = 0; t < seconds - 1e-9; t += stepSeconds) tick(stepSeconds);
      return mode;
    },
    realtime: () => { manual = false; },
  } : {}),
};

boot().catch((err) => {
  console.error(err);
  ui.error(`Could not load the game: ${err.message}`);
});
