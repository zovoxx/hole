# Hole: phases

Each phase is sized for about **80% of one 5-hour Claude Pro usage window** (a guide, not a rule). Conto
phases run on the laptop (ComfyUI + Blender) and come first. Contoo phases run in the cloud with only the repo,
so everything they need must already be in git. Contoo phases may use placeholder assets if a real one isn't
ready.

How a phase is run (read, pre-flight, save, test, push, report, log usage): see `CLAUDE.md`.

Total estimate: 3 conto + 4 contoo phases, about 5.7 windows of usage.

| Phase | Goal | Est. usage |
| --- | --- | --- |
| Conto 1 | Meteor models: concepts → Pixal3D raw models + helper tools | ~80% |
| Conto 2 | Meteors game-ready: PC/mobile GLBs, manifest, browser viewer | ~85% |
| Conto 3 | Music (4 intensity loops), space textures, final check of all assets | ~85% |
| Contoo 1 | Fly: playable core loop on PC and phone | ~85% |
| Contoo 2 | Danger: meteor types, distance doubt, explosions, gravity | ~85% |
| Contoo 3 | Pressure: walls, difficulty curve, camera effects, sound | ~85% |
| Contoo 4 | Tune and ship: feel, fairness, performance | ~70% |

Conto steps that don't apply to Hole: **Grounds (TripoSplat)**: there is no ground in space. **Animations
(Kimodo)**: there are no characters; meteor spin, orbits and explosions are done in code. Step 1 makes the
meteors instead of characters and weapons.

---

## Conto phases

### Conto 1: Meteor models

**Goal:** all 11 meteor shapes exist as raw Pixal3D models, chosen and check-rendered, plus the helper tools
for the rest of the conto.

**Tasks**

1. Pre-flight: ComfyUI answers at `http://127.0.0.1:8188/system_stats`; Blender works (MCP, or
   `blender --background --version`); your Z-Image Turbo and Pixal3D workflow JSONs are uploaded. The repo is
   cloned on the laptop with Git LFS installed (`git lfs install`). Work folder:
   `%USERPROFILE%\Documents\HoleWork\` (permanent, never Temp).
2. Write tools:
   - `tools/comfy_client.py`: load a workflow JSON, set prompt / seed / input image, submit, poll `/history`,
     download outputs, free VRAM (`/free`).
   - `tools/gen_queue.py`: runs a list of jobs one at a time, unattended, and writes a status JSON so progress
     can be checked with one read instead of constant polling.
   - `tools/blender_check.py`: Cycles-on-CPU check renders (several angles, dark background, rim light) and a
     contact sheet.
3. Style lock: 4–6 test concepts. Prompt direction: one irregular asteroid rock, clean smooth 3D game asset,
   matte neutral gray stone, complete object, isolated and centered, plain flat light background, soft even
   light (neutral light so Pixal3D doesn't bake strong shadows into the texture), no text. Pick the prompt
   that gives clean, varied silhouettes.
4. Concepts, 2–3 seeds each, pick the best:
   - 8 small shapes: round potato, elongated, flat slab, angular chunk, twin-lobed, cratered, jagged, pitted.
   - 3 big shapes (used for big and massive meteors): huge cratered boulder, long giant, lumpy giant.
5. Pixal3D for each pick, one job at a time. Free VRAM between Z-Image and Pixal3D; if Pixal3D runs out of
   VRAM while decoding textures, free and resubmit.
6. Check-render every model and look at it. Redo broken ones (missing parts, big holes, flat backs).
7. Save to git: chosen concepts → `source/meteors/concepts/`, raw GLBs → `source/meteors/raw/`, contact
   sheet → `docs/checks/conto1_raw.jpg`, tools → `tools/`. Update STATUS, commit, push.

**Done when**

- `docs/checks/conto1_raw.jpg` shows 11 distinct, complete rocks (8 small, 3 big) with no big holes or broken
  pieces, and they look like one set.
- `source/meteors/raw/` has 11 GLBs and `source/meteors/concepts/` has the 11 chosen images.
- The three tools are in `tools/`.

**Estimated usage:** ~80%

### Conto 2: Meteors game-ready

**Goal:** PC and mobile meteor GLBs in `public/`, the meteor part of the manifest, and a browser viewer that
proves they load.

**Tasks**

1. Pre-flight: Blender works (ComfyUI only if a rock has to be redone).
2. `tools/blender_meteors.py`, for each rock:
   import raw → center, scale to bounding radius 1 m → repair (voxel remesh closes the tiny holes) → PC LOD
   and mobile LOD (remesh first, then decimate; use quadric decimation via pymeshlab in a separate process if
   Blender's decimate makes spikes) → UV unwrap → bake base color, normal and ORM from the raw high-poly
   (Cycles CPU, selected-to-active) → neutralize the base color (desaturate, even out baked-in lighting, so
   the game can tint it) → compute `collisionRadius` (a sphere slightly inside the surface).
3. Explosion fragments: cell-fracture one small rock into 4 shards, PC + mobile.
4. Export GLBs to `public/assets/meteors/{pc,mobile}/`. Re-import and verify (triangle counts, textures,
   scale, origin). Check renders: every rock in game-like dark light, in gray / decoy yellow / exploder yellow,
   PC next to mobile → `docs/checks/conto2_meteors.jpg`. Look at it; fix anything off.
5. `tools/write_manifest.py`: reads the exported files and writes `public/assets/manifest.json` (ids, paths,
   triangle counts, collision radii).
6. Vendor three.js into `public/game/vendor/` and build `public/dev/viewer.html`: loads the manifest with the
   PC or mobile set and shows every meteor spinning in dark fog with the three tints. This becomes the base of
   the game renderer.
7. Save the final `source/meteors/meteors.blend`. Run `tools/check_public.py`, serve `public/` locally, console
   clean. Update STATUS, commit, push.

**Done when**

- In `docs/checks/conto2_meteors.jpg` each rock has the same shape in PC and mobile, with no spikes or holes,
  and the tints read as gray / yellow / deep yellow.
- `/dev/viewer.html` (local or deployed) shows all 15 meteors on PC and on your phone; `?set=pc` and
  `?set=mobile` both work; no console errors.
- `python tools/check_public.py` passes.

**Estimated usage:** ~85%

### Conto 3: Music, space textures, final check

**Goal:** every remaining asset done, the full manifest final, conto finished.

**Tasks**

1. Pre-flight: ComfyUI and Blender work; your ACE-Step and Z-Image workflow JSONs are uploaded.
2. Music (ACE-Step 1.5 XL Turbo, instrumental), **required and important**: exciting, driving music that
   pumps more adrenaline the longer you survive. Make **4 intensity loops** (`music_1` calm-but-tense start →
   `music_4` full adrenaline), all in the **same key and tempo** (e.g. dark electronic/synth, ~120–140 BPM,
   rising energy: more drums, bass and layers per level) so the game can crossfade between them softly with
   no audible switch. 3–4 candidates per level; you listen and pick (Claude can't judge music by ear). Cut
   seamless loops on bar boundaries, all the same length in bars (`tools/music_loop.py`), export OGG + MP3
   (PC 192 kbps, mobile 96 kbps), loop points and BPM into the manifest.
3. Space textures (Z-Image Turbo, on pure black so brightness becomes alpha): 4 dust wisps, 2 big murky haze
   puffs, 1 explosion flash glow. `tools/make_sprites.py`: grayscale, alpha from brightness, soft edges (no
   square borders), WebP at PC and mobile sizes. The starfield itself stays procedural so it is perfectly
   even.
4. Step 6, final pass: check every asset together (contact sheet of rocks and sprites over the game's dark
   background → `docs/checks/conto3_all.jpg`), fix anything off, write the final manifest.
5. Viewer shows the sprites and has a music player with a 1 → 4 intensity slider (soft crossfade). Run `check_public.py`, serve locally,
   console clean. Update STATUS with a short asset list, commit, push.

**Done when**

- In the viewer each music level loops with no click or gap, and a slider that crossfades level 1 → 4 sounds
  like one track getting more intense, with no audible switch.
- `docs/checks/conto3_all.jpg` shows dust, haze and flash as soft shapes with no hard square edges.
- `check_public.py` passes; the viewer works on PC and phone; the manifest lists every asset.

**Estimated usage:** ~85%

---

## Contoo phases

### Contoo 1: Fly

**Goal:** a complete, playable run on PC and phone with plain gray rocks: start → fly → hit → game over →
restart.

**Tasks**

1. `public/index.html` with the import map, a loading screen with a progress bar and a web app manifest.
   `device.js` (PC/mobile set), `loader.js` (manifest, placeholders if a file is missing).
2. Start screen (title "Hole", tap / click / key to start, fullscreen button). Game-over screen (time, best
   time, instant restart). Best time in `localStorage`.
3. HUD: cross, circle, timer (mm:ss.s), touch buttons (left/right bottom-left, up/down stacked bottom-right,
   large, semi-transparent, multi-touch for diagonals), WASD.
4. Flight model exactly as DESIGN §4 and TECH "Flight model", every value in `config.js`.
5. Space: procedural starfield, fog, dust motes, floating origin.
6. Gray rocks from the manifest: spawn, fade in, drift, spin and recycle in every direction except behind;
   instanced.
7. Collision → short hit effect → game over.
8. First version of the difficulty curve (speed and meteor count).
9. Tests: Playwright on desktop and mobile emulation (touch, portrait and landscape), no console errors;
   `check_public.py`.

**Done when** (test on the deployed site)

- PC: WASD moves the circle at one constant speed, it stays where you leave it, and turning feels heavy (a
  full counter-steer keeps turning the old way for a moment before it reverses).
- Phone: both thumbs at once give diagonals; it works in portrait and landscape; the fullscreen button works
  (on iPhone via "Add to Home Screen").
- Rocks fade in far away, never pop, never come from behind; turning all the way around shows space already
  full.
- A hit ends the run; the game-over screen shows time and best time; any key or tap restarts.

**Estimated usage:** ~85%

### Contoo 2: Danger

**Goal:** all meteor types, the doubt from distance, explosions and gravity.

**Tasks**

1. Types: rock, decoy (pale → deep yellow), exploder (deepest yellow), big, massive; shares from difficulty.
2. Readability by distance: fog wash-out plus a "tell" factor for cracks, pulse and dust ring (none far,
   faint mid, clear near).
3. Exploder: fuse starts at ~150 m, lasts ~2 s, pulse speeds up; a few blow up on their own far away.
4. Explosion: 6–12 fragments (the fragment meshes) that can hit you and feel gravity; flash light and glow at
   the explosion (never full-screen); camera kick.
5. Gravity: big pulls meteors; massive pulls meteors and you (sideways drift and turn toward it, stronger the
   closer you are); swarms with orbits and slingshots; dust ring.
6. Escape rule: extra meteors on the escape side, always at least one gap you can make.
7. Tests and `check_public.py`.

**Done when**

- From far you honestly can't tell an exploder from a deep-yellow decoy, or a massive meteor from a big one;
  up close the cracks, pulse and dust ring are obvious.
- An exploder whose fuse starts ahead of you blows up at a scary but dodgeable distance; pieces fly toward you
  and can kill you; the flash lights nearby rocks but not the screen.
- Near a massive meteor you drift and turn toward it, you have to hold the opposite direction halfway in, and
  there is always an escape gap.

**Estimated usage:** ~85%

### Contoo 3: Pressure

**Goal:** walls, the full difficulty curve, the camera effects and sound.

**Tasks**

1. Walls: curtain with 1–2 holes, never on your current heading, each hole checked as reachable by
   simulating the flight model; warning 4 s → 2 s; rhythm 15 s → 6 s with calm moments; later combos
   (exploders in the wall, a wall next to a massive meteor).
2. Full difficulty curve driving every knob in DESIGN §11, applied only to meteors spawning far ahead;
   blue-black → red-black, thicker dust.
3. Camera effects: handling rattle, explosion kick, gravity rumble + lean/roll up to ~25° + darker edge +
   slight stretch, near-miss kick. Smooth, stacked, capped; the HUD never moves.
4. Audio: synthesized whoosh, rumble and boom; the 4 music loops started in sync and crossfaded softly by
   difficulty (equal-power, over several seconds, never a hard switch); iOS audio unlock.
5. Tests and `check_public.py`.

**Done when**

- Walls appear about 4 s ahead early and about 2 s ahead after a few minutes; there is always a hole you can
  make if you react, and it is never straight ahead.
- Over a long run space gets denser, faster and redder with no visible step.
- Shakes feel like smooth wobbles; the cross, circle, timer and buttons never move; the lean near a massive
  meteor eases back afterwards.
- You hear the whoosh, the rumble and the boom; the music gets more intense as the run goes on and you never
  notice a switch.

**Estimated usage:** ~85%

### Contoo 4: Tune and ship

**Goal:** a feel, fairness and performance pass so the game is ready for real players.

**Tasks**

1. Tuning with your feedback from playing: control weight, speeds, densities, the curve.
2. Fairness audit: automated runs of the wall and escape-gap checks across the whole difficulty range;
   collision radii; no deaths from things you couldn't see.
3. Performance: steady 60 fps on a mid-range phone (instancing, far LOD on PC using the mobile meshes,
   pixel-ratio cap, adaptive quality), memory, load time.
4. Don'ts audit (DESIGN §13): no pop-in, no auto roll, no full-screen flash, no circle re-centering, and the
   rest.
5. Polish: loading and start/game-over screens, home-screen icons, cache headers (`public/_headers`) if they
   help.
6. Final check, merge to main, verify the live site.

**Done when**

- Five runs in a row on phone and PC: every death felt like your own mistake.
- No stutter on your phone; the game loads in a few seconds on mobile data.
- Every item on the don'ts list holds.

**Estimated usage:** ~70%
