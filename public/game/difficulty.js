// The single difficulty curve (DESIGN §11, TECH "Difficulty curve"): depends only on time survived, rises fast in
// the first minute, then slower forever. Every knob is derived from it.
import { DIFFICULTY } from './config.js';

export function difficulty(t, c = DIFFICULTY) {
  return 1 - Math.exp(-t / c.fastSeconds) + c.slowWeight * Math.log(1 + t / c.slowSeconds);
}

// [a, b] = value at D = 0 and D = 1; both keep going past D = 1.
export const linearKnob = ([a, b], D) => a + (b - a) * D;
export const geometricKnob = ([a, b], D) => a * (b / a) ** D;

export function knobs(t, c = DIFFICULTY) {
  const D = difficulty(t, c);
  return {
    D,
    speed: linearKnob(c.speed, D),          // m/s forward
    pathGap: geometricKnob(c.pathGap, D),   // s between rocks in your path (meteor density)
  };
}
