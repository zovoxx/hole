// Effects in space (TECH "Camera effects"): explosion flashes and the camera shake stack.
// - Flash: a pool of point lights (always in the scene, so the shaders never recompile; intensity 0 when idle)
//   lights the rocks around an explosion, plus an additive glow sprite at the explosion whose size is capped by
//   its distance, so it never covers the screen. A far flash still glows faintly through the fog.
// - Kick: a short smooth wobble of the view (pitch and yaw only, never roll), stronger the closer the
//   explosion; several kicks add up but the sum is capped. Only the canvas camera moves, never the HUD.
// Contoo 3 (DESIGN §10, `SHAKE`): the other layers, all smooth sums of sines (never random per frame), with
// amplitudes that glide, summed with the kicks and capped at SHAKE.maxDegrees:
// - handling: always a little, more the harder you steer against your own momentum (flight.js strain);
// - gravity: a deep slow rumble with the pull of a massive meteor, plus the lean: a roll toward it (up to 25°,
//   the only roll in the game, easing back once you are free), a darker screen edge on its side and a slight
//   stretch of the view along its direction;
// - near miss: a small kick away from a rock that passes very close.
import * as THREE from 'three';
import { EXPLOSION, SPRITES, SHAKE } from './config.js';
import { spriteMaterial } from './sprites.js';

const DEG = Math.PI / 180;
const _axis = new THREE.Vector3();
const TAU = Math.PI * 2;

// Smooth noise in -1..1: three sines at unrelated frequencies with random phases.
class Wobble {
  constructor(hz) {
    this.hz = hz;
    this.phase = hz.map(() => [Math.random() * TAU, Math.random() * TAU]);
  }

  at(t) {
    let x = 0;
    let y = 0;
    const w = [1, 0.6, 0.35];
    for (let i = 0; i < this.hz.length; i++) {
      x += w[i] * Math.sin(TAU * this.hz[i] * t + this.phase[i][0]);
      y += w[i] * Math.sin(TAU * this.hz[i] * 1.13 * t + this.phase[i][1]);
    }
    return [x / 1.95, y / 1.95];
  }
}

export class Fx {
  constructor(scene, flashTextures, fogDensity) {
    this.fogDensity = fogDensity;
    this.lights = [0, 1].map(() => {
      const light = new THREE.PointLight(SPRITES.flash.color, 0, EXPLOSION.lightRange, 2);
      scene.add(light);
      return { light, owner: null };
    });
    this.glows = [];
    const tex = flashTextures?.[0]?.texture;
    for (let i = 0; i < 6; i++) {
      const material = spriteMaterial(tex ?? null, { ...SPRITES.flash, additive: true });
      material.fog = false;  // faded by hand: a flash shows a little further into the murk than a rock
      material.color.multiplyScalar(EXPLOSION.glowGain);
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      sprite.renderOrder = 5;
      scene.add(sprite);
      this.glows.push(sprite);
    }
    this.flashes = [];   // { p, s, t, glow, light }
    this.kicks = [];     // { t, amp, ax, ay, phase, hz, seconds }
    this.kickX = 0;      // current shake (all layers), radians (pitch, yaw)
    this.kickY = 0;
    this.t = 0;
    this.handling = new Wobble(SHAKE.handling.hz);
    this.rumble = new Wobble(SHAKE.rumble.hz);
    this.amp = { handling: 0, rumble: 0 };   // gliding amplitudes (deg)
    this.lean = 0;       // roll toward a massive meteor (radians, + = counterclockwise on screen)
    this.side = { amount: 0, angle: 0 };     // the darker edge and the stretch: how much, which way (screen rad)
    this.stats = { flashes: 0, nearMisses: 0 };
  }

  clear() {
    for (const f of this.flashes) this.release(f);
    this.flashes.length = 0;
    this.kicks.length = 0;
    this.kickX = this.kickY = 0;
    this.amp.handling = this.amp.rumble = 0;
    this.lean = 0;
    this.side.amount = 0;
  }

  // An explosion at p (world, the player at the origin) of a rock of radius s.
  explode(p, s) {
    const glow = this.glows.find((g) => !g.visible && !this.flashes.some((f) => f.glow === g)) ?? null;
    const f = { p: p.clone(), s, t: 0, glow, light: null };
    // the newest flash takes a light (the oldest gives its own up when both are busy)
    let slot = this.lights.find((l) => !l.owner);
    if (!slot) slot = this.lights.reduce((a, b) => (a.owner.t > b.owner.t ? a : b));
    if (slot.owner) slot.owner.light = null;
    slot.owner = f;
    f.light = slot;
    this.flashes.push(f);
    this.stats.flashes++;
    const d = p.length();
    const near = 1 - d / EXPLOSION.kickRange;
    if (near > 0) {
      const phi = Math.random() * Math.PI * 2;
      this.kicks.push({ t: 0, amp: EXPLOSION.kickDegrees * DEG * near * near * Math.sqrt(s / 7),
                        ax: Math.cos(phi), ay: Math.sin(phi), phase: Math.random() * 0.6,
                        hz: 8, seconds: EXPLOSION.kickSeconds });
    }
    return f;
  }

  // A rock passed close: a small kick away from it. side = (x, y) of the rock's closest point in camera space;
  // gap = m from its surface; s = its radius. Returns the strength 0..1 (for the whoosh).
  nearMiss(sx, sy, gap, s) {
    const N = SHAKE.nearMiss;
    const k = (1 - Math.min(1, gap / N.range)) * Math.min(1, Math.sqrt(s / 6));
    if (k <= 0.02) return 0;
    const l = Math.hypot(sx, sy) || 1;
    // pushed away from the rock: the view turns away (pitch with -y, yaw with x)
    this.kicks.push({ t: 0, amp: N.degrees * DEG * k, ax: -sy / l, ay: sx / l, phase: 0, hz: N.hz, seconds: N.seconds });
    this.stats.nearMisses++;
    return k;
  }

  release(f) {
    if (f.glow) f.glow.visible = false;
    if (f.light) {
      f.light.light.intensity = 0;
      f.light.owner = null;
    }
  }

  // move: how far the player flew this frame (space moves the other way). Optional camera layers (the run):
  // strain 0..1 (steering against your momentum), pull { strength, gx, gy } (a massive meteor's, camera space).
  update(dt, move, { strain = 0, pull = null } = {}) {
    this.t += dt;
    const T = EXPLOSION.flashSeconds;
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += dt;
      f.p.sub(move);
      if (f.t >= T) {
        this.release(f);
        this.flashes.splice(i, 1);
        continue;
      }
      const k = f.t < 0.04 ? f.t / 0.04 : Math.exp(-(f.t - 0.04) * 6) * (1 - f.t / T);  // fast rise, soft fade
      if (f.light) {
        f.light.light.position.copy(f.p);
        f.light.light.intensity = EXPLOSION.light * (f.s / 7) * k;
      }
      if (f.glow) {
        const d = f.p.length();
        const vis = Math.exp(-((this.fogDensity * d) ** 2));
        const grow = 0.55 + 0.45 * Math.sqrt(Math.min(1, f.t / 0.25));
        const size = Math.min(EXPLOSION.glow * f.s * grow, EXPLOSION.glowMaxView * d);
        f.glow.position.copy(f.p);
        f.glow.scale.setScalar(size);
        f.glow.material.opacity = k * vis ** 0.45;
        f.glow.visible = f.glow.material.opacity > 0.004;
      }
    }
    // kicks: damped wobbles
    let x = 0;
    let y = 0;
    for (let i = this.kicks.length - 1; i >= 0; i--) {
      const kk = this.kicks[i];
      kk.t += dt;
      if (kk.t >= kk.seconds) {
        this.kicks.splice(i, 1);
        continue;
      }
      const end = 1 - kk.t / kk.seconds;
      const w = kk.amp * Math.exp(-kk.t / 0.14) * end * Math.sin(TAU * kk.hz * kk.t + 1.2 + kk.phase);
      x += kk.ax * w;
      y += kk.ay * w;
    }
    // handling rattle and gravity rumble: smooth noise with gliding amplitudes
    const glide = 1 - Math.exp(-dt / SHAKE.smooth);
    const strength = pull?.strength ?? 0;
    this.amp.handling += (SHAKE.handling.base + SHAKE.handling.strain * strain - this.amp.handling) * glide;
    this.amp.rumble += (SHAKE.rumble.degrees * Math.min(1, strength / SHAKE.lean.full) - this.amp.rumble) * glide;
    const [hx, hy] = this.handling.at(this.t);
    const [rx, ry] = this.rumble.at(this.t);
    x += (hx * this.amp.handling + rx * this.amp.rumble) * DEG;
    y += (hy * this.amp.handling + ry * this.amp.rumble) * DEG;
    const len = Math.hypot(x, y);
    const max = SHAKE.maxDegrees * DEG;
    if (len > max) {
      x *= max / len;
      y *= max / len;
    }
    this.kickX = x;
    this.kickY = y;
    // the lean toward a massive meteor: a roll from its sideways direction, a darker edge and a stretch toward it
    const L = SHAKE.lean;
    const amount = Math.min(1, strength / L.full);
    const g = pull ? Math.hypot(pull.gx, pull.gy) : 0;
    const target = g > 1e-6 ? -L.degrees * DEG * amount * (pull.gx / g) : 0;
    const tau = Math.abs(target) > Math.abs(this.lean) ? L.seconds : L.back;
    this.lean += (target - this.lean) * (1 - Math.exp(-dt / tau));
    this.side.amount += (amount - this.side.amount) * (1 - Math.exp(-dt / (amount > this.side.amount ? L.seconds : L.back)));
    if (g > 1e-6) this.side.angle = Math.atan2(pull.gy, pull.gx) - this.lean;  // on screen (the roll turns it)
  }

  // Stops the layers that belong to flying (the hit and game-over screens keep only kicks and flashes).
  calm() {
    this.amp.handling = this.amp.rumble = 0;
  }

  // The camera offset rotation of the shake (pitch and yaw in camera space, no roll).
  kickRotation(out) {
    const a = Math.hypot(this.kickX, this.kickY);
    if (a < 1e-7) return out.identity();
    return out.setFromAxisAngle(_axis.set(this.kickX / a, this.kickY / a, 0), a);
  }

  // The lean (roll about the view axis).
  leanRotation(out) {
    return out.setFromAxisAngle(_axis.set(0, 0, 1), this.lean);
  }
}
