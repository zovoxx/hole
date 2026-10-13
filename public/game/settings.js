// Player settings (the settings panel on the start and game-over screens): music volume, sound volume and the
// debug read-out (off by default). Kept in localStorage; a private window keeps them for the visit only.
import { SETTINGS } from './config.js';

export function loadSettings() {
  const s = { ...SETTINGS.defaults };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS.key) ?? '{}');
    for (const key of ['music', 'sound']) {
      if (Number.isFinite(saved?.[key])) s[key] = Math.min(SETTINGS.steps, Math.max(0, Math.round(saved[key])));
    }
    if (typeof saved?.debug === 'boolean') s.debug = saved.debug;
  } catch { /* nothing saved, or no storage: the defaults */ }
  return s;
}

export function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS.key, JSON.stringify({ music: s.music, sound: s.sound, debug: s.debug }));
  } catch { /* private mode */ }
}

// A volume step (0 ... SETTINGS.steps) as a gain: the default step plays at `base`; equal steps sound about equally
// far apart (square law); 0 is silent.
export function volumeGain(step, base) {
  return base * (step / SETTINGS.defaults.music) ** 2;
}
