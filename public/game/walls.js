// Walls (DESIGN §9, TECH "Walls"): a huge curtain of meteors across your path with one or two holes.
// - Shape: part of a sphere around where you are when it appears, of radius L = warning × speed, reaching
//   WALL.extent degrees round from your heading. So it stands at the same distance in every direction you could
//   turn to: you can't fly round it, you have to find a hole. Its rocks sit on an even net (a Fibonacci spiral on
//   the sphere, jittered); only the part inside the field's kept cone exists as rocks. Turning brings more of it
//   in, out of view, like the field's turn fill; parts that leave the cone are dropped and come back the same.
// - Warning: the wall appears at L and comes out of the murk in WALL.fadeSeconds, so you see it `warning` seconds
//   before you reach it (4 s early in a run, 2 s late).
// - Holes are never on the path you are on: flying on as you are (the circle left where it is) passes at least
//   WALL.missBy outside every hole. Every hole is made by a simulated pilot (the real flight model, the pull of
//   massive meteors, the rocks already in the way) that starts steering WALL.reaction seconds after the wall
//   appears. Layouts that fail are thrown away; if none passes, the wall waits a moment and tries again.
// - Rhythm: one every wallGap seconds (15 s -> 6 s); the field thins around each one (the inflow far ahead is
//   timed for when you reach the wall), so the approach reads clearly and a short calm follows.
// - Combos later in a run: exploders in the wall (they light as it appears and blow up >= ~1.25 s before you get
//   there), and walls next to a massive meteor (holes on the side away from it; the pilot fights its pull).
// Pure math with three.js vectors plus the field's rock API, so it runs in Node tests too.
import * as THREE from 'three';
import { WALL, WORLD, FLIGHT, GRAVITY, JOYSTICK } from './config.js';
import { stepFlight, stepJoystick, extremeConfig } from './flight.js';
import { playerPull, playerRange, inHole } from './gravity.js';
import { knobs } from './difficulty.js';

const DEG = Math.PI / 180;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const randIn = ([a, b]) => a + Math.random() * (b - a);
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _l = new THREE.Vector3();
const _qi = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _fa = new THREE.Vector3();
const _fb = new THREE.Vector3();

// Two unit vectors perpendicular to `axis` (and to each other).
function basis(axis, a, b) {
  a.set(Math.abs(axis.x) < 0.9 ? 1 : 0, Math.abs(axis.x) < 0.9 ? 0 : 1, 0).cross(axis).normalize();
  b.copy(axis).cross(a);
}

// A direction at angle `theta` (rad) from axis, azimuth phi around it.
export function dirAround(axis, theta, phi, out = new THREE.Vector3()) {
  basis(axis, _a, _b);
  const st = Math.sin(theta);
  return out.copy(axis).multiplyScalar(Math.cos(theta))
    .addScaledVector(_a, st * Math.cos(phi)).addScaledVector(_b, st * Math.sin(phi));
}

// ---- the simulated pilot (also used by the tests): aims the cross at `target` (a point, the player's frame)
// with the circle, like a player would: bang-bang with the circle kept near the cross, braking on the way in,
// allowing for the pull. Returns the held direction { x, y }.
export function circleTo(f, cx, cy, dt) {
  const dx = cx - f.cx;
  const dy = cy - f.cy;
  const l = Math.hypot(dx, dy);
  return l < dt / FLIGHT.circleSeconds ? { x: 0, y: 0 } : { x: dx / l, y: dy / l };
}

export function pilot(f, q, rel, pull, dt) {
  _l.copy(rel).applyQuaternion(_qi.copy(q).invert());
  const ex = Math.atan2(_l.x, -_l.z) / DEG;
  const ey = Math.atan2(_l.y, -_l.z) / DEG;
  const wx = 3 * ex - 0.45 * f.wx - pull.gx;
  const wy = 3 * ey - 0.45 * f.wy - pull.gy;
  const w = Math.hypot(wx, wy);
  return w < 6 ? circleTo(f, 0, 0, dt) : circleTo(f, (0.3 * wx) / w, (0.3 * wy) / w, dt);
}

// The joystick version (the default controls): the same aim, with the stick pushed as far as the wanted turn needs
// (through the stick's dead zone and curve). m = the sensitivity multiplier. Returns the stick { x, y }.
export function joystickPilot(f, q, rel, pull, m = 1) {
  _l.copy(rel).applyQuaternion(_qi.copy(q).invert());
  const ex = Math.atan2(_l.x, -_l.z) / DEG;
  const ey = Math.atan2(_l.y, -_l.z) / DEG;
  const wx = 3 * ex - 0.25 * f.wx - pull.gx;
  const wy = 3 * ey - 0.25 * f.wy - pull.gy;
  const w = Math.hypot(wx, wy);
  if (w < 1) return { x: 0, y: 0 };
  const top = JOYSTICK.maxTurnRate * m;
  const r = JOYSTICK.deadZone + (1 - JOYSTICK.deadZone) * Math.min(1, w / top) ** (1 / JOYSTICK.expo);
  return { x: (wx / w) * r, y: (wy / w) * r };
}

// The player's controls, as the planner needs them (owner's wish after Contoo 4: walls are planned with the scheme and
// sensitivity the player chose, so every hole can be made with them): how the ship flies one step, what "flying on
// as you are" holds (Extreme: the circle stays where it is; joystick: the stick held where it is) and how a player
// steers for a point.
const STILL = { x: 0, y: 0 };
export function controlsModel(kind = 'extreme', m = 1) {
  if (kind === 'joystick') {
    return { kind, m, step: (f, u, dt) => stepJoystick(f, u, dt, m), idle: (f0) => ({ x: f0.cx, y: f0.cy }),
             pilot: (f, q, rel, pull) => joystickPilot(f, q, rel, pull, m) };
  }
  const cfg = extremeConfig(m);
  return { kind, m, step: (f, u, dt) => stepFlight(f, u, dt, cfg), idle: () => STILL, pilot };
}
const EXTREME = controlsModel();

// Flies from the moment a wall appears (player at the origin, facing q, flight state f, drift) for as long as it
// takes to pass through the wall's shell (radius L around the origin). hole = the hole to steer through (null:
// fly on as you are). Returns { ok, through: [m inside each hole's edge, min over the shell], hitRock, end }.
// opts: speedAt(t), massives (proxies { p0, v, s, pull }), rocks (proxies { p0, v, r }: they only count in the
// last `rockSeconds` before the shell and inside it, where they would plug the hole; rocks earlier on the way are
// dodged like any rock), sheet (proxies that count all the way: a massive meteor's escape sheet, flown on through
// for `after` m past the wall), dt, until (stop after this long and return the heading in `end`), controls
// (controlsModel(), Extreme by default), record (keep the
// positions inside the shell in `path`: flying on as you are doesn't depend on the holes, so one flight serves every
// layout, see pathThrough).
export function flyThrough(start, wall, hole, opts) {
  const dt = opts.dt ?? 1 / 30;
  const f = { ...start.f };
  const q = start.q.clone();
  const P = new THREE.Vector3();
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  const drift = start.drift.clone();
  const driftT = new THREE.Vector3();
  const target = new THREE.Vector3();
  const rel = new THREE.Vector3();
  const ms = (opts.massives ?? []).map((m) => ({ ...m, p: m.p0.clone() }));
  const L = wall.L;
  const band = WALL.depth + WALL.size[1] + 2;
  const through = wall.holes.map(() => Infinity);
  const pr = FLIGHT.playerRadius;
  let pull = { gx: 0, gy: 0, strength: 0 };
  let inBand = false;
  const path = opts.record ? [] : null;
  if (hole) target.copy(hole.dir).multiplyScalar(L + 30);
  const tMax = opts.until ?? wall.warn * 2.5 + 2;
  const ctl = opts.controls ?? EXTREME;
  const still = ctl.idle(start.f);
  const rockFrom = L - band - opts.speedAt(0) * (opts.rockSeconds ?? 0.8);
  for (let t = 0; t < tMax; t += dt) {
    // massive meteors seen from where the player is now
    for (const m of ms) m.p.copy(m.p0).addScaledVector(m.v, t).sub(P);
    pull = ms.length ? playerPull(ms, fwd, q, driftT) : (driftT.set(0, 0, 0), pull);
    let held = still;
    if (hole && t >= WALL.reaction) held = ctl.pilot(f, q, rel.copy(target).sub(P), pull, dt);
    ctl.step(f, held, dt);
    drift.lerp(driftT, 1 - Math.exp(-dt / GRAVITY.player.driftSeconds));
    const ax = (f.wy + pull.gy) * DEG * dt;
    const ay = -(f.wx + pull.gx) * DEG * dt;
    const angle = Math.hypot(ax, ay);
    if (angle > 0) {
      q.multiply(_dq.setFromAxisAngle(_axis.set(ax / angle, ay / angle, 0), angle));
      q.normalize();
    }
    fwd.set(0, 0, -1).applyQuaternion(q);
    P.addScaledVector(fwd, opts.speedAt(t) * dt).addScaledVector(drift, dt);
    // rocks in the way (straight-line motion; their radius already includes yours and a margin)
    if (hole && opts.rocks && P.length() > rockFrom) {
      for (const r of opts.rocks) {
        _v.copy(r.p0).addScaledVector(r.v, t).sub(P);
        if (_v.lengthSq() < r.r * r.r) return { ok: false, through, hitRock: true };
      }
    }
    if (hole && opts.sheet) {
      for (const r of opts.sheet) {
        _v.copy(r.p0).addScaledVector(r.v, t).sub(P);
        if (_v.lengthSq() < r.r * r.r) return { ok: false, through, hitRock: true };
      }
    }
    // inside the shell: how far inside (or outside) each hole's edge
    const d = P.length();
    if (d > L - band && d < L + band) {
      inBand = true;
      path?.push(P.clone());
      for (let i = 0; i < wall.holes.length; i++) {
        const h = wall.holes[i];
        const along = P.dot(h.dir);
        const perp = along > 0 ? Math.sqrt(Math.max(0, d * d - along * along)) : Infinity;
        through[i] = Math.min(through[i], h.r - pr - perp);
      }
    } else if (inBand && d >= L + band + (opts.after ?? 0)) {
      break;
    }
  }
  const i = hole ? wall.holes.indexOf(hole) : -1;
  return { ok: inBand && (i < 0 || through[i] >= WALL.clearance), through: through.map((x) => (inBand ? x : -Infinity)),
           hitRock: false, end: { P, fwd }, path };
}

// flyThrough's `through` for these holes from a recorded path (m inside each hole's edge, min over the shell).
export function pathThrough(path, holes) {
  const pr = FLIGHT.playerRadius;
  return holes.map((h) => {
    if (!path.length) return -Infinity;
    let m = Infinity;
    for (const P of path) {
      const d = P.length();
      const along = P.dot(h.dir);
      const perp = along > 0 ? Math.sqrt(Math.max(0, d * d - along * along)) : Infinity;
      m = Math.min(m, h.r - pr - perp);
    }
    return m;
  });
}

// Everything the pilot needs to know about the moment a wall appears.
function snapshot({ q, flight, drift, speed, runTime }) {
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  return { q: q.clone(), fwd, f: { ...flight }, drift: drift.clone(), speed, runTime };
}

// The hole layout of one candidate: n holes around `axis` (your heading, or where you will be heading if you are
// turning), WALL.holeOffset off your heading now and at least holeApart apart (around it). escape: a preferred side
// (unit, perpendicular to fwd) for combos with a massive meteor.
function candidateHoles(fwd, axis, n, radius, escape) {
  const holes = [];
  const around = axis.angleTo(fwd) > 1 * DEG;
  basis(fwd, _fa, _fb);
  const azimuth = (d) => Math.atan2(d.dot(_fb), d.dot(_fa));   // around your heading now
  basis(axis, _a, _b);
  const escPhi = escape ? Math.atan2(escape.dot(_b), escape.dot(_a)) : null;
  for (let tries = 0; holes.length < n && tries < 40; tries++) {
    const off = (around ? Math.sqrt(Math.random()) * WALL.aheadSpread : randIn(WALL.holeOffset)) * DEG;
    const phi = escPhi === null ? Math.random() * Math.PI * 2 : escPhi + (Math.random() * 2 - 1) * 55 * DEG;
    const dir = dirAround(axis, off, phi);
    const fromNow = dir.angleTo(fwd) / DEG;
    if (fromNow < WALL.holeOffset[0] || fromNow > WALL.holeMax) continue;
    const az = azimuth(dir);
    if (holes.some((h) => Math.abs(Math.atan2(Math.sin(h.az - az), Math.cos(h.az - az))) < WALL.holeApart * DEG)) continue;
    holes.push({ dir, r: radius, phi, az, off: fromNow });
  }
  return holes;
}

export class Walls {
  // field: the MeteorField the wall rocks live in.
  constructor(field) {
    this.field = field;
    field.walls = this;
    this.controls = EXTREME;   // the player's controls (main.js: controlsModel(scheme, sensitivity))
    this.active = [];
    this.reset();
  }

  reset() {
    for (const w of this.active) w.open = false;
    this.active.length = 0;
    this.nextAt = Infinity;   // run time of the next wall
    this.planned = [];        // run times you are expected to reach upcoming / current walls (for the calm)
    this.due = null;          // { since, combo } while a due wall waits for a layout
    this.auto = true;         // tests can switch the timer off
    this.last = null;         // the last wall's layout check, for tests and the debug line
    this.stats = { spawned: 0, skipped: 0, retries: 0, combos: 0, candidates: 0, rocks: 0, planMs: 0 };
  }

  // Plans (and throws away) a few walls, so the browser has compiled the planner before the first real wall (cold, it
  // took ~4x longer: a hitch just as the wall comes out of the murk). ctx as update().
  warmUp(ctx, n = 3) {
    const field = this.field;
    for (let i = 0; i < n; i++) {
      const w = this.spawn(ctx);
      if (!w) continue;
      for (let j = field.rocks.length - 1; j >= 0; j--) {
        const r = field.rocks[j];
        if (r.wall !== w) continue;
        field.rocks[j] = field.rocks[field.rocks.length - 1];
        field.rocks.pop();
        field.release(r);
      }
    }
    this.reset();
  }

  // A run begins: the first wall after about one wall gap.
  begin(k, runTime = 0) {
    this.nextAt = runTime + k.wallGap * randIn(WALL.firstAfter);
    this.planned = [this.nextAt + k.wallWarn];
  }

  // Field density multiplier for the inflow now (it reaches you in about (R - fadeBand/2) / speed seconds).
  calmAt(runTime, speed) {
    const tau = runTime + (WORLD.radius - WORLD.fadeBand / 2) / Math.max(speed, 1);
    const c = WALL.calm;
    let dip = 0;
    for (const at of this.planned) {
      const x = tau - at;
      const s = smooth(x, c.in[0], c.in[1]) * (1 - smooth(x, c.out[0], c.out[1]));
      dip = Math.max(dip, s);
    }
    return 1 - c.depth * dip;
  }

  // One frame, after the field's. ctx = { runTime, k, speed, q, flight, drift, fwd, frustum, move, spawn } (spawn:
  // a run is on, walls may come)
  update(dt, ctx) {
    const field = this.field;
    // walls move with space (floating origin), fade in, fill in as you turn, and close once you are through
    for (let i = this.active.length - 1; i >= 0; i--) {
      const w = this.active[i];
      w.center.sub(ctx.move);
      w.age += dt;
      if (w.open) {
        const through = w.center.length() > w.L + WALL.depth + WALL.size[1] + 15;
        if (through || w.age > w.warn * 3 + 6) w.open = false;
        else this.fill(w, ctx.fwd, ctx.frustum);
      }
      if (!w.open && w.alive === 0) this.active.splice(i, 1);
    }
    this.planned = this.planned.filter((at) => at > ctx.runTime - 5);
    if (ctx.spawn) {
      field.inflowScale = this.calmAt(ctx.runTime, ctx.speed);
      if (this.auto && ctx.runTime >= this.nextAt) this.tryWall(ctx);
    } else {
      field.inflowScale = 1;
    }
  }

  // The due wall: place it if a layout passes, else wait a moment (and give up after WALL.giveUp seconds).
  tryWall(ctx) {
    const k = ctx.k;
    if (!this.due) this.due = { since: ctx.runTime, combo: Math.random() < k.wallCombo };
    const wall = this.spawn(ctx, { combo: this.due.combo });
    if (wall) {
      this.due = null;
      const next = ctx.runTime + Math.max(wall.warn + 2.5, k.wallGap * randIn(WALL.gapJitter));
      this.nextAt = next;
      this.planned = this.planned.filter((at) => at < ctx.runTime);
      this.planned.push(ctx.runTime + wall.warn, next + knobs(next).wallWarn);
      return wall;
    }
    this.stats.retries++;
    if (ctx.runTime - this.due.since > WALL.giveUp) {
      this.due = null;
      this.stats.skipped++;
      this.nextAt = ctx.runTime + k.wallGap * randIn(WALL.gapJitter);
      this.planned = this.planned.filter((at) => at < ctx.runTime);
      this.planned.push(this.nextAt + knobs(this.nextAt).wallWarn);
    } else {
      this.nextAt = ctx.runTime + WALL.retry;
    }
    return null;
  }

  // Lays out and places a wall now, if a layout passes. opts: combo (allow it next to a massive meteor), holes
  // (force [{ off, phi }] in degrees, tests), test (only hits while testOnly), check: false skips the checks.
  spawn(ctx, { combo = false, holes = null, test = false, check = true, warn = null } = {}) {
    const field = this.field;
    if (!field.groups.small.length) return null;
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const k = ctx.k;
    const start = snapshot(ctx);
    const fwd = start.fwd;
    const W = warn ?? k.wallWarn;
    const L = W * ctx.speed;
    const speedAt = (t) => knobs(ctx.runTime + t).speed;
    // massive meteors that pull you now or will before you are through
    const massives = [];
    const tEnd = W + 1.5;
    for (const m of field.massives) {
      const range = playerRange(m) + 10;
      let near = false;
      for (let t = 0; t <= tEnd && !near; t += 0.25) {
        _v.copy(m.p).addScaledVector(m.v, t).addScaledVector(fwd, -speedAt(t) * t);
        if (_v.length() < range && _v.dot(fwd) > -0.5 * _v.length()) near = true;
      }
      if (near) massives.push(m);
    }
    if (massives.length && !combo && check) return null;  // wait until it is behind you (or make it a combo)
    let escape = null;
    if (massives.length) {  // holes on the side away from the nearest one
      const m = massives.reduce((a, b) => (a.p.lengthSq() < b.p.lengthSq() ? a : b));
      escape = m.p.clone().addScaledVector(fwd, -m.p.dot(fwd));
      escape = escape.lengthSq() > 1 ? escape.normalize().negate() : null;
    }
    // the rocks that could be in the pilot's way: everything ahead out to the wall (moving in straight lines)
    const pr = FLIGHT.playerRadius;
    const rocks = [];
    const sheet = [];
    if (check) {
      for (const r of field.rocks) {
        if (r.wall || r.mu) continue;  // other walls are behind you; the pull of big rocks is not simulated
        const d = r.p.length();
        const proxy = { p0: r.p, v: r.v, r: r.s * r.shape.reach + pr + 0.75, reachIn: r.v.length() * (W + 1) };
        if (massives.length && r.noGrav && d < L + 160) sheet.push(proxy);   // an escape sheet: all the way
        else if (d <= L + 60 && r.p.dot(fwd) >= -r.s) rocks.push(proxy);
      }
    }
    const proxies = massives.map((m) => ({ p0: m.p.clone(), v: m.v.clone(), s: m.s, pull: m.pull, mu: m.mu }));
    const radius = THREE.MathUtils.lerp(WALL.holeRadius[0], WALL.holeRadius[1], Math.min(1, k.D));
    const n = Math.random() < k.wallTwoHoles ? 2 : 1;
    let chosen = null;
    let tries = 0;
    let idlePath = null;   // flying on as you are (the same for every layout)
    const tryLayout = (hs) => {
      tries++;
      const wall = { L, warn: W, holes: hs };
      if (!check) return true;
      // flying on as you are must pass outside every hole's whole rim (its clear radius plus the biggest rock
      // there: the rocks' collision spheres sit inside their size, so the hole is a little wider than its clear
      // radius) by missBy
      idlePath ??= flyThrough(start, { L, warn: W, holes: [] }, null,
                              { speedAt, massives: proxies, record: true, controls: this.controls }).path;
      if (pathThrough(idlePath, hs).some((x) => x > -(WALL.size[1] + 1 + WALL.missBy) - pr)) return false;
      // each hole can be made, past the rocks already there (and on through an escape sheet)
      for (const h of hs) {
        const near = rocks.filter((r) => segmentDistance(r.p0, h.dir, L) < r.r + r.reachIn + 25);
        const opts = { speedAt, massives: proxies, rocks: near, controls: this.controls,
                       ...(sheet.length ? { sheet, after: 110 } : {}) };
        if (!flyThrough(start, wall, h, opts).ok) return false;
      }
      return true;
    };
    if (holes) {
      const hs = holes.map((h) => ({ dir: dirAround(fwd, h.off * DEG, h.phi * DEG), r: h.r ?? radius, phi: h.phi * DEG, off: h.off }));
      if (tryLayout(hs)) chosen = hs;
    } else {
      // where you will be heading if you fly on as you are for a moment (turning: holes that way are the ones
      // you can make); straight on, that is your heading
      const ahead = check ? flyThrough(start, { L, warn: W, holes: [] }, null,
                                       { speedAt, massives: proxies, until: WALL.aheadSeconds, controls: this.controls }).end : null;
      const axis = ahead ? ahead.P.clone().addScaledVector(ahead.fwd, L).normalize() : fwd;
      // next to a massive meteor: first try holes lined up with its escape holes (where they will be)
      for (const m of massives) {
        for (const eh of m.holes ?? []) {
          if (chosen) break;
          _w.copy(m.p).add(eh.offset);
          _w.addScaledVector(m.v, _w.length() / Math.max(ctx.speed, 1)).normalize();
          const off = _w.angleTo(fwd) / DEG;
          if (off < WALL.holeOffset[0] || off > WALL.holeMax) continue;
          const hs = [{ dir: _w.clone(), r: radius, phi: 0, az: 0, off }];
          if (tryLayout(hs)) chosen = hs;
        }
      }
      for (let c = 0; c < WALL.candidates && !chosen; c++) {
        const hs = candidateHoles(fwd, c % 2 ? axis : fwd, c < WALL.candidates / 2 ? n : 1, radius, escape);
        if (hs.length && tryLayout(hs)) chosen = hs;
      }
    }
    this.stats.candidates += tries;
    if (t0) this.stats.planMs = performance.now() - t0;
    this.last = { tries, ok: !!chosen, combo: massives.length > 0, L, warn: W };
    if (!chosen) return null;
    const wall = this.build(start, { L, warn: W, holes: chosen, k, massives, test });
    if (massives.length) this.stats.combos++;
    this.stats.spawned++;
    this.fill(wall, fwd, ctx.frustum, true);
    return wall;
  }

  // The wall's net of rocks (offsets from its centre), with the holes and the massive meteors' swarms left open.
  build(start, { L, warn, holes, k, massives, test }) {
    const fwd = start.fwd;
    const S = WALL.spacing;
    const cosMax = Math.cos(WALL.extent * DEG);
    const area = 2 * Math.PI * (1 - cosMax) * L * L;
    const N = Math.round(area / (S * S * Math.sqrt(3) / 2));
    const offsets = new Float32Array(N * 3);
    const sizes = new Float32Array(N);
    const kinds = new Uint8Array(N);   // 0 gone, 1 rock/decoy, 2 exploder
    const shapes = new Uint8Array(N);
    const tints = new Float32Array(N); // decoy shade (or -1: gray)
    basis(fwd, _a, _b);
    const fuse = Math.min(WALL.exploderFuse[1], Math.max(WALL.exploderFuse[0], warn - 1.25));
    const field = this.field;
    let count = 0;
    for (let i = 0; i < N; i++) {
      const c = 1 - ((i + 0.5) / N) * (1 - cosMax);
      const s = Math.sqrt(1 - c * c);
      const phi = i * GOLDEN;
      // the point on the sphere, then jitter: sideways (along two tangents) and in/out
      _v.copy(fwd).multiplyScalar(c).addScaledVector(_a, s * Math.cos(phi)).addScaledVector(_b, s * Math.sin(phi));
      const j = WALL.jitter * S;
      _w.copy(_a).multiplyScalar((Math.random() * 2 - 1) * j).addScaledVector(_b, (Math.random() * 2 - 1) * j);
      _w.addScaledVector(_v, -_w.dot(_v));
      const size = WALL.size[0] * (WALL.size[1] / WALL.size[0]) ** Math.random();
      _v.multiplyScalar(L + (Math.random() * 2 - 1) * WALL.depth).add(_w);
      // holes: keep the tube clear (the rock's whole radius plus a metre)
      const len = _v.length();
      let open = false;
      for (const h of holes) {
        const along = _v.dot(h.dir);
        if (along > 0 && Math.sqrt(Math.max(0, len * len - along * along)) < h.r + size + 1) open = true;
      }
      // a massive meteor's swarm where it will be when you get here, and its escape holes (they go on through)
      for (const m of massives) {
        _w.copy(m.p).addScaledVector(m.v, warn);  // (the wall itself stands still)
        const swarmR = GRAVITY.massive.orbit[1] * 1.35 * m.s;
        if (_w.distanceTo(_v) < swarmR + size + WALL.massiveClear) open = true;
        if (m.holes && inHole(m, _w.copy(_v).addScaledVector(m.v, -warn), size)) open = true;
      }
      if (open) continue;
      offsets.set([_v.x, _v.y, _v.z], count * 3);
      sizes[count] = size;
      shapes[count] = wallShape(field);
      // exploders (later in a run), never right beside a hole; decoys like the field
      const nearHole = holes.some((h) => _v.angleTo(h.dir) * L < h.r * 2.2);
      if (!nearHole && Math.random() < k.wallExploders) {
        kinds[count] = 2;
      } else {
        kinds[count] = 1;
        tints[count] = Math.random() < k.decoyShare ? 1 - (1 - Math.random()) ** k.decoyDeepBias : -1;
      }
      count++;
    }
    const wall = {
      center: new THREE.Vector3(), axis: fwd.clone(), L, warn, holes, test, fuse,
      n: count, offsets, sizes, kinds, shapes, tints,
      rocks: new Array(count).fill(null), alive: 0, age: 0, open: true, combo: massives.length > 0,
    };
    this.active.push(wall);
    this.stats.rocks = count;
    return wall;
  }

  // Makes rocks of the wall's net that are inside the kept cone and not there yet. Out of view only, except when it
  // first appears (then everything is at fade 0 and comes out of the murk together).
  fill(w, fwd, frustum, first = false) {
    const field = this.field;
    const cosKeep = field.cosKeep;
    const R = WORLD.radius;
    for (let i = 0; i < w.n; i++) {
      if (w.rocks[i] || !w.kinds[i]) continue;
      _v.set(w.offsets[i * 3], w.offsets[i * 3 + 1], w.offsets[i * 3 + 2]).add(w.center);
      const d = _v.length();
      if (d > R || d < 1 || _v.dot(fwd) < cosKeep * d) continue;
      const s = w.sizes[i];
      if (!first && frustum && field.inView(_v, s, frustum)) continue;
      const exploder = w.kinds[i] === 2;
      const fade = first ? 0 : Math.min(1, w.age / WALL.fadeSeconds);
      const r = field.makeRock(exploder ? 'exploder' : w.tints[i] >= 0 ? 'decoy' : 'rock', field.groups.small[w.shapes[i]], _v, s, fade);
      if (w.tints[i] >= 0 && !exploder) field.tintDecoy(r, w.tints[i]);
      r.fadeRate = 1 / WALL.fadeSeconds;
      r.noGrav = true;
      r.spin *= 0.5;
      r.farFuse = 0;
      r.fuseLen = w.fuse;
      r.test = w.test;
      r.wall = w;
      r.entry = i;
      w.rocks[i] = r;
      w.alive++;
    }
  }

  // The field lets go of a wall rock (dropped out of the cone, or blown up: then it is gone for good).
  released(r, gone) {
    const w = r.wall;
    if (w.rocks[r.entry] === r) {
      w.rocks[r.entry] = null;
      w.alive--;
      if (gone) w.kinds[r.entry] = 0;
    }
  }

  // Is p (radius size, the player's frame) inside an open wall's hole (a new field rock there would plug it)?
  inHole(p, size) {
    for (const w of this.active) {
      if (!w.open) continue;
      _v.copy(p).sub(w.center);
      const d = _v.length();
      if (d < w.L - 45 || d > w.L + 45) continue;
      for (const h of w.holes) {
        const along = _v.dot(h.dir);
        if (along > 0 && Math.sqrt(Math.max(0, d * d - along * along)) < h.r + size + 4) return true;
      }
    }
    return false;
  }
}

// Distance of point p from the segment 0 -> dir·L.
function segmentDistance(p, dir, L) {
  const t = Math.min(L, Math.max(0, p.dot(dir)));
  return _w.copy(dir).multiplyScalar(t).distanceTo(p);
}

function smooth(x, a, b) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// A small shape for a wall rock: the thin ones (the slab, the long rock) block little of the curtain, so only the
// shapes whose collision spheres fill most of their size are used.
function wallShape(field) {
  const list = field.groups.small;
  if (!list.wallPick) {
    const good = list.map((sh, i) => (sh.effR >= 0.55 ? i : -1)).filter((i) => i >= 0);
    list.wallPick = good.length ? good : list.map((_, i) => i);
  }
  return list.wallPick[Math.floor(Math.random() * list.wallPick.length)];
}
