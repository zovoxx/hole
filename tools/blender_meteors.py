"""Conto 2: game-ready PC and mobile meteor GLBs from the raw Pixal3D models. Runs inside Blender (background),
Cycles on the CPU only (safe while ComfyUI works). Mesh repair and decimation run in tools/mesh_tool.py through a
venv Python with numpy/scipy/scikit-image/pymeshlab (HOLE_TOOLS_PY, default %USERPROFILE%/Documents/HoleWork/venv).

build      raw GLB -> drop tiny loose pieces -> center, bounding radius 1 m -> repair: watertight solid of the outer
           wall (the raw meshes are thin double-walled shells with holes) -> PC and mobile LOD (quadric decimation of
           the solid) -> UV unwrap -> bake from the raw, selected-to-active: base colour, normal, AO -> neutral gray
           base colour (desaturated, large-scale baked-in lighting evened out, same median for every rock) -> ORM
           (AO, constant roughness, no metal) -> collision spheres -> GLB with WebP textures and tangents.
fragments  cuts one repaired rock into 4 Voronoi cells (flat broken faces) and runs the same LOD/bake/export steps.
check      re-imports the exported GLBs, measures them and renders PC next to mobile in game-like dark light with the
           gray / decoy / exploder tints -> contact sheet + JSON report.
blend      collects the exported GLBs into one .blend (pc and mobile collections).

  blender -b --factory-startup -P tools/blender_meteors.py -- build [ids ...]
  blender -b --factory-startup -P tools/blender_meteors.py -- fragments [--src rock_04] [--seed 1]
  blender -b --factory-startup -P tools/blender_meteors.py -- check [--out docs/checks/conto2_meteors.jpg] [ids ...]
  blender -b --factory-startup -P tools/blender_meteors.py -- blend [--save source/meteors/meteors.blend]

Common options: --raw source/meteors/raw  --out-dir public/assets/meteors  --info source/meteors/meteors.json
                --work %USERPROFILE%/Documents/HoleWork/conto2
Coordinates: Blender Z up while working; the GLBs are glTF +Y up. Collision spheres are written in glTF axes.
"""
import argparse
import json
import math
import os
import struct
import subprocess
import sys
import time
import traceback

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

TOOLS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(TOOLS)
sys.path.insert(0, TOOLS)
import blender_check as bc  # noqa: E402  (scene clearing, image helpers, label font)

TOOLS_PY = os.environ.get("HOLE_TOOLS_PY") or os.path.join(
    os.path.expanduser("~"), "Documents", "HoleWork", "venv", "Scripts", "python.exe")

KINDS = {  # (triangles, texture size) per LOD
    "small": {"pc": (2500, 1024), "mobile": (800, 512)},
    "big": {"pc": (10000, 2048), "mobile": (3000, 1024)},
    "frag": {"pc": (400, 512), "mobile": (150, 256)},
}
SMALL = [f"rock_{i:02d}" for i in range(1, 9)]
BIG = [f"big_{i:02d}" for i in range(1, 4)]
FRAGS = [f"frag_{i:02d}" for i in range(1, 5)]
SETS = ("pc", "mobile")

LOOSE_MAX = 0.01       # loose parts with less than this share of the faces are dropped
SOLID_VOXEL = 0.008    # voxel of the watertight repair (bounding radius 1)
COARSE_TRIS = 12000    # coarse proxy for the low-frequency (baked lighting) estimate, edges ~0.04
GAIN_ITERS = 120       # smoothing passes on the coarse proxy (~0.3 m)
GAIN_RANGE = (0.6, 1.8)
BASE_MEDIAN = 0.58     # sRGB median of every final base colour; the game multiplies it by a tint
BASE_MAX_RATIO = 4.5   # cap on p95/p5 (linear) of the base colour
ROUGHNESS = 0.85       # Pixal3D gave a constant 0.84
AO_STRENGTH = 0.7      # share of the baked AO kept in the ORM red channel
AO_DISTANCE = 0.25
BAKE_SAMPLES = 8
WEBP_QUALITY = 88
SHARD_SHARP = math.radians(40)  # fragment edges sharper than this get split normals
CAP_GRAY = 0.16        # linear albedo of the broken (cut) faces of fragments, before the levels step
LUM = np.array([0.2126, 0.7152, 0.0722], np.float32)
TINTS = {"gray": "#c8c8c8", "decoy": "#f0dc94", "exploder": "#f2b414"}  # sRGB, multiplied with the base colour


def kind_of(rid):
    return "big" if rid.startswith("big_") else "frag" if rid.startswith("frag_") else "small"


def log(msg):
    print(f"[meteors {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def srgb_to_lin(c):
    c = np.asarray(c, np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(np.asarray(c, np.float32), 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def hex_lin(h):
    return tuple(float(x) for x in srgb_to_lin([int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]))


def to_gltf(p):
    """Blender (Z up) -> glTF (Y up)."""
    return [round(float(p[0]), 4), round(float(p[2]), 4), round(float(-p[1]), 4)]


# ---------------------------------------------------------------- mesh helpers

def verts_np(me):
    co = np.empty(len(me.vertices) * 3, np.float64)
    me.vertices.foreach_get("co", co)
    return co.reshape(-1, 3)


def set_verts(me, v):
    me.vertices.foreach_set("co", np.asarray(v, np.float32).ravel())
    me.update()


def edges_np(me):
    e = np.empty(len(me.edges) * 2, np.int64)
    me.edges.foreach_get("vertices", e)
    return e.reshape(-1, 2)


def tris_np(me):
    me.calc_loop_triangles()
    t = np.empty(len(me.loop_triangles) * 3, np.int64)
    me.loop_triangles.foreach_get("vertices", t)
    return t.reshape(-1, 3)


def tri_count(me):
    lt = np.empty(len(me.polygons), np.int64)
    me.polygons.foreach_get("loop_total", lt)
    return int((lt - 2).sum())


def components(n, ea, eb):
    lab = np.arange(n)
    while True:
        old = lab.copy()
        m = np.minimum(lab[ea], lab[eb])
        np.minimum.at(lab, ea, m)
        np.minimum.at(lab, eb, m)
        lab = lab[lab]
        if np.array_equal(lab, old):
            return lab


def face_labels(me, weld=True):
    """Connected-part label per face (vertices welded by position, so UV seams don't split parts)."""
    v = verts_np(me)
    if weld:
        q = np.round((v - v.min(0)) * 2e4).astype(np.int64)
        _, inv = np.unique(q, axis=0, return_inverse=True)
        inv = inv.ravel()
    else:
        inv = np.arange(len(v))
    e = edges_np(me)
    lab = components(int(inv.max()) + 1, inv[e[:, 0]], inv[e[:, 1]])
    ls = np.empty(len(me.polygons), np.int64)
    me.polygons.foreach_get("loop_start", ls)
    lv = np.empty(len(me.loops), np.int64)
    me.loops.foreach_get("vertex_index", lv)
    return lab[inv[lv[ls]]]


def delete_faces(obj, mask):
    if not mask.any():
        return
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.faces[i] for i in np.nonzero(mask)[0]], context="FACES")
    bm.to_mesh(obj.data)
    bm.free()


def drop_loose(obj, max_share=LOOSE_MAX, weld=True):
    flab = face_labels(obj.data, weld)
    labs, counts = np.unique(flab, return_counts=True)
    small = labs[counts < max_share * len(flab)]
    drop = np.isin(flab, small)
    delete_faces(obj, drop)
    return int(len(labs)), int(drop.sum())


def keep_largest(obj, weld=False):
    flab = face_labels(obj.data, weld)
    labs, counts = np.unique(flab, return_counts=True)
    delete_faces(obj, flab != labs[counts.argmax()])
    return int(len(labs))


def new_object(name, me):
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def select_only(objs, active=None):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    if active is not None:
        bpy.context.view_layer.objects.active = active


def mesh_from_np(name, v, f):
    me = bpy.data.meshes.new(name)
    me.from_pydata(np.asarray(v, np.float64).tolist(), [], np.asarray(f, np.int64).tolist())
    me.validate()
    me.update()
    me.shade_smooth()
    return new_object(name, me)


def run_tool(mode, inp, out, *extra):
    """tools/mesh_tool.py in the venv Python; returns its RESULT numbers."""
    cmd = [TOOLS_PY, os.path.join(TOOLS, "mesh_tool.py"), mode, inp, out, *map(str, extra)]
    p = subprocess.run(cmd, capture_output=True, text=True)
    line = next((ln for ln in p.stdout.splitlines() if ln.startswith("RESULT ")), None)
    if p.returncode or line is None:
        raise RuntimeError(f"mesh_tool {mode} failed: {p.stdout[-2000:]} {p.stderr[-2000:]}")
    return json.loads(line[7:])


def save_np(path, o):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    np.savez(path, v=verts_np(o.data).astype(np.float32), f=tris_np(o.data).astype(np.int32))


def load_np(path, name):
    d = np.load(path)
    return mesh_from_np(name, d["v"], d["f"])


def decimated(src_npz, name, tris, work):
    out = os.path.join(work, f"{name}_{tris}.npz")
    res = run_tool("decimate", src_npz, out, "--tris", tris)
    o = load_np(out, name)
    clean_tris(o)
    return o, res


def clean_tris(o):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.dissolve_degenerate(bm, dist=1e-7, edges=bm.edges[:])
    big = [f for f in bm.faces if len(f.verts) > 3]
    if big:
        bmesh.ops.triangulate(bm, faces=big, quad_method="BEAUTY", ngon_method="BEAUTY")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(o.data)
    bm.free()
    o.data.shade_smooth()


def mark_sharp(o, angle):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    for f in bm.faces:
        f.smooth = True
    n = 0
    for e in bm.edges:
        sharp = len(e.link_faces) == 2 and e.calc_face_angle(0.0) > angle
        e.smooth = not sharp
        n += sharp
    bm.to_mesh(o.data)
    bm.free()
    return n


def bvh_of(o):
    return BVHTree.FromObject(o, bpy.context.evaluated_depsgraph_get())


def deviation(lod, hi_bvh, hi_sample):
    lod_bvh = bvh_of(lod)
    d1 = np.array([hi_bvh.find_nearest(Vector(p))[3] for p in verts_np(lod.data)])
    d2 = np.array([lod_bvh.find_nearest(Vector(p))[3] for p in hi_sample])
    return {"lodToHiMax": round(float(d1.max()), 4), "hiToLodMax": round(float(d2.max()), 4),
            "hiToLodP99": round(float(np.percentile(d2, 99)), 4), "hiToLodMean": round(float(d2.mean()), 4)}


def unwrap(o, res):
    if not o.data.uv_layers:
        o.data.uv_layers.new(name="UVMap")
    select_only([o], o)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    margin = 6.0 / res
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=margin, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    try:
        bpy.ops.uv.select_all(action="SELECT")
        bpy.ops.uv.pack_islands(rotate=True, margin_method="FRACTION", margin=margin, shape_method="CONCAVE")
    except (TypeError, RuntimeError) as e:
        log(f"pack_islands fallback ({e})")
    bpy.ops.object.mode_set(mode="OBJECT")
    me = o.data
    uv = np.empty(len(me.loops) * 2, np.float64)
    me.uv_layers.active.data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    lo, hi = uv.min(0), uv.max(0)  # the packer leaves free space: scale the layout back up to fill the texture
    uv = (uv - lo) * ((1.0 - 2 * margin) / (hi - lo).max()) + margin
    me.uv_layers.active.data.foreach_set("uv", uv.ravel())
    t = uv.reshape(-1, 3, 2)  # all faces are triangles
    a = 0.5 * np.abs((t[:, 1, 0] - t[:, 0, 0]) * (t[:, 2, 1] - t[:, 0, 1]) -
                     (t[:, 2, 0] - t[:, 0, 0]) * (t[:, 1, 1] - t[:, 0, 1]))
    return round(float(a.sum()), 3)  # share of the texture covered by islands


# ---------------------------------------------------------------- materials

def node_material(name):
    mat = bpy.data.materials.new(name)
    if mat.node_tree is None:  # Blender < 5 (5.x materials always use nodes)
        mat.use_nodes = True
    return mat


def link(nt, a, b):
    nt.links.new(a, b)


def material_base_image(obj):
    for mat in obj.data.materials:
        for n in mat.node_tree.nodes:
            if n.type == "BSDF_PRINCIPLED" and n.inputs["Base Color"].is_linked:
                src = n.inputs["Base Color"].links[0].from_node
                if src.type == "TEX_IMAGE":
                    return src.image
    raise RuntimeError(f"no base colour image on {obj.name}")


def src_material(name, base_image=None, gray=None, bump=False):
    """Bake source with three switchable surfaces: 'emit' (base colour as emission), 'emit_ao' (AO as emission,
    only this object occludes) and 'bsdf' (for the normal bake). base_image is multiplied by the 'gain' attribute;
    gray gives a noisy constant instead (broken faces of fragments)."""
    mat = node_material(name)
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.name = "out"
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.name = "bsdf"
    em = nt.nodes.new("ShaderNodeEmission")
    em.name = "emit"
    ao = nt.nodes.new("ShaderNodeAmbientOcclusion")
    ao.only_local = True
    ao.samples = 16
    ao.inputs["Distance"].default_value = AO_DISTANCE
    em_ao = nt.nodes.new("ShaderNodeEmission")
    em_ao.name = "emit_ao"
    link(nt, ao.outputs["AO"], em_ao.inputs["Color"])
    if base_image is not None:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = base_image
        attr = nt.nodes.new("ShaderNodeAttribute")
        attr.attribute_name = "gain"
        mul = nt.nodes.new("ShaderNodeVectorMath")
        mul.operation = "MULTIPLY"
        link(nt, tex.outputs["Color"], mul.inputs[0])
        link(nt, attr.outputs["Color"], mul.inputs[1])
        link(nt, mul.outputs["Vector"], em.inputs["Color"])
    elif gray is not None:  # freshly broken stone: blotchy gray with fine grain
        noise = nt.nodes.new("ShaderNodeTexNoise")
        noise.inputs["Scale"].default_value = 9.0
        noise.inputs["Detail"].default_value = 10.0
        noise.inputs["Roughness"].default_value = 0.65
        ramp = nt.nodes.new("ShaderNodeMapRange")
        ramp.inputs["From Min"].default_value = 0.3
        ramp.inputs["From Max"].default_value = 0.7
        ramp.inputs["To Min"].default_value = gray * 0.55
        ramp.inputs["To Max"].default_value = gray * 1.45
        link(nt, noise.outputs["Fac"], ramp.inputs["Value"])
        link(nt, ramp.outputs["Result"], em.inputs["Color"])
    if bump:  # rough fracture surface (only the normal map sees it; the cut itself stays flat)
        noise = nt.nodes.new("ShaderNodeTexNoise")
        noise.inputs["Scale"].default_value = 14.0
        noise.inputs["Detail"].default_value = 10.0
        noise.inputs["Roughness"].default_value = 0.7
        bn = nt.nodes.new("ShaderNodeBump")
        bn.inputs["Strength"].default_value = 0.8
        bn.inputs["Distance"].default_value = 0.03
        link(nt, noise.outputs["Fac"], bn.inputs["Height"])
        link(nt, bn.outputs["Normal"], bsdf.inputs["Normal"])
    link(nt, em.outputs["Emission"], out.inputs["Surface"])
    return mat


def set_surface(objs, which):
    """which: 'emit' (base colour), 'emit_ao' (AO) or 'bsdf' (normal)."""
    for o in objs:
        for mat in o.data.materials:
            nt = mat.node_tree
            node = nt.nodes[which]
            sock = node.outputs["BSDF"] if which == "bsdf" else node.outputs["Emission"]
            link(nt, sock, nt.nodes["out"].inputs["Surface"])


def dst_material(o):
    mat = node_material(o.name + "_bake")
    nt = mat.node_tree
    nt.nodes.clear()
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.name = "target"
    nt.nodes.new("ShaderNodeOutputMaterial")
    nt.nodes.active = tex
    o.data.materials.clear()
    o.data.materials.append(mat)
    o.data.polygons.foreach_set("material_index", np.zeros(len(o.data.polygons), np.int64))
    return mat


def gltf_output_group():
    ng = bpy.data.node_groups.get("glTF Material Output")
    if ng is None:
        ng = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
        ng.interface.new_socket(name="Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
        ng.interface.new_socket(name="Thickness", in_out="INPUT", socket_type="NodeSocketFloat")
    return ng


def export_material(name, base, orm, normal):
    mat = node_material(name)
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    link(nt, bsdf.outputs["BSDF"], out.inputs["Surface"])
    tb = nt.nodes.new("ShaderNodeTexImage")
    tb.image = base
    link(nt, tb.outputs["Color"], bsdf.inputs["Base Color"])
    to = nt.nodes.new("ShaderNodeTexImage")
    to.image = orm
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    link(nt, to.outputs["Color"], sep.inputs["Color"])
    link(nt, sep.outputs["Green"], bsdf.inputs["Roughness"])
    link(nt, sep.outputs["Blue"], bsdf.inputs["Metallic"])
    grp = nt.nodes.new("ShaderNodeGroup")
    grp.node_tree = gltf_output_group()
    link(nt, sep.outputs["Red"], grp.inputs["Occlusion"])
    tn = nt.nodes.new("ShaderNodeTexImage")
    tn.image = normal
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nm.uv_map = "UVMap"
    link(nt, tn.outputs["Color"], nm.inputs["Color"])
    link(nt, nm.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


# ---------------------------------------------------------------- baking

def setup_bake():
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = BAKE_SAMPLES
    sc.cycles.use_denoising = False


def make_cage(lod, extrusion):
    """Copy of the LOD pushed out along averaged vertex normals. With split (sharp) normals the default
    extrusion opens gaps at the edges and the bake rays miss there."""
    cage = new_object(lod.name + "_cage", lod.data.copy())
    v = verts_np(cage.data)
    t = tris_np(cage.data)
    fn = np.cross(v[t[:, 1]] - v[t[:, 0]], v[t[:, 2]] - v[t[:, 0]])
    vn = np.zeros_like(v)
    for k in range(3):
        np.add.at(vn, t[:, k], fn)
    vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)
    set_verts(cage.data, v + vn * extrusion)
    return cage


def bake(lod, sources, btype, res, extrusion, margin, cage=None):
    img = bpy.data.images.new(f"{lod.name}_{btype}", res, res, alpha=False, float_buffer=True)
    img.colorspace_settings.name = "Non-Color"
    nt = lod.data.materials[0].node_tree
    node = nt.nodes["target"]
    node.image = img
    nt.nodes.active = node
    select_only(sources + [lod], lod)
    bpy.ops.object.bake(type=btype, use_selected_to_active=True, max_ray_distance=0.0,
                        cage_extrusion=0.0 if cage else extrusion, use_cage=cage is not None,
                        cage_object=cage.name if cage else "",
                        margin=margin, margin_type="EXTEND", use_clear=True, target="IMAGE_TEXTURES",
                        normal_space="TANGENT")
    px = np.empty(res * res * 4, np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    return px.reshape(res, res, 4)


def save_png(arr, name, path, colorspace):
    h, w = arr.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=False)
    img.colorspace_settings.name = colorspace
    rgba = np.ones((h, w, 4), np.float32)
    rgba[..., :3] = arr
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    return img


def finish_textures(name, base, ao, nrm, work):
    """Baked float buffers -> gray base colour (sRGB), ORM and normal images (saved as PNG in work)."""
    cov = base[..., :3].max(-1) > 0  # pixels the bake wrote (islands + margin); the rest stays black
    lum = base[..., :3] @ LUM
    s = lum[cov]
    med, p5, p95 = (float(np.percentile(s, q)) for q in (50, 5, 95))
    target = float(srgb_to_lin(BASE_MEDIAN))
    L = lum * (target / med)
    ratio = p95 / max(p5, 1e-4)
    gamma = 1.0
    if ratio > BASE_MAX_RATIO:
        gamma = math.log(BASE_MAX_RATIO) / math.log(ratio)
        L = target * (np.maximum(L, 1e-4) / target) ** gamma
    L = np.clip(L, 0.01, 0.92)
    L[~cov] = target
    gray = np.repeat(lin_to_srgb(L)[..., None], 3, axis=2)
    a = np.clip(ao[..., 0], 0.0, 1.0)
    a = 1.0 - AO_STRENGTH * (1.0 - a)
    a[~cov] = 1.0
    orm = np.stack([a, np.full_like(a, ROUGHNESS), np.zeros_like(a)], axis=2)
    n = nrm[..., :3].copy()
    n[~cov] = (0.5, 0.5, 1.0)
    os.makedirs(work, exist_ok=True)
    imgs = (save_png(gray, name + "_base", os.path.join(work, name + "_base.png"), "sRGB"),
            save_png(orm, name + "_orm", os.path.join(work, name + "_orm.png"), "Non-Color"),
            save_png(n, name + "_normal", os.path.join(work, name + "_normal.png"), "Non-Color"))
    flipped = float((n[cov][:, 2] < 0.5).mean())  # normals facing away from the surface = bake errors
    stats = {"rawMedianLin": round(med, 4), "rawP5P95Ratio": round(ratio, 2), "contrastGamma": round(gamma, 3),
             "aoMean": round(float(a[cov].mean()), 3), "coverage": round(float(cov.mean()), 3),
             "normalFlipped": round(flipped, 4)}
    return imgs, stats


def export_glb(o, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    select_only([o], o)
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True,
                              export_image_format="WEBP", export_image_quality=WEBP_QUALITY,
                              export_tangents=True, export_yup=True, export_apply=True, export_texcoords=True,
                              export_normals=True, export_materials="EXPORT", export_vertex_color="NONE",
                              export_animations=False, export_cameras=False, export_lights=False,
                              export_extras=False)


def make_lod(rid, set_name, hi_npz, sources, hi_bvh, hi_sample, out_dir, work, sharp=None, xf=None,
             shape_sources=None):
    """Decimate the repaired mesh -> unwrap -> bake (base colour from sources, AO and normal from shape_sources,
    default the same) -> textures -> export. xf=(center, radius) normalizes the LOD for export (fragments)."""
    shape_sources = shape_sources or sources
    tris, res = KINDS[kind_of(rid)][set_name]
    t0 = time.time()
    name = f"{rid}_{set_name}"
    lod, _ = decimated(hi_npz, name, tris, work)
    sharp_edges = mark_sharp(lod, sharp) if sharp else 0
    dst_material(lod)
    uv_fill = unwrap(lod, res)
    dev = deviation(lod, hi_bvh, hi_sample)
    extrusion = float(np.clip(1.25 * max(dev["hiToLodMax"], dev["lodToHiMax"]) + 0.01, 0.02, 0.15))
    margin = max(4, res // 128)
    cage = make_cage(lod, extrusion) if sharp else None
    set_surface(sources, "emit")
    base = bake(lod, sources, "EMIT", res, extrusion, margin, cage)
    set_surface(shape_sources, "emit_ao")
    ao = bake(lod, shape_sources, "EMIT", res, extrusion, margin, cage)
    set_surface(shape_sources, "bsdf")
    nrm = bake(lod, shape_sources, "NORMAL", res, extrusion, margin, cage)
    if cage:
        bpy.data.meshes.remove(cage.data)
    imgs, tstats = finish_textures(name, base, ao, nrm, work)
    lod.data.materials.clear()
    lod.data.materials.append(export_material(rid, *imgs))
    if xf is not None:
        center, radius = xf
        set_verts(lod.data, (verts_np(lod.data) - center) / radius)
    lod.name = rid
    lod.data.name = rid
    path = os.path.join(out_dir, set_name, rid + ".glb")
    export_glb(lod, path)
    info = {"tris": tri_count(lod.data), "texture": res, "uvFill": uv_fill, "cageExtrusion": round(extrusion, 3),
            "sharpEdges": sharp_edges, **dev, **tstats, "bytes": os.path.getsize(path),
            "seconds": round(time.time() - t0, 1)}
    log(f"{rid} {set_name}: {json.dumps(info)}")
    lod.name = name
    return lod, info


# ---------------------------------------------------------------- collision

def inside_mask(bvh, pts):
    d = Vector((1.0, 0.1234, 0.0567)).normalized()
    res = np.zeros(len(pts), bool)
    for i, p in enumerate(pts):
        o = Vector(p)
        n = 0
        while n < 64:
            hit = bvh.ray_cast(o, d)
            if hit[0] is None:
                break
            n += 1
            o = hit[0] + d * 1e-5
        res[i] = n % 2 == 1
    return res


def collision(bvh, n=36, max_spheres=12, target=0.8):
    """collisionRadius: largest sphere at the origin with >= 92% of its volume inside the rock.
    collisionSpheres: greedy set of spheres inside the rock (5% under the surface) until they cover `target` of
    its volume (max 12; flat and long rocks need more)."""
    g = (np.arange(n) + 0.5) / n * 2.0 - 1.0
    P = np.stack(np.meshgrid(g, g, g, indexing="ij"), -1).reshape(-1, 3)
    P = P[np.linalg.norm(P, axis=1) <= 1.0]
    inside = inside_mask(bvh, P)
    d = np.linalg.norm(P, axis=1)
    order = np.argsort(d)
    frac = np.cumsum(inside[order]) / np.arange(1, len(order) + 1)
    ok = np.nonzero((frac >= 0.92) & (d[order] >= 4.0 / n))[0]
    r_single = float(d[order][ok.max()]) if len(ok) else 0.0
    inP = P[inside]
    cand = inP[:: max(1, len(inP) // 1500)]
    rc = np.array([bvh.find_nearest(Vector(c))[3] for c in cand]) * 0.95
    covered = np.zeros(len(inP), bool)
    spheres = []
    for _ in range(max_spheres):
        free = inP[~covered]
        if not len(free):
            break
        gains = np.zeros(len(cand), np.int64)
        for s in range(0, len(cand), 200):
            c = cand[s:s + 200]
            d2 = ((free[:, None, :] - c[None, :, :]) ** 2).sum(-1)
            gains[s:s + 200] = (d2 < (rc[s:s + 200] ** 2)[None, :]).sum(0)
        j = int(gains.argmax())
        spheres.append(to_gltf(cand[j]) + [round(float(rc[j]), 4)])
        covered |= ((inP - cand[j]) ** 2).sum(-1) < rc[j] ** 2
        if covered.mean() >= target:
            break
    return {"collisionRadius": round(r_single, 3), "collisionSpheres": spheres,
            "sphereCoverage": round(float(covered.mean()), 3),
            "unitSphereFill": round(float(inside.mean()), 3)}  # share of the bounding sphere that is rock


# ---------------------------------------------------------------- per rock

def clear_all():
    bc.clear_scene()
    ids = list(bpy.data.node_groups)
    if ids:
        bpy.data.batch_remove(ids)


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]
    for o in meshes:
        mw = o.matrix_world.copy()
        o.parent = None
        o.data.transform(mw)
        o.matrix_world = Matrix.Identity(4)
    for o in new:
        if o.type != "MESH":
            bpy.data.objects.remove(o)
    if len(meshes) > 1:
        select_only(meshes, meshes[0])
        bpy.ops.object.join()
    return meshes[0]


def prepare(rid, args, work):
    """Raw import -> clean -> normalize -> watertight repaired mesh -> gain attribute -> raw bake material."""
    clear_all()
    raw = import_glb(os.path.join(args.raw, rid + ".glb"))
    raw.name = rid + "_raw"
    base_img = material_base_image(raw)
    parts, dropped = drop_loose(raw)
    v = verts_np(raw.data)
    lo, hi_ = v.min(0), v.max(0)
    center = (lo + hi_) / 2
    radius = float(np.linalg.norm(v - center, axis=1).max())
    set_verts(raw.data, (v - center) / radius)
    raw_npz = os.path.join(work, rid + "_raw.npz")
    hi_npz = os.path.join(work, rid + "_hi.npz")
    save_np(raw_npz, raw)
    solid = run_tool("solid", raw_npz, hi_npz, "--voxel", SOLID_VOXEL)
    log(f"{rid} solid: {json.dumps(solid)}")
    hi = load_np(hi_npz, rid + "_hi")
    hv = verts_np(hi.data)  # normalize again on the repaired solid (the raw had loose bits and inner walls)
    c2 = (hv.min(0) + hv.max(0)) / 2
    r2 = float(np.linalg.norm(hv - c2, axis=1).max())
    set_verts(hi.data, (hv - c2) / r2)
    set_verts(raw.data, (verts_np(raw.data) - c2) / r2)
    save_np(hi_npz, hi)
    center, radius = center + c2 * radius, radius * r2
    gain = add_gain(raw, base_img, hi_npz, work)
    raw.data.materials.clear()
    raw.data.materials.append(src_material(rid + "_src_raw", base_image=base_img))
    info = {"raw": os.path.relpath(os.path.join(args.raw, rid + ".glb"), ROOT).replace("\\", "/"),
            "rawParts": parts, "droppedFaces": dropped,
            "normalize": {"center": [round(float(x), 5) for x in center], "scale": round(1.0 / radius, 5)},
            "solid": solid, **gain}
    return raw, hi, hi_npz, info


def add_gain(raw, base_img, hi_npz, work):
    """Per-vertex 'gain' on the raw mesh that evens out the large-scale (baked lighting) brightness."""
    coarse, _ = decimated(hi_npz, raw.name + "_coarse", COARSE_TRIS, work)
    me = raw.data
    w, h = base_img.size
    px = np.empty(w * h * 4, np.float32)
    base_img.pixels.foreach_get(px)  # 8-bit sRGB image: encoded values
    lum_img = srgb_to_lin(px.reshape(h, w, 4)[..., :3]) @ LUM
    uv = np.empty(len(me.loops) * 2, np.float64)
    me.uv_layers.active.data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    xs = np.clip((uv[:, 0] % 1.0) * w, 0, w - 1).astype(np.int64)
    ys = np.clip((uv[:, 1] % 1.0) * h, 0, h - 1).astype(np.int64)
    lv = np.empty(len(me.loops), np.int64)
    me.loops.foreach_get("vertex_index", lv)
    nv = len(me.vertices)
    lum_v = np.bincount(lv, lum_img[ys, xs], nv) / np.maximum(np.bincount(lv, minlength=nv), 1)
    cv = verts_np(coarse.data)
    nc = len(cv)
    kd = KDTree(nc)
    for i, c in enumerate(cv):
        kd.insert(c, i)
    kd.balance()
    rv = verts_np(me)
    near = np.fromiter((kd.find(p)[1] for p in rv), np.int64, len(rv))
    cnt = np.bincount(near, minlength=nc)
    x = np.bincount(near, lum_v, nc) / np.maximum(cnt, 1)
    x[cnt == 0] = np.median(x[cnt > 0])
    x0 = x.copy()
    e = edges_np(coarse.data)
    ea, eb = e[:, 0], e[:, 1]
    deg = np.maximum(np.bincount(ea, minlength=nc) + np.bincount(eb, minlength=nc), 1)
    for _ in range(GAIN_ITERS):
        x = 0.5 * x + 0.5 * (np.bincount(ea, x[eb], nc) + np.bincount(eb, x[ea], nc)) / deg
    low = np.empty(nv)
    for i, p in enumerate(rv):
        acc = wsum = 0.0
        for _, idx, dist in kd.find_n(p, 4):
            wt = 1.0 / (dist + 1e-3)
            acc += wt * x[idx]
            wsum += wt
        low[i] = acc / wsum
    target = float(np.median(x))
    gain = np.clip(target / np.maximum(low, 1e-4), *GAIN_RANGE)
    attr = me.color_attributes.new("gain", "FLOAT_COLOR", "POINT")
    col = np.ones((nv, 4), np.float32)
    col[:, :3] = gain[:, None]
    attr.data.foreach_set("color", col.ravel())
    bpy.data.meshes.remove(coarse.data)
    return {"lumP5P95": [round(float(np.percentile(x0, q) / target), 3) for q in (5, 95)],
            "lightingMinMax": [round(float(x.min() / target), 3), round(float(x.max() / target), 3)],
            "gainMinMax": [round(float(gain.min()), 3), round(float(gain.max()), 3)]}


def load_info(path):
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_info(path, info):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(dict(sorted(info.items())), f, indent=1)


def build(args):
    ids = args.ids or SMALL + BIG
    setup_bake()
    failed = []
    for rid in ids:
        t0 = time.time()
        work = os.path.join(args.work, rid)
        try:
            log(f"{rid}: prepare")
            raw, hi, hi_npz, info = prepare(rid, args, work)
            hi_bvh = bvh_of(hi)
            hi_sample = verts_np(hi.data)[::5]
            info["lod"] = {}
            for s in SETS:
                _, info["lod"][s] = make_lod(rid, s, hi_npz, [raw], hi_bvh, hi_sample, args.out_dir, work)
            info.update(collision(hi_bvh))
            info["kind"] = kind_of(rid)
            info["seconds"] = round(time.time() - t0, 1)
            all_info = load_info(args.info)
            all_info[rid] = info
            save_info(args.info, all_info)
            log(f"{rid} done in {info['seconds']} s: r={info['collisionRadius']} "
                f"spheres={len(info['collisionSpheres'])} cover={info['sphereCoverage']}")
            if args.save_work:
                bpy.ops.wm.save_as_mainfile(filepath=os.path.join(args.work, rid + ".blend"), copy=True)
        except Exception:
            traceback.print_exc()
            failed.append(rid)
            log(f"{rid} FAILED")
    log(f"build finished, failed: {failed}")
    return 1 if failed else 0


def recollide(args):
    """Recompute the collision numbers from the repaired meshes saved in the work folder (no rebake)."""
    all_info = load_info(args.info)
    for rid in args.ids or [k for k in all_info]:
        clear_all()
        meta = all_info[rid]
        if kind_of(rid) == "frag":
            o = load_np(os.path.join(args.work, "fragments", rid + "_hi.npz"), rid)
            n = meta["normalize"]
            set_verts(o.data, (verts_np(o.data) - np.array(n["center"])) * n["scale"])
        else:
            o = load_np(os.path.join(args.work, rid, rid + "_hi.npz"), rid)
        meta.update(collision(bvh_of(o)))
        log(f"{rid}: r={meta['collisionRadius']} spheres={len(meta['collisionSpheres'])} "
            f"cover={meta['sphereCoverage']}")
    save_info(args.info, all_info)
    return 0


# ---------------------------------------------------------------- fragments

def cut_cell(hi, seeds, i, name):
    bm = bmesh.new()
    bm.from_mesh(hi.data)
    for f in bm.faces:
        f.material_index = 0
    si = Vector(seeds[i])
    for j, sj in enumerate(seeds):
        if j == i:
            continue
        sj = Vector(sj)
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-6,
                               plane_co=(si + sj) / 2, plane_no=(sj - si).normalized(), clear_outer=True)
        ret = bmesh.ops.holes_fill(bm, edges=[e for e in bm.edges if e.is_boundary], sides=1_000_000)
        for f in ret["faces"]:
            f.material_index = 1
    caps = [f for f in bm.faces if f.material_index == 1 and len(f.verts) > 3]
    if caps:
        bmesh.ops.triangulate(bm, faces=caps, quad_method="BEAUTY", ngon_method="BEAUTY")
    for f in bm.faces:  # broken faces are flat (smooth normals over the fan give radial gradients)
        f.smooth = f.material_index == 0
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = new_object(name, me)
    keep_largest(o)
    return o


def cut_open(src, seeds, i, name):
    """src cut by the same cell planes, without capping (bake source for one fragment: otherwise the rays near a
    cut edge hit the neighbouring cell's surface)."""
    bm = bmesh.new()
    bm.from_mesh(src.data)
    si = Vector(seeds[i])
    for j, sj in enumerate(seeds):
        if j != i:
            sj = Vector(sj)
            bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-6,
                                   plane_co=(si + sj) / 2, plane_no=(sj - si).normalized(), clear_outer=True)
    me = src.data.copy()
    bm.to_mesh(me)
    bm.free()
    me.name = name
    return new_object(name, me)


def fragments(args):
    setup_bake()
    t0 = time.time()
    work = os.path.join(args.work, "fragments")
    raw, hi, _, prep = prepare(args.src, args, work)
    hi_bvh = bvh_of(hi)
    rng = np.random.default_rng(args.seed)
    tet = np.array([[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]], np.float64) / math.sqrt(3)
    for _ in range(200):  # random rotation of a tetrahedron, jittered; all seeds inside the rock
        q, _r = np.linalg.qr(rng.normal(size=(3, 3)))
        seeds = tet @ q.T * 0.42 + rng.normal(scale=0.06, size=(4, 3))
        if inside_mask(hi_bvh, seeds).all():
            break
    log(f"fragments from {args.src}, seeds {np.round(seeds, 3).tolist()}")
    rock_mat = src_material("shard_rock")  # plain surface of the repaired shard (normal and AO bakes)
    cap_src = src_material("shard_cap", gray=CAP_GRAY, bump=True)
    all_info = load_info(args.info)
    for i, fid in enumerate(FRAGS):
        shard = cut_cell(hi, seeds, i, fid + "_hi")
        caps = new_object(fid + "_caps", shard.data.copy())
        mi = np.empty(len(caps.data.polygons), np.int64)
        caps.data.polygons.foreach_get("material_index", mi)
        delete_faces(caps, mi != 1)
        caps.data.materials.clear()
        caps.data.materials.append(cap_src)
        shard.data.materials.append(rock_mat)  # slot 0: outer rock surface (no clear(): it resets the indices)
        shard.data.materials.append(cap_src)   # slot 1: broken faces (bump)
        shard_npz = os.path.join(work, fid + "_hi.npz")
        save_np(shard_npz, shard)
        v = verts_np(shard.data)
        center = (v.min(0) + v.max(0)) / 2
        radius = float(np.linalg.norm(v - center, axis=1).max())
        sb = bvh_of(shard)
        info = {"kind": "frag", "source": args.src, "seed": args.seed, "lod": {}, "hiTris": tri_count(shard.data),
                "normalize": {"center": [round(float(x), 5) for x in center], "scale": round(1.0 / radius, 5),
                              "sizeInRock": round(radius, 4)}}
        raw_cell = cut_open(raw, seeds, i, fid + "_raw")
        for s in SETS:
            # base colour from the cut raw (+ broken faces); normal and AO from the closed, single-walled shard
            _, info["lod"][s] = make_lod(fid, s, shard_npz, [raw_cell, caps], sb, v[::3], args.out_dir, work,
                                         sharp=SHARD_SHARP, xf=(center, radius), shape_sources=[shard])
        norm_copy = new_object(fid + "_norm", shard.data.copy())
        set_verts(norm_copy.data, (v - center) / radius)
        info.update(collision(bvh_of(norm_copy)))
        info["seconds"] = round(time.time() - t0, 1)
        all_info[fid] = info
        save_info(args.info, all_info)
        log(f"{fid} done: size {radius:.3f} of the rock, r={info['collisionRadius']} "
            f"spheres={len(info['collisionSpheres'])}")
    log(f"fragments finished in {time.time() - t0:.0f} s")
    if args.save_work:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(args.work, "fragments.blend"), copy=True)
    return 0


# ---------------------------------------------------------------- check renders

def glb_json(path):
    with open(path, "rb") as f:
        data = f.read(1 << 20)
    clen = struct.unpack_from("<I", data, 12)[0]
    if clen + 20 > len(data):
        with open(path, "rb") as f:
            data = f.read(clen + 20)
    return json.loads(data[20:20 + clen])


def glb_facts(path):
    j = glb_json(path)
    tris, attrs = 0, set()
    for m in j["meshes"]:
        for p in m["primitives"]:
            tris += j["accessors"][p["indices"]]["count"] // 3
            attrs |= set(p["attributes"])
    mat = j["materials"][0]
    pbr = mat.get("pbrMetallicRoughness", {})
    return {"tris": tris, "attributes": sorted(attrs), "images": len(j.get("images", [])),
            "mime": sorted({i.get("mimeType", "") for i in j.get("images", [])}),
            "extensionsRequired": j.get("extensionsRequired", []),
            "maps": [k for k, ok in (("base", "baseColorTexture" in pbr), ("mr", "metallicRoughnessTexture" in pbr),
                                     ("normal", "normalTexture" in mat), ("ao", "occlusionTexture" in mat)) if ok],
            "bytes": os.path.getsize(path)}


def setup_game_scene(tile, samples):
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = samples
    sc.cycles.use_adaptive_sampling = True
    sc.cycles.use_denoising = True
    sc.cycles.max_bounces = 4
    sc.render.resolution_x = sc.render.resolution_y = tile
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGB"
    world = bpy.data.worlds.get("game") or bpy.data.worlds.new("game")
    if world.node_tree is None:  # Blender < 5
        world.use_nodes = True
    bgn = world.node_tree.nodes.get("Background")
    bgn.inputs["Color"].default_value = (0.006, 0.008, 0.018, 1.0)  # blue-black space
    bgn.inputs["Strength"].default_value = 1.0
    sc.world = world
    rig = bpy.data.objects.new("check_rig", None)
    sc.collection.objects.link(rig)
    cam = bpy.data.objects.new("check_cam", bpy.data.cameras.new("check_cam"))
    cam.data.angle = math.radians(35)
    cam.location = (0, -1.12 / math.sin(math.radians(17.5)), 0)
    cam.rotation_euler = (math.radians(90), 0, 0)
    cam.parent = rig
    sc.collection.objects.link(cam)
    sc.camera = cam
    for name, pos, energy, color in (("key", (-3, -3, 4), 2.2, (1.0, 0.95, 0.88)),
                                     ("rim", (2.5, 5, 1.5), 1.6, (0.6, 0.72, 1.0))):
        light = bpy.data.objects.new("game_" + name, bpy.data.lights.new("game_" + name, "SUN"))
        light.data.energy = energy
        light.data.color = color
        light.data.angle = math.radians(2)
        bc.aim(light, pos)
        sc.collection.objects.link(light)  # lights stay fixed; only the camera orbits
    return rig


def tint_node(objs):
    """Insert a multiply between base colour texture and BSDF; returns the tint sockets."""
    socks = []
    for o in objs:
        for mat in o.data.materials:
            nt = mat.node_tree
            bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
            src = bsdf.inputs["Base Color"].links[0].from_socket
            mul = nt.nodes.new("ShaderNodeVectorMath")
            mul.operation = "MULTIPLY"
            nt.links.new(src, mul.inputs[0])
            nt.links.new(mul.outputs["Vector"], bsdf.inputs["Base Color"])
            socks.append(mul.inputs[1])
    return socks


def check(args):
    ids = args.ids or SMALL + BIG + FRAGS
    renders = os.path.join(args.work, "check_renders")
    os.makedirs(renders, exist_ok=True)
    combos = [("front", "gray"), ("front34", "decoy"), ("back", "exploder")]
    rows, report = [], {}
    for rid in ids:
        tiles = {}
        report[rid] = {}
        for s in SETS:
            path = os.path.join(args.out_dir, s, rid + ".glb")
            clear_all()
            rig = setup_game_scene(args.tile, args.samples)
            o = import_glb(path)
            v = verts_np(o.data)
            facts = glb_facts(path)
            imgs = [i for i in bpy.data.images if i.size[0]]
            base = next((i for i in imgs if "base" in i.name), None)
            med = None
            if base is not None:
                px = np.empty(base.size[0] * base.size[1] * 4, np.float32)
                base.pixels.foreach_get(px)
                med = round(float(np.median(px.reshape(-1, 4)[:, 0])), 3)
            facts.update(radius=round(float(np.linalg.norm(v, axis=1).max()), 4),
                         bboxCenter=[round(float(x), 4) for x in (v.min(0) + v.max(0)) / 2],
                         textures=sorted({f"{i.size[0]}" for i in imgs}), baseMedian=med)
            report[rid][s] = facts
            log(f"CHECK {rid} {s}: {json.dumps(facts)}")
            socks = tint_node([o])
            for view, tint in combos:
                for sk in socks:
                    sk.default_value = hex_lin(TINTS[tint])
                az, el = bc.VIEWS[view]
                rig.rotation_euler = (math.radians(-el), 0.0, math.radians(az))
                out = os.path.join(renders, f"{rid}_{s}_{view}.png")
                bpy.context.scene.render.filepath = out
                bpy.ops.render.render(write_still=True)
                tile = bc.load_image(out)
                label = f"{'PC' if s == 'pc' else 'MOBILE'} {facts['tris']}"
                bc.draw_text(tile, 4, args.tile - 4 - 9, f"{label}  {tint}", scale=1)
                tiles[(s, view)] = tile
        order = [tiles[(s, v)] for v, _ in combos for s in SETS]
        bc.draw_text(order[0], 4, 4, rid, scale=2)
        rows.append(np.concatenate(order, axis=1))
    blocks = max(1, args.blocks)
    per = math.ceil(len(rows) / blocks)
    gap = 6
    rw, rh = rows[0].shape[1], rows[0].shape[0]
    sheet = np.ones((per * rh + (per - 1) * gap, blocks * rw + (blocks - 1) * gap, 3), np.float32) * 0.18
    for i, row in enumerate(rows):
        bi, ri = divmod(i, per)
        sheet[ri * (rh + gap):ri * (rh + gap) + rh, bi * (rw + gap):bi * (rw + gap) + rw] = row
    bc.save_jpg(sheet, args.out, quality=86)
    rep = args.report or os.path.splitext(args.out)[0] + ".json"
    with open(rep, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=1)
    log(f"SHEET {args.out} ({sheet.shape[1]}x{sheet.shape[0]}), report {rep}")
    return 0


# ---------------------------------------------------------------- final .blend

def blend(args):
    ids = args.ids or SMALL + BIG + FRAGS
    clear_all()
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)
    sc = bpy.context.scene
    for si, s in enumerate(SETS):
        coll = bpy.data.collections.new(s)
        sc.collection.children.link(coll)
        for i, rid in enumerate(ids):
            o = import_glb(os.path.join(args.out_dir, s, rid + ".glb"))
            o.name = f"{rid}_{s}"
            for c in list(o.users_collection):
                c.objects.unlink(o)
            coll.objects.link(o)
            o.location = (2.5 * (i % 8), 2.5 * (i // 8) + 6.0 * si, 0.0)
    bpy.ops.file.pack_all()
    os.makedirs(os.path.dirname(os.path.abspath(args.save)), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.save), compress=True)
    log(f"saved {args.save} ({os.path.getsize(args.save) / 2**20:.1f} MB)")
    return 0


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser(prog="blender_meteors.py")
    ap.add_argument("mode", choices=["build", "fragments", "collision", "check", "blend"])
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--raw", default=os.path.join(ROOT, "source", "meteors", "raw"))
    ap.add_argument("--out-dir", default=os.path.join(ROOT, "public", "assets", "meteors"))
    ap.add_argument("--info", default=os.path.join(ROOT, "source", "meteors", "meteors.json"))
    ap.add_argument("--work", default=os.path.join(os.path.expanduser("~"), "Documents", "HoleWork", "conto2"))
    ap.add_argument("--save-work", action="store_true", help="save a work .blend per rock")
    ap.add_argument("--src", default="rock_04", help="fragments: rock to break")
    ap.add_argument("--seed", type=int, default=1, help="fragments: cell seed")
    ap.add_argument("--out", default=os.path.join(ROOT, "docs", "checks", "conto2_meteors.jpg"))
    ap.add_argument("--report")
    ap.add_argument("--tile", type=int, default=224)
    ap.add_argument("--samples", type=int, default=24)
    ap.add_argument("--blocks", type=int, default=2)
    ap.add_argument("--save", default=os.path.join(ROOT, "source", "meteors", "meteors.blend"))
    args = ap.parse_args(argv)
    code = {"build": build, "fragments": fragments, "collision": recollide, "check": check,
            "blend": blend}[args.mode](args)
    sys.stdout.flush()
    if code:
        sys.exit(code)


if __name__ == "__main__":
    main()
