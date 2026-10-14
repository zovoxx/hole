// Input: WASD (and the arrow keys) plus the touch buttons, turned into held screen directions. Several thumbs at
// once (multi-touch), so diagonals work. Also reports fresh presses (a key, a click or a tap anywhere) for the
// start and game-over screens.
// Joystick controls (owner's wish after Contoo 4) also give a stick { x, y } (|stick| <= 1, screen up = +y): a
// floating stick wherever a thumb (or the mouse) goes down and drags, a gamepad's left stick, or the keys pushing it
// to the edge and letting it spring back. A gamepad's A / Start button is a press too.
// The no-zoom rules (owner's wish, TECH "Devices") live here too: every touch on the page is preventDefault-ed,
// so a fast double tap never zooms and there are no clicks from touches (buttons react to pointer events).
import { HUD, JOYSTICK } from './config.js';

const KEY_DIRS = {
  KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};
const IGNORED_PRESS = new Set(['Escape', 'Tab', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'ContextMenu',
  'OSLeft', 'OSRight', 'AltGraph', 'Fn']);

export class Input {
  // buttons = { left, right, up, down } elements; onPress(event) for a fresh key press or pointer down.
  constructor(buttons, onPress = () => {}) {
    this.buttons = buttons;
    this.onPress = onPress;
    this.keys = new Set();          // held directions from the keyboard
    this.pointers = new Map();      // pointerId -> { x, y } while down
    this.rects = [];                // [{ dir, l, t, r, b, cx, cy }] of the visible buttons, with slop
    this.touchEnabled = false;
    this.lastHeld = new Set();
    this.held = { x: 0, y: 0 };
    this.mode = 'joystick';         // or 'extreme' (main.js sets it from the settings)
    this.stick = { x: 0, y: 0 };    // joystick mode: where the stick is
    this.keyStick = { x: 0, y: 0 };
    this.drag = null;               // { id, bx, by }: the pointer steering the touch stick and its base
    this.stickEl = document.getElementById('stick');
    this.knobEl = this.stickEl?.querySelector('.knob') ?? null;
    this.stickShown = '';
    this.padPressed = false;
    this.listen();
  }

  // Joystick mode: the pointer that went down becomes the stick (its base where it went down). Not on the screens'
  // own buttons (gear, fullscreen, settings).
  grab(e) {
    if (this.mode !== 'joystick' || this.drag || e.target?.closest?.('button, .gear, .fs, #settings')) return;
    this.drag = { id: e.pointerId, bx: e.clientX, by: e.clientY };
  }

  listen() {
    const opts = { passive: false };
    // No zoom, no callout, no selection: cancel the browser's own touch handling everywhere on the page.
    const stop = (e) => { if (e.cancelable) e.preventDefault(); };
    for (const type of ['touchstart', 'touchmove', 'touchend']) document.addEventListener(type, stop, opts);
    for (const type of ['dblclick', 'gesturestart', 'gesturechange', 'gestureend', 'contextmenu', 'selectstart']) {
      document.addEventListener(type, stop, opts);
    }

    window.addEventListener('keydown', (e) => {
      const dir = KEY_DIRS[e.code];
      if (dir) {
        this.keys.add(e.code);
        e.preventDefault();  // arrows would scroll
      }
      if (!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !IGNORED_PRESS.has(e.key) && !/^F\d+$/.test(e.key)) {
        this.onPress(e);
      }
    });
    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); });
    const releaseAll = () => { this.keys.clear(); this.pointers.clear(); this.drag = null; };
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.grab(e);
      this.onPress(e);
    });
    window.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (p) { p.x = e.clientX; p.y = e.clientY; }
    });
    const up = (e) => {
      this.pointers.delete(e.pointerId);
      if (this.drag?.id === e.pointerId) this.drag = null;
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  // Call after layout changes (resize, buttons shown/hidden).
  measure() {
    this.rects = [];
    if (!this.touchEnabled) return;
    for (const [dir, el] of Object.entries(this.buttons)) {
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      const s = HUD.buttonSlop * Math.min(r.width, r.height);
      this.rects.push({ dir, l: r.left - s, t: r.top - s, r: r.right + s, b: r.bottom + s,
                        cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 });
    }
  }

  // The held directions now, as { x, y } in -1..1 (screen up = +y). Opposite directions cancel. dt (s) moves the
  // joystick mode's stick (this.stick).
  update(dt = 1 / 60) {
    const dirs = new Set();
    for (const code of this.keys) dirs.add(KEY_DIRS[code]);
    const pad = this.readPad();
    if (pad) {  // Extreme: the gamepad's stick or d-pad as held directions
      if (pad.x > 0.5) dirs.add('right');
      if (pad.x < -0.5) dirs.add('left');
      if (pad.y > 0.5) dirs.add('up');
      if (pad.y < -0.5) dirs.add('down');
    }
    for (const p of this.pointers.values()) {
      let best = null;
      let bestD = Infinity;
      for (const r of this.rects) {  // each thumb holds at most one button: the nearest one it is on
        if (p.x < r.l || p.x > r.r || p.y < r.t || p.y > r.b) continue;
        const d = (p.x - r.cx) ** 2 + (p.y - r.cy) ** 2;
        if (d < bestD) { bestD = d; best = r.dir; }
      }
      if (best) dirs.add(best);
    }
    this.held.x = (dirs.has('right') ? 1 : 0) - (dirs.has('left') ? 1 : 0);
    this.held.y = (dirs.has('up') ? 1 : 0) - (dirs.has('down') ? 1 : 0);
    for (const [dir, el] of Object.entries(this.buttons)) {  // pressed look, only on change
      const on = dirs.has(dir);
      if (on !== this.lastHeld.has(dir)) el.classList.toggle('on', on);
    }
    this.lastHeld = dirs;
    this.updateStick(dt, pad);
    return this.held;
  }

  // Joystick mode: the touch / mouse stick, else the gamepad's stick, else the keys (pushed in, springing back).
  updateStick(dt, pad) {
    const J = JOYSTICK;
    const st = this.stick;
    // keys: toward the held direction at one speed, back to the cross faster
    const kx = this.held.x;
    const ky = this.held.y;
    const kl = Math.hypot(kx, ky);
    const ks = this.keyStick;
    const tx = kl ? kx / kl : 0;
    const ty = kl ? ky / kl : 0;
    const dx = tx - ks.x;
    const dy = ty - ks.y;
    const dl = Math.hypot(dx, dy);
    const step = dt / (kl ? J.keyIn : J.keyOut);
    if (dl <= step) { ks.x = tx; ks.y = ty; } else { ks.x += (dx / dl) * step; ks.y += (dy / dl) * step; }
    let shown = '';
    const p = this.drag && this.pointers.get(this.drag.id);
    if (this.mode === 'joystick' && p) {
      const R = Math.max(24, J.radius * Math.min(window.innerWidth, window.innerHeight));
      let ox = p.x - this.drag.bx;
      let oy = p.y - this.drag.by;
      const ol = Math.hypot(ox, oy);
      if (ol > R) {  // the base follows the thumb, so turning the other way is quick
        this.drag.bx += (ox * (ol - R)) / ol;
        this.drag.by += (oy * (ol - R)) / ol;
        ox = (ox * R) / ol;
        oy = (oy * R) / ol;
      }
      st.x = ox / R;
      st.y = -oy / R;
      shown = `${Math.round(this.drag.bx)},${Math.round(this.drag.by)},${Math.round(ox)},${Math.round(oy)},${Math.round(R)}`;
    } else if (pad && Math.hypot(pad.x, pad.y) > J.padDeadZone) {
      st.x = pad.x;
      st.y = pad.y;
    } else {
      st.x = ks.x;
      st.y = ks.y;
    }
    if (this.stickEl && shown !== this.stickShown) {  // the stick under the thumb (only on change)
      this.stickShown = shown;
      this.stickEl.hidden = !shown;
      if (shown) {
        const [bx, by, ox, oy, R] = shown.split(',').map(Number);
        this.stickEl.style.transform = `translate(${bx}px, ${by}px)`;
        this.stickEl.style.setProperty('--r', `${R}px`);
        this.knobEl.style.transform = `translate(${ox}px, ${oy}px)`;
      }
    }
  }

  // The first connected gamepad's left stick (or d-pad) as { x, y } (screen up = +y), or null. A fresh A or Start
  // press is a press (start, restart, continue).
  readPad() {
    const pads = navigator.getGamepads?.() ?? [];
    for (const g of pads) {
      if (!g?.connected) continue;
      const b = (i) => !!g.buttons[i]?.pressed;
      const pressed = b(0) || b(9);
      if (pressed && !this.padPressed) this.onPress({ type: 'gamepad', target: null });
      this.padPressed = pressed;
      let x = g.axes[0] ?? 0;
      let y = -(g.axes[1] ?? 0);
      if (b(14)) x = -1;
      if (b(15)) x = 1;
      if (b(12)) y = 1;
      if (b(13)) y = -1;
      return { x, y };
    }
    return null;
  }

  clear() {
    this.keys.clear();
    this.drag = null;
    this.keyStick.x = this.keyStick.y = 0;
  }
}
