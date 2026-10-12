// Meteor rendering: one InstancedMesh per rock shape. Each instance carries its tint (instanceColor multiplies the
// neutral gray base colour) and aFx = (fade, crack, glow, seed):
// - fade: extra fog, so a rock arriving at the far edge comes out of the murk smoothly (no transparency, no
//   sorting; a dithered fade showed as hatched discs on big rocks).
// - crack: how strongly an exploder's cracks glow (0 for every other rock). The world multiplies it by the tell
//   factor (none far away, faint at mid distance, clear up close) and raises it while the fuse burns.
// - glow: the pulse, 0..1 (the world advances its phase; it speeds up during the fuse).
// - seed: shifts the crack pattern, so two exploders of the same shape crack differently.
// Cracks are procedural: the edges of a 3D Voronoi pattern in the rock's own space, emissive, then fogged like the
// rock. Massive meteors also get a dust ring (DustRing) that only the tell lets you see.
import * as THREE from 'three';
import { METEOR_TINTS, EXPLODER, TELL, GRAVITY } from './config.js';

const pale = new THREE.Color(METEOR_TINTS.decoyPale);
const deep = new THREE.Color(METEOR_TINTS.decoyDeep);
const exploder = new THREE.Color(METEOR_TINTS.exploder);
const _deep = new THREE.Color();

// kind: 'gray' | 'decoy' | 'exploder'; shade: decoy position from pale (0) to deep (1); closeness: how far the
// deep end has moved toward the exploder colour (0..1, grows with difficulty).
export function tintColor(kind, shade = 0.5, target = new THREE.Color(), closeness = 0) {
  if (kind === 'decoy') {
    _deep.copy(deep).lerp(exploder, THREE.MathUtils.clamp(closeness, 0, 1));
    return target.copy(pale).lerp(_deep, THREE.MathUtils.clamp(shade, 0, 1));
  }
  return kind === 'exploder' ? target.copy(exploder) : target.set(METEOR_TINTS.gray);
}

// The tell factor at distance d (m): 1 near, 0 far, faint in between (DESIGN §6 "Readability by distance").
export function tellAt(d, c = TELL) {
  const t = THREE.MathUtils.clamp((d - c.near) / (c.far - c.near), 0, 1);
  return (1 - t * t * (3 - 2 * t)) ** c.power;
}

// fx: true adds the per-instance aFx attribute and the fade/crack/pulse shader. (The asset viewer uses plain
// meshes without it.)
export function createMeteorMesh(shape, capacity, { fx = false, fade = false } = {}) {
  let geometry = shape.geometry;
  let material = shape.material;
  if (fx || fade) {
    geometry = geometry.clone();
    const a = new Float32Array(capacity * 4);
    for (let i = 0; i < capacity; i++) a[i * 4] = 1;
    geometry.setAttribute('aFx', new THREE.InstancedBufferAttribute(a, 4).setUsage(THREE.DynamicDrawUsage));
    material = meteorMaterial(material);
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

const CRACK_GLSL = /* glsl */`
  varying vec4 vFx;
  varying vec3 vObj;
  uniform vec3 uCrackColor;
  uniform float uCrackScale;
  uniform float uCrackWidth;
  vec3 crackHash(vec3 p) {
    p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
    return fract(sin(p) * 43758.5453);
  }
  // F2 - F1 of a 3D Voronoi pattern (0 on the cell borders: the cracks) and how strongly this border glows (a
  // hash of the two cells, so some borders stay dark and the cracks don't look like a regular net)
  vec2 crackEdge(vec3 x) {
    vec3 n = floor(x);
    vec3 f = fract(x);
    float d1 = 8.0;
    float d2 = 8.0;
    vec3 c1 = vec3(0.0);
    vec3 c2 = vec3(0.0);
    for (int k = -1; k <= 1; k++)
    for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec3 g = vec3(float(i), float(j), float(k));
      vec3 r = g + crackHash(n + g) - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; c2 = c1; d1 = d; c1 = n + g; } else if (d < d2) { d2 = d; c2 = n + g; }
    }
    float pair = fract(sin(dot(c1 + c2, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    return vec2(sqrt(d2) - sqrt(d1), smoothstep(0.25, 0.6, pair));
  }
`;

// A copy of the GLB material with the fx: crack glow and pulse added to the emissive light (so the fog washes
// them out with distance like the rock), then the fade blends the fogged colour further into the fog colour.
function meteorMaterial(source) {
  const material = source.clone();
  const uniforms = {
    uCrackColor: { value: new THREE.Color(EXPLODER.crackColor) },
    uCrackScale: { value: EXPLODER.crackScale },
    uCrackWidth: { value: EXPLODER.crackWidth },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aFx;\nvarying vec4 vFx;\nvarying vec3 vObj;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFx = aFx;\nvObj = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${CRACK_GLSL}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (vFx.y > 0.002) {
          vec2 ce = crackEdge(vObj * uCrackScale + vFx.w * 17.0);
          float e = ce.x;
          float crack = (1.0 - smoothstep(0.0, uCrackWidth, e)) * ce.y;
          float halo = (1.0 - smoothstep(0.0, uCrackWidth * 4.0, e)) * (0.3 + 0.7 * ce.y);
          float pulse = 0.45 + 0.55 * vFx.z;
          totalEmissiveRadiance += uCrackColor * vFx.y * (crack * pulse + halo * 0.22 * vFx.z + 0.05 * vFx.z);
        }`)
      .replace('#include <fog_fragment>', `#include <fog_fragment>
        #ifdef USE_FOG
          gl_FragColor.rgb = mix(fogColor, gl_FragColor.rgb, vFx.x);
        #endif`);
  };
  material.customProgramCacheKey = () => 'meteor-fx';
  return material;
}

// ---- dust ring of a massive meteor: a thin disc of dust orbiting it, seen only up close (the tell)

const RING_VERT = /* glsl */`
  attribute vec4 aRing;   // radius (host radii), start angle, height (host radii), size (m)
  uniform float uTime;
  uniform float uHostR;
  uniform float uOmega;
  uniform float uScale;
  uniform float uOpacity;
  uniform float uFogDensity;
  uniform float uPuffAlpha;
  varying float vAlpha;
  void main() {
    float a = aRing.y + uOmega * pow(aRing.x / 2.0, -1.5) * uTime;   // inner dust goes round faster
    vec3 p = vec3(cos(a) * aRing.x, aRing.z, sin(a) * aRing.x) * uHostR;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float z = max(-mv.z, 0.1);
    float px = aRing.w * uScale / z;
    float fog = exp(-uFogDensity * uFogDensity * z * z);
    float puff = step(2.0, aRing.w);   // the big faint puffs (sizes >= 2 m)
    vAlpha = uOpacity * fog * clamp(px / 1.5, 0.0, 1.0) * (0.55 + 0.45 * fract(aRing.y * 7.13)) * mix(1.0, uPuffAlpha, puff);
    gl_PointSize = clamp(px, 1.5, 64.0);
  }`;

const RING_FRAG = /* glsl */`
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = (1.0 - smoothstep(0.1, 1.0, d)) * vAlpha;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
  }`;

export class DustRing {
  constructor(set, fogDensity) {
    const c = GRAVITY.ring;
    const n = c.points[set] ?? c.points.mobile;
    const data = new Float32Array(n * 4);
    const [r0, r1] = c.radius;
    for (let i = 0; i < n; i++) {
      // denser in the middle of the band, a few strays inside and out
      const u = (Math.random() + Math.random() + Math.random()) / 3;
      data[i * 4] = r0 + (r1 - r0) * u;
      data[i * 4 + 1] = Math.random() * Math.PI * 2;
      data[i * 4 + 2] = (Math.random() + Math.random() - 1) * c.thickness;
      // fine grains, and a share of big faint puffs that blur them into a band
      const puff = i < n * c.puffs;
      const [z0, z1] = puff ? c.puffSize : c.size;
      data[i * 4 + 3] = z0 + (z1 - z0) * Math.random() ** 2;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geometry.setAttribute('aRing', new THREE.BufferAttribute(data, 4));
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uHostR: { value: 1 },
        uOmega: { value: (2 * Math.PI) / c.period },
        uScale: { value: 500 },
        uOpacity: { value: 0 },
        uFogDensity: { value: fogDensity },
        uPuffAlpha: { value: c.puffAlpha },
        uColor: { value: new THREE.Color(c.color) },
      },
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.host = null;
  }

  attach(host, normal) {
    this.host = host;
    this.material.uniforms.uHostR.value = host.s;
    this.material.uniforms.uTime.value = Math.random() * 100;
    this.points.quaternion.setFromUnitVectors(_up.set(0, 1, 0), normal);
  }

  // opacity = tell × fade of the host
  update(dt, opacity, scale) {
    const u = this.material.uniforms;
    u.uTime.value += dt;
    u.uScale.value = scale;
    u.uOpacity.value = GRAVITY.ring.opacity * opacity;
    this.points.position.copy(this.host.p);
    this.points.visible = opacity > 0.003;
  }

  detach() {
    this.host = null;
    this.points.visible = false;
  }
}
const _up = new THREE.Vector3();
