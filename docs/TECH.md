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
- Loading (Contoo 4): `index.html` preloads the whole module graph (`modulepreload`) and the manifest, so the
  browser fetches them at once instead of import by import. `public/_headers` lets browsers keep meteors, sprites
  and music for 30 days; the game asks for them as `file?v=<bytes>` (sizes from the manifest, `assetUrl` in
  `loader.js`), so a changed file gets a new URL. The code and the manifest keep Cloudflare's default
  (`max-age=0, must-revalidate`). `wrangler dev` serves `_headers` the same way.

## Code layout (`public/game/`)

| File | Job |
| --- | --- |
| `main.js` | Boot, game states (loading → start → run → hit → game over), main loop (`frame` draws, `tick` is one game step), hit effect, camera FOV, the lean and stretch applied to the camera, space colour over a run |
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
| `walls.js` | Wall timing and calm, the curtain's net of rocks, hole placement, the simulated pilot and the reachability check, combos |
| `difficulty.js` | The single difficulty curve and every value derived from it |
| `fx.js` | Explosion flash (pooled point lights + glow sprites) and the camera shake stack: explosion and near-miss kicks, handling rattle, gravity rumble, the lean (roll, darker edge side, stretch amount) |
| `audio.js` | `Music` (the intensity loops, the 5-minute cycle, the game-over duck) and `Sfx` (synthesized whoosh, rumble, boom, crash) |
| `sound.js` | The game's audio: one AudioContext, unlock on the first gesture, music loading in the background, what plays when (run, hit, restart), volumes |
| `settings.js` | Player settings (music volume, sound volume, debug read-out) in `localStorage` |
| `quality.js` | Adaptive quality (Contoo 4): steps the pixel ratio down while frames stay slow |
| `ui.js` | HUD (cross, circle, timer, touch buttons), the loading / start / game-over screens, fullscreen, best time, the settings panel, the lean's darker edge |
| `style.css` | Page, HUD and screen styles (sizes from `--u` = 1% of min(width, height)) |

## Rendering and layers

- One full-screen WebGL canvas shows space. Above it, DOM layers for edge darkening (`#lean-edge`: the side of a
  massive meteor; `#edge`: the hit and the restart), and above that the HUD (cross, circle, timer, buttons) and
  screens. Camera effects only touch the canvas camera and the darkening layers, so the HUD can never shake, roll
  or flash.
- Background: an even sprinkle of procedural stars at infinity (3,200 points at 1 km around the camera,
  uniform on the sphere, soft round points, `space.js`), so there is no top, bottom or seam. Dust: motes in a
  45 m box around the camera that wraps in the vertex shader (speed feel) plus a few big dust/haze sprites from
  the conto drifting in the murk (spawned and dropped like the meteors, thinning out as you get close).
- Fog: exponential-squared, exactly the background color, reaching 2% visibility at the field's radius
  (`WORLD.fogAtRadius`), so far meteors are washed out and a meteor at the edge is gone.
- Depth over a run (Contoo 3, `knobs().deep` = smoothstep of D from 0.15 to 1.35, `DEEP`): background and fog go
  from blue-black `#05070d` to red-black `#0f0408` (~0.25 at 30 s, 0.6 at 1 min, 0.9 at 5 min); dust and haze
  sprites and the motes turn from blue-gray to red-gray and get 35–50% stronger, and 70% more motes fade in one by
  one (each has a rank; the shown share rises smoothly). Nothing steps or pops.
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
  pitch and yaw in camera space; lean roll is a separate visual offset that eases back to zero. The camera shown
  is `q × lean × shake × hit kick`; the frustum (spawning, dropping, fuses) uses that camera with the projection
  before the stretch, which sees slightly more than the stretched view, so nothing is placed or dropped where it
  would show.

## Distance bands (example values, meters)

| Band | Distance | What is visible |
| --- | --- | --- |
| Nearest | < 60 | Cracks, pulse and dust ring obvious |
| Mid | 60–150 | Tells faint; fuses start around 150 |
| Mid-far | 150–250 | Shapes and washed-out colors, no tells |
| Far | 250–300 | Ghosts in the fog; meteors arrive and fade in at 275–300 (`WORLD.radius` 300) |

## Controls (owner's wish after Contoo 4)

Two schemes in the settings (`settings.controls`, default `joystick`), and a sensitivity (`settings.sensitivity`,
1–10, default 5: m = 2^((step − 5) / 11.5), 0.79 … 1.35; `SENSITIVITY`, `sensitivity()` in `flight.js`).

- **Joystick** (`stepJoystick`, `JOYSTICK`): stick s, |s| ≤ 1, springs back to 0 when let go. The circle shows the
  stick. Target turn = direction × ((|s| − 0.06) / 0.94)^1.5 × 90 °/s × m (fine control near the cross); the turn
  follows at 520 × m °/s² (light, still a ship). Top turn 71 … 122 °/s: even the lowest beats Extreme's 70 °/s
  and a massive meteor's strongest pull (~64 °/s). Inputs (`input.js`): a floating touch / mouse stick (base where
  the pointer went down, full push 11% of the short side away, the base follows past the edge so turning back is
  quick; drawn under the thumb), else a gamepad's left stick or d-pad (A / Start = a press), else the keys (pushed
  to the edge in 0.18 s, back in 0.1 s). No touch buttons.
- **Extreme** (`stepFlight`, `FLIGHT`): the heavy circle below, with the circle m times as fast (`extremeConfig`).
  The settings show it in red ("extreme difficulty"), the start and game-over screens carry an "Extreme" tag, and it
  keeps its own best time (`hole.best`, where every earlier run was; the joystick's is `hole.best.joystick`).
- **Walls are planned with the player's controls** (`controlsModel(kind, m)` in `walls.js`, `walls.controls`): how
  the ship flies on as you are (Extreme: the circle stays; joystick: the stick held) and a pilot for each scheme
  (`pilot`, `joystickPilot`). `tools/audit.mjs` checks every hole is made with the joystick at sensitivity 1, 5 and
  10 and that the joystick at sensitivity 1 gets out through escape holes.
- `?controls=extreme|joystick` overrides the setting for the visit (tests; not saved).

## Flight model (Extreme)

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
  - **Start of a run:** the whole cone is filled at once behind the closed view, with nothing within
    `WORLD.startClear` (80 m, big rocks' moons included) and the first 220 m of the path clear. Behind the start
    screen meteors do not drift, so the path stays clear; when the first run starts from it, the rocks within 80 m
    that are out of view are cleared (`clearNear`; the ones you can see stay). Contoo 4: with the fill from 20 m,
    turning at once could meet a rock 30–45 m to the side less than a second after the view opened.
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
- **Far LOD (Contoo 4, PC only):** each small shape has a second `InstancedMesh` with its mobile mesh and textures,
  loaded in the background after the start screen (`loadFarLod` in `main.js`, `field.addFarLod`). A small rock whose
  radius on screen is under `LOD.farPx` (48 device px) is drawn with it; it switches back above ×1.2 (no flicker).
  Big rocks and fragments always use their own set. Two minutes in, ~85% of the drawn rocks are far and the
  triangles halve (1.04 M → 0.53 M) with no visible change (`docs/checks/contoo4_ship.jpg`).
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

As built in Contoo 3 (`walls.js`, `WALL`, the wall knobs in `DIFFICULTY`):

- **Shape:** part of a sphere around where you are when the wall appears, radius L = warning × speed, reaching
  115° round from your heading. So it stands at the same distance in every direction you could turn to: you can't
  fly round it, you need a hole. Its rocks sit on an even net (a Fibonacci spiral over the cap, 12 m apart,
  jittered ±30% sideways and ±4 m in depth), radius 10–15 m, gray with decoys like the field; only the shapes whose
  collision spheres fill most of their size (not the thin rock_02 and rock_07). A straight path into it hits a
  rock 98% of the time (measured with the real collision spheres).
- **Only the part inside the kept cone exists as rocks** (~700–950 when it appears). Turning brings more of it in,
  out of view, like the field's turn fill; parts that leave the cone are dropped and come back the same (the net
  is fixed); a rock that blew up stays gone. Wall rocks don't drift, spin at half speed and ignore gravity
  (`noGrav`), so the holes stay open. The wall closes (no more filling) once you are through it.
- **Warning:** the wall appears at L, all at fade 0, and comes out of the murk in 0.7 s (`fadeRate`), so you see it
  `wallWarn` seconds before you reach it: 4 s early, 2 s after a few minutes (linear in D^1.6, floor 2: 3.6 s at
  15 s, 2.5 s at 1 min, 2 s from ~2 min).
- **Holes:** 1–2 (two holes 65% → 40% of the time), 17 → 14 m clear plus each rock's whole radius, at least 75°
  apart around your heading. Candidates: 10–24° off your heading (on screen on every device), or, if you are
  turning, within 20° of where you would be heading after 1 s of flying on as you are (up to 45° off). A layout
  is kept only if (`flyThrough`, the real `stepFlight`, the pull of massive meteors, 1/30 s steps):
  - flying on as you are (the circle left where it is) passes at least 4 m outside every hole's rim (its clear
    radius plus the biggest rock, 15 m: the rocks' collision spheres sit inside their size, so a hole is a little
    wider than its clear radius), so a hole is never on your path;
  - for every hole, a simulated pilot that starts steering 0.6 s after the wall appears gets through it at least
    2.5 m inside its edge. The pilot (`pilot()`, shared with the tests) aims the cross at a point 30 m past the
    hole with the circle like a player would: bang-bang with the circle kept near the cross (0.3 of its range),
    braking on the way in, allowing for the pull;
  - no rock already there (its straight-line motion, its collision reach plus 1.25 m) is in the pilot's way in
    the last 0.8 s before the wall or in the hole itself (rocks earlier on the way are dodged like any rock).
  Up to 16 layouts are tried (~2–5 ms: flying on as you are doesn't depend on the holes, so that path is flown
  once per wall and each layout is measured against it, `pathThrough`); if none passes, the wall tries again every
  0.25 s and is skipped after 4 s. Measured: placed at once 87–100% of the time when flying straight, 73–100% when
  turning. The planner is warmed up at boot (`walls.warmUp`: three plans thrown away), since its first, cold run
  took 16–25 ms, a hitch just as the first wall came out of the murk.
- **Rhythm and calm:** a wall every `wallGap` seconds (15 s → 6 s, geometric in D^1.6, floor 6; ±15% jitter; the
  first after ~15 s). The field's inflow far ahead thins to 45% around each wall, timed for when you reach it
  (from 2.5 s before to 3 s after, smooth): a clearer approach and a short calm after. Walls never come while a
  massive meteor pulls you or will within the warning, unless it is a combo.
- **Combos (from D ≈ 0.6, ~35 s):** exploders in the wall (0 → 3% of its rocks, never within 2.2 hole radii of a
  hole); near your path they light as the wall appears, with a fuse of warning − 1.25 s (0.8–2 s), so they blow up
  about 1.2 s before you reach the wall and open a gap there. A wall due near a massive meteor comes anyway with
  chance `wallCombo` (0 → 50%): its holes are first lined up with the meteor's escape holes (where they will be),
  else on the side away from it; the pilot check includes the pull and flies on 110 m past the wall through the
  escape sheet; the swarm (where it will be) and the escape holes are kept open through the wall.
- New field rocks are not spawned inside an open wall's holes (`inAnyHole`).
- Tests (`tools/test_world.mjs`): the knobs, the rhythm and warning over a 5.5-minute run, flying straight on
  hits the wall (0–3 of 40 slip through a random gap), the pilot gets through 25 of 25 walls at 0, 1 and 10 minutes
  (straight and turning), combos (26 of 30 through and away; the misses are swarm and sheet rocks the pilot doesn't
  dodge), wall exploders, the calm, near misses.

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
  `decoyDeepBias`, `massiveGap` (geometric) and `pull` (capped at its D = 1 value). Contoo 3 adds `wallGap` and
  `wallWarn` (in D^1.6, so the first half minute keeps slow, well-warned walls), `wallTwoHoles`,
  `wallExploders`, `wallCombo` and `deep` (space colour and dust).
- Everything that changes meteors reaches only new spawns far ahead. Speed, the space colour and the dust change
  continuously and slowly.

## Camera effects

As built in Contoo 3 (`fx.js`, `SHAKE`): every layer is pitch/yaw of the view only (no roll except the lean),
smooth (sums of three sines at unrelated frequencies, never random per frame) with amplitudes that glide (0.12 s),
summed and capped at 4.5°. Only the canvas camera moves.

| Layer | When | What |
| --- | --- | --- |
| Handling | Always | 0.05° + 0.45° × strain (how far the turn rate is from where the circle pulls it), 5–11 Hz |
| Explosion | A blast | 2.6° × (1 − d / 230 m)² × √(size / 7 m), damped 8 Hz, 0.5 s (Contoo 2) |
| Gravity | A massive meteor pulls | Rumble 1.1° × min(1, pull / 0.6) at 2–4 Hz; lean: a roll toward it, up to 25° × the same × its sideways share on screen (in 0.45 s, back in 1.1 s); the screen edge on its side darkens (up to 75%); the view stretches up to 6% along its direction |
| Near miss | A rock passes within 5 m of its surface (once per rock) | 0.9° × closeness × √(size / 6 m) kick away from it, 8 Hz, 0.4 s, and the whoosh |

- The lean is a roll about the view axis, so the cross still shows where you are going. Your turn follows the
  screen as you see it: the held direction is turned by the lean into the ship's frame (up is always the top of
  the screen), the pull acts in the ship's frame.
- Stretch: the projection is multiplied by a scale of 1 + 6% × amount along the meteor's screen direction (in
  pixel space), only for drawing.
- Near misses come from `field.update`: the closest point of this frame's relative motion, closer than 5 m to the
  rock's surface (0.85 × its radius); `field.misses`.

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
- Sounds are synthesized, no files (`Sfx` in `audio.js`): whoosh = band-passed white noise sweeping down (faster
  = higher), panned to the passing side, louder the closer; rumble = low-passed (130 Hz) looping brown noise plus a
  40 Hz tone wandering ±7 Hz, its level following the pull; boom = a noise burst through a low-pass that is darker
  the further away plus a falling 95 → 32 Hz tone, loudness (1 − (d − 40) / 290)^1.6 × √(size / 7), panned;
  crash (the hit) = a close boom. A compressor on the effects bus; at most ~10 voices.
- Levels (`SOUND`) were set by rendering offline (OfflineAudioContext in headless Chromium) against the music:
  loops −21 … −18 dB RMS (peaks −11 … −5 dB); a near boom and the crash peak at ~−5 dB, a full whoosh ~−8 dB, the
  rumble at full pull −20 dB RMS. Tune by ear.
- In the game (`sound.js`): one AudioContext made at boot, resumed on the first key / click / tap (window capture
  listeners on keydown, mousedown, pointerup, touchend, click: touches unlock audio on touchend / pointerup, not on
  touchstart); suspended while the tab is hidden. The music loads after the meteors without holding up the
  loading bar, starts with the first run (or as soon as it is decoded) and follows the run time. The hit: the
  crash, the rumble stops, the music ducks to 45% with the low-pass dip and sinks to level 1; the next run brings
  it back and the cycle starts again at depth 0.
- Volumes: the settings panel has Music and Sounds in 10 steps (gain = base × (step / 8)², default 8 = the mixed
  level, 0 = off).

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
- Pixel ratio capped (1.5 on mobile, 2 on PC). Adaptive quality (Contoo 4, `quality.js`, `QUALITY`): the median
  frame time over 2 s; slower than 50 fps steps the pixel ratio down (×0.82, 0.68, 0.55 of the start, never under
  0.75). With vsync a frame takes 16.7 or 33.3 ms, so a step that brings no speed-up tries the next; if even the
  lowest brings none (a 30 fps power-saving cap, or the CPU is the limit) it goes back and stops adapting. It never
  steps back up during a visit. Stalls (> 0.1 s), hidden tabs and the first 3 s after loading (shaders compile,
  textures upload) don't count; tests on the manual clock never adapt.
- Leaving the page mid-run (another app or tab, a locked phone: `visibilitychange`) pauses the run (mode
  `paused`); coming back, "Paused / Tap to continue" with the HUD and timer visible waits for a tap or key (0.3 s
  lock). Without it, a run came back flying into whatever was ahead.
- A browser that can't start WebGL gets a message on the loading screen (the renderer is made in a try/catch).
- Best time in `localStorage` (wrapped in try/catch).
- Settings (Contoo 3): a gear button on the start and game-over screens opens a panel with Music and Sounds
  volume (− / + steps) and a Debug info switch (the top-left read-out; off by default). Taps only (no sliders: every
  touch on the page is cancelled, and drags raise Safari's fullscreen suspicion). Nothing on the panel reaches the
  game behind it; keys are ignored while it is open and for 150 ms after; Escape / Enter, Done or a tap beside the
  card closes it. Saved in `localStorage` (`hole.settings`). There are no difficulty options: difficulty depends
  only on time survived.

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
  field rocks, no massive meteors, no walls, only placed rocks hit), `hole.place({ type, dist, s, side, up, ... })`,
  `hole.spawnMassive({ dist, offAxis, s, ... })`, `hole.spawnWall({ holes: [{ off, phi }], combo, check })` and
  `hole.setRunTime(t)` (jump the difficulty).
- `NODE_PATH=$(npm root -g) node tools/check_pressure.mjs [out.jpg] [--tiles dir]` (Playwright, ~10 min): the
  Contoo 3 check sheet `docs/checks/contoo3_pressure.jpg` (an early wall from appearing to its hole, a late wall
  with exploders, the lean, blue-black vs red-black space, the settings panel and the debug read-out).
- `node tools/audit.mjs [--quick] [--only collision|walls|escape|bots|donts]` (~3 min, Node, Contoo 4): the
  fairness and don'ts audit. Collision spheres against the real meshes (GLBs read directly), walls and escape holes
  over 0 s … 20 min, bot runs (straight, turning at random, a careful one) logging how long each killer was in
  sight before it hit, and immortal runs checking that nothing pops into or out of view, nothing behind you moves
  toward you, rocks never change once there and no knob jumps between frames. `tools/sim.mjs` is its harness
  (whole runs as `main.js` plays them, `seedRandom` for reproducible runs). `node tools/bench.mjs`: the logic cost
  per frame and per wall plan at six points of a run. `NODE_PATH=$(npm root -g) node tools/check_ship.mjs`: the
  Contoo 4 check sheet (far LOD on/off, a fresh run, the screens).
- `NODE_PATH=$(npm root -g) node tools/test_game.mjs [--shots dir] [--only desktop|mobile]` (Playwright,
  ~5 min): serves `public/` itself and plays the game on desktop and on iPhone, Android and iPad emulation
  (portrait, landscape, rotation): no console errors or 404s, keys and two-thumb touch, circle speed and
  heavy counter-steer, fullscreen button, hit → game over → restart, best time, fast double taps never zoom.
  Headless Chromium draws with a software rasterizer (~0.3–1 s per frame), so the checks run on the game's
  test clock: `?debug` exposes `hole.advance(seconds)` (the same per-frame code in fixed 1/60 s steps),
  `hole.setRendering(false)` and `hole.setTestOnly(true)` (only `hole.placeAhead()` rocks can hit). The read-out
  of fps, meteor counts, walls, the flight state and audio is the Debug info setting (off by default).
  Contoo 3 adds: the settings panel (mouse and touch), audio unlocking on the first key / tap, the music playing
  and following the run, a wall in a run, the HUD not moving under shake and lean, the lean easing back, red-black
  space ten minutes in. Contoo 4 adds: the far LOD on PC (none on mobile), the pause when the page is left, the
  message without WebGL, a close blast's glow staying small, no roll over 12 s without massive meteors.
- Serve and look at the browser console: `npx wrangler dev` (http://localhost:8787) or
  `python -m http.server 8000 -d public`.
