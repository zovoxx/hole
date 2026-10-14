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
//   comes from behind (fragments and slingshots can be faster; they are dropped once behind and out of view).
// - Difficulty only reaches meteors as they spawn (density, sizes, drift, type, colour); nothing already there
//   changes.
// Contoo 2 (DESIGN §6–7): every rock gets a type when it spawns: rock (gray), decoy (pale to deep yellow),
// exploder (deepest yellow, glowing cracks and a pulse up close, a fuse), big (pulls meteors, small rocks circle it)
// or massive (put near your path every `massiveGap` s: pulls meteors and you, a swarm, a dust ring and the escape
// sheet). Groups that come together (a big rock and its moons, a massive meteor's package) start beyond the far
// edge, invisible, and fade in as they cross it, so nothing pops.
// Contoo 3: walls (walls.js) put their rocks in this field (rock.wall); the inflow thins around each wall
// (inflowScale), new rocks keep out of wall holes, and rocks passing very close are reported as near misses
// (this.misses: the whoosh and a small kick).
import * as THREE from 'three';
import { WORLD, FLIGHT, EXPLODER, EXPLOSION, GRAVITY, SHAKE } from './config.js';
import { createMeteorMesh, tintColor, tellAt, DustRing } from './meteors.js';
import { knobs, linearKnob } from './difficulty.js';
import { setupAttractor, addPull, playerPull, playerRange, orbit, escapeLayout, inHole } from './gravity.js';

const DEG = Math.PI / 180;
const _v = new THREE.Vector3();
const _o = new THREE.Vector3();
const _w = new THREE.Vector3();
const _e = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _sphere = new THREE.Sphere();
const randIn = ([a, b]) => a + Math.random() * (b - a);
const CELL = 100;  // m, gravity grid
const cellKey = (ix, iy, iz) => ((ix + 512) * 1024 + (iy + 512)) * 1024 + (iz + 512);
const randInt = ([a, b]) => a + Math.floor(Math.random() * (b - a + 1));

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

function randomUnit(out) {
  const z = Math.random() * 2 - 1;
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return out.set(r * Math.cos(a), r * Math.sin(a), z);
}

export class MeteorField {
  // shapes = loadMeteors() result (small, big, fragments). set picks the dust ring size; fogDensity fogs the rings.
  constructor(scene, shapes, { set = 'mobile', fogDensity = 0.0066 } = {}) {
    this.scene = scene;
    this.set = set;
    this.fogDensity = fogDensity;
    this.rocks = [];       // alive
    this.free = [];        // pooled rock objects
    this.keepAngle = 70 * DEG;
    this.capacity = Math.ceil(WORLD.maxMeteors * 1.3);
    this.groups = { small: [], big: [], frag: [] };
    for (const [group, list] of [['small', shapes.small], ['big', shapes.big], ['frag', shapes.fragments]]) {
      for (const shape of list ?? []) {
        const cap = group === 'frag' ? 400 : group === 'big' ? Math.ceil(this.capacity * 0.2) : this.capacity;
        const mesh = createMeteorMesh(shape, cap, { fx: true });
        scene.add(mesh);
        this.groups[group].push({
          id: shape.id, group, mesh, fx: mesh.geometry.getAttribute('aFx'), count: 0, cap,
          spheres: shape.collisionSpheres?.length ? shape.collisionSpheres : [[0, 0, 0, shape.collisionRadius]],
          effR: effectiveRadius(shape.collisionSpheres, shape.collisionRadius),
          collisionRadius: shape.collisionRadius ?? 0.8,
          // how far the collision spheres reach from the centre (rock units): what a rock can block at most
          reach: Math.max(shape.collisionRadius ?? 0.8, ...(shape.collisionSpheres ?? [])
            .map(([x, y, z, r]) => Math.hypot(x, y, z) + r)),
          sizeInRock: shape.sizeInRock ?? 0.85,
        });
      }
    }
    this.shapes = [...this.groups.small, ...this.groups.big, ...this.groups.frag];
    if (!this.groups.small.length) throw new Error('no meteor shapes loaded');
    this.sigma = this.meanCrossSection();
    this.density = 0;        // meteors per m³ for new spawns
    this.sizeFactor = 1;
    this.k = knobs(0);       // difficulty knobs for new spawns
    this.speed = 40;
    this.inflowCarry = 0;    // fractional spawns carried to the next frame
    this.turnCarry = 0;
    this.prevFwd = null;
    this.testOnly = false;   // tests: only rocks from placeAhead() / test placements can hit
    this.autoMassive = true; // tests can switch the massive meteors off
    this.densityScale = 1;   // tests and screenshots: 0 = no new field rocks
    this.massiveIn = Infinity;
    this.rings = [];         // dust ring pool
    this.ringScale = 500;
    this.attractors = [];
    this.massives = [];
    this.frameNo = 0;
    this.grid = new Map();   // cell key -> attractors whose reach touches that cell (rebuilt every frame)
    this.gridUsed = [];
    this.gridPool = [];
    this.events = [];        // explosions this frame: { p, s, visible, d } (main.js flashes and kicks)
    this.misses = [];        // near misses this frame: { p (closest point), gap (m), s, speed } (whoosh, kick)
    this.walls = null;       // the Walls (walls.js), set by it
    this.inflowScale = 1;    // the walls thin the inflow around each wall (the calm)
    this.stats = { alive: 0, drawn: 0, target: 0, spawned: 0, explosions: 0, fragments: 0,
                   types: { rock: 0, decoy: 0, exploder: 0, big: 0, massive: 0, frag: 0 } };
  }

  // Mean area of your path a spawned rock blocks (m², player radius included), over shapes and sizes. (A big
  // rock's moons are left out: they stay close to it, so they rarely block a path the big rock doesn't.)
  meanCrossSection(sizeFactor = 1) {
    const pr = FLIGHT.playerRadius;
    const disc = (effR, es, es2) => Math.PI * (effR ** 2 * es2 + 2 * effR * pr * es + pr * pr);
    const part = (list, [a, b], f) => {
      const L = Math.log(b / a);
      const es = ((b - a) / L) * f;                     // E[s], log-uniform
      const es2 = ((b * b - a * a) / (2 * L)) * f ** 2; // E[s²]
      return list.reduce((sum, sh) => sum + disc(sh.effR, es, es2), 0) / list.length;
    };
    const bigShare = this.groups.big.length ? WORLD.big.share : 0;
    return (1 - bigShare) * part(this.groups.small, WORLD.small.radius, sizeFactor)
      + (bigShare ? bigShare * part(this.groups.big, WORLD.big.radius, sizeFactor) : 0);
  }

  // Call when the camera's fov or aspect changes: the kept cone reaches past the view's corners. If it grows
  // (a phone turned to landscape), the new ring around it is filled at once; it lies past the view's corners.
  // heightPx: the drawing buffer height (sizes the dust ring points).
  setView(camera, heightPx = 720, frustum = null) {
    const tv = Math.tan((camera.fov * DEG) / 2);
    const th = tv * camera.aspect;
    const corner = Math.atan(Math.hypot(tv, th));
    const oldCos = this.cosKeep;
    this.keepAngle = Math.min(corner + WORLD.keepMargin * DEG, 100 * DEG);
    this.cosKeep = Math.cos(this.keepAngle);
    this.keepSolid = 2 * Math.PI * (1 - this.cosKeep);
    this.ringScale = heightPx / 2 / tv;
    const fwd = this.prevFwd;
    if (fwd && this.density > 0 && oldCos !== undefined && this.cosKeep < oldCos) {
      const R = WORLD.radius;
      const r0 = WORLD.sideMin;
      const n = Math.round(this.density * 2 * Math.PI * (oldCos - this.cosKeep) * (R ** 3 - r0 ** 3) / 3);
      for (let i = 0; i < n; i++) {
        dirAround(fwd, Math.acos(oldCos - Math.random() * (oldCos - this.cosKeep)), Math.random() * 2 * Math.PI, _v);
        const d = fieldDistance(r0, R, _v, fwd);
        if (d !== null) this.spawn(_v, d, 1, fwd, { speed: this.speed, frustum });
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
    this.density = rho * this.densityScale;
    this.speed = speed;
    this.stats.target = Math.round(rho * volume);
  }

  // All the difficulty knobs for new spawns (knobs() result).
  setDifficulty(k) {
    this.k = k;
    this.setDensity(k.speed, k.pathGap);
  }

  clear() {
    for (const r of this.rocks) this.release(r);
    this.rocks.length = 0;
    this.attractors.length = 0;
    this.massives.length = 0;
    this.events.length = 0;
    this.misses.length = 0;
    this.walls?.reset();
  }

  // Takes a rock out of the field now (tests).
  remove(r) {
    const i = this.rocks.indexOf(r);
    if (i < 0) return;
    this.rocks[i] = this.rocks[this.rocks.length - 1];
    this.rocks.pop();
    this.release(r);
    this.attractors = this.attractors.filter((a) => a.mu > 0);
    this.massives = this.attractors.filter((a) => a.type === 'massive');
  }

  // gone: it blew up (a wall rock then never comes back).
  release(r, gone = false) {
    r.mu = 0;  // (the attractor lists drop it at the end of the frame)
    if (r.wall) {
      this.walls?.released(r, gone);
      r.wall = null;
    }
    if (r.ring) {
      r.ring.detach();
      r.ring = null;
    }
    r.host = null;
    r.holes = null;
    this.free.push(r);
  }

  // A fresh field (a new run, or the start screen): the whole cone filled at once (hidden by a screen), with the
  // first stretch of the path clear and nothing within WORLD.startClear (Contoo 4: rocks a few dozen metres to the
  // side could be turned into less than a second after the view opened).
  reset(fwd, frustum, { speed, attract = false }) {
    this.clear();
    const R = WORLD.radius;
    const r0 = WORLD.startClear;
    const n = Math.round(this.density * this.keepSolid * (R ** 3 - r0 ** 3) / 3);
    for (let i = 0; i < n; i++) {
      dirAround(fwd, Math.acos(1 - Math.random() * (1 - this.cosKeep)), Math.random() * 2 * Math.PI, _v);
      const d = fieldDistance(r0, R, _v, fwd);
      if (d !== null) this.spawn(_v, d, 1, fwd, { speed, attract, clearPath: true, minDist: r0 });
    }
    this.prevFwd = fwd.clone();
    this.inflowCarry = this.turnCarry = 0;
  }

  // The first run starts from the start screen's field: rocks near you that are out of view (beside you, past the
  // view's edge) are taken away, so turning at once never meets a rock you could not have seen. The ones you can see
  // stay (nothing vanishes in view).
  clearNear(r0, frustum) {
    for (let i = this.rocks.length - 1; i >= 0; i--) {
      const r = this.rocks[i];
      if (r.p.length() - r.s > r0 || this.visible(r, frustum)) continue;
      this.release(r);
      this.rocks[i] = this.rocks[this.rocks.length - 1];
      this.rocks.pop();
    }
  }

  // The run begins (from the start screen or a restart): the first massive meteor comes after a while.
  begin() {
    this.massiveIn = this.k.massiveGap * (0.45 + 0.3 * Math.random());
  }

  newRock() {
    const r = this.free.pop() ?? {
      shape: null, s: 1, p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(),
      axis: new THREE.Vector3(), tint: new THREE.Color(), spin: 0, fade: 1, test: false, type: 'rock',
      crack: 0, fuse: -1, farFuse: 0, phase: 0, seed: 0, mu: 0, range: 0, fieldPull: 0, pull: 0, ring: null, holes: null,
      host: null, far: 0, noGrav: false, age: 0, crackNow: 0, glow: 0, aimed: false, absorbed: false,
      fadeRate: 0, fuseLen: 0, wall: null, entry: -1, missed: false,
    };
    r.gen = (r.gen ?? 0) + 1;  // a new life for a pooled object (members check their host's)
    r.fuse = -1;
    r.farFuse = 0;
    r.crack = r.mu = r.range = r.pull = r.far = r.age = r.crackNow = r.glow = 0;
    r.ring = r.holes = r.host = null;
    r.noGrav = r.test = r.aimed = r.absorbed = r.missed = false;
    r.fadeRate = r.fuseLen = 0;   // 0 = the defaults (WORLD.fadeSeconds, EXPLODER.fuseSeconds)
    r.wall = null;
    r.entry = -1;
    r.seed = Math.random();
    r.phase = Math.random() * Math.PI * 2;
    r.tick = Math.floor(Math.random() * 3);  // which frame of three its weak gravity is applied on
    return r;
  }

  // A rock of `type` (rock | decoy | exploder | big | massive | frag) at position p (copied), radius s.
  makeRock(type, shape, p, s, fade) {
    const r = this.newRock();
    r.type = type;
    r.shape = shape;
    r.s = s;
    r.p.copy(p);
    r.v.set(0, 0, 0);
    r.q.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    r.axis.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
    const heavy = type === 'big' || type === 'massive';
    r.spin = logUniform(WORLD.spin) * (heavy ? 0.3 : 1) * (Math.random() < 0.5 ? -1 : 1);
    r.fade = fade;
    const k = this.k;
    if (type === 'decoy') {
      this.tintDecoy(r, 1 - (1 - Math.random()) ** k.decoyDeepBias);
    } else if (type === 'exploder' || type === 'frag') {
      tintColor('exploder', 0, r.tint);
      if (type === 'frag') r.tint.multiplyScalar(0.8);
    } else {
      tintColor('gray', 0, r.tint).multiplyScalar(1 + (Math.random() * 2 - 1) * WORLD.grayJitter);
    }
    if (type === 'exploder') {
      r.crack = 1;
      if (Math.random() < linearKnob(EXPLODER.farShare, k.D)) r.farFuse = randIn(EXPLODER.farFuse);
    }
    this.rocks.push(r);
    this.stats.spawned++;
    return r;
  }

  // A decoy's colour at `shade` (0 pale ... 1 deep), with the deep end where the difficulty has moved it.
  tintDecoy(r, shade) {
    tintColor('decoy', shade, r.tint, this.k.decoyCloseness);
  }

  smallType({ exploders = true } = {}) {
    const u = Math.random();
    if (exploders && u < this.k.exploderShare) return 'exploder';
    if (u < this.k.exploderShare + this.k.decoyShare) return 'decoy';
    return 'rock';
  }

  pickShape(group) {
    const list = this.groups[group];
    return list[Math.floor(Math.random() * list.length)];
  }

  // A new field rock at direction dir (unit) and distance d, faded in by `fade` (0..1). frustum: only spawn it if
  // no part of it is in view. inflow: it arrives through the far cap (a big rock then starts beyond the far edge
  // with its moons). Returns it, or null when it was not placed.
  // minDist: its moons are not placed closer to you than this.
  spawn(dir, d, fade, fwd, { speed, attract = false, clearPath = false, frustum = null, inflow = false, minDist = 0 }) {
    const big = this.groups.big.length && Math.random() < WORLD.big.share;
    const s = logUniform(big ? WORLD.big.radius : WORLD.small.radius) * this.sizeFactor;
    _o.copy(dir).multiplyScalar(d);
    if (big && inflow) _o.addScaledVector(fwd, GRAVITY.big.orbit[1] * s);  // back along its flight line
    d = _o.length();
    if (frustum && this.inView(_o, s, frustum)) return null;
    if ((clearPath || attract) && this.inPath(_o, s, fwd)) return null;  // keep the first stretch of the path empty
    if (this.inAnyHole(_o, s)) return null;
    const r = this.makeRock(big ? 'big' : this.smallType(), this.pickShape(big ? 'big' : 'small'), _o, s, fade);
    if (!attract) {  // behind the start screen nothing drifts into the path
      randomUnit(r.v).multiplyScalar(Math.random() * WORLD.drift * speed * (big ? 0.4 : 1));
    }
    if (big) {
      r.far = Math.max(0, d - WORLD.radius) + 10;
      this.makeAttractor(r, GRAVITY.big);
      this.addMembers(r, GRAVITY.big, { fwd, frustum, clearPath: clearPath || attract, tilt: 50, exploders: false,
                                        minDist: Math.max(minDist, frustum ? WORLD.sideMin : 0) });
    }
    return r;
  }

  inView(p, s, frustum) {
    _sphere.center.copy(p);
    _sphere.radius = s * 1.05 + 1;
    return frustum.intersectsSphere(_sphere);
  }

  inPath(p, s, fwd) {
    const along = p.dot(fwd);
    const side = Math.sqrt(Math.max(0, p.lengthSq() - along * along));
    return along > -s && along < WORLD.clearPath.length && side < s + WORLD.clearPath.margin;
  }

  inAnyHole(p, s) {
    for (const m of this.massives) if (m.holes && inHole(m, p, s)) return true;
    return !!this.walls?.inHole(p, s);
  }

  makeAttractor(r, cfg) {
    setupAttractor(r, cfg.period, cfg.range * r.s);
    r.fieldPull = cfg.fieldPull;
    this.attractors.push(r);
    if (r.type === 'massive') this.massives.push(r);
  }

  // Moons of a big rock or the swarm of a massive meteor, on orbits around it. Members that would be in view
  // (frustum given: out-of-view spawns) or in the clear start path are skipped.
  addMembers(host, cfg, { fwd, frustum = null, clearPath = false, tilt = 12, exploders = true, normal = null, minDist = 0 }) {
    const n = randInt(cfg.members);
    const slings = cfg.slingshot ? Math.max(1, Math.round(n * cfg.slingshot)) : 0;
    const plane = normal ?? randomUnit(new THREE.Vector3());
    const sense = Math.random() < 0.5 ? -1 : 1;
    for (let i = 0; i < n; i++) {
      const sling = i < slings;
      const rOrb = (sling ? randIn([cfg.orbit[1], cfg.orbit[1] * 1.35]) : randIn(cfg.orbit)) * host.s;
      const size = logUniform(cfg.memberSize);
      const o = orbit(host, rOrb, plane, { tilt, sling, sense });
      _w.copy(host.p).add(o.offset);
      if (frustum && this.inView(_w, size, frustum)) continue;
      if (clearPath && this.inPath(_w, size, fwd)) continue;
      if (_w.length() < minDist) continue;
      const m = this.makeRock(this.smallType({ exploders }), this.pickShape('small'), _w, size,
                              _w.length() > WORLD.radius ? 0 : host.fade);
      m.v.copy(host.v).add(o.velocity);
      m.host = host;
      m.hostGen = host.gen;
      m.far = Math.max(0, _w.length() - WORLD.radius) + 10;
    }
    return plane;
  }

  // A massive meteor near your path, beyond the far edge with its swarm, dust ring and escape sheet; they all fade
  // in as they cross the edge. opts: offAxis (deg), phi, s, dist (tests and screenshots).
  spawnMassive(fwd, { speed = this.speed, offAxis = null, phi = null, s = null, dist = null, test = false,
                      shape = null, still = false } = {}) {
    const cfg = GRAVITY.massive;
    if (!this.groups.big.length) return null;
    const size = s ?? logUniform(cfg.radius);
    const swarmR = cfg.orbit[1] * size;
    const d = dist ?? WORLD.radius + swarmR * 1.35 + 15;
    dirAround(fwd, (offAxis ?? randIn(cfg.offAxis)) * DEG, phi ?? Math.random() * Math.PI * 2, _v);
    const fade = d > WORLD.radius ? 0 : 1;
    const big = shape ? this.groups.big.find((g) => g.id === shape) : this.pickShape('big');
    const r = this.makeRock('massive', big, _v.multiplyScalar(d), size, fade);
    if (!still) randomUnit(r.v).multiplyScalar(Math.random() * WORLD.drift * 0.4 * speed);
    r.far = Math.max(0, d - WORLD.radius) + swarmR + 20;
    r.pull = this.k.pull;
    r.test = test;
    this.makeAttractor(r, cfg);
    const normal = randomUnit(new THREE.Vector3());
    this.addMembers(r, cfg, { fwd, normal, tilt: 12 });
    const ring = this.rings.find((g) => !g.host) ?? this.newRing();
    ring.attach(r, normal);
    r.ring = ring;
    // the escape sheet: extra rocks on the far side of you from it, moving with it, with clear holes
    const layout = escapeLayout(r.p, size, swarmR * 1.35, fwd);
    for (const e of layout.rocks) {
      const x = this.makeRock(this.smallType({ exploders: false }), this.pickShape('small'), e.p, e.size,
                              e.p.length() > WORLD.radius ? 0 : 1);
      x.v.copy(r.v);
      x.noGrav = true;
      x.far = Math.max(0, e.p.length() - WORLD.radius) + 10;
      x.test = test;
    }
    r.holes = layout.holes;
    // field rocks already inside a hole are still out in the murk (just faded in): take them out
    for (let i = this.rocks.length - 1; i >= 0; i--) {
      const x = this.rocks[i];
      if (x.mu || x.host || x.noGrav || x.fade >= 1) continue;
      if (inHole(r, x.p, x.s)) {
        this.release(x);
        this.rocks[i] = this.rocks[this.rocks.length - 1];
        this.rocks.pop();
      }
    }
    return r;
  }

  newRing() {
    const ring = new DustRing(this.set, this.fogDensity);
    this.scene.add(ring.points);
    this.rings.push(ring);
    return ring;
  }

  // New rocks this frame: the inflow through the far cap (flying forward), the sliver a turn swept into and the
  // massive meteors.
  feed(dt, fwd, frustum, { speed, flySpeed, attract }) {
    const R = WORLD.radius;
    const opts = { speed, attract };
    // 1. inflow through the far cap: the lines of flight entering it are evenly spread over its projected disc
    //    (radius R·sin keep), so the entry points are cosine-weighted; a rock appears a random depth up to
    //    fadeBand down its line
    const kIn = Math.min(this.keepAngle, Math.PI / 2);
    if (flySpeed > 0) {
      this.inflowCarry += this.density * this.inflowScale * flySpeed * Math.PI * (R * Math.sin(kIn)) ** 2 * dt;
      while (this.inflowCarry >= 1) {
        this.inflowCarry -= 1;
        const theta = Math.asin(Math.sqrt(Math.random()) * Math.sin(kIn));
        dirAround(fwd, theta, Math.random() * 2 * Math.PI, _v);
        _v.multiplyScalar(R).addScaledVector(fwd, -Math.random() * WORLD.fadeBand);
        const d = _v.length();
        this.spawn(_v.divideScalar(d), d, 0, fwd, { ...opts, inflow: true });
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
    // 3. massive meteors near your path, one every massiveGap seconds (with some spread)
    if (!attract && flySpeed > 0 && this.autoMassive) {
      this.massiveIn -= dt;
      if (this.massiveIn <= 0) {
        this.spawnMassive(fwd, { speed });
        this.massiveIn = this.k.massiveGap * (0.7 + 0.6 * Math.random());
      }
    }
  }

  // The pull of the massive meteors on you this frame (gravity.js playerPull): { gx, gy, strength }, drift into
  // `drift` (m/s, world).
  playerPull(fwd, q, drift) {
    return playerPull(this.massives, fwd, q, drift);
  }

  // Attractors by grid cell, so each meteor only looks at the few whose reach covers its cell (all of them for
  // every meteor took ~3 ms a frame at full difficulty).
  buildGrid(atts) {
    for (const list of this.gridUsed) {
      list.length = 0;
      this.gridPool.push(list);
    }
    this.gridUsed.length = 0;
    this.grid.clear();
    for (const a of atts) {
      const r = a.range;
      const x0 = Math.floor((a.p.x - r) / CELL);
      const x1 = Math.floor((a.p.x + r) / CELL);
      const y0 = Math.floor((a.p.y - r) / CELL);
      const y1 = Math.floor((a.p.y + r) / CELL);
      const z0 = Math.floor((a.p.z - r) / CELL);
      const z1 = Math.floor((a.p.z + r) / CELL);
      for (let ix = x0; ix <= x1; ix++) {
        for (let iy = y0; iy <= y1; iy++) {
          for (let iz = z0; iz <= z1; iz++) {
            const key = cellKey(ix, iy, iz);
            let list = this.grid.get(key);
            if (!list) {
              list = this.gridPool.pop() ?? [];
              this.grid.set(key, list);
              this.gridUsed.push(list);
            }
            list.push(a);
          }
        }
      }
    }
  }

  // Moves everything by one frame. move = how far the player flew this frame (world vector) and timeScale
  // slows the meteors' own motion (the hit effect). attract: the start screen (nothing moves on its own, no
  // fuses, no gravity). Returns the rock that hit the player, if any; explosions go to this.events.
  update(dt, { fwd, frustum, move, speed, timeScale = 1, collide = true, attract = false }) {
    const R = WORLD.radius;
    const pr = FLIGHT.playerRadius;
    const sdt = dt * timeScale;
    const own = attract ? 0 : sdt;
    let hit = null;
    const rocks = this.rocks;
    const atts = this.attractors;
    const blasts = [];
    const fuseAhead = (EXPLODER.fuseSeconds + EXPLODER.leadSeconds) * speed;
    const missRange = SHAKE.nearMiss.range;
    this.events.length = 0;
    this.misses.length = 0;
    const gravity = own > 0 && atts.length > 0;
    this.frameNo++;
    if (gravity) this.buildGrid(atts);
    for (let i = rocks.length - 1; i >= 0; i--) {
      const r = rocks[i];
      // gravity bends the paths of every meteor that doesn't pull (the escape sheet keeps its layout): its own
      // host pulls every frame (smooth orbits), the others, weaker, every third frame with 3·dt
      if (r.host && r.host.gen !== r.hostGen) r.host = null;  // the host is gone (its pooled object reused)
      if (gravity && !r.mu && !r.noGrav) {
        if (r.host) addPull(r.host, r.p, own, r.v);
        if ((this.frameNo + r.tick) % 3 === 0) {
          const near = this.grid.get(cellKey(Math.floor(r.p.x / CELL), Math.floor(r.p.y / CELL), Math.floor(r.p.z / CELL)));
          for (let j = 0; near && j < near.length; j++) {
            const a = near[j];
            if (a === r.host) continue;
            const da = addPull(a, r.p, 3 * own * a.fieldPull, r.v);
            // a meteor that falls into a massive one is hidden inside it: gone (big rocks don't swallow, so the
            // field's density stays as planned)
            if (a.pull && da + r.s * 0.3 < GRAVITY.absorb * a.shape.collisionRadius * a.s) r.absorbed = true;
          }
        }
      }
      // relative motion this frame: own drift minus the player's flight
      _o.copy(r.v).multiplyScalar(own).sub(move);
      r.p.add(_o);
      if (r.spin) r.q.premultiply(_q.setFromAxisAngle(r.axis, r.spin * sdt));
      const d = r.p.length();
      if (r.fade < 1 && d <= R) r.fade = Math.min(1, r.fade + dt * (r.fadeRate || 1 / WORLD.fadeSeconds));
      r.age += sdt;
      // drop: past the fog, out of the kept cone and out of view, or swallowed by the rock that pulls it.
      // A massive meteor stays while it still pulls you and is not behind you.
      const cos = d > 1e-6 ? r.p.dot(fwd) / d : 1;
      let drop = d > R + 5 + r.far || r.absorbed;
      if (!drop && cos < this.cosKeep && !this.visible(r, frustum)) {
        drop = !(r.type === 'massive' && cos > GRAVITY.player.behind[0] && d < playerRange(r));
      }
      if (drop) {
        this.release(r);
        rocks[i] = rocks[rocks.length - 1];
        rocks.pop();
        continue;
      }
      if (r.type === 'exploder') {
        this.exploderStep(r, d, sdt, attract, fwd, frustum, fuseAhead);
        if (r.fuse >= (r.fuseLen || EXPLODER.fuseSeconds)) {
          blasts.push(r);
          rocks[i] = rocks[rocks.length - 1];
          rocks.pop();
          continue;
        }
      } else if (r.type === 'frag') {
        r.crackNow = 1.6 * Math.exp(-r.age / 0.7);  // hot broken faces, cooling
        r.glow = 1;
      }
      const stepLen = _o.length();
      if (collide && !hit && (r.test || !this.testOnly) && d < r.s + pr + stepLen + 0.5 && this.hits(r, _o, pr)) hit = r;
      // a near miss: its closest pass this frame, within missRange of its surface (once per rock)
      if (!r.missed && !attract && d < r.s + missRange + stepLen + 1 && stepLen > 1e-6) {
        const t = THREE.MathUtils.clamp(r.p.dot(_o) / (stepLen * stepLen), 0, 1);
        if (t > 0) {
          _w.copy(r.p).addScaledVector(_o, -t);
          const gap = _w.length() - r.s * 0.85;
          if (gap < missRange) {
            r.missed = true;
            this.misses.push({ p: _w.clone(), gap: Math.max(0, gap), s: r.s, speed: stepLen / Math.max(dt, 1e-6) });
          }
        }
      }
    }
    if (blasts.length) {
      const pv = _e.copy(move).divideScalar(Math.max(dt, 1e-6));  // your velocity
      for (const r of blasts) this.explode(r, pv, fwd, frustum);
    }
    // the dust rings follow their massive meteors and show as the tell allows
    for (const ring of this.rings) {
      if (!ring.host) continue;
      const h = ring.host;
      ring.update(sdt, tellAt(h.p.length() - h.s) * h.fade, this.ringScale);
    }
    this.attractors = atts.filter((a) => a.mu > 0);
    this.massives = this.attractors.filter((a) => a.type === 'massive');
    const flySpeed = dt > 0 ? move.dot(fwd) / dt : 0;
    this.feed(dt, fwd, frustum, { speed, flySpeed, attract });
    this.stats.alive = rocks.length;
    return hit;
  }

  // An exploder's fuse and pulse. The fuse lights when it is in view, ahead within EXPLODER.lateral of your path
  // and closer than fuseSeconds + leadSeconds of flight (or, for a few, anywhere in view closer than farFuse).
  exploderStep(r, d, sdt, attract, fwd, frustum, fuseAhead) {
    const E = EXPLODER;
    if (!attract && r.fuse < 0) {
      const along = r.p.dot(fwd);
      const lateral = Math.sqrt(Math.max(0, d * d - along * along));
      const near = along > 0 && along < fuseAhead && lateral < E.lateral + r.s;
      const far = r.farFuse > 0 && d < r.farFuse;
      if ((near || far) && this.visible(r, frustum)) {
        r.fuse = 0;
        r.aimed = near && !far;
      }
    } else if (r.fuse >= 0) {
      r.fuse += sdt;
    }
    const f = r.fuse >= 0 ? Math.min(1, r.fuse / (r.fuseLen || E.fuseSeconds)) : 0;
    r.phase += 2 * Math.PI * (E.pulseHz[0] + (E.pulseHz[1] - E.pulseHz[0]) * f ** 1.5) * sdt;
    r.glow = 0.5 + 0.5 * Math.sin(r.phase);
    r.crackNow = E.crackRest * tellAt(d - r.s) + E.crackFuse * f * f;
  }

  // The exploder r blows up: 6–12 pieces (only if you can see it), a flash and a kick (main.js, from events).
  // pv: your velocity (world, m/s). A piece or two is sent at where you will be if you fly on (it was ahead of you
  // and its fuse lit near your path), missing by up to aimMiss m: steer and it misses.
  explode(r, pv, fwd, frustum) {
    const d = r.p.length();
    const visible = this.visible(r, frustum);
    this.events.push({ p: r.p.clone(), s: r.s, d, visible });
    this.stats.explosions++;
    const frags = this.groups.frag;
    if (visible && frags.length) {
      const X = EXPLOSION;
      const n = randInt(X.pieces);
      const base = r.s * Math.cbrt(4 / n);
      const aimed = r.aimed && r.p.dot(fwd) > 0 ? randInt(X.aimed) : 0;
      const order = frags.map((sh) => ({ sh, k: Math.random() })).sort((a, b) => a.k - b.k).map((o) => o.sh);
      for (let i = 0; i < n; i++) {
        const shape = order[i % order.length];
        const size = base * shape.sizeInRock * randIn(X.pieceSize);
        let u = randIn(X.pieceSpeed);
        randomUnit(_w);
        if (i < aimed) u = this.aim(r, pv, fwd, _w, Math.max(u, X.pieceSpeed[1] * 0.8)) ?? u;
        _v.copy(r.p).addScaledVector(_w, r.s * 0.3);
        const p = this.makeRock('frag', shape, _v, size, 1);
        p.v.copy(r.v).addScaledVector(_w, u);
        p.spin = randIn(X.pieceSpin) * (Math.random() < 0.5 ? -1 : 1);
        p.test = r.test;
        p.aimed = i < aimed;
        this.stats.fragments++;
      }
    }
    this.release(r, true);
  }

  // Sets dir (unit) so a piece leaving r at speed u meets you (flying on at pv) plus a miss offset; returns the
  // speed, or null when it can't reach you.
  aim(r, pv, fwd, dir, u) {
    const miss = randIn(EXPLOSION.aimMiss);
    randomUnit(_s).addScaledVector(fwd, -_s.dot(fwd)).normalize().multiplyScalar(miss);
    const E = _v.copy(r.p).sub(_s);                      // from the miss point
    const W = _a.copy(pv).sub(r.v);                      // you, seen from the rock
    const A = W.dot(W) - u * u;
    const B = -2 * W.dot(E);
    const C = E.dot(E);
    let t;
    if (Math.abs(A) < 1e-6) {
      t = -C / B;
    } else {
      const disc = B * B - 4 * A * C;
      if (disc < 0) return null;
      const t1 = (-B - Math.sqrt(disc)) / (2 * A);
      const t2 = (-B + Math.sqrt(disc)) / (2 * A);
      t = Math.min(t1 > 0 ? t1 : Infinity, t2 > 0 ? t2 : Infinity);
    }
    if (!(t > 0 && t < 6)) return null;
    dir.copy(W).multiplyScalar(t).sub(E).divideScalar(u * t);  // (W t + miss) - r.p, per second, over u
    dir.normalize();
    return u;
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

  // Writes the visible rocks into their instanced meshes: matrix, tint and fx (fade, crack, glow, seed).
  render(frustum) {
    for (const sh of this.shapes) sh.count = 0;
    let drawn = 0;
    const types = this.stats.types;
    for (const k in types) types[k] = 0;
    for (const r of this.rocks) {
      types[r.type]++;
      if (r.fade <= 0 || !this.visible(r, frustum)) continue;
      const sh = r.shape;
      const i = sh.count;
      if (i >= sh.cap) continue;
      _m.compose(r.p, r.q, _s.setScalar(r.s));
      _m.toArray(sh.mesh.instanceMatrix.array, i * 16);
      r.tint.toArray(sh.mesh.instanceColor.array, i * 3);
      const fx = sh.fx.array;
      fx[i * 4] = r.fade;
      fx[i * 4 + 1] = r.crackNow;
      fx[i * 4 + 2] = r.glow;
      fx[i * 4 + 3] = r.seed;
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
      sh.fx.clearUpdateRanges();
      sh.fx.addUpdateRange(0, sh.count * 4);
      sh.fx.needsUpdate = true;
    }
    this.stats.drawn = drawn;
  }

  // Test helper: a rock straight ahead at `dist` metres, not moving; the only kind that hits while testOnly.
  placeAhead(fwd, dist = 60, s = 4) {
    return this.place(fwd, { type: 'rock', dist, s });
  }

  // Test and screenshot helper: a rock of any small type (or big) at `dist` m along fwd turned by `side` / `up`
  // degrees (right / up of the heading, approximately), standing still. fuse: light the fuse now.
  place(fwd, { type = 'rock', dist = 60, s = 4, side = 0, up = 0, shade = 1, shape = null, fuse = false, test = true,
               moons = false }) {
    _v.copy(fwd);
    if (side || up) {
      _a.set(0, 1, 0);
      if (Math.abs(fwd.y) > 0.9) _a.set(1, 0, 0);
      const right = _b.crossVectors(fwd, _a).normalize();
      const upv = _a.crossVectors(right, fwd).normalize();
      _v.addScaledVector(right, Math.tan(side * DEG)).addScaledVector(upv, Math.tan(up * DEG)).normalize();
    }
    const group = type === 'big' ? 'big' : 'small';
    const r = this.makeRock(type, shape ? this.groups[group].find((g) => g.id === shape) : this.groups[group][0],
                            _v.multiplyScalar(dist), s, 1);
    if (type === 'decoy') tintColor('decoy', shade, r.tint, this.k.decoyCloseness);
    r.q.identity();
    r.axis.set(0, 1, 0);
    r.spin = 0;
    r.farFuse = 0;
    r.test = test;
    if (fuse) {
      r.fuse = 0;
      r.aimed = true;
    }
    if (type === 'big') {
      this.makeAttractor(r, GRAVITY.big);
      if (moons) this.addMembers(r, GRAVITY.big, { fwd, tilt: 50, exploders: false });
    }
    return r;
  }
}
