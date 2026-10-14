#!/usr/bin/env node
// Fairness and don'ts audit (Contoo 4, PHASES "Fairness audit", "Don'ts audit"): is every death the player's own
// mistake, and does every don't hold?
//   1. collision: every rock's collision spheres (manifest) against its real meshes (PC and mobile GLBs): a sphere
//      poking out of the rock would kill you in empty space
//   2. walls over the whole difficulty range (0 s ... 20 min): placed, never a hole on your path, every hole made by
//      a pilot that reacts late (straight and turning)
//   3. escape gaps over the whole range: steering through a massive meteor's escape hole gets you out
//   4. whole runs flown by bots (the real field, walls, massive meteors, exploders): for every death, how long the
//      rock that hit you had been in view and out of the fog before it hit. A rock you could not see coming is the
//      game's fault, not yours.
//   5. the don'ts (DESIGN §13) in whole runs: nothing pops into or out of view, nothing behind you, a rock never
//      changes once it is there, no difficulty jumps
// Usage: node tools/audit.mjs [--quick] [--only collision|walls|escape|bots|donts] [--runs N] [--seed S] [--bot name]
import fs from 'node:fs';
import path from 'node:path';
import { THREE, mod, manifest, ROOT, game, fogVisibility, seedRandom } from './sim.mjs';

const { FLIGHT, WALL, WORLD, GRAVITY } = mod.config;
const { knobs } = mod.difficulty;
const { pilot, circleTo } = mod.walls;
const DEG = Math.PI / 180;
const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const RUNS = args.includes('--runs') ? Number(args[args.indexOf('--runs') + 1]) : QUICK ? 6 : 24;
const SEED = args.includes('--seed') ? Number(args[args.indexOf('--seed') + 1]) : 4;
const dt = 1 / 60;
let failures = 0;
function check(ok, what, detail = '') {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${what}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
const pct = (a, b) => `${b ? Math.round((100 * a) / b) : 0}%`;
const want = (name) => !ONLY || ONLY === name;
seedRandom(SEED);

// ---- 1. collision spheres against the meshes

// Positions and triangles of the first mesh primitive in a GLB (float positions, 16/32-bit indices, no node
// transforms: what tools/blender_meteors.py exports).
function readGlb(file) {
  const b = fs.readFileSync(file);
  const jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString('utf8'));
  const bin = b.subarray(20 + jsonLen + 8);
  const prim = json.meshes[0].primitives[0];
  const view = (acc) => {
    const a = json.accessors[acc];
    const v = json.bufferViews[a.bufferView];
    return { a, off: (v.byteOffset ?? 0) + (a.byteOffset ?? 0) };
  };
  const { a: pa, off: po } = view(prim.attributes.POSITION);
  const pos = new Float32Array(pa.count * 3);
  for (let i = 0; i < pa.count * 3; i++) pos[i] = bin.readFloatLE(po + i * 4);
  const { a: ia, off: io } = view(prim.indices);
  const idx = new Uint32Array(ia.count);
  for (let i = 0; i < ia.count; i++) idx[i] = ia.componentType === 5125 ? bin.readUInt32LE(io + i * 4) : bin.readUInt16LE(io + i * 2);
  return { pos, idx };
}

// Closest distance from p to the mesh, and whether p is inside (ray parity along 3 directions, majority vote).
const _t = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), q: new THREE.Vector3() };
const tri = new THREE.Triangle();
const ray = new THREE.Ray();
function meshDistance(mesh, p) {
  const { pos, idx } = mesh;
  let best = Infinity;
  const dirs = [new THREE.Vector3(0.31, 0.83, 0.46).normalize(), new THREE.Vector3(-0.7, 0.1, 0.7).normalize(),
                new THREE.Vector3(0.2, -0.9, -0.38).normalize()];
  const crossings = [0, 0, 0];
  for (let i = 0; i < idx.length; i += 3) {
    _t.a.fromArray(pos, idx[i] * 3);
    _t.b.fromArray(pos, idx[i + 1] * 3);
    _t.c.fromArray(pos, idx[i + 2] * 3);
    tri.set(_t.a, _t.b, _t.c);
    tri.closestPointToPoint(p, _t.q);
    best = Math.min(best, _t.q.distanceTo(p));
    for (let k = 0; k < 3; k++) {
      ray.set(p, dirs[k]);
      if (ray.intersectTriangle(_t.a, _t.b, _t.c, false, _t.q)) crossings[k]++;
    }
  }
  const inside = crossings.filter((c) => c % 2 === 1).length >= 2;
  return { dist: best, inside };
}

if (want('collision')) {
  console.log('collision spheres against the meshes (PC and mobile)');
  const groups = [['small', WORLD.small.radius[1]], ['big', GRAVITY.massive.radius[1]], ['fragments', 8]];
  const worst = { pc: { out: -Infinity, id: '' }, mobile: { out: -Infinity, id: '' } };
  const lines = [];
  for (const [group, maxSize] of groups) {
    for (const e of manifest.meteors[group]) {
      const row = [e.id];
      for (const set of ['pc', 'mobile']) {
        const mesh = readGlb(path.join(ROOT, 'assets', e[set]));
        // glTF axes, the same as the spheres
        let out = -Infinity;
        for (const [x, y, z, r] of e.collisionSpheres) {
          const { dist, inside } = meshDistance(mesh, new THREE.Vector3(x, y, z));
          out = Math.max(out, inside ? r - dist : r + dist);   // > 0: the sphere pokes out of the rock by that much
        }
        const metres = out * maxSize;
        row.push(`${set} ${out > 0 ? '+' : ''}${out.toFixed(3)} (${metres > 0 ? '+' : ''}${metres.toFixed(2)} m at ${maxSize} m)`);
        if (metres > worst[set].out) worst[set] = { out: metres, id: e.id };
      }
      lines.push(row.join('  '));
    }
  }
  if (!QUICK) for (const l of lines) console.log(`       ${l}`);
  check(worst.pc.out < 0.6 && worst.mobile.out < 0.6,
    'no collision sphere pokes out of its rock by more than the player\'s radius (largest size of each kind)',
    `worst: PC ${worst.pc.id || '-'} ${worst.pc.out.toFixed(2)} m, mobile ${worst.mobile.id || '-'} ${worst.mobile.out.toFixed(2)} m`);
}

// ---- 2. walls over the whole difficulty range (an empty field and the real wall code, as in test_world.mjs)

// An empty stage at run time t: no field rocks, no automatic massive meteors, walls on demand.
function stage(t) {
  const g = game();
  g.start();
  const { field } = g;
  field.clear();
  field.densityScale = 0;
  field.autoMassive = false;
  g.walls.auto = false;
  g.runTime = t;
  const step0 = g.step;
  // keep the difficulty at t (the wall test is about one wall)
  g.step = (held) => {
    const r = g.runTime;
    const hit = step0(held);
    g.runTime = r;
    return hit;
  };
  g.k = knobs(t);
  g.speed = g.k.speed;
  field.setDifficulty(g.k);
  field.testOnly = false;
  g.wall = (opts = {}) => g.walls.spawn({ runTime: g.runTime, k: g.noWallExploders ? { ...g.k, wallExploders: 0 } : g.k,
                                          speed: g.speed, q: g.q, flight: g.f,
                                          drift: g.drift, fwd: g.fwd, frustum: g.frustum }, opts);
  return g;
}

function wallRun(t, { turning = false, steer = true } = {}) {
  const g = stage(t);
  g.noWallExploders = true;   // (an exploder blows its own gap)
  if (turning) {
    g.f.cx = (Math.random() * 2 - 1) * 0.4;
    g.f.cy = (Math.random() * 2 - 1) * 0.4;
    g.f.wx = (Math.random() * 2 - 1) * 40;
    g.f.wy = (Math.random() * 2 - 1) * 40;
  }
  let w = null;
  let waited = 0;
  // as in a run: ask again every 0.25 s while flying on (up to WALL.giveUp)
  while (!w && waited <= WALL.giveUp) {
    w = g.wall();
    if (!w) for (let i = 0; i < 15; i++, waited += dt) g.step();
  }
  if (!w) return { out: 'none' };
  const hole = w.holes[Math.floor(Math.random() * w.holes.length)];
  const target = new THREE.Vector3();
  for (let i = 0; i < 60 * (w.warn * 2.5 + 2); i++) {
    let held = { x: 0, y: 0 };
    if (steer && i * dt >= WALL.reaction) {
      target.copy(w.center).addScaledVector(hole.dir, w.L + 30);
      held = pilot(g.f, g.q, target, g.pull, dt);
    }
    const hit = g.step(held);
    if (hit) return { out: hit.wall ? 'wall' : 'other', w, waited };
    if (w.center.length() > w.L + WALL.depth + WALL.size[1] + 5) return { out: 'through', w, waited };
  }
  return { out: 'circling', w, waited };
}

if (want('walls')) {
  console.log('walls over the whole difficulty range');
  const times = QUICK ? [0, 60, 600] : [0, 15, 30, 45, 60, 90, 120, 180, 300, 600, 900, 1200];
  const N = QUICK ? 12 : 30;
  let allOk = true;
  for (const t of times) {
    const idle = { wall: 0, through: 0, none: 0, other: 0, circling: 0 };
    const steer = { wall: 0, through: 0, none: 0, other: 0, circling: 0 };
    let late = 0;
    for (let i = 0; i < N; i++) idle[wallRun(t, { steer: false, turning: i % 2 === 1 }).out]++;
    for (let i = 0; i < N; i++) {
      const r = wallRun(t, { turning: i % 2 === 1 });
      steer[r.out]++;
      if (r.waited > 0.01) late++;
    }
    const placed = N - steer.none;
    const ok = steer.through >= placed * 0.95 && placed >= N * 0.85 && idle.through <= Math.max(1, N * 0.08);
    if (!ok) allOk = false;
    console.log(`  ${ok ? 'ok ' : 'BAD'}  ${String(t).padStart(4)} s  ${knobs(t).speed.toFixed(0)} m/s warn ${knobs(t).wallWarn.toFixed(1)} s:`
      + ` pilot through ${steer.through}/${placed} (wall ${steer.wall}, circling ${steer.circling}), placed ${placed}/${N} (${late} after a wait),`
      + ` flying on: ${idle.through} slipped through a gap of ${N - idle.none}`);
  }
  check(allOk, 'every wall over 0 s ... 20 min: placed, no hole on your path, every hole made by a late-reacting pilot');
}

// ---- 3. escape gaps over the whole range

function escapeRun(t) {
  const g = stage(t);
  const m = g.field.spawnMassive(g.fwd, { s: 16 + Math.random() * 14 });
  m.pull = g.k.pull;
  const hole = m.holes[0];
  const target = new THREE.Vector3();
  const l = new THREE.Vector3();
  const qi = new THREE.Quaternion();
  for (let i = 0; i < 60 * 14; i++) {
    let held = { x: 0, y: 0 };
    if (g.field.rocks.includes(m)) {
      target.copy(m.p).add(hole.offset).addScaledVector(hole.axis, 30);
      if (target.dot(g.fwd) > 5) {
        l.copy(target).applyQuaternion(qi.copy(g.q).invert());
        const ex = Math.atan2(l.x, -l.z) / DEG;
        const ey = Math.atan2(l.y, -l.z) / DEG;
        const wx = 2.2 * ex - 0.35 * g.f.wx - g.pull.gx;
        const wy = 2.2 * ey - 0.35 * g.f.wy - g.pull.gy;
        const w = Math.hypot(wx, wy);
        held = w < 10 ? circleTo(g.f, 0, 0, dt) : circleTo(g.f, (0.5 * wx) / w, (0.5 * wy) / w, dt);
      } else if (g.pull.strength > 0.02) {
        const w = Math.hypot(g.pull.gx, g.pull.gy);
        held = circleTo(g.f, -g.pull.gx / w, -g.pull.gy / w, dt);
      } else {
        held = circleTo(g.f, 0, 0, dt);
      }
    }
    const hit = g.step(held);
    if (hit) return hit === m ? 'massive' : hit.host === m ? 'swarm' : 'sheet';
    if (!g.field.rocks.includes(m) && m.p.dot(g.fwd) < 0) break;
  }
  return 'free';
}

if (want('escape')) {
  console.log('escape gaps over the whole difficulty range');
  const times = QUICK ? [20, 600] : [20, 45, 60, 120, 300, 600, 1200];
  const N = QUICK ? 12 : 30;
  let allOk = true;
  for (const t of times) {
    const res = { massive: 0, swarm: 0, sheet: 0, free: 0 };
    for (let i = 0; i < N; i++) res[escapeRun(t)]++;
    const ok = res.free >= N * 0.9;
    if (!ok) allOk = false;
    console.log(`  ${ok ? 'ok ' : 'BAD'}  ${String(t).padStart(4)} s  ${knobs(t).speed.toFixed(0)} m/s pull ×${knobs(t).pull.toFixed(2)}:`
      + ` out ${res.free}/${N}; hit massive ${res.massive}, swarm ${res.swarm}, sheet ${res.sheet}`);
  }
  check(allOk, 'steering through an escape hole gets you out over 20 s ... 20 min (≥ 90%)');
}

// ---- 4. whole runs flown by bots: was every rock that killed you in sight long enough?

// "Seen": its bounding sphere is in view, it has faded in and at least `SEEN_VIS` of it shows through the fog.
const SEEN_VIS = 0.2;
// Time a player needs to see a rock coming to dodge it: ~0.3 s to react plus ~0.7 s for the heavy controls to
// move a 6 m rock dead ahead out of the way (flight model: ~16 t³ m sideways at 40 m/s from straight flight).
const NEED = 1.0;

const _p = new THREE.Vector3();
const _u = new THREE.Vector3();
const _V = new THREE.Vector3();
const _sph = new THREE.Sphere();
const _qi = new THREE.Quaternion();

// Bots. Each returns the held direction for this frame (screen axes). They only react to rocks they have seen for
// `react` seconds (a person's reaction time).
const bots = {
  // flies straight on: dies at the first rock in its path (the base case)
  straight: () => ({ x: 0, y: 0 }),
  // a nervous player: random holds in random directions, often turning hard (explores turns and turn fills)
  nervous: (g, s) => {
    s.until ??= 0;
    if (g.runTime >= s.until) {
      const hold = Math.random() < 0.65;
      const a = Math.random() * 2 * Math.PI;
      s.dir = hold ? { x: Math.cos(a), y: Math.sin(a) } : null;
      s.back = !hold;
      s.until = g.runTime + (hold ? 0.1 + Math.random() * 0.5 : 0.3 + Math.random() * 1.5);
    }
    if (s.dir) return s.dir;
    return s.back ? circleTo(g.f, 0, 0, dt) : { x: 0, y: 0 };
  },
  // a careful player: steers through wall holes and escape holes, dodges the first rock it sees coming
  dodger: (g, s, seen) => {
    const react = 0.3;
    _qi.copy(g.q).invert();
    // walls: the hole nearest to where it is heading, once it has seen the wall for a moment
    for (const w of g.walls.active) {
      if (!w.open || w.age < 0.6) continue;
      const d = w.center.length();
      if (d > w.L + WALL.depth + WALL.size[1]) continue;  // through it
      let best = null;
      for (const h of w.holes) {
        _p.copy(w.center).addScaledVector(h.dir, w.L + 30);
        const ang = _p.angleTo(g.fwd);
        if (!best || ang < best.ang) best = { ang, target: _p.clone() };
      }
      // a rock about to hit it first still gets dodged
      const threat = threatOf(g, seen, react, 0.9, true);   // (the pilot handles the wall's own rocks)
      s.mode = threat ? 'dodge at wall' : 'wall';
      s.wallAge = w.age;
      s.wallWarn = w.warn;
      if (threat) { s.lastDodge = g.runTime; return dodge(g, threat); }
      return pilot(g.f, g.q, best.target, g.pull, dt);
    }
    const threat = threatOf(g, seen, react, 2.5);
    s.mode = threat ? 'dodge' : 'cruise';
    if (threat) { s.lastDodge = g.runTime; return dodge(g, threat); }
    // a massive meteor pulling: aim for its escape hole, then hold away until it lets go
    if (g.pull.strength > 0.02) {
      const m = g.field.massives.find((x) => x.holes?.length);
      if (m) {
        _p.copy(m.p).add(m.holes[0].offset).addScaledVector(m.holes[0].axis, 30);
        if (_p.dot(g.fwd) > 5) return pilot(g.f, g.q, _p, g.pull, dt);
      }
      const w = Math.hypot(g.pull.gx, g.pull.gy);
      return circleTo(g.f, -g.pull.gx / w, -g.pull.gy / w, dt);
    }
    return circleTo(g.f, 0, 0, dt);
  },
};

// The seen rock whose path comes closest soonest (within `horizon` s), or null.
function threatOf(g, seen, react, horizon, skipWall = false) {
  _V.copy(g.fwd).multiplyScalar(g.speed).add(g.drift);
  let best = null;
  for (const r of g.field.rocks) {
    if (skipWall && r.wall) continue;
    const s = seen.get(r);
    if (!s || s.gen !== r.gen || s.end === null || g.runTime - s.end > 0.25 || g.runTime - s.start < react) continue;
    _u.copy(r.v).sub(_V);
    const uu = _u.lengthSq();
    const tc = -r.p.dot(_u) / Math.max(uu, 1e-6);
    if (tc <= 0 || tc > horizon) continue;
    _p.copy(r.p).addScaledVector(_u, tc);
    const reach = r.s * r.shape.reach + FLIGHT.playerRadius + 2.5;
    if (_p.length() < reach && (!best || tc < best.tc)) best = { r, tc, off: _p.clone() };
  }
  return best;
}

// Steer away from where the threat will pass (screen axes); dead centre: away from where it is now.
function dodge(g, threat) {
  const l = threat.off.clone().applyQuaternion(_qi);
  if (Math.hypot(l.x, l.y) < 0.5) l.copy(threat.r.p).applyQuaternion(_qi);
  const n = Math.hypot(l.x, l.y) || 1;
  return circleTo(g.f, (-0.9 * l.x) / n, (-0.9 * l.y) / n, dt);
}

function kindOf(r) {
  if (r.wall) return r.type === 'exploder' ? 'wall exploder' : 'wall';
  if (r.type === 'frag') return r.aimed ? 'piece (aimed)' : 'piece';
  if (r.type === 'massive') return 'massive';
  if (r.host?.type === 'massive') return 'swarm';
  if (r.host?.type === 'big') return 'moon';
  if (r.noGrav) return 'escape sheet';
  return `${r.type} (${r.src ?? 'start'})`;
}

// One run flown by a bot, as main.js plays it. Tracks sightings (rock -> its latest one: a gap of more than 0.25 s
// starts a new one) and where rocks come from. opts: aspect, maxT, t0 (start at this run time: the difficulty and
// a field filled at its density), immortal (nothing hits), onFrame(g) after every frame. Returns { g, hit, sighting }.
function flyRun(bot, { aspect = 16 / 9, maxT = 360, t0 = 0, immortal = false, onFrame = null, wrap = null } = {}) {
  const g = game({ aspect });
  // tag where field rocks come from (inflow through the far cap, turn fill, the start)
  const spawn = g.field.spawn.bind(g.field);
  g.field.spawn = (dir, d, fade, fwd, opts) => {
    const r = spawn(dir, d, fade, fwd, opts);
    if (r) r.src = opts.inflow ? 'inflow' : opts.frustum ? 'turn fill' : 'start';
    return r;
  };
  const makeRock = g.field.makeRock.bind(g.field);
  g.field.makeRock = (...a) => {
    const r = makeRock(...a);
    r.src = null;
    return r;
  };
  g.start();
  if (t0) {
    g.runTime = t0;
    g.k = knobs(t0);
    g.speed = g.k.speed;
    g.field.setDifficulty(g.k);
    g.field.reset(g.fwd, g.frustum, { speed: g.speed });
    g.walls.reset();
    g.walls.begin(g.k, t0);
    g.field.begin();
  }
  g.field.testOnly = immortal;
  wrap?.(g);
  const seen = new Map();
  const sighting = (r) => {
    let s = seen.get(r);
    if (!s || s.gen !== r.gen) {
      s = { gen: r.gen, start: null, end: null, dStart: 0, parent: null, first: null, dFirst: 0 };
      seen.set(r, s);
    }
    return s;
  };
  // explosion pieces: the warning is the exploder's (its glowing cracks and quickening pulse); remember it
  const explode = g.field.explode.bind(g.field);
  g.field.explode = (r, ...a) => {
    const parent = { ...sighting(r) };
    const n = g.field.rocks.length;
    explode(r, ...a);
    for (const x of g.field.rocks.slice(n)) sighting(x).parent = parent;
  };
  const state = {};
  let hit = null;
  while (!hit && g.runTime < t0 + maxT) {
    // who is in sight this frame
    for (const r of g.field.rocks) {
      const s = sighting(r);
      const d = r.p.length();
      _sph.center.copy(r.p);
      _sph.radius = r.s;
      const vis = r.fade * fogVisibility(d - r.s);
      if (vis >= SEEN_VIS && g.frustum.intersectsSphere(_sph)) {
        if (s.end === null || g.runTime - s.end > 0.25) { s.start = g.runTime; s.dStart = d; }
        if (s.first === null) { s.first = g.runTime; s.dFirst = d; }
        s.end = g.runTime;
      }
    }
    hit = g.step(bot(g, state, seen));
    onFrame?.(g);
  }
  return { g, hit, sighting, state };
}

if (want('bots')) {
  console.log(`whole runs flown by bots (${RUNS} runs each, up to ${QUICK ? 3 : 6} min)`);
  const maxT = QUICK ? 180 : 360;
  const deaths = [];
  const t0 = Date.now();
  const BOT = args.includes('--bot') ? args[args.indexOf('--bot') + 1] : null;
  for (const [name, bot] of Object.entries(bots)) {
    if (BOT && name !== BOT) continue;
    for (let run = 0; run < RUNS; run++) {
      const portrait = run % 3 === 2;
      const { g, hit, sighting, state } = flyRun(bot, { aspect: portrait ? 9 / 19.5 : 16 / 9, maxT });
      if (!hit) {
        deaths.push({ bot: name, t: g.runTime, survived: true });
        continue;
      }
      const s = sighting(hit);
      let from = s.start ?? Infinity;
      let dFrom = s.dStart;
      if (s.parent?.start != null && s.parent.start < from) { from = s.parent.start; dFrom = s.parent.dStart; }
      // a massive meteor you have seen once stays with you (its pull, the rumble, the lean, the dark edge on its side)
      if (hit.type === 'massive' && s.first !== null) { from = s.first; dFrom = s.dFirst; }
      deaths.push({
        bot: name, t: g.runTime, kind: kindOf(hit), portrait,
        warned: Number.isFinite(from) ? g.runTime - from : 0,   // since its latest sighting began
        gap: s.end !== null ? g.runTime - s.end : Infinity,     // out of sight this long before the hit
        dFirst: dFrom, speed: g.speed, size: hit.s, mode: state.mode, wallAge: state.wallAge, wallWarn: state.wallWarn,
        dodged: state.lastDodge != null ? g.runTime - state.lastDodge : null,
      });
    }
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  for (const name of Object.keys(bots)) {
    const list = deaths.filter((d) => d.bot === name);
    if (!list.length) continue;
    const times = list.map((d) => d.t).sort((a, b) => a - b);
    const kinds = {};
    for (const d of list) if (!d.survived) kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
    console.log(`  ${name.padEnd(8)} median ${times[Math.floor(times.length / 2)].toFixed(0)} s (${times[0].toFixed(0)}–${times[times.length - 1].toFixed(0)} s),`
      + ` ${list.filter((d) => d.survived).length} survived; killed by ${Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  }
  const dead = deaths.filter((d) => !d.survived);
  const short = dead.filter((d) => d.warned < NEED);
  for (const d of short) {
    console.log(`       short warning: ${d.bot} at ${d.t.toFixed(1)} s ${d.portrait ? '(portrait)' : ''} ${d.kind}, ${d.size.toFixed(1)} m,`
      + ` in sight ${d.warned.toFixed(2)} s before the hit (seen ${d.dFirst.toFixed(0)} m away at ${d.speed.toFixed(0)} m/s,`
      + ` out of sight ${d.gap.toFixed(2)} s before the hit)`);
  }
  if (process.env.AUDIT_VERBOSE) {
    for (const d of dead) {
      console.log(`       ${d.bot} ${d.t.toFixed(1)} s ${d.portrait ? 'P' : 'L'} ${d.kind} warned ${d.warned.toFixed(2)} s from ${d.dFirst.toFixed(0)} m`
        + `${d.mode ? ` mode ${d.mode}` : ''}${d.wallAge != null ? ` wall age ${d.wallAge.toFixed(2)}/${d.wallWarn.toFixed(2)}` : ''}`
        + `${d.dodged != null ? ` last dodge ${d.dodged.toFixed(2)} s ago` : ''}`);
    }
  }
  const warned = dead.map((d) => d.warned).sort((a, b) => a - b);
  console.log(`       warning before a death: median ${warned[Math.floor(warned.length / 2)]?.toFixed(2)} s, shortest ${warned[0]?.toFixed(2)} s (${secs} s of audit)`);
  // Nothing comes out of nowhere: every killer was in sight for at least MIN s (under that nobody can react and
  // steer). A careful player (looks ahead, dodges what it sees, steers for holes) almost only dies to rocks it saw
  // NEED s or more before. Turning blindly can meet a rock that was beside you just outside the view: rare.
  const MIN = 0.6;
  check(dead.every((d) => d.warned >= MIN), `nothing came out of nowhere: every killer was in sight at least ${MIN} s`,
    `shortest ${warned[0]?.toFixed(2)} s over ${dead.length} deaths`);
  const careful = dead.filter((d) => d.bot === 'dodger');
  const carefulShort = careful.filter((d) => d.warned < NEED);
  if (careful.length) {
    check(carefulShort.length <= careful.length * 0.05, `a careful player: at least 95% of deaths were in sight ${NEED} s or more`,
      `${carefulShort.length} of ${careful.length} had less`);
  }
  const blind = dead.filter((d) => d.bot !== 'dodger');
  if (blind.length) {
    const n = short.length - carefulShort.length;
    check(n <= blind.length * 0.03, `flying blind (straight on, or turning at random): at most 3% of deaths in sight under ${NEED} s`,
      `${n} of ${blind.length}`);
  }
}

// ---- 5. the don'ts (DESIGN §13) in whole runs: nobody dies here, so every part of a run comes up

if (want('donts')) {
  console.log("the don'ts in whole runs (nobody dies: walls, massive meteors, explosions all come up)");
  const V = 0.05;   // more than this much of a rock showing through the fog (times its fade-in) counts as visible
  const visibleNow = (g, r) => {
    _sph.center.copy(r.p);
    _sph.radius = r.s;
    return r.fade * fogVisibility(r.p.length() - r.s) > V && g.frustum.intersectsSphere(_sph);
  };
  const desc = (g, r) => `${kindOf(r)} ${r.s.toFixed(1)} m at ${r.p.length().toFixed(0)} m, ${g.runTime.toFixed(1)} s`;
  const st = { frames: 0, popIn: [], popOut: [], swallowed: 0, swallowedOut: 0, behind: [], changed: [], explosions: 0, walls: 0,
               massives: 0, combos: 0 };
  const runs = QUICK ? [['nervous', 0, 16 / 9, 60], ['dodger', 300, 9 / 19.5, 60]]
    : [['nervous', 0, 16 / 9, 150], ['dodger', 0, 9 / 19.5, 150], ['nervous', 240, 9 / 19.5, 150], ['dodger', 300, 16 / 9, 150]];
  for (const [name, t0, aspect, maxT] of runs) {
    const known = new Map();   // rock -> { gen, type, s, tint } as it was when it appeared
    const { g } = flyRun(bots[name], {
      aspect, t0, maxT, immortal: true,
      wrap: (g) => {
        // what leaves the field while you can see it: blown up (an event), swallowed by a massive meteor (inside it), or a pop
        const release = g.field.release.bind(g.field);
        g.field.release = (r, gone = false) => {
          if (!gone && visibleNow(g, r)) {
            if (r.absorbed) {
              st.swallowed++;
              const m = g.field.massives.reduce((a, b) => (!a || b.p.distanceTo(r.p) < a.p.distanceTo(r.p) ? b : a), null);
              if (m && m.p.distanceTo(r.p) + r.s * 0.5 > m.s) st.swallowedOut++;   // half of it still outside the massive one
            } else {
              st.popOut.push(desc(g, r));
            }
          }
          return release(r, gone);
        };
        for (const r of g.field.rocks) known.set(r, { gen: r.gen, type: r.type, s: r.s, tint: r.tint.getHex() });
      },
      onFrame: (g) => {
        st.frames++;
        for (const r of g.field.rocks) {
          const k = known.get(r);
          if (!k || k.gen !== r.gen) {
            // new this frame: never in plain sight (pieces fly out of an explosion you see)
            if (r.type !== 'frag' && visibleNow(g, r)) st.popIn.push(desc(g, r));
            known.set(r, { gen: r.gen, type: r.type, s: r.s, tint: r.tint.getHex() });
          } else if (k.type !== r.type || k.s !== r.s || k.tint !== r.tint.getHex()) {
            st.changed.push(desc(g, r));
            known.set(r, { gen: r.gen, type: r.type, s: r.s, tint: r.tint.getHex() });
          }
          // behind you and catching up (rocks you fly past drift backward; anything faster is dropped once behind)
          if (r.type !== 'massive' && r.p.dot(g.fwd) < 0
              && r.v.dot(g.fwd) - g.speed - g.drift.dot(g.fwd) > 0) st.behind.push(desc(g, r));
        }
      },
    });
    st.explosions += g.field.stats.explosions;
    st.walls += g.walls.stats.spawned;
    st.combos += g.walls.stats.combos;
    st.massives += g.field.rocks.filter((r) => r.type === 'massive').length;
  }
  const show = (list) => list.slice(0, 3).join('; ') + (list.length > 3 ? ` ... (${list.length})` : '');
  console.log(`       ${(st.frames / 60).toFixed(0)} s flown, ${st.walls} walls (${st.combos} next to a massive meteor), ${st.explosions} explosions`);
  check(st.popIn.length === 0, 'nothing pops into view (rocks come out of the murk, or out of view)', show(st.popIn) || 'none');
  check(st.popOut.length === 0 && st.swallowedOut <= Math.max(1, st.swallowed * 0.1),
    'nothing vanishes in view (only explosions, and rocks swallowed deep inside a massive meteor)',
    `${show(st.popOut) || 'no pops'}; ${st.swallowed} swallowed in view, ${st.swallowedOut} of them half outside`);
  check(st.behind.length === 0, 'nothing comes from behind (nothing behind you moves toward you)', show(st.behind) || 'none');
  check(st.changed.length === 0, 'a rock never changes once it is there (type, size, colour: difficulty reaches new rocks only)',
    show(st.changed) || 'none');
  // no visible difficulty jumps: every knob moves by a hair from one frame to the next, over 30 minutes
  let worst = { k: '', step: 0 };
  let prev = knobs(0);
  const span = {};
  for (const [key, v] of Object.entries(prev)) span[key] = Math.max(1e-9, Math.abs(knobs(1800)[key] - v));
  for (let t = dt; t <= 1800; t += dt) {
    const k = knobs(t);
    for (const key of Object.keys(k)) {
      const step = Math.abs(k[key] - prev[key]) / span[key];
      if (step > worst.step) worst = { k: key, step, t };
    }
    prev = k;
  }
  check(worst.step < 0.002, 'no visible difficulty jumps: no knob moves more than 0.2% of its range in a frame',
    `largest: ${worst.k} ${(worst.step * 100).toFixed(3)}% at ${worst.t?.toFixed(1)} s`);
}

console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
