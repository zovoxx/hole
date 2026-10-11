#!/usr/bin/env python3
"""Home-screen and browser icons for Hole: a dark hole in blue-black space with the game's cross and circle.

Writes public/icons/icon-192.png, icon-512.png, icon-512-maskable.png (safe zone: the art fits in the middle
80%) and apple-touch-icon.png (180). Needs Pillow and numpy (the venv in tools/requirements-mesh.txt, or any
Python with both).

Usage: python tools/make_icons.py
"""
from pathlib import Path

import numpy as np
from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
SS = 4  # supersampling


def render(size: int, art_scale: float = 1.0) -> Image.Image:
    n = size * SS
    y, x = (np.mgrid[0:n, 0:n] + 0.5) / n * 2 - 1  # -1..1
    r = np.hypot(x, y) / art_scale
    # background: blue-black, darker toward the middle (the hole), a faint glow ring around it
    bg = np.array([5, 7, 13], float) / 255
    edge = np.array([16, 22, 40], float) / 255
    t = np.clip(r / 1.1, 0, 1) ** 1.4
    rgb = bg[None, None, :] * (1 - t[..., None]) * 0.2 + edge[None, None, :] * t[..., None]
    glow = np.exp(-((r - 0.62) / 0.16) ** 2) * 0.22
    rgb += glow[..., None] * np.array([0.45, 0.55, 0.95])
    # stars
    rng = np.random.default_rng(3)
    for _ in range(40):
        sx, sy = rng.uniform(-1, 1, 2)
        if np.hypot(sx, sy) < 0.75 * art_scale:
            continue
        b = rng.uniform(0.25, 0.8)
        d2 = (x - sx) ** 2 + (y - sy) ** 2
        rgb += (np.exp(-d2 / (2 * (0.007 + 0.006 * b) ** 2)) * b)[..., None] * np.array([0.85, 0.9, 1.0])
    ink = np.array([0.88, 0.91, 0.97])
    # the circle (ring), up and to the right of the cross: the ship is tempted
    cx, cy, rad, w = 0.2 * art_scale, -0.17 * art_scale, 0.16 * art_scale, 0.03 * art_scale
    ring = np.clip(1 - np.abs(np.hypot(x - cx, y - cy) - rad) / w, 0, 1) ** 1.5
    # the cross: thin, with a gap in the middle
    arm, gap, lw = 0.2 * art_scale, 0.06 * art_scale, 0.016 * art_scale
    h = (np.abs(y) < lw) & (np.abs(x) < arm) & (np.abs(x) > gap)
    v = (np.abs(x) < lw) & (np.abs(y) < arm) & (np.abs(y) > gap)
    a = np.maximum(ring * 0.95, (h | v) * 0.9)
    rgb = rgb * (1 - a[..., None]) + ink * a[..., None]
    img = Image.fromarray((np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB")
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size, scale in [("icon-192.png", 192, 1.0), ("icon-512.png", 512, 1.0),
                              ("icon-512-maskable.png", 512, 0.8), ("apple-touch-icon.png", 180, 1.0)]:
        render(size, scale).save(OUT / name, optimize=True)
        print(OUT / name, (OUT / name).stat().st_size, "bytes")


if __name__ == "__main__":
    main()
