import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * The toy-diorama look, shared by every model: smooth rounded shapes, a
 * vertical colour gradient per piece (lit on top, deeper underneath) and a
 * soft warm rim light so shapes pop off the ground.
 */

export interface Look {
  /** Soft warm rim light strength. */
  rim?: number;
  /** Gentle sway with height (plants). */
  sway?: boolean;
}

export function toyMaterial(time: { value: number }, look: Look = {}): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        ${look.sway ? `
        vec4 toyWorld = modelMatrix * vec4(transformed, 1.0);
        float bend = max(0.0, position.y) * 0.08;
        transformed.x += bend * sin(uTime * 2.4 + toyWorld.x * 0.9 + toyWorld.z * 0.7);` : ''}`,
      );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <aomap_fragment>',
      `#include <aomap_fragment>
      ${look.rim ? `
      float rimF = pow(1.0 - saturate(dot(normalize(normal), normalize(vViewPosition))), 2.5);
      totalEmissiveRadiance += vec3(1.0, 0.95, 0.85) * rimF * ${look.rim.toFixed(2)} * (0.4 + 0.6 * diffuseColor.rgb);` : ''}`,
    );
  };
  mat.customProgramCacheKey = () => `toy-${look.rim ?? 0}-${look.sway ? 's' : ''}`;
  return mat;
}

/** Vertex colour attribute, one flat colour. Returns a non-indexed copy. */
export function colored(geo: THREE.BufferGeometry, color: THREE.Color | number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = color instanceof THREE.Color ? color : new THREE.Color(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.toArray(arr, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (g.attributes.uv) g.deleteAttribute('uv');
  return g;
}

/** Vertex colours running from `bottom` (at y0) to `top` (at y1). */
export function shaded(geo: THREE.BufferGeometry, top: number, bottom: number, y0: number, y1: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const arr = new Float32Array(pos.count * 3);
  const ct = new THREE.Color(top);
  const cb = new THREE.Color(bottom);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, (pos.getY(i) - y0) / (y1 - y0 || 1)));
    c.copy(cb).lerp(ct, t * t * (3 - 2 * t));
    c.toArray(arr, i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (g.attributes.uv) g.deleteAttribute('uv');
  return g;
}

/** A smooth sphere with soft normals (and optional lumpiness). */
export function blob(r: number, detail = 2, lump = 0, seed = 0): THREE.BufferGeometry {
  let geo: THREE.BufferGeometry = new THREE.IcosahedronGeometry(r, detail);
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = mergeVertices(geo);
  if (lump > 0) {
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = Math.sin(v.x * 7 + seed) * Math.cos(v.y * 5 + v.z * 6 + seed) * 0.5;
      v.multiplyScalar(1 + n * lump);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
  }
  geo.computeVertexNormals();
  return geo;
}

/** Shifts a colour toward white (for highlights) or black (for shade). */
export function tint(hex: number, toward: number, k: number): number {
  return new THREE.Color(hex).lerp(new THREE.Color(toward), k).getHex();
}

/** Deterministic hash in [0, 1). */
export function hash(x: number, y: number, seed = 0): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** Overshooting pop for things appearing. */
export function popScale(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const c = 2.2;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
}
