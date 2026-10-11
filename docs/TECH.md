# Hole: technical plan

How the design in [DESIGN.md](DESIGN.md) gets built. This is a plan, not a contract: change it when
something works better, and update this file when you do. All numbers are starting values to tune.

## Stack

- **three.js 0.186.1**, vendored into `public/game/vendor/`: `three.module.js` + `three.core.js` (the npm
  package no longer ships `.min.js` builds; Cloudflare compresses them) plus only the addons we use under
  `addons/`, renamed to lowercase (`addons/loaders/gltfloader.js` and the two utils it imports). Import map:
  `"three"` → `game/vendor/three.module.js`, `"three/addons/"` → `game/vendor/addons/`. Version, checksum and
  the renames are in `public/game/vendor/version.txt`.
- Plain ES modules and an import map in `index.html`. **No build step**, no npm packages at runtime.
  `public/` is deployed exactly as it is in git.
- WebAudio for all sound. DOM/CSS for the HUD and screens.
- Cloudflare Workers static assets (`wrangler.jsonc` → `assets.directory = ./public`). No server code.

## Code layout (`public/game/`)

| File | Job |
| --- | --- |
| `main.js` | Boot, game states (loading → start → run → hit → game over), main loop (`frame` draws, `tick` is one game step), hit effect, camera FOV |
| `config.js` | Every tunable number in one place (speeds, ranges, curves, colors) |
| `device.js` | Picks the `pc` or `mobile` asset set; `?set=pc` / `?set=mobile` overrides it for testing |
| `loader.js` | Reads `assets/manifest.json`, loads the chosen set, drives the loading bar, falls back to placeholder meshes if a file is missing |
| `input.js` | Keyboard (WASD) and multi-touch buttons → held directions |
| `flight.js` | Circle, turning momentum, forward speed, gravity drift on the player |
| `world.js` | Floating origin, the meteor field (inflow, turn fill, dropping), collision, instance writing |
| `space.js` | Starfield, dust motes, the drifting dust/haze sprites (murk) |
| `meteors.js` | Meteor types, instanced rendering, tint/crack/pulse shader, fuses, explosions, fragments |
| `sprites.js` | Loads the dust / haze / flash sprite textures from the manifest; sprite materials (tint, normal or additive) |
| `gravity.js` | Big/massive pull on meteors and on the player, swarms, escape gaps |
| `walls.js` | Wall timing, layout, hole placement and reachability check |
| `difficulty.js` | The single difficulty curve and every value derived from it |
| `fx.js` | Camera effect stack: shake layers, lean/roll, edge darkening, stretch, explosion flash lights |
| `audio.js` | Music loops and synthesized sounds |
| `ui.js` | HUD (cross, circle, timer, touch buttons), the loading / start / game-over screens, fullscreen, best time |
| `style.css` | Page, HUD and screen styles (sizes from `--u` = 1% of min(width, height)) |

## Rendering and layers

- One full-screen WebGL canvas shows space. Above it, a DOM layer for edge darkening, and above that the HUD
  (cross, circle, timer, buttons) and screens. Camera effects only touch the canvas camera and the darkening
  layer, so the HUD can never shake, roll or flash.
- Background: an even sprinkle of procedural stars at infinity (3,200 points at 1 km around the camera,
  uniform on the sphere, soft round points, `space.js`), so there is no top, bottom or seam. Dust: motes in a
  45 m box around the camera that wraps in the vertex shader (speed feel) plus a few big dust/haze sprites from
  the conto drifting in the murk (spawned and dropped like the meteors, thinning out as you get close).
- Fog: exponential-squared, exactly the background color, reaching 2% visibility at the field's radius
  (`WORLD.fogAtRadius`), so far meteors are washed out and a meteor at the edge is gone. The background/fog
  color shifts from blue-black to red-black with difficulty (Contoo 3), and the dust gets denser.
- No tone mapping (`NoToneMapping`): the scene is dark, the yellows stay yellow, and fog blends linearly. With
  Neutral tone mapping the background (not tone mapped) and fully fogged rocks (tone mapped) differ, and its
  dark-range curve squares contrast, so fogged rocks showed as dark silhouettes.
- Lights ride with the camera (ambient + key from upper left + a faint rim from ahead), so rocks look the same
  whichever way you face: no lighting cue for "up".
- Meteors: one `InstancedMesh` per rock shape. Per-instance attributes: tint, crack strength, pulse phase,
  fade. The shader extends `MeshStandardMaterial` (`onBeforeCompile`):
  - Tint multiplies the neutral-gray base color (gray rock, pale→deep yellow decoy, deepest-yellow exploder).
  - Cracks are procedural (3D Voronoi edges in object space) and emissive; their strength is multiplied by a
    "tell" factor that is 0 far away, faint at mid distance and full up close. The same factor drives the
    dust ring of massive meteors.
  - Fade-in (`aFade`) is extra fog: the fogged colour is blended further toward the fog colour, so a rock
    arriving at the far edge comes out of the murk smoothly. No transparency, no sorting. (A dithered fade
    showed as hatched discs on big rocks.)
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
| Far | 250–300 | Ghosts in the fog; meteors arrive and fade in at 275–300 (`WORLD.radius` 300) |

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
- **The field** (`world.js`): space is a uniform random field of meteors with density ρ (per m³), kept only
  inside a cone around where the camera faces, out to `WORLD.radius` (300 m). The cone's half-angle is the
  view's corner + 15° (`keepAngle`, ~65° on a 16:9 screen, ~68° on a portrait phone), so it always reaches past
  the screen. Nothing exists behind.
  - **Inflow:** flying forward, the field flows toward you. New meteors enter through the far cap at the rate
    a uniform field would: ρ · v · π(R·sin keep)². Their flight lines are spread evenly over the cap's
    projected disc (cosine-weighted entry points), and each appears a random depth up to `fadeBand` (25 m)
    down its line, inside the fog, fading in. Everything closer comes from there, so the density is even at
    every distance.
  - **Turn fill:** turning sweeps the cone into new directions. That thin sliver (solid angle ≈ 2·sin(keep)·δ
    for a turn of δ) is filled at once, from `sideMin` (40 m) to R, minus what already flows into it from the
    side (v·sin(keep)·dt across the edge). It lies past the view's corners, so nobody sees rocks arrive, and a
    turn, even all the way round, always finds space already full. A rock that would touch the view is skipped.
  - **Dropping:** a meteor that leaves the cone is dropped once it is out of view; past R + 5 m (in the fog)
    too. A wider view (phone turned to landscape) fills the new ring around the cone at once.
  - **Start of a run:** the whole cone is filled at once behind the closed view (from 20 m), with the first
    220 m of the path clear. Behind the start screen meteors do not drift, so the path stays clear.
  - `tools/test_world.mjs` checks the density is even (±15%) at every distance flying straight and turning,
    that nothing new appears in view except faded at the far edge, and that nothing comes from behind.
- **Density from the difficulty:** `DIFFICULTY.pathGap` is the seconds between rocks in your path if you flew
  straight (12 s → 3 s). ρ = 1 / (pathGap · speed · σ), with σ the mean area of your path a rock blocks (its
  collision spheres seen from a random direction, as a disc, plus the player's radius, over shapes and sizes;
  `effectiveRadius` and `meanCrossSection` in `world.js`). Measured: one per 7.9 s for a planned 8 s. Past
  `WORLD.maxMeteors` (3,000 in the cone) rocks get bigger instead of more (same on PC and mobile).
- **Sizes:** small shapes 4–11 m radius, big shapes 14–30 m (4% of the count; plain gray rocks until
  Contoo 2), log-uniform; drift up to 0.3 × player speed (big 40% of that); spin 0.05–0.6 rad/s.
- **Drawing:** every frame only the meteors whose bounding sphere is in view are written into their shape's
  `InstancedMesh` (~250 at the start, ~600 at full difficulty).
- **Nothing from behind:** meteor speeds stay below player speed (fragments and slingshots are the
  exception and are recycled once they are behind and out of view).
- **Difficulty is applied at spawn time only:** each meteor stores its type, color and speed when it spawns.
- **Collision:** the player is a 0.5 m sphere. Each rock's `collisionSpheres` from the manifest (5% under the
  surface, rotated and scaled with the instance) are tested against the player's sphere with a swept test
  along this frame's relative motion, so nothing tunnels through at speed.
- **Hit:** a 0.75 s effect: you bounce back off the rock (recoil 0.6 × speed, dying out in 0.25 s), the view
  kicks (a 4° wobble) and closes in from the edges like a hole (DOM layer, never a flash), then the game-over
  screen. A new run reopens the view over 0.5 s.

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

- `t` = seconds survived. One smooth curve, `D(t) = 1 − e^(−t/40)` (fast first minute) plus a slow
  forever term `0.15 · ln(1 + t/180)` (`difficulty.js`). Contoo 1 drives forward speed (40 → 70 m/s, linear in
  D, past D = 1 too) and the path gap (12 → 3 s, geometric in D): at 1 min 65 m/s and 3.9 s, at 10 min
  77 m/s and 2.2 s.
- Every knob is a function of `D`: forward speed, meteor count, wall interval (15 s → 6 s floor), wall warning
  (4 s → 2 s floor), exploder share, massive share, pull strength, decoy-to-exploder color distance,
  background color, dust density.

## Camera effects

- Shake layers (handling, explosion, gravity, near miss) are smooth noise, mostly rotation, summed and then
  capped so the view stays readable.
- Gravity: deep rumble, lean/roll toward the meteor (≤ 25°, eased back), darker screen edge on that side
  (DOM gradient layer), slight stretch (FOV / horizontal scale).

## Audio

- Unlock the `AudioContext` on the first tap/click/key (required on iOS): `unlockAudio(ctx)` in `audio.js`.
- Music is required: 4 intensity loops (same key, tempo and bar length). `Music` in `audio.js` (written in
  Conto 3, tested in `/dev/viewer.html`) starts all 4 at the same moment as looping `AudioBufferSourceNode`s
  playing `loopStart`..`loopEnd`, each with its own gain, into a gentle limiter. `setIntensity(x)` takes a
  continuous level x in 1..4; only the two neighbouring loops sound, with a constant-power crossfade that
  moves slowly (`MUSIC.fadeSeconds` in `config.js`), so changes are never heard as a switch. OGG (Vorbis)
  where the browser plays it, else MP3 (Safari).
- Music cycle (the owner's rule): the game calls `music.follow(runSeconds, MUSIC)` every frame. Level climbs
  1 → 4 over `MUSIC.cycleSeconds` (300 s); in the last `descentSeconds` (30 s) it sinks smoothly back to 1
  (levels crossfade down, a low-pass filter closes to `dipHz` and opens again, the reverb swells) while the
  next depth eases in (`MUSIC.depth`, capped at 3): more reverb (generated impulse), more sub (low shelf) and
  a quiet breathing drone on the tonal centre (C#2; the loops measure as C#, not the requested D minor).
  Nothing switches at once (an earlier version jumped a semitone at a bar line; the owner found the change
  too abrupt). Try it on `/dev/music.html` (speed 1×/10×/30×, jump to before the descent, effects on/off).
- Every music file holds its loop plus 0.25 s of cyclic padding on both sides (the loop's end before it, its
  start after it). Whatever offset a decoder adds (MP3 encoder delay that one browser trims and another
  doesn't) only shifts the window inside cyclic audio, so the loop stays seamless and the 4 levels stay in
  sync (they shift together).
- The 4 levels are one track: level 4 was generated from text, levels 3, 2, 1 from level 4 by ACE-Step
  audio-to-audio with rising denoise and calmer tags, so they keep its beat grid and harmony and a crossfade
  sounds like layers coming and going. `rhoNext` in the manifest is how alike a loop is to the next level;
  the crossfade divides by `sqrt(1 + rhoNext·sin 2θ)` so similar loops don't get louder in the middle.
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
- No zoom (owner's wish): viewport `width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no,
  viewport-fit=cover`; `touch-action: none` on the canvas, buttons and screens (`manipulation` is not enough for
  fast repeated taps); `-webkit-user-select: none`, `-webkit-touch-callout: none`,
  `-webkit-tap-highlight-color: transparent`; `preventDefault` on `touchstart`/`touchmove` of game elements
  (passive: false), on `dblclick`, and on iOS `gesturestart` / `gesturechange` (pinch), because iOS Safari
  ignores `user-scalable=no`. Test fast double taps on the buttons and on empty screen on iPhone and Android.
- Fewer Safari fullscreen warnings (owner's wish; iPad Safari watches touches and keys in element fullscreen
  and shows a warning in the middle of the screen, and has an entry banner): ask for fullscreen only from the
  fullscreen button (start screen; on the game-over screen only while not in fullscreen), never automatically
  and never mid-run; stay in fullscreen across game over and restart (never exit and re-enter; the game-over
  screen has no exit button); controls are held buttons where thumbs stay still (no
  swipe or drag controls, fast-moving touches raise Safari's suspicion score); no text inputs; on iPad with a
  hardware keyboard, typing keys in fullscreen can trigger the warning, so test WASD there and, if it does,
  show the keyboard hint only outside fullscreen. Keep the "Add to Home Screen" hint (a home-screen app has no
  warnings). Test on an iPad: several full runs in fullscreen without a warning.
- As built (Contoo 1): every touch on the page is `preventDefault`-ed (`touchstart`/`touchmove`/`touchend`,
  passive: false) and the buttons use pointer events, so touches never make clicks or zooms; the fullscreen
  button reacts on `touchend` (a user gesture everywhere) or `click` (mouse, keyboard) and never starts the
  run. A key held through a crash (auto-repeat) does not restart; restarting needs a fresh press after 0.45 s.
  The start screen says "W A S D to steer" without touch and "Hold the arrows to steer" with touch.
- Camera: the short side of the screen always shows 60°; the long side at most 100° (portrait phones get a
  taller view, ultra-wide screens a lower one). Touch buttons: min(124 px, max(64 px, 20% of the short side)),
  multi-touch, each thumb holds the nearest button it is on (15% slop), so two thumbs give diagonals.
- Pixel ratio capped (about 1.5 on mobile, 2 on PC); adaptive quality if frame time stays high.
- Best time in `localStorage` (wrapped in try/catch).

## Assets

All runtime files live in `public/assets/`. File names are lowercase, no spaces.

| Asset | Count | PC | Mobile |
| --- | --- | --- | --- |
| Small rocks (`rock_01`…) | 8 shapes | ~2,500 tris, 1024² textures | ~800 tris, 512² textures |
| Big rocks (`big_01`…), used for big and massive | 3 shapes | ~10,000 tris, 2048² | ~3,000 tris, 1024² |
| Explosion fragments (`frag_01`…) | 4 shards | ~400 tris, 512² each | ~150 tris, 256² each |
| Dust/haze sprites (`dust_01`…, `haze_01`…) | 4 + 2 | WebP 1024² with alpha | WebP 512² |
| Flash sprite (`flash_01`) | 1 | WebP 512² | WebP 256² |
| Music intensity loops (`music_1`…`music_4`) | 4 | OGG + MP3, 192 kbps | OGG + MP3, 96 kbps |

- Rocks: GLB, centered, bounding radius 1 m, +Y up in glTF, vertex tangents. Base color is neutral gray with
  the same median on every rock (the game tints it), plus normal and ORM maps (AO, roughness 0.85, metal 0)
  baked from the Pixal3D high-poly. Textures embedded as WebP (`EXT_texture_webp`, required; three.js
  supports it). No mesh compression is needed at these triangle counts, so no decoder files.
- Fragments: same format; flat broken faces with sharp (split) normals. One GLB per fragment.
- Every file is far below the 25 MiB limit; the meteor set is 5.7 MiB (PC) and 2.2 MiB (mobile).
- How they are made: `tools/blender_meteors.py` (see its docstring), mesh repair/decimation in
  `tools/mesh_tool.py`, manifest by `tools/write_manifest.py`, check sheet `docs/checks/conto2_meteors.jpg`.
- Sprites: WebP with alpha, square, white RGB with the shape in alpha (brightness of a Z-Image Turbo image on
  black, with a soft radial edge mask, so no square border can show). The game tints them with the material
  colour (`SPRITES` in `config.js`): dust and haze blend normally, the flash is additive. Made by
  `tools/make_sprites.py`; prompts, seeds and processing in `source/textures/sprites.json`.
- Music: 32-bar loops at 128 BPM with a C# tonal centre (60 s), 48 kHz stereo, OGG Vorbis + MP3 per set, with 0.25 s of
  cyclic padding (see Audio). Made by `tools/comfy_client.py` / `tools/gen_queue.py` (`acestep` jobs) and
  `tools/music_loop.py` (beat grid, loop window with the smallest seam, crossfaded loop closure, resampling to
  exactly 32 bars, loudness per level, encoding and decode check); details in `source/music/music.json`.

## Asset manifest (`public/assets/manifest.json`)

Paths are relative to `public/assets/`. The game reads only this file to find assets.

```json
{
  "version": 1,
  "meteors": {
    "small": [
      { "id": "rock_01", "pc": "meteors/pc/rock_01.glb", "mobile": "meteors/mobile/rock_01.glb",
        "collisionRadius": 0.734, "collisionSpheres": [[0.05, -0.02, 0.1, 0.71], "... up to 12"],
        "tris": { "pc": 2500, "mobile": 800 }, "texture": { "pc": 1024, "mobile": 512 },
        "bytes": { "pc": 412000, "mobile": 150000 } }
    ],
    "big": [ "... same fields" ],
    "fragments": [
      { "id": "frag_01", "...": "same fields", "sizeInRock": 0.849, "source": "rock_04" }
    ]
  },
  "textures": {
    "dust": [ { "id": "dust_01", "pc": "textures/pc/dust_01.webp", "mobile": "textures/mobile/dust_01.webp",
                "size": { "pc": 1024, "mobile": 512 }, "bytes": { "pc": 90000, "mobile": 30000 } } ],
    "haze": [ "... same fields" ],
    "flash": [ "... same fields" ]
  },
  "music": [
    { "id": "music_1", "level": 1, "bpm": 128, "bars": 32, "beatsPerBar": 4, "key": "C#",
      "pc": { "ogg": "music/pc/music_1.ogg", "mp3": "music/pc/music_1.mp3" },
      "mobile": { "ogg": "music/mobile/music_1.ogg", "mp3": "music/mobile/music_1.mp3" },
      "loopStart": 0.25, "loopEnd": 60.25, "rhoNext": 0.42,
      "bytes": { "pc": { "ogg": 1300000, "mp3": 1450000 }, "mobile": { "ogg": 700000, "mp3": 730000 } } }
  ]
}
```

- `collisionRadius`: one sphere at the origin with ≥ 92% of its volume inside the rock. `collisionSpheres`:
  `[x, y, z, r]` (GLB units, glTF axes), greedy set of spheres 5% under the surface covering most of the
  volume. Both scale with the instance. `sizeInRock`: a fragment's radius relative to its source rock.
- `tools/write_manifest.py` rewrites the whole manifest: `meteors` from the GLBs and
  `source/meteors/meteors.json`, `textures` from the WebPs in `public/assets/textures/`, `music` from
  `source/music/music.json` and the files in `public/assets/music/`.

## Local checks

- `python tools/check_public.py`: file limits, lowercase names, no LFS pointer files in `public/`, every
  manifest path exists.
- `node tools/test_world.mjs` (a few seconds, no browser): flight model, difficulty curve, meteor field
  (even density, nothing pops, nothing from behind, path-gap calibration).
- `NODE_PATH=$(npm root -g) node tools/test_game.mjs [--shots dir] [--only desktop|mobile]` (Playwright,
  ~5 min): serves `public/` itself and plays the game on desktop and on iPhone, Android and iPad emulation
  (portrait, landscape, rotation): no console errors or 404s, keys and two-thumb touch, circle speed and
  heavy counter-steer, fullscreen button, hit → game over → restart, best time, fast double taps never zoom.
  Headless Chromium draws with a software rasterizer (~0.3–1 s per frame), so the checks run on the game's
  test clock: `?debug` exposes `hole.advance(seconds)` (the same per-frame code in fixed 1/60 s steps),
  `hole.setRendering(false)`, `hole.setTestOnly(true)` (only `hole.placeAhead()` rocks can hit) and a read-out
  of fps, meteor counts and the flight state.
- Serve and look at the browser console: `npx wrangler dev` (http://localhost:8787) or
  `python -m http.server 8000 -d public`.
