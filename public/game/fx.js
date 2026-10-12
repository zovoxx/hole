// Effects in space (TECH "Camera effects"): explosion flashes and the camera kick. Contoo 3 adds the other shake
// layers (handling, gravity rumble and lean, near miss) to the same stack.
// - Flash: a pool of point lights (always in the scene, so the shaders never recompile; intensity 0 when idle)
//   lights the rocks around an explosion, plus an additive glow sprite at the explosion whose size is capped by
//   its distance, so it never covers the screen. A far flash still glows faintly through the fog.
// - Kick: a short smooth wobble of the view (pitch and yaw only, never roll), stronger the closer the
//   explosion; several kicks add up but the sum is capped. Only the canvas camera moves, never the HUD.
import * as THREE from 'three';
import { EXPLOSION, SPRITES } from './config.js';
import { spriteMaterial } from './sprites.js';

const DEG = Math.PI / 180;
const MAX_KICK = 4.5 * DEG;
const _axis = new THREE.Vector3();

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
    this.kicks = [];     // { t, amp, ax, ay, phase }
    this.kickX = 0;      // current kick, radians (pitch, yaw)
    this.kickY = 0;
    this.stats = { flashes: 0 };
  }

  clear() {
    for (const f of this.flashes) this.release(f);
    this.flashes.length = 0;
    this.kicks.length = 0;
    this.kickX = this.kickY = 0;
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
                        ax: Math.cos(phi), ay: Math.sin(phi), phase: Math.random() * 0.6 });
    }
    return f;
  }

  release(f) {
    if (f.glow) f.glow.visible = false;
    if (f.light) {
      f.light.light.intensity = 0;
      f.light.owner = null;
    }
  }

  // move: how far the player flew this frame (space moves the other way).
  update(dt, move) {
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
    // kicks: damped wobbles, summed and capped
    let x = 0;
    let y = 0;
    for (let i = this.kicks.length - 1; i >= 0; i--) {
      const kk = this.kicks[i];
      kk.t += dt;
      if (kk.t >= EXPLOSION.kickSeconds) {
        this.kicks.splice(i, 1);
        continue;
      }
      const end = 1 - kk.t / EXPLOSION.kickSeconds;
      const w = kk.amp * Math.exp(-kk.t / 0.14) * end * Math.sin(2 * Math.PI * 8 * kk.t + 1.2 + kk.phase);
      x += kk.ax * w;
      y += kk.ay * w;
    }
    const len = Math.hypot(x, y);
    if (len > MAX_KICK) {
      x *= MAX_KICK / len;
      y *= MAX_KICK / len;
    }
    this.kickX = x;
    this.kickY = y;
  }

  // The camera offset rotation of the active kicks (pitch and yaw in camera space, no roll).
  kickRotation(out) {
    const a = Math.hypot(this.kickX, this.kickY);
    if (a < 1e-7) return out.identity();
    return out.setFromAxisAngle(_axis.set(this.kickX / a, this.kickY / a, 0), a);
  }
}
