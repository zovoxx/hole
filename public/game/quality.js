// Adaptive quality (Contoo 4, TECH "Devices"): if frames keep coming slower than QUALITY.slowFps, the drawing
// resolution (the pixel ratio) steps down. If a step brings no speed-up it tries the next one (with vsync a frame
// takes 16.7 or 33.3 ms, so one step may not show); if even the lowest brings nothing, it goes back to where it was
// and stops adapting: then the limit is not the drawing (a 30 fps power-saving cap, or the CPU), and a blurrier view
// would buy nothing.
// It never steps back up during a visit (a stutter that came back would be worse than a slightly softer view).
// Pure logic (no DOM), so tools/test_world.mjs can drive it with made-up frame times.
import { QUALITY } from './config.js';

export class Quality {
  // base: the pixel ratio to start from (devicePixelRatio, capped per asset set).
  constructor(base, cfg = QUALITY) {
    this.cfg = cfg;
    this.levels = [];
    for (const k of cfg.steps) {
      const r = Math.max(cfg.floor, Math.round(base * k * 100) / 100);
      if (!this.levels.length || r < this.levels[this.levels.length - 1] - 0.01) this.levels.push(r);
    }
    this.level = 0;
    this.state = 'watch';   // watch -> trial (a step was taken) -> watch, or done
    this.samples = [];
    this.sum = 0;
    this.settle = 0;
    this.before = 0;
    this.from = 0;
  }

  get pixelRatio() {
    return this.levels[this.level];
  }

  // One frame: dt = seconds since the last one; active = something moving is on screen. Returns the new pixel
  // ratio when it changes, else null.
  update(dt, active = true) {
    if (this.state === 'done' || !active || dt <= 0 || dt > 0.1) return null;  // (stalls, hidden tabs)
    if (this.settle > 0) {
      this.settle -= dt;
      return null;
    }
    this.samples.push(dt);
    this.sum += dt;
    if (this.sum < this.cfg.window) return null;
    const sorted = this.samples.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.samples.length = 0;
    this.sum = 0;
    if (this.state === 'trial') {
      if (median < this.before * (1 - this.cfg.gain)) {
        this.state = 'watch';      // it helped; keep watching (it may step again)
      } else if (this.level < this.levels.length - 1) {
        this.level++;              // not yet: one more step
        this.settle = this.cfg.settle;
        return this.pixelRatio;
      } else {
        this.level = this.from;    // even the lowest didn't: the drawing is not the limit
        this.state = 'done';
        return this.pixelRatio;
      }
    }
    if (median > 1 / this.cfg.slowFps && this.level < this.levels.length - 1) {
      this.before = median;
      this.from = this.level;
      this.level++;
      this.state = 'trial';
      this.settle = this.cfg.settle;
      return this.pixelRatio;
    }
    return null;
  }
}
