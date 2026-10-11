# Hole: technical plan

How the design in [DESIGN.md](DESIGN.md) gets built. This is a plan, not a contract: change it when
something works better, and update this file when you do. All numbers are starting values to tune.

## Stack

- **three.js 0.186.x**, vendored into `public/game/vendor/` (the `three.module.min.js` build plus only the
  addons we use, e.g. `GLTFLoader`). Pin the exact version in `public/game/vendor/version.txt`.
- Plain ES modules and an import map in `index.html`. **No build step**, no npm packages at runtime.
  `public/` is deployed exactly as it is in git.
- WebAudio for all sound. DOM/CSS for the HUD and screens.
- Cloudflare Workers static assets (`wrangler.jsonc` → `assets.directory = ./public`). No server code.

## Code layout (`public/game/`)

| File | Job |
| --- | --- |
| `main.js` | Boot, game states (loading → start → run → game over), main loop |
| `config.js` | Every tunable number in one place (speeds, ranges, curves, colors) |
| `device.js` | Picks the `pc` or `mobile` asset set; `?set=pc` / `?set=mobile` overrides it for testing |
| `loader.js` | Reads `assets/manifest.json`, loads the chosen set, drives the loading bar, falls back to placeholder meshes if a file is missing |
| `input.js` | Keyboard (WASD) and multi-touch buttons → held directions |
| `flight.js` | Circle, turning momentum, forward speed, gravity drift on the player |
| `world.js` | Floating origin, spawning and recycling meteors around the player |
| `meteors.js` | Meteor types, instanced rendering, tint/crack/pulse shader, fuses, explosions, fragments |
| `gravity.js` | Big/massive pull on meteors and on the player, swarms, escape gaps |
| `walls.js` | Wall timing, layout, hole placement and reachability check |
| `difficulty.js` | The single difficulty curve and every value derived from it |
| `fx.js` | Camera effect stack: shake layers, lean/roll, edge darkening, stretch, explosion flash lights |
| `audio.js` | Music loops and synthesized sounds |
| `ui.js` | HUD (cross, circle, timer, touch buttons) and the start / game-over screens |

## Rendering and layers

- One full-screen WebGL canvas shows space. Above it, a DOM layer for edge darkening, and above that the HUD
  (cross, circle, timer, buttons) and screens. Camera effects only touch the canvas camera and the darkening
  layer, so the HUD can never shake, roll or flash.
- Background: a procedural starfield computed from view direction in a shader (hash-based stars on a
  direction grid), so it is perfectly even with no top, bottom or seams. Dust: procedural motes near the
  camera (speed feel) plus the dust/haze sprites from the conto, tinted by depth.
- Fog: exponential-squared, same color as the background, so far meteors are washed out. The background/fog
  color shifts from blue-black to red-black with difficulty, and the dust gets denser.
- Meteors: one `InstancedMesh` per rock shape. Per-instance attributes: tint, crack strength, pulse phase,
  fade. The shader extends `MeshStandardMaterial` (`onBeforeCompile`):
  - Tint multiplies the neutral-gray base color (gray rock, pale→deep yellow decoy, deepest-yellow exploder).
  - Cracks are procedural (3D Voronoi edges in object space) and emissive; their strength is multiplied by a
    "tell" factor that is 0 far away, faint at mid distance and full up close. The same factor drives the
    dust ring of massive meteors.
  - Fade-in uses dithered (hashed) alpha, so there is no transparency sorting and nothing pops.
- Explosion flash: a small pool of point lights (max 2 active) plus an additive glow sprite at the explosion.
  Never a full-screen flash.
- The camera never uses `lookAt` with a fixed up vector. Orientation is a quaternion that only changes by
  pitch and yaw in camera space; lean roll is a separate visual offset that eases back to zero.

## Distance bands (example values, meters)

| Band | Distance | What is visible |
| --- | --- | --- |
| Nearest | < 60 | Cracks, pulse and dust ring obvious |
| Mid | 60–150 | Tells faint; fuses start around 150 |
| Mid-far | 150–250 | Shapes and washed-out colors, no tells |
| Far | 250–400 | Dark silhouettes in fog; meteors spawn and fade in at ~400 |

## Flight model

Units: circle position `c` is measured in "circle ranges" (|c| ≤ 1); angles in degrees.

1. Held directions give a unit vector `u` (screen space, normalized for diagonals).
   `c += u * dt / 0.6`, then clamp |c| ≤ 1. Nothing else ever moves `c`.
2. Pull direction `p = c / |c|` when |c| > a small dead zone (about 0.06), else `p = 0`. The dead zone keeps
   "back on the cross" reachable with constant-speed buttons.
3. Target turn rate `ω* = p × 70°/s` (screen up → pitch up, screen right → yaw right).
4. Turn rate `ω` moves toward `ω*` with a capped angular acceleration (start near 140°/s², tune so a full
   right→left counter-steer keeps turning right for about 0.5 s after the circle crosses the cross).
5. Orientation `q = q × rotation(ω · dt)` in camera space. Forward speed comes only from the difficulty
   curve (start about 40 m/s).
6. Massive gravity adds a sideways drift to the player's velocity and an extra turn toward the meteor; both
   grow as distance shrinks.
7. Handling shake strength = how far `ω` is from `ω*` (steering against your own momentum).

## World

- **Floating origin:** the player is always at (0,0,0); meteors move instead. No precision problems in long
  runs.
- **Spawning:** keep a target number of meteors (from difficulty) in a sphere of ~400 m, but never in the
  rear cone (more than ~100° from where the camera faces). New meteors appear only at the far edge or outside
  the camera frustum, and fade in from fully fogged.
- **Recycling:** a meteor is removed only when it is out of view (behind, outside the frustum, or beyond the
  fog). When the player turns, under-filled directions outside the frustum are refilled first, so the new
  direction is already full.
- **Nothing from behind:** meteor speeds stay below player speed (fragments and slingshots are the
  exception and are recycled once they are behind and out of view).
- **Difficulty is applied at spawn time only:** each meteor stores its type, color and speed when it spawns.
- **Collision:** the player is a small sphere (~0.5 m). Each rock has a `collisionRadius` from the manifest
  slightly inside its surface, scaled per instance, so hits feel fair.

## Gravity, swarms and escape gaps

- Only big and massive meteors attract (O(meteors × attractors), attractors are few). Semi-implicit Euler.
- When a massive meteor spawns, it comes with a swarm: members placed on orbits (some bound, some passing
  fast enough to slingshot).
- Escape rule: while the pull on the player is above a threshold, spawn extra meteors on the side opposite
  the massive meteor, laid out to leave at least one gap wide enough for the turn radius at the current
  speed.

## Walls

- A wall is a curtain of meteors across the current flight direction with 1–2 holes, placed so that it
  emerges from the murk exactly `warning time × speed` ahead (wall meteors fade in at that distance).
- Holes are never on the current heading. Before a wall is spawned, the hole positions are checked by
  simulating the flight model (same code as `flight.js`) from the current state: the turn must fit inside the
  warning time with margin; otherwise pick another layout.

## Difficulty curve

- `t` = seconds survived. One smooth curve, e.g. `D(t) = 1 − e^(−t/40)` (fast first minute) plus a slow
  forever term `0.15 · ln(1 + t/180)`.
- Every knob is a function of `D`: forward speed, meteor count, wall interval (15 s → 6 s floor), wall warning
  (4 s → 2 s floor), exploder share, massive share, pull strength, decoy-to-exploder color distance,
  background color, dust density.

## Camera effects

- Shake layers (handling, explosion, gravity, near miss) are smooth noise, mostly rotation, summed and then
  capped so the view stays readable.
- Gravity: deep rumble, lean/roll toward the meteor (≤ 25°, eased back), darker screen edge on that side
  (DOM gradient layer), slight stretch (FOV / horizontal scale).

## Audio

- Unlock the `AudioContext` on the first tap/click/key (required on iOS).
- Music is required: 4 intensity loops (same key, tempo and bar length). All 4 start at the same moment as
  looping `AudioBufferSourceNode`s (`loopStart`/`loopEnd` from the manifest avoids MP3 padding gaps), each
  with its own gain. Difficulty `D` maps to a level 1→4; gains follow an equal-power crossfade that moves
  slowly (several seconds), so the music only ever gets more intense, never switches audibly.
- Sounds are synthesized, no files: whoosh = band-passed noise sweep panned to the passing side; rumble =
  low-passed brown noise plus a 30–50 Hz tone, gain from pull; boom = noise burst plus a falling low tone,
  volume from distance.

## Devices

- Asset set: `mobile` when the main pointer is coarse (`(pointer: coarse)` or `maxTouchPoints > 1` without
  hover, which also catches iPads that report a desktop user agent), else `pc`. Gameplay numbers are the same
  on both sets; only meshes and textures differ.
- Touch buttons appear when touch is available; WASD always works.
- Orientation: no lock. Everything is sized from `min(width, height)` and recomputed on resize.
- Fullscreen: Fullscreen API (with the `webkit` prefix). iPhone Safari has no element fullscreen, so there the
  button is hidden and a web app manifest (`display: fullscreen`) lets "Add to Home Screen" run fullscreen.
- Pixel ratio capped (about 1.5 on mobile, 2 on PC); adaptive quality if frame time stays high.
- Best time in `localStorage` (wrapped in try/catch).

## Assets

All runtime files live in `public/assets/`. File names are lowercase, no spaces.

| Asset | Count | PC | Mobile |
| --- | --- | --- | --- |
| Small rocks (`rock_01`…) | 8 shapes | ~2,500 tris, 1024² textures | ~800 tris, 512² textures |
| Big rocks (`big_01`…), used for big and massive | 3 shapes | ~10,000 tris, 2048² | ~3,000 tris, 1024² |
| Explosion fragments (`frag_01`…) | 4 shards | ~400 tris, one shared 1024² set | ~150 tris, shared 512² |
| Dust/haze sprites (`dust_01`…, `haze_01`…) | 4 + 2 | WebP 1024² with alpha | WebP 512² |
| Flash sprite (`flash_01`) | 1 | WebP 512² | WebP 256² |
| Music intensity loops (`music_1`…`music_4`) | 4 | OGG + MP3, 192 kbps | OGG + MP3, 96 kbps |

- Rocks: GLB, centered, bounding radius 1 m, +Y up in glTF. Base color is neutral gray (the game tints it),
  plus normal and ORM maps baked from the Pixal3D high-poly. Textures embedded as WebP if Blender's exporter
  allows it, else JPEG. No mesh compression is needed at these triangle counts, so no decoder files.
- Every file is far below the 25 MiB limit; the whole set should stay under ~15 MB (PC) and ~5 MB (mobile).

## Asset manifest (`public/assets/manifest.json`)

Paths are relative to `public/assets/`. The game reads only this file to find assets.

```json
{
  "version": 1,
  "meteors": {
    "small": [
      { "id": "rock_01", "pc": "meteors/pc/rock_01.glb", "mobile": "meteors/mobile/rock_01.glb",
        "collisionRadius": 0.82, "tris": { "pc": 2480, "mobile": 790 } }
    ],
    "big": [
      { "id": "big_01", "pc": "meteors/pc/big_01.glb", "mobile": "meteors/mobile/big_01.glb",
        "collisionRadius": 0.85, "tris": { "pc": 9900, "mobile": 2950 } }
    ],
    "fragments": [
      { "id": "frag_01", "pc": "meteors/pc/frag_01.glb", "mobile": "meteors/mobile/frag_01.glb",
        "collisionRadius": 0.7 }
    ]
  },
  "textures": {
    "dust": [ { "id": "dust_01", "pc": "textures/pc/dust_01.webp", "mobile": "textures/mobile/dust_01.webp" } ],
    "haze": [ { "id": "haze_01", "pc": "textures/pc/haze_01.webp", "mobile": "textures/mobile/haze_01.webp" } ],
    "flash": [ { "id": "flash_01", "pc": "textures/pc/flash_01.webp", "mobile": "textures/mobile/flash_01.webp" } ]
  },
  "music": [
    { "id": "music_1", "level": 1, "bpm": 128,
      "pc": { "ogg": "music/pc/music_1.ogg", "mp3": "music/pc/music_1.mp3" },
      "mobile": { "ogg": "music/mobile/music_1.ogg", "mp3": "music/mobile/music_1.mp3" },
      "loopStart": 0.0, "loopEnd": 60.0 }
  ]
}
```

## Local checks

- `python tools/check_public.py`: file limits, lowercase names, no LFS pointer files in `public/`, every
  manifest path exists.
- Serve and look at the browser console: `npx wrangler dev` (http://localhost:8787) or
  `python -m http.server 8000 -d public`. In a cloud session, use Playwright (preinstalled) to load the page
  and fail on console errors or 404s.
