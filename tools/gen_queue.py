#!/usr/bin/env python3
"""Run a list of ComfyUI jobs one at a time, unattended, and keep a status JSON up to date.

Check progress with one read of the status file instead of polling ComfyUI.

Usage:
  python tools/gen_queue.py JOBS.json [--status STATUS.json] [--force]

JOBS.json:
  {
    "root": "C:/Users/me/Documents/HoleWork/conto1",      # relative paths below are under this (default: the JOBS.json folder)
    "jobs": [
      {"id": "rock_01_s1", "kind": "zimage", "prompt": "...", "seed": 1, "width": 1024, "height": 1024,
       "out": "concepts/rock_01_s1.png"},
      {"id": "rock_01", "kind": "pixal3d", "image": "concepts/rock_01_s1.png", "seed": 1,
       "faces": 200000, "tex": 2048, "out": "raw/rock_01.glb"},
      {"id": "music_3a", "kind": "acestep", "tags": "...", "seed": 1, "bpm": 128, "keyscale": "D minor",
       "seconds": 120, "out": "music/music_3a.flac"},
      {"id": "music_1a", "kind": "acestep", "tags": "...", "seed": 1, "init_audio": "music/music_3a.flac",
       "denoise": 0.7, "out": "music/music_1a.flac"}                 # audio-to-audio from another track
    ]
  }

Rules (from the conto lessons): one GPU job at a time; VRAM is freed whenever the model family changes;
an out-of-memory error frees VRAM and retries (up to 2 times). Jobs whose output already exists are skipped
(resume after a crash), unless --force. Each output gets a sidecar "<out>.json" with the job parameters.
"""
import argparse
import datetime
import json
import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import comfy_client as cc  # noqa: E402

RETRIES_OOM = 2


def now():
    return datetime.datetime.now().isoformat(timespec="seconds")


class Status:
    def __init__(self, path, total):
        self.path = path
        self.data = {"pid": os.getpid(), "state": "running", "started": now(), "updated": now(), "total": total,
                     "current": None, "done": [], "skipped": [], "failed": [], "log": []}
        self.write()

    def log(self, msg):
        self.data["log"] = (self.data["log"] + [f"{now()} {msg}"])[-40:]
        print(msg, flush=True)
        self.write()

    def write(self):
        self.data["updated"] = now()
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.data, f, indent=1)
        os.replace(tmp, self.path)


def build(job, root):
    kind = job["kind"]
    if kind == "zimage":
        wf = cc.zimage_workflow(job["prompt"], job.get("seed", 0), job.get("width", 1024), job.get("height", 1024),
                                prefix="hole/" + job["id"])
        return wf, ".png"
    if kind == "pixal3d":
        img = os.path.normpath(job["image"] if os.path.isabs(job["image"]) else os.path.join(root, job["image"]))
        name = cc.upload_image(img)
        wf = cc.pixal3d_workflow(name, job.get("seed", 0), job.get("faces", 200000), job.get("tex", 2048),
                                 prefix="hole/" + job["id"])
        return wf, ".glb"
    if kind == "acestep":
        init = None
        if job.get("init_audio"):
            src = job["init_audio"]
            init = cc.upload_image(os.path.normpath(src if os.path.isabs(src) else os.path.join(root, src)))
        wf = cc.acestep_workflow(job["tags"], job.get("seed", 0), job.get("bpm", 128), job.get("keyscale", "D minor"),
                                 job.get("seconds", 120), job.get("lyrics", "[Instrumental]"),
                                 steps=job.get("steps"), init_audio=init, denoise=job.get("denoise", 1.0),
                                 audio_codes=job.get("audio_codes"), prefix="hole/" + job["id"])
        return wf, ".flac"
    raise ValueError(f"unknown job kind {kind!r}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("jobs")
    ap.add_argument("--status")
    ap.add_argument("--force", action="store_true", help="redo jobs whose output already exists")
    a = ap.parse_args()

    with open(a.jobs, encoding="utf-8-sig") as f:
        spec = json.load(f)
    root = spec.get("root") or os.path.dirname(os.path.abspath(a.jobs))
    jobs = spec["jobs"]
    status = Status(a.status or os.path.splitext(a.jobs)[0] + "_status.json", len(jobs))

    last_kind = None
    for i, job in enumerate(jobs):
        out = os.path.normpath(job["out"] if os.path.isabs(job["out"]) else os.path.join(root, job["out"]))
        if os.path.exists(out) and not a.force:
            status.data["skipped"].append(job["id"])
            status.write()
            continue
        if last_kind and job["kind"] != last_kind:
            cc.free()
            status.log(f"freed VRAM ({last_kind} -> {job['kind']})")
        last_kind = job["kind"]
        status.data["current"] = {"id": job["id"], "kind": job["kind"], "index": i + 1, "started": now()}
        status.log(f"[{i + 1}/{len(jobs)}] {job['kind']} {job['id']}")
        for attempt in range(RETRIES_OOM + 1):
            try:
                wf, ext = build(job, root)
                path, secs = cc.run(wf, out, ext, timeout=job.get("timeout", 3600))
                meta = {k: v for k, v in job.items() if k != "out"}
                meta.update(out=os.path.basename(out), seconds=secs, finished=now())
                with open(out + ".json", "w", encoding="utf-8") as f:
                    json.dump(meta, f, indent=1)
                status.data["done"].append({"id": job["id"], "out": out, "seconds": secs})
                status.log(f"  done in {secs}s -> {out}")
                break
            except Exception as e:  # noqa: BLE001 - keep the queue going, record the error
                if cc.is_oom(e) and attempt < RETRIES_OOM:
                    status.log(f"  out of memory, freeing VRAM and retrying ({attempt + 1}/{RETRIES_OOM})")
                    cc.free()
                    time.sleep(5)
                    continue
                status.data["failed"].append({"id": job["id"], "error": str(e)[:2000]})
                status.log(f"  FAILED: {str(e)[:300]}")
                traceback.print_exc()
                break
        status.data["current"] = None
        status.write()

    status.data["state"] = "done"
    status.log(f"finished: {len(status.data['done'])} done, {len(status.data['skipped'])} skipped, "
               f"{len(status.data['failed'])} failed")
    return 1 if status.data["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
