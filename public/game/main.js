// Hole: boot, game states (loading -> start -> run -> hit -> over -> run ...) and the main loop.
import * as THREE from 'three';
import { SPACE_COLOR, WORLD, CAMERA, LIGHTS, RUN, GRAVITY, SHAKE, DEEP, PULL_WARNING, FLIGHT } from './config.js';
import { pullForecast, pullStrength } from './gravity.js';
import { pickAssetSet, pixelRatio, hasTouch } from './device.js';
import { loadManifest, loadMeteors } from './loader.js';
import { loadSprites } from './sprites.js';
import { createFlight, resetFlight, stepFlight, stepJoystick, sensitivity, extremeConfig, strain } from './flight.js';
import { knobs } from './difficulty.js';
import { MeteorField } from './world.js';
import { Walls, controlsModel } from './walls.js';
import { createStars, Motes, Murk } from './space.js';
import { Fx } from './fx.js';
import { Input } from './input.js';
import { UI, loadBest, saveBest } from './ui.js';
import { loadSettings, saveSettings } from './settings.js';
import { GameSound } from './sound.js';
import { Quality } from './quality.js';

const DEG = Math.PI / 180;
const params = new URLSearchParams(window.location.search);
const DEBUG = params.has('debug');   // the test handle (window.hole); the read-out is a setting
const set = pickAssetSet();
const touch = hasTouch() || params.get('touch') === '1';

const settings = loadSettings();
// ?controls=extreme|joystick: for tests (not saved)
if (params.get('controls') === 'extreme' || params.get('controls') === 'joystick') settings.controls = params.get('controls');
const ui = new UI({ touch });
const input = new Input(ui.buttons, onPress);
input.touchEnabled = touch;
const sound = new GameSound(set, settings);
let controls = '';      // 'joystick' (default) or 'extreme' (the heavy circle of DESIGN §4)
let sens = 1;           // the sensitivity as a multiplier
let extremeFlight = extremeConfig(1);
ui.setupSettings(settings, (s) => {
  saveSettings(s);
  sound.applyVolumes();
  showDebug(s.debug);
  applyControls();
});

// The controls scheme and sensitivity from the settings (only ever changed between runs).
function applyControls() {
  sens = sensitivity(settings.sensitivity);
  extremeFlight = extremeConfig(sens);
  if (walls) walls.controls = controlsModel(settings.controls, sens);  // holes planned for these controls
  if (settings.controls === controls) return;
  controls = settings.controls;
  input.mode = controls;
  input.clear();
  ui.setControls(controls);
  input.measure();
  best = loadBest(controls);
  ui.setBest(best);
}

// ---- renderer, scene, camera (the camera never uses lookAt: orientation is a quaternion turned by pitch/yaw)
const canvas = document.getElementById('view');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (err) {
  ui.error('Hole needs WebGL, and this browser could not start it. Try another browser, or turn on hardware acceleration.');
  throw err;
}
const quality = new Quality(pixelRatio(set));   // steps the resolution down if frames stay slow
renderer.setPixelRatio(quality.pixelRatio);
// No tone mapping: the scene is dark, the yellows stay yellow (Contoo 2), and fog blends linearly into exactly
// the background colour, so a fully fogged rock is gone. (Neutral tone mapping squares the contrast of very dark
// colours: fogged rocks stood out as dark or dithered silhouettes.)
renderer.toneMapping = THREE.NoToneMapping;
const scene = new THREE.Scene();
const spaceColors = [new THREE.Color(SPACE_COLOR), new THREE.Color(DEEP.space)];  // blue-black -> red-black
scene.background = new THREE.Color(SPACE_COLOR);
scene.fog = new THREE.FogExp2(SPACE_COLOR, Math.sqrt(-Math.log(WORLD.fogAtRadius)) / WORLD.radius);
const camera = new THREE.PerspectiveCamera(CAMERA.fovShort, 1, CAMERA.near, CAMERA.far);
scene.add(camera);
const projBase = new THREE.Matrix4();     // the projection without the stretch (for the frustum)
const stretchM = new THREE.Matrix4();

// Lights ride with the camera: rocks look the same whichever way you face (no fixed up anywhere).
camera.add(new THREE.AmbientLight(LIGHTS.ambient.color, LIGHTS.ambient.intensity));
for (const l of [LIGHTS.key, LIGHTS.rim]) {
  const light = new THREE.DirectionalLight(l.color, l.intensity);
  light.position.set(0, 0, 0);
  light.target.position.set(...l.dir);
  camera.add(light, light.target);
}

const stars = createStars(renderer.getPixelRatio());  // around the origin, where the camera always is
scene.add(stars);
const motes = new Motes(set);
scene.add(motes.points);

// ---- game state
const flight = createFlight();
const q = new THREE.Quaternion();        // where the player faces
const kick = new THREE.Quaternion();     // visual camera offset (hit kick); never touches the HUD
const fxKick = new THREE.Quaternion();   // the shake stack (fx.js)
const leanQ = new THREE.Quaternion();    // the lean toward a massive meteor (a roll, fx.js)
const drift = new THREE.Vector3();       // sideways drift from a massive meteor's pull (world m/s)
const driftTarget = new THREE.Vector3();
const fwd = new THREE.Vector3(0, 0, -1);
const move = new THREE.Vector3();
const frustum = new THREE.Frustum();
const projView = new THREE.Matrix4();
const kickAxis = new THREE.Vector3();
const dq = new THREE.Quaternion();
const qInv = new THREE.Quaternion();
const axis = new THREE.Vector3();
const local = new THREE.Vector3();

let field = null;
let walls = null;
let murk = null;
let fx = null;
let pull = { gx: 0, gy: 0, strength: 0 };
// the pull warning: the forecast (every few frames), how close the hit is (0..1, smoothed), how much to show
const warn = { tHit: Infinity, meteor: null, danger: 0, show: 0, angle: 0, frame: 0 };
let mode = 'loading';
let runTime = 0;       // seconds survived this run (the timer)
let modeTime = 0;      // seconds since the mode began
let speed = 40;
let k = knobs(0);      // the difficulty now
let deep = -1;         // how deep space looks (knobs().deep), applied when it changes
let best = 0;           // the best time with the current controls (applyControls)
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
  walls = new Walls(field);
  murk = new Murk(scene, sprites);
  fx = new Fx(scene, sprites.flash, scene.fog.density);
  resize();
  updateCamera();
  speed = WORLD.attractSpeed;
  field.setDifficulty(k);
  field.setDensity(speed, k.pathGap);
  field.reset(fwd, frustum, { speed, attract: true });
  murk.reset(fwd, frustum, field.cosKeep);
  setDeep(0);
  const k1 = knobs(60);
  walls.warmUp({ runTime: 60, k: k1, speed: k1.speed, q, flight, drift, fwd, frustum });
  renderer.compile(scene, camera);
  applyControls();
  showDebug(settings.debug);
  setMode('start');
  renderer.setAnimationLoop(frame);
  sound.load(manifest);  // the music decodes in the background; the game doesn't wait for it
  if (set === 'pc') loadFarLod(manifest);
}

// PC: the mobile meshes of the small rocks as a far LOD (Contoo 4), loaded in the background; until they are in,
// every rock uses its PC mesh. Their textures are uploaded at once, so the first far rocks don't hitch.
async function loadFarLod(manifest) {
  try {
    const lo = await loadMeteors(manifest, 'mobile', () => {}, { groups: ['small'] });
    for (const mesh of field.addFarLod(lo.small)) {
      const m = mesh.material;
      for (const tex of [m.map, m.normalMap, m.roughnessMap, m.metalnessMap, m.aoMap]) if (tex) renderer.initTexture(tex);
    }
  } catch (err) {
    console.warn(`far LOD: ${err.message}; keeping the PC meshes`);
  }
}

// ---- presses: start, restart, continue after a pause (never while the settings are open)
function onPress(e) {
  if (e.target?.closest?.('.fs, .gear, #settings') || ui.settingsOpen) return;
  if (mode === 'start') {
    startRun(false);
  } else if (mode === 'over' && modeTime >= RUN.restartLock) {
    startRun(true);
  } else if (mode === 'paused' && modeTime >= RUN.pauseLock) {
    setMode('run');
  }
}

// Leaving the page mid-run (another app, another tab, the phone locked) pauses the run: coming back, space waits
// until you tap or press a key, instead of flying on into whatever was ahead.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && mode === 'run') setMode('paused');
});

function startRun(fresh) {
  resetFlight(flight);
  runTime = 0;
  k = knobs(0);
  speed = k.speed;
  drift.set(0, 0, 0);
  pull = { gx: 0, gy: 0, strength: 0 };
  field.setDifficulty(k);
  if (fresh) {  // a new run: fresh space behind the closed view, which then opens
    kick.identity();
    fx.clear();
    updateCamera();
    field.reset(fwd, frustum, { speed });
    murk.reset(fwd, frustum, field.cosKeep);
    setDeep(0);
    openT = 0;
  } else {
    walls.reset();
    field.clearNear(WORLD.startClear, frustum);
  }
  walls.begin(k);
  field.begin();
  sound.runStarted();
  input.measure();
  setMode('run');
}

// ---- main loop: frame() keeps time and draws; tick() is one step of the game
let manual = false;    // tests drive the clock with hole.advance() (?debug)

function frame(now) {
  const raw = Math.max(0, (now - last) / 1000);
  const dt = Math.min(0.05, raw);
  last = now;
  fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;
  if (!manual) tick(dt);
  if (!manual && rendering) {
    const pr = quality.update(raw, !document.hidden);
    if (pr) {
      renderer.setPixelRatio(pr);
      resize();
    }
  }
  if (rendering) {
    applyStretch();
    renderer.render(scene, camera);
  }
  if (debugEl && !debugEl.hidden) debugLine(now);
}

function tick(dt) {
  modeTime += dt;
  const held = input.update(dt);

  if (mode === 'start') {
    speed = WORLD.attractSpeed;
    step(dt, { attract: true, collide: false });
  } else if (mode === 'run') {
    runTime += dt;
    k = knobs(runTime);
    speed = k.speed;
    field.setDifficulty(k);
    setDeep(k.deep);
    if (controls === 'extreme') stepFlight(flight, held, dt, extremeFlight);
    else stepJoystick(flight, input.stick, dt, sens);
    // a massive meteor's pull: an extra turn toward it and a sideways drag (gravity.js)
    pull = field.playerPull(fwd, q, driftTarget);
    drift.lerp(driftTarget, 1 - Math.exp(-dt / GRAVITY.player.driftSeconds));
    turn(dt, pull.gx, pull.gy);
    const hit = step(dt, { collide: true, run: true });
    pullWarning(dt);
    sound.run(runTime, pull.strength);
    sound.warning(warn.danger, dt);
    if (hit) onHit(hit);
  } else if (mode === 'hit') {
    hitEffect(dt);
    if (modeTime >= RUN.hitSeconds) setMode('over');
  } else if (mode === 'paused') {
    sound.run(runTime, 0);   // the rumble rests; nothing moves
  } else if (mode === 'over' && fx) {
    fx.update(dt, move.set(0, 0, 0));  // space holds still behind the game-over screen; the lean eases back
    updateCamera();
  }

  // the view opening at the start of a fresh run
  if (openT < 1) {
    openT = Math.min(1, openT + dt / RUN.openSeconds);
    const e = 1 - (1 - openT) ** 2;
    ui.setEdge(0.35 + 0.65 * e, 0.92 * (1 - e));
  }

  if (mode !== 'run' && (warn.show || warn.danger)) {
    warn.show = warn.danger = 0;
    sound.warning(0, dt);
  }
  ui.setCircle(flight.cx, flight.cy);
  ui.setTimer(runTime);
  ui.setPullWarning(warn.show, warn.danger, warn.angle, runTime);
  if (fx) ui.setLeanEdge(fx.side.amount, warn.danger > 0.02 ? warn.angle : fx.side.angle, SHAKE.edge, warn.danger);
}

// The pull warning (owner's wish after Contoo 4): as soon as a massive meteor pulls you, chevrons by the cross point
// at it; if flying on as you are would hit it within PULL_WARNING.horizon s, they turn red and pulse, the edge on
// its side turns red, the words show and a beep repeats (sound.warning), faster the closer the hit.
function pullWarning(dt) {
  const W = PULL_WARNING;
  const ms = field.massives;
  if (!ms.length) {
    warn.tHit = Infinity;
    warn.meteor = null;
  } else if (warn.frame++ % W.every === 0) {
    const f = pullForecast(ms, { f: flight, q, drift, speed, controls: walls.controls, horizon: W.horizon,
                                 playerRadius: FLIGHT.playerRadius });
    warn.tHit = f.tHit;
    warn.meteor = f.meteor;
  }
  // which one: the one you would hit, else the one pulling hardest
  let m = warn.meteor;
  if (!m) {
    let best = 0;
    for (const x of ms) {
      const k = pullStrength(x) * x.pull;
      if (k > best) { best = k; m = x; }
    }
  }
  // a forecast hit is red at once (0.45), redder and faster the closer it is
  const target = warn.tHit < W.horizon ? 0.45 + 0.55 * (1 - warn.tHit / W.horizon) : 0;
  warn.danger += (target - warn.danger) * (1 - Math.exp(-dt / (target > warn.danger ? 0.08 : 0.35)));
  if (warn.danger < 0.002) warn.danger = 0;
  const shown = pull.strength > W.show ? Math.min(1, 0.35 + 0.65 * ((pull.strength - W.show) / 0.3)) : 0;
  warn.show += (Math.max(shown, warn.danger) - warn.show) * (1 - Math.exp(-dt / 0.15));
  if (warn.show < 0.004) warn.show = 0;
  if (m) {
    local.copy(m.p).applyQuaternion(qInv.copy(q).invert());
    warn.angle = Math.atan2(local.y, local.x) - (fx?.lean ?? 0);   // on screen (the lean turns the view)
  }
}

// Pitch and yaw only: the camera never rolls by itself (the lean is a separate visual roll). The player's turn is
// on the screen as they see it, so it is turned by the lean into the ship's frame; the pull (gx, gy, °/s) is in
// the ship's frame already.
function turn(dt, gx = 0, gy = 0) {
  const lean = fx?.lean ?? 0;
  const c = Math.cos(lean);
  const s = Math.sin(lean);
  const sx = flight.wy * DEG * dt;    // pitch up = +x
  const sy = -flight.wx * DEG * dt;   // yaw right = -y
  const ax = c * sx - s * sy + gy * DEG * dt;
  const ay = s * sx + c * sy - gx * DEG * dt;
  const angle = Math.hypot(ax, ay);
  if (angle > 0) {
    q.multiply(dq.setFromAxisAngle(axis.set(ax / angle, ay / angle, 0), angle));
    q.normalize();
  }
}

function updateCamera() {
  fwd.set(0, 0, -1).applyQuaternion(q);
  camera.quaternion.copy(q);
  if (fx) camera.quaternion.multiply(fx.leanRotation(leanQ)).multiply(fx.kickRotation(fxKick));
  camera.quaternion.multiply(kick);
  camera.updateMatrixWorld();
  projView.multiplyMatrices(projBase, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projView);
}

// The slight stretch of the view along a massive meteor's direction (only for drawing; the frustum uses the
// unstretched projection, which sees a little more, so nothing is placed or dropped where it would show).
function applyStretch() {
  const a = fx ? fx.side.amount * SHAKE.stretch : 0;
  camera.projectionMatrix.copy(projBase);
  if (a > 1e-4) {
    const ux = Math.cos(fx.side.angle);
    const uy = Math.sin(fx.side.angle);
    const r = camera.aspect;   // width / height
    stretchM.set(
      1 + a * ux * ux, (a * ux * uy) / r, 0, 0,
      a * ux * uy * r, 1 + a * uy * uy, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    );
    camera.projectionMatrix.premultiply(stretchM);
  }
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

// Moves space by one frame. Returns the rock that hit the player, if any. run: a run is on (walls, camera layers).
function step(dt, { attract = false, collide = true, timeScale = 1, flySpeed = speed, run = false }) {
  updateCamera();
  move.copy(fwd).multiplyScalar(flySpeed * dt).addScaledVector(drift, dt);
  const hit = field.update(dt, { fwd, frustum, move, speed, timeScale, collide, attract });
  walls.update(dt, { runTime, k, speed, q, flight, drift, fwd, frustum, move, spawn: run });
  qInv.copy(q).invert();
  for (const e of field.events) {
    fx.explode(e.p, e.s);
    local.copy(e.p).applyQuaternion(qInv);
    sound.boom(e.d, local.x / Math.max(e.d, 1), e.s);
  }
  for (const m of field.misses) {
    local.copy(m.p).applyQuaternion(qInv);
    const kk = fx.nearMiss(local.x, local.y, m.gap, m.s);
    sound.whoosh(kk, local.x / Math.max(1, Math.hypot(local.x, local.y)), m.speed);
  }
  fx.update(dt * timeScale, move, run ? { strain: strain(flight), pull } : {});
  murk.update(dt, { move, fwd, frustum, cosKeep: field.cosKeep });
  motes.update(move);
  field.render(frustum);
  return hit;
}

// Space shifts from blue-black to red-black and the dust thickens (deep 0..1, from the difficulty).
function setDeep(d) {
  if (Math.abs(d - deep) < 0.002) return;
  deep = d;
  scene.background.lerpColors(spaceColors[0], spaceColors[1], d);
  scene.fog.color.copy(scene.background);
  motes.setDeep(d);
  murk?.setDeep(d);
}

// ---- hit: a short recoil, a kick of the view and the view closing in; then the game-over screen
function onHit(rock) {
  lastHit = { speed, t: runTime, type: rock.type, wall: !!rock.wall };
  const isNew = runTime > best;
  if (isNew) {
    best = runTime;
    saveBest(best, controls);
  }
  ui.gameOver(runTime, best, isNew);
  ui.setBest(best);
  kickAxis.set(Math.random() - 0.5, Math.random() - 0.5, 0).normalize();
  fx.calm();
  sound.hit();
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
  const e = 1 - (1 - Math.min(1, t / RUN.hitSeconds)) ** 3;
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
  projBase.copy(camera.projectionMatrix);
  field?.setView(camera, h * renderer.getPixelRatio(), frustum);
  motes.resize(camera, h * renderer.getPixelRatio());
  stars.material.uniforms.uPixelRatio.value = renderer.getPixelRatio();
  ui.layout();
  input.measure();
}
window.addEventListener('resize', resize);
window.visualViewport?.addEventListener('resize', resize);

// ---- the debug read-out (a setting, off by default) and a small handle for tests (?debug)
let debugEl = null;
let debugAt = 0;
function showDebug(on) {
  if (on && !debugEl) {
    debugEl = document.createElement('pre');
    debugEl.id = 'debug';
    document.body.append(debugEl);
  }
  if (debugEl) debugEl.hidden = !on;
}

function debugLine(now) {
  if (now - debugAt < 250 || !field) return;
  debugAt = now;
  const s = field.stats;
  const t = s.types;
  const w = walls.stats;
  const a = sound.state;
  debugEl.textContent = `${set} ${Math.round(fps)} fps  px ×${renderer.getPixelRatio()}${quality.state === 'done' ? ' (fixed)' : ''}  D ${k.D.toFixed(2)}  ${speed.toFixed(0)} m/s  gap ${k.pathGap.toFixed(1)} s  deep ${deep.toFixed(2)}\n`
    + `meteors ${s.alive}/${s.target} drawn ${s.drawn} (far ${s.far})  size×${field.sizeFactor.toFixed(2)}  calls ${renderer.info.render.calls}\n`
    + `decoy ${t.decoy} exploder ${t.exploder} big ${t.big} massive ${t.massive} frag ${t.frag}  booms ${s.explosions}  next massive ${field.massiveIn.toFixed(0)} s\n`
    + `walls ${w.spawned} (skipped ${w.skipped}, combos ${w.combos}) next ${Math.max(0, walls.nextAt - runTime).toFixed(1)} s  warn ${k.wallWarn.toFixed(1)} s every ${k.wallGap.toFixed(1)} s  calm ×${field.inflowScale.toFixed(2)}  plan ${w.planMs.toFixed(1)} ms\n`
    + `circle ${flight.cx.toFixed(2)},${flight.cy.toFixed(2)}  turn ${flight.wx.toFixed(0)},${flight.wy.toFixed(0)} °/s  pull ${pull.strength.toFixed(2)} (${pull.gx.toFixed(0)},${pull.gy.toFixed(0)} °/s) drift ${drift.length().toFixed(1)} m/s  lean ${(fx.lean / DEG).toFixed(0)}°\n`
    + `audio ${a.context}${a.loaded ? '' : ' (music loading)'}  music ${a.playing ? `level ${a.intensity.toFixed(2)} depth ${a.depth.toFixed(2)}` : 'off'}  near misses ${fx.stats.nearMisses}`;
}

window.hole = {
  get mode() { return mode; },
  get controls() { return controls; },
  get modeTime() { return modeTime; },
  get time() { return runTime; },
  get best() { return best; },
  get speed() { return speed; },
  get fps() { return fps; },
  flight,
  get field() { return field; },
  get walls() { return walls; },
  get fwd() { return fwd.clone(); },
  get q() { return q.clone(); },
  get pull() { return pull; },
  get warning() { return { ...warn, meteor: undefined }; },
  get drift() { return drift.clone(); },
  get lastHit() { return lastHit; },
  get fx() { return fx; },
  get deep() { return deep; },
  sound,
  settings,
  ui,
  input,
  renderer,
  quality,
  ...(DEBUG ? {
    placeAhead: (dist, size) => field.placeAhead(fwd, dist, size),
    place: (opts) => field.place(fwd, opts),
    // An empty stage for screenshots and tests: no field rocks, no massive meteors, no walls, only placed rocks hit.
    stage: () => {
      field.clear();
      fx.clear();
      field.densityScale = 0;
      field.autoMassive = false;
      field.testOnly = true;
      walls.auto = false;
    },
    spawnMassive: (opts) => field.spawnMassive(fwd, opts),
    // A wall now (opts: holes [{ off, phi }] in degrees, warn, check, combo, test)
    spawnWall: (opts = {}) => walls.spawn({ runTime, k, speed, q, flight, drift, fwd, frustum, move }, { test: true, ...opts }),
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
    // Jump the run clock (the difficulty) to t seconds; space keeps what it has, new spawns follow.
    setRunTime: (t) => { runTime = t; },
    realtime: () => { manual = false; },
  } : {}),
};

boot().catch((err) => {
  console.error(err);
  ui.error(`Could not load the game: ${err.message}`);
});
