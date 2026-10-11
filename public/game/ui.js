// HUD (cross, circle, timer, touch buttons) and the loading / start / game-over screens, all DOM above the
// canvas. Camera effects never touch this layer, so the HUD never shakes, rolls or flashes.
// Fullscreen is only ever asked for from the fullscreen button (never automatically, never mid-run) and the game
// never leaves it by itself, so Safari's fullscreen warning comes up as rarely as possible.
import { HUD, RUN } from './config.js';

const $ = (id) => document.getElementById(id);

export function formatTime(t) {
  const tenths = Math.floor(Math.max(0, t) * 10 + 1e-6);
  const mm = Math.floor(tenths / 600);
  const ss = (tenths % 600) / 10;
  return `${String(mm).padStart(2, '0')}:${ss.toFixed(1).padStart(4, '0')}`;
}

export function loadBest() {
  try {
    return Number(localStorage.getItem(RUN.bestKey)) || 0;
  } catch {
    return 0;
  }
}

export function saveBest(t) {
  try {
    localStorage.setItem(RUN.bestKey, String(t));
  } catch { /* private mode: keep it for this visit only */ }
}

const fsEnabled = () => !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => navigator.standalone === true
  || window.matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches;

export class UI {
  constructor({ touch }) {
    this.touch = touch;
    this.root = document.documentElement;
    this.circle = $('circle');
    this.timer = $('timer');
    this.buttons = { left: $('btn-left'), right: $('btn-right'), up: $('btn-up'), down: $('btn-down') };
    this.screens = { loading: $('loading'), start: $('start'), over: $('over') };
    this.edge = $('edge');
    this.timerText = '';
    this.range = 100;
    this.circleXY = [NaN, NaN];
    document.body.classList.toggle('touch', touch);
    $('start-prompt').textContent = touch ? 'Tap to start' : 'Press any key or click to start';
    $('over-prompt').textContent = touch ? 'Tap to fly again' : 'Press any key or click to fly again';
    $('start-hint').textContent = touch ? 'Hold the arrows to steer · both thumbs for diagonals'
      : 'W A S D to steer';
    this.setupFullscreen();
    this.layout();
  }

  // Sizes everything from min(width, height); call on every resize.
  layout() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const m = Math.min(w, h);
    const [bMin, bShare, bMax] = HUD.button;
    const s = this.root.style;
    s.setProperty('--u', `${m / 100}px`);
    s.setProperty('--btn', `${Math.round(Math.min(bMax, Math.max(bMin, bShare * m)))}px`);
    s.setProperty('--circle', `${Math.round(HUD.circleSize * m)}px`);
    s.setProperty('--cross', `${Math.round(HUD.crossSize * m)}px`);
    this.range = HUD.circleRange * m;
    this.circleXY = [NaN, NaN];
  }

  // c = circle position in ranges (|c| <= 1, y up).
  setCircle(cx, cy) {
    const x = Math.round(cx * this.range * 10) / 10;
    const y = Math.round(-cy * this.range * 10) / 10;
    if (x === this.circleXY[0] && y === this.circleXY[1]) return;
    this.circleXY = [x, y];
    this.circle.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
  }

  setTimer(t) {
    const text = formatTime(t);
    if (text !== this.timerText) {
      this.timerText = text;
      this.timer.textContent = text;
    }
  }

  // mode: 'loading' | 'start' | 'run' | 'hit' | 'over'
  show(mode) {
    document.body.dataset.mode = mode;
    for (const [name, el] of Object.entries(this.screens)) el.classList.toggle('shown', name === mode);
    this.updateFullscreenButtons();
  }

  progress(frac) {
    $('bar').firstElementChild.style.width = `${Math.round(frac * 100)}%`;
  }

  error(message) {
    $('load-error').textContent = message;
  }

  gameOver(time, best, isNew) {
    $('over-time').textContent = formatTime(time);
    $('over-best').textContent = isNew ? 'New best time' : `Best ${formatTime(best)}`;
    $('over-best').classList.toggle('new', isNew);
  }

  setBest(best) {
    $('start-best').textContent = best > 0 ? `Best ${formatTime(best)}` : '';
  }

  // The view closing in (iris 1 = open ... 0 = shut) and darkening; used by the hit effect and the restart.
  setEdge(iris, dark) {
    if (dark <= 0.001) {
      if (this.edge.style.opacity !== '0') this.edge.style.opacity = '0';
      return;
    }
    const inner = Math.max(0, iris * 100 - 30);
    this.edge.style.opacity = '1';
    this.edge.style.background = `radial-gradient(circle closest-corner at 50% 50%, rgba(1,2,5,0) ${inner.toFixed(1)}%, `
      + `rgba(1,2,5,${(dark * 0.55).toFixed(3)}) ${(inner + 18).toFixed(1)}%, rgba(1,2,5,${dark.toFixed(3)}) ${(iris * 100 + 25).toFixed(1)}%)`;
  }

  // ---- fullscreen
  setupFullscreen() {
    this.fsButtons = [...document.querySelectorAll('.fs')];
    const toggle = () => {
      if (fsElement()) {
        (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.())?.catch?.(() => {});
        return;
      }
      const el = document.documentElement;
      try {
        const p = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen?.();
        p?.catch?.((err) => console.warn('fullscreen:', err.message));
      } catch (err) {
        console.warn('fullscreen:', err.message);
      }
    };
    for (const b of this.fsButtons) {
      // Touch: react on touchend (a user gesture on every browser, and touches never make clicks here).
      // Mouse and keyboard: click. The press never reaches the screen behind (it would start the run).
      b.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); toggle(); }, { passive: false });
      b.addEventListener('click', (e) => { e.stopPropagation(); b.blur(); toggle(); });  // blur: keys start runs
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
    }
    document.addEventListener('fullscreenchange', () => this.updateFullscreenButtons());
    document.addEventListener('webkitfullscreenchange', () => this.updateFullscreenButtons());
    // iPhone Safari has no fullscreen for pages: a home-screen app runs fullscreen instead.
    $('a2hs').hidden = !(isIOS() && !fsEnabled() && !standalone());
  }

  // Start screen: a toggle. Game over: only "Fullscreen" (to get in); in fullscreen it is hidden there, so a
  // restart tap can never leave fullscreen by accident (leaving and re-entering brings Safari's warnings).
  updateFullscreenButtons() {
    const on = !!fsElement();
    for (const b of this.fsButtons) {
      b.hidden = !fsEnabled() || (on && !!b.closest('#over'));
      b.classList.toggle('on', on);
      b.querySelector('span').textContent = on ? 'Exit fullscreen' : 'Fullscreen';
    }
  }

  get fullscreen() {
    return !!fsElement();
  }
}
