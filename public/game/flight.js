// Flight model (DESIGN §4, TECH "Flight model"): the circle only tempts a heavy ship (Extreme), or the joystick
// turns it directly (the default control since the owner's wish after Contoo 4).
// Pure math with no three.js, so it can be tested in Node and reused by the wall reachability check (Contoo 3).
// Screen axes: x right, y up. Turn rates in deg/s: wx = yaw to the right, wy = pitch up.
import { FLIGHT, JOYSTICK, SENSITIVITY } from './config.js';

export function createFlight() {
  return { cx: 0, cy: 0, wx: 0, wy: 0, tx: 0, ty: 0 };
}

export function resetFlight(f) {
  f.cx = f.cy = f.wx = f.wy = f.tx = f.ty = 0;
  return f;
}

// held = { x, y } with x, y in -1..1 (the held buttons/keys). Updates f in place and returns it.
export function stepFlight(f, held, dt, cfg = FLIGHT) {
  // 1. The circle moves only while something is held, at one constant speed (diagonals too), up to its range.
  //    Nothing else ever moves it.
  const ul = Math.hypot(held.x, held.y);
  if (ul > 0) {
    const k = dt / cfg.circleSeconds / ul;
    f.cx += held.x * k;
    f.cy += held.y * k;
    const l = Math.hypot(f.cx, f.cy);
    if (l > 1) { f.cx /= l; f.cy /= l; }
  }
  // 2–3. Only the direction from the cross matters: it sets the target turn rate at full strength.
  const cl = Math.hypot(f.cx, f.cy);
  if (cl > cfg.deadZone) {
    f.tx = (f.cx / cl) * cfg.maxTurnRate;
    f.ty = (f.cy / cl) * cfg.maxTurnRate;
  } else {
    f.tx = f.ty = 0;
  }
  // 4. The turn rate follows the target with a capped angular acceleration: the heavy momentum.
  follow(f, cfg.turnAccel * dt);
  return f;
}

function follow(f, step) {
  const dx = f.tx - f.wx;
  const dy = f.ty - f.wy;
  const dl = Math.hypot(dx, dy);
  if (dl <= step) {
    f.wx = f.tx;
    f.wy = f.ty;
  } else {
    f.wx += (dx / dl) * step;
    f.wy += (dy / dl) * step;
  }
}

// The sensitivity setting (a step) as a multiplier: 1 at the base step, twice as much every perDouble steps.
export function sensitivity(step, cfg = SENSITIVITY) {
  return 2 ** ((step - cfg.base) / cfg.perDouble);
}

// Extreme with a sensitivity: the same heavy ship, the circle m times as fast.
export function extremeConfig(m, cfg = FLIGHT) {
  return { ...cfg, circleSeconds: cfg.circleSeconds / m };
}

// Joystick controls (owner's wish after Contoo 4): stick = { x, y }, |stick| <= 1, screen axes, back at 0 when let
// go. The circle shows the stick; the turn follows how far it is pushed (deflection^expo, so small pushes turn
// gently), quickly but not at once. m = sensitivity().
export function stepJoystick(f, stick, dt, m = 1, cfg = JOYSTICK) {
  let x = stick.x;
  let y = stick.y;
  const l = Math.hypot(x, y);
  if (l > 1) { x /= l; y /= l; }
  f.cx = x;
  f.cy = y;
  const r = Math.min(1, l);
  if (r > cfg.deadZone) {
    const k = (((r - cfg.deadZone) / (1 - cfg.deadZone)) ** cfg.expo * cfg.maxTurnRate * m) / r;
    f.tx = x * k;
    f.ty = y * k;
  } else {
    f.tx = f.ty = 0;
  }
  follow(f, cfg.turnAccel * m * dt);
  return f;
}

// How hard the player steers against their own momentum, 0..1 (drives the handling rattle in Contoo 3).
export function strain(f, cfg = FLIGHT) {
  return Math.min(1, Math.hypot(f.tx - f.wx, f.ty - f.wy) / (2 * cfg.maxTurnRate));
}
