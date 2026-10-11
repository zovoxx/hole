// Space around the meteors (TECH "Rendering and layers"):
// - Stars: a fixed, even sprinkle of points at infinity (they turn with the view but never move), so there is
//   no top, bottom, horizon or seam.
// - Motes: tiny dust in a box around the camera that wraps as you fly (in the shader), for the feel of speed.
// - Murk: a few big dust and haze sprites from the conto drifting in the fog; they appear and leave like the
//   meteors (never in view) and thin out as you get close, so they never cover the screen.
import * as THREE from 'three';
import { SPACE, SPRITES, WORLD } from './config.js';
import { spriteMaterial } from './sprites.js';

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createStars(pixelRatio) {
  const { count, size: [s0, s1], seed } = SPACE.stars;
  const rnd = mulberry32(seed);
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const R = 1000;
  for (let i = 0; i < count; i++) {
    const z = rnd() * 2 - 1;  // uniform on the sphere
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    pos.set([R * r * Math.cos(a), R * r * Math.sin(a), R * z], i * 3);
    const b = 0.12 + 0.88 * rnd() ** 5;   // mostly faint, a few bright
    const warm = rnd();
    const tint = warm < 0.12 ? [1, 0.86, 0.7] : warm < 0.5 ? [0.8, 0.86, 1] : [0.92, 0.95, 1];
    col.set(tint.map((c) => c * b), i * 3);
    size[i] = s0 + (s1 - s0) * rnd() ** 2 * (0.4 + 0.6 * b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: { uPixelRatio: { value: pixelRatio } },
    vertexShader: `
      attribute vec3 aColor;
      attribute float aSize;
      uniform float uPixelRatio;
      varying vec3 vColor;
      varying float vFaint;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float px = aSize * uPixelRatio;
        vFaint = clamp(px / 1.6, 0.0, 1.0);       // below 1.6 device px: keep the size, lower the light
        gl_PointSize = max(px, 1.6);
        vColor = aColor;
      }`,
    fragmentShader: `
      varying vec3 vColor;
      varying float vFaint;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = 1.0 - smoothstep(0.35, 1.0, d);
        gl_FragColor = vec4(vColor * a * vFaint, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = -10;
  return points;
}

export class Motes {
  constructor(set) {
    const { count, box, size, color, opacity } = SPACE.motes;
    const n = count[set] ?? count.mobile;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) pos[i] = (Math.random() * 2 - 1) * box;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.offset = new THREE.Vector3();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uOffset: { value: this.offset },
        uHalf: { value: box },
        uSize: { value: size },
        uScale: { value: 500 },
        uColor: { value: new THREE.Color(color) },
        uOpacity: { value: opacity },
      },
      vertexShader: `
        uniform vec3 uOffset;
        uniform float uHalf;
        uniform float uSize;
        uniform float uScale;
        varying float vAlpha;
        void main() {
          vec3 p = mod(position - uOffset + uHalf, 2.0 * uHalf) - uHalf;   // wrap around the camera
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float d = length(p);
          float z = max(-mv.z, 0.05);
          float px = uSize * uScale / z;
          vAlpha = (1.0 - smoothstep(uHalf * 0.5, uHalf * 0.95, d)) * smoothstep(0.8, 3.0, d)
                 * clamp(px / 1.5, 0.0, 1.0);
          gl_PointSize = clamp(px, 1.5, 7.0);
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = (1.0 - smoothstep(0.2, 1.0, d)) * vAlpha * uOpacity;
          if (a < 0.003) discard;
          gl_FragColor = vec4(uColor, a);
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
  }

  // Device pixels per metre at 1 m in front of the camera.
  resize(camera, heightPx) {
    this.material.uniforms.uScale.value = heightPx / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  }

  update(move) {
    const span = 2 * SPACE.motes.box;
    this.offset.add(move);
    for (const k of ['x', 'y', 'z']) this.offset[k] = ((this.offset[k] % span) + span) % span;
  }
}

const _dir = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _sphere = new THREE.Sphere();

export class Murk {
  // sprites = loadSprites() result
  constructor(scene, sprites) {
    this.items = [];
    const make = (kind, list, n, [s0, s1]) => {
      if (!list?.length) return;
      for (let i = 0; i < n; i++) {
        const tex = list[i % list.length].texture;
        const material = spriteMaterial(tex, { ...SPRITES[kind], rotation: Math.random() * Math.PI * 2 });
        const sprite = new THREE.Sprite(material);
        sprite.visible = false;
        scene.add(sprite);
        this.items.push({ kind, sprite, size: s0, range: [s0, s1], base: SPRITES[kind].opacity, fade: 1,
                          spin: (Math.random() - 0.5) * 0.02 });
      }
    };
    make('haze', sprites.haze, SPACE.sprites.haze, SPACE.sprites.hazeSize);
    make('dust', sprites.dust, SPACE.sprites.dust, SPACE.sprites.dustSize);
  }

  // A random direction in the kept cone around fwd (uniform over the cap).
  randomDir(fwd, cosKeep, out) {
    const c = 1 - Math.random() * (1 - cosKeep);
    const s = Math.sqrt(1 - c * c);
    const phi = Math.random() * Math.PI * 2;
    _a.set(Math.abs(fwd.x) < 0.9 ? 1 : 0, Math.abs(fwd.x) < 0.9 ? 0 : 1, 0).cross(fwd).normalize();
    _b.copy(fwd).cross(_a);
    return out.copy(fwd).multiplyScalar(c).addScaledVector(_a, s * Math.cos(phi)).addScaledVector(_b, s * Math.sin(phi));
  }

  place(it, fwd, frustum, cosKeep, initial) {
    const R = WORLD.radius;
    it.size = it.range[0] + Math.random() * (it.range[1] - it.range[0]);
    this.randomDir(fwd, cosKeep, _dir);
    const r0 = WORLD.sideMin + it.size * 0.5;
    let d = Math.cbrt(r0 ** 3 + Math.random() * (R ** 3 - r0 ** 3));
    it.fade = 1;
    if (!initial) {
      _sphere.center.copy(_dir).multiplyScalar(d);
      _sphere.radius = it.size * 0.6;
      if (frustum.intersectsSphere(_sphere)) {
        d = R + it.size * 0.2 - Math.random() * WORLD.fadeBand;
        it.fade = 0;
      }
    }
    it.sprite.position.copy(_dir).multiplyScalar(d);
    it.sprite.scale.setScalar(it.size);
    it.sprite.material.rotation = Math.random() * Math.PI * 2;
  }

  reset(fwd, frustum, cosKeep) {
    for (const it of this.items) this.place(it, fwd, frustum, cosKeep, true);
  }

  update(dt, { move, fwd, frustum, cosKeep }) {
    const R = WORLD.radius;
    for (const it of this.items) {
      const p = it.sprite.position.sub(move);
      const d = p.length();
      const cos = d > 1e-6 ? p.dot(fwd) / d : 1;
      _sphere.center.copy(p);
      _sphere.radius = it.size * 0.6;
      const inView = frustum.intersectsSphere(_sphere);
      if (d > R + it.size || (cos < cosKeep && !inView)) {
        this.place(it, fwd, frustum, cosKeep, false);
        continue;
      }
      if (it.fade < 1) it.fade = Math.min(1, it.fade + dt / 3);
      // thin out when close, so a sprite never fills the screen
      const near = THREE.MathUtils.smoothstep(d, it.size * 0.35, it.size * SPACE.sprites.nearFade);
      it.sprite.material.opacity = it.base * it.fade * near;
      it.sprite.material.rotation += it.spin * dt;
      it.sprite.visible = inView && it.sprite.material.opacity > 0.004;
    }
  }
}
