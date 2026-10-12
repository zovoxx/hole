# Hole: status

## Done

- **Setup** (2026-10-11): `CLAUDE.md`, `docs/DESIGN.md`, `docs/TECH.md`, `docs/PHASES.md`, this file,
  `wrangler.jsonc`, `.gitattributes` (LFS for `source/**` only), `.gitignore`, folder layout,
  `tools/check_public.py`, placeholder `public/index.html`.
- **Conto 1: Meteor models** (2026-10-11):
  - Tools: `tools/comfy_client.py` (workflow editing, submit, wait, download, free VRAM),
    `tools/gen_queue.py` (unattended one-at-a-time job queue with a status JSON, VRAM freeing between model
    families, out-of-memory retry, resume), `tools/blender_check.py` (Cycles-on-CPU check renders, mesh
    numbers, contact sheets, `--clay` mode). The owner's workflows are in `tools/workflows/` (Z-Image Turbo,
    Pixal3D, ACE-Step for Conto 3).
  - 11 chosen concepts in `source/meteors/concepts/` (prompt and seed per rock in `concepts.json`).
  - 11 raw Pixal3D GLBs in `source/meteors/raw/` (200k tris, 2048² textures, 13–18 MB each; settings in
    `raw.json`).
  - Check sheet `docs/checks/conto1_raw.jpg` (6 views per rock) and its numbers in `conto1_raw.json`.
- **Conto 2: Meteors game-ready** (2026-10-11):
  - 15 meteors × PC + mobile GLBs in `public/assets/meteors/{pc,mobile}/`: 8 small rocks (2,500 / 800 tris,
    1024² / 512²), 3 big rocks (10,000 / 3,000 tris, 2048² / 1024²), 4 explosion fragments cut from rock_04
    (400 / 150 tris, 512² / 256²). GLBs: centered, bounding radius 1, +Y up, tangents, WebP base colour + ORM +
    normal (EXT_texture_webp). PC set 5.7 MiB, mobile set 2.2 MiB.
  - Base colours are neutral gray with the same median (sRGB 0.58) on every rock, baked-in Pixal3D lighting
    evened out, so the game's tint decides the colour.
  - `public/assets/manifest.json` (meteor part): paths, tris, texture sizes, bytes, `collisionRadius` and
    `collisionSpheres`; fragments also have `sizeInRock`.
  - Game modules to build on: `public/game/config.js` (space colour, fog, tints, pixel-ratio caps),
    `device.js` (PC/mobile set, `?set=`), `loader.js` (manifest + GLBs, placeholder fallback), `meteors.js`
    (InstancedMesh per shape with per-instance tint). three.js 0.186.1 vendored in `public/game/vendor/`.
  - `public/dev/viewer.html`: all 15 meteors spinning in fog with the tints, `?set=pc` / `?set=mobile`, tint
    and decoy-shade controls, a distance slider into the fog, drag to turn. Tested locally on PC and mobile
    emulation (landscape and portrait): no console errors.
  - Tools: `tools/blender_meteors.py` (build / fragments / collision / check / blend), `tools/mesh_tool.py`
    (watertight repair and quadric decimation, venv: `tools/requirements-mesh.txt`), `tools/write_manifest.py`.
  - Check sheet `docs/checks/conto2_meteors.jpg` (PC next to mobile; gray / decoy / exploder) + numbers in
    `conto2_meteors.json`. Build numbers per rock in `source/meteors/meteors.json`. Final
    `source/meteors/meteors.blend` (the exported GLBs, pc and mobile collections, textures packed).
- **Conto 3: Music, space textures, final check** (2026-10-11). The conto is finished.
  - Music (family A "darksynth chase", picked by ear on a listening page): `music_1`–`music_4` in
    `public/assets/music/{pc,mobile}/` as OGG Vorbis + MP3 (PC 192 kbps, mobile 96 kbps; 1.45–1.67 MB / 0.72–0.77
    MB per file). 32-bar loops (60 s) at 128 BPM, C# tonal centre, all cut at the same bars of one track, so
    they crossfade note for note. Raw generations, loop masters and every number in `source/music/`
    (`music.json`).
  - Music engine `public/game/audio.js` (`Music`: load, start in sync, `setIntensity`, `follow(runSeconds)`
    with the 5-minute cycle and smooth descent, `unlockAudio`, OGG/MP3 choice) and `MUSIC` in `config.js`. Test page
    `public/dev/music.html`.
  - 7 sprites in `public/assets/textures/{pc,mobile}/`: dust_01–04, haze_01–02 (WebP 1024² / 512²),
    flash_01 (512² / 256²); white RGB, shape in alpha, alpha 0 at the borders. Sources, prompts, seeds and
    processing in `source/textures/`. `public/game/sprites.js` loads them; `SPRITES` tints in `config.js`.
  - Final check `docs/checks/conto3_all.jpg`: all 15 meteors re-imported from the PC GLBs (all 30 GLBs
    re-import as one closed part with the planned triangle counts and texture sizes) and the 7 sprites over the
    game background.
  - `/dev/viewer.html` now also shows haze, dust and an explosion flash that lights the rocks, and has a music
    Play button with a 1 → 4 intensity slider.
  - Tools: `tools/music_loop.py` (beat grid, seam-matched bar loops, encode + decode check, compare),
    `tools/make_sprites.py`, `acestep` jobs in `tools/comfy_client.py` / `tools/gen_queue.py`, textures and
    music in `tools/write_manifest.py`. `public/assets/manifest.json` lists every asset.

- **Contoo 1: Fly** (2026-10-11). The game is playable at `/` (`public/index.html`): start → fly → hit → game
  over → restart, on PC and touch devices.
  - Page: import map, loading screen with a progress bar, web app manifest (`manifest.webmanifest`,
    `display: fullscreen`) and icons (`public/icons/`, made by `tools/make_icons.py`), no-zoom viewport.
  - Screens: start ("Hole", tap / click / key to start, fullscreen button, controls hint, best time; on
    iPhone an "Add to Home Screen" hint instead of the button), game over (time, best time or "New best time",
    tap / key to fly again after 0.45 s). Best time in `localStorage`.
  - HUD: cross, circle, timer (mm:ss.s), touch buttons (left/right bottom-left, up/down bottom-right,
    64–124 px, multi-touch), WASD and arrow keys. DOM above the canvas, so it never shakes.
  - Flight model as DESIGN §4 (`flight.js`, values in `FLIGHT`): circle 0.6 s cross → edge, dead zone 0.06,
    70°/s top turn, 140°/s² turn acceleration: a full counter-steer keeps turning the old way 0.45 s after the
    circle crosses the cross (1.05 s after the key). Pitch/yaw only, no roll.
  - Space (`space.js`): 3,200 stars at infinity, dust motes wrapping around the camera, a few big dust/haze
    sprites from the conto drifting in the murk, exp² fog that is exactly the background colour.
  - Meteor field (`world.js`): uniform field kept in a cone just wider than the view, fed through the far
    cap (rocks come out of the fog) and filled out of view when turning; dropped behind. Gray rocks (the 8
    small and 3 big shapes), instanced, only visible ones drawn. Swept collision against the manifest's
    collision spheres. Hit: recoil, view kick, the view closing in like a hole, then game over.
  - Difficulty v1 (`difficulty.js`): speed 40 → 70 m/s and the gap between rocks in your path 12 → 3 s (it
    sets the density), one smooth curve that keeps rising slowly after the first minute.
  - Owner's wishes: no zoom on fast/double taps (viewport, `touch-action: none`, every touch cancelled,
    pointer-event buttons, `gesturestart` cancelled); fullscreen only from the button, never left by the game,
    no exit button on the game-over screen, still-thumb button controls, no text inputs.
  - Tests: `tools/test_world.mjs` (Node, seconds: flight, curve, even density, no pop-in, nothing from
    behind, density calibration) and `tools/test_game.mjs` (Playwright: desktop, iPhone portrait/landscape,
    Android, iPad; keys, two thumbs, rotation, fullscreen button, hit → game over → restart, double taps never
    zoom, no console errors or 404s). All pass. Screenshots: `docs/checks/contoo1_screens.jpg`.

- **Contoo 2: Danger** (2026-10-12). Every meteor type, the doubt from distance, exploders, explosions,
  gravity, massive meteors with their swarms and escape gaps.
  - Types at spawn (`world.js`): gray rocks; decoys pale → deep yellow (12% → 18% of the small rocks; later in
    a run more of them sit at the deep end and the deep end moves toward the exploder colour); exploders, the
    deepest yellow (0.8% → 1.6%: the count is large, so that is one near your path every ~10 s at the start);
    big rocks (4%) with 3–6 small moons circling them; massive meteors put near your path every 45 → 16 s (first
    after 20–34 s), the same big shapes and sizes, so from far they look like a big rock.
  - The tell (`meteors.js`): exploders get glowing procedural cracks (3D Voronoi, some borders dark) and a
    faint pulse, massive meteors a dust ring (fine grains plus faint puffs); both scale with
    (1 − smoothstep(50, 150 m))³: nothing past 150 m, faint at 100 m, clear inside 50 m. The fog does the rest.
  - Fuses: light when an exploder is in view within 70 m of your path and 3.75 s of flight ahead; it blows up
    1.75 s ahead of you (150 m → 70 m at 40 m/s, 262 m → 120 m at 70 m/s), the pulse speeding up 0.6 → 7 Hz and
    the cracks flaring. 15% → 5% of exploders blow up on their own far away (200–265 m).
  - Explosions: 6–12 hot pieces (the fragment meshes) that hit like rocks and feel gravity; 1–2 aimed at where
    you'll be (missing by 0.5–7 m): flying on, ~40% of runs get hit, turning away 0.3 s after the flash ~5%. No
    pieces from an explosion you can't see. Flash: two pooled point lights light the rocks around it, a glow
    sprite at the blast capped by distance (never full-screen), a 0.5 s camera kick by distance (`fx.js`).
  - Gravity (`gravity.js`): big rocks pull meteors (moons fully, the field weakly), massive meteors pull
    meteors (swarm of 9–15, a quarter slingshots) and you: a turn toward it (up to 200 °/s × strength × sin of
    the angle) and a sideways drag, growing as you close in, letting go once it is behind you; capped so holding
    against it always wins. Do nothing and you hit it (39–40 of 40 in the tests).
  - Escape rule: a porous sheet of extra rocks on the far side from the massive meteor, with 1–2 clear 15 m
    holes placed outside its swarm; decided when it spawns (beyond the far edge, so nothing pops in), moving
    with it. Steering through a hole gets out 39–40 of 40 times, at the start and ten minutes in (test pilot).
  - Performance: gravity through a 100 m grid, weak pulls every third frame: field update ~1 ms a frame at full
    difficulty on the dev machine (Contoo 1: 0.2 ms).
  - Tests: `tools/test_world.mjs` (all of the above, ~1 min) and `tools/test_game.mjs` (new desktop checks:
    types on the start screen and nothing blowing up there, an exploder ahead blowing up with flash, light and
    pieces, a massive meteor pulling you) pass. Check sheet `docs/checks/contoo2_danger.jpg` from
    `tools/check_danger.mjs`.

## Next

- **Try Contoo 2 on the deployed site** (PHASES Contoo 2 "Done when"), on PC and phone: from far, can you
  tell an exploder from a deep-yellow decoy, or a massive meteor from a big rock? (You shouldn't.) Up close,
  are the cracks, pulse and dust ring obvious? Is an exploder blowing up ahead scary but dodgeable? Near a
  massive meteor, do you drift and turn toward it and have to hold against it, and is there always a way out?
  Is there too much or too little of anything (explosions, yellow rocks, massive meteors)? Does it stay smooth
  on your phone? Contoo 1's points still apply (control weight, speed, density, darkness, iPad warning).
- **Contoo 3: Pressure.** Say "make contoo phase 3". Walls, the full difficulty curve, camera effects, sound.

## Decisions

- Concept style (style lock of 6 prompts): `"<shape phrase>. Stylized 3D game asset of a single asteroid
  floating in mid-air, clean smooth sculpted stone surface, matte neutral gray stone with no color, ...
  plain flat white background, soft even studio lighting, no ground, no cast shadow, no text."` Full text in
  `source/meteors/concepts/concepts.json`. Variety comes from the shape phrase; seeds barely change Z-Image
  Turbo's composition.
- Raw Pixal3D at 200k faces and 2048² textures: enough to bake every final LOD (largest final texture is
  2048²) and keeps `source/` at ~185 MB.
- Retries: rock_03 (the slab) came back as a thick boulder from a top-down concept, then with a folded
  underside; the final one is concept `rock_03_s33` with Pixal3D seed 8. big_01 uses Pixal3D seed 8 (fewer
  tunnels than seed 7). rock_01, 06, 07, 08 and big_03 use second-round prompts (the first ones gave
  near-identical cratered spheres, thin horns, or a cluster of balls).
- Music is important: exciting, more adrenaline as the run goes on, 4 intensity loops with soft crossfades
  (Conto 3 resized to ~85%).
- Conto 2 repair: the raw Pixal3D meshes are thin double-walled shells with holes (the workflow's UDF remesh),
  so Blender's voxel remesh kept both walls on 8 of 11 rocks. `tools/mesh_tool.py solid` instead closes the
  shell (morphological closing, 1–8 voxels of 0.008), flood-fills the outside and runs marching cubes: one
  watertight part ~2 mm from the raw surface. LODs come from that solid (pymeshlab quadric decimation);
  textures are baked from the raw (base colour, normal, AO), so pits the closing filled still show.
- Pixal3D's AO channel is broken (0 or 1 per patch); AO is baked in Blender instead. Roughness is a constant
  0.85 (Pixal3D gave 0.84 everywhere), metal 0.
- Fragments: 4 Voronoi cells of the repaired rock_04, flat broken faces with a rocky bump and blotchy gray;
  base colour from the raw cut to the same cell, normal and AO from the closed shard. Each fragment GLB has its
  own 512² / 256² textures (same pixel budget as the planned shared 1024² set, same loading code as the rocks).
- Tints (sRGB, multiply the gray base): gray `#c8c8c8`, decoy `#efe4b4` → `#f2b81e`, exploder `#f2b414`
  (`public/game/config.js`). The viewer uses Neutral tone mapping: ACES pushed the yellows to orange.
- Music levels are one track: level 4 from text (ACE-Step with its LM codes), levels 3–1 by audio-to-audio
  from level 4 (effective denoise 0.67 / 0.89 / 0.89 with calmer tags), so beat grid and harmony match. The
  first level 3 (denoise 0.80) lost its bass and sounded harsh ("migraine"); the owner's pick is seed 55 at
  0.67. Four families were made (darksynth, industrial techno, cinematic hybrid, dark synthwave); only A kept.
- Music cycle (owner): 1 → 4 over 5 minutes, back to 1, each cycle deeper (more mystery and adrenaline, not
  scary). The way back must be smooth: a 30 s descent with a closing/opening low-pass ("going under") and a
  reverb swell; deeper = more reverb, sub and a C# drone, capped after 3 cycles. The first version (instant
  semitone/tempo jump on a bar line after a 1 s fade) was too abrupt. Tune in `MUSIC` (`config.js`) with
  `/dev/music.html`.
- Sprites: alpha from brightness of Z-Image images on black with a soft radial mask; the flash uses a sum of
  blurs (bloom) for a peaked core. Rejected candidates are listed in `source/textures/sprites.json`.

- Contoo 2 judgement calls (tell me if any is wrong):
  - The fuse distance follows the speed (it always blows up 1.75 s ahead of you): a fixed 150 m would blow up
    10 m ahead of you at 70 m/s.
  - Only exploders near your path light (within 70 m of it); the rest pass by unlit, except the few that blow up
    far away. Lighting every exploder within 150 m would mean several explosions a second at full difficulty
    (estimated from the inflow rate).
  - 1–2 pieces of an explosion near your path are aimed at you (missing by up to 7 m): with pieces flying in
    random directions, one would head at you only ~1% of the time (estimate), which isn't "pieces fly toward
    you".
  - Massive meteors come on a timer near your path (45 s → 16 s), not as a share of the count: a 4% share
    meant five massive meteors in view at once.
  - The escape sheet is laid out when the massive meteor appears (far away, fading in), not while you are
    pulled: spawning rocks then would pop them in close to you.
  - Big rocks pull other meteors only weakly (15%), their own moons fully; a massive meteor pulls the field at
    60%. The pull on you is capped so holding against it always wins (the design's "hold the opposite
    direction", never "you can't get out").

## Notes for Contoo

- Contoo 2 → 3: walls can be laid out like the escape sheet (`escapeLayout` in `gravity.js`: decided beyond the
  far edge, moving together, `noGrav`, holes kept clear of new spawns with `inHole`); the reachability check can
  reuse the test pilot in `tools/test_world.mjs` (`stage()`, `circleTo`). The camera effects go into `fx.js`
  next to the explosion kick (`fx.kickRotation`); the pull's strength for the rumble, lean, dark edge and stretch
  is `pull.strength` in `main.js` (0..1) and its screen direction is (`pull.gx`, `pull.gy`). Explosions are in
  `field.events` each frame (position, size, distance, in view) for the boom; near misses still need a check in
  `field.update`. "Later combos" (exploders in a wall, a wall next to a massive meteor) can use
  `spawnMassive()` and `place()`.
- Contoo 2 tuning knobs (all in `config.js`): `DIFFICULTY.decoyShare / exploderShare / decoyCloseness /
  decoyDeepBias / massiveGap / pull`, `TELL`, `EXPLODER`, `EXPLOSION`, `GRAVITY`.
- Contoo 1 → 2 (done): the field spawns through `MeteorField.spawn()`; `field.render()` writes the tint and
  `aFx` per instance.
- Performance is unmeasured on real phones (headless tests use a software rasterizer). About 250 rocks are
  drawn at the start and ~800 at full difficulty (mobile 800 tris each), plus up to 2 point lights during a
  flash and the Voronoi cracks on exploders. The field update costs ~1 ms a frame at full difficulty on the dev
  machine (gravity included). If a phone stutters: far rocks with fewer triangles, fewer moons, gravity on the
  field every 4th frame, or a lower `WORLD.radius`/pixel ratio (Contoo 4).
- Collision: `collisionRadius` is one sphere at the origin with ≥ 92% of its volume inside the rock (generous
  for long/flat rocks: rock_02 0.43, rock_03 0.21, big_02 0.28). `collisionSpheres` (up to 12, `[x, y, z, r]`
  in GLB units, glTF axes) sit 5% under the surface and cover 37–71% of the volume; the uncovered part is the
  outer rim, so grazing hits are forgiven. Scale both by the instance scale. rock_03 (the slab) is the least
  covered: check its hits feel fair in Contoo 2.
- `sizeInRock` of a fragment is its radius relative to the rock it broke from (≈ 0.85–0.89 for 4 cells);
  scale fragments from the exploder's size.
- `loader.js` returns the GLB material as is (MeshStandardMaterial with base, ORM and normal maps). The
  crack/pulse shader in Contoo extends it with `onBeforeCompile`; `instanceColor` already carries the tint.

## Open questions / assumptions

- The Cloudflare Worker is assumed to be named `hole` (`wrangler.jsonc`). If the dashboard uses another name,
  change `name` there.
- Conto steps 2 (TripoSplat grounds) and 3 (Kimodo animations) are skipped: no ground, no characters.
- Contoo 1: the game uses no tone mapping (TECH "Rendering"); the dev viewer still uses Neutral, so its
  rocks look a little darker than in the game.
- Contoo 1: the "Fullscreen" button is also on the game-over screen, but only while not in fullscreen (so
  a player who skipped it on the start screen can still get in); the game never leaves fullscreen.
- Music volume is quiet on purpose (loops at −20 … −16 dB RMS, `MUSIC.volume` 0.8) to leave room for the
  sounds; set it in Contoo 3.
- Contoo 2: how often things blow up is a guess until played. At the start one exploder near your path every
  ~10 s plus a far one now and then; at full difficulty about one every 1.5 s. Turn `exploderShare` and
  `EXPLODER.farShare` down if it feels like fireworks.
- Contoo 2: the field at 25 s and later is dense (Contoo 1's density curve: a rock in your path every 6 s at
  25 s, 3.9 s at 1 min); with gravity, moons and swarms on top it may feel crowded. Tune `pathGap` if so.

## Assets

- Meteors (PC + mobile GLBs in `public/assets/meteors/`, raw models in `source/meteors/raw/`): rock_01 round
  potato, rock_02 elongated, rock_03 flat slab, rock_04 angular chunk, rock_05 twin-lobed, rock_06 cratered,
  rock_07 jagged shard, rock_08 pitted, big_01 huge cratered boulder, big_02 long curved giant, big_03 lumpy
  giant, frag_01–04 explosion fragments (from rock_04).
- Sprites (`public/assets/textures/`): dust_01 irregular patch, dust_02 diffuse spray, dust_03 diagonal drift,
  dust_04 tangled cloud, haze_01 lumpy puff, haze_02 smooth fog bank, flash_01 explosion glow.
- Music (`public/assets/music/`): music_1 calm (beatless) → music_4 full adrenaline, darksynth.

## Usage log

| Phase | Date | Usage % (reported) | Notes |
| --- | --- | --- | --- |
| Setup | 2026-10-11 | n/a | Planning session |
| Conto 1 | 2026-10-11 | (to ask) | ~3 h wall clock, mostly unattended GPU queues; 60 Z-Image images, 18 Pixal3D runs |
| Conto 2 | 2026-10-11 | (to ask) | ~1 h 10 min wall clock, no GPU; full build of 11 rocks ~11 min, fragments ~2 min, check sheet ~1 min |
| Conto 3 | 2026-10-11 | (to ask) | ~2 h 30 min wall clock incl. listening; 6 ACE-Step text tracks (~4.3 min each), ~60 audio-to-audio (10–25 s), 24 Z-Image sprites |
| Contoo 1 | 2026-10-11 | (to ask) | Cloud session; the meteor field took three designs (direction bins over-filled near you; far-cap inflow + turn fill is exact) |
| Contoo 2 | 2026-10-12 | (to ask) | Cloud session; gravity needed two fixes (full-strength pull emptied the field into the big rocks; all-pairs loop 3.5 ms → grid 1 ms) |
