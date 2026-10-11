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
    with the 5-minute deepening cycle, `unlockAudio`, OGG/MP3 choice) and `MUSIC` in `config.js`. Test page
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

## Next

- **Contoo 1: Fly.** Runs in the cloud from the repo only (push first). Say "make contoo phase 1".
- After the push: try `/dev/music.html` and `/dev/viewer.html` on the deployed site on your phone and PC.

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
  scary): +1 semitone and tempo per cycle (max +2), more reverb, sub and a C# drone, capped after 3 cycles.
  Tune in `MUSIC` (`config.js`) with `/dev/music.html`.
- Sprites: alpha from brightness of Z-Image images on black with a soft radial mask; the flash uses a sum of
  blurs (bloom) for a peaked core. Rejected candidates are listed in `source/textures/sprites.json`.

## Notes for Contoo

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
- Music volume is quiet on purpose (loops at −20 … −16 dB RMS, `MUSIC.volume` 0.8) to leave room for the
  sounds; set it in Contoo 3.

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
