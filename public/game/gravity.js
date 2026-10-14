// Gravity (DESIGN §7, TECH "Gravity, swarms and escape gaps"): only big and massive meteors pull.
// - On meteors: a softened inverse-square pull, mu = GM chosen so a circular orbit at 2.5 radii takes `period`
//   seconds, out to `range` radii (fading over the outer 40%). Small meteors don't pull each other.
// - On you (massive only): a gameplay curve, not physics: strength s = ((range - d) / (range - radius))^power grows
//   as you get closer; it turns you toward the meteor (up to turnMax °/s) and drags you sideways (up to drift m/s),
//   both times sin(angle off your heading), and fades out once the meteor is behind you.
// - Swarms: members placed on orbits around their attractor (bound ones and a few slingshots).
// - Escape rule: a porous sheet of extra meteors on the far side of you from the massive meteor, with clear holes.
// Pure math with three.js vectors only, so it runs in Node tests too.
import * as THREE from 'three';
import { GRAVITY } from './config.js';

const DEG = Math.PI / 180;
const _d = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _l = new THREE.Vector3();
const _qi = new THREE.Quaternion();

// mu (m³/s²) for an attractor of radius s whose orbit at 2.5 radii takes `period` seconds.
export function attractorMu(s, period) {
  const r = 2.5 * s;
  const v = (2 * Math.PI * r) / period;
  return v * v * r * ((r * r + softening(s) ** 2) / (r * r)) ** 1.5;
}

export const softening = (s) => 0.5 * s;

// Speed of a circular orbit at distance r around an attractor (mu, radius s), with the same softened law.
export function circularSpeed(mu, s, r) {
  const e2 = softening(s) ** 2;
  return Math.sqrt((mu * r * r) / (r * r + e2) ** 1.5);
}

// Constants for addPull, set once when a rock becomes an attractor (radius s, `range` m).
export function setupAttractor(att, period, range) {
  att.mu = attractorMu(att.s, period);
  att.range = range;
  att.range2 = range * range;
  att.inner = 0.6 * range;
  att.e2 = softening(att.s) ** 2;
}

// Adds the pull of one attractor at point p (both in the same frame) to the velocity `out`, scaled by dt (its own
// swarm uses dt, other meteors dt · fieldPull). Returns the distance (Infinity out of range). Called ~10k times a
// frame, so plain numbers only.
export function addPull(att, p, dt, out) {
  const dx = att.p.x - p.x;
  const dy = att.p.y - p.y;
  const dz = att.p.z - p.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 > att.range2) return Infinity;
  const q = d2 + att.e2;
  let k = att.mu / (q * Math.sqrt(q));
  const d = Math.sqrt(d2);
  if (d > att.inner) {  // fade out over the outer part of the range
    const t = (d - att.inner) / (att.range - att.inner);
    k *= 1 - t * t * (3 - 2 * t);
  }
  k *= dt;
  out.x += dx * k;
  out.y += dy * k;
  out.z += dz * k;
  return d;
}

// The pull of the massive meteors on the player. q = where you face; fwd its forward vector. Returns the extra turn
// in camera space (gx = yaw right, gy = pitch up, °/s), the drift target (world m/s, into `drift`) and the strongest
// pull (0..1, for the escape rule and the camera effects later).
export function playerPull(massives, fwd, q, drift, cfg = GRAVITY.player) {
  let gx = 0;
  let gy = 0;
  let strength = 0;
  drift.set(0, 0, 0);
  _qi.copy(q).invert();
  for (const m of massives) {
    const s = pullStrength(m, cfg);
    if (s <= 0) continue;
    const d = m.p.length();
    const cos = m.p.dot(fwd) / d;
    const behind = THREE.MathUtils.smoothstep(cos, cfg.behind[0], cfg.behind[1]);
    const k = s * m.pull * behind;
    if (k <= 0) continue;
    strength = Math.max(strength, k);
    // camera space: x right, y up, -z ahead; (lx, ly) / d = sin(angle off the heading) in the turn direction
    _l.copy(m.p).applyQuaternion(_qi);
    gx += (cfg.turnMax * k * _l.x) / d;
    gy += (cfg.turnMax * k * _l.y) / d;
    // sideways (perpendicular to the heading) toward the meteor
    _n.copy(m.p).addScaledVector(fwd, -m.p.dot(fwd)).multiplyScalar(1 / d);
    drift.addScaledVector(_n, cfg.drift * k);
  }
  return { gx, gy, strength };
}

// The pull warning (owner's wish after Contoo 4: being pulled into a massive meteor was too unexpected): flies on as
// you are (controls = walls.js controlsModel(): the circle or the stick held where it is) with the pull, for up to
// `horizon` s, and returns the time until you would hit a massive meteor (Infinity if you don't) and which one.
// The meteors move in straight lines here. f = the flight state, q = where you face, drift = your drift (m/s).
const _fq = new THREE.Quaternion();
const _fdq = new THREE.Quaternion();
const _fax = new THREE.Vector3();
const _ffwd = new THREE.Vector3();
const _fP = new THREE.Vector3();
const _fdrift = new THREE.Vector3();
const _fdt = new THREE.Vector3();
const _frel = new THREE.Vector3();
export function pullForecast(massives, { f, q, drift, speed, controls, horizon = 4, dt = 1 / 20, playerRadius = 0.5 }) {
  if (!massives.length) return { tHit: Infinity, meteor: null };
  const ms = massives.map((m) => ({ m, p0: m.p, v: m.v, s: m.s, pull: m.pull, p: new THREE.Vector3(),
                                    reach: m.s * (m.shape?.collisionRadius ?? 0.8) + playerRadius }));
  const ff = { ...f };
  const u = controls.idle(f);
  _fq.copy(q);
  _fP.set(0, 0, 0);
  _fdrift.copy(drift);
  for (let t = dt; t <= horizon + 1e-9; t += dt) {
    for (const x of ms) x.p.copy(x.p0).addScaledVector(x.v, t).sub(_fP);   // seen from where you would be
    _ffwd.set(0, 0, -1).applyQuaternion(_fq);
    const pull = playerPull(ms, _ffwd, _fq, _fdt);
    controls.step(ff, u, dt);
    _fdrift.lerp(_fdt, 1 - Math.exp(-dt / GRAVITY.player.driftSeconds));
    const ax = (ff.wy + pull.gy) * DEG * dt;
    const ay = -(ff.wx + pull.gx) * DEG * dt;
    const a = Math.hypot(ax, ay);
    if (a > 0) _fq.multiply(_fdq.setFromAxisAngle(_fax.set(ax / a, ay / a, 0), a)).normalize();
    _ffwd.set(0, 0, -1).applyQuaternion(_fq);
    _fP.addScaledVector(_ffwd, speed * dt).addScaledVector(_fdrift, dt);
    for (const x of ms) {
      _frel.copy(x.p0).addScaledVector(x.v, t).sub(_fP);
      if (_frel.length() < x.reach) return { tHit: t, meteor: x.m };
    }
  }
  return { tHit: Infinity, meteor: null };
}

export function playerRange(m, cfg = GRAVITY.player) {
  return cfg.range[0] + cfg.range[1] * m.s;
}

export function pullStrength(m, cfg = GRAVITY.player) {
  const range = playerRange(m, cfg);
  const d = m.p.length();
  if (d >= range) return 0;
  return Math.min(1, (range - d) / (range - m.s)) ** cfg.power;
}

// Orbit for a swarm member around host (radius s, mu): returns { offset, velocity } relative to the host.
// normal: the swarm plane; tilt: random tilt off it (deg); sling: a fast pass instead of a bound orbit.
export function orbit(host, r, normal, { tilt = 0, sling = false, sense = 1 } = {}) {
  // a random direction in the plane, tilted a little
  _a.set(Math.abs(normal.x) < 0.9 ? 1 : 0, Math.abs(normal.x) < 0.9 ? 0 : 1, 0).cross(normal).normalize();
  _b.copy(normal).cross(_a);
  const phi = Math.random() * Math.PI * 2;
  const radial = new THREE.Vector3().copy(_a).multiplyScalar(Math.cos(phi)).addScaledVector(_b, Math.sin(phi));
  const t = (Math.random() * 2 - 1) * tilt * DEG;
  radial.multiplyScalar(Math.cos(t)).addScaledVector(normal, Math.sin(t)).normalize();
  const tangent = new THREE.Vector3().crossVectors(normal, radial).normalize().multiplyScalar(sense);
  const offset = radial.clone().multiplyScalar(r);
  const vc = circularSpeed(host.mu, host.s, r);
  let velocity;
  if (sling) {  // falling in from further out, aimed to pass close and swing round fast
    const b = host.s * (2.2 + Math.random() * 0.8);       // aim this far off the centre
    const beta = Math.asin(Math.min(0.95, b / r));
    const vEsc = Math.sqrt(2) * vc;
    velocity = radial.clone().multiplyScalar(-Math.cos(beta) * vEsc * 1.1)
      .addScaledVector(tangent, Math.sin(beta) * vEsc * 1.1);
  } else {      // nearly circular (a little eccentric)
    velocity = tangent.multiplyScalar(vc * (0.93 + Math.random() * 0.12));
  }
  return { offset, velocity };
}

// Escape sheet layout for a massive meteor at position M (radius s, swarm out to `swarmR`), seen from the player
// at the origin flying along fwd. Returns { rocks: [{ p, size }], holes: [{ offset, axis, r }] } in the world
// frame (hole offsets relative to M).
export function escapeLayout(M, s, swarmR, fwd, cfg = GRAVITY.escape) {
  const depthM = M.dot(fwd);
  const lat = new THREE.Vector3().copy(M).addScaledVector(fwd, -depthM);
  const latLen = lat.length();
  // the escape side e is away from the massive meteor (any side if it is dead ahead)
  const e = latLen > 1 ? lat.multiplyScalar(-1 / latLen) : randomPerp(fwd, lat);
  const f = new THREE.Vector3().crossVectors(fwd, e);
  const depth = depthM - s - cfg.depth - 6;
  const at = (a, b, z = depth) => new THREE.Vector3().copy(fwd).multiplyScalar(z).addScaledVector(e, a).addScaledVector(f, b);
  // holes: away from the swarm, inside the band you can turn to in time
  const nHoles = cfg.holes[0] + Math.floor(Math.random() * (cfg.holes[1] - cfg.holes[0] + 1));
  const minA = Math.max(cfg.holeAt[0], swarmR + cfg.holeRadius + 8 - latLen);
  const holes = [];
  for (let tries = 0; holes.length < nHoles && tries < 40; tries++) {
    const a = minA + Math.random() * Math.max(10, cfg.holeAt[1] - cfg.holeAt[0]);
    const b = (Math.random() * 2 - 1) * 35;
    if (holes.some((h) => Math.hypot(h.a - a, h.b - b) < cfg.holeRadius * 2.6)) continue;
    holes.push({ a, b });
  }
  const rocks = [];
  const [s0, s1] = cfg.size;
  const sp = cfg.spacing;
  const a1 = Math.max(cfg.lateral[1], minA + cfg.holeAt[1] - cfg.holeAt[0] + 40);
  for (let a = cfg.lateral[0]; a <= a1; a += sp) {
    for (let b = -cfg.across; b <= cfg.across; b += sp) {
      const size = s0 * (s1 / s0) ** Math.random();
      const ja = a + (Math.random() - 0.5) * sp * 0.7;
      const jb = b + (Math.random() - 0.5) * sp * 0.7;
      if (holes.some((h) => Math.hypot(h.a - ja, h.b - jb) < cfg.holeRadius + size)) continue;
      const p = at(ja, jb, depth + (Math.random() * 2 - 1) * cfg.depth);
      if (p.distanceTo(M) < swarmR + size + 6) continue;
      rocks.push({ p, size });
    }
  }
  return {
    rocks,
    holes: holes.map((h) => ({ offset: at(h.a, h.b).sub(M), axis: fwd.clone(), r: cfg.holeRadius, depth: cfg.depth })),
  };
}

function randomPerp(axis, out) {
  _a.set(Math.abs(axis.x) < 0.9 ? 1 : 0, Math.abs(axis.x) < 0.9 ? 0 : 1, 0).cross(axis).normalize();
  _b.copy(axis).cross(_a);
  const phi = Math.random() * Math.PI * 2;
  return out.copy(_a).multiplyScalar(Math.cos(phi)).addScaledVector(_b, Math.sin(phi));
}

// Is point p (radius size) inside one of the holes of massive m (so a new rock there would plug it)?
export function inHole(m, p, size, margin = 4) {
  for (const h of m.holes) {
    _d.copy(p).sub(m.p).sub(h.offset);
    const along = _d.dot(h.axis);
    if (Math.abs(along) > h.depth + 30) continue;
    const perp2 = _d.lengthSq() - along * along;
    const reach = h.r + size + margin;
    if (perp2 < reach * reach) return true;
  }
  return false;
}
