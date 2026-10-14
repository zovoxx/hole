#!/usr/bin/env node
// CPU cost of the game logic per frame (Contoo 4 performance pass), in Node with the game's own modules: the field
// (inflow, turn fill, gravity, fuses, collisions), the walls (including the frame a wall is planned) and the instance
// writing (field.render). The GPU side can't be measured here (headless Chromium draws in software); this is the
// main-thread budget. A phone runs JavaScript ~3-5x slower than this machine.
// Usage: node tools/bench.mjs [--seconds 20]
import { THREE, mod, game, seedRandom } from './sim.mjs';

const { knobs } = mod.difficulty;
const args = process.argv.slice(2);
const SECONDS = args.includes('--seconds') ? Number(args[args.indexOf('--seconds') + 1]) : 20;
seedRandom(9);

const pct = (list, p) => list[Math.min(list.length - 1, Math.floor(list.length * p))];
console.log('run time   speed  alive drawn  frame ms (median / 95% / max)   render ms   wall plans ms (n)');
for (const t of [0, 30, 60, 120, 300, 600]) {
  const g = game();
  g.start();
  // jump to t: the difficulty and a field filled at its density
  g.runTime = t;
  g.k = knobs(t);
  g.speed = g.k.speed;
  g.field.setDifficulty(g.k);
  g.field.reset(g.fwd, g.frustum, { speed: g.speed });
  g.walls.reset();
  g.walls.begin(g.k, t);
  g.field.begin();
  g.field.testOnly = true;   // nobody dies: the cost of flying on
  const frame = [];
  const render = [];
  const plans = [];
  let alive = 0;
  let drawn = 0;
  let turnUntil = 0;
  let held = { x: 0, y: 0 };
  for (let i = 0; i < SECONDS * 60; i++) {
    // turn now and then (the turn fill costs too)
    if (g.runTime > turnUntil) {
      const a = Math.random() * Math.PI * 2;
      held = Math.random() < 0.5 ? { x: Math.cos(a), y: Math.sin(a) } : { x: -g.f.cx, y: -g.f.cy };
      turnUntil = g.runTime + 0.2 + Math.random();
    }
    const spawned = g.walls.stats.spawned + g.walls.stats.retries;
    const t0 = performance.now();
    g.step(held);
    const t1 = performance.now();
    g.field.render(g.frustum);
    const t2 = performance.now();
    if (i > 60) {
      frame.push(t2 - t0);
      render.push(t2 - t1);
      alive += g.field.stats.alive;
      drawn += g.field.stats.drawn;
    }
    if (g.walls.stats.spawned + g.walls.stats.retries > spawned) plans.push(g.walls.stats.planMs);
  }
  frame.sort((a, b) => a - b);
  render.sort((a, b) => a - b);
  const n = frame.length;
  console.log(`${String(t).padStart(5)} s   ${g.speed.toFixed(0).padStart(3)} m/s ${String(Math.round(alive / n)).padStart(5)} ${String(Math.round(drawn / n)).padStart(5)}`
    + `   ${pct(frame, 0.5).toFixed(2)} / ${pct(frame, 0.95).toFixed(2)} / ${frame[n - 1].toFixed(1)}`.padEnd(32)
    + `   ${pct(render, 0.5).toFixed(2)}      ${plans.map((p) => p.toFixed(1)).join(', ') || '-'}`);
}
