#!/usr/bin/env node
// Check sheet for Contoo 3 (pressure): stages scenes in the real game (headless Chromium, PC asset set, 1280x720)
// and composes the screenshots into one labelled sheet.
//   1. a wall early in a run (4 s warning): coming out of the murk, its holes, steering for one, through it
//   2. a wall late in a run (2 s warning, red-black space, exploders in it)
//   3. the lean near a massive meteor (roll, darker edge, stretch); space at the start vs. ten minutes in
//   4. the start screen with the settings panel; the debug read-out switched on
// Usage: NODE_PATH=$(npm root -g) node tools/check_pressure.mjs [out.jpg] [--tiles dir]
// Headless Chromium draws with a software rasterizer, so the game runs on its test clock (?debug, hole.advance)
// and drawing is switched on only for each screenshot.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'public');
const args = process.argv.slice(2);
const OUT = args.find((a) => a.endsWith('.jpg')) ?? path.resolve(HERE, '..', 'docs/checks/contoo3_pressure.jpg');
const TILES = args.includes('--tiles') ? args[args.indexOf('--tiles') + 1] : null;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.webp': 'image/webp', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(ROOT, url);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (url.endsWith('/')) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const W = 1280;
const H = 720;
const page = await browser.newPage({ viewport: { width: W, height: H } });
const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
page.on('pageerror', (e) => problems.push(e.message));
await page.goto(`${base}/index.html?debug&set=pc`);
await page.waitForFunction(() => window.hole?.mode === 'start', null, { timeout: 120000 });
await page.evaluate(() => { hole.setRendering(false); hole.advance(0); });

const ev = (fn, arg) => page.evaluate(fn, arg);
const tiles = [];   // { row, label, data }
async function shot(row, label) {
  await ev(() => hole.setRendering(true));
  await ev(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const buf = await page.screenshot({ type: 'png', timeout: 300000 });
  await ev(() => hole.setRendering(false));
  tiles.push({ row, label, data: buf.toString('base64') });
  if (TILES) {
    fs.mkdirSync(TILES, { recursive: true });
    fs.writeFileSync(path.join(TILES, `${tiles.length.toString().padStart(2, '0')}.png`), buf);
  }
}

// 4a. the start screen with the settings open (before any run)
await ev(() => { hole.advance(1); hole.ui.openSettings(); });
await new Promise((r) => setTimeout(r, 800));  // (the screens fade in real time)
await shot(3, 'start screen, settings open (defaults: music 80%, sounds 80%, debug off)');
await ev(() => hole.ui.closeSettings());
await new Promise((r) => setTimeout(r, 400));  // (a key right after closing the panel is ignored)
// a run (again, if a scene ended in a hit)
async function ensureRun() {
  if (await ev(() => hole.mode) === 'run') return;
  await ev(() => hole.advance(2));
  await page.keyboard.press('KeyK');
  await ev(() => hole.advance(0.5));
  await new Promise((r) => setTimeout(r, 1500));  // (the screens fade in real time)
}
await ensureRun();

// A thinner field (so the wall reads), no automatic walls or massive meteors, fly through everything.
const prepare = async (t) => { await ensureRun(); await ev((rt) => {
  hole.setRunTime(rt);
  hole.advance(1 / 60);
  hole.field.clear();
  hole.fx.clear();
  hole.flight.cx = hole.flight.cy = hole.flight.wx = hole.flight.wy = 0;
  hole.field.autoMassive = false;
  hole.walls.auto = false;
  hole.field.testOnly = true;
  hole.field.densityScale = 0.5;
  hole.field.setDifficulty(hole.field.k);
  hole.field.reset(hole.fwd, null, { speed: hole.speed });
  hole.advance(0.2);
}, t); };

// 1. an early wall: 4 s of warning, two holes; the pilot steers for one 0.6 s after it appears
await prepare(5);
const w1 = await ev(() => {
  // the layout asked for (if it passes the checks with the rocks there now), else the wall's own choice
  let w = hole.spawnWall({ holes: [{ off: 17, phi: 140 }, { off: 21, phi: 320 }] });
  for (let i = 0; i < 20 && !w; i++) w = hole.spawnWall();
  window.__w = w;
  return { L: w.L, warn: w.warn, holes: w.holes.length, rocks: w.alive };
});
await ev(() => hole.advance(0.35));
await shot(0, `early wall, ${Math.round(w1.L)} m / ${w1.warn.toFixed(1)} s ahead: appears (0.35 s)`);
await ev(() => hole.advance(0.25));
await ev(async () => {
  const { pilot } = await import('./game/walls.js');
  const w = window.__w;
  const h = w.holes[0];
  const target = new (hole.fwd.constructor)();
  window.__fly = (seconds) => {
    // the pilot's held direction drives the circle in place of the buttons
    const update = hole.input.update;
    let held = { x: 0, y: 0 };
    hole.input.update = () => held;
    for (let i = 0; i < seconds * 60; i++) {
      target.copy(w.center).addScaledVector(h.dir, w.L + 30);
      held = pilot(hole.flight, hole.q, target, hole.pull, 1 / 60);
      hole.advance(1 / 60);
    }
    hole.input.update = update;
  };
});
await ev(() => window.__fly(0.6));
await shot(0, `out of the murk (1.2 s): ${w1.holes} hole(s); steering for one since 0.6 s`);
await ev(() => window.__fly(1.4));
await shot(0, 'steering for the hole (2.6 s)');
await ev(() => window.__fly(0.95));
await shot(0, `in the hole (3.55 s): ${await ev(() => (hole.mode === 'run' ? 'still flying' : hole.mode))}`);

// 2. a late wall: 2 s of warning, red-black space, exploders in the wall
await prepare(600);
const w2 = await ev(() => {
  let w = null;
  w = hole.spawnWall({ holes: [{ off: 14, phi: 30 }] });
  for (let i = 0; i < 20 && !w; i++) w = hole.spawnWall();
  return { L: w.L, warn: w.warn, ex: w.rocks.filter((r) => r && r.type === 'exploder').length };
});
for (const [t, label] of [[0.3, 'appears (0.3 s)'], [0.6, 'its hole (0.9 s), exploders lit']]) {
  await ev((x) => hole.advance(x), t);
  await shot(1, `late wall (10 min), ${Math.round(w2.L)} m / ${w2.warn.toFixed(1)} s ahead: ${label}`);
}
await ev(() => hole.advance(0.35));
await shot(1, 'a wall exploder blows up 1.2 s before the wall');

// 3. the lean near a massive meteor, holding against it; space at the start vs ten minutes in
await prepare(240);
const lean = await ev(() => {
  hole.field.densityScale = 0.35;
  hole.field.clear();
  hole.field.setDifficulty(hole.field.k);
  hole.field.reset(hole.fwd, null, { speed: hole.speed });
  const m = hole.spawnMassive({ dist: 85, offAxis: 42, phi: 1.9, s: 26, still: true, shape: 'big_01' });
  hole.advance(1 / 60);
  const g = Math.hypot(hole.pull.gx, hole.pull.gy) || 1;
  hole.flight.cx = (-hole.pull.gx / g) * 0.6;
  hole.flight.cy = (-hole.pull.gy / g) * 0.6;
  hole.advance(1.1);
  return { lean: (hole.fx.lean * 180) / Math.PI, pull: hole.pull.strength, d: m.p.length() };
});
await shot(2, `pulled by a massive meteor ${Math.round(lean.d)} m away, holding against it: lean ${Math.abs(lean.lean).toFixed(0)}°, darker edge, stretch`);
await prepare(1);
await ev(() => hole.advance(0.5));
await shot(2, 'space at the start: blue-black');
await prepare(600);
await ev(() => { hole.field.densityScale = 0.5; hole.advance(0.5); });
await shot(2, 'ten minutes in: red-black, thicker dust (field thinned for the picture)');

// 4b. the debug read-out switched on
await ev(() => document.querySelector('#settings .toggle').dispatchEvent(new MouseEvent('click')));
await ev(() => { hole.field.densityScale = 1; hole.field.setDifficulty(hole.field.k); hole.advance(0.5); });
await new Promise((r) => setTimeout(r, 600));
await shot(3, 'the debug read-out, switched on in the settings (top left)');

const rows = ['A wall early in a run (4 s warning; the pilot steers 0.6 s after it appears)',
  'A wall late in a run (2 s warning, exploders in it)', 'The lean; how deep space looks', 'Settings'];
const html = `<!doctype html><html><head><style>
  body { margin: 0; background: #0b0d12; color: #cfd6e4; font: 13px/1.3 system-ui, sans-serif; padding: 10px; width: 1700px; }
  h1 { font-size: 18px; margin: 4px 0 8px; } h2 { font-size: 14px; margin: 12px 0 6px; color: #9fb0cc; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; } figure { margin: 0; width: 416px; } figcaption { padding: 3px 0; }
  img { display: block; width: 416px; border: 1px solid #2a3040; } .r3 figure, .r3 img, .r2 figure, .r2 img { width: 556px; }
</style></head><body><h1>Hole: Contoo 3 pressure check (PC set, 1280x720 frames)</h1>
${rows.map((title, r) => `<h2>${title}</h2><div class="row r${r}">${tiles.filter((t) => t.row === r)
    .map((t) => `<figure><img src="data:image/png;base64,${t.data}"><figcaption>${t.label}</figcaption></figure>`).join('')}</div>`).join('')}
</body></html>`;
const sheet = await browser.newPage({ viewport: { width: 1720, height: 800 } });
await sheet.setContent(html);
await sheet.screenshot({ path: OUT, type: 'jpeg', quality: 80, fullPage: true, timeout: 300000 });
console.log(`wrote ${OUT}`);
console.log(`early wall ${JSON.stringify(w1)}, late wall ${JSON.stringify(w2)}, lean ${JSON.stringify(lean)}`);
console.log(problems.length ? `console errors: ${problems.slice(0, 5).join(' | ')}` : 'no console errors');
await browser.close();
server.close();
process.exit(problems.length ? 1 : 0);
