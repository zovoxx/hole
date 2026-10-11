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

## Next

- **Conto 2: Meteors game-ready.** Needs Blender only (ComfyUI only if a rock is redone).

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

## Notes for Conto 2 (from the Conto 1 check renders)

- Orientation: "front" is the side Pixal3D saw (glTF +Z, Blender −Y). Backs are guessed but complete.
- Small pits and tunnels to close in the repair step: rock_02 (two pinholes underneath), big_01 (pinholes),
  big_03 (a few pits on the back and bottom), rock_07 (crack crevices). Check with
  `blender_check.py --clay`; `tunnels_est` in the report is only good for comparing versions, because
  Pixal3D meshes also have many microscopic tunnels.
- Tiny floating pieces to drop: rock_02 (1), rock_07 (1), big_03 (3), all well under 1% of faces.
- Base colors are light to mid gray with some baked shading on the hidden sides (big_03's back is darker):
  neutralize as planned.

## Open questions / assumptions

- The Cloudflare Worker is assumed to be named `hole` (`wrangler.jsonc`). If the dashboard uses another name,
  change `name` there.
- Conto steps 2 (TripoSplat grounds) and 3 (Kimodo animations) are skipped: no ground, no characters.

## Assets

- Raw meteors (source only; nothing in `public/` yet): rock_01 round potato, rock_02 elongated, rock_03 flat
  slab, rock_04 angular chunk, rock_05 twin-lobed, rock_06 cratered, rock_07 jagged shard, rock_08 pitted,
  big_01 huge cratered boulder, big_02 long curved giant, big_03 lumpy giant.

## Usage log

| Phase | Date | Usage % (reported) | Notes |
| --- | --- | --- | --- |
| Setup | 2026-10-11 | n/a | Planning session |
| Conto 1 | 2026-10-11 | (to ask) | ~3 h wall clock, mostly unattended GPU queues; 60 Z-Image images, 18 Pixal3D runs |
