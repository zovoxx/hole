// Space sprites from the manifest: dust wisps, haze puffs and the explosion flash glow. The textures are white
// with the shape in the alpha channel, so a material colour tints them. A file that fails to load becomes a
// soft procedural blob (with a console warning), so the game still runs.
import * as THREE from 'three';
import { assetUrl } from './loader.js';

// Returns { dust: [{ id, texture }], haze: [...], flash: [...] }, each list sorted by id.
export async function loadSprites(manifest, set, onProgress = () => {}) {
  const entries = Object.entries(manifest.textures ?? {}).flatMap(([kind, list]) =>
    list.map((entry) => ({ kind, entry })));
  const loader = new THREE.TextureLoader();
  const out = { dust: [], haze: [], flash: [] };
  let done = 0;
  await Promise.all(entries.map(async ({ kind, entry }) => {
    let texture;
    try {
      texture = await loader.loadAsync(assetUrl(entry[set], entry.bytes?.[set]));
    } catch (err) {
      console.warn(`sprite ${entry.id} (${set}): ${err.message ?? 'load failed'}; using a soft blob`);
      texture = softBlob();
    }
    texture.colorSpace = THREE.SRGBColorSpace;
    (out[kind] ??= []).push({ id: entry.id, texture });
    onProgress(++done, entries.length);
  }));
  for (const list of Object.values(out)) list.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

// Dust and haze blend normally (they veil what is behind them); the flash adds light.
export function spriteMaterial(texture, { color = 0xffffff, opacity = 1, additive = false, rotation = 0 } = {}) {
  return new THREE.SpriteMaterial({
    map: texture, color, opacity, rotation, transparent: true, depthWrite: false, fog: true,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

function softBlob(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}
