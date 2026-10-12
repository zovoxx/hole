#!/usr/bin/env node
// Browser tests for the game (Contoo 1–2): serves public/ on a local port and drives headless Chromium with
// Playwright on desktop and mobile emulation (touch, portrait and landscape).
//   - loads with no console errors and no failed requests (404s)
//   - desktop: a key starts the run; WASD moves the circle at one constant speed and it stays put; the turn is
//     heavy (a counter-steer keeps turning the old way for a while); a rock ahead ends the run; the game-over
//     screen shows the time and best time; a key restarts
//   - mobile: tap to start; two thumbs at once give a diagonal; a fast double tap on a button and on empty
//     screen never zooms (visualViewport.scale stays 1)
//   - Contoo 2 (desktop): the field has decoys, exploders and big rocks; nothing blows up behind the start
//     screen; an exploder ahead lights its fuse and blows up (flash, pieces); a massive meteor pulls you
// Usage: NODE_PATH=$(npm root -g) node tools/test_game.mjs [--shots dir] [--only desktop|mobile]
// Needs Playwright (npm i -g playwright, or npx playwright install chromium on a laptop).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  console.error('Playwright not found: npm i -g playwright, then run with NODE_PATH=$(npm root -g)');
  process.exit(2);
}
const { chromium, devices } = playwright;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const args = process.argv.slice(2);
const SHOTS = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.glb': 'model/gltf-binary', '.webp': 'image/webp',
  '.png': 'image/png', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.txt': 'text/plain',
};

function serve() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(ROOT, url);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    if (url.endsWith('/')) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let failures = 0;
function check(ok, what, detail = '') {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${what}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

async function openGame(browser, base, contextOptions, query = '?debug') {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
  await page.goto(`${base}/index.html${query}`);
  await page.waitForFunction(() => window.hole?.mode === 'start', null, { timeout: 60000 });
  await page.waitForFunction(() => (window.__frames = (window.__frames ?? 0) + 1) > 2, null, { polling: 'raf', timeout: 60000 });
  // Headless Chromium draws with a software rasterizer (~0.3–1 s per frame here), so the checks run on the
  // game's test clock (hole.advance: the same per-frame code in fixed 1/60 s steps) with drawing off.
  // Real key and touch events still drive the input between steps. Screenshots switch drawing back on.
  await page.evaluate(() => { hole.setRendering(false); hole.setTestOnly(true); hole.advance(0); });
  return { context, page, problems };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const advance = (page, s) => page.evaluate((x) => hole.advance(x), s);
const game = (page) => page.evaluate(() => ({
  mode: hole.mode, time: hole.time, best: hole.best, cx: hole.flight.cx, cy: hole.flight.cy,
  wx: hole.flight.wx, wy: hole.flight.wy, alive: hole.field.stats.alive,
  drawn: hole.field.stats.drawn, target: hole.field.stats.target,
  scale: window.visualViewport ? visualViewport.scale : 1,
}));

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(() => hole.setRendering(true));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), timeout: 120000 });
  await page.evaluate(() => hole.setRendering(false));
}

async function desktop(browser, base) {
  console.log('desktop 1280x720');
  const { context, page, problems } = await openGame(browser, base, { viewport: { width: 1280, height: 720 } });
  await advance(page, 2);
  await shot(page, 'desktop_start');
  let g = await game(page);
  check(g.alive > 100, 'space is full on the start screen', `${g.alive} meteors, ${g.drawn} drawn, target ${g.target}`);
  const calm = await page.evaluate(() => ({ booms: hole.field.stats.explosions, types: { ...hole.field.stats.types } }));
  check(calm.booms === 0 && calm.types.decoy > 10 && calm.types.big > 3,
    'the start screen shows decoys and big rocks, and nothing blows up behind it', JSON.stringify(calm));
  await page.click('#start .fs');
  await sleep(300);
  const fs1 = await page.evaluate(() => ({ mode: hole.mode, fs: !!document.fullscreenElement }));
  check(fs1.mode === 'start', 'the fullscreen button does not start the run', `fullscreen ${fs1.fs}`);
  if (fs1.fs) await page.evaluate(() => document.exitFullscreen());
  await page.keyboard.press('Space');
  g = await game(page);
  check(g.mode === 'run', 'a key starts the run');

  // circle: constant speed while held, stays where it is left
  await page.keyboard.down('KeyD');
  await advance(page, 0.3);
  await page.keyboard.up('KeyD');
  g = await game(page);
  const c1 = g.cx;
  check(Math.abs(c1 - 0.5) < 0.02 && Math.abs(g.cy) < 1e-9, 'D moves the circle right, 0.6 s from cross to edge', `cx ${c1.toFixed(3)} after 0.3 s`);
  await advance(page, 0.4);
  g = await game(page);
  check(g.cx === c1, 'the circle stays where it was left', `cx ${g.cx.toFixed(3)}`);
  await page.keyboard.down('KeyD');
  await advance(page, 0.7);
  await page.keyboard.up('KeyD');
  g = await game(page);
  check(Math.abs(g.cx - 1) < 1e-9, 'the circle stops at the edge of its range', `cx ${g.cx.toFixed(3)}`);
  await advance(page, 0.6);
  g = await game(page);
  check(Math.abs(g.wx - 70) < 0.5, 'turning right at full speed (70 °/s)', `${g.wx.toFixed(1)} °/s`);
  // counter-steer: hold A; the circle crosses the cross after ~0.6 s, the turn keeps going right a while
  await page.keyboard.down('KeyA');
  const cs = await page.evaluate(() => {
    let crossed = null;
    let reversed = null;
    for (let i = 1; i <= 180 && reversed === null; i++) {
      hole.advance(1 / 60);
      if (crossed === null && hole.flight.cx <= 0) crossed = i / 60;
      if (reversed === null && hole.flight.wx < 0) reversed = i / 60;
    }
    return { crossed, reversed };
  });
  await page.keyboard.up('KeyA');
  check(cs.crossed !== null && cs.reversed !== null && cs.reversed - cs.crossed > 0.35 && cs.reversed - cs.crossed < 0.65,
    'a full counter-steer keeps turning the old way ~0.5 s after the circle crosses',
    `crossed ${cs.crossed?.toFixed(2)} s, turn reversed ${cs.reversed?.toFixed(2)} s`);
  await page.keyboard.down('KeyS');
  await page.keyboard.down('KeyD');
  const before = await game(page);
  await advance(page, 0.25);
  await page.keyboard.up('KeyS');
  await page.keyboard.up('KeyD');
  g = await game(page);
  const moved = Math.hypot(g.cx - before.cx, g.cy - before.cy);
  check(g.cy < before.cy - 0.1 && g.cx > before.cx + 0.1 && Math.abs(moved - 0.25 / 0.6) < 0.02,
    'S+D moves the circle diagonally at the same speed', `moved ${moved.toFixed(3)}`);
  await advance(page, 1);
  g = await game(page);
  check(g.mode === 'run' || g.mode === 'hit' || g.mode === 'over', 'still flying', g.mode);
  if (g.mode === 'run') await shot(page, 'desktop_run');

  // a rock straight ahead ends the run
  if (g.mode === 'run') {
    await page.keyboard.down('KeyQ');  // a key held through the crash (not a steering key)
    await page.evaluate(() => { hole.flight.cx = hole.flight.cy = hole.flight.wx = hole.flight.wy = 0; hole.placeAhead(25, 5); });
    await advance(page, 1);
  }
  g = await game(page);
  check(g.mode === 'hit' || g.mode === 'over', 'a rock ahead hits the player', g.mode);
  await advance(page, 1);
  await shot(page, 'desktop_over');
  const shown = await page.evaluate(() => ({
    time: document.getElementById('over-time').textContent, best: document.getElementById('over-best').textContent,
    visible: getComputedStyle(document.getElementById('over')).visibility, mode: hole.mode,
  }));
  check(shown.mode === 'over' && shown.visible === 'visible' && /^\d\d:\d\d\.\d$/.test(shown.time) && shown.best.length > 0,
    'the game-over screen shows time and best time', `${shown.time} / ${shown.best}`);
  const stored = await page.evaluate(() => localStorage.getItem('hole.best'));
  check(Number(stored) > 0, 'best time kept in localStorage', stored);
  await advance(page, 0.6);
  await page.keyboard.down('KeyQ');  // already down: the browser's auto-repeat (repeat = true)
  g = await game(page);
  check(g.mode === 'over', 'a key held through the crash (auto-repeat) does not restart', g.mode);
  await page.keyboard.up('KeyQ');
  await page.keyboard.press('KeyK');
  g = await game(page);
  check(g.mode === 'run' && g.time === 0 && g.cx === 0, 'any key restarts from zero', `${g.mode} t ${g.time.toFixed(2)}`);
  await advance(page, 3);
  g = await game(page);
  check(g.mode === 'run' && Math.abs(g.time - 3) < 0.02, 'the timer counts the run', `t ${g.time.toFixed(2)}`);
  await shot(page, 'desktop_restart');
  // Contoo 2: an exploder ahead (its pieces can't hit in this test) lights its fuse and blows up; a massive
  // meteor beside your path pulls you
  const boom = await page.evaluate(() => {
    const before = { ...hole.field.stats };
    const ex = hole.place({ type: 'exploder', dist: 155, s: 6, side: 3, test: false });
    let lit = null;
    for (let i = 0; i < 240 && hole.field.stats.explosions === before.explosions; i++) {
      hole.advance(1 / 60);
      if (lit === null && ex.fuse >= 0) lit = Math.round(ex.p.length());
    }
    return { lit, booms: hole.field.stats.explosions - before.explosions, pieces: hole.field.stats.fragments - before.fragments,
             flashes: hole.fx.flashes.length, light: hole.fx.lights.some((l) => l.light.intensity > 0) };
  });
  check(boom.lit > 100 && boom.booms >= 1 && boom.pieces >= 6 && boom.flashes >= 1 && boom.light,
    'an exploder ahead lights its fuse and blows up: flash, light, pieces', JSON.stringify(boom));
  await shot(page, 'desktop_blast');
  const pulled = await page.evaluate(() => {
    const m = hole.spawnMassive({ dist: 120, offAxis: 25, s: 22 });
    hole.advance(0.5);
    const out = { strength: hole.pull.strength, turn: Math.hypot(hole.pull.gx, hole.pull.gy), drift: hole.drift.length() };
    hole.field.remove(m);
    for (const r of [...hole.field.rocks]) if (r.host === m || r.noGrav) hole.field.remove(r);
    hole.advance(0.5);
    return out;
  });
  check(pulled.strength > 0.1 && pulled.turn > 5 && pulled.drift > 0.3, 'a massive meteor near you turns you toward it and drags you sideways',
    `${pulled.turn.toFixed(0)} °/s, drift ${pulled.drift.toFixed(1)} m/s`);
  g = await game(page);
  check(g.mode === 'run', 'still flying after the blast and the pull (test rocks only)', g.mode);
  // the real clock runs too (after a screenshot the software GPU first works off its backlog)
  const tNow = await page.evaluate(() => hole.time);
  await page.evaluate(() => hole.realtime());
  const ran = await page.waitForFunction((t) => hole.time > t + 1.5, tNow, { timeout: 30000 }).then(() => true, () => false);
  g = await game(page);
  check(ran, 'the real-time clock runs', `t ${g.time.toFixed(2)}`);
  check(problems.length === 0, 'no console errors or failed requests', problems.slice(0, 5).join(' | '));
  await context.close();
}

async function center(page, sel) {
  return page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);
}

async function doubleTap(cdp, x, y) {
  for (let i = 0; i < 2; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(50);
  }
}

async function mobile(browser, base, name, device, landscape) {
  const d = devices[device];
  const viewport = landscape ? { width: d.viewport.height, height: d.viewport.width } : d.viewport;
  console.log(`${name} ${landscape ? 'landscape' : 'portrait'} ${viewport.width}x${viewport.height}`);
  const { context, page, problems } = await openGame(browser, base, { ...d, viewport });
  const tag = `${name}_${landscape ? 'land' : 'port'}`;
  const touchOn = await page.evaluate(() => document.body.classList.contains('touch'));
  check(touchOn, 'touch buttons enabled');
  await advance(page, 2);
  await shot(page, `${tag}_start`);
  const cdp = await context.newCDPSession(page);
  const vw = viewport.width;
  const vh = viewport.height;
  const fsb = await page.evaluate(() => {
    const b = document.querySelector('#start .fs');
    const r = b.getBoundingClientRect();
    return { hidden: b.hidden, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (!fsb.hidden) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fsb.x, y: fsb.y, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(300);
    const m = await page.evaluate(() => ({ mode: hole.mode, fs: !!document.fullscreenElement }));
    check(m.mode === 'start', 'tapping the fullscreen button does not start the run', `fullscreen ${m.fs}`);
    if (m.fs) await page.evaluate(() => document.exitFullscreen());
  }
  await doubleTap(cdp, vw * 0.5, vh * 0.3);  // a (double) tap on the start screen starts and never zooms
  let g = await game(page);
  check(g.mode === 'run', 'a tap starts the run');
  // pads: inside the screen, apart from each other, big enough for thumbs
  const pads = await page.evaluate(() => ['btn-left', 'btn-right', 'btn-up', 'btn-down'].map((id) => {
    const r = document.getElementById(id).getBoundingClientRect();
    return { id, l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width };
  }));
  const inside = pads.every((p) => p.l >= 0 && p.t >= 0 && p.r <= vw && p.b <= vh && p.w >= 60);
  const overlap = pads.some((a, i) => pads.some((b, j) => i < j && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b));
  check(inside && !overlap, 'buttons inside the screen, no overlap, at least 60 px', pads.map((p) => `${p.id} ${Math.round(p.w)}px`).join(', '));
  // two thumbs: right + up at once -> diagonal
  const right = await center(page, '#btn-right');
  const up = await center(page, '#btn-up');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...right, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...right, id: 1 }, { ...up, id: 2 }] });
  await advance(page, 0.25);
  const lit = await page.evaluate(() => [...document.querySelectorAll('.btn.on')].map((b) => b.id).sort().join(','));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  g = await game(page);
  check(g.cx > 0.2 && g.cy > 0.2 && Math.abs(g.cx - g.cy) < 0.02, 'two thumbs at once give a diagonal',
    `c ${g.cx.toFixed(3)}, ${g.cy.toFixed(3)}; pressed ${lit}`);
  await advance(page, 0.05);
  const pressed = await page.evaluate(() => document.querySelectorAll('.btn.on').length);
  check(pressed === 0, 'buttons released after the thumbs lift');
  if (g.mode === 'run') await shot(page, `${tag}_run`);
  // fast double taps: on a button, on empty space
  const left = await center(page, '#btn-left');
  await doubleTap(cdp, left.x, left.y);
  await doubleTap(cdp, vw * 0.5, vh * 0.45);
  await doubleTap(cdp, vw * 0.3, vh * 0.6);
  await sleep(500);
  g = await game(page);
  check(g.scale === 1, 'fast double taps never zoom', `visualViewport.scale ${g.scale}`);
  // turning the device: the layout follows and space stays full
  const before = await game(page);
  await page.setViewportSize({ width: vh, height: vw });
  await advance(page, 0.5);
  const turned = await page.evaluate(() => {
    const r = document.getElementById('btn-down').getBoundingClientRect();
    return { inside: r.right <= innerWidth && r.bottom <= innerHeight, alive: hole.field.stats.alive, target: hole.field.stats.target };
  });
  g = await game(page);
  check(g.mode === 'run' && turned.inside && turned.alive > 0.8 * turned.target,
    'rotating the device keeps the buttons on screen and space full', `${before.alive} -> ${turned.alive} meteors (target ${turned.target})`);
  await page.setViewportSize({ width: vw, height: vh });
  await advance(page, 0.2);
  // game over and a tap to restart
  await page.evaluate(() => { hole.flight.cx = hole.flight.cy = hole.flight.wx = hole.flight.wy = 0; hole.placeAhead(25, 5); });
  await advance(page, 2.5);
  g = await game(page);
  check(g.mode === 'over', 'a hit ends the run', g.mode);
  await doubleTap(cdp, vw * 0.5, vh * 0.5);
  g = await game(page);
  check(g.mode === 'run' && g.scale === 1, 'a tap restarts (no zoom)', `${g.mode}, scale ${g.scale}`);
  check(problems.length === 0, 'no console errors or failed requests', problems.slice(0, 5).join(' | '));
  await context.close();
}

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  if (!ONLY || ONLY === 'desktop') await desktop(browser, base);
  if (!ONLY || ONLY === 'mobile') {
    await mobile(browser, base, 'iphone', 'iPhone 13', false);
    await mobile(browser, base, 'iphone', 'iPhone 13', true);
    await mobile(browser, base, 'pixel', 'Pixel 7', false);
    await mobile(browser, base, 'ipad', 'iPad Pro 11', true);
  }
} catch (err) {
  console.error(err);
  failures++;
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
