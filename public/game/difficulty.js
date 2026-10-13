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
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  return {
    D,
    speed: linearKnob(c.speed, D),          // m/s forward
    pathGap: geometricKnob(c.pathGap, D),   // s between rocks in your path (meteor density)
    // Contoo 2: shares of the small rocks, decoy colour, massive meteors, pull
    decoyShare: linearKnob(c.decoyShare, D),
    exploderShare: linearKnob(c.exploderShare, D),
    decoyCloseness: clamp01(linearKnob(c.decoyCloseness, D)),
    decoyDeepBias: linearKnob(c.decoyDeepBias, D),
    massiveGap: geometricKnob(c.massiveGap, D),
    pull: Math.min(c.pull[1], linearKnob(c.pull, D)),  // capped: holding against a pull must always win
    // Contoo 3: walls (how often, how much warning, holes, combos) and how deep space looks (0 = blue-black,
    // thin dust ... 1 = red-black, thick dust)
    wallGap: Math.max(c.wallGapMin, geometricKnob(c.wallGap, D ** c.wallEase)),
    wallWarn: Math.max(c.wallWarnMin, linearKnob(c.wallWarn, D ** c.wallEase)),
    wallTwoHoles: clamp01(linearKnob(c.wallTwoHoles, D)),
    wallExploders: clamp01(linearKnob(c.wallExploders, D)),
    wallCombo: clamp01(linearKnob(c.wallCombo, D)),
    deep: smooth01((D - c.deep[0]) / (c.deep[1] - c.deep[0])),
  };
}

const smooth01 = (x) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};
