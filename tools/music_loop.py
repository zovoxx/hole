#!/usr/bin/env python3
"""Music loops for Hole: beat grid analysis, bar-aligned seamless loops, OGG + MP3 export.

Runs in Blender's Python: numpy plus Blender's audio module `aud`, which reads FLAC/WAV/MP3/OGG and writes
MP3/OGG through Blender's FFmpeg (the laptop has no ffmpeg on PATH and the system Python has no numpy):

  blender -b --factory-startup -P tools/music_loop.py -- analyze A.flac [B.flac ...] --bpm 128 --bars 32 [--out R.json]
  blender -b --factory-startup -P tools/music_loop.py -- cut SPEC.json
  blender -b --factory-startup -P tools/music_loop.py -- export SPEC.json
  blender -b --factory-startup -P tools/music_loop.py -- compare BASE.flac A.flac [B.flac ...]

compare  for tracks made from BASE by audio-to-audio: beat lag, beat and harmony similarity, loudness, bass,
         highs, onset density (to choose the denoise per level).
analyze  tempo (coarse and fine), beat phase, tempo stability, downbeat, bar features, best loop window.
cut      SPEC {"bpm": 128, "bars": 32, "out_dir": "...", "loops": [{"id": "music_1", "level": 1, "in": "a.flac",
         "grid": "base.flac", "start_bar": null, "rms_db": -20}]}. Every loop that shares a "grid" file is cut at
         the same bars of that file's beat grid, so tracks made from one another (audio-to-audio) stay in sync,
         note for note. The window is chosen for the smallest seam (the bar before the start must sound like the
         last bar) and even energy. The loop is closed with a correlation-aware crossfade of its last beat into
         the audio just before its start, resampled to exactly `bars` bars at `bpm` (FFT resampling of the
         periodic loop, so the pitch moves by the same tiny ratio), set to its RMS target and soft-limited.
         Writes <out_dir>/<id>.flac (padded, see below) and <out_dir>/cut.json.
export   SPEC {"masters": "<out_dir of cut>", "public": "public/assets/music", "loops": ["music_1", ...],
         "pc_kbps": 192, "mobile_kbps": 96, "codec_ogg": "vorbis"}. Encodes pc/mobile OGG + MP3, decodes them again
         and checks length, alignment and quality, and writes <masters>/export.json for the manifest.

Every file holds the loop plus `pad` seconds of cyclic padding on both sides (the end of the loop before it, the
start after it), and the manifest gives loopStart = pad, loopEnd = pad + loop length. Any decoder offset (MP3
encoder delay that a browser does or doesn't trim) only shifts the window inside cyclic audio, so the loop
stays seamless, and all levels shift the same way, so they stay in sync.
"""
import argparse
import json
import math
import os
import sys

import numpy as np

try:
    import aud  # Blender's audio module
except ImportError:  # pragma: no cover
    aud = None

NFFT = 2048
HOP = 512
LEVEL_RMS_DB = {1: -20.0, 2: -18.5, 3: -17.0, 4: -16.0}
LIMIT_T = 0.80  # soft limiter knee (linear); peaks approach 1.0 asymptotically


# ---------------------------------------------------------------- audio IO

def load(path):
    snd = aud.Sound(path)
    rate = int(snd.specs[0])
    x = np.asarray(snd.data(), dtype=np.float32)
    if x.ndim == 1:
        x = x[:, None]
    if x.shape[1] == 1:
        x = np.repeat(x, 2, 1)
    return np.ascontiguousarray(x[:, :2]), rate


def write(path, x, sr, kind, kbps=0, codec_ogg="vorbis"):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    snd = aud.Sound.buffer(np.ascontiguousarray(x, dtype=np.float32), sr)
    if kind == "flac":
        snd.write(path, rate=sr, channels=aud.CHANNELS_STEREO, format=aud.FORMAT_S16,
                  container=aud.CONTAINER_FLAC, codec=aud.CODEC_FLAC)
    elif kind == "mp3":
        snd.write(path, rate=sr, channels=aud.CHANNELS_STEREO, format=aud.FORMAT_FLOAT32,
                  container=aud.CONTAINER_MP3, codec=aud.CODEC_MP3, bitrate=int(kbps) * 1000)
    elif kind == "ogg":
        codec = aud.CODEC_OPUS if codec_ogg == "opus" else aud.CODEC_VORBIS
        snd.write(path, rate=sr, channels=aud.CHANNELS_STEREO, format=aud.FORMAT_FLOAT32,
                  container=aud.CONTAINER_OGG, codec=codec, bitrate=int(kbps) * 1000)
    else:
        raise ValueError(kind)
    return path


# ---------------------------------------------------------------- analysis

def stft_mag(m):
    win = np.hanning(NFFT).astype(np.float32)
    nfr = 1 + max(0, (len(m) - NFFT) // HOP)
    out = np.empty((nfr, NFFT // 2 + 1), np.float32)
    for a in range(0, nfr, 512):
        b = min(nfr, a + 512)
        idx = (np.arange(a, b) * HOP)[:, None] + np.arange(NFFT)[None, :]
        out[a:b] = np.abs(np.fft.rfft(m[idx] * win, axis=1))
    return out


def moving_avg(v, n):
    if n <= 1:
        return v
    k = np.ones(n) / n
    return np.convolve(np.pad(v, (n // 2, n - 1 - n // 2), mode="edge"), k, mode="valid")


def onset_env(mag, freqs, lo=0.0, hi=1e9, fps=93.75):
    sel = (freqs >= lo) & (freqs < hi)
    L = np.log1p(1000.0 * mag[:, sel] / (mag.max() + 1e-12))
    flux = np.concatenate([[0.0], np.maximum(0.0, np.diff(L, axis=0)).sum(1)])
    flux = flux - moving_avg(flux, max(3, int(0.4 * fps)))
    return np.maximum(flux, 0.0)


def comb(env, per):
    t = np.arange(len(env))
    return np.dot(env, np.exp(-2j * np.pi * t / per))


def tempo_coarse(env, fps, lo=70, hi=180):
    e = env - env.mean()
    ac = np.correlate(e, e, mode="full")[len(e) - 1:]
    lags = np.arange(len(ac))
    ok = (lags >= fps * 60 / hi) & (lags <= fps * 60 / lo)
    lag = lags[ok][np.argmax(ac[ok])]
    return 60.0 * fps / lag


def tempo_fine(env, fps, bpm0, span=0.04, step=0.005):
    bpms = np.arange(bpm0 * (1 - span), bpm0 * (1 + span), step)
    t = np.arange(len(env))
    best = (-1, None, None)
    for chunk in np.array_split(bpms, max(1, len(bpms) // 64)):
        per = fps * 60.0 / chunk
        r = np.exp(-2j * np.pi * t[None, :] / per[:, None]) @ env
        i = int(np.argmax(np.abs(r)))
        if abs(r[i]) > best[0]:
            best = (abs(r[i]), float(chunk[i]), r[i])
    strength = best[0] / (env.sum() + 1e-12)
    return best[1], best[2], strength


def chroma(mag, freqs):
    sel = (freqs >= 55) & (freqs <= 2000)
    pc = np.round(12 * np.log2(freqs[sel] / 440.0)).astype(int) % 12
    C = np.zeros((mag.shape[0], 12), np.float32)
    for k in range(12):
        C[:, k] = (mag[:, sel][:, pc == k] ** 2).sum(1)
    return C


def band_env(mag, freqs, nb=32):
    edges = np.geomspace(40, min(16000, freqs[-1]), nb + 1)
    E = np.zeros((mag.shape[0], nb), np.float32)
    for k in range(nb):
        sel = (freqs >= edges[k]) & (freqs < edges[k + 1])
        E[:, k] = (mag[:, sel] ** 2).sum(1) if sel.any() else 0
    return E


def analyze_file(path, bpm=128.0, bars=32, beats_per_bar=4, x=None, sr=None):
    if x is None:
        x, sr = load(path)
    m = x.mean(1)
    mag = stft_mag(m)
    freqs = np.fft.rfftfreq(NFFT, 1.0 / sr)
    fps = sr / HOP
    env_all = onset_env(mag, freqs, fps=fps)
    env_low = onset_env(mag, freqs, 0, 160, fps=fps)
    env = env_all / (env_all.std() + 1e-9) + env_low / (env_low.std() + 1e-9)
    coarse = tempo_coarse(env, fps)
    fine, r, strength = tempo_fine(env, fps, bpm)
    per = fps * 60.0 / fine                              # frames per beat
    t0 = (-np.angle(r) / (2 * np.pi) * per) % per        # first beat (frames)
    # frame i measures the change into the window centred at i*HOP + NFFT/2; shift half a hop earlier
    frame_to_s = lambda f: (f * HOP + NFFT / 2 - HOP / 2) / sr  # noqa: E731
    nbeats = int((len(env) - t0) // per)
    beats_f = t0 + per * np.arange(nbeats)

    # tempo stability: local phase in windows of 32 beats against the global grid
    drift = []
    for j in range(0, nbeats - 32, 16):
        a, b = int(beats_f[j]), int(beats_f[j + 32])
        seg = env[a:b]
        rr = np.dot(seg, np.exp(-2j * np.pi * (np.arange(a, b) - t0) / per))
        drift.append(float(-np.angle(rr) / (2 * np.pi) * per / fps * 1000.0))
    drift = np.array(drift) if drift else np.zeros(1)

    # downbeat: strongest low-band onsets and the biggest harmonic change on beat 1
    C = chroma(mag, freqs)
    Cn = C / (C.sum(1, keepdims=True) + 1e-12)
    low_at, chg_at = [], []
    for j in range(nbeats):
        f = int(round(beats_f[j]))
        low_at.append(env_low[max(0, f - 2): f + 3].max() if f < len(env_low) else 0)
        a0, a1 = int(beats_f[j - 1]) if j else 0, f
        b1 = int(beats_f[j + 1]) if j + 1 < nbeats else len(Cn)
        if j == 0 or b1 <= f or a1 <= a0:
            chg_at.append(0.0)
        else:
            chg_at.append(float(np.abs(Cn[a0:a1].mean(0) - Cn[f:b1].mean(0)).sum()))
    low_at, chg_at = np.array(low_at), np.array(chg_at)
    z = lambda v: (v - v.mean()) / (v.std() + 1e-9)  # noqa: E731
    score = z(low_at) + z(chg_at)
    phase_scores = [float(score[r_::beats_per_bar].mean()) for r_ in range(beats_per_bar)]
    db_phase = int(np.argmax(phase_scores))
    srt = sorted(phase_scores)
    db_conf = float(srt[-1] - srt[-2])

    # bars
    bar_beats = list(range(db_phase, nbeats - beats_per_bar + 1, beats_per_bar))
    E = band_env(mag, freqs)
    logE = np.log10(E + 1e-10)
    bar_start_s, bar_rms, bar_env, bar_chroma, bar_low, bar_high, bar_onset = [], [], [], [], [], [], []
    for j in bar_beats:
        fa, fb = int(round(beats_f[j])), int(round(beats_f[j + beats_per_bar])) if j + beats_per_bar < nbeats \
            else int(round(beats_f[j] + per * beats_per_bar))
        fb = min(fb, len(env))
        sa, sb = int(frame_to_s(fa) * sr), int(frame_to_s(fb) * sr)
        seg = x[max(0, sa):sb]
        bar_start_s.append(frame_to_s(beats_f[j]))
        bar_rms.append(float(20 * np.log10(np.sqrt((seg ** 2).mean()) + 1e-9)))
        bar_env.append(logE[fa:fb].mean(0))
        cc = C[fa:fb].mean(0)
        bar_chroma.append(cc / (np.linalg.norm(cc) + 1e-12))
        bar_low.append(float(10 * np.log10(E[fa:fb, :6].sum(1).mean() + 1e-12)))
        bar_high.append(float(10 * np.log10(E[fa:fb, 22:].sum(1).mean() + 1e-12)))
        bar_onset.append(float(env_all[fa:fb].mean()))
    return {
        "path": path, "sr": sr, "seconds": round(len(x) / sr, 3),
        "bpm_target": bpm, "bpm_coarse": round(coarse, 2), "bpm": round(fine, 4), "beat_strength": round(strength, 4),
        "first_beat_s": round(frame_to_s(t0), 4), "beat_s": 60.0 / fine,
        "drift_ms": [round(float(drift.min()), 1), round(float(drift.max()), 1)],
        "downbeat_phase": db_phase, "downbeat_scores": [round(s, 3) for s in phase_scores],
        "downbeat_conf": round(db_conf, 3),
        "bars": len(bar_beats), "bar_start_s": [round(s, 4) for s in bar_start_s],
        "bar_rms_db": [round(v, 2) for v in bar_rms], "bar_low_db": [round(v, 2) for v in bar_low],
        "bar_high_db": [round(v, 2) for v in bar_high], "bar_onset": [round(v, 4) for v in bar_onset],
        "_bar_env": np.array(bar_env), "_bar_chroma": np.array(bar_chroma),
    }


def window_costs(infos, nbars, edge_s=6.0):
    """Cost per start bar k of an nbars window, summed over tracks cut on the same grid (same bar count)."""
    nb = min(i["bars"] for i in infos)
    secs = min(i["seconds"] for i in infos)
    starts = infos[0]["bar_start_s"]
    costs = {}
    for k in range(1, nb - nbars):
        if starts[k] < edge_s or starts[k + nbars] > secs - edge_s:
            continue
        c = 0.0
        for i in infos:
            env, chrm, rms = i["_bar_env"], i["_bar_chroma"], np.array(i["bar_rms_db"])
            seam = np.abs(env[k + nbars - 1] - env[k - 1]).mean() + np.abs(env[k + nbars] - env[k]).mean()
            seam += 2.0 * (2 - float(chrm[k + nbars - 1] @ chrm[k - 1]) - float(chrm[k + nbars] @ chrm[k]))
            w = rms[k:k + nbars]
            c += 4.0 * seam + 0.15 * w.std() + 0.25 * max(0.0, np.median(w) - w.min() - 4.0)
        costs[k] = round(c, 4)
    return costs


# ---------------------------------------------------------------- loop making

def refine_end(x, sr, s, n0, beat_s, max_ms=60.0, step_ms=0.5):
    """Loop length near n0 whose end lines up with the start: the transient envelope (drums) around the end
    must match the one around the start best. Returns (n, offset from n0 in ms, correlation)."""
    m = x.mean(1).astype(np.float64)
    d = np.abs(np.diff(m, prepend=m[0]))
    k = max(1, int(0.002 * sr))
    env = np.convolve(d, np.ones(k) / k, mode="same")
    w = int(round(beat_s * sr))
    ref = env[s - w:s + w]
    ref = (ref - ref.mean()) / (np.linalg.norm(ref - ref.mean()) + 1e-12)
    span, step = int(max_ms / 1000 * sr), max(1, int(step_ms / 1000 * sr))
    best = (-2.0, n0)
    for n in range(n0 - span, n0 + span + 1, step):
        if s + n + w > len(env):
            break
        seg = env[s + n - w:s + n + w]
        c = float(np.dot(seg - seg.mean(), ref)) / (np.linalg.norm(seg - seg.mean()) + 1e-12)
        if c > best[0]:
            best = (c, n)
    return best[1], (best[1] - n0) * 1000.0 / sr, best[0]


def close_loop(x, s, n, f):
    """Loop of n samples starting at s; its last f samples crossfade into the f samples before s."""
    seg = x[s:s + n].astype(np.float64).copy()
    a_ = seg[n - f:]
    b_ = x[s - f:s].astype(np.float64)
    rho = float((a_ * b_).sum() / (np.sqrt((a_ ** 2).sum() * (b_ ** 2).sum()) + 1e-12))
    t = (np.arange(f) + 0.5) / f
    ga, gb = np.cos(t * np.pi / 2), np.sin(t * np.pi / 2)   # equal power for uncorrelated audio
    if rho > 0:                                             # move toward equal gain when they are correlated
        la, lb = 1 - t, t
        ga, gb = (1 - rho) * ga + rho * la, (1 - rho) * gb + rho * lb
    norm = np.sqrt(ga ** 2 + gb ** 2 + 2 * max(rho, 0) * ga * gb)
    seg[n - f:] = (ga[:, None] * a_ + gb[:, None] * b_) / norm[:, None]
    return seg, rho


def resample_periodic(x, n_out):
    n_in = x.shape[0]
    if n_in == n_out:
        return x
    X = np.fft.rfft(x, axis=0)
    m = n_out // 2 + 1
    Y = np.zeros((m, x.shape[1]), dtype=complex)
    k = min(m, X.shape[0])
    Y[:k] = X[:k]
    return np.fft.irfft(Y, n=n_out, axis=0) * (n_out / n_in)


def soft_limit(x, t=LIMIT_T):
    a = np.abs(x)
    over = a > t
    y = x.copy()
    y[over] = np.sign(x[over]) * (t + (1 - t) * np.tanh((a[over] - t) / (1 - t)))
    return y


def rms_db(x):
    return float(20 * np.log10(np.sqrt((x ** 2).mean()) + 1e-12))


def pad_cyclic(loop, pad):
    return np.concatenate([loop[-pad:], loop, loop[:pad]], 0)


def cmd_cut(spec_path):
    with open(spec_path, encoding="utf-8-sig") as f:
        spec = json.load(f)
    base_dir = os.path.dirname(os.path.abspath(spec_path))
    absp = lambda p: p if os.path.isabs(p) else os.path.normpath(os.path.join(base_dir, p))  # noqa: E731
    bpm, nbars, bpb = float(spec.get("bpm", 128)), int(spec.get("bars", 32)), int(spec.get("beats_per_bar", 4))
    pad_s, fade_beats = float(spec.get("pad", 0.25)), float(spec.get("fade_beats", 1.0))
    out_dir = absp(spec["out_dir"])
    os.makedirs(out_dir, exist_ok=True)
    loops = spec["loops"]
    audio, grids = {}, {}
    for L in loops:
        for p in (absp(L["in"]), absp(L.get("grid") or L["in"])):
            if p not in audio:
                audio[p] = load(p)
    # one analysis per grid file; the window is chosen over every track on that grid
    groups = {}
    for L in loops:
        groups.setdefault(absp(L.get("grid") or L["in"]), []).append(L)
    result = {"bpm": bpm, "bars": nbars, "beats_per_bar": bpb, "loops": []}
    for gpath, members in groups.items():
        gx, gsr = audio[gpath]
        ginfo = analyze_file(gpath, bpm, nbars, bpb, gx, gsr)
        grids[gpath] = ginfo
        infos = [ginfo]
        for L in members:
            p = absp(L["in"])
            if p != gpath:
                x, sr = audio[p]
                infos.append(bar_features_on_grid(x, sr, ginfo))  # this track measured at the grid's bars
        fixed = [L.get("start_bar") for L in members if L.get("start_bar") is not None]
        costs = window_costs(infos, nbars)
        if not costs and not fixed:
            raise SystemExit(f"no {nbars}-bar window fits in {gpath} ({ginfo['bars']} bars)")
        k = int(fixed[0]) if fixed else min(costs, key=costs.get)
        beat_s = ginfo["beat_s"]
        start_s = ginfo["bar_start_s"][k]
        s = int(round(start_s * gsr))
        # generations drift by tens of ms from one steady grid: put the end where the drums line up with the start
        n, end_off, end_corr = refine_end(gx, gsr, s, int(round(nbars * bpb * beat_s * gsr)), beat_s)
        print(f"window bars {k}..{k + nbars}: end moved {end_off:+.1f} ms from the grid (transient match {end_corr:.2f})")
        cut_loops = {}
        for L in members:
            x, sr = audio[absp(L["in"])]
            if sr != gsr:
                raise SystemExit("all tracks on one grid must share the sample rate")
            f = int(round(fade_beats * beat_s * sr))
            if s - f < 0 or s + n > len(x):
                raise SystemExit(f"window outside {L['in']}")
            loop, rho = close_loop(x, s, n, f)
            n_out = int(round(nbars * bpb * 60.0 / bpm * sr))
            loop = resample_periodic(loop, n_out)
            level = int(L.get("level", 0))
            target = float(L.get("rms_db", LEVEL_RMS_DB.get(level, -18.0)))
            gain_db = target - rms_db(loop)
            loop = soft_limit(loop * 10 ** (gain_db / 20))
            cut_loops[L["id"]] = (level, loop.astype(np.float32))
            pad = int(round(pad_s * sr))
            out = os.path.join(out_dir, L["id"] + ".flac")
            write(out, pad_cyclic(loop, pad), sr, "flac")
            result["loops"].append({
                "id": L["id"], "level": level, "in": absp(L["in"]), "grid": gpath, "file": out, "sr": sr,
                "start_bar": k, "start_s": round(start_s, 4), "end_s": round((s + n) / sr, 4),
                "end_offset_ms": round(end_off, 1), "end_match": round(end_corr, 3), "source_bpm": ginfo["bpm"],
                "stretch": round(n_out / n, 6), "cents": round(-1200 * math.log2(n_out / n), 2),
                "crossfade_rho": round(rho, 3), "gain_db": round(gain_db, 2), "rms_db": round(rms_db(loop), 2),
                "peak": round(float(np.abs(loop).max()), 3),
                "loopStart": round(pad / sr, 6), "loopEnd": round((pad + n_out) / sr, 6),
                "window_cost": costs.get(k), "best_costs": sorted(costs.items(), key=lambda kv: kv[1])[:5],
            })
            print(f"{L['id']}: bars {k}..{k + nbars} of {os.path.basename(gpath)} at {start_s:.2f}s, "
                  f"src {ginfo['bpm']:.3f} BPM, {result['loops'][-1]['cents']} cents, rho {rho:.2f}, "
                  f"gain {gain_db:+.1f} dB, peak {result['loops'][-1]['peak']}")
        # how alike each level is to the next one on this grid (the game's crossfade keeps the power constant)
        order = sorted(cut_loops.items(), key=lambda kv: kv[1][0])
        for (ia, (la, xa)), (ib, (lb, xb)) in zip(order[:-1], order[1:]):
            rho = float((xa * xb).sum() / (np.sqrt((xa ** 2).sum() * (xb ** 2).sum()) + 1e-12))
            next(e for e in result["loops"] if e["id"] == ia)["rhoNext"] = round(max(0.0, rho), 3)
    result["grids"] = {p: strip(i) for p, i in grids.items()}
    with open(os.path.join(out_dir, "cut.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, indent=1)
    return result


def bar_features_on_grid(x, sr, ginfo):
    """Bar features of a track measured at another track's bar times (same length tracks)."""
    m = x.mean(1)
    mag = stft_mag(m)
    freqs = np.fft.rfftfreq(NFFT, 1.0 / sr)
    E = band_env(mag, freqs)
    logE = np.log10(E + 1e-10)
    C = chroma(mag, freqs)
    starts = ginfo["bar_start_s"] + [ginfo["bar_start_s"][-1] + 4 * ginfo["beat_s"]]
    env, chrm, rms = [], [], []
    for a, b in zip(starts[:-1], starts[1:]):
        fa, fb = int(a * sr / HOP), max(int(a * sr / HOP) + 1, int(b * sr / HOP))
        env.append(logE[fa:fb].mean(0))
        cc = C[fa:fb].mean(0)
        chrm.append(cc / (np.linalg.norm(cc) + 1e-12))
        seg = x[int(a * sr):int(b * sr)]
        rms.append(rms_db(seg) if len(seg) else -120.0)
    return {"bars": len(env), "seconds": len(x) / sr, "bar_start_s": ginfo["bar_start_s"],
            "_bar_env": np.array(env), "_bar_chroma": np.array(chrm), "bar_rms_db": rms}


def strip(info):
    return {k: v for k, v in info.items() if not k.startswith("_")}


def compare(base_path, paths, bpm=128.0):
    """How tracks made from a base track relate to it, measured on the base's bars: beat lag, harmony
    (per-bar chroma cosine), loudness, bass, highs and onset density. Used to choose audio-to-audio settings."""
    bx, sr = load(base_path)
    g = analyze_file(base_path, bpm, x=bx, sr=sr)
    freqs = np.fft.rfftfreq(NFFT, 1.0 / sr)
    fps = sr / HOP

    def env_of(x):
        mag = stft_mag(x.mean(1))
        return mag, onset_env(mag, freqs, fps=fps)

    def drums(mag):  # mean onset strength in the kick band and the hi-hat band
        return (float(onset_env(mag, freqs, 0, 160, fps).mean()), float(onset_env(mag, freqs, 5000, 1e9, fps).mean()))

    _, benv = env_of(bx)
    rows = []
    for p in [base_path] + list(paths):
        x, xsr = load(p)
        mag, env = env_of(x)
        n = min(len(env), len(benv))
        a, b = env[:n] - env[:n].mean(), benv[:n] - benv[:n].mean()
        lags = range(-12, 13)
        cc = [float(np.dot(a[max(0, l):n + min(0, l)], b[max(0, -l):n - max(0, l)])) for l in lags]
        lag_ms = (list(lags)[int(np.argmax(cc))]) * 1000.0 / fps
        beat_corr = max(cc) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12)
        f = bar_features_on_grid(x, xsr, g)
        chroma_sim = float(np.mean([u @ v for u, v in zip(f["_bar_chroma"], g["_bar_chroma"])]))
        E = band_env(mag, freqs)
        kick, hats = drums(mag)
        rows.append({
            "kick": round(kick, 3), "hats": round(hats, 3),
            "file": os.path.basename(p), "seconds": round(len(x) / xsr, 2), "lag_ms": round(lag_ms, 1),
            "beat_corr": round(float(beat_corr), 3), "chroma_sim": round(chroma_sim, 3),
            "rms_db": round(rms_db(x), 1), "low_db": round(float(10 * np.log10(E[:, :6].sum(1).mean() + 1e-12)), 1),
            "high_db": round(float(10 * np.log10(E[:, 22:].sum(1).mean() + 1e-12)), 1),
            "onset": round(float(env.mean()), 4), "bar_rms": [round(v) for v in f["bar_rms_db"]],
        })
    return rows


# ---------------------------------------------------------------- export

def align_offset(dec, ref, search=6000, win=48000):
    """Lag (samples) of dec against ref, from cross-correlating the start of the mono signals."""
    a = dec.mean(1)[: win + 2 * search]
    b = ref.mean(1)[search: search + win]
    best, lag = -1e9, 0
    for d in range(0, 2 * search + 1, 1):
        v = float(np.dot(a[d:d + win], b))
        if v > best:
            best, lag = v, d - search
    return lag


def cmd_export(spec_path):
    with open(spec_path, encoding="utf-8-sig") as f:
        spec = json.load(f)
    base_dir = os.path.dirname(os.path.abspath(spec_path))
    absp = lambda p: p if os.path.isabs(p) else os.path.normpath(os.path.join(base_dir, p))  # noqa: E731
    masters = absp(spec["masters"])
    public = absp(spec["public"])
    with open(os.path.join(masters, "cut.json"), encoding="utf-8") as f:
        cut = json.load(f)
    by_id = {L["id"]: L for L in cut["loops"]}
    rename = spec.get("rename", {})
    rates = {"pc": int(spec.get("pc_kbps", 192)), "mobile": int(spec.get("mobile_kbps", 96))}
    codec_ogg = spec.get("codec_ogg", "vorbis")
    out = {"bpm": cut["bpm"], "bars": cut["bars"], "beats_per_bar": cut["beats_per_bar"], "loops": []}
    for lid in spec["loops"]:
        L = by_id[lid]
        name = rename.get(lid, lid)
        x, sr = load(L["file"])
        entry = {"id": name, "level": L["level"], "from": lid, "loopStart": L["loopStart"], "loopEnd": L["loopEnd"],
                 "rhoNext": L.get("rhoNext", 0.0), "seconds": round(len(x) / sr, 6), "sr": sr, "files": {}}
        for plat, kbps in rates.items():
            for kind in ("ogg", "mp3"):
                rel = f"{plat}/{name}.{kind}"
                path = os.path.join(public, plat, f"{name}.{kind}")
                write(path, x, sr, kind, kbps, codec_ogg)
                dec, dsr = load(path)
                lag = align_offset(dec, x) if dsr == sr else None
                n = min(len(dec), len(x)) - abs(lag or 0) - 1
                if lag is not None and lag >= 0:
                    d, r = dec[lag:lag + n], x[:n]
                else:
                    d, r = dec[:n], x[-(lag or 0):-(lag or 0) + n]
                snr = 10 * np.log10((r ** 2).sum() / (((d - r) ** 2).sum() + 1e-12)) if dsr == sr else None
                entry["files"][rel] = {"bytes": os.path.getsize(path), "kbps": round(os.path.getsize(path) * 8 / 1000 /
                                       (len(x) / sr), 1), "decoded_samples": len(dec), "decoded_sr": dsr,
                                       "lag": lag, "snr_db": None if snr is None else round(float(snr), 1)}
                print(f"{rel}: {entry['files'][rel]}")
        out["loops"].append(entry)
    with open(os.path.join(masters, "export.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    return out


# ---------------------------------------------------------------- CLI

def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a1 = sub.add_parser("analyze")
    a1.add_argument("files", nargs="+")
    a1.add_argument("--bpm", type=float, default=128)
    a1.add_argument("--bars", type=int, default=32)
    a1.add_argument("--out")
    a2 = sub.add_parser("cut")
    a2.add_argument("spec")
    a3 = sub.add_parser("export")
    a3.add_argument("spec")
    a4 = sub.add_parser("compare")
    a4.add_argument("base")
    a4.add_argument("files", nargs="+")
    a4.add_argument("--bpm", type=float, default=128)
    a4.add_argument("--out")
    a = ap.parse_args(argv)
    if a.cmd == "compare":
        rows = compare(a.base, a.files, a.bpm)
        for r in rows:
            print(json.dumps({k: v for k, v in r.items() if k != "bar_rms"}))
            print("  bar rms:", " ".join(str(v) for v in r["bar_rms"]))
        if a.out:
            with open(a.out, "w", encoding="utf-8") as f:
                json.dump(rows, f, indent=1)
        return
    if a.cmd == "analyze":
        res = []
        for p in a.files:
            info = analyze_file(p, a.bpm, a.bars)
            costs = window_costs([info], a.bars)
            best = sorted(costs.items(), key=lambda kv: kv[1])[:5]
            info = strip(info)
            info["best_windows"] = best
            res.append(info)
            print(json.dumps({k: info[k] for k in ("path", "seconds", "bpm_coarse", "bpm", "beat_strength",
                                                   "first_beat_s", "drift_ms", "downbeat_phase", "downbeat_conf",
                                                   "bars", "best_windows")}))
            print("  bar rms:", " ".join(f"{v:.0f}" for v in info["bar_rms_db"]))
        if a.out:
            with open(a.out, "w", encoding="utf-8") as f:
                json.dump(res, f, indent=1)
    elif a.cmd == "cut":
        cmd_cut(a.spec)
    elif a.cmd == "export":
        cmd_export(a.spec)


if __name__ == "__main__":
    main(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:])
