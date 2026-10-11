// Input: WASD (and the arrow keys) plus the touch buttons, turned into held screen directions. Several thumbs at
// once (multi-touch), so diagonals work. Also reports fresh presses (a key, a click or a tap anywhere) for the
// start and game-over screens.
// The no-zoom rules (owner's wish, TECH "Devices") live here too: every touch on the page is preventDefault-ed,
// so a fast double tap never zooms and there are no clicks from touches (buttons react to pointer events).
import { HUD } from './config.js';

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
    this.listen();
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
    const releaseAll = () => { this.keys.clear(); this.pointers.clear(); };
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.onPress(e);
    });
    window.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (p) { p.x = e.clientX; p.y = e.clientY; }
    });
    const up = (e) => { this.pointers.delete(e.pointerId); };
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

  // The held directions now, as { x, y } in -1..1 (screen up = +y). Opposite directions cancel.
  update() {
    const dirs = new Set();
    for (const code of this.keys) dirs.add(KEY_DIRS[code]);
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
    return this.held;
  }

  clear() {
    this.keys.clear();
  }
}
