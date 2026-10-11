#!/usr/bin/env python3
"""Writes the meteor part of public/assets/manifest.json from the exported GLBs.

Reads public/assets/meteors/{pc,mobile}/<id>.glb (triangle counts, sizes, texture sizes from the GLB itself) and
source/meteors/meteors.json (collision numbers written by tools/blender_meteors.py). Other manifest sections
(textures, music) are kept as they are, so later conto phases can add theirs.

Usage: python tools/write_manifest.py [--check]
  --check  only compare: exit 1 if the manifest on disk differs from what would be written.
Uses only the Python standard library.
"""
import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "public" / "assets"
MANIFEST = ASSETS / "manifest.json"
INFO = ROOT / "source" / "meteors" / "meteors.json"
GROUPS = {"small": [f"rock_{i:02d}" for i in range(1, 9)],
          "big": [f"big_{i:02d}" for i in range(1, 4)],
          "fragments": [f"frag_{i:02d}" for i in range(1, 5)]}
SETS = ("pc", "mobile")


def read_glb(path):
    data = path.read_bytes()
    magic, _version, _length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF":
        raise ValueError(f"{path} is not a GLB")
    clen, ctype = struct.unpack_from("<II", data, 12)
    j = json.loads(data[20:20 + clen])
    bin_start = 20 + clen + 8
    tris = sum(j["accessors"][p["indices"]]["count"] // 3 for m in j["meshes"] for p in m["primitives"])
    sizes = []
    for img in j.get("images", []):
        bv = j["bufferViews"][img["bufferView"]]
        blob = data[bin_start + bv.get("byteOffset", 0): bin_start + bv.get("byteOffset", 0) + bv["byteLength"]]
        sizes.append(image_size(blob))
    pos = j["accessors"][j["meshes"][0]["primitives"][0]["attributes"]["POSITION"]]
    return {"tris": tris, "bytes": len(data), "texture": max((s[0] for s in sizes if s), default=0),
            "min": pos.get("min"), "max": pos.get("max")}


def image_size(blob):
    """Width and height of a WebP, PNG or JPEG blob."""
    if blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
        kind = blob[12:16]
        if kind == b"VP8 ":
            w, h = struct.unpack_from("<HH", blob, 26)
            return w & 0x3FFF, h & 0x3FFF
        if kind == b"VP8L":
            b = struct.unpack_from("<I", blob, 21)[0]
            return (b & 0x3FFF) + 1, ((b >> 14) & 0x3FFF) + 1
        if kind == b"VP8X":
            w = int.from_bytes(blob[24:27], "little") + 1
            h = int.from_bytes(blob[27:30], "little") + 1
            return w, h
    if blob[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack_from(">II", blob, 16)
    if blob[:2] == b"\xff\xd8":
        i = 2
        while i < len(blob):
            marker, size = blob[i + 1], struct.unpack_from(">H", blob, i + 2)[0]
            if marker in (0xC0, 0xC1, 0xC2):
                h, w = struct.unpack_from(">HH", blob, i + 5)
                return w, h
            i += 2 + size
    return None


def build():
    info = json.loads(INFO.read_text(encoding="utf-8"))
    meteors = {}
    for group, ids in GROUPS.items():
        entries = []
        for rid in ids:
            files = {s: f"meteors/{s}/{rid}.glb" for s in SETS}
            glbs = {s: read_glb(ASSETS / files[s]) for s in SETS}
            meta = info[rid]
            entry = {"id": rid, "pc": files["pc"], "mobile": files["mobile"],
                     "collisionRadius": meta["collisionRadius"],
                     "collisionSpheres": meta["collisionSpheres"],
                     "tris": {s: glbs[s]["tris"] for s in SETS},
                     "texture": {s: glbs[s]["texture"] for s in SETS},
                     "bytes": {s: glbs[s]["bytes"] for s in SETS}}
            if group == "fragments":
                entry["sizeInRock"] = meta["normalize"]["sizeInRock"]
                entry["source"] = meta["source"]
            entries.append(entry)
        meteors[group] = entries
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.is_file() else {}
    out = {"version": 1,
           "notes": "Paths are relative to this file. Meteor GLBs: glTF +Y up, centered, bounding radius 1. "
                    "collisionSpheres: [x, y, z, r] in the same units; collisionRadius: one sphere at the origin.",
           "meteors": meteors,
           "textures": manifest.get("textures", {"dust": [], "haze": [], "flash": []}),
           "music": manifest.get("music", [])}
    return out


def main():
    out = build()
    text = json.dumps(out, indent=1) + "\n"
    if "--check" in sys.argv:
        same = MANIFEST.is_file() and MANIFEST.read_text(encoding="utf-8") == text
        print("manifest up to date" if same else "manifest differs from the exported files")
        return 0 if same else 1
    MANIFEST.write_text(text, encoding="utf-8", newline="\n")
    m = out["meteors"]
    for s in SETS:
        tris = sum(e["tris"][s] for g in m.values() for e in g)
        mb = sum(e["bytes"][s] for g in m.values() for e in g) / 2**20
        print(f"{s}: {sum(len(g) for g in m.values())} meteors, {tris} tris, {mb:.2f} MiB")
    print(f"wrote {MANIFEST.relative_to(ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
