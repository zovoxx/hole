// The meteor field around the player (TECH "World"). Floating origin: the player is always at 0,0,0 and
// everything else moves. Space is a uniform random field of meteors, kept only inside a cone around where the
// camera faces (`keepAngle` = the view's corners + WORLD.keepMargin), never behind:
// - Flying forward, the field flows toward you. New meteors enter through the far cap of the cone at the rate a
//   uniform field would (density · speed · cosθ · R² per steradian), inside the complete fog, and fade in (extra
//   fog). Everything closer comes from there, so the density you see is even at every distance.
// - Turning, the cone sweeps into new directions: that thin sliver is filled at once, out of view, never
//   closer than WORLD.sideMin. So a turn always finds space already full.
// - A meteor that leaves the cone is dropped (only once it is out of view), so the field stays uniform.
// - Meteors drift slower than the player, so in the camera's frame everything moves backward: nothing ever
//   comes from behind.
// - Difficulty only reaches meteors as they spawn (density, sizes, drift); nothing already there changes.
import * as THREE from 'three';
import { WORLD, FLIGHT } from './config.js';
import { createMeteorMesh, tintColor } from './meteors.js';

const DEG = Math.PI / 180;
const _v = new THREE.Vector3();
const _o = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _sphere = new THREE.Sphere();
let GRAY = null;  // linear gray tint, set on first use (after the colour management is ready)

// Deterministic random numbers for the shape statistics (the field itself uses Math.random).
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The radius of a disc with the same area as the rock's collision spheres seen from a random direction (in rock
// units, bounding radius 1). Sets how much of your path a rock blocks, so the density can be set as "seconds
// between rocks in your path".
function effectiveRadius(spheres, fallback) {
  if (!spheres?.length) return fallback;
  const rnd = mulberry32(7);
  const d = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  let hits = 0;
  let total = 0;
  for (let k = 0; k < 48; k++) {
    d.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();
    a.set(0.3, 0.5, 0.8).cross(d).normalize();
    b.copy(d).cross(a);
    for (let i = 0; i < 160; i++) {
      const u = rnd() * 2 - 1;
      const w = rnd() * 2 - 1;
      for (const [x, y, z, r] of spheres) {
        const s = x * d.x + y * d.y + z * d.z;  // distance from the sphere centre to the ray, squared
        const px = x - s * d.x - u * a.x - w * b.x;
        const py = y - s * d.y - u * a.y - w * b.y;
        const pz = z - s * d.z - u * a.z - w * b.z;
        if (px * px + py * py + pz * pz < r * r) { hits++; break; }
      }
      total++;
    }
  }
  return Math.sqrt((4 * hits) / total / Math.PI);
}

const logUniform = ([a, b], r = Math.random()) => a * (b / a) ** r;

// A distance uniform in volume between r0 and R along dir (unit), or null. Near the far edge the density ramps
// down to 0 at R, matching the band the arrivals through the far cap keep up: they appear at a random depth up
// to fadeBand along the flight line, so the ramp follows the line too.
function fieldDistance(r0, R, dir, fwd) {
  const d = Math.cbrt(r0 ** 3 + Math.random() * (R ** 3 - r0 ** 3));
  const a = d * dir.dot(fwd);
  const lineDepth = -a + Math.sqrt(Math.max(0, a * a - d * d + R * R));  // to the sphere, along +fwd
  return lineDepth < WORLD.fadeBand && Math.random() * WORLD.fadeBand > lineDepth ? null : d;
}

// A random direction at angle theta from axis (unit), azimuth phi around it.
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
function dirAround(axis, theta, phi, out) {
  _a.set(Math.abs(axis.x) < 0.9 ? 1 : 0, Math.abs(axis.x) < 0.9 ? 0 : 1, 0).cross(axis).normalize();
  _b.copy(axis).cross(_a);
  const st = Math.sin(theta);
  return out.copy(axis).multiplyScalar(Math.cos(theta))
    .addScaledVector(_a, st * Math.cos(phi)).addScaledVector(_b, st * Math.sin(phi));
}

export class MeteorField {
  // shapes = loadMeteors() result; only `small` and `big` are used here (fragments come in Contoo 2).
  constructor(scene, shapes) {
    this.rocks = [];       // alive
    this.free = [];        // pooled rock objects
    this.keepAngle = 70 * DEG;
    this.capacity = Math.ceil(WORLD.maxMeteors * 1.3);
    this.groups = { small: [], big: [] };
    for (const group of ['small', 'big']) {
      for (const shape of shapes[group] ?? []) {
        const mesh = createMeteorMesh(shape, this.capacity, { fade: true });
        scene.add(mesh);
        this.groups[group].push({
          id: shape.id, group, mesh, fade: mesh.geometry.getAttribute('aFade'), count: 0,
          spheres: shape.collisionSpheres?.length ? shape.collisionSpheres : [[0, 0, 0, shape.collisionRadius]],
          effR: effectiveRadius(shape.collisionSpheres, shape.collisionRadius),
        });
      }
    }
    this.shapes = [...this.groups.small, ...this.groups.big];
    if (!this.groups.small.length) throw new Error('no meteor shapes loaded');
    this.sigma = this.meanCrossSection();
    this.density = 0;        // meteors per m³ for new spawns
    this.sizeFactor = 1;
    this.inflowCarry = 0;    // fractional spawns carried to the next frame
    this.turnCarry = 0;
    this.prevFwd = null;
    this.testOnly = false;   // tests: only rocks from placeAhead() can hit
    this.stats = { alive: 0, drawn: 0, target: 0, spawned: 0 };
  }

  // Mean area of your path a spawned rock blocks (m², player radius included), over shapes and sizes.
  meanCrossSection(sizeFactor = 1) {
    const pr = FLIGHT.playerRadius;
    const part = (list, [a, b]) => {
      const L = Math.log(b / a);
      const es = ((b - a) / L) * sizeFactor;                     // E[s], log-uniform
      const es2 = ((b * b - a * a) / (2 * L)) * sizeFactor ** 2; // E[s²]
      const mean = list.reduce((sum, sh) => sum + Math.PI * (sh.effR ** 2 * es2 + 2 * sh.effR * pr * es + pr * pr), 0);
      return mean / list.length;
    };
    const bigShare = this.groups.big.length ? WORLD.big.share : 0;
    return (1 - bigShare) * part(this.groups.small, WORLD.small.radius)
      + (bigShare ? bigShare * part(this.groups.big, WORLD.big.radius) : 0);
  }

  // Call when the camera's fov or aspect changes: the kept cone reaches past the view's corners. If it grows
  // (a phone turned to landscape), the new ring around it is filled at once; it lies past the view's corners.
  setView(camera) {
    const tv = Math.tan((camera.fov * DEG) / 2);
    const th = tv * camera.aspect;
    const corner = Math.atan(Math.hypot(tv, th));
    const oldCos = this.cosKeep;
    this.keepAngle = Math.min(corner + WORLD.keepMargin * DEG, 100 * DEG);
    this.cosKeep = Math.cos(this.keepAngle);
    this.keepSolid = 2 * Math.PI * (1 - this.cosKeep);
    const fwd = this.prevFwd;
    if (fwd && this.density > 0 && oldCos !== undefined && this.cosKeep < oldCos) {
      const R = WORLD.radius;
      const r0 = WORLD.sideMin;
      const n = Math.round(this.density * 2 * Math.PI * (oldCos - this.cosKeep) * (R ** 3 - r0 ** 3) / 3);
      for (let i = 0; i < n; i++) {
        dirAround(fwd, Math.acos(oldCos - Math.random() * (oldCos - this.cosKeep)), Math.random() * 2 * Math.PI, _v);
        const d = fieldDistance(r0, R, _v, fwd);
        if (d !== null) this.spawn(_v, d, 1, fwd, { speed: this.lastSpeed ?? 40 });
      }
    }
  }

  // speed (m/s) and pathGap (s) -> how many meteors per m³; past the cap rocks get bigger instead of more.
  setDensity(speed, pathGap) {
    const R = WORLD.radius;
    const volume = (this.keepSolid * R ** 3) / 3;
    let rho = 1 / (pathGap * speed * this.sigma);
    this.sizeFactor = 1;
    if (rho * volume > WORLD.maxMeteors) {
      const capped = WORLD.maxMeteors / volume;
      this.sizeFactor = Math.sqrt(rho / capped);  // blocks the same share of your path with fewer, bigger rocks
      rho = capped;
    }
    this.density = rho;
    this.stats.target = Math.round(rho * volume);
  }

  clear() {
    for (const r of this.rocks) this.free.push(r);
    this.rocks.length = 0;
  }

  // A fresh field (a new run, or the start screen): the whole cone filled at once (hidden by a screen), with the
  // first stretch of the path clear.
  reset(fwd, frustum, { speed, attract = false }) {
    this.clear();
    const R = WORLD.radius;
    const r0 = 20;
    const n = Math.round(this.density * this.keepSolid * (R ** 3 - r0 ** 3) / 3);
    for (let i = 0; i < n; i++) {
      dirAround(fwd, Math.acos(1 - Math.random() * (1 - this.cosKeep)), Math.random() * 2 * Math.PI, _v);
      const d = fieldDistance(r0, R, _v, fwd);
      if (d !== null) this.spawn(_v, d, 1, fwd, { speed, attract, clearPath: true });
    }
    this.prevFwd = fwd.clone();
    this.inflowCarry = this.turnCarry = 0;
  }

  newRock() {
    return this.free.pop() ?? {
      shape: null, s: 1, p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(),
      axis: new THREE.Vector3(), spin: 0, fade: 1, gray: 1, test: false,
    };
  }

  // A new rock at direction dir (unit) and distance d, faded in by `fade` (0..1). frustum: only spawn it if no
  // part of it is in view. Returns it, or null when it was not placed.
  spawn(dir, d, fade, fwd, { speed, attract = false, clearPath = false, frustum = null }) {
    const big = this.groups.big.length && Math.random() < WORLD.big.share;
    const list = big ? this.groups.big : this.groups.small;
    const shape = list[Math.floor(Math.random() * list.length)];
    const s = logUniform(big ? WORLD.big.radius : WORLD.small.radius) * this.sizeFactor;
    _o.copy(dir).multiplyScalar(d);
    if (frustum) {
      _sphere.center.copy(_o);
      _sphere.radius = s * 1.05 + 1;
      if (frustum.intersectsSphere(_sphere)) return null;
    }
    if (clearPath || attract) {  // keep the first stretch of the path empty (start screen and a new run)
      const along = _o.dot(fwd);
      const side = Math.sqrt(Math.max(0, d * d - along * along));
      if (along > -s && along < WORLD.clearPath.length && side < s + WORLD.clearPath.margin) return null;
    }
    const r = this.newRock();
    r.shape = shape;
    r.s = s;
    r.p.copy(_o);
    if (attract) {
      r.v.set(0, 0, 0);  // behind the start screen nothing drifts into the path
    } else {
      r.v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
      if (r.v.lengthSq() > 1e-6) r.v.normalize();
      r.v.multiplyScalar(Math.random() * WORLD.drift * speed * (big ? 0.4 : 1));
    }
    r.q.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    r.axis.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
    r.spin = logUniform(WORLD.spin) * (big ? 0.3 : 1) * (Math.random() < 0.5 ? -1 : 1);
    r.fade = fade;
    r.gray = 1 + (Math.random() * 2 - 1) * WORLD.grayJitter;
    r.test = false;
    this.rocks.push(r);
    this.stats.spawned++;
    return r;
  }

  // New rocks this frame: the inflow through the far cap (flying forward) and the sliver a turn swept into.
  feed(dt, fwd, frustum, { speed, flySpeed, attract }) {
    const R = WORLD.radius;
    this.lastSpeed = speed;
    const opts = { speed, attract };
    // 1. inflow through the far cap: the lines of flight entering it are evenly spread over its projected disc
    //    (radius R·sin keep), so the entry points are cosine-weighted; a rock appears a random depth up to
    //    fadeBand down its line
    const kIn = Math.min(this.keepAngle, Math.PI / 2);
    if (flySpeed > 0) {
      this.inflowCarry += this.density * flySpeed * Math.PI * (R * Math.sin(kIn)) ** 2 * dt;
      while (this.inflowCarry >= 1) {
        this.inflowCarry -= 1;
        const theta = Math.asin(Math.sqrt(Math.random()) * Math.sin(kIn));
        dirAround(fwd, theta, Math.random() * 2 * Math.PI, _v);
        _v.multiplyScalar(R).addScaledVector(fwd, -Math.random() * WORLD.fadeBand);
        const d = _v.length();
        this.spawn(_v.divideScalar(d), d, 0, fwd, opts);
      }
    }
    // 2. the sliver of new directions a turn swept into the cone: solid angle ≈ 2·sin(keep)·δ, filled from
    //    sideMin to R (it lies past the view's corners, so nobody sees it arrive). Flying forward, rocks near
    //    the side already flow outward into it (v·sin(keep)·dt across the edge), so only the rest is filled.
    const prev = this.prevFwd ?? (this.prevFwd = fwd.clone());
    const cosDelta = THREE.MathUtils.clamp(prev.dot(fwd), -1, 1);
    const delta = Math.acos(cosDelta);
    if (delta > 1e-6) {
      const r0 = WORLD.sideMin;
      const out = Math.max(0, flySpeed) * Math.sin(this.keepAngle) * dt;
      this.turnCarry += this.density * (R ** 3 - r0 ** 3) / 3 * 2 * Math.sin(this.keepAngle) * delta;
      // turn direction t: from prev toward fwd, perpendicular to fwd
      const t = _s.copy(fwd).multiplyScalar(cosDelta).sub(prev).normalize();
      // azimuth of t around fwd, in dirAround's frame
      _a.set(Math.abs(fwd.x) < 0.9 ? 1 : 0, Math.abs(fwd.x) < 0.9 ? 0 : 1, 0).cross(fwd).normalize();
      _b.copy(fwd).cross(_a);
      const phiT = Math.atan2(t.dot(_b), t.dot(_a));
      while (this.turnCarry >= 1) {
        this.turnCarry -= 1;
        const phi = Math.asin(2 * Math.random() - 1);         // density ∝ cos φ around the turn direction
        const d = Math.cbrt(r0 ** 3 + Math.random() * (R ** 3 - r0 ** 3));
        const swept = delta * Math.cos(phi);                   // how far the edge moved here (radians)
        const depth = swept - out / d;                         // ...minus what the outflow already covers
        if (depth <= 0 || Math.random() * swept > depth) continue;
        const theta = this.keepAngle - Math.random() * depth;
        dirAround(fwd, theta, phiT + phi, _v);
        const a = d * _v.dot(fwd);                             // the far-edge ramp, as in fieldDistance
        const lineDepth = -a + Math.sqrt(Math.max(0, a * a - d * d + R * R));
        if (lineDepth < WORLD.fadeBand && Math.random() * WORLD.fadeBand > lineDepth) continue;
        this.spawn(_v, d, 1, fwd, { ...opts, frustum });  // (a big rock could reach into the view: then none)
      }
      prev.copy(fwd);
    }
  }

  // Moves everything by one frame. move = how far the player flew this frame (world vector) and timeScale
  // slows the meteors' own motion (the hit effect). Returns the rock that hit the player, if any.
  update(dt, { fwd, frustum, move, speed, timeScale = 1, collide = true, attract = false }) {
    const R = WORLD.radius;
    const pr = FLIGHT.playerRadius;
    let hit = null;
    const rocks = this.rocks;
    for (let i = rocks.length - 1; i >= 0; i--) {
      const r = rocks[i];
      const sdt = dt * timeScale;
      // relative motion this frame: own drift minus the player's flight
      _o.copy(r.v).multiplyScalar(sdt).sub(move);
      r.p.add(_o);
      if (r.spin) r.q.premultiply(_q.setFromAxisAngle(r.axis, r.spin * sdt));
      if (r.fade < 1) r.fade = Math.min(1, r.fade + dt / WORLD.fadeSeconds);
      const d = r.p.length();
      // drop: past the fog, or out of the kept cone and out of view
      const cos = d > 1e-6 ? r.p.dot(fwd) / d : 1;
      if (d > R + 5 || (cos < this.cosKeep && !this.visible(r, frustum))) {
        this.free.push(r);
        rocks[i] = rocks[rocks.length - 1];
        rocks.pop();
        continue;
      }
      if (collide && !hit && (r.test || !this.testOnly) && d < r.s + pr + _o.length() + 0.5 && this.hits(r, _o, pr)) hit = r;
    }
    const flySpeed = dt > 0 ? move.dot(fwd) / dt : 0;
    this.feed(dt, fwd, frustum, { speed, flySpeed, attract });
    this.stats.alive = rocks.length;
    return hit;
  }

  visible(r, frustum) {
    _sphere.center.copy(r.p);
    _sphere.radius = r.s * 1.05 + 1;
    return frustum.intersectsSphere(_sphere);
  }

  // Swept test: did any collision sphere of the rock touch the player's sphere during this frame's motion?
  hits(r, step, pr) {
    const len2 = step.lengthSq();
    for (const [x, y, z, rad] of r.shape.spheres) {
      _s.set(x, y, z).multiplyScalar(r.s).applyQuaternion(r.q).add(r.p);  // sphere centre now (c1)
      // on the segment c1 - t·step (t in 0..1), the point closest to the player
      const t = len2 > 1e-9 ? THREE.MathUtils.clamp(_s.dot(step) / len2, 0, 1) : 0;
      const cx = _s.x - t * step.x;
      const cy = _s.y - t * step.y;
      const cz = _s.z - t * step.z;
      const reach = rad * r.s + pr;
      if (cx * cx + cy * cy + cz * cz < reach * reach) return true;
    }
    return false;
  }

  // Writes the visible rocks into their instanced meshes.
  render(frustum) {
    for (const sh of this.shapes) sh.count = 0;
    let drawn = 0;
    for (const r of this.rocks) {
      if (!this.visible(r, frustum)) continue;
      const sh = r.shape;
      const i = sh.count;
      if (i >= this.capacity) continue;
      _m.compose(r.p, r.q, _s.setScalar(r.s));
      _m.toArray(sh.mesh.instanceMatrix.array, i * 16);
      _c.copy(GRAY ??= tintColor('gray')).multiplyScalar(r.gray);
      _c.toArray(sh.mesh.instanceColor.array, i * 3);
      sh.fade.array[i] = r.fade;
      sh.count = i + 1;
      drawn++;
    }
    for (const sh of this.shapes) {
      sh.mesh.count = sh.count;
      if (!sh.count) continue;
      sh.mesh.instanceMatrix.clearUpdateRanges();
      sh.mesh.instanceMatrix.addUpdateRange(0, sh.count * 16);
      sh.mesh.instanceMatrix.needsUpdate = true;
      sh.mesh.instanceColor.clearUpdateRanges();
      sh.mesh.instanceColor.addUpdateRange(0, sh.count * 3);
      sh.mesh.instanceColor.needsUpdate = true;
      sh.fade.clearUpdateRanges();
      sh.fade.addUpdateRange(0, sh.count);
      sh.fade.needsUpdate = true;
    }
    this.stats.drawn = drawn;
  }

  // Test helper: a rock straight ahead at `dist` metres, not moving; the only kind that hits while testOnly.
  placeAhead(fwd, dist = 60, s = 4) {
    const r = this.newRock();
    r.shape = this.groups.small[0];
    r.s = s;
    r.p.copy(fwd).multiplyScalar(dist);
    r.v.set(0, 0, 0);
    r.q.identity();
    r.axis.set(0, 1, 0);
    r.spin = 0;
    r.fade = 1;
    r.gray = 1;
    r.test = true;
    this.rocks.push(r);
    return r;
  }
}
