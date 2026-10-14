// HUD (cross, circle, timer, touch buttons) and the loading / start / game-over screens, all DOM above the
// canvas. Camera effects never touch this layer, so the HUD never shakes, rolls or flashes.
// Fullscreen is only ever asked for from the fullscreen button (never automatically, never mid-run) and the game
// never leaves it by itself, so Safari's fullscreen warning comes up as rarely as possible.
// Contoo 3: the settings panel (gear on the start and game-over screens: music and sound volume, the debug
// read-out; taps only, no sliders, nothing reaches the game behind it) and the lean's darker edge.
import { HUD, RUN, SETTINGS, PULL_WARNING } from './config.js';

const $ = (id) => document.getElementById(id);

export function formatTime(t) {
  const tenths = Math.floor(Math.max(0, t) * 10 + 1e-6);
  const mm = Math.floor(tenths / 600);
  const ss = (tenths % 600) / 10;
  return `${String(mm).padStart(2, '0')}:${ss.toFixed(1).padStart(4, '0')}`;
}

// Best times are kept per controls scheme (Extreme keeps the old key: every run before the joystick was Extreme).
const bestKey = (controls) => (controls === 'extreme' ? RUN.bestKey : RUN.bestKeyJoystick);

export function loadBest(controls = 'extreme') {
  try {
    return Number(localStorage.getItem(bestKey(controls))) || 0;
  } catch {
    return 0;
  }
}

export function saveBest(t, controls = 'extreme') {
  try {
    localStorage.setItem(bestKey(controls), String(t));
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
    this.screens = { loading: $('loading'), start: $('start'), over: $('over'), paused: $('paused') };
    this.edge = $('edge');
    this.leanEdge = $('lean-edge');
    this.leanKey = '';
    this.pull = $('pull');
    this.pullArm = this.pull.querySelector('.arm');
    this.pullKey = '';
    this.settingsEl = $('settings');
    this.timerText = '';
    this.range = 100;
    this.circleXY = [NaN, NaN];
    document.body.classList.toggle('touch', touch);
    $('start-prompt').textContent = touch ? 'Tap to start' : 'Press any key or click to start';
    $('over-prompt').textContent = touch ? 'Tap to fly again' : 'Press any key or click to fly again';
    $('paused-prompt').textContent = touch ? 'Tap to continue' : 'Press any key or click to continue';
    this.setControls('joystick');
    this.setupFullscreen();
    this.layout();
  }

  // The controls scheme ('joystick' | 'extreme'): the touch buttons or the floating stick, the hint, the Extreme tag.
  setControls(mode) {
    const joy = mode !== 'extreme';
    document.body.classList.toggle('joy', joy);
    document.body.classList.toggle('extreme', !joy);
    $('start-hint').textContent = joy
      ? (this.touch ? 'Drag anywhere to steer' : 'W A S D, a mouse drag or a gamepad to steer')
      : (this.touch ? 'Hold the arrows to steer · both thumbs for diagonals' : 'W A S D to steer');
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
    s.setProperty('--range', `${Math.round(this.range)}px`);
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

  // mode: 'loading' | 'start' | 'run' | 'hit' | 'over' | 'paused'
  show(mode) {
    document.body.dataset.mode = mode;
    if (mode !== 'start' && mode !== 'over') this.closeSettings();
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

  // The pull warning: show 0..1 (how much), danger 0..1 (how near the forecast hit: amber -> red, faster pulse),
  // angle = the meteor's direction on screen (rad, 0 = right, counterclockwise), t = time (s) for the pulse.
  setPullWarning(show, danger, angle, t) {
    const c = PULL_WARNING;
    const hz = c.pulseHz[0] + (c.pulseHz[1] - c.pulseHz[0]) * danger;
    const pulse = danger > 0.02 ? 0.6 + 0.4 * Math.sin(2 * Math.PI * hz * t) : 1;
    const o = Math.round(Math.min(1, show) * c.opacity * pulse * 100) / 100;
    const mix = (i) => Math.round(c.amber[i] + (c.red[i] - c.amber[i]) * danger);
    const color = `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
    const deg = Math.round((-angle * 180) / Math.PI);   // CSS rotates clockwise
    const key = `${o}|${color}|${deg}`;
    if (key === this.pullKey) return;
    this.pullKey = key;
    this.pull.style.opacity = String(o);
    this.pull.style.setProperty('--pc', color);
    this.pullArm.style.transform = `rotate(${deg}deg)`;
  }

  // The darker screen edge on a massive meteor's side: amount 0..1, angle = its direction on screen (rad, 0 =
  // right, counterclockwise); red 0..1 turns it red (the pull warning's danger).
  setLeanEdge(amount, angle, max, red = 0) {
    const a = Math.max(Math.round(amount * max * 100) / 100, Math.round(red * 0.6 * 100) / 100);
    const r = Math.round(red * 10) / 10;
    const deg = Math.round(90 - (angle * 180) / Math.PI);   // CSS: 0deg points up, clockwise
    const key = a > 0.005 ? `${a}|${deg}|${r}` : '0';
    if (key === this.leanKey) return;
    this.leanKey = key;
    if (key === '0') {
      this.leanEdge.style.opacity = '0';
      return;
    }
    this.leanEdge.style.opacity = '1';
    const rgb = `${Math.round(110 * r)},${Math.round(6 * r)},0`;   // black, or a deep red
    this.leanEdge.style.background = `linear-gradient(${deg}deg, rgba(${rgb},0) 30%, rgba(${rgb},${(a * 0.55).toFixed(2)}) 62%, `
      + `rgba(${rgb},${a.toFixed(2)}) 90%)`;
  }

  // ---- settings: settings = { music, sound, debug, controls, sensitivity } (changed in place); onChange(settings)
  // after every change
  setupSettings(settings, onChange) {
    this.settings = settings;
    const el = this.settingsEl;
    const tap = (b, fn) => {
      b.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); fn(); }, { passive: false });
      b.addEventListener('click', (e) => { e.stopPropagation(); b.blur(); fn(); });
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
    };
    for (const g of document.querySelectorAll('.gear')) tap(g, () => this.openSettings());
    // nothing on the panel reaches the game (a press there must never start or restart a run)
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.target === el) this.closeSettings();   // the dim area around the card
    });
    el.addEventListener('touchend', (e) => { if (e.target === el) { e.preventDefault(); this.closeSettings(); } }, { passive: false });
    el.addEventListener('click', (e) => e.stopPropagation());
    for (const st of el.querySelectorAll('.stepper')) {
      const key = st.dataset.key;
      const min = Number(st.dataset.min ?? 0);
      const max = Number(st.dataset.max ?? SETTINGS.steps);
      for (const b of st.querySelectorAll('button')) {
        tap(b, () => {
          settings[key] = Math.min(max, Math.max(min, settings[key] + Number(b.dataset.d)));
          this.renderSettings();
          onChange(settings);
        });
      }
    }
    for (const ch of el.querySelectorAll('.choice')) {
      const key = ch.dataset.key;
      for (const b of ch.querySelectorAll('button')) {
        tap(b, () => {
          settings[key] = b.dataset.v;
          this.renderSettings();
          onChange(settings);
        });
      }
    }
    const toggle = el.querySelector('.toggle');
    tap(toggle, () => {
      settings.debug = !settings.debug;
      this.renderSettings();
      onChange(settings);
    });
    tap(el.querySelector('.done'), () => this.closeSettings());
    window.addEventListener('keydown', (e) => {
      if (this.settingsOpen && (e.key === 'Escape' || e.key === 'Enter')) {
        e.preventDefault();
        this.closeSettings();
      }
    });
    this.renderSettings();
  }

  renderSettings() {
    const s = this.settings;
    for (const st of this.settingsEl.querySelectorAll('.stepper')) {
      const v = s[st.dataset.key];
      const min = Number(st.dataset.min ?? 0);
      const max = Number(st.dataset.max ?? SETTINGS.steps);
      st.querySelector('output').textContent = st.dataset.fmt === 'num' ? String(v)
        : v ? `${Math.round((v / SETTINGS.steps) * 100)}%` : 'Off';
      st.querySelector('[data-d="-1"]').disabled = v <= min;
      st.querySelector('[data-d="1"]').disabled = v >= max;
    }
    for (const ch of this.settingsEl.querySelectorAll('.choice')) {
      for (const b of ch.querySelectorAll('button')) b.setAttribute('aria-pressed', String(s[ch.dataset.key] === b.dataset.v));
    }
    const note = $('controls-note');
    const extreme = s.controls === 'extreme';
    note.classList.toggle('extreme', extreme);
    note.textContent = extreme
      ? 'Extreme difficulty: the circle only tempts a heavy ship. It stays where you leave it; turning takes time.'
      : 'Push the stick and the ship turns; let go and it flies straight. Sensitivity sets how fast it turns.';
    const t = this.settingsEl.querySelector('.toggle');
    t.setAttribute('aria-pressed', String(!!s.debug));
    t.textContent = s.debug ? 'On' : 'Off';
  }

  openSettings() {
    this.settingsEl.hidden = false;
  }

  closeSettings() {
    // (the key press that closes it must not start a run: main.js ignores presses while it is open and for a
    // moment after)
    if (!this.settingsEl.hidden) this.closedAt = performance.now();
    this.settingsEl.hidden = true;
  }

  get settingsOpen() {
    return !this.settingsEl.hidden || performance.now() - (this.closedAt ?? -1e9) < 150;
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
