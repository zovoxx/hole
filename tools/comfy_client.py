#!/usr/bin/env python3
"""Small ComfyUI API client for the Hole conto. Standard library only.

Loads an API-format workflow JSON (the owner's exports live in tools/workflows/), sets prompt / seed /
input image, submits it, polls /history, downloads the outputs and frees VRAM.

Nodes are found by class_type (and title where needed), not by id, so re-exported workflows keep working.

Usage:
  python tools/comfy_client.py stats
  python tools/comfy_client.py free
  python tools/comfy_client.py zimage --prompt "..." --seed 1 --out C:/work/a.png [--width 1024 --height 1024]
  python tools/comfy_client.py pixal3d --image C:/work/a.png --seed 1 --out C:/work/a.glb [--faces 200000 --tex 2048]
"""
import argparse
import copy
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

BASE = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")
TOOLS = os.path.dirname(os.path.abspath(__file__))
WORKFLOWS = {
    "zimage": os.path.join(TOOLS, "workflows", "z_image_turbo.json"),
    "pixal3d": os.path.join(TOOLS, "workflows", "pixal3d.json"),
    "acestep": os.path.join(TOOLS, "workflows", "ace_step_1_5_xl_turbo.json"),
}
CLIENT_ID = "hole-conto-" + uuid.uuid4().hex[:8]


class ComfyError(RuntimeError):
    pass


# ---------------------------------------------------------------- HTTP

def _request(path, data=None, headers=None, timeout=60):
    req = urllib.request.Request(BASE + path, data=data, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        raise ComfyError(f"HTTP {e.code} on {path}: {e.read().decode(errors='replace')[:4000]}") from None


def get_json(path, timeout=60):
    return json.loads(_request(path, timeout=timeout))


def post_json(path, obj, timeout=60):
    body = _request(path, json.dumps(obj).encode(), {"Content-Type": "application/json"}, timeout)
    return json.loads(body) if body.strip() else {}


def stats():
    return get_json("/system_stats", timeout=10)


def free(unload_models=True):
    """Unload models and free VRAM (do this between model families)."""
    post_json("/free", {"unload_models": unload_models, "free_memory": True})


def upload_image(path, subfolder="hole", overwrite=True):
    """Upload a local image to ComfyUI's input folder; returns the value for a LoadImage node."""
    boundary = "----hole" + uuid.uuid4().hex
    name = os.path.basename(path)
    ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
    with open(path, "rb") as f:
        payload = f.read()
    parts = []
    for key, value in (("subfolder", subfolder), ("type", "input"), ("overwrite", "true" if overwrite else "false")):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{name}"\r\n'
                 f"Content-Type: {ctype}\r\n\r\n".encode() + payload + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    res = json.loads(_request("/upload/image", b"".join(parts),
                              {"Content-Type": f"multipart/form-data; boundary={boundary}"}, timeout=120))
    return f"{res['subfolder']}/{res['name']}" if res.get("subfolder") else res["name"]


# ---------------------------------------------------------------- workflow editing

def load_workflow(name_or_path):
    path = WORKFLOWS.get(name_or_path, name_or_path)
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def nodes_of(wf, class_type, title=None):
    """Ids of nodes with this class_type (and _meta.title, if given), sorted by id."""
    ids = [nid for nid, n in wf.items() if n.get("class_type") == class_type
           and (title is None or n.get("_meta", {}).get("title") == title)]
    return sorted(ids, key=lambda s: [int(p) if p.isdigit() else p for p in s.split(":")])


def one_node(wf, class_type, title=None):
    ids = nodes_of(wf, class_type, title)
    if len(ids) != 1:
        raise ComfyError(f"expected one {class_type} node (title={title!r}), found {ids}")
    return wf[ids[0]]


def _is_link(v):
    return isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and isinstance(v[1], int)


def _literal(wf, v):
    """Value of a literal input, following links to Primitive* nodes; None if not constant."""
    if _is_link(v):
        n = wf.get(v[0], {})
        if n.get("class_type", "").startswith("Primitive"):
            return n["inputs"].get("value")
        return None
    return v


def resolve_switches(wf):
    """Replace every ComfySwitchNode whose switch is constant by a direct link to the chosen branch.
    Unused branches (e.g. the Trellis2 loader, whose model is not installed) then drop out in prune()."""
    changed = True
    while changed:
        changed = False
        for nid, n in list(wf.items()):
            if n.get("class_type") != "ComfySwitchNode":
                continue
            sw = _literal(wf, n["inputs"].get("switch"))
            if sw is None:
                continue
            target = n["inputs"]["on_true" if sw else "on_false"]
            for other in wf.values():
                for k, v in other["inputs"].items():
                    if _is_link(v) and v[0] == nid:
                        other["inputs"][k] = list(target) if _is_link(target) else target
            del wf[nid]
            changed = True
    return wf


def prune(wf, keep):
    """Keep only the given output nodes and everything upstream of them."""
    need, stack = set(), list(keep)
    while stack:
        nid = stack.pop()
        if nid in need:
            continue
        need.add(nid)
        for v in wf[nid]["inputs"].values():
            if _is_link(v):
                stack.append(v[0])
    for nid in list(wf):
        if nid not in need:
            del wf[nid]
    return wf


def zimage_workflow(prompt, seed, width=1024, height=1024, prefix="hole/zimage", wf=None):
    wf = copy.deepcopy(wf or load_workflow("zimage"))
    one_node(wf, "CLIPTextEncode")["inputs"]["text"] = prompt
    ks = one_node(wf, "KSampler")["inputs"]
    ks["seed"] = int(seed)
    one_node(wf, "EmptySD3LatentImage")["inputs"].update(width=int(width), height=int(height))
    one_node(wf, "SaveImage")["inputs"]["filename_prefix"] = prefix
    return wf


def pixal3d_workflow(image, seed, faces=200000, tex=2048, prefix="hole/pixal3d", wf=None):
    """image = LoadImage value (from upload_image). Uses the Pixal3D branch (the Trellis2 switch must be off)."""
    wf = copy.deepcopy(wf or load_workflow("pixal3d"))
    for nid in nodes_of(wf, "PrimitiveBoolean"):
        if "Trellis2" in wf[nid].get("_meta", {}).get("title", ""):
            wf[nid]["inputs"]["value"] = False
    resolve_switches(wf)
    save = one_node(wf, "Save3DAdvanced")
    save_id = nodes_of(wf, "Save3DAdvanced")[0]
    prune(wf, [save_id])
    one_node(wf, "LoadImage")["inputs"]["image"] = image
    for i, nid in enumerate(nodes_of(wf, "KSampler")):
        wf[nid]["inputs"]["seed"] = int(seed) + i
    one_node(wf, "DecimateMesh")["inputs"]["target_face_count"] = int(faces)
    one_node(wf, "PrimitiveInt", "Texture Resolution")["inputs"]["value"] = int(tex)
    save["inputs"]["filename_prefix"] = prefix
    return wf


# ---------------------------------------------------------------- run

def submit(wf):
    res = post_json("/prompt", {"prompt": wf, "client_id": CLIENT_ID})
    if res.get("node_errors"):
        raise ComfyError("node errors: " + json.dumps(res["node_errors"])[:4000])
    return res["prompt_id"]


def queue_state(pid):
    q = get_json("/queue")
    if any(x[1] == pid for x in q.get("queue_running", [])):
        return "running"
    if any(x[1] == pid for x in q.get("queue_pending", [])):
        return "pending"
    return "unknown"


def wait(pid, timeout=3600, poll=2.0):
    """Block until the prompt finishes; returns its /history entry. Raises ComfyError on failure."""
    t0 = time.time()
    unknown = 0
    while True:
        h = get_json("/history/" + pid)
        if pid in h:
            entry = h[pid]
            st = entry.get("status", {})
            if st.get("status_str") == "error" or not st.get("completed", True):
                msgs = [m for m in st.get("messages", []) if m[0] in ("execution_error", "execution_interrupted")]
                detail = msgs[0][1] if msgs else st
                if isinstance(detail, dict):
                    detail = {k: detail.get(k) for k in ("node_id", "node_type", "exception_type", "exception_message")}
                raise ComfyError("execution failed: " + json.dumps(detail)[:3000])
            return entry
        state = queue_state(pid)
        unknown = unknown + 1 if state == "unknown" else 0
        if unknown > 5:
            raise ComfyError(f"prompt {pid} vanished from the queue")
        if time.time() - t0 > timeout:
            raise ComfyError(f"timeout after {timeout}s waiting for {pid}")
        time.sleep(poll)


def output_files(entry):
    """All saved files of a finished prompt: list of {node, filename, subfolder, type}."""
    found = []

    def walk(node_id, v):
        if isinstance(v, dict):
            if "filename" in v and isinstance(v["filename"], str):
                found.append({"node": node_id, "filename": v["filename"],
                              "subfolder": v.get("subfolder", ""), "type": v.get("type", "output")})
            else:
                for x in v.values():
                    walk(node_id, x)
        elif isinstance(v, list):
            for x in v:
                walk(node_id, x)

    for nid, out in entry.get("outputs", {}).items():
        walk(nid, out)
    return found


def download(item, dest):
    q = urllib.parse.urlencode({"filename": item["filename"], "subfolder": item["subfolder"], "type": item["type"]})
    data = _request("/view?" + q, timeout=300)
    os.makedirs(os.path.dirname(os.path.abspath(dest)), exist_ok=True)
    tmp = dest + ".part"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, dest)
    return dest


def run(wf, dest, ext, timeout=3600):
    """Submit, wait, download the first saved output with this extension to dest. Returns (dest, seconds)."""
    t0 = time.time()
    entry = wait(submit(wf), timeout=timeout)
    files = [f for f in output_files(entry) if f["type"] == "output" and f["filename"].lower().endswith(ext)]
    if not files:
        raise ComfyError(f"no {ext} output in {output_files(entry)}")
    return download(files[0], dest), round(time.time() - t0, 1)


def is_oom(err):
    s = str(err).lower()
    return "out of memory" in s or "outofmemory" in s or "cuda error: out" in s or "allocation on device" in s


# ---------------------------------------------------------------- CLI

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("stats")
    sub.add_parser("free")
    z = sub.add_parser("zimage")
    z.add_argument("--prompt", required=True)
    z.add_argument("--seed", type=int, default=0)
    z.add_argument("--width", type=int, default=1024)
    z.add_argument("--height", type=int, default=1024)
    z.add_argument("--out", required=True)
    p = sub.add_parser("pixal3d")
    p.add_argument("--image", required=True)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--faces", type=int, default=200000)
    p.add_argument("--tex", type=int, default=2048)
    p.add_argument("--out", required=True)
    a = ap.parse_args()

    if a.cmd == "stats":
        s = stats()
        d = s["devices"][0]
        print(json.dumps({"comfyui": s["system"]["comfyui_version"], "gpu": d["name"],
                          "vram_free_gb": round(d["vram_free"] / 2**30, 2)}, indent=1))
    elif a.cmd == "free":
        free()
        print("freed")
    elif a.cmd == "zimage":
        print(run(zimage_workflow(a.prompt, a.seed, a.width, a.height), a.out, ".png"))
    elif a.cmd == "pixal3d":
        print(run(pixal3d_workflow(upload_image(a.image), a.seed, a.faces, a.tex), a.out, ".glb"))


if __name__ == "__main__":
    sys.exit(main())
