// Music cycle test: drives the game's Music engine from a run clock that can be sped up or skipped, with the
// deepening effects switchable one by one.
import { MUSIC } from '../game/config.js';
import { pickAssetSet } from '../game/device.js';
import { loadManifest } from '../game/loader.js';
import { Music, unlockAudio, musicFormat } from '../game/audio.js';

const $ = (id) => document.getElementById(id);
const set = pickAssetSet();
const fx = { dip: true, reverb: true, sub: true, drone: true };
let audio = null;     // { ctx, music }
let runTime = 0;      // seconds of "run"
let speed = 1;
let last = 0;

// MUSIC.depth with the switched-off effects zeroed
function depthCfg() {
  const d = MUSIC.depth;
  const zero = (a) => a.map(() => 0);
  return { ...d, reverb: fx.reverb ? d.reverb : zero(d.reverb), subDb: fx.sub ? d.subDb : zero(d.subDb),
           drone: fx.drone ? d.drone : zero(d.drone) };
}
const dipHz = () => (fx.dip ? MUSIC.dipHz : 20000);

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

$('play').addEventListener('click', async () => {
  if (!audio) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    unlockAudio(ctx);
    const music = new Music(ctx, { fadeSeconds: MUSIC.fadeSeconds, volume: MUSIC.volume, depth: depthCfg(),
                                   dipHz: dipHz() });
    audio = { ctx, music };
    $('msg').textContent = `loading ${set} ${musicFormat()}…`;
    const manifest = await loadManifest();
    await music.load(manifest, set);
    $('bars').innerHTML = music.loops.map((l) => `<div class="lv">L${l.level}<i></i></div>`).join('');
    $('msg').textContent = '';
  } else {
    unlockAudio(audio.ctx);
  }
  const m = audio.music;
  if (m.playing) {
    m.stop(0.5);
  } else {
    m.start();
    last = performance.now();
  }
  $('play').textContent = m.playing ? 'Stop' : 'Play';
  $('play').classList.toggle('on', m.playing);
});

for (const b of document.querySelectorAll('[data-speed]')) {
  b.addEventListener('click', () => {
    speed = Number(b.dataset.speed);
    for (const o of document.querySelectorAll('[data-speed]')) o.classList.toggle('on', o === b);
  });
}
for (const b of document.querySelectorAll('[data-fx]')) {
  b.addEventListener('click', () => {
    fx[b.dataset.fx] = !fx[b.dataset.fx];
    b.classList.toggle('on', fx[b.dataset.fx]);
    if (audio) {
      audio.music.depthCfg = depthCfg();
      audio.music.dipHz = dipHz();
      if (audio.music.playing) audio.music.setDepth(audio.music.depth, audio.music.dip, 1);
    }
  });
}
$('end').addEventListener('click', () => {
  const c = MUSIC.cycleSeconds;
  runTime = Math.floor(runTime / c) * c + c - MUSIC.descentSeconds - 15;
});
$('restart').addEventListener('click', () => {
  runTime = 0;
  if (audio?.music.playing) {
    audio.music.stop(0.3);
    setTimeout(() => { audio.music.depth = 0; audio.music.dip = 0; audio.music.intensity = 1; audio.music.start(); }, 400);
  }
});

// A timer, not requestAnimationFrame, so the run clock keeps going while the tab is in the background.
function tick() {
  const now = performance.now();
  const dt = Math.min(1.5, (now - last) / 1000);
  last = now;
  if (audio?.music.playing) {
    runTime += dt * speed;
    const m = audio.music;
    const plan = m.follow(runTime, MUSIC);
    $('read').textContent = [
      `run      ${fmt(runTime)}   (${speed}×)`,
      `cycle    ${plan.cycle + 1}   depth ${m.depth.toFixed(2)}${plan.descending ? '   sinking…' : ''}`,
      `level    ${m.intensity.toFixed(2)}`,
      `filter   ${Math.round(m.lowpass.frequency.value)} Hz`,
      `loop     ${m.position().toFixed(1)} s`,
    ].join('\n');
    const g = m.gainsFor(m.intensity);
    document.querySelectorAll('.lv i').forEach((el, i) => { el.style.width = `${Math.round(100 * (g[i] ?? 0))}%`; });
    $('cyc').firstElementChild.style.width = `${(100 * (runTime % MUSIC.cycleSeconds)) / MUSIC.cycleSeconds}%`;
  }
}
setInterval(tick, 100);
