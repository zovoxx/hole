// Audio. Conto 3 starts it with the music: the intensity loops from the manifest, all started at the same
// moment and crossfaded by a continuous intensity (1 = calm start ... 4 = full adrenaline). The loops share
// tempo, key and bar count, so they stay in sync forever; intensity only moves their gains.
// Over a run the music climbs 1 -> 4 in one cycle (MUSIC.cycleSeconds). In the cycle's last descentSeconds it
// sinks smoothly back to 1: the levels crossfade down, a low-pass filter closes and opens again and the reverb
// swells, while the next depth eases in (more reverb, more sub, a low drone on the tonal centre). Nothing ever
// switches at once.
// Contoo 3: the synthesized sounds (Sfx: whoosh, rumble, boom, crash; no files) and a duck for the game-over
// screen (the music goes under and quiet, then comes back for the next run).
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
    this.duckGain = ctx.createGain();  // the game-over screen ducks the music (duck()); 1 = not ducked
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
    this.out.connect(this.duckGain).connect(this.limiter).connect(ctx.destination);
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

  // 1 = full, less = ducked (the game-over screen); glides over `seconds`.
  duck(v, seconds = 0.8) {
    const p = this.duckGain.gain;
    p.cancelScheduledValues(this.ctx.currentTime);
    p.setTargetAtTime(v, this.ctx.currentTime, seconds / 3);
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

// ---- synthesized sounds (TECH "Audio"): no files, all built from noise and oscillators.
// - whoosh: band-passed noise sweeping down (a rock rushing past), panned to its side;
// - rumble: low-passed brown noise plus a slowly wandering 30–50 Hz tone, its level following the pull;
// - boom: a noise burst through a low-pass that is darker the further away, plus a falling low tone;
// - crash: the hit (a close boom with a harder thud).
export class Sfx {
  constructor(ctx, { volume = 0.9, cfg = {} } = {}) {
    this.ctx = ctx;
    this.cfg = cfg;
    this.out = ctx.createGain();
    this.out.gain.value = volume;
    this.comp = ctx.createDynamicsCompressor();  // keeps stacked booms from clipping
    this.comp.threshold.value = -10;
    this.comp.knee.value = 6;
    this.comp.ratio.value = 6;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.2;
    this.out.connect(this.comp).connect(ctx.destination);
    this.white = noiseBuffer(ctx, 2, false);
    this.brown = noiseBuffer(ctx, 4, true);
    this.voices = 0;          // sounds playing now (whooshes and booms are capped)
    this.rumble = null;
    this.stats = { whoosh: 0, boom: 0, crash: 0 };
  }

  setVolume(v, seconds = 0.2) {
    this.out.gain.setTargetAtTime(v, this.ctx.currentTime, seconds / 3);
  }

  // A panner (StereoPanner where there is one) feeding the output.
  pan(x, dest = this.out) {
    if (!this.ctx.createStereoPanner) return dest;
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, x));
    p.connect(dest);
    return p;
  }

  noise(buffer = this.white, when = this.ctx.currentTime, seconds = 1) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.start(when, Math.random() * Math.max(0, buffer.duration - seconds - 0.05));
    src.stop(when + seconds + 0.05);
    return src;
  }

  // A rock passes close: k = how close 0..1, pan = its side (-1 left ... 1 right), speed m/s (relative).
  whoosh(k, pan, speed = 50) {
    if (this.voices > 10 || k <= 0.02) return;
    const c = this.ctx;
    const t = c.currentTime;
    const dur = (this.cfg.whoosh?.seconds ?? 0.6) * (0.8 + 0.4 * Math.random());
    const src = this.noise(this.white, t, dur);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    const f0 = 900 + 1600 * Math.min(1, speed / 80);   // faster = higher
    bp.frequency.setValueAtTime(f0 * 1.6, t);
    bp.frequency.exponentialRampToValueAtTime(f0 * 0.28, t + dur);  // passing: the pitch falls
    const g = c.createGain();
    const peak = (this.cfg.whoosh?.gain ?? 0.55) * (0.25 + 0.75 * k);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp).connect(g).connect(this.pan(pan * 0.85));
    this.track(src, dur);
    this.stats.whoosh++;
  }

  // An explosion d metres away (pan -1..1), from a rock of radius s.
  boom(d, pan = 0, s = 7) {
    if (this.voices > 10) return;
    const B = this.cfg.boom ?? { gain: 1, range: 330, near: 40 };
    const far = Math.min(1, Math.max(0, (d - B.near) / (B.range - B.near)));
    const level = B.gain * (1 - far) ** 1.6 * Math.min(1.3, Math.sqrt(s / 7));
    if (level < 0.01) return;
    this.blast(level, pan, 1 - far, 1.1 + 0.9 * far);
    this.stats.boom++;
  }

  // The hit.
  crash() {
    this.blast(this.cfg.crash?.gain ?? 0.9, 0, 1.2, 0.9);
    this.stats.crash++;
  }

  // level 0..1, pan, bright 0..1 (near = bright), dur s
  blast(level, pan, bright, dur) {
    const c = this.ctx;
    const t = c.currentTime;
    const out = this.pan(pan * 0.7);
    // the burst: noise, darker with distance
    const src = this.noise(this.white, t, dur);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(500 + 4500 * bright * bright, t);
    lp.frequency.exponentialRampToValueAtTime(140 + 200 * bright, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level * 0.9, t + 0.008);
    g.gain.exponentialRampToValueAtTime(level * 0.3, t + 0.18);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp).connect(g).connect(out);
    // the body: a falling low tone
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(95, t);
    osc.frequency.exponentialRampToValueAtTime(32, t + dur * 0.8);
    const og = c.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(level * 0.8, t + 0.02);
    og.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.9);
    osc.connect(og).connect(out);
    osc.start(t);
    osc.stop(t + dur);
    this.track(src, dur);
  }

  track(src, dur) {
    this.voices++;
    setTimeout(() => { this.voices--; }, (dur + 0.1) * 1000);
    src.onended = null;
  }

  // The rumble of a massive meteor's pull: started once, its level follows strength (0..1) smoothly.
  setRumble(strength) {
    const c = this.ctx;
    if (!this.rumble) {
      if (strength <= 0.001) return;
      const gain = c.createGain();
      gain.gain.value = 0;
      gain.connect(this.out);
      const src = c.createBufferSource();
      src.buffer = this.brown;
      src.loop = true;
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 130;
      lp.Q.value = 0.9;
      src.connect(lp).connect(gain);
      src.start();
      const osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 40;
      const lfo = c.createOscillator();  // the tone wanders 33–47 Hz
      lfo.frequency.value = 0.13;
      const lfoDepth = c.createGain();
      lfoDepth.gain.value = 7;
      lfo.connect(lfoDepth).connect(osc.frequency);
      const og = c.createGain();
      og.gain.value = 0.12;
      osc.connect(og).connect(gain);
      osc.start();
      lfo.start();
      this.rumble = { gain, nodes: [src, osc, lfo], level: 0 };
    }
    const level = (this.cfg.rumble?.gain ?? 0.7) * Math.min(1, strength) ** 0.8;
    if (Math.abs(level - this.rumble.level) < 0.004) return;
    this.rumble.level = level;
    this.rumble.gain.gain.setTargetAtTime(level, c.currentTime, 0.12);
  }
}

// Noise for the sounds: white, or brown (integrated, for the rumble), mono.
function noiseBuffer(ctx, seconds, brown) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) {
      b = (b + 0.02 * w) / 1.02;
      d[i] = b * 3.5;
    } else {
      d[i] = w * 0.7;
    }
  }
  if (brown) {  // make it loop without a step at the seam
    const step = d[n - 1] - d[0];
    for (let i = 0; i < n; i++) d[i] -= (step * i) / (n - 1);
  }
  return buf;
}
