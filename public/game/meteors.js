// Meteor rendering: one InstancedMesh per rock shape; each instance carries its own tint (instanceColor
// multiplies the neutral gray base colour) and fade (aFade: extra fog, so a rock arriving at the far edge comes
// out of the murk smoothly; no transparency, no sorting). Contoo 2 adds the types, crack/pulse shader, fuses and
// fragments here.
import * as THREE from 'three';
import { METEOR_TINTS } from './config.js';

const pale = new THREE.Color(METEOR_TINTS.decoyPale);
const deep = new THREE.Color(METEOR_TINTS.decoyDeep);

// kind: 'gray' | 'decoy' | 'exploder'; shade: decoy position from pale (0) to deep (1).
export function tintColor(kind, shade = 0.5, target = new THREE.Color()) {
  if (kind === 'decoy') return target.copy(pale).lerp(deep, THREE.MathUtils.clamp(shade, 0, 1));
  return target.set(kind === 'exploder' ? METEOR_TINTS.exploder : METEOR_TINTS.gray);
}

// fade: true adds the per-instance aFade attribute (1 = as fogged as its distance, 0 = all fog colour) and patches
// the material to use it.
export function createMeteorMesh(shape, capacity, { fade = false } = {}) {
  let geometry = shape.geometry;
  let material = shape.material;
  if (fade) {
    geometry = geometry.clone();
    geometry.setAttribute('aFade', new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1)
      .setUsage(THREE.DynamicDrawUsage));
    material = fadeMaterial(material);
  }
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = shape.id;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.setColorAt(0, tintColor('gray'));  // creates instanceColor
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;  // instances spread over the whole view; per-instance culling is the world's job
  return mesh;
}

// A copy of the GLB material that blends the lit, fogged colour further into the fog colour while aFade < 1.
// The fog colour is the background colour, so at aFade = 0 the rock is invisible. (A dithered fade showed as a
// hatched disc on big rocks at the far edge.)
function fadeMaterial(source) {
  const material = source.clone();
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFade;\nvarying float vFade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFade = aFade;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFade;')
      .replace('#include <fog_fragment>', `#include <fog_fragment>
        #ifdef USE_FOG
          gl_FragColor.rgb = mix(fogColor, gl_FragColor.rgb, vFade);
        #endif`);
  };
  material.customProgramCacheKey = () => 'meteor-fade';
  return material;
}
