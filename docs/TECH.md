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
| `world.js` | Floating origin, the meteor field (inflow, turn fill, dropping), types at spawn, swarms, massive meteors and their escape sheets, gravity on meteors, fuses, explosions and fragments, collision, instance writing |
| `space.js` | Starfield, dust motes, the drifting dust/haze sprites (murk) |
| `meteors.js` | Type tints, the tell factor, instanced rendering with the fade/crack/pulse shader, the dust ring of massive meteors |
| `sprites.js` | Loads the dust / haze / flash sprite textures from the manifest; sprite materials (tint, normal or additive) |
| `gravity.js` | Pure math: attractor pull on meteors, the massive pull on the player (turn + drift), orbits and slingshots, the escape-sheet layout and its holes |
| `walls.js` | Wall timing, layout, hole placement and reachability check |
| `difficulty.js` | The single difficulty curve and every value derived from it |
| `fx.js` | Explosion flash (pooled point lights + glow sprites) and the camera kick; Contoo 3 adds the other shake layers, lean/roll, edge darkening, stretch |
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
- Meteors: one `InstancedMesh` per rock shape (8 small, 3 big, 4 fragments). Per instance: the tint
  (`instanceColor`) and `aFx` = (fade, crack, glow, seed). The shader extends `MeshStandardMaterial`
  (`onBeforeCompile`, `meteors.js`):
  - Tint multiplies the neutral-gray base color (gray rock, pale→deep yellow decoy, deepest-yellow exploder).
  - Cracks are procedural (F2 − F1 of a 3D Voronoi pattern in the rock's own space, `seed` shifts it; a hash of
    the two cells leaves some borders dark so it doesn't read as a regular net) and emissive, so the fog washes
    them out like the rock. Only instances with crack > 0 run the Voronoi (a branch per instance). Crack strength
    = `EXPLODER.crackRest` × tell + `crackFuse` × (fuse progress)²; the glow is the pulse (0.6 Hz at rest →
    7 Hz at the end of the fuse; the world advances its phase). Fragments start hot (crack 1.6, cooling in
    ~0.7 s).
  - The tell factor (`tellAt`, `TELL`) is (1 − smoothstep(50, 150, distance to the surface))³: 0 past 150 m,
    ~0.12 at 100 m, 1 nearer than 50 m. The same factor drives the dust ring.
  - Dust ring (massive meteors, `DustRing`): 3,000 points on PC / 1,500 on mobile in a thin disc 1.45–2.7
    radii out in the swarm's plane, inner dust going round faster; 88% fine grains (0.12–0.5 m), 12% big faint
    puffs (3–7 m, 10% alpha) that blur them into a band; fogged in the shader; opacity = tell × fade.
  - Fade-in (`aFx.x`) is extra fog: the fogged colour is blended further toward the fog colour, so a rock
    arriving at the far edge comes out of the murk smoothly. No transparency, no sorting. (A dithered fade
    showed as hatched discs on big rocks.)
- Explosion flash (`fx.js`): two point lights always in the scene (intensity 0 when idle, so shaders never
  recompile; the newest flash takes one) light the rocks around it (9,000 cd × rock size / 7 m at the peak,
  range 150 m, 0.9 s) plus an additive glow sprite at the explosion (flash texture × 3.5 gain, 5 rock radii)
  whose size is capped at 0.35 × its distance, so it never covers the screen. A far flash glows through the fog
  a little (opacity × visibility^0.45). Never a full-screen flash.
- Camera kick: a damped 8 Hz wobble in pitch/yaw (never roll), 2.6° × (1 − d / 230 m)² × √(size / 7 m),
  0.5 s; kicks add up, capped at 4.5°. Only the canvas camera moves.
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
- **Sizes:** small shapes 4–11 m radius, big shapes 14–30 m (4% of the count), log-uniform; drift up to
  0.3 × player speed (big 40% of that); spin 0.05–0.6 rad/s.
- **Types (Contoo 2, at spawn):** a small rock is an exploder (`exploderShare` 0.8% → 1.6%), a decoy
  (`decoyShare` 12% → 18%; shade = 1 − (1 − u)^bias with the bias 1.4 → 3, so later decoys sit near the deep
  end, and the deep end itself moves toward the exploder colour by `decoyCloseness` 0 → 0.6) or gray. Shares
  are of the count, which is large (165 rocks/s enter the cone at the start, 690/s at full difficulty), so a
  1% exploder share already means one near your path every ~10 s at the start. A big rock comes with 3–6 small
  moons (2–4.5 m) on orbits at 1.7–2.8 radii. Massive meteors are not a share: one is put near your path every
  `massiveGap` s (45 → 16 s, first one after 20–34 s), 3–13° off your heading, radius 16–30 m (the big
  shapes, so from far it looks like a big rock).
- **Groups arrive beyond the far edge:** a big rock entering through the far cap is set back along its flight
  line by its moons' orbit; a massive meteor starts at R + 1.35 × swarm radius + 15 m with its swarm and
  escape sheet. Beyond R a rock's fade stays 0 and it isn't drawn; crossing R it fades in like any arrival.
  These rocks carry a `far` allowance so they aren't dropped as "past the fog".
- **Drawing:** every frame only the meteors whose bounding sphere is in view are written into their shape's
  `InstancedMesh` (~250 at the start, ~600 at full difficulty).
- **Nothing from behind:** meteor speeds stay below player speed (fragments and slingshots are the
  exception; nothing exists behind you, so they are dropped once behind and out of view). A massive meteor is
  kept while it still pulls you and is not behind you (cos > −0.5), even outside the cone.
- **Difficulty is applied at spawn time only:** each meteor stores its type, color and speed when it spawns.
- **Collision:** the player is a 0.5 m sphere. Each rock's `collisionSpheres` from the manifest (5% under the
  surface, rotated and scaled with the instance) are tested against the player's sphere with a swept test
  along this frame's relative motion, so nothing tunnels through at speed.
- **Hit:** a 0.75 s effect: you bounce back off the rock (recoil 0.6 × speed, dying out in 0.25 s), the view
  kicks (a 4° wobble) and closes in from the edges like a hole (DOM layer, never a flash), then the game-over
  screen. A new run reopens the view over 0.5 s.

## Gravity, swarms and escape gaps

As built in Contoo 2 (`gravity.js`, `world.js`, values in `GRAVITY`):

- Only big and massive meteors attract. Softened inverse square, mu chosen so a circular orbit at 2.5 radii
  takes `period` s (big 20 s, massive 16 s), out to `range` radii (big 3.5, massive 6), fading over the outer
  40%. Semi-implicit Euler.
- A rock's own host pulls it fully every frame (moons and swarms orbit smoothly). Other attractors pull it
  with `fieldPull` (big 0.15, massive 0.6), every third frame with 3·dt. At full strength the slowly drifting
  field fell into the big rocks by the hundred (gravitational focusing ~10×) and thinned the field by 15%.
- Speed: a grid of 100 m cells lists the attractors whose reach touches each cell, so a rock only looks at a
  few. Field update + instance writing ~1 ms a frame at full difficulty on the dev machine (Contoo 1: 0.2 ms;
  all-pairs gravity was 3.5 ms).
- A meteor falling deep into a massive meteor (0.7 × its collision radius) is hidden inside it and dropped.
  Big rocks don't swallow (rocks pass through them as in Contoo 1), so the planned density holds.
- Swarm of a massive meteor: 9–15 members (2.5–7 m) in one plane (±12°) at 1.8–3.6 radii, a quarter of them
  slingshots falling in from further out at 1.1 × escape speed, aimed to pass 2.2–3 radii off the centre (they
  swing round at ~2× orbital speed). Members can be exploders.
- Pull on the player (massive only, `playerPull`): within range = 90 m + 4 radii, s = ((range − d) / (range −
  radius))^1.5. It turns you toward the meteor by 200 °/s × s × pull × sin(angle off your heading) (camera
  space, added to the flight model's turn rate, so it never rolls) and drags you sideways at up to 20 m/s × the
  same (smoothed over 0.35 s); both fade out as it goes behind you (smoothstep of cos from −0.5 to 0). `pull`
  goes 0.75 → 0.9 and is capped there: beside a massive meteor halfway in, the pull is 64 °/s at most, so
  holding against it (70 °/s) always wins. Measured: 1 °/s at the edge, ~27 °/s at 30° off halfway in.
- Escape rule (`escapeLayout`): decided when the massive meteor spawns (so nothing pops in): a porous sheet of
  extra rocks (4–9 m, a 21 m grid jittered, ±12 m deep) just in front of it, on the far side of your line from
  it, from 6 to ~135 m out and ±95 m across, with 1–2 holes (15 m clear plus each rock's radius) placed outside
  the swarm and 24–80 m (or just past the swarm) from your line. The sheet moves with the massive meteor and
  ignores gravity, so the holes stay open; new field rocks are not spawned inside a hole, and field rocks still
  fading in inside one are taken out. Sheet rocks are gray or decoys, never exploders.
- Tests (`tools/test_world.mjs`): do nothing near a massive meteor in your path and you hit it (39–40 of 40);
  steering through a hole gets you out (39–40 of 40, at the start and at 77 m/s ten minutes in, with a simple
  bang-bang pilot that keeps holding away until it lets go); every hole is clear and on the escape side.

## Walls

- A wall is a curtain of meteors across the current flight direction with 1–2 holes, placed so that it
  emerges from the murk exactly `warning time × speed` ahead (wall meteors fade in at that distance).
- Holes are never on the current heading. Before a wall is spawned, the hole positions are checked by
  simulating the flight model (same code as `flight.js`) from the current state: the turn must fit inside the
  warning time with margin; otherwise pick another layout.

## Fuses and explosions

As built in Contoo 2 (`world.js`, `EXPLODER`, `EXPLOSION`):

- The fuse lights when an exploder is in view, ahead, within 70 m of your path (plus its radius) and closer
  than (fuseSeconds + leadSeconds) × speed (2 + 1.75 s: 150 m at 40 m/s, 262 m at 70 m/s), so it blows up
  1.75 s ahead of you (70 m at 40 m/s), the time to dodge staying the same as speed grows. Exploders passing
  further to the side never light. A share (`farShare` 15% → 5%) light on their own when they come within
  200–265 m anywhere in view: far explosions, so the player learns they exist. Nothing lights behind the start
  screen.
- Explosion: the exploder is removed; if it is in view, 6–12 pieces (the 4 fragment meshes, each sized
  rock radius × sizeInRock × (4 / n)^⅓ × 0.55–0.9) fly out at 16–38 m/s on top of its drift, spin 0.8–3 rad/s
  and act as rocks (collision spheres from the manifest, gravity). If the fuse lit near your path, 1–2 pieces
  are aimed at where you will be if you fly on (an intercept), missing by 0.5–7 m: flying on, ~40% of runs get
  hit; turning away 0.3 s after the flash, ~5%. An explosion out of view throws no pieces (nothing unseen can
  hit you). Each explosion goes to `field.events`; `main.js` hands it to `fx.explode` (flash, light, kick).

## Difficulty curve

- `t` = seconds survived. One smooth curve, `D(t) = 1 − e^(−t/40)` (fast first minute) plus a slow
  forever term `0.15 · ln(1 + t/180)` (`difficulty.js`). Contoo 1 drives forward speed (40 → 70 m/s, linear in
  D, past D = 1 too) and the path gap (12 → 3 s, geometric in D): at 1 min 65 m/s and 3.9 s, at 10 min
  77 m/s and 2.2 s.
- Every knob is a function of `D`: forward speed, meteor count, wall interval (15 s → 6 s floor), wall warning
  (4 s → 2 s floor), exploder share, massive share, pull strength, decoy-to-exploder color distance,
  background color, dust density. Contoo 2 adds (`knobs()`): `decoyShare`, `exploderShare`, `decoyCloseness`,
  `decoyDeepBias`, `massiveGap` (geometric) and `pull` (capped at its D = 1 value).

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
- `node tools/test_world.mjs` (~1 min, no browser): flight model, difficulty curve, meteor field (even
  density, nothing pops, nothing from behind, path-gap calibration), and Contoo 2: type shares and decoy
  colour over a run, the tell, where fuses light and blow up (40 and 70 m/s), pieces (count, aimed, gravity,
  dodgeable), orbits and slingshots, the massive pull (edge, halfway, late in a run, behind), do nothing → hit
  it, escape through a hole, the escape sheet's holes.
- `NODE_PATH=$(npm root -g) node tools/check_danger.mjs [out.jpg] [--tiles dir]` (Playwright, ~5 min): the
  Contoo 2 check sheet `docs/checks/contoo2_danger.jpg` (exploder vs deep decoy by distance, a lit fuse and the
  blast, big rock vs massive meteor by distance, play). `?debug` also has `hole.stage()` (an empty stage: no
  field rocks, no massive meteors, only placed rocks hit), `hole.place({ type, dist, s, side, up, ... })` and
  `hole.spawnMassive({ dist, offAxis, s, ... })`.
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
