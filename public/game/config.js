// Every tunable number lives here. Conto 2 starts it with the look of space and the meteor tints; Contoo adds
// the flight model, world, difficulty and effects values.

// Background and fog colour (blue-black; the difficulty curve later shifts it toward red-black).
export const SPACE_COLOR = '#05070d';
export const FOG_DENSITY = 0.012; // FogExp2, per metre (viewer value; the game derives it from the distance bands)

// Device pixel ratio cap per asset set.
export const PIXEL_RATIO_MAX = { pc: 2, mobile: 1.5 };

// Contoo 4, adaptive quality (quality.js): frames slower than slowFps (median over `window` s) step the pixel ratio
// down (base × steps, never under floor); a step that doesn't speed frames up by `gain` is undone and adapting stops.
export const QUALITY = { slowFps: 50, window: 2, settle: 0.6, gain: 0.08, steps: [1, 0.82, 0.68, 0.55], floor: 0.75 };

// Contoo 4, far LOD on PC: small rocks smaller than farPx on screen (radius in device px) use the mobile mesh;
// they switch back above farPx × hysteresis. (On mobile every rock already uses the mobile mesh.)
export const LOD = { farPx: 48, hysteresis: 1.2 };

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
  // Contoo 2: the danger knobs (DESIGN §11). Shares are of the small rocks; spawned rocks keep what they got.
  decoyShare: [0.12, 0.18],
  exploderShare: [0.008, 0.016],
  decoyCloseness: [0, 0.6],   // how far the deep end of the decoys has moved from decoyDeep to the exploder colour
  decoyDeepBias: [1.4, 3],    // shade = 1 - (1 - u)^bias: higher = more decoys near the deep (exploder-like) end
  massiveGap: [45, 16],       // s between massive meteors put near your path
  pull: [0.75, 0.9],          // strength of a massive meteor's pull on you (at 0.9 holding against it still wins)
  // Contoo 3: walls, combos and the look of depth (DESIGN §9, §11)
  wallGap: [15, 6],           // s between walls (geometric in D^wallEase), never under wallGapMin
  wallGapMin: 6,
  wallWarn: [4, 2],           // s: a wall emerges from the murk this long before you reach it (linear in D^wallEase)
  wallWarnMin: 2,
  wallEase: 1.6,              // > 1: walls stay slow and well warned through the first half minute
  wallTwoHoles: [0.65, 0.4],  // chance a wall has two holes (else one)
  wallExploders: [-0.045, 0.03],  // share of wall rocks that are exploders (none before D ≈ 0.6, ~35 s)
  wallCombo: [-0.75, 0.5],    // chance a wall due near a massive meteor comes anyway, next to it (none before D 0.6)
  deep: [0.15, 1.35],         // D over which space shifts from blue-black to red-black and the dust thickens
};

// World around the player (floating origin: the player stays at 0,0,0 and space moves).
export const WORLD = {
  radius: 300,          // m: meteors live inside this sphere; it is also where the fog is complete
  fogAtRadius: 0.02,    // how much of a meteor still shows through the fog at `radius` (sets the fog density)
  fadeBand: 25,         // m: meteors that appear in view do so in the last fadeBand before `radius`...
  fadeSeconds: 1.5,     // ...and fade in (extra fog) over this long
  sideMin: 40,          // m: meteors that appear out of view are never closer than this
  startClear: 80,       // m: nothing this close when a run starts (a fresh field, or out of view at the first run)
  keepMargin: 15,       // deg past the view's corners where space is kept full; meteors further round are dropped
  maxMeteors: 3000,     // performance cap; past it new rocks spawn bigger instead of more (same on PC and mobile)
  small: { radius: [4, 11] },            // m, log-uniform
  big: { share: 0.04, radius: [14, 30] }, // share of the count; the big shapes (massive meteors use them too)
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
  pauseLock: 0.3,       // s after coming back to a paused run before a tap/key continues it
  openSeconds: 0.5,     // the view opening again at a restart
  bestKey: 'hole.best',
};

// ---- Contoo 2: danger (DESIGN §6–7, TECH "Gravity, swarms and escape gaps")

// The tell: how much of an exploder's cracks and pulse and a massive meteor's dust ring shows, by distance
// (1 nearer than `near`, 0 past `far`, (1 - smoothstep)^power in between: faint at mid distance).
export const TELL = { near: 50, far: 150, power: 3 };

// Exploders. The fuse starts when one is in view, within `lateral` m of your heading and fuseSeconds + leadSeconds
// of flight ahead (150 m at 40 m/s), so it blows up ~leadSeconds ahead of you (70 m at 40 m/s). A share of them
// light a fuse on their own far away (farFuse m), so the player learns they exist.
export const EXPLODER = {
  fuseSeconds: 2,
  leadSeconds: 1.75,
  lateral: 70,
  farShare: [0.15, 0.05],     // over difficulty
  farFuse: [200, 265],
  crackColor: '#ff9a2e',
  crackScale: 2.3,            // Voronoi cells per rock radius
  crackWidth: 0.075,
  crackRest: 1.1,             // crack glow at rest (times the tell)
  crackFuse: 2.6,             // crack glow at the end of the fuse (shows through the distance a little)
  pulseHz: [0.6, 7],          // pulse at rest -> at the end of the fuse
};

// Explosions: 6–12 pieces (the fragment meshes) that hit like rocks and feel gravity; a flash of light that
// lights the rocks around it (never the whole screen) and a glow sprite at the explosion; a camera kick.
export const EXPLOSION = {
  pieces: [6, 12],
  pieceSize: [0.55, 0.9],     // times the size that keeps the rock's volume
  pieceSpeed: [16, 38],       // m/s away from the explosion
  pieceSpin: [0.8, 3],        // rad/s
  aimed: [1, 2],              // pieces sent toward you (when it is ahead of you)
  aimMiss: [0.5, 7],          // m: how far beside you an aimed piece would pass if you don't steer
  flashSeconds: 0.9,
  light: 9000,                // candela at the peak (point light, decay 2)
  lightRange: 150,            // m
  glow: 5,                    // glow sprite size, times the rock radius
  glowGain: 3.5,              // glow brightness (the flash texture's halo is faint; the core saturates)
  glowMaxView: 0.35,          // glow at most this share of its distance across (never a full-screen flash)
  kickDegrees: 2.6,
  kickSeconds: 0.5,
  kickRange: 230,             // m: no kick from further away
};

// Gravity. Only big and massive meteors pull. On meteors: mu = GM from the orbit period at 2.5 radii, within
// `range` radii; its own moons / swarm feel all of it, other meteors `fieldPull` of it (full strength, the slow
// drifting field fell into the big rocks by the hundred). On you (massive only): s = ((range - d) / (range -
// radius))^power, a turn toward it of up to turnMax °/s and a sideways drift of up to drift m/s, both times
// sin(angle off your heading) and `pull`.
export const GRAVITY = {
  big: { period: 20, range: 3.5, fieldPull: 0.15, members: [3, 6], orbit: [1.7, 2.8], memberSize: [2, 4.5] },
  massive: { period: 16, range: 6, fieldPull: 0.6, members: [9, 15], orbit: [1.8, 3.6], memberSize: [2.5, 7],
             slingshot: 0.25,
             radius: [16, 30], offAxis: [3, 13] },   // deg off your heading when it is put near your path
  absorb: 0.7,                // a meteor this deep inside a massive one (share of its radius) is hidden: dropped
  player: { range: [90, 4], turnMax: 200, drift: 20, power: 1.5, driftSeconds: 0.35, behind: [-0.5, 0] },
  ring: { points: { pc: 3000, mobile: 1500 }, radius: [1.45, 2.7], thickness: 0.05, size: [0.12, 0.5],
          puffs: 0.12, puffSize: [3, 7], puffAlpha: 0.1, color: '#cfc3a6', opacity: 0.6, period: 18 },
  // Escape rule: a porous sheet of extra meteors on the side away from the massive meteor, just in front of it,
  // with 1–2 clear holes (holeRadius m plus the rock's own radius) you can steer through.
  escape: { spacing: 21, lateral: [6, 135], across: 95, depth: 12, holes: [1, 2], holeRadius: 15,
            holeAt: [24, 80], size: [4, 9] },
};

// ---- Contoo 3: pressure (DESIGN §9–11, TECH "Walls", "Camera effects", "Audio")

// Walls: a curtain of rocks across your path with 1–2 holes. It is part of a sphere around where you are when it
// appears, of radius warning × speed, so it stands at the same distance across every direction you could turn to.
// Only the part inside the kept cone exists as rocks; turning fills in more of it, out of view. Holes are never on
// the path you are on (flying on as you are misses them by missBy m) and each is made by a simulated pilot that
// starts steering `reaction` s after the wall appears (the flight model, the pulls, the rocks in the way).
export const WALL = {
  extent: 115,            // deg from your heading when it appears: how far round the curtain reaches
  spacing: 12,            // m between rock centres (an even net on the sphere)
  jitter: 0.3,            // share of the spacing, sideways
  depth: 4,               // ± m in and out of the curtain
  size: [10, 15],         // m rock radius (log-uniform); with the spacing ~98% of the curtain is solid
  fadeSeconds: 0.7,       // how fast it comes out of the murk
  holeRadius: [17, 14],   // m clear (plus each rock's radius), over difficulty (D 0 -> 1)
  holeOffset: [10, 24],   // deg off your heading (on screen: the short side shows ±30°)
  holeMax: 45,            // deg: turning, holes can also be where you are turning to (within aheadSpread of where
  aheadSpread: 20,        // you would be heading after aheadSeconds), up to holeMax off your heading now
  aheadSeconds: 1,
  holeApart: 75,          // deg at least between two holes (around your heading)
  reaction: 0.6,          // s before the simulated pilot starts steering...
  clearance: 2.5,         // ...and it must pass at least this far inside the hole's edge
  missBy: 4,              // m: flying on as you are passes at least this far outside every hole's rim
  candidates: 16,         // hole layouts tried per wall
  retry: 0.25,            // s: try again this soon when no layout passes or a massive meteor is in the way
  giveUp: 4,              // s of retrying, then this wall is skipped
  firstAfter: [0.9, 1.1], // first wall after this share of the wall gap (about 15 s)
  gapJitter: [0.85, 1.15],
  // The field thins around each wall (inflow far ahead, timed for when you reach the wall): clearer approach,
  // a short calm after it. Seconds relative to reaching the wall.
  calm: { depth: 0.55, in: [-2.5, -0.6], out: [1.2, 3] },
  exploderFuse: [0.8, 2], // s: a wall exploder lights as the wall appears and blows up >= ~1.25 s before you reach it
  massiveClear: 8,        // m kept clear around a massive meteor's swarm (combo walls)
};

// Space gets deeper over a run (knobs().deep 0 -> 1): blue-black -> red-black, thicker dust.
export const DEEP = {
  space: '#0f0408',
  dust: '#c4a09c', haze: '#7a4752', motes: '#b8918c',
  dustOpacity: 1.35, hazeOpacity: 1.35, motesOpacity: 1.5,
  motesMore: 0.7,         // extra motes at full depth (share of the count)
};

// Camera effects: smooth wobbles of the view only (never the HUD), stacked and capped.
export const SHAKE = {
  maxDegrees: 4.5,        // cap of all the shake rotations together (pitch/yaw; the lean is a separate roll)
  handling: { base: 0.05, strain: 0.45, hz: [5.3, 7.9, 11.3] },  // deg: always a little, more when steering against your momentum
  rumble: { degrees: 1.1, hz: [1.9, 2.9, 4.3] },                   // deg at full pull
  nearMiss: { range: 5, degrees: 0.9, seconds: 0.4, hz: 8 },      // m from the rock's surface
  lean: { degrees: 25, full: 0.6, seconds: 0.45, back: 1.1 },     // roll toward a massive meteor (full at pull 0.6), eases back
  edge: 0.75,             // darkest edge on the meteor's side (at full pull)
  stretch: 0.06,          // the view stretched along the meteor's direction (at full pull)
  smooth: 0.12,           // s: amplitudes glide, never jump
};

// Synthesized sounds (no files) and the settings.
// Levels measured offline against the music (loops at -21 ... -18 dB RMS, peaks -11 ... -5 dB): a near boom and the
// crash peak around -3 dB, a full whoosh around -9 dB, the rumble at full pull about -20 dB RMS (mostly sub bass).
export const SOUND = {
  volume: 0.9,
  whoosh: { gain: 0.9, seconds: 0.6 },
  boom: { gain: 1.45, range: 330, near: 40 },  // m: full loudness inside `near`, gone at `range`
  rumble: { gain: 0.35 },
  crash: { gain: 1.5 },
};
export const SETTINGS = {
  key: 'hole.settings',
  steps: 10,                                      // volume steps (0 = off ... 10)
  defaults: { music: 8, sound: 8, debug: false }, // 8 = the mixed level (MUSIC.volume, SOUND.volume)
};
