#!/usr/bin/env python3
"""Space sprites for Hole (dust wisps, haze puffs, explosion flash) from Z-Image Turbo images on pure black.

Brightness becomes alpha: grayscale -> black point from the background ring -> normalise -> curve -> soft radial
edge mask (alpha reaches 0 well inside the square, so no square border can ever show) -> optional blur.
The colour channels are plain white, so the game tints a sprite with its material colour and the alpha carries
all the detail. WebP with alpha at the PC and mobile sizes.

Runs in the HoleWork venv (numpy, scipy, Pillow; tools/requirements-mesh.txt):

  python tools/make_sprites.py candidates --out SHEET.jpg [--labels a,b] A.png B.png ...
      contact sheet of candidates processed with their kind's defaults (kind from the file name: dust_, haze_,
      flash_), over the game's background colour, with the numbers that matter (edge loss, coverage).
  python tools/make_sprites.py make SPEC.json
      SPEC {"public": "public/assets/textures", "previews": "<dir>", "sprites": [{"id": "dust_01",
            "kind": "dust", "src": "a.png", ...per-sprite overrides of KIND_DEFAULTS}]}
      writes <public>/{pc,mobile}/<id>.webp, a preview PNG per sprite and <previews>/sprites.json.
  python tools/make_sprites.py sheet --out SHEET.jpg --rocks R1.png,R2.png,... --sprites SPRITES.json
      the final check sheet: rock renders and every sprite over the game's background.
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.ndimage import gaussian_filter

SPACE_COLOR = (5, 7, 13)  # public/game/config.js SPACE_COLOR #05070d

KIND_DEFAULTS = {
    #        alpha curve  edge mask (radius, 1 = half the side)  blur (fraction of side)  sizes (px)
    "dust":  {"gamma": 1.15, "inner": 0.55, "outer": 0.94, "blur": 0.0, "pc": 1024, "mobile": 512,
              "preview_tint": (0.78, 0.82, 0.95), "preview_opacity": 0.6, "preview_add": False},
    "haze":  {"gamma": 0.9, "inner": 0.42, "outer": 0.94, "blur": 0.006, "pc": 1024, "mobile": 512,
              "preview_tint": (0.42, 0.48, 0.66), "preview_opacity": 0.5, "preview_add": False},
    "flash": {"gamma": 1.6, "inner": 0.30, "outer": 0.92, "blur": 0.0, "bloom": [0.015, 0.05, 0.12],
              "white_pct": 100, "pc": 512, "mobile": 256,
              "preview_tint": (1.0, 0.86, 0.6), "preview_opacity": 1.0, "preview_add": True},
}
WEBP = {"quality": 90, "alpha_quality": 90, "method": 6}


def kind_of(name):
    for k in KIND_DEFAULTS:
        if os.path.basename(name).lower().startswith(k):
            return k
    raise SystemExit(f"cannot tell the kind of {name} (name it dust_*, haze_* or flash_*)")


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def process(path, opts):
    """Returns (alpha HxW float 0..1, numbers)."""
    rgb = np.asarray(Image.open(path).convert("RGB"), np.float32) / 255.0
    L = rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    h, w = L.shape
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.hypot((xx + 0.5) / w * 2 - 1, (yy + 0.5) / h * 2 - 1)
    ring = L[r > 0.97]
    black = opts.get("black")
    if black is None:  # background level plus its noise
        med = float(np.median(ring))
        black = med + 3 * float(np.median(np.abs(ring - med))) + 0.01
    v = np.clip((L - black) / max(1e-6, 1 - black), 0, 1)
    if opts.get("blur"):
        v = gaussian_filter(v, opts["blur"] * w)
    if opts.get("bloom"):  # sum of blurs at several sizes: a peaked core with a long soft falloff
        v = sum(gaussian_filter(v, s * w) for s in opts["bloom"]) / len(opts["bloom"])
    white = float(np.percentile(v[r < 0.9], opts.get("white_pct", 99.8)))
    v = np.clip(v / max(white, 1e-6), 0, 1) ** opts["gamma"]
    mask = 1.0 - smoothstep(opts["inner"], opts["outer"], r)
    a = v * mask
    edge = np.zeros_like(a, bool)
    b = max(2, int(0.02 * w))
    edge[:b], edge[-b:], edge[:, :b], edge[:, -b:] = True, True, True, True
    nums = {
        "black": round(float(black), 4), "ring_mean": round(float(ring.mean()), 4),
        "coverage": round(float(a.mean()), 4), "edge_loss": round(float((v * (1 - mask)).sum() / (v.sum() + 1e-9)), 4),
        "edge_max_alpha": round(float(a[edge].max()), 4),
    }
    return a, nums


def to_rgba(a, size):
    img = Image.fromarray(np.round(a * 255).astype(np.uint8), "L")
    if img.size[0] != size:
        img = img.resize((size, size), Image.LANCZOS)
    white = Image.new("L", img.size, 255)
    return Image.merge("RGBA", (white, white, white, img))


def preview(a, opts, size=256):
    """The sprite over the game's background (normal blend, or additive for the flash), as uint8 RGB."""
    al = np.asarray(Image.fromarray(np.round(a * 255).astype(np.uint8)).resize((size, size), Image.LANCZOS),
                    np.float32)[..., None] / 255.0
    bg = np.array(SPACE_COLOR, np.float32)[None, None] / 255.0
    tint = np.array(opts["preview_tint"], np.float32)[None, None]
    k = al * opts["preview_opacity"]
    out = bg + tint * k if opts["preview_add"] else bg * (1 - k) + tint * k
    return (np.clip(out, 0, 1) * 255).astype(np.uint8)


def font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def grid(tiles, labels, cols, tile, title=None):
    rows = (len(tiles) + cols - 1) // cols
    top = 34 if title else 0
    lab = 30
    sheet = Image.new("RGB", (cols * tile + (cols + 1) * 6, top + rows * (tile + lab) + (rows + 1) * 6), (16, 18, 24))
    d = ImageDraw.Draw(sheet)
    if title:
        d.text((8, 8), title, fill=(220, 225, 235), font=font(18))
    for i, (t, l) in enumerate(zip(tiles, labels)):
        x = 6 + (i % cols) * (tile + 6)
        y = top + 6 + (i // cols) * (tile + lab + 6)
        im = t if isinstance(t, Image.Image) else Image.fromarray(t)
        if im.size != (tile, tile):
            im = im.resize((tile, tile), Image.LANCZOS)
        sheet.paste(im, (x, y))
        d.text((x + 2, y + tile + 3), l, fill=(200, 205, 215), font=font(13))
    return sheet


def cmd_candidates(a):
    labels = a.labels.split(",") if a.labels else [os.path.splitext(os.path.basename(p))[0] for p in a.files]
    tiles, labs = [], []
    for p, l in zip(a.files, labels):
        opts = KIND_DEFAULTS[kind_of(l if a.labels else p)]
        al, n = process(p, opts)
        tiles.append(preview(al, opts, a.tile))
        labs.append(f"{l}  loss {n['edge_loss']:.0%} cov {n['coverage']:.2f}")
    grid(tiles, labs, a.cols, a.tile, a.title).save(a.out, quality=90)
    print(a.out)


def cmd_make(spec_path):
    with open(spec_path, encoding="utf-8-sig") as f:
        spec = json.load(f)
    base = os.path.dirname(os.path.abspath(spec_path))
    absp = lambda p: p if os.path.isabs(p) else os.path.normpath(os.path.join(base, p))  # noqa: E731
    public, prev_dir = absp(spec["public"]), absp(spec["previews"])
    os.makedirs(prev_dir, exist_ok=True)
    report = []
    for s in spec["sprites"]:
        opts = dict(KIND_DEFAULTS[s["kind"]])
        opts.update({k: v for k, v in s.items() if k not in ("id", "kind", "src")})
        al, nums = process(absp(s["src"]), opts)
        entry = {"id": s["id"], "kind": s["kind"], "src": os.path.basename(s["src"]), **nums, "files": {}}
        for plat in ("pc", "mobile"):
            size = int(opts[plat])
            out = os.path.join(public, plat, s["id"] + ".webp")
            os.makedirs(os.path.dirname(out), exist_ok=True)
            to_rgba(al, size).save(out, "WEBP", **WEBP)
            back = np.asarray(Image.open(out))[..., 3]
            b = max(2, int(0.02 * size))
            entry["files"][plat] = {"path": f"textures/{plat}/{s['id']}.webp", "size": size,
                                    "bytes": os.path.getsize(out),
                                    "edge_max_alpha": int(max(back[:b].max(), back[-b:].max(),
                                                              back[:, :b].max(), back[:, -b:].max()))}
        pv = os.path.join(prev_dir, s["id"] + "_preview.png")
        Image.fromarray(preview(al, opts, 384)).save(pv)
        entry["preview"] = pv
        entry["params"] = {k: opts.get(k) for k in ("gamma", "inner", "outer", "blur", "bloom")}
        report.append(entry)
        print(json.dumps({k: entry[k] for k in ("id", "coverage", "edge_loss", "edge_max_alpha")}),
              {p: (v["bytes"], v["edge_max_alpha"]) for p, v in entry["files"].items()})
    with open(os.path.join(prev_dir, "sprites.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=1)


def cmd_sheet(a):
    with open(a.sprites, encoding="utf-8") as f:
        sprites = json.load(f)
    rocks = [p for p in a.rocks.split(",") if p]
    tiles = [Image.open(p).convert("RGB") for p in rocks]
    labels = [os.path.splitext(os.path.basename(p))[0].replace("_front34", "").replace("_front", "") for p in rocks]
    for s in sprites:
        tiles.append(Image.open(s["preview"]).convert("RGB"))
        f = s["files"]
        labels.append(f"{s['id']}  {f['pc']['bytes'] // 1024} / {f['mobile']['bytes'] // 1024} KB")
    grid(tiles, labels, a.cols, a.tile, a.title).save(a.out, quality=88)
    print(a.out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("candidates")
    c.add_argument("files", nargs="+")
    c.add_argument("--out", required=True)
    c.add_argument("--labels")
    c.add_argument("--cols", type=int, default=5)
    c.add_argument("--tile", type=int, default=256)
    c.add_argument("--title")
    m = sub.add_parser("make")
    m.add_argument("spec")
    s = sub.add_parser("sheet")
    s.add_argument("--out", required=True)
    s.add_argument("--rocks", default="")
    s.add_argument("--sprites", required=True)
    s.add_argument("--cols", type=int, default=6)
    s.add_argument("--tile", type=int, default=256)
    s.add_argument("--title")
    a = ap.parse_args()
    if a.cmd == "candidates":
        cmd_candidates(a)
    elif a.cmd == "make":
        cmd_make(a.spec)
    elif a.cmd == "sheet":
        cmd_sheet(a)


if __name__ == "__main__":
    sys.exit(main())
