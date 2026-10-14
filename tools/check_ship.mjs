#!/usr/bin/env node
// Check sheet for Contoo 4 (tune and ship): stages scenes in the real game (headless Chromium) and composes the
// screenshots into one labelled sheet.
//   1. the far LOD on PC: the same frame two minutes into a run with and without it (triangles drawn)
//   2. a fresh run just after a restart: nothing within WORLD.startClear
//   3. the screens: loading (phone), start (iPad), paused (phone), game over (PC)
// Usage: NODE_PATH=$(npm root -g) node tools/check_ship.mjs [out.jpg] [--tiles dir]
// Headless Chromium draws with a software rasterizer, so the game runs on its test clock (?debug, hole.advance)
// and drawing is switched on only for each screenshot.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'public');
const args = process.argv.slice(2);
const OUT = args.find((a) => a.endsWith('.jpg')) ?? path.resolve(HERE, '..', 'docs/checks/contoo4_ship.jpg');
const TILES = args.includes('--tiles') ? args[args.indexOf('--tiles') + 1] : null;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.webp': 'image/webp', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg' };

let glbDelay = 0;   // ms: holds the meteors back, so the loading screen can be caught
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(ROOT, url);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (url.endsWith('/')) file = path.join(file, 'index.html');
  setTimeout(() => fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  }), file.endsWith('.glb') ? glbDelay : 0);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const problems = [];
const tiles = [];   // { row, label, data, w }

async function open(contextOptions, query = '?debug') {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(e.message));
  await page.goto(`${base}/index.html${query}`);
  return page;
}
const ready = async (page) => {
  await page.waitForFunction(() => window.hole?.mode === 'start', null, { timeout: 120000 });
  await page.evaluate(() => { hole.setRendering(false); hole.setTestOnly(true); hole.advance(0); });
};
async function shot(page, row, label, { draw = true } = {}) {
  if (draw) {
    await page.evaluate(() => hole.setRendering(true));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }
  await new Promise((r) => setTimeout(r, 450));   // screen fades (0.35 s)
  const buf = await page.screenshot({ type: 'png', timeout: 300000 });
  if (draw) await page.evaluate(() => hole.setRendering(false));
  tiles.push({ row, label, data: buf.toString('base64'), w: page.viewportSize().width });
  if (TILES) {
    fs.mkdirSync(TILES, { recursive: true });
    fs.writeFileSync(path.join(TILES, `${tiles.length.toString().padStart(2, '0')}.png`), buf);
  }
}

// 1. far LOD on PC, and 2. a fresh run after a restart
const pc = await open({ viewport: { width: 1280, height: 720 } }, '?debug&set=pc');
await ready(pc);
await pc.waitForFunction(() => hole.field.groups.small.every((s) => s.far), null, { timeout: 120000 });
await pc.keyboard.press('KeyW');
await pc.evaluate(() => { hole.setRunTime(120); hole.advance(5); });
const lodOn = await pc.evaluate(() => ({ ...hole.field.stats, types: null }));
await shot(pc, 0, `far LOD on: ${lodOn.far} of ${lodOn.drawn} rocks drawn with the mobile mesh`);
const trisOn = await pc.evaluate(() => hole.renderer.info.render.triangles);
await pc.evaluate(() => {
  for (const s of hole.field.groups.small) { s.saved = s.far; s.far.mesh.count = 0; s.far = null; }
  hole.advance(1 / 60);
});
await shot(pc, 0, 'far LOD off (the next frame): every rock with its PC mesh');
const trisOff = await pc.evaluate(() => hole.renderer.info.render.triangles);
tiles[0].label += ` (${(trisOn / 1e6).toFixed(2)} M triangles)`;
tiles[1].label += ` (${(trisOff / 1e6).toFixed(2)} M triangles)`;
await pc.evaluate(() => { for (const s of hole.field.groups.small) s.far = s.saved; hole.placeAhead(20, 6); hole.advance(2); });
await pc.waitForTimeout(600);
await pc.keyboard.press('KeyK');   // restart: a fresh field behind the closed view
await pc.evaluate(() => hole.advance(0.6));
const near = await pc.evaluate(() => Math.min(...hole.field.rocks.map((r) => r.p.length() - r.s)));
await shot(pc, 1, `a fresh run 0.6 s after a restart: the nearest rock surface is ${near.toFixed(0)} m away (nothing within 80 m when the view opened)`);
await pc.evaluate(() => { hole.placeAhead(20, 6); hole.advance(2); });
await shot(pc, 2, 'game over (PC)');

// 3. the screens on devices
glbDelay = 6000;
const phone = await open(devices['iPhone 13']);
await phone.waitForTimeout(2500);
await shot(phone, 2, 'loading (phone)', { draw: false });
glbDelay = 0;
await ready(phone);
await phone.evaluate(() => {
  document.getElementById('start').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  hole.advance(3);
  Object.defineProperty(document, 'hidden', { value: true, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
  delete document.hidden;
  document.dispatchEvent(new Event('visibilitychange'));
  hole.advance(0.5);
});
await shot(phone, 2, 'paused after leaving the page (phone)');
const ipad = await open({ ...devices['iPad Pro 11 landscape'] });
await ready(ipad);
await ipad.evaluate(() => hole.advance(1));
await shot(ipad, 2, 'start (iPad)');

const rows = ['Far LOD on PC (two minutes into a run)', 'Start of a fresh run', 'Screens'];
const html = `<!doctype html><html><head><style>
  body { margin: 0; background: #0b0d12; color: #cfd6e4; font: 13px/1.3 system-ui, sans-serif; padding: 10px; width: 1700px; }
  h1 { font-size: 18px; margin: 4px 0 8px; } h2 { font-size: 14px; margin: 12px 0 6px; color: #9fb0cc; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start; } figure { margin: 0; } figcaption { padding: 3px 0; max-width: 556px; }
  img { display: block; height: 313px; border: 1px solid #2a3040; } .r0 img { height: 470px; } .r1 img { height: 470px; }
</style></head><body><h1>Hole: Contoo 4 ship check</h1>
${rows.map((title, r) => `<h2>${title}</h2><div class="row r${r}">${tiles.filter((t) => t.row === r)
    .map((t) => `<figure><img src="data:image/png;base64,${t.data}"><figcaption>${t.label}</figcaption></figure>`).join('')}</div>`).join('')}
</body></html>`;
const sheet = await browser.newPage({ viewport: { width: 1720, height: 800 } });
await sheet.setContent(html);
await sheet.screenshot({ path: OUT, type: 'jpeg', quality: 78, fullPage: true, timeout: 300000 });
console.log(`wrote ${OUT}`);
console.log(`far LOD: ${trisOn} vs ${trisOff} triangles; nearest rock after a restart ${near.toFixed(1)} m`);
console.log(problems.length ? `console errors: ${problems.slice(0, 5).join(' | ')}` : 'no console errors');
await browser.close();
server.close();
process.exit(problems.length ? 1 : 0);
