// Every tunable number lives here. Conto 2 starts it with the look of space and the meteor tints; Contoo adds
// the flight model, world, difficulty and effects values.

// Background and fog colour (blue-black; the difficulty curve later shifts it toward red-black).
export const SPACE_COLOR = '#05070d';
export const FOG_DENSITY = 0.012; // FogExp2, per metre (viewer value; the game derives it from the distance bands)

// Device pixel ratio cap per asset set.
export const PIXEL_RATIO_MAX = { pc: 2, mobile: 1.5 };

// Meteor tints (sRGB). They multiply the neutral gray base colour of every rock.
// Decoys range from pale to deep yellow; near the deep end they are almost the exploder colour.
export const METEOR_TINTS = {
  gray: '#c8c8c8',
  decoyPale: '#efe4b4',
  decoyDeep: '#f2b81e',
  exploder: '#f2b414',
};

// Space sprites (sRGB tint and opacity; the textures are white with the shape in the alpha channel).
// Dust and haze veil what is behind them; the flash adds light.
export const SPRITES = {
  dust: { color: '#9aa6c4', opacity: 0.45 },
  haze: { color: '#4d5a7a', opacity: 0.35 },
  flash: { color: '#ffd9a0', opacity: 1.0 },
};

// Music: 4 intensity loops. Over a run it climbs level 1 -> 4 in one cycle (cycleSeconds; rampPower < 1 climbs
// faster early), drops back to level 1 on a bar line and starts the next cycle one step deeper: key and tempo up
// a semitone (up to maxSemitones), more reverb (mystery), more sub bass, a low drone on the tonal centre (C#2;
// the loops measure as C#). Arrays are per depth 0, 1, 2, 3. fadeSeconds = how long an intensity change takes.
export const MUSIC = {
  fadeSeconds: 6,
  volume: 0.8,
  cycleSeconds: 300,
  rampPower: 1,
  depth: {
    maxDepth: 3,
    semitonesPerCycle: 1,
    maxSemitones: 2,
    reverb: [0, 0.2, 0.3, 0.38],
    subDb: [0, 1.5, 3, 4],
    drone: [0, 0.035, 0.05, 0.065],
    droneHz: 69.3,
  },
};
