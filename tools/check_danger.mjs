#!/usr/bin/env node
// Check sheet for Contoo 2 (danger): stages scenes in the real game (headless Chromium, PC asset set, 1280x720)
// and composes the screenshots into one labelled sheet.
//   1. exploder (left) next to the deepest decoy (right), same shape and size, at 250 / 160 / 100 / 45 m
//   2. a lit fuse coming at you (the pulse speeds up), the explosion lighting the rocks around it
//   3. a big rock with its moons and a massive meteor with its swarm and dust ring, at 250 / 160 / 90 m
//   4. play: the field with decoys and exploders, a massive meteor ahead with its escape sheet
// Usage: NODE_PATH=$(npm root -g) node tools/check_danger.mjs [out.jpg] [--tiles dir]
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
const OUT = args.find((a) => a.endsWith('.jpg')) ?? path.resolve(HERE, '..', 'docs/checks/contoo2_danger.jpg');
const TILES = args.includes('--tiles') ? args[args.indexOf('--tiles') + 1] : null;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.webp': 'image/webp', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

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
await page.evaluate(() => {
  hole.setRendering(false);
  hole.advance(0);
  document.getElementById('debug')?.remove();
});
await page.keyboard.press('Space');
await page.evaluate(() => hole.advance(0.5));
await new Promise((r) => setTimeout(r, 1500));  // the start screen fades out in real time
await page.addStyleTag({ content: '#debug { display: none !important; }' });

const ev = (fn, arg) => page.evaluate(fn, arg);
const tiles = [];   // { row, label, data }
async function shot(row, label, clip = null) {
  await ev(() => hole.setRendering(true));
  await ev(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const buf = await page.screenshot({ type: 'png', clip: clip ?? undefined, timeout: 120000 });
  await ev(() => hole.setRendering(false));
  tiles.push({ row, label, data: buf.toString('base64') });
  if (TILES) {
    fs.mkdirSync(TILES, { recursive: true });
    fs.writeFileSync(path.join(TILES, `${tiles.length.toString().padStart(2, '0')}.png`), buf);
  }
}
const center = (w, h) => ({ x: (W - w) / 2, y: (H - h) / 2, width: w, height: h });

// 1. doubt: exploder vs deepest decoy
for (const d of [220, 150, 100, 50]) {
  await ev((dist) => {
    hole.stage();
    const a = (Math.atan(10 / dist) * 180) / Math.PI;
    hole.place({ type: 'exploder', dist, s: 6, side: -a, shape: 'rock_01' });
    hole.place({ type: 'decoy', dist, s: 6, side: a, shade: 1, shape: 'rock_01' });
    hole.place({ type: 'rock', dist: dist * 1.15, s: 6, up: (Math.atan(14 / dist) * 180) / Math.PI, shape: 'rock_01' });
    hole.advance(1 / 60);
  }, d);
  await shot(0, `${d} m: exploder · deep decoy · gray`, center(400, 300));
}

// 2. a lit fuse coming at you, then the blast lighting the rocks around it (you fly on at 40 m/s)
await ev(() => {
  hole.stage();
  const ex = hole.place({ type: 'exploder', dist: 152, s: 6, shape: 'rock_04', side: 3, up: 2 });
  window.__ex = ex;
  for (const [side, up, s] of [[-4, 4, 7], [9, -1, 6], [6, 8, 5], [-1, -4, 6]]) hole.place({ type: 'rock', dist: 160, s, side, up });
  hole.advance(0.05);
});
for (const [t, label] of [[0.25, 'fuse 0.3 s'], [1.0, 'fuse 1.3 s'], [0.62, 'fuse 1.9 s']]) {
  await ev((x) => hole.advance(x), t);
  const info = await ev(() => ({ d: __ex.p.length(), fuse: __ex.fuse }));
  await shot(1, `${label} (${Math.round(info.d)} m)`, center(400, 300));
}
await ev(() => {
  for (let i = 0; i < 60 && !hole.fx.flashes.length; i++) hole.advance(1 / 60);
});
const boom = await ev(() => hole.fx.flashes[0]?.p.length() ?? 0);
await shot(1, `blast +0 s (${Math.round(boom)} m)`, center(400, 300));
await ev(() => hole.advance(0.2));
await shot(1, 'blast +0.2 s: pieces, rocks lit', center(400, 300));

// 3. big rock with moons vs massive meteor with swarm and dust ring
for (const d of [250, 160, 90]) {
  await ev((dist) => {
    hole.stage();
    hole.place({ type: 'big', dist, s: 22, shape: 'big_01', moons: true });
    hole.advance(1 / 60);
  }, d);
  await shot(2, `${d} m: big rock + moons`);
  await ev((dist) => {
    hole.stage();
    const m = hole.spawnMassive({ dist, offAxis: 0, s: 22, shape: 'big_01', still: true });
    // the escape sheet is not part of this comparison (it lies off to the side): take it out
    for (const r of [...hole.field.rocks]) if (r.noGrav) hole.field.remove(r);
    m.pull = 0;
    hole.advance(1 / 60);
  }, d);
  await shot(2, `${d} m: massive + swarm + ring`);
}

// 4. play: the field at ~25 s, a massive meteor ahead with its escape sheet
const t0 = await ev(() => {
  hole.field.clear();
  hole.fx.clear();
  hole.field.densityScale = 1;
  hole.field.testOnly = true;     // fly on through everything
  hole.field.autoMassive = false;
  hole.field.setDensity(hole.speed, 11);
  hole.field.reset(hole.fwd, null, { speed: hole.speed });
  hole.advance(22);
  return hole.time;
});
await shot(3, `play at ${Math.round(t0)} s (decoys, exploders, big rocks)`);
await ev(() => {
  hole.field.clear();
  hole.field.densityScale = 0.3;  // a thinner field, so the massive meteor and its sheet show
  hole.field.setDensity(hole.speed, 11);
  hole.field.reset(hole.fwd, null, { speed: hole.speed });
  const m = hole.spawnMassive({ offAxis: 11, phi: 3.3, s: 26 });
  m.pull = 0;  // (the screenshot shouldn't turn into it)
  window.__m = m;
  for (let i = 0; i < 300 && m.p.length() > 160; i++) hole.advance(0.05);
});
const md = await ev(() => Math.round(__m.p.length()));
await shot(3, `a massive meteor ${md} m ahead with its swarm, the escape sheet on its far side (thinner field)`);
const summary = await ev(() => ({ ...hole.field.stats, types: { ...hole.field.stats.types } }));

// compose the sheet
const rows = ['Exploder vs deepest decoy (and a gray rock) by distance: no tell far, faint mid, cracks near',
  'A lit fuse coming at you (pulse speeds up), the blast lighting the rocks around it',
  'Big rock (moons) vs massive meteor (swarm, dust ring) by distance', 'Play'];
const html = `<!doctype html><html><head><style>
  body { margin: 0; background: #0b0d12; color: #cfd6e4; font: 13px/1.3 system-ui, sans-serif; padding: 10px; width: 1700px; }
  h1 { font-size: 18px; margin: 4px 0 8px; } h2 { font-size: 14px; margin: 12px 0 6px; color: #9fb0cc; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; } figure { margin: 0; } figcaption { padding: 3px 0; }
  img { display: block; border: 1px solid #2a3040; } .t img { width: 270px; } .w img { width: 410px; } .p img { width: 830px; }
</style></head><body><h1>Hole: Contoo 2 danger check (PC set, 1280x720; rows 1–2 are 1:1 crops of 400x300, rows 3–4 whole frames)</h1>
${rows.map((title, r) => `<h2>${title}</h2><div class="row ${['t', 't', 'w', 'p'][r]}">${tiles.filter((t) => t.row === r)
    .map((t) => `<figure><img src="data:image/png;base64,${t.data}"><figcaption>${t.label}</figcaption></figure>`).join('')}</div>`).join('')}
</body></html>`;
const sheet = await browser.newPage({ viewport: { width: 1720, height: 800 } });
await sheet.setContent(html);
await sheet.screenshot({ path: OUT, type: 'jpeg', quality: 82, fullPage: true, timeout: 300000 });
console.log(`wrote ${OUT}`);
console.log('field after the play shots:', JSON.stringify(summary.types), `explosions ${summary.explosions}`);
console.log(problems.length ? `console errors: ${problems.slice(0, 5).join(' | ')}` : 'no console errors');
await browser.close();
server.close();
process.exit(problems.length ? 1 : 0);
