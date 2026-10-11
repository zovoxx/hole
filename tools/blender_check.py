"""Check renders and contact sheets for the Hole conto. Runs inside Blender (background), Cycles on the CPU.

Never uses Eevee or the GPU, so it is safe to run while ComfyUI is working.

Models: each GLB is centered and scaled to bounding radius 1, rendered from several angles on a dark background
with a key, fill and rim light, and measured (triangles, loose parts, open boundary = holes, non-manifold edges).
One row per model in the contact sheet; a JSON report has the numbers.

  blender -b --factory-startup -P tools/blender_check.py -- models --out SHEET.jpg
      [--renders DIR] [--report REPORT.json] [--tile 320] [--samples 32] [--blocks 1]
      [--views front,right,back,left,top,bottom] [--labels a,b,...] [--clay] A.glb B.glb ...

Images: a labeled grid of images (e.g. concept candidates).

  blender -b --factory-startup -P tools/blender_check.py -- images --out SHEET.jpg [--cols 6] [--tile 256]
      [--labels a,b,...] A.png B.png ...
"""
import argparse
import json
import math
import os
import sys
import time

import bpy
import numpy as np
from mathutils import Matrix, Vector

VIEWS = {  # name: (azimuth deg around Z, 0 = front from -Y; elevation deg)
    "front": (0, 10), "right": (90, 10), "back": (180, 10), "left": (270, 10),
    "top": (30, 65), "bottom": (210, -60), "front34": (40, 25),
}
BG = (0.004, 0.005, 0.009)

# ---------------------------------------------------------------- 5x7 bitmap font for labels

FONT = {
    "0": (14, 17, 19, 21, 25, 17, 14), "1": (4, 12, 4, 4, 4, 4, 14), "2": (14, 17, 1, 2, 4, 8, 31),
    "3": (31, 2, 4, 2, 1, 17, 14), "4": (2, 6, 10, 18, 31, 2, 2), "5": (31, 16, 30, 1, 1, 17, 14),
    "6": (6, 8, 16, 30, 17, 17, 14), "7": (31, 1, 2, 4, 8, 8, 8), "8": (14, 17, 17, 14, 17, 17, 14),
    "9": (14, 17, 17, 15, 1, 2, 12), "A": (14, 17, 17, 17, 31, 17, 17), "B": (30, 17, 17, 30, 17, 17, 30),
    "C": (14, 17, 16, 16, 16, 17, 14), "D": (28, 18, 17, 17, 17, 18, 28), "E": (31, 16, 16, 30, 16, 16, 31),
    "F": (31, 16, 16, 30, 16, 16, 16), "G": (14, 17, 16, 23, 17, 17, 15), "H": (17, 17, 17, 31, 17, 17, 17),
    "I": (14, 4, 4, 4, 4, 4, 14), "J": (7, 2, 2, 2, 2, 18, 12), "K": (17, 18, 20, 24, 20, 18, 17),
    "L": (16, 16, 16, 16, 16, 16, 31), "M": (17, 27, 21, 21, 17, 17, 17), "N": (17, 17, 25, 21, 19, 17, 17),
    "O": (14, 17, 17, 17, 17, 17, 14), "P": (30, 17, 17, 30, 16, 16, 16), "Q": (14, 17, 17, 17, 21, 18, 13),
    "R": (30, 17, 17, 30, 20, 18, 17), "S": (15, 16, 16, 14, 1, 1, 30), "T": (31, 4, 4, 4, 4, 4, 4),
    "U": (17, 17, 17, 17, 17, 17, 14), "V": (17, 17, 17, 17, 17, 10, 4), "W": (17, 17, 17, 21, 21, 21, 10),
    "X": (17, 17, 10, 4, 10, 17, 17), "Y": (17, 17, 17, 10, 4, 4, 4), "Z": (31, 1, 2, 4, 8, 16, 31),
    "_": (0, 0, 0, 0, 0, 0, 31), "-": (0, 0, 0, 31, 0, 0, 0), ".": (0, 0, 0, 0, 0, 12, 12),
    ":": (0, 12, 12, 0, 12, 12, 0), "/": (1, 1, 2, 4, 8, 16, 16), "%": (24, 25, 2, 4, 8, 19, 3),
    "=": (0, 0, 31, 0, 31, 0, 0), "+": (0, 4, 4, 31, 4, 4, 0), " ": (0,) * 7, "?": (14, 17, 1, 2, 4, 0, 4),
}


def draw_text(img, x, y, text, scale=2, color=(1.0, 1.0, 1.0)):
    """Draw text on a top-down HxWx3 float image, on a darkened box."""
    text = text.upper()
    h, w = img.shape[:2]
    bw, bh = (len(text) * 6 + 1) * scale, 9 * scale
    img[y:min(h, y + bh), x:min(w, x + bw)] *= 0.25
    for i, ch in enumerate(text):
        for r, bits in enumerate(FONT.get(ch, FONT["?"])):
            for c in range(5):
                if bits & (16 >> c):
                    yy, xx = y + (r + 1) * scale, x + (i * 6 + c + 1) * scale
                    if yy + scale <= h and xx + scale <= w:
                        img[yy:yy + scale, xx:xx + scale] = color


# ---------------------------------------------------------------- image helpers (numpy, top-down RGB floats)

def load_image(path):
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    px = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    return px.reshape(h, w, 4)[::-1, :, :3].copy()


def resize(arr, nw, nh):
    h, w = arr.shape[:2]
    k = max(1, min(w // max(1, nw), h // max(1, nh)))
    if k > 1:  # box filter first, then nearest
        hh, ww = (h // k) * k, (w // k) * k
        arr = arr[:hh, :ww].reshape(hh // k, k, ww // k, k, 3).mean(axis=(1, 3))
        h, w = arr.shape[:2]
    ys = np.clip(((np.arange(nh) + 0.5) * h / nh).astype(int), 0, h - 1)
    xs = np.clip(((np.arange(nw) + 0.5) * w / nw).astype(int), 0, w - 1)
    return arr[ys][:, xs]


def fit_tile(arr, tile, bg=BG):
    """Scale to fit inside a square tile, centered."""
    h, w = arr.shape[:2]
    s = tile / max(h, w)
    nw, nh = max(1, round(w * s)), max(1, round(h * s))
    out = np.empty((tile, tile, 3), np.float32)
    out[:] = bg
    y0, x0 = (tile - nh) // 2, (tile - nw) // 2
    out[y0:y0 + nh, x0:x0 + nw] = resize(arr, nw, nh)
    return out


def save_jpg(arr, path, quality=88):
    h, w = arr.shape[:2]
    img = bpy.data.images.new("sheet", w, h, alpha=False)
    rgba = np.ones((h, w, 4), np.float32)
    rgba[..., :3] = np.clip(arr, 0.0, 1.0)
    img.pixels.foreach_set(rgba[::-1].ravel())
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    img.filepath_raw = path
    img.file_format = "JPEG"
    try:
        img.save(filepath=path, quality=quality)
    except TypeError:
        img.save()
    bpy.data.images.remove(img)


# ---------------------------------------------------------------- scene

def clear_scene():
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.lights,
                 bpy.data.cameras, bpy.data.textures, bpy.data.curves):
        ids = [i for i in coll if not (coll is bpy.data.images and i.type == "RENDER_RESULT")]
        if ids:
            bpy.data.batch_remove(ids)


def aim(obj, pos, target=(0.0, 0.0, 0.0)):
    obj.location = pos
    obj.rotation_euler = (Vector(target) - Vector(pos)).to_track_quat("-Z", "Y").to_euler()


def setup_scene(tile, samples):
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = samples
    sc.cycles.use_adaptive_sampling = True
    sc.cycles.use_denoising = True
    try:
        sc.cycles.denoiser = "OPENIMAGEDENOISE"
    except TypeError:
        pass
    sc.cycles.max_bounces = 4
    sc.render.resolution_x = sc.render.resolution_y = tile
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGB"
    world = bpy.data.worlds.get("check") or bpy.data.worlds.new("check")
    world.use_nodes = True
    bgn = world.node_tree.nodes.get("Background")
    bgn.inputs["Color"].default_value = (*BG, 1.0)
    bgn.inputs["Strength"].default_value = 1.0
    sc.world = world

    rig = bpy.data.objects.new("check_rig", None)
    sc.collection.objects.link(rig)
    cam = bpy.data.objects.new("check_cam", bpy.data.cameras.new("check_cam"))
    cam.data.angle = math.radians(35)
    dist = 1.12 / math.sin(math.radians(17.5))
    cam.location = (0, -dist, 0)
    cam.rotation_euler = (math.radians(90), 0, 0)
    cam.parent = rig
    sc.collection.objects.link(cam)
    sc.camera = cam
    for name, pos, energy, color in (("key", (-3, -4, 4), 3.5, (1.0, 0.97, 0.92)),
                                     ("fill", (4, -2, -1.5), 0.5, (0.75, 0.82, 1.0)),
                                     ("rim", (2.5, 5, 2.5), 6.0, (0.85, 0.9, 1.0))):
        light = bpy.data.objects.new("check_" + name, bpy.data.lights.new("check_" + name, "SUN"))
        light.data.energy = energy
        light.data.color = color
        light.data.angle = math.radians(3)
        aim(light, pos)
        light.parent = rig
        sc.collection.objects.link(light)
    return rig


# ---------------------------------------------------------------- measuring

def mesh_arrays(meshes):
    """World-space vertices, and per-loop vertex / next-vertex indices for all meshes."""
    verts, la, lb, tris, polys, offset = [], [], [], 0, 0, 0
    for o in meshes:
        me = o.data
        nv, npoly, nl = len(me.vertices), len(me.polygons), len(me.loops)
        co = np.empty(nv * 3, np.float64)
        me.vertices.foreach_get("co", co)
        m = np.array(o.matrix_world)
        verts.append(co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3])
        ls = np.empty(npoly, np.int64)
        lt = np.empty(npoly, np.int64)
        me.polygons.foreach_get("loop_start", ls)
        me.polygons.foreach_get("loop_total", lt)
        lv = np.empty(nl, np.int64)
        me.loops.foreach_get("vertex_index", lv)
        nxt = np.arange(nl) + 1
        nxt[ls + lt - 1] = ls
        la.append(lv + offset)
        lb.append(lv[nxt] + offset)
        tris += int((lt - 2).sum())
        polys += npoly
        offset += nv
    return np.concatenate(verts), np.concatenate(la), np.concatenate(lb), tris, polys


def measure(meshes):
    v, la, lb, tris, polys = mesh_arrays(meshes)
    lo, hi = v.min(0), v.max(0)
    center = (lo + hi) / 2
    radius = float(np.linalg.norm(v - center, axis=1).max())
    vn = (v - center) / radius
    # weld vertices split at UV seams so seams don't count as holes
    q = np.round(vn * 2e4).astype(np.int64)
    uq, inv = np.unique(q, axis=0, return_inverse=True)
    inv = inv.ravel()
    pos = uq / 2e4
    n = len(uq)
    a, b = inv[la], inv[lb]
    keep = a != b
    a, b = a[keep], b[keep]
    key = np.minimum(a, b) * n + np.maximum(a, b)
    ukey, counts = np.unique(key, return_counts=True)
    ea, eb = ukey // n, ukey % n
    bnd = counts == 1
    blen = float(np.linalg.norm(pos[ea[bnd]] - pos[eb[bnd]], axis=1).sum())
    # connected parts by label propagation with pointer jumping
    lab = np.arange(n)
    while True:
        old = lab.copy()
        m = np.minimum(lab[ea], lab[eb])
        np.minimum.at(lab, ea, m)
        np.minimum.at(lab, eb, m)
        lab = lab[lab]
        if np.array_equal(lab, old):
            break
    used = np.unique(np.concatenate([ea, eb]))
    parts, sizes = np.unique(lab[used], return_counts=True)
    sizes = np.sort(sizes)[::-1]
    ext = np.sort(hi - lo)[::-1] / (2 * radius)
    # Euler characteristic V - E + F = 2 per closed part, minus 2 per tunnel (handle). Tunnels are closed
    # surfaces, so the boundary numbers miss them; big ones render as black holes through the rock. Pixal3D
    # meshes also have many microscopic ones, so use this to compare candidates, not as pass/fail.
    chi = len(used) - len(ukey) + polys
    return center, radius, {
        "tris": tris, "verts_welded": int(n), "parts": int(len(parts)),
        "tunnels_est": max(0, int(round((2 * len(parts) - chi) / 2))),
        "main_part": round(float(sizes[0] / sizes.sum()), 4) if len(sizes) else 0.0,
        "parts_over_1pct": int((sizes > 0.01 * sizes.sum()).sum()),
        "boundary_edges": int(bnd.sum()), "boundary_len": round(blen, 3),
        "nonmanifold_edges": int((counts > 2).sum()),
        "extents": [round(float(x), 3) for x in ext],  # sorted bbox sizes, bounding radius = 1
    }


# ---------------------------------------------------------------- modes

def check_models(args):
    renders = args.renders or os.path.join(os.path.dirname(os.path.abspath(args.out)), "renders")
    os.makedirs(renders, exist_ok=True)
    views = args.views.split(",")
    labels = args.labels.split(",") if args.labels else [os.path.splitext(os.path.basename(p))[0] for p in args.files]
    rows, report = [], []
    for path, label in zip(args.files, labels):
        t0 = time.time()
        clear_scene()
        rig = setup_scene(args.tile, args.samples)
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=path)
        new = [o for o in bpy.data.objects if o not in before]
        meshes = [o for o in new if o.type == "MESH"]
        bpy.context.view_layer.update()
        center, radius, info = measure(meshes)
        norm = Matrix.Scale(1.0 / radius, 4) @ Matrix.Translation(Vector(-center))
        for o in new:
            if o.parent is None:
                o.matrix_world = norm @ o.matrix_world
        if args.clay:  # plain gray material: tells texture problems from geometry problems
            clay = bpy.data.materials.new("check_clay")
            clay.diffuse_color = (0.5, 0.5, 0.5, 1.0)
            clay.use_nodes = True
            bsdf = next(n for n in clay.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
            bsdf.inputs["Base Color"].default_value = (0.5, 0.5, 0.5, 1.0)
            bsdf.inputs["Roughness"].default_value = 0.8
            for o in meshes:
                o.data.materials.clear()
                o.data.materials.append(clay)
        info.update(label=label, file=os.path.abspath(path), file_mb=round(os.path.getsize(path) / 2**20, 2),
                    size_m=[round(float(x) * 2 * radius, 3) for x in info["extents"]],
                    textures=sorted({f"{i.size[0]}x{i.size[1]}" for i in bpy.data.images if i.size[0]}))
        tiles = []
        for view in views:
            az, el = VIEWS[view]
            rig.rotation_euler = (math.radians(-el), 0.0, math.radians(az))
            out = os.path.join(renders, f"{label}_{view}.png")
            bpy.context.scene.render.filepath = out
            bpy.ops.render.render(write_still=True)
            tile = load_image(out)
            draw_text(tile, 4, args.tile - 4 - 9, view, scale=1)
            tiles.append(tile)
        draw_text(tiles[0], 4, 4, label, scale=2)
        draw_text(tiles[0], 4, 26, f"{info['tris'] // 1000}K TRI  {info['parts']} PART", scale=1)
        draw_text(tiles[0], 4, 38, f"HOLES {info['boundary_len']}  TUN {info['tunnels_est']}", scale=1)
        rows.append(np.concatenate(tiles, axis=1))
        info["seconds"] = round(time.time() - t0, 1)
        report.append(info)
        print(f"CHECK {label}: {json.dumps(info)}", flush=True)

    blocks = max(1, args.blocks)
    per = math.ceil(len(rows) / blocks)
    gap = 6
    rw, rh = rows[0].shape[1], rows[0].shape[0]
    sheet = np.ones((per * rh + (per - 1) * gap, blocks * rw + (blocks - 1) * gap, 3), np.float32) * 0.18
    for i, row in enumerate(rows):
        bi, ri = divmod(i, per)
        y, x = ri * (rh + gap), bi * (rw + gap)
        sheet[y:y + rh, x:x + rw] = row
    save_jpg(sheet, args.out)
    rep = args.report or os.path.splitext(args.out)[0] + ".json"
    with open(rep, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=1)
    print(f"SHEET {args.out} ({sheet.shape[1]}x{sheet.shape[0]}), report {rep}", flush=True)


def check_images(args):
    labels = args.labels.split(",") if args.labels else [os.path.splitext(os.path.basename(p))[0] for p in args.files]
    cols = max(1, args.cols)
    nrows = math.ceil(len(args.files) / cols)
    gap = 4
    t = args.tile
    sheet = np.ones((nrows * t + (nrows - 1) * gap, cols * t + (cols - 1) * gap, 3), np.float32) * 0.18
    for i, (path, label) in enumerate(zip(args.files, labels)):
        tile = fit_tile(load_image(path), t)
        draw_text(tile, 3, 3, label, scale=2 if t >= 200 else 1)
        r, c = divmod(i, cols)
        sheet[r * (t + gap):r * (t + gap) + t, c * (t + gap):c * (t + gap) + t] = tile
    save_jpg(sheet, args.out)
    print(f"SHEET {args.out} ({sheet.shape[1]}x{sheet.shape[0]})", flush=True)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser(prog="blender_check.py")
    sub = ap.add_subparsers(dest="mode", required=True)
    m = sub.add_parser("models")
    m.add_argument("files", nargs="+")
    m.add_argument("--out", required=True)
    m.add_argument("--renders")
    m.add_argument("--report")
    m.add_argument("--tile", type=int, default=320)
    m.add_argument("--samples", type=int, default=32)
    m.add_argument("--blocks", type=int, default=1)
    m.add_argument("--views", default="front,right,back,left,top,bottom")
    m.add_argument("--labels")
    m.add_argument("--clay", action="store_true", help="render with a plain gray material instead of the textures")
    i = sub.add_parser("images")
    i.add_argument("files", nargs="+")
    i.add_argument("--out", required=True)
    i.add_argument("--cols", type=int, default=6)
    i.add_argument("--tile", type=int, default=256)
    i.add_argument("--labels")
    args = ap.parse_args(argv)
    (check_models if args.mode == "models" else check_images)(args)


if __name__ == "__main__":  # importable by tools/blender_meteors.py
    main()
