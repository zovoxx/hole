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

// ---- Contoo 1: flight, world, difficulty, HUD, run

// Flight model (DESIGN §4, TECH "Flight model"). The circle position c is in "circle ranges" (|c| <= 1).
export const FLIGHT = {
  circleSeconds: 0.6,   // cross to the edge of the range at one constant speed, only while a button is held
  deadZone: 0.06,       // |c| below this = no pull (keeps "back on the cross" reachable)
  maxTurnRate: 70,      // deg/s, top turning speed
  turnAccel: 140,       // deg/s², how fast the turn rate follows the pull (the heavy momentum)
  playerRadius: 0.5,    // m, the player's collision sphere
};

// Camera: the short screen side always shows fovShort degrees; the long side at most fovLongMax.
export const CAMERA = { fovShort: 60, fovLongMax: 100, near: 0.3, far: 1400 };

// Difficulty: one smooth curve of time survived, D(t) = 1 - e^(-t/fastSeconds) + slowWeight·ln(1 + t/slowSeconds).
// Every knob is [value at D = 0, value at D = 1] and keeps going past D = 1 (speed linearly, gaps geometrically).
export const DIFFICULTY = {
  fastSeconds: 40,
  slowWeight: 0.15,
  slowSeconds: 180,
  speed: [40, 70],      // m/s forward
  pathGap: [12, 3],     // seconds between rocks in your path if you flew straight (sets the meteor density)
};

// World around the player (floating origin: the player stays at 0,0,0 and space moves).
export const WORLD = {
  radius: 300,          // m: meteors live inside this sphere; it is also where the fog is complete
  fogAtRadius: 0.02,    // how much of a meteor still shows through the fog at `radius` (sets the fog density)
  fadeBand: 25,         // m: meteors that appear in view do so in the last fadeBand before `radius`...
  fadeSeconds: 1.5,     // ...and fade in (extra fog) over this long
  sideMin: 40,          // m: meteors that appear out of view are never closer than this
  keepMargin: 15,       // deg past the view's corners where space is kept full; meteors further round are dropped
  maxMeteors: 3000,     // performance cap; past it new rocks spawn bigger instead of more (same on PC and mobile)
  small: { radius: [4, 11] },            // m, log-uniform
  big: { share: 0.04, radius: [14, 30] }, // share of the count; the big shapes (plain gray until Contoo 2)
  drift: 0.3,           // max own speed, as a share of the player's speed (meteors never overtake you)
  spin: [0.05, 0.6],    // rad/s, log-uniform (big rocks spin at 30%)
  grayJitter: 0.05,     // ± brightness variation of the gray tint
  clearPath: { length: 220, margin: 4 },  // m: no meteors in the first stretch of your path at a new start
  attractSpeed: 40,     // m/s behind the start screen (no collisions, no drift into the path)
};

// Space dressing: procedural stars (at infinity), dust motes near the camera (speed feel) and a few big dust /
// haze sprites from the conto drifting in the murk.
export const SPACE = {
  stars: { count: 3200, size: [0.9, 2.2], seed: 7 },     // size in CSS px
  motes: { count: { pc: 700, mobile: 400 }, box: 45, size: 0.09, color: '#8d9ab8', opacity: 0.55 },
  sprites: { dust: 9, haze: 5, dustSize: [30, 70], hazeSize: [90, 170], nearFade: 0.9 },
};

// Lights ride with the camera, so rocks look the same in every direction (no fixed up).
export const LIGHTS = {
  ambient: { color: '#3a4560', intensity: 0.7 },
  key: { color: '#fff1e0', intensity: 1.9, dir: [-0.45, 0.55, -0.7] },  // from upper left, shining forward
  rim: { color: '#9aa8c8', intensity: 0.45, dir: [0.25, 0.15, 1] },     // from far ahead, toward the camera
};

// HUD sizes as a share of min(width, height); buttons in CSS px [min, share, max].
export const HUD = {
  circleRange: 0.17,    // how far the circle can go from the cross
  circleSize: 0.07,     // ring diameter
  crossSize: 0.05,      // crosshair width
  button: [64, 0.2, 124],
  buttonSlop: 0.15,     // a thumb this far (share of the button size) outside a button still holds it
};

// A run: hit effect, game over, restart.
export const RUN = {
  hitSeconds: 0.75,     // hit effect (recoil, kick, the view closing in) before the game-over screen
  recoil: 0.6,          // share of the speed you bounce back with...
  recoilSeconds: 0.25,  // ...dying out with this time constant (you end up ~recoil·speed·recoilSeconds back)
  kickDegrees: 4,
  restartLock: 0.45,    // s after the game-over screen appears before a tap/key restarts (panic taps)
  openSeconds: 0.5,     // the view opening again at a restart
  bestKey: 'hole.best',
};
