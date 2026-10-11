"""Mesh repair and decimation for the Hole conto, outside Blender (numpy, scipy, scikit-image, pymeshlab).

Called by tools/blender_meteors.py through a venv Python (see TOOLS_PY there). Meshes are .npz files with
"v" (n x 3 float) and "f" (m x 3 int).

solid     Pixal3D meshes are thin double-walled shells (UDF remesh) with holes, so Blender's voxel remesh often
          keeps both walls. Instead: mark the voxels the surface passes through, flood-fill the outside from the
          grid border, everything else is solid; smooth signed distance -> marching cubes -> largest part.
          The level is corrected once so the result lies on the outer wall (report: distance to the raw surface).
decimate  pymeshlab quadric edge collapse to an exact triangle count (topology and normals preserved).

  python tools/mesh_tool.py solid IN.npz OUT.npz [--voxel 0.008] [--max-tris 250000]
  python tools/mesh_tool.py decimate IN.npz OUT.npz --tris 2500
Prints one JSON line (starting with RESULT) with the numbers.
"""
import argparse
import json
import sys
import time

import numpy as np
import pymeshlab
from scipy import ndimage
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree
from skimage.measure import marching_cubes


def load(path):
    d = np.load(path)
    return d["v"].astype(np.float64), d["f"].astype(np.int64)


def save(path, v, f):
    np.savez(path, v=np.asarray(v, np.float32), f=np.asarray(f, np.int32))


def surface_samples(v, f, spacing, rng):
    """Random points on the triangles, about one per spacing^2 of area (at least one per triangle)."""
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    k = np.maximum(1, np.ceil(area / spacing ** 2)).astype(np.int64)
    idx = np.repeat(np.arange(len(f)), k)
    r1, r2 = rng.random(len(idx)), rng.random(len(idx))
    s = np.sqrt(r1)
    w0, w1, w2 = 1 - s, s * (1 - r2), s * r2
    pts = a[idx] * w0[:, None] + b[idx] * w1[:, None] + c[idx] * w2[:, None]
    return np.concatenate([pts, v]), float(area.sum())


def largest_part(v, f):
    n = len(v)
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    g = coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n))
    ncomp, lab = connected_components(g, directed=False)
    flab = lab[f[:, 0]]
    keep = flab == np.bincount(flab).argmax()
    f = f[keep]
    used = np.unique(f)
    remap = -np.ones(n, np.int64)
    remap[used] = np.arange(len(used))
    return v[used], remap[f], int(ncomp)


def signed_volume(v, f):
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)


def decimate_mesh(v, f, tris):
    ms = pymeshlab.MeshSet()
    ms.add_mesh(pymeshlab.Mesh(vertex_matrix=v, face_matrix=f.astype(np.int32)))
    ms.meshing_decimation_quadric_edge_collapse(targetfacenum=int(tris), qualitythr=0.5, preserveboundary=True,
                                                preservenormal=True, preservetopology=True, optimalplacement=True,
                                                planarquadric=True, autoclean=True)
    m = ms.current_mesh()
    return m.vertex_matrix(), m.face_matrix().astype(np.int64)


def solid(args):
    t0 = time.time()
    v, f = load(args.inp)
    vox = args.voxel
    rng = np.random.default_rng(0)
    pts, area = surface_samples(v, f, vox * 0.4, rng)
    lo = v.min(0) - 6 * vox
    shape = tuple(np.ceil((v.max(0) + 6 * vox - lo) / vox).astype(int) + 1)
    ijk = np.floor((pts - lo) / vox).astype(np.int64)
    mask = np.zeros(shape, bool)
    mask[ijk[:, 0], ijk[:, 1], ijk[:, 2]] = True
    mask = ndimage.binary_dilation(mask, structure=ndimage.generate_binary_structure(3, 1))
    dist_mask = ndimage.distance_transform_edt(~mask)

    def closed_solid(k):
        """Morphological closing with radius k voxels: holes in the shell narrower than ~2k can't let the
        outside flood in. Returns the solid (everything the flood fill from the grid border can't reach)."""
        lab, _ = ndimage.label(dist_mask > k)  # free space, 6-connected
        border = np.unique(np.concatenate([lab[0].ravel(), lab[-1].ravel(), lab[:, 0].ravel(), lab[:, -1].ravel(),
                                           lab[:, :, 0].ravel(), lab[:, :, -1].ravel()]))
        outside = np.isin(lab, border[border > 0])
        return ndimage.distance_transform_edt(~outside) > k  # grow the outside back by k

    # pad so the closing never touches the grid border
    pad = max(args.close) + 2
    mask = np.pad(mask, pad)
    dist_mask = np.pad(dist_mask, pad, constant_values=pad + 10)
    lo = lo - pad * vox
    shape = mask.shape
    shares = {}
    full = closed_solid(max(args.close))
    full_share = float(full.mean())
    for k in sorted(args.close):  # smallest closing radius that seals the shell
        solid_mask = full if k == max(args.close) else closed_solid(k)
        shares[k] = round(float(solid_mask.mean()), 4)
        if shares[k] >= 0.93 * full_share:
            break
    close_k = k
    sdf = np.where(solid_mask, -(ndimage.distance_transform_edt(solid_mask) - 0.5),
                   ndimage.distance_transform_edt(~solid_mask) - 0.5)
    sdf = ndimage.gaussian_filter(sdf.astype(np.float32), sigma=args.sigma)
    tree = cKDTree(pts)
    best = None
    for level in (-1.0, -1.5, -2.0, -2.5, -3.0):  # the dilation pushed the boundary out: pick the level on the raw wall
        mv, mf, _n, _v = marching_cubes(sdf, level=level)
        mv = (mv + 0.5) * vox + lo  # sample i sits at the centre of voxel i
        med = float(np.median(tree.query(mv[:: max(1, len(mv) // 50000)])[0]))
        if best is None or med < best[0]:
            best = (med, level, mv, mf)
    _, level, mv, mf = best
    mv, mf, parts = largest_part(mv, mf.astype(np.int64))
    if signed_volume(mv, mf) < 0:
        mf = mf[:, ::-1]
    tris_mc = len(mf)
    if len(mf) > args.max_tris:
        mv, mf = decimate_mesh(mv, mf, args.max_tris)
    d = tree.query(mv)[0]
    save(args.out, mv, mf)
    return {"tris": int(len(mf)), "trisMC": int(tris_mc), "parts": parts, "grid": [int(x) for x in shape],
            "solidShare": round(float(solid_mask.mean()), 4), "closeVoxels": close_k,
            "sharesByClose": {str(k): s for k, s in shares.items()}, "rawArea": round(area, 3), "level": round(level, 3),
            "distToRawMean": round(float(d.mean()), 5), "distToRawP99": round(float(np.percentile(d, 99)), 5),
            "seconds": round(time.time() - t0, 1)}


def decimate(args):
    t0 = time.time()
    v, f = load(args.inp)
    dv, df = decimate_mesh(v, f, args.tris)
    save(args.out, dv, df)
    return {"tris": int(len(df)), "verts": int(len(dv)), "seconds": round(time.time() - t0, 1)}


def main():
    ap = argparse.ArgumentParser(prog="mesh_tool.py")
    ap.add_argument("mode", choices=["solid", "decimate"])
    ap.add_argument("inp")
    ap.add_argument("out")
    ap.add_argument("--voxel", type=float, default=0.008)
    ap.add_argument("--sigma", type=float, default=0.8, help="solid: smoothing of the signed distance, voxels")
    ap.add_argument("--close", type=int, nargs="+", default=[1, 2, 3, 5, 8, 12],
                    help="solid: closing radii (voxels) to try, smallest that seals wins")
    ap.add_argument("--max-tris", type=int, default=250000)
    ap.add_argument("--tris", type=int, default=2500)
    args = ap.parse_args()
    res = (solid if args.mode == "solid" else decimate)(args)
    print("RESULT " + json.dumps(res), flush=True)


if __name__ == "__main__":
    sys.exit(main())
