#!/usr/bin/env node
// Fast checks of the game logic in Node, no browser (Contoo 1): the flight model, the difficulty curve and the
// meteor field (even density at every distance flying straight and turning, nothing pops into view, nothing
// comes from behind, the density gives the planned seconds between rocks in your path).
// Contoo 2: meteor types and colours, the tell, fuses (where they light and blow up), explosion pieces (aimed,
// dodgeable, pulled by gravity), orbits, the massive meteor's pull (drift slowly at the edge, hold against it
// halfway in, do nothing and you hit it) and the escape sheet (clear holes; steering through one gets you out).
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
const { WORLD, FLIGHT, EXPLODER, EXPLOSION, GRAVITY } = await game('config.js');
const { playerRange, circularSpeed } = await game('gravity.js');

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
      // a new rock in view must appear at the far edge, faded out
      if (field.visible(r, frustum) && (r.fade > 0 || r.p.length() < R - WORLD.fadeBand - 1)) pops++;
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
  check(seen > 8 * 0.83 && seen < 8 * 1.2, 'flying straight, a rock is in your path about every pathGap seconds',
    `one per ${seen.toFixed(2)} s for a planned 8 s (${r.hitCount} rocks)`);
}

// ---- Contoo 2: danger

// An empty stage (no field rocks, no automatic massive meteors) and a pilot that flies like main.js: the flight
// model, the pull of massive meteors (extra turn and drift) and the field update.
function stage({ speed = 40, aspect = 16 / 9 } = {}) {
  const field = new MeteorField(new THREE.Scene(), { small: manifest.meteors.small.map(shape),
    big: manifest.meteors.big.map(shape), fragments: manifest.meteors.fragments.map(shape) });
  const cam = new THREE.PerspectiveCamera(60, aspect, 0.3, 1400);
  field.setView(cam);
  field.densityScale = 0;
  field.autoMassive = false;
  field.setDensity(speed, 8);
  const p = { field, f: createFlight(), q: new THREE.Quaternion(), fwd: new THREE.Vector3(0, 0, -1),
              frustum: new THREE.Frustum(), drift: new THREE.Vector3(), pull: { gx: 0, gy: 0, strength: 0 }, speed };
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
    return field.update(dt, { fwd: p.fwd, frustum: p.frustum, move, speed: p.speed });
  };
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
  check(still / N > 0.25 && dodged / N < 0.12 && dodged < still / 2,
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
  check(bound.length > 3 && kept.length >= bound.length * 0.9, 'a massive meteor\'s swarm keeps circling it',
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

console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
