// Picks the asset set. `?set=pc` / `?set=mobile` overrides the detection (for testing).
import { PIXEL_RATIO_MAX } from './config.js';

export function pickAssetSet(search = window.location.search) {
  const forced = new URLSearchParams(search).get('set');
  if (forced === 'pc' || forced === 'mobile') return forced;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  // iPads can report a desktop user agent; touch points without hover still mean a tablet
  const touchNoHover = navigator.maxTouchPoints > 1 && !window.matchMedia('(hover: hover)').matches;
  return coarse || touchNoHover ? 'mobile' : 'pc';
}

export function pixelRatio(set) {
  return Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_MAX[set] ?? 1.5);
}

export function hasTouch() {
  return navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
}
