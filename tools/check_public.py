#!/usr/bin/env python3
"""Static checks for public/ before every push (Cloudflare static hosting rules).

Checks:
  - public/index.html exists
  - at most 20,000 files, each at most 25 MiB
  - file and folder names are lowercase with no spaces
  - no Git LFS pointer files (Cloudflare would deploy the pointer, not the file)
  - no source/work formats (.blend, .py, raw audio/images) in public/
  - every local path referenced by HTML (src/href, import map), JS (relative imports)
    and assets/manifest.json exists with the exact same case
  - no absolute "/..." references (use relative paths)

Usage: python tools/check_public.py [path/to/public]
Exit code 0 = OK, 1 = errors found. Uses only the Python standard library.
"""
import json
import os
import re
import sys
from pathlib import Path

MAX_FILES = 20_000
MAX_BYTES = 25 * 1024 * 1024
LFS_SIGNATURE = b"version https://git-lfs.github.com/spec/v1"
FORBIDDEN_EXT = {".blend", ".blend1", ".blend2", ".py", ".psd", ".exr", ".wav", ".flac", ".ply", ".fbx", ".obj", ".md"}
ASSET_EXT = (".glb", ".gltf", ".bin", ".png", ".jpg", ".jpeg", ".webp", ".ktx2", ".ogg", ".mp3", ".m4a", ".json", ".spz", ".wasm", ".js")

HTML_REF = re.compile(r"""(?:src|href)\s*=\s*["']([^"']+)["']""", re.I)
IMPORTMAP = re.compile(r"""<script[^>]*type\s*=\s*["']importmap["'][^>]*>(.*?)</script>""", re.I | re.S)
JS_IMPORT = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}/[^"']+)["']""")


def exists_exact_case(path: Path, root: Path) -> bool:
    """True if path exists and every component matches on-disk case (Windows is case-insensitive)."""
    try:
        rel = path.resolve().relative_to(root.resolve())
    except ValueError:
        return False  # points outside public/
    current = root.resolve()
    for part in rel.parts:
        try:
            names = os.listdir(current)
        except OSError:
            return False
        if part not in names:
            return False
        current = current / part
    return True


def is_local_ref(ref: str) -> bool:
    return not re.match(r"^([a-z][a-z0-9+.-]*:|//|#)", ref, re.I)


def manifest_paths(node):
    if isinstance(node, dict):
        for value in node.values():
            yield from manifest_paths(value)
    elif isinstance(node, list):
        for value in node:
            yield from manifest_paths(value)
    elif isinstance(node, str) and node.lower().endswith(ASSET_EXT):
        yield node


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "public")
    errors, warnings = [], []
    if not root.is_dir():
        print(f"ERROR: {root} is not a folder")
        return 1

    files = [p for p in root.rglob("*") if p.is_file()]
    total = sum(p.stat().st_size for p in files)

    if not (root / "index.html").is_file():
        errors.append("public/index.html is missing")
    if len(files) > MAX_FILES:
        errors.append(f"{len(files)} files in public/ (max {MAX_FILES})")

    for p in root.rglob("*"):
        rel = p.relative_to(root).as_posix()
        name = p.name
        if name != name.lower() or " " in name:
            errors.append(f"name must be lowercase without spaces: {rel}")
        if not p.is_file():
            continue
        size = p.stat().st_size
        if size > MAX_BYTES:
            errors.append(f"file over 25 MiB ({size / 2**20:.1f} MiB): {rel}")
        if p.suffix.lower() in FORBIDDEN_EXT:
            errors.append(f"source/work file does not belong in public/: {rel}")
        if size < 1024:
            with open(p, "rb") as f:
                if f.read(len(LFS_SIGNATURE)) == LFS_SIGNATURE:
                    errors.append(f"Git LFS pointer file (real file missing): {rel}")

    def check_ref(ref: str, base: Path, source: str):
        ref = ref.split("#")[0].split("?")[0]
        if not ref or not is_local_ref(ref):
            return
        if ref.startswith("/"):
            errors.append(f"absolute path, use a relative one: '{ref}' in {source}")
            return
        target = (base / ref)
        if ref.endswith("/"):
            if not target.is_dir():
                errors.append(f"missing folder '{ref}' referenced in {source}")
            return
        if not exists_exact_case(target, root):
            errors.append(f"missing file (or wrong case) '{ref}' referenced in {source}")

    for page in root.rglob("*.html"):
        text = page.read_text(encoding="utf-8", errors="replace")
        src = page.relative_to(root).as_posix()
        for ref in HTML_REF.findall(text):
            check_ref(ref, page.parent, src)
        for block in IMPORTMAP.findall(text):
            try:
                imap = json.loads(block)
            except json.JSONDecodeError as e:
                errors.append(f"invalid import map JSON in {src}: {e}")
                continue
            for ref in imap.get("imports", {}).values():
                check_ref(ref, page.parent, f"{src} (import map)")

    for script in root.rglob("*.js"):
        text = script.read_text(encoding="utf-8", errors="replace")
        for ref in JS_IMPORT.findall(text):
            check_ref(ref, script.parent, script.relative_to(root).as_posix())

    manifest = root / "assets" / "manifest.json"
    if manifest.is_file():
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            errors.append(f"assets/manifest.json is not valid JSON: {e}")
        else:
            for ref in manifest_paths(data):
                check_ref(ref, manifest.parent, "assets/manifest.json")
    else:
        warnings.append("assets/manifest.json not found (fine until the first conto export)")

    print(f"public/: {len(files)} files, {total / 2**20:.2f} MiB")
    for p in sorted(files, key=lambda p: p.stat().st_size, reverse=True)[:5]:
        print(f"  {p.stat().st_size / 2**20:8.2f} MiB  {p.relative_to(root).as_posix()}")
    for w in warnings:
        print(f"WARNING: {w}")
    for e in errors:
        print(f"ERROR: {e}")
    print("OK" if not errors else f"{len(errors)} error(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
