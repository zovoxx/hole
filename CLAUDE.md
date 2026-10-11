# Hole

3D first-person survival game for the browser (PC, phone, iPad). You are only a point of view flying through
dark space: a fixed cross, a steering circle that only *tempts* a heavy ship, and a timer. Dodge meteors,
exploders, gravity wells and walls; one hit ends the run; it gets harder forever and should feel like sinking
into a hole.

- Design (the owner's, every detail matters): `docs/DESIGN.md`
- How it's built (stack, code layout, asset specs, manifest): `docs/TECH.md`
- Phases: `docs/PHASES.md` · Progress and usage log: `docs/STATUS.md`

## Hosting rules (Cloudflare, static only)

- Everything the browser needs is in `public/` (`index.html`, `game/`, `assets/`, `assets/manifest.json`).
  Nothing needed at runtime may live outside `public/`.
- Static files only: no server code, no database. Relative paths (`./assets/...`), lowercase file names, no
  spaces (Cloudflare is case-sensitive, Windows is not).
- Max 25 MiB per file, max 20,000 files in `public/`. Compress anything bigger (and make sure the game can
  decode it).
- Never in `public/`: .blend files, raw generations, concept drafts, `tools/`, `docs/`.
- Must run on PC and mobile browsers: pick the `pc` or `mobile` asset set by device, keyboard/mouse and touch,
  loading screen.
- `wrangler.jsonc` serves `./public` as Workers static assets. The Worker name there (`hole`) must match the
  Worker connected in the Cloudflare dashboard.
- Before every push: `python tools/check_public.py`, then serve `public/` (`npx wrangler dev` or
  `python -m http.server 8000 -d public`) and check the browser console for 404s and errors.

## Conto pipeline (asset phases on the laptop, in this order)

1. **Models**: Z-Image Turbo concept → Pixal3D → Blender. For Hole these are the meteors (8 small rocks,
   3 big rocks, explosion fragments). There are no characters or weapons.
2. **Grounds** (TripoSplat): not used, there is no ground in space.
3. **Animations** (Kimodo): not used, no characters; meteor motion is code.
4. **Music** (important): ACE-Step 1.5 XL Turbo, 4 exciting intensity loops in the same key/tempo, crossfaded
   softly so the adrenaline rises as the run goes on.
5. **Backgrounds**: Z-Image Turbo dust/haze/flash sprites. The starfield is procedural so it stays even.
6. **Check and adjust in Blender**: export PC + mobile, verify by re-importing, write `public/assets/manifest.json`.

Art style, detail and camera come from `docs/DESIGN.md`, not from the pipeline.

**Laptop:** Windows, RTX 4070 Laptop (8 GB VRAM), 32 GB RAM. ComfyUI Desktop API at `http://127.0.0.1:8188`.
Blender through its MCP if connected, else the command line. The owner uploads the ComfyUI workflow JSONs at
the start of each conto phase; use those. Helper scripts live in `tools/` (write them if missing). Work files
go in a permanent folder (`%USERPROFILE%\Documents\HoleWork\`), never in Temp.

**Lessons:**
- One GPU job at a time; free VRAM between model families. Stop Kimodo before Pixal3D/TripoSplat jobs.
- Pixal3D can run out of VRAM while decoding textures: free VRAM and resubmit.
- No Eevee while ComfyUI is working. Check renders use Cycles on the CPU.
- Pixal3D meshes often have tiny holes. For low-poly versions: remesh first, then decimate, then bake textures
  from the high-poly model.
- Look at check renders of every asset before calling it done.

## Folder layout

```
public/                 deployed as-is
  index.html
  game/                 game code (game/vendor/ = pinned three.js)
  dev/                  test pages (asset viewer)
  assets/meteors/{pc,mobile}/   assets/textures/{pc,mobile}/   assets/music/{pc,mobile}/
  assets/manifest.json  the only file the game reads to find assets
source/                 final .blend files, chosen concepts, raw generations (Git LFS, not published)
tools/                  helper scripts (Python for ComfyUI/Blender, checks)
docs/                   DESIGN, TECH, PHASES, STATUS, checks/ (small check-render sheets)
```

## How every phase works

When the owner says "make conto phase N" or "make contoo phase N":

1. Read `CLAUDE.md`, `docs/STATUS.md` and that phase in `docs/PHASES.md`, plus the parts of `docs/DESIGN.md`
   and `docs/TECH.md` you need.
2. Conto phases: check that ComfyUI and Blender on the laptop work before starting.
3. Use the laptop freely for working files and testing during conto.
4. At the end, save everything needed to keep building the game to GitHub: web-ready final assets (PC +
   mobile) and the manifest in `public/assets/`, game code in `public/game/`, final .blend files and chosen
   source images in `source/`, helper scripts in `tools/`. Leave out drafts and unused generations. Contoo runs
   in the cloud without the laptop, so anything it needs must be in the repo.
5. Make sure `public/` works when served locally (hosting rules). Update `docs/STATUS.md`, commit and push.
   Tell the owner in a few lines what's done and what's next, then ask how much usage % the phase used and
   log it in STATUS.
6. If a phase used much more or less than 80%, resize the remaining phases in `docs/PHASES.md` and say so.
7. Cloudflare deploys every push to `main` (~30 s). Never push a broken `public/`. If a build fails, read the
   build log and fix it. Deploy manually from the laptop (`npx wrangler deploy`) only if asked.

## Git rules

- Push to the branch the session was given; otherwise to `main`. Reaching `main` means going live.
- Git LFS only for big source files (`source/**`: .blend, .png, .jpg, .glb, .ply, .wav, ...; see
  `.gitattributes`). Never LFS anything in `public/`: Cloudflare's build may deploy pointer files instead of
  the real ones. `tools/check_public.py` catches this.
- LFS storage is limited (10 GiB) and every changed file is stored again: commit final versions only, no
  drafts, no unused generations, no `.blend1` backups.
- Clear commit messages that say what changed.
