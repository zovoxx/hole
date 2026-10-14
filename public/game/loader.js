// Reads assets/manifest.json and loads the chosen asset set. A file that fails to load becomes a placeholder
// rock (with a console warning), so the game still runs.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/gltfloader.js';

export const ASSETS_URL = new URL('../assets/', import.meta.url);

// The URL of an asset file, with its size from the manifest as a version (?v=bytes): the files are cached for a
// long time (public/_headers), and a changed file gets a new URL.
export function assetUrl(file, bytes) {
  const url = new URL(file, ASSETS_URL);
  if (bytes) url.searchParams.set('v', bytes);
  return url.href;
}

export async function loadManifest() {
  const res = await fetch(new URL('manifest.json', ASSETS_URL));
  if (!res.ok) throw new Error(`assets/manifest.json: HTTP ${res.status}`);
  return res.json();
}

// Returns { small: [shape], big: [shape], fragments: [shape] }, each list sorted by id.
// shape = { id, group, geometry, material, collisionRadius, collisionSpheres, tris, placeholder }
// onProgress(done, total) is called after every file. groups: which groups to load (default all).
export async function loadMeteors(manifest, set, onProgress = () => {}, { groups = null } = {}) {
  const entries = Object.entries(manifest.meteors ?? {})
    .filter(([group]) => !groups || groups.includes(group))
    .flatMap(([group, list]) => list.map((entry) => ({ group, entry })));
  const loader = new GLTFLoader();
  const out = { small: [], big: [], fragments: [] };
  let done = 0;
  await Promise.all(entries.map(async ({ group, entry }) => {
    let shape;
    try {
      shape = meshFromGltf(await loader.loadAsync(assetUrl(entry[set], entry.bytes?.[set])));
    } catch (err) {
      console.warn(`meteor ${entry.id} (${set}): ${err.message}; using a placeholder`);
      shape = placeholderRock();
    }
    (out[group] ??= []).push({
      id: entry.id,
      group,
      ...shape,
      collisionRadius: entry.collisionRadius ?? 0.8,
      collisionSpheres: entry.collisionSpheres ?? [],
      sizeInRock: entry.sizeInRock ?? 0.85,  // fragments: radius relative to the rock they broke from
      tris: entry.tris?.[set] ?? shape.geometry.index.count / 3,
    });
    onProgress(++done, entries.length);
  }));
  for (const list of Object.values(out)) list.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function meshFromGltf(gltf) {
  let mesh = null;
  gltf.scene.traverse((o) => { if (!mesh && o.isMesh) mesh = o; });
  if (!mesh) throw new Error('no mesh in the GLB');
  mesh.updateWorldMatrix(true, false);
  const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
  geometry.computeBoundingSphere();
  return { geometry, material: mesh.material, placeholder: false };
}

function placeholderRock() {
  const geometry = new THREE.IcosahedronGeometry(1, 2);
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {  // lumpy, deterministic
    const s = 0.85 + 0.15 * Math.sin(i * 12.9898) * Math.sin(i * 78.233);
    pos.setXYZ(i, pos.getX(i) * s, pos.getY(i) * s, pos.getZ(i) * s);
  }
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ color: 0x949494, roughness: 0.85, flatShading: true });
  return { geometry, material, placeholder: true };
}
