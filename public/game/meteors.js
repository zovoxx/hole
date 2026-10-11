// Meteor rendering: one InstancedMesh per rock shape; each instance carries its own tint (instanceColor
// multiplies the neutral gray base colour). Contoo adds the types, crack/pulse shader, fuses and fragments here.
import * as THREE from 'three';
import { METEOR_TINTS } from './config.js';

const pale = new THREE.Color(METEOR_TINTS.decoyPale);
const deep = new THREE.Color(METEOR_TINTS.decoyDeep);

// kind: 'gray' | 'decoy' | 'exploder'; shade: decoy position from pale (0) to deep (1).
export function tintColor(kind, shade = 0.5, target = new THREE.Color()) {
  if (kind === 'decoy') return target.copy(pale).lerp(deep, THREE.MathUtils.clamp(shade, 0, 1));
  return target.set(kind === 'exploder' ? METEOR_TINTS.exploder : METEOR_TINTS.gray);
}

export function createMeteorMesh(shape, capacity) {
  const mesh = new THREE.InstancedMesh(shape.geometry, shape.material, capacity);
  mesh.name = shape.id;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.setColorAt(0, tintColor('gray'));  // creates instanceColor
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;  // instances spread over the whole view; per-instance culling is the world's job
  return mesh;
}
