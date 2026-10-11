// Audio. Conto 3 starts it with the music: the intensity loops from the manifest, all started at the same
// moment and crossfaded by a continuous intensity (1 = calm start ... 4 = full adrenaline). The loops share
// tempo, key and bar count, so they stay in sync forever; intensity only moves their gains.
// Over a run the music climbs 1 -> 4 in one cycle (MUSIC.cycleSeconds), drops back to 1 on a bar line and
// starts the next cycle one step deeper: a semitone higher and faster, more reverb, more sub, a low drone on
// the tonal centre (MUSIC.depth). Contoo adds the synthesized sounds (whoosh, rumble, boom).
const ASSETS_URL = new URL('../assets/', import.meta.url);  // same as loader.js; kept here so this file stands alone

// iOS and Chrome start an AudioContext suspended until a tap/click/key; call this from that event.
export function unlockAudio(ctx) {
  if (ctx.state !== 'running') ctx.resume();
  const src = ctx.createBufferSource();  // a silent buffer, for older iOS
  src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
  src.connect(ctx.destination);
  src.start();
}

// 'ogg' where the browser plays Ogg Vorbis, else 'mp3' (Safari).
export function musicFormat() {
  const a = document.createElement('audio');
  return a.canPlayType('audio/ogg; codecs="vorbis"') ? 'ogg' : 'mp3';
}

// Where the music is at run time t (seconds): cycle number, depth (capped) and level 1..4 within the cycle.
export function musicPlan(t, cfg) {
  const k = Math.max(0, Math.floor(t / cfg.cycleSeconds));
  const p = (t - k * cfg.cycleSeconds) / cfg.cycleSeconds;
  return { cycle: k, depth: Math.min(k, cfg.depth?.maxDepth ?? 0), level: 1 + 3 * p ** (cfg.rampPower ?? 1) };
}

export class Music {
  // fadeSeconds: how long a gain change takes to mostly settle (time constant = fadeSeconds / 3).
  // depth: MUSIC.depth from config.js (null = no deepening).
  constructor(ctx, { fadeSeconds = 6, volume = 0.8, depth = null } = {}) {
    this.ctx = ctx;
    this.fadeSeconds = fadeSeconds;
    this.depthCfg = depth;
    this.loops = [];        // { id, level, buffer, gain, loopStart, loopEnd, rhoNext }
    this.sources = [];
    this.intensity = 1;
    this.depth = 0;
    this.rate = 1;
    this.barSeconds = 1.875;  // from the manifest (bpm, beatsPerBar)
    this.anchors = [];        // { time, pos, rate }: loop position bookkeeping across rate changes
    this.cycle = null;
    this.holdUntil = 0;
    this.playing = false;
    // loop gains -> mix -> sub shelf -> out (volume) -> limiter -> speakers; mix -> reverb -> wet -> out;
    // drone -> drone gain -> out (and a little into the reverb)
    this.mix = ctx.createGain();
    this.sub = ctx.createBiquadFilter();
    this.sub.type = 'lowshelf';
    this.sub.frequency.value = 110;
    this.sub.gain.value = 0;
    this.out = ctx.createGain();
    this.out.gain.value = volume;
    this.limiter = ctx.createDynamicsCompressor();  // gentle limiter so overlapping loops never clip
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 3;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = impulse(ctx, 3.2, 2.6);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0;
    this.mix.connect(this.sub).connect(this.out);
    this.mix.connect(this.reverb).connect(this.wet).connect(this.out);
    this.out.connect(this.limiter).connect(ctx.destination);
    this.drone = null;
  }

  // Loads every loop of the set ('pc' or 'mobile'); falls back to MP3 if the OGG fails to decode.
  async load(manifest, set, onProgress = () => {}, baseUrl = ASSETS_URL) {
    const list = [...(manifest.music ?? [])].sort((a, b) => a.level - b.level);
    if (list[0]?.bpm) this.barSeconds = (60 / list[0].bpm) * (list[0].beatsPerBar ?? 4);
    const fmt = musicFormat();
    let done = 0;
    this.loops = await Promise.all(list.map(async (m) => {
      let buffer = null;
      for (const f of fmt === 'ogg' ? ['ogg', 'mp3'] : ['mp3']) {
        try {
          const res = await fetch(new URL(m[set][f], baseUrl));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          buffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
          break;
        } catch (err) {
          console.warn(`music ${m.id} (${set} ${f}): ${err.message}`);
        }
      }
      onProgress(++done, list.length);
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.mix);
      return { id: m.id, level: m.level, buffer, gain, loopStart: m.loopStart, loopEnd: m.loopEnd,
               rhoNext: m.rhoNext ?? 0 };
    }));
    return this.loops;
  }

  // Starts all loops together, `delay` seconds from now, at the current intensity and depth.
  start(delay = 0.05) {
    if (this.playing) return;
    const when = this.ctx.currentTime + delay;
    this.anchors = [{ time: when, pos: 0, rate: this.rate }];
    this.sources = this.loops.map((l) => {
      if (!l.buffer) return null;
      const src = this.ctx.createBufferSource();
      src.buffer = l.buffer;
      src.loop = true;
      src.loopStart = l.loopStart;
      src.loopEnd = l.loopEnd;
      src.playbackRate.value = this.rate;
      src.connect(l.gain);
      src.start(when, l.loopStart);
      return src;
    });
    if (this.depthCfg) this.drone = makeDrone(this.ctx, this.depthCfg.droneHz * this.rate, this.out, this.reverb);
    this.playing = true;
    this.setIntensity(this.intensity, 0);
    this.setDepth(this.depth, when, 0);
  }

  stop(fade = 0.5) {
    if (!this.playing) return;
    const t = this.ctx.currentTime;
    for (const l of this.loops) {
      l.gain.gain.cancelScheduledValues(t);
      l.gain.gain.setTargetAtTime(0, t, fade / 3);
    }
    for (const s of this.sources) s?.stop(t + fade + 0.1);
    if (this.drone) {
      this.drone.gain.gain.cancelScheduledValues(t);
      this.drone.gain.gain.setTargetAtTime(0, t, fade / 3);
      for (const o of this.drone.oscs) o.osc.stop(t + fade + 0.1);
      this.drone.lfo.stop(t + fade + 0.1);
      this.drone = null;
    }
    this.sources = [];
    this.cycle = null;
    this.playing = false;
  }

  // Gains for a continuous intensity x in [1, n]: only the two neighbouring levels sound, with a
  // constant-power crossfade (corrected for how alike the two loops are, rhoNext from the manifest).
  gainsFor(x) {
    const n = this.loops.length;
    const g = new Array(n).fill(0);
    if (!n) return g;
    const f = Math.min(Math.max(x, 1), n) - 1;
    const i = Math.min(Math.floor(f), n - 2);
    if (i < 0) { g[0] = 1; return g; }
    const th = (f - i) * Math.PI / 2;
    const a = Math.cos(th);
    const b = Math.sin(th);
    const rho = Math.max(0, this.loops[i].rhoNext);
    const norm = Math.sqrt(a * a + b * b + 2 * rho * a * b);
    g[i] = a / norm;
    g[i + 1] = b / norm;
    return g;
  }

  // seconds: how long the move takes (default fadeSeconds); 0 jumps. `at`: when it starts.
  setIntensity(x, seconds = this.fadeSeconds, at = this.ctx.currentTime) {
    this.intensity = x;
    this.gainsFor(x).forEach((v, k) => {
      const p = this.loops[k].gain.gain;
      p.cancelScheduledValues(at);
      if (seconds <= 0) p.setValueAtTime(v, at);
      else p.setTargetAtTime(v, at, seconds / 3);
    });
  }

  // Depth d (0 = as generated): key and tempo up by semitones, more reverb, more sub, more drone. The key and
  // tempo change lands exactly at `when` (use a bar line); the rest eases in over `ease` seconds.
  setDepth(d, when = this.ctx.currentTime, ease = 4) {
    const c = this.depthCfg;
    if (!c) return;
    d = Math.max(0, Math.min(d, c.maxDepth));
    const pick = (arr) => arr[Math.min(d, arr.length - 1)];
    const rate = 2 ** (Math.min(d * c.semitonesPerCycle, c.maxSemitones) / 12);
    if (this.playing && rate !== this.anchors[this.anchors.length - 1].rate) {
      this.anchors.push({ time: when, pos: this.positionAt(when), rate });
      while (this.anchors.length > 2 && this.anchors[1].time < this.ctx.currentTime) this.anchors.shift();
    }
    for (const s of this.sources) s?.playbackRate.setValueAtTime(rate, when);
    const tc = Math.max(0.01, ease / 3);
    this.wet.gain.setTargetAtTime(pick(c.reverb), when, tc);
    this.sub.gain.setTargetAtTime(pick(c.subDb), when, tc);
    if (this.drone) {
      this.drone.gain.gain.setTargetAtTime(pick(c.drone), when, Math.max(tc, 1));
      for (const o of this.drone.oscs) o.osc.frequency.setValueAtTime(c.droneHz * o.mul * rate, when);
    }
    this.depth = d;
    this.rate = rate;
  }

  // Next bar line (in groups of `bars`) at least `ahead` seconds from now, as AudioContext time.
  nextBarTime(bars = 2, ahead = 0.3) {
    const now = this.ctx.currentTime + ahead;
    const len = this.barSeconds * bars;
    const pos = this.positionAt(now);
    const rate = this.rateAt(now);
    return now + (Math.ceil(pos / len - 1e-6) * len - pos) / rate;
  }

  // Drives the music from the run time t (seconds); call every frame. At a new cycle the music drops back to
  // level 1, fading out over `drop` seconds so the drop and the deeper key land together on a bar line.
  follow(t, cfg, drop = 1.2) {
    const plan = musicPlan(t, cfg);
    if (!this.playing) return plan;
    if (this.cycle === null) {
      this.cycle = plan.cycle;
      this.setDepth(plan.depth, this.ctx.currentTime, 0.5);
      this.setIntensity(plan.level, 0.5);
    } else if (plan.cycle !== this.cycle) {
      this.cycle = plan.cycle;
      const T = this.nextBarTime(2, drop + 0.2);
      this.setIntensity(1, drop, T - drop);
      this.setDepth(plan.depth, T);
      this.holdUntil = T + 0.5;
    } else if (this.ctx.currentTime >= this.holdUntil && Math.abs(plan.level - this.intensity) > 0.002) {
      this.setIntensity(plan.level);
    }
    return plan;
  }

  setVolume(v, seconds = 0.2) {
    this.out.gain.setTargetAtTime(v, this.ctx.currentTime, seconds / 3);
  }

  rateAt(t) {
    let a = this.anchors[0];
    for (const x of this.anchors) if (x.time <= t) a = x;
    return a?.rate ?? this.rate;
  }

  // Loop position (seconds from loopStart, in loop time) at AudioContext time t.
  positionAt(t = this.ctx.currentTime) {
    const l = this.loops[0];
    if (!this.playing || !l?.buffer || !this.anchors.length) return 0;
    let a = this.anchors[0];
    for (const x of this.anchors) if (x.time <= t) a = x;
    const len = l.loopEnd - l.loopStart;
    return (((a.pos + (t - a.time) * a.rate) % len) + len) % len;
  }

  position() {
    return this.positionAt();
  }
}

// A soft stereo reverb tail: decaying, slightly darkened noise.
function impulse(ctx, seconds, decay) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      lp += 0.3 * ((Math.random() * 2 - 1) - lp);
      d[i] = lp * (1 - i / n) ** decay;
    }
  }
  return buf;
}

// A low, slowly breathing drone on the music's tonal centre (root, octave below, fifth).
function makeDrone(ctx, hz, out, reverb) {
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 240;
  lp.Q.value = 0.8;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.06;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 110;
  lfo.connect(lfoDepth).connect(lp.frequency);
  lfo.start();
  const oscs = [[1, 'sawtooth', 0.45], [1.004, 'sawtooth', 0.35], [0.5, 'sine', 0.9], [1.5, 'triangle', 0.25]]
    .map(([mul, type, amp]) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = hz * mul;
      const g = ctx.createGain();
      g.gain.value = amp;
      osc.connect(g).connect(lp);
      osc.start();
      return { osc, mul };
    });
  lp.connect(gain);
  gain.connect(out);
  const send = ctx.createGain();
  send.gain.value = 0.5;
  gain.connect(send).connect(reverb);
  return { gain, oscs, lfo };
}
