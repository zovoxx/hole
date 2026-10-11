// Audio. Conto 3 starts it with the music: the intensity loops from the manifest, all started at the same
// moment and crossfaded by a continuous intensity (1 = calm start ... 4 = full adrenaline). The loops share
// tempo, key and bar count, so they stay in sync forever; intensity only moves their gains.
// Over a run the music climbs 1 -> 4 in one cycle (MUSIC.cycleSeconds). In the cycle's last descentSeconds it
// sinks smoothly back to 1: the levels crossfade down, a low-pass filter closes and opens again and the reverb
// swells, while the next depth eases in (more reverb, more sub, a low drone on the tonal centre). Nothing ever
// switches at once. Contoo adds the synthesized sounds (whoosh, rumble, boom).
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

// Where the music is at run time t (seconds): cycle, level 1..4, filter dip 0..1 and depth (fractional, capped).
export function musicPlan(t, cfg) {
  const T = cfg.cycleSeconds;
  const D = Math.min(cfg.descentSeconds ?? 0, T / 2);
  const k = Math.max(0, Math.floor(t / T));
  const u = t - k * T;
  let level;
  let dip = 0;
  let depth = k;
  if (u < T - D) {
    level = 1 + 3 * (u / (T - D)) ** (cfg.rampPower ?? 1);
  } else {
    const q = (u - (T - D)) / D;
    const e = 0.5 - 0.5 * Math.cos(Math.PI * q);  // smooth 0 -> 1
    level = 4 - 3 * e;
    dip = Math.sin(Math.PI * q);
    depth = k + e;
  }
  return { cycle: k, level, dip, depth: Math.min(depth, cfg.depth?.maxDepth ?? 0), descending: dip > 0 };
}

export class Music {
  // fadeSeconds: how long a gain change takes to mostly settle (time constant = fadeSeconds / 3).
  // depth: MUSIC.depth from config.js (null = no deepening); dipHz: lowest filter cutoff in a descent.
  constructor(ctx, { fadeSeconds = 6, volume = 0.8, depth = null, dipHz = 700 } = {}) {
    this.ctx = ctx;
    this.fadeSeconds = fadeSeconds;
    this.depthCfg = depth;
    this.dipHz = dipHz;
    this.loops = [];        // { id, level, buffer, gain, loopStart, loopEnd, rhoNext }
    this.sources = [];
    this.intensity = 1;
    this.depth = 0;
    this.dip = 0;
    this.playing = false;
    // loop gains -> mix -> low-pass -> sub shelf -> out (volume) -> limiter -> speakers;
    // low-pass -> reverb -> wet -> out; drone -> drone gain -> out (and a little into the reverb)
    this.mix = ctx.createGain();
    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.frequency.value = 20000;
    this.lowpass.Q.value = 0.7;
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
    this.mix.connect(this.lowpass).connect(this.sub).connect(this.out);
    this.lowpass.connect(this.reverb).connect(this.wet).connect(this.out);
    this.out.connect(this.limiter).connect(ctx.destination);
    this.drone = null;
  }

  // Loads every loop of the set ('pc' or 'mobile'); falls back to MP3 if the OGG fails to decode.
  async load(manifest, set, onProgress = () => {}, baseUrl = ASSETS_URL) {
    const list = [...(manifest.music ?? [])].sort((a, b) => a.level - b.level);
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
    this.startedAt = when;
    this.sources = this.loops.map((l) => {
      if (!l.buffer) return null;
      const src = this.ctx.createBufferSource();
      src.buffer = l.buffer;
      src.loop = true;
      src.loopStart = l.loopStart;
      src.loopEnd = l.loopEnd;
      src.connect(l.gain);
      src.start(when, l.loopStart);
      return src;
    });
    if (this.depthCfg) this.drone = makeDrone(this.ctx, this.depthCfg.droneHz, this.out, this.reverb);
    this.playing = true;
    this.setIntensity(this.intensity, 0);
    this.setDepth(this.depth, this.dip, 0.05);
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
      for (const o of this.drone.oscs) o.stop(t + fade + 0.1);
      this.drone.lfo.stop(t + fade + 0.1);
      this.drone = null;
    }
    this.sources = [];
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

  // seconds: how long the move takes (default fadeSeconds); 0 jumps.
  setIntensity(x, seconds = this.fadeSeconds) {
    this.intensity = x;
    const t = this.ctx.currentTime;
    this.gainsFor(x).forEach((v, k) => {
      const p = this.loops[k].gain.gain;
      p.cancelScheduledValues(t);
      if (seconds <= 0) p.setValueAtTime(v, t);
      else p.setTargetAtTime(v, t, seconds / 3);
    });
  }

  // Depth d (fractional, 0 = as generated) and filter dip (0 = open, 1 = closed to dipHz); both glide.
  setDepth(d, dip = 0, glide = 0.5) {
    const c = this.depthCfg;
    const t = this.ctx.currentTime;
    this.dip = dip;
    const hz = Math.exp(Math.log(20000) + (Math.log(this.dipHz) - Math.log(20000)) * dip);
    this.lowpass.frequency.setTargetAtTime(hz, t, glide);
    if (!c) {
      this.wet.gain.setTargetAtTime(0.25 * dip, t, glide);
      return;
    }
    d = Math.max(0, Math.min(d, c.maxDepth));
    this.depth = d;
    const at = (arr) => {
      const i = Math.min(Math.floor(d), arr.length - 1);
      const j = Math.min(i + 1, arr.length - 1);
      return arr[i] + (arr[j] - arr[i]) * (d - Math.floor(d));
    };
    this.wet.gain.setTargetAtTime(at(c.reverb) + 0.25 * dip, t, glide);
    this.sub.gain.setTargetAtTime(at(c.subDb), t, glide);
    if (this.drone) this.drone.gain.gain.setTargetAtTime(at(c.drone), t, Math.max(glide, 1));
  }

  // Drives the music from the run time t (seconds); call every frame (or a few times a second).
  follow(t, cfg) {
    const plan = musicPlan(t, cfg);
    if (!this.playing) return plan;
    if (Math.abs(plan.level - this.intensity) > 0.002) this.setIntensity(plan.level, plan.descending ? 2 : this.fadeSeconds);
    if (Math.abs(plan.depth - this.depth) > 0.002 || Math.abs(plan.dip - this.dip) > 0.002) this.setDepth(plan.depth, plan.dip);
    return plan;
  }

  setVolume(v, seconds = 0.2) {
    this.out.gain.setTargetAtTime(v, this.ctx.currentTime, seconds / 3);
  }

  // Position in the loop (seconds from loopStart), for display.
  position() {
    const l = this.loops[0];
    if (!this.playing || !l?.buffer) return 0;
    const len = l.loopEnd - l.loopStart;
    return (((this.ctx.currentTime - this.startedAt) % len) + len) % len;
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
      return osc;
    });
  lp.connect(gain);
  gain.connect(out);
  const send = ctx.createGain();
  send.gain.value = 0.5;
  gain.connect(send).connect(reverb);
  return { gain, oscs, lfo };
}
