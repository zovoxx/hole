#!/usr/bin/env node
// Fast checks of the game logic in Node, no browser (Contoo 1): the flight model, the difficulty curve and the
// meteor field (even density at every distance flying straight and turning, nothing pops into view, nothing
// comes from behind, the density gives the planned seconds between rocks in your path).
// Contoo 2: meteor types and colours, the tell, fuses (where they light and blow up), explosion pieces (aimed,
// dodgeable, pulled by gravity), orbits, the massive meteor's pull (drift slowly at the edge, hold against it
// halfway in, do nothing and you hit it) and the escape sheet (clear holes; steering through one gets you out).
// Contoo 3: the wall knobs and rhythm, the warning, holes never on your path, every hole made by a pilot that
// reacts late, wall exploders, walls next to a massive meteor, the calm, near misses, the depth of space.
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
const { tellAt, tintColor } = await game('meteors.js');
const { WORLD, FLIGHT, EXPLODER, EXPLOSION, GRAVITY, WALL } = await game('config.js');
const { playerRange, circularSpeed } = await game('gravity.js');
const { Walls, pilot } = await game('walls.js');

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

console.log('joystick controls');
{
  const { stepJoystick, sensitivity } = await game('flight.js');
  const { JOYSTICK, SENSITIVITY } = await game('config.js');
  const f = createFlight();
  for (let i = 0; i < 30; i++) stepJoystick(f, { x: 1, y: 0 }, dt);
  const full = f.wx;
  stepJoystick(f, { x: 0, y: 0 }, dt);
  const centred = f.cx === 0 && f.tx === 0;
  for (let i = 0; i < 20; i++) stepJoystick(f, { x: 0, y: 0 }, dt);
  const stopped = f.wx;
  const g = createFlight();
  for (let i = 0; i < 60; i++) stepJoystick(g, { x: 0.5, y: 0 }, dt);
  check(Math.abs(full - JOYSTICK.maxTurnRate) < 1e-6 && centred && stopped === 0 && g.wx > 20 && g.wx < 0.45 * JOYSTICK.maxTurnRate,
    'joystick: full push turns at its top rate in ~0.2 s, half a push turns gently, let go and the turn stops',
    `full ${full.toFixed(0)} °/s, half ${g.wx.toFixed(0)} °/s, released ${stopped} °/s`);
  const lo = JOYSTICK.maxTurnRate * sensitivity(SENSITIVITY.min);
  const hi = JOYSTICK.maxTurnRate * sensitivity(SENSITIVITY.max);
  const pullMax = GRAVITY.player.turnMax * knobs(1e5).pull * 0.36;   // (the strongest pull beside you, halfway in)
  check(sensitivity(SENSITIVITY.base) === 1 && lo >= FLIGHT.maxTurnRate && lo > pullMax,
    'sensitivity: even the lowest joystick turns as fast as Extreme and out-turns a massive meteor\'s pull',
    `${lo.toFixed(0)} ... ${hi.toFixed(0)} °/s (Extreme ${FLIGHT.maxTurnRate}, pull at most ~${pullMax.toFixed(0)} °/s)`);
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
                        collisionSpheres: e.collisionSpheres, sizeInRock: e.sizeInRock });

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
    if (hit) field.remove(hit);
    for (const r of field.rocks) {
      if (known.has(r)) continue;
      known.add(r);
      // a new rock in view must appear at the far edge, faded out (a big rock's moon arriving with it, fade 0, can be
      // a little nearer: still in the fog's last few percent)
      if (field.visible(r, frustum) && (r.fade > 0 || r.p.length() < R - 2 * WORLD.fadeBand)) pops++;
      // nothing comes from behind: every rock moves backward relative to the player
      if (r.v.dot(fwd) >= speed) behind++;
    }
    if (i > 60 * 10 && i % 10 === 0) {
      samples++;
      for (const r of field.rocks) {
        if (r.host || !frustum.containsPoint(r.p)) continue;  // (a big rock's moons come on top of the field)
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
  // (~150 rocks a run: runs of the same code measure 6.6–9.4 s, so ±25%)
  check(seen > 8 * 0.78 && seen < 8 * 1.25, 'flying straight, a rock is in your path about every pathGap seconds',
    `one per ${seen.toFixed(2)} s for a planned 8 s (${r.hitCount} rocks)`);
}

// ---- Contoo 2: danger

// An empty stage (no field rocks, no automatic massive meteors) and a pilot that flies like main.js: the flight
// model, the pull of massive meteors (extra turn and drift) and the field update.
function stage({ speed = 40, aspect = 16 / 9, t = 0, walls = false } = {}) {
  const field = new MeteorField(new THREE.Scene(), { small: manifest.meteors.small.map(shape),
    big: manifest.meteors.big.map(shape), fragments: manifest.meteors.fragments.map(shape) });
  const cam = new THREE.PerspectiveCamera(60, aspect, 0.3, 1400);
  field.setView(cam);
  field.densityScale = 0;
  field.autoMassive = false;
  field.setDensity(speed, 8);
  const p = { field, f: createFlight(), q: new THREE.Quaternion(), fwd: new THREE.Vector3(0, 0, -1),
              frustum: new THREE.Frustum(), drift: new THREE.Vector3(), pull: { gx: 0, gy: 0, strength: 0 }, speed,
              t, k: knobs(t), walls: walls ? new Walls(field) : null, spawnWalls: false };
  field.k = p.k;
  const pv = new THREE.Matrix4();
  const move = new THREE.Vector3();
  const driftT = new THREE.Vector3();
  const dq = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  p.view = () => {
    p.fwd.set(0, 0, -1).applyQuaternion(p.q);
    cam.quaternion.copy(p.q);
    cam.updateMatrixWorld();
    p.frustum.setFromProjectionMatrix(pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  };
  p.view();
  // one 1/60 s frame; held = { x, y }; returns the rock that hit you
  p.step = (held = { x: 0, y: 0 }) => {
    stepFlight(p.f, held, dt);
    p.pull = field.playerPull(p.fwd, p.q, driftT);
    p.drift.lerp(driftT, 1 - Math.exp(-dt / GRAVITY.player.driftSeconds));
    const ax = (p.f.wy + p.pull.gy) * DEG * dt;
    const ay = -(p.f.wx + p.pull.gx) * DEG * dt;
    const a = Math.hypot(ax, ay);
    if (a > 0) {
      p.q.multiply(dq.setFromAxisAngle(axis.set(ax / a, ay / a, 0), a));
      p.q.normalize();
    }
    p.view();
    move.copy(p.fwd).multiplyScalar(p.speed * dt).addScaledVector(p.drift, dt);
    const hit = field.update(dt, { fwd: p.fwd, frustum: p.frustum, move, speed: p.speed });
    if (p.walls) {
      p.t += dt;
      p.walls.update(dt, { runTime: p.t, k: p.k, speed: p.speed, q: p.q, flight: p.f, drift: p.drift, fwd: p.fwd,
                           frustum: p.frustum, move, spawn: p.spawnWalls });
    }
    return hit;
  };
  // a wall now, from the current state (opts as Walls.spawn)
  p.wall = (opts = {}) => p.walls.spawn({ runTime: p.t, k: p.k, speed: p.speed, q: p.q, flight: p.f, drift: p.drift,
                                           fwd: p.fwd, frustum: p.frustum }, opts);
  // the circle moves toward c* (|c*| <= 1) at its constant speed
  p.circleTo = (cx, cy) => {
    const dx = cx - p.f.cx;
    const dy = cy - p.f.cy;
    const l = Math.hypot(dx, dy);
    return l < dt / FLIGHT.circleSeconds ? { x: 0, y: 0 } : { x: dx / l, y: dy / l };
  };
  return p;
}

console.log('meteor types');
{
  const shares = (t) => {
    const p = stage();
    p.field.k = knobs(t);
    const n = { rock: 0, decoy: 0, exploder: 0 };
    for (let i = 0; i < 40000; i++) n[p.field.smallType()]++;
    return { decoy: n.decoy / 40000, exploder: n.exploder / 40000 };
  };
  const a = shares(0);
  const b = shares(600);
  check(Math.abs(a.decoy - knobs(0).decoyShare) < 0.01 && Math.abs(a.exploder - knobs(0).exploderShare) < 0.002
        && b.exploder > a.exploder * 1.5 && b.decoy > a.decoy,
  'decoy and exploder shares follow the difficulty', `start ${(a.decoy * 100).toFixed(1)}% / ${(a.exploder * 100).toFixed(2)}%, 10 min ${(b.decoy * 100).toFixed(1)}% / ${(b.exploder * 100).toFixed(2)}%`);
  // decoys drift toward the exploder colour over a run
  const ex = tintColor('exploder');
  const dist = (t) => {
    const p = stage();
    p.field.k = knobs(t);
    let sum = 0;
    const c = new THREE.Vector3();
    for (let i = 0; i < 3000; i++) {
      const r = p.field.makeRock('decoy', p.field.groups.small[0], new THREE.Vector3(0, 0, -100), 5, 1);
      sum += c.set(r.tint.r - ex.r, r.tint.g - ex.g, r.tint.b - ex.b).length();
    }
    return sum / 3000;
  };
  const d0 = dist(0);
  const d1 = dist(600);
  check(d1 < d0 * 0.75, 'later in a run the decoys get closer to the exploder colour', `mean colour distance ${d0.toFixed(3)} -> ${d1.toFixed(3)}`);
  check(tellAt(260) === 0 && tellAt(150) === 0 && tellAt(100) > 0.05 && tellAt(100) < 0.4 && tellAt(40) === 1,
    'tell: none far, faint at mid distance, clear up close', `250 m ${tellAt(260)}, 100 m ${tellAt(100).toFixed(2)}, 40 m ${tellAt(40)}`);
}

console.log('fuses and explosions');
// fly straight at an exploder; returns where its fuse lit and where it blew up (distances), and the pieces
function fuseRun(speed, { dist = 300, side = 0 } = {}) {
  const p = stage({ speed });
  const ex = p.field.place(p.fwd, { type: 'exploder', dist, s: 6, side });
  let lit = null;
  let boom = null;
  let pieces = [];
  for (let i = 0; i < 60 * 12 && !boom; i++) {
    p.step();
    if (lit === null && ex.fuse >= 0) lit = ex.p.length();
    if (p.field.events.length) {
      boom = p.field.events[0];
      pieces = p.field.rocks.filter((r) => r.type === 'frag');
    }
  }
  return { lit, boom, pieces, p };
}
{
  const a = fuseRun(40);
  check(a.lit > 140 && a.lit < 160 && a.boom && a.boom.d > 62 && a.boom.d < 78,
    'at 40 m/s the fuse lights ~150 m ahead and it blows up ~70 m ahead', `lit at ${a.lit?.toFixed(0)} m, boom at ${a.boom?.d.toFixed(0)} m`);
  const b = fuseRun(70);
  check(b.boom && Math.abs(b.boom.d / 70 - EXPLODER.leadSeconds) < 0.15,
    'at 70 m/s it blows up the same time ahead (lead seconds)', `lit at ${b.lit?.toFixed(0)} m, boom at ${b.boom?.d.toFixed(0)} m = ${(b.boom?.d / 70).toFixed(2)} s`);
  check(a.pieces.length >= EXPLOSION.pieces[0] && a.pieces.length <= EXPLOSION.pieces[1] && a.pieces.some((r) => r.aimed),
    '6–12 pieces, at least one sent toward you', `${a.pieces.length} pieces, ${a.pieces.filter((r) => r.aimed).length} aimed`);
  const off = fuseRun(40, { side: 40 });  // far off to the side, never in view
  check(off.lit === null && !off.boom, 'an exploder you never see never lights its fuse');
  const wide = fuseRun(40, { dist: 300, side: 25 });  // in view but passing ~130 m to the side
  check(wide.lit === null, 'an exploder passing far to the side of your path does not light (only the far few do)');
  // a far one: lights at its farFuse distance wherever it is in view
  const p = stage();
  const far = p.field.place(p.fwd, { type: 'exploder', dist: 290, s: 6, side: 20 });
  far.farFuse = 240;
  let farBoom = null;
  for (let i = 0; i < 60 * 6 && !farBoom; i++) {
    p.step();
    if (p.field.events.length) farBoom = p.field.events[0];
  }
  check(farBoom && farBoom.d > 120, 'a few blow up on their own far away', `boom at ${farBoom?.d.toFixed(0)} m`);
}
{
  // pieces feel gravity: a piece next to a big rock bends toward it
  const p = stage();
  const big = p.field.place(p.fwd, { type: 'big', dist: 150, s: 20 });
  const piece = p.field.makeRock('frag', p.field.groups.frag[0], big.p.clone().add(new THREE.Vector3(45, 0, 0)), 2, 1);
  piece.v.set(0, 0, 0);
  p.speed = 0;
  for (let i = 0; i < 60; i++) p.step();
  check(piece.v.x < -0.5, 'explosion pieces are pulled by gravity', `after 1 s ${piece.v.x.toFixed(2)} m/s toward the big rock`);
}
{
  // dodgeable: do nothing and the aimed pieces often hit you; 0.3 s after the flash turn hard away from the side
  // the piece you see coming will pass on, and they rarely do
  const trial = (dodge) => {
    const p = fuseRun(40, { dist: 160 }).p;  // (fuseRun stops at the flash)
    p.field.testOnly = false;
    let t = 0;
    let away = null;
    for (let i = 0; i < 60 * 3; i++) {
      t += dt;
      if (dodge && t > 0.3 && !away) {
        const piece = p.field.rocks.find((r) => r.aimed);
        const w = piece ? piece.v.clone().addScaledVector(p.fwd, -p.speed) : null;
        const o = piece ? piece.p.clone().addScaledVector(w, -piece.p.dot(w) / w.lengthSq()) : new THREE.Vector3(1, 0, 0);
        o.applyQuaternion(p.q.clone().invert());
        const l = Math.hypot(o.x, o.y) || 1;
        away = { x: -o.x / l, y: -o.y / l };
      }
      const held = away ? p.circleTo(away.x, away.y) : { x: 0, y: 0 };
      if (p.step(held)) return 1;
    }
    return 0;
  };
  let still = 0;
  let dodged = 0;
  const N = 60;
  for (let i = 0; i < N; i++) {
    still += trial(false);
    dodged += trial(true);
  }
  // (300 trials: 32–38% hit flying on, 8% turning away; 60 trials scatter ±6% / ±3.5%)
  check(still / N > 0.2 && dodged / N < 0.16 && dodged < still / 2,
    'pieces fly at you: scary if you do nothing, dodgeable if you steer', `hit ${still}/${N} flying on, ${dodged}/${N} turning away after 0.3 s`);
}

console.log('gravity');
{
  // orbits: bound swarm members stay around their massive meteor, slingshots swing past fast
  const p = stage({ speed: 0 });
  p.speed = 0;
  const m = p.field.spawnMassive(p.fwd, { dist: 200, offAxis: 0, s: 22 });
  const members = p.field.rocks.filter((r) => r.host === m);
  const r0 = new Map(members.map((r) => [r, r.p.distanceTo(m.p)]));
  let fastest = 0;
  for (let i = 0; i < 60 * 12; i++) {
    p.step();
    for (const r of members) fastest = Math.max(fastest, r.v.distanceTo(m.v) / circularSpeed(m.mu, m.s, r.p.distanceTo(m.p)));
  }
  const bound = members.filter((r) => r0.get(r) <= GRAVITY.massive.orbit[1] * m.s * 1.01);
  const kept = bound.filter((r) => p.field.rocks.includes(r) && r.p.distanceTo(m.p) < GRAVITY.massive.orbit[1] * m.s * 1.5);
  // (one of 7–10 is sometimes lost)
  check(bound.length > 3 && kept.length >= bound.length * 0.85, 'a massive meteor\'s swarm keeps circling it',
    `${kept.length}/${bound.length} bound members still in orbit after 12 s, ${members.length - bound.length} slingshots`);
  check(fastest > 1.3, 'slingshots swing past faster than an orbit', `fastest ${fastest.toFixed(2)}× circular speed`);
  // the dust ring is a tell: none far, clear near
  check(tellAt(260 - 22) === 0 && tellAt(60 - 22) === 1, 'the dust ring shows only up close (same tell)');
}
{
  // the pull on you: slow drift at the edge, about half your top turn halfway in, nothing once behind you
  const p = stage();
  const m = p.field.spawnMassive(p.fwd, { dist: 200, offAxis: 0, s: 22 });
  const range = playerRange(m);
  const at = (d, deg) => {
    m.p.set(Math.sin(deg * DEG), 0, -Math.cos(deg * DEG)).multiplyScalar(d);
    const drift = new THREE.Vector3();
    const r = p.field.playerPull(p.fwd, p.q, drift);
    return { turn: Math.hypot(r.gx, r.gy), drift: drift.length(), gx: r.gx };
  };
  const edge = at(range * 0.95, 30);
  const half = at((range + m.s) / 2, 30);
  const behind = at(60, 150);
  check(edge.turn < 6 && edge.drift < 1, 'at the edge of its range you drift slowly', `${edge.turn.toFixed(1)} °/s, ${edge.drift.toFixed(2)} m/s`);
  check(half.turn > 25 && half.turn < 60 && half.gx > 0, 'halfway in it turns you toward it hard enough that you must hold against it',
    `${half.turn.toFixed(0)} °/s toward it (your top turn is ${FLIGHT.maxTurnRate}), drift ${half.drift.toFixed(1)} m/s`);
  m.pull = knobs(1800).pull;
  const side = at((range + m.s) / 2, 90);
  check(side.turn < FLIGHT.maxTurnRate * 0.95, '...and even late in a run, beside it halfway in, holding against it still wins',
    `${side.turn.toFixed(0)} °/s at 30 min`);
  check(behind.turn < 0.5, 'once it is behind you it lets go', `${behind.turn.toFixed(2)} °/s`);
}
{
  // do nothing near a massive meteor in your path: you hit it. Steer through an escape hole: you get out.
  const approach = (escape, t = 0) => {
    const k = knobs(t);
    const p = stage({ speed: k.speed });
    p.field.k = k;
    p.field.testOnly = false;
    const m = p.field.spawnMassive(p.fwd, { s: 16 + Math.random() * 14 });
    const hole = m.holes[0];
    const target = new THREE.Vector3();
    const l = new THREE.Vector3();
    const qi = new THREE.Quaternion();
    for (let i = 0; i < 60 * 14; i++) {
      let held = { x: 0, y: 0 };
      if (escape && p.field.rocks.includes(m)) {
        // aim through the hole (a little past it), allowing for the pull; bang-bang circle as a player would
        target.copy(m.p).add(hole.offset).addScaledVector(hole.axis, 30);
        if (target.dot(p.fwd) > 5) {
          l.copy(target).applyQuaternion(qi.copy(p.q).invert());
          const ex = Math.atan2(l.x, -l.z) / DEG;
          const ey = Math.atan2(l.y, -l.z) / DEG;
          const wx = 2.2 * ex - 0.35 * p.f.wx - p.pull.gx;
          const wy = 2.2 * ey - 0.35 * p.f.wy - p.pull.gy;
          const w = Math.hypot(wx, wy);
          held = w < 10 ? p.circleTo(0, 0) : p.circleTo((0.5 * wx) / w, (0.5 * wy) / w);
        } else if (p.pull.strength > 0.02) {  // past the hole: keep holding away from it until it lets go
          const w = Math.hypot(p.pull.gx, p.pull.gy);
          held = p.circleTo(-p.pull.gx / w, -p.pull.gy / w);
        } else {
          held = p.circleTo(0, 0);
        }
      }
      const hit = p.step(held);
      if (hit) return hit.type === 'massive' ? 'massive' : hit.host === m ? 'swarm' : 'other';
      if (!p.field.rocks.includes(m) && m.p.dot(p.fwd) < 0) break;
    }
    return 'free';
  };
  const N = 40;
  const idle = { massive: 0, swarm: 0, other: 0, free: 0 };
  const out = { massive: 0, swarm: 0, other: 0, free: 0 };
  for (let i = 0; i < N; i++) {
    idle[approach(false)]++;
    out[approach(true)]++;
  }
  check(idle.massive / N > 0.8, 'do nothing near a massive meteor in your path and you hit it',
    `${idle.massive}/${N} hit it, ${idle.swarm} its swarm, ${idle.other} the escape sheet, ${idle.free} got past`);
  check(out.free / N >= 0.9, 'steering through an escape hole gets you out',
    `${out.free}/${N} out; hit: massive ${out.massive}, swarm ${out.swarm}, sheet ${out.other}`);
  const late = { massive: 0, swarm: 0, other: 0, free: 0 };
  for (let i = 0; i < N; i++) late[approach(true, 600)]++;
  check(late.free / N >= 0.9, '...also 10 minutes in (faster, stronger pull)',
    `${late.free}/${N} out at ${knobs(600).speed.toFixed(0)} m/s, pull ×${knobs(600).pull.toFixed(2)}; hit: massive ${late.massive}, swarm ${late.swarm}, sheet ${late.other}`);
}
{
  // the escape sheet: on the side away from the massive meteor, with clear holes
  let clear = 0;
  let away = 0;
  const N = 30;
  for (let i = 0; i < N; i++) {
    const p = stage();
    const m = p.field.spawnMassive(p.fwd, {});
    const sheet = p.field.rocks.filter((r) => r.noGrav);
    const lat = (v) => v.clone().addScaledVector(p.fwd, -v.dot(p.fwd));
    const mLat = lat(m.p);
    const ok = m.holes.every((h) => {
      const c = m.p.clone().add(h.offset);
      return sheet.every((r) => {
        const d = r.p.clone().sub(c);
        const along = d.dot(h.axis);
        return Math.sqrt(d.lengthSq() - along * along) > h.r + r.s * 0.99;
      });
    });
    if (ok && m.holes.length >= 1) clear++;
    if (m.holes.every((h) => lat(m.p.clone().add(h.offset)).dot(mLat) < 0)) away++;
  }
  check(clear === N && away === N, 'escape sheet: every hole is clear and on the side away from the massive meteor',
    `${clear}/${N} clear, ${away}/${N} on the escape side`);
}

// ---- Contoo 3: pressure

console.log('walls');
{
  let mono = true;
  let prev = knobs(0);
  for (let t = 1; t <= 1800; t++) {
    const k = knobs(t);
    if (k.wallGap > prev.wallGap || k.wallWarn > prev.wallWarn || k.wallExploders < prev.wallExploders
        || k.wallCombo < prev.wallCombo || k.deep < prev.deep) mono = false;
    prev = k;
  }
  const [a, b, c, d] = [0, 60, 180, 600].map((t) => knobs(t));
  check(mono && Math.abs(a.wallWarn - 4) < 0.01 && Math.abs(c.wallWarn - 2) < 0.15 && d.wallWarn === 2
        && Math.abs(a.wallGap - 15) < 0.01 && d.wallGap === 6,
  'one curve: warning 4 s -> 2 s after a few minutes, a wall every 15 s -> 6 s, combos and depth only grow',
  `warn ${a.wallWarn.toFixed(1)} / ${b.wallWarn.toFixed(1)} / ${c.wallWarn.toFixed(1)} / ${d.wallWarn.toFixed(1)} s, every ${a.wallGap.toFixed(1)} / ${b.wallGap.toFixed(1)} / ${c.wallGap.toFixed(1)} / ${d.wallGap.toFixed(1)} s at 0 / 1 / 3 / 10 min`);
  check(a.wallExploders === 0 && a.wallCombo === 0 && knobs(30).wallExploders === 0 && d.wallExploders > 0.02 && d.wallCombo > 0.3,
    'combos (exploders in walls, walls next to massive meteors) only later in a run',
    `exploders ${(b.wallExploders * 100).toFixed(1)}% at 1 min, ${(d.wallExploders * 100).toFixed(1)}% at 10 min; combo ${(d.wallCombo * 100).toFixed(0)}%`);
}
{
  // the rhythm and the warning over a simulated run (an empty field, flying straight through everything)
  const p = stage({ walls: true });
  p.field.testOnly = true;
  p.spawnWalls = true;
  p.walls.begin(p.k, 0);
  const spawned = [];
  let n = 0;
  for (let i = 0; i < 60 * 330; i++) {
    p.k = knobs(p.t);
    p.speed = p.k.speed;
    p.field.k = p.k;
    p.step();
    if (p.walls.stats.spawned > n) {
      n = p.walls.stats.spawned;
      const w = p.walls.active[p.walls.active.length - 1];
      spawned.push({ t: p.t, warn: w.warn, L: w.L, speed: p.speed, w, reached: null, fade0: w.rocks.filter((r) => r && r.fade > 0).length });
    }
    for (const s of spawned) if (s.reached === null && s.w.center.length() >= s.L) s.reached = p.t - s.t;
  }
  const gaps = spawned.slice(1).map((s, i) => s.t - spawned[i].t);
  const early = gaps.slice(0, 1);
  const late = gaps.filter((g, i) => spawned[i].t > 240);
  const onCurve = gaps.every((g, i) => g >= knobs(spawned[i].t).wallGap * WALL.gapJitter[0] - 0.05
                                     && g <= knobs(spawned[i].t).wallGap * WALL.gapJitter[1] + 1);
  check(spawned[0].t > 12 && spawned[0].t < 18 && early.every((g) => g > 10.5 && g < 16) && late.length > 5
        && late.every((g) => g >= 5 && g < 7.5) && onCurve,
    'walls come about every 15 s early and every 6 s late (the curve, ±15%)', `first at ${spawned[0].t.toFixed(1)} s, then ${gaps.slice(0, 4).map((g) => g.toFixed(1)).join(', ')} ... late ${late.slice(0, 5).map((g) => g.toFixed(1)).join(', ')} s (${spawned.length} walls in 5.5 min, ${p.walls.stats.skipped} skipped)`);
  const first = spawned[0];
  const last = spawned.filter((s) => s.reached !== null).pop();
  check(first.warn > 3.4 && Math.abs(first.reached - first.warn) < 0.15 && Math.abs(last.reached - 2) < 0.15 && first.fade0 === 0,
    'a wall appears (out of the murk, faded in) about 4 s ahead early and 2 s ahead late',
    `first ${first.L.toFixed(0)} m ahead, reached after ${first.reached.toFixed(2)} s; at ${last.t.toFixed(0)} s ${last.L.toFixed(0)} m ahead, reached after ${last.reached.toFixed(2)} s`);
}
// A wall from a random flight state (straight or turning), flown by the real field and the real wall rocks.
// Returns 'wall' (hit a wall rock), 'through' (crossed the wall) or 'none' (no wall placed).
function wallRun(t, { turning = false, steer = true, exploders = true } = {}) {
  const k = { ...knobs(t), ...(exploders ? {} : { wallExploders: 0 }) };   // (an exploder blows its own gap)
  const p = stage({ speed: k.speed, t, walls: true });
  p.k = k;
  p.field.testOnly = false;
  if (turning) {
    p.f.cx = (Math.random() * 2 - 1) * 0.4;
    p.f.cy = (Math.random() * 2 - 1) * 0.4;
    p.f.wx = (Math.random() * 2 - 1) * 40;
    p.f.wy = (Math.random() * 2 - 1) * 40;
  }
  const w = p.wall();
  if (!w) return { out: 'none' };
  const hole = w.holes[Math.floor(Math.random() * w.holes.length)];
  const target = new THREE.Vector3();
  let crossed = false;
  for (let i = 0; i < 60 * (w.warn * 2.5 + 2); i++) {
    let held = { x: 0, y: 0 };
    if (steer && i * dt >= WALL.reaction) {
      target.copy(w.center).addScaledVector(hole.dir, w.L + 30);
      held = pilot(p.f, p.q, target, p.pull, dt);
    }
    const hit = p.step(held);
    if (hit) return { out: hit.wall ? 'wall' : 'other', w };
    if (w.center.length() > w.L + WALL.depth + WALL.size[1] + 5) { crossed = true; break; }
  }
  return { out: crossed ? 'through' : 'circling', w, hole };
}
{
  // (wall exploders are left out here: they blow gaps and throw pieces, tested below)
  for (const t of [0, 60, 600]) {
    const N = 25;
    const idle = { wall: 0, through: 0, none: 0, other: 0, circling: 0, massive: 0 };
    const steer = { wall: 0, through: 0, none: 0, other: 0, circling: 0, massive: 0 };
    for (let i = 0; i < 40; i++) idle[wallRun(t, { steer: false, exploders: false }).out]++;  // straight on
    for (let i = 0; i < N; i++) steer[wallRun(t, { turning: i % 2 === 1, exploders: false }).out]++;
    const reached = idle.wall + idle.through;
    const placed = N - steer.none;
    check(idle.through <= Math.max(2, reached * 0.1) && reached >= 30,   // (measured 1–4 of 40 slip through a random gap)
      `${t / 60} min: flying straight on, you hit the wall (no hole on your path; the curtain is ~98% solid)`,
      `${idle.wall} hit it, ${idle.through} slipped through a gap, ${idle.none}/40 not placed at once (it retries)`);
    check(steer.through >= placed * 0.95 && placed >= N * 0.75,
      `${t / 60} min: every hole is made by a pilot steering ${WALL.reaction} s after the wall appears (straight and turning)`,
      `${steer.through}/${placed} through, ${steer.wall} hit the wall, ${steer.circling} circling, ${steer.none} not placed at once`);
  }
}
{
  // combos: a wall next to a massive meteor. A massive meteor comes as in a run (far ahead, near your path, with
  // its swarm and escape sheet); you fly on, holding away from its pull, and the wall is asked for every 0.25 s
  // until one passes its checks (with the pull). Then the pilot steers for its hole and, once through, holds away
  // until the pull lets go.
  const comboRun = () => {
    const k = knobs(600);
    const p = stage({ speed: k.speed, t: 600, walls: true });
    p.field.testOnly = false;
    const m = p.field.spawnMassive(p.fwd, {});
    m.pull = k.pull;
    const away = () => {
      const g = Math.hypot(p.pull.gx, p.pull.gy);
      return p.pull.strength > 0.02 && g > 1e-6 ? p.circleTo(-p.pull.gx / g, -p.pull.gy / g) : p.circleTo(0, 0);
    };
    let w = null;
    let hole = null;
    const target = new THREE.Vector3();
    let since = 0;
    for (let i = 0; i < 60 * 16; i++) {
      if (!w && i % 15 === 0 && m.p.length() < 330) {
        w = p.wall({ combo: true });
        if (w && !w.combo) w = null;   // (only walls next to it count here)
        if (w) hole = w.holes[0];
      }
      let held = away();
      if (w) {
        since += dt;
        const through = w.center.length() > w.L + WALL.depth + WALL.size[1] + 5;
        if (!through && since >= WALL.reaction) held = pilot(p.f, p.q, target.copy(w.center).addScaledVector(hole.dir, w.L + 30), p.pull, dt);
        if (through && !p.field.rocks.includes(m) && m.p.dot(p.fwd) < 0) return 'out';
      }
      const hit = p.step(held);
      if (hit) return w ? (hit === m ? 'massive' : hit.wall ? 'wall' : hit.noGrav ? 'sheet' : hit.host === m ? 'swarm' : 'other') : 'before';
    }
    return w ? 'out' : 'none';
  };
  const res = { out: 0, wall: 0, massive: 0, sheet: 0, swarm: 0, other: 0, before: 0, none: 0 };
  for (let i = 0; i < 40; i++) res[comboRun()]++;
  const placed = 40 - res.none - res.before;
  check(placed >= 16 && res.out >= placed * 0.75,   // (measured 77–100% over runs; misses are swarm, sheet rocks and pieces the pilot doesn't dodge)
    'a wall next to a massive meteor (holes away from it): you can make its hole against the pull and get away',
    `${res.out}/${placed} through and away; hit wall ${res.wall}, massive ${res.massive}, its escape sheet ${res.sheet}, swarm ${res.swarm}, other ${res.other}; ${res.none} times no combo wall, ${res.before} hit before`);
  const p = stage({ speed: knobs(600).speed, t: 600, walls: true });
  let w = null;
  for (let i = 0; i < 5 && !w; i++) w = p.wall();
  const ex = w.rocks.filter((r) => r && r.type === 'exploder');
  const nearHole = ex.filter((r) => w.holes.some((h) => r.p.clone().sub(w.center).angleTo(h.dir) * w.L < h.r * 2.1));
  let lit = 0;
  let boomAt = null;
  for (let i = 0; i < 60 * 2.5 && boomAt === null; i++) {
    p.step();
    lit = Math.max(lit, w.rocks.filter((r) => r && r.type === 'exploder' && r.fuse >= 0).length);
    if (p.field.events.length) boomAt = (i + 1) * dt;
  }
  check(ex.length > 3 && nearHole.length === 0 && lit > 0 && boomAt !== null && w.warn - boomAt > 1,
    'late walls hold exploders (never beside a hole); near your path they light as the wall appears and blow up >1 s before you get there',
    `${ex.length} exploders in view of ${w.alive} rocks, ${lit} lit, first boom ${boomAt?.toFixed(2)} s after it appeared, ${(w.warn - boomAt).toFixed(2)} s before the wall`);
}
{
  // the calm: the inflow thins around the moment you reach a wall
  const p = stage({ walls: true });
  p.walls.planned = [20];
  const R = WORLD.radius - WORLD.fadeBand / 2;
  const at = (arrive) => p.walls.calmAt(arrive - R / 40, 40);   // inflow that reaches you at `arrive`
  check(at(10) === 1 && at(19.7) < 0.5 && at(21) < 0.5 && at(25) === 1 && at(17.5) > 0.95,
    'the field thins just before and after each wall (a clear approach, a short calm)',
    `density ×${at(17.5).toFixed(2)} 2.5 s before, ×${at(19.7).toFixed(2)} at it, ×${at(21).toFixed(2)} 1 s after, ×${at(25).toFixed(2)} 5 s after`);
}

console.log('near misses');
{
  const miss = (side) => {
    const p = stage();
    p.field.testOnly = false;
    p.field.place(p.fwd, { type: 'rock', dist: 60, s: 4, side: (Math.atan((side + 4 * 0.85) / 60) * 180) / Math.PI, test: true });
    let events = 0;
    let hit = false;
    for (let i = 0; i < 120; i++) {
      if (p.step()) hit = true;
      events += p.field.misses.length;
    }
    return { events, hit };
  };
  const close = miss(2.5);
  const far = miss(15);
  check(close.events === 1 && !close.hit && far.events === 0, 'a rock passing within a few metres is one near miss; far ones are none',
    `2.5 m: ${close.events} event(s), 15 m: ${far.events}`);
}

// ---- Contoo 4: performance

console.log('adaptive quality');
{
  const { Quality } = await game('quality.js');
  // made-up devices: frame time as a function of the pixel ratio
  const fly = (q, frameAt, seconds = 30) => {
    for (let t = 0; t < seconds;) {
      const dt = frameAt(q.pixelRatio);
      q.update(dt);
      t += dt;
    }
    return q;
  };
  const vsync = (ms) => Math.ceil(ms / 16.667 - 1e-9) * (1 / 60);      // a 60 Hz screen
  const gpu = fly(new Quality(1.5), (pr) => vsync(9 + 9 * pr * pr));  // drawing-bound: 29 ms at 1.5
  const fast = fly(new Quality(2), () => 1 / 60);
  const capped = fly(new Quality(1.5), () => 1 / 30);                  // a 30 fps power-saving cap
  const cpu = fly(new Quality(1.5), (pr) => vsync(24 + pr));            // the CPU is the limit
  check(gpu.pixelRatio < 1.5 && gpu.pixelRatio >= 0.75 && fast.pixelRatio === 2 && fast.state === 'watch',
    'slow drawing: the resolution steps down until frames are fast; fast devices keep it',
    `drawing-bound phone 1.5 -> ${gpu.pixelRatio} (levels ${gpu.levels.join(', ')}), fast PC stays at ${fast.pixelRatio}`);
  check(capped.pixelRatio === 1.5 && capped.state === 'done' && cpu.pixelRatio === 1.5 && cpu.state === 'done',
    'a step that buys no speed (a 30 fps cap, a CPU limit) is undone and adapting stops',
    `capped ${capped.pixelRatio} (${capped.state}), CPU-bound ${cpu.pixelRatio} (${cpu.state})`);
}

console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
