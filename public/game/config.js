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
// faster early). In the last descentSeconds it sinks smoothly back to level 1 (levels crossfade down, a low-pass
// filter closes to dipHz and opens again, the reverb swells) while the next depth eases in: more reverb
// (mystery), more sub bass (weight), a low drone on the tonal centre (C#2; the loops measure as C#).
// Depth arrays are per depth 0, 1, 2, 3. fadeSeconds = how long an intensity change takes.
export const MUSIC = {
  fadeSeconds: 6,
  volume: 0.8,
  cycleSeconds: 300,
  descentSeconds: 30,
  rampPower: 1,
  dipHz: 700,
  depth: {
    maxDepth: 3,
    reverb: [0, 0.18, 0.28, 0.36],
    subDb: [0, 1.5, 3, 4],
    drone: [0, 0.035, 0.05, 0.065],
    droneHz: 69.3,
  },
};
