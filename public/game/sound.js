// The game's audio (TECH "Audio"): one AudioContext for the music (audio.js Music) and the synthesized sounds
// (audio.js Sfx).
// - Unlocking: browsers (iOS above all) start audio only from a user gesture. The context is made at boot (so the
//   music can decode in the background) and resumed on the first key, click or tap; touches count on touchend /
//   pointerup, which is when mobile browsers allow it. Hidden tab: suspended; back: resumed.
// - Music: loaded after the meteors, without holding up the loading bar; it starts with the first run and follows
//   the run time (music.follow: 5-minute cycles that drop back to calm and come back deeper). Game over: it goes
//   under (low-pass, quieter) and sinks to calm; the next run brings it back from the start of the cycle.
// - Sounds: the near-miss whoosh, the rumble of a massive meteor's pull, explosion booms, the crash.
import { PULL_WARNING, MUSIC, SOUND } from './config.js';
import { Music, Sfx, unlockAudio } from './audio.js';
import { volumeGain } from './settings.js';

export class GameSound {
  constructor(set, settings) {
    this.set = set;
    this.settings = settings;
    this.ctx = null;
    this.music = null;
    this.sfx = null;
    this.loaded = false;    // music decoded
    this.wantMusic = false; // a run has started (the music should play once loaded)
    this.under = false;     // game over: ducked
    this.started = false;   // the context has run (so it may be resumed after a hidden tab)
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC({ latencyHint: 'interactive' });
    } catch (err) {
      console.warn('audio:', err.message);
    }
    if (!this.ctx) return;
    this.music = new Music(this.ctx, { fadeSeconds: MUSIC.fadeSeconds, volume: 0, depth: MUSIC.depth, dipHz: MUSIC.dipHz });
    this.sfx = new Sfx(this.ctx, { volume: 0, cfg: SOUND });
    this.applyVolumes(0.01);
    const unlock = () => this.unlock();
    for (const type of ['keydown', 'mousedown', 'pointerup', 'touchend', 'click']) {
      window.addEventListener(type, unlock, { capture: true, passive: true });
    }
    this.ctx.addEventListener?.('statechange', () => { if (this.ctx.state === 'running') this.started = true; });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.ctx.suspend?.().catch?.(() => {});
      else if (this.started) this.ctx.resume?.().catch?.(() => {});
    });
  }

  get unlocked() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  unlock() {
    if (!this.ctx || this.ctx.state === 'running' || document.hidden) return;
    try {
      unlockAudio(this.ctx);
    } catch (err) {
      console.warn('audio unlock:', err.message);
    }
  }

  // Loads the music (in the background). Resolves when it is ready (or failed: the game plays on without it).
  async load(manifest) {
    if (!this.music) return;
    try {
      await this.music.load(manifest, this.set);
      this.loaded = this.music.loops.some((l) => l.buffer);
      if (this.loaded && this.wantMusic) this.startMusic();
    } catch (err) {
      console.warn('music:', err.message);
    }
  }

  applyVolumes(seconds = 0.2) {
    if (!this.ctx) return;
    this.music.setVolume(volumeGain(this.settings.music, MUSIC.volume), seconds);
    this.sfx.setVolume(volumeGain(this.settings.sound, SOUND.volume), seconds);
  }

  startMusic() {
    if (!this.loaded || this.music.playing) return;
    this.music.setIntensity(1, 0);
    this.music.setDepth(0, 0, 0.05);
    this.music.start();
  }

  // A run starts (the first one, or a restart).
  runStarted() {
    if (!this.ctx) return;
    this.unlock();
    this.wantMusic = true;
    this.startMusic();
    if (this.under) {
      this.under = false;
      this.music.duck(1, 1.2);
      this.music.setDepth(0, 0, 0.6);
    }
  }

  // Every frame of a run: the music follows the run time, the rumble the pull.
  run(runTime, pullStrength) {
    if (!this.ctx) return;
    if (this.music.playing) this.music.follow(runTime, MUSIC);
    if (this.unlocked) this.sfx.setRumble(pullStrength);
  }

  // The hit: the crash, the rumble stops, the music goes under and sinks to calm.
  hit() {
    if (!this.ctx) return;
    if (this.unlocked) this.sfx.crash();
    this.sfx.setRumble(0);
    this.under = true;
    if (this.music.playing) {
      this.music.duck(0.45, 0.8);
      this.music.setDepth(this.music.depth, 0.85, 0.25);
      this.music.setIntensity(1, 3);
    }
  }

  // The pull warning (danger 0..1, dt s): beeps, faster the closer the hit; the first one at once.
  warning(danger, dt) {
    if (danger <= 0.02) {
      this.warnIn = 0;
      return;
    }
    this.warnIn = (this.warnIn ?? 0) - dt;
    if (this.warnIn > 0) return;
    const [slow, fast] = PULL_WARNING.beepGap;
    this.warnIn = slow + (fast - slow) * danger;
    if (this.unlocked) this.sfx.beep(0.55 + 0.45 * danger);
  }

  whoosh(k, pan, speed) {
    if (this.unlocked) this.sfx.whoosh(k, pan, speed);
  }

  boom(d, pan, s) {
    if (this.unlocked) this.sfx.boom(d, pan, s);
  }

  // For tests and the debug line.
  get state() {
    return {
      context: this.ctx?.state ?? 'none', loaded: this.loaded, playing: !!this.music?.playing,
      intensity: this.music?.intensity ?? 0, depth: this.music?.depth ?? 0, sfx: { ...(this.sfx?.stats ?? {}) },
    };
  }
}
