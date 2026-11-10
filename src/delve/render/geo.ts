/**
 * Procedural low-poly geometry (RENDER): critters, bosses, the delver and lantern, the Wyrm, gems, props.
 *
 * Every mesh is merged from primitive "parts" into one geometry with attributes:
 *   color (vec3)  base colour; white parts take the per-instance tint, keep parts keep their own colour
 *   aKeep (vec2)  x = keep own colour (0 tinted .. 1 own), y = self glow (eyes, lamps, mushroom caps)
 *   aBend (vec3)  displacement animated as aBend * sin(time * freq + phase) (wings, legs, arms)
 * Conventions: unit footprint radius ~1, origin on the floor, facing +z.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

type BendFn = (x: number, y: number, z: number, out: [number, number, number]) => void;

interface PartOpts {
  keep?: number;
  glow?: number;
  bend?: BendFn;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Position / rotate (XYZ euler) / scale a primitive in place. */
function at(
  g: THREE.BufferGeometry, x: number, y: number, z: number,
  rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx,
): THREE.BufferGeometry {
  _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
  g.applyMatrix4(_m);
  return g;
}

/** Convert to a non-indexed part with colour / keep / bend attributes. */
function paint(g: THREE.BufferGeometry, color: number, o: PartOpts = {}): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  if (ng !== g) g.dispose();
  for (const k of Object.keys(ng.attributes)) if (k !== 'position' && k !== 'normal') ng.deleteAttribute(k);
  const pos = ng.getAttribute('position') as THREE.BufferAttribute;
  const n = pos.count;
  const col = new Float32Array(n * 3);
  const keep = new Float32Array(n * 2);
  const bend = new Float32Array(n * 3);
  const c = new THREE.Color(color);
  const tmp: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
    keep[i * 2] = o.keep ?? 0;
    keep[i * 2 + 1] = o.glow ?? 0;
    if (o.bend) {
      tmp[0] = tmp[1] = tmp[2] = 0;
      o.bend(pos.getX(i), pos.getY(i), pos.getZ(i), tmp);
      bend[i * 3] = tmp[0];
      bend[i * 3 + 1] = tmp[1];
      bend[i * 3 + 2] = tmp[2];
    }
  }
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
  ng.setAttribute('aKeep', new THREE.BufferAttribute(keep, 2));
  ng.setAttribute('aBend', new THREE.BufferAttribute(bend, 3));
  if (!ng.getAttribute('normal')) ng.computeVertexNormals();
  return ng;
}

/** Mirror a part across x (fixing the winding so faces still point out). */
function mirrorX(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const m = g.clone();
  m.applyMatrix4(new THREE.Matrix4().makeScale(-1, 1, 1));
  for (const name of Object.keys(m.attributes)) {
    const a = m.getAttribute(name) as THREE.BufferAttribute;
    const s = a.itemSize;
    const arr = a.array as Float32Array;
    for (let t = 0; t < a.count; t += 3) {
      for (let k = 0; k < s; k++) {
        const i1 = (t + 1) * s + k;
        const i2 = (t + 2) * s + k;
        const tmp = arr[i1];
        arr[i1] = arr[i2];
        arr[i2] = tmp;
      }
    }
  }
  // bend x component flips with the mirror
  const b = m.getAttribute('aBend') as THREE.BufferAttribute;
  for (let i = 0; i < b.count; i++) b.setX(i, -b.getX(i));
  return m;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false);
  if (!g) throw new Error('merge failed');
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  return g;
}

const sphere = (r: number, w = 8, h = 6) => new THREE.SphereGeometry(r, w, h);
const box = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z);
const cyl = (rt: number, rb: number, h: number, s = 8) => new THREE.CylinderGeometry(rt, rb, h, s);
const cone = (r: number, h: number, s = 6) => new THREE.ConeGeometry(r, h, s);
const dode = (r: number) => new THREE.DodecahedronGeometry(r, 0);
const octa = (r: number) => new THREE.OctahedronGeometry(r, 0);

const W = 0xffffff;
const EYE = 0xfff3a0;

/** Pair of glowing eyes at (±x, y, z). */
function eyes(x: number, y: number, z: number, r: number, color = EYE, glow = 1.4): THREE.BufferGeometry[] {
  const a = paint(at(sphere(r, 6, 5), x, y, z), color, { keep: 1, glow });
  return [a, mirrorX(a)];
}

// ---------------------------------------------------------------------------------------------
// Critters
// ---------------------------------------------------------------------------------------------

/** Cave bat: round body, big ears, scalloped wings that flap (bend on y), glowing eyes. Centred at y = 0. */
export function batGeo(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0.3, 0.22);
  shape.lineTo(1.0, 0.5);
  shape.lineTo(1.8, 0.2);
  shape.lineTo(1.5, -0.2);
  shape.lineTo(1.18, -0.02);
  shape.lineTo(0.92, -0.36);
  shape.lineTo(0.6, -0.1);
  shape.lineTo(0.3, -0.28);
  const wingG = new THREE.ExtrudeGeometry(shape, { depth: 0.06, bevelEnabled: false });
  at(wingG, 0, 0.02, 0, Math.PI / 2, 0, 0); // XY shape -> XZ plane (z flips sign)
  const wing = paint(wingG, 0x9a9aa8, {
    bend: (x, _y, _z, o) => {
      const k = Math.max(0, Math.abs(x) - 0.3);
      o[1] = k * 0.75;
      o[0] = -k * 0.12 * Math.sign(x);
    },
  });
  return merge([
    paint(at(sphere(0.55, 9, 7), 0, 0, 0, 0, 0, 0, 1, 0.92, 1.05), W),
    paint(at(sphere(0.38, 8, 6), 0, -0.1, 0.24), 0xd8d0e0),
    paint(at(cone(0.17, 0.45, 4), 0.26, 0.56, 0, 0, 0, -0.35), W),
    paint(at(cone(0.17, 0.45, 4), -0.26, 0.56, 0, 0, 0, 0.35), W),
    ...eyes(0.19, 0.14, 0.46, 0.11, 0xfff07a, 1.6),
    paint(at(cone(0.04, 0.12, 3), 0.09, -0.12, 0.5, Math.PI, 0, 0), 0xffffff, { keep: 1 }),
    paint(at(cone(0.04, 0.12, 3), -0.09, -0.12, 0.5, Math.PI, 0, 0), 0xffffff, { keep: 1 }),
    wing,
    mirrorX(wing),
  ]);
}

/** Glow slime: squashy dome with a shine and big eyes. */
export function slimeGeo(): THREE.BufferGeometry {
  return merge([
    paint(at(sphere(1, 12, 9), 0, 0.78, 0, 0, 0, 0, 1, 0.8, 1), W, { glow: 0.18 }),
    paint(at(sphere(0.62, 9, 7), 0, 0.7, 0.05, 0, 0, 0, 1, 0.8, 1), 0xffffff, { glow: 0.3 }),
    ...eyes(0.32, 0.98, 0.76, 0.18, 0xffffff, 0.5),
    ...eyes(0.32, 0.98, 0.9, 0.09, 0x101018, 0),
    paint(at(sphere(0.2, 6, 5), -0.42, 1.3, 0.38, 0, 0, 0, 1, 0.55, 1), 0xffffff, { keep: 1, glow: 0.9 }),
  ]);
}

/** Lamp beetle: domed shell, dark head, six stepping legs, a glowing abdomen lamp. */
export function beetleGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    paint(at(new THREE.SphereGeometry(0.85, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0.22, 0, 0, 0, 0, 0.92, 0.8, 1.15), W),
    paint(at(box(0.05, 0.05, 1.7), 0, 0.88, 0), 0x2a2020, { keep: 1 }),
    paint(at(cyl(0.8, 0.75, 0.26, 10), 0, 0.17, 0, 0, 0, 0, 1, 1, 1.2), 0x2b2426, { keep: 1 }),
    paint(at(sphere(0.38, 8, 6), 0, 0.35, 0.98), 0x2e2a30, { keep: 1 }),
    ...eyes(0.17, 0.5, 1.25, 0.09, 0xff7050, 1.5),
    paint(at(cone(0.06, 0.3, 4), 0.14, 0.28, 1.32, Math.PI / 2, 0, 0.3), 0x2e2a30, { keep: 1 }),
    paint(at(cone(0.06, 0.3, 4), -0.14, 0.28, 1.32, Math.PI / 2, 0, -0.3), 0x2e2a30, { keep: 1 }),
    paint(at(sphere(0.36, 8, 6), 0, 0.32, -0.95, 0, 0, 0, 1, 0.85, 1), 0xfff0a0, { keep: 1, glow: 1.8 }),
  ];
  for (let k = 0; k < 3; k++) {
    const z = -0.45 + k * 0.45;
    const sgn = k % 2 === 0 ? 1 : -1;
    const leg = paint(at(box(0.62, 0.08, 0.08), 0.95, 0.12, z, 0, 0, -0.45), 0x2b2426, {
      keep: 1,
      bend: (x, _y, _zz, o) => {
        o[2] = 0.18 * sgn * Math.min(1, Math.abs(x) - 0.6 > 0 ? 1 : 0.4);
        o[1] = 0.06 * Math.max(0, Math.abs(x) - 0.7);
      },
    });
    parts.push(leg);
    // the opposite side steps out of phase: mirror then flip the bend z
    const m = mirrorX(leg);
    const b = m.getAttribute('aBend') as THREE.BufferAttribute;
    for (let i = 0; i < b.count; i++) b.setZ(i, -b.getZ(i));
    parts.push(m);
  }
  return merge(parts);
}

/** Mushroom walker: tinted cap with glowing spots, pale stem body, glowing eyes, stubby stepping legs. */
export function shroomGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    paint(at(new THREE.SphereGeometry(1, 12, 7, 0, Math.PI * 2, 0, Math.PI * 0.55), 0, 0.92, 0, 0, 0, 0, 1.12, 0.78, 1.12), W, { glow: 0.22 }),
    paint(at(cyl(1.02, 0.55, 0.14, 12), 0, 0.92, 0), 0xffe5d0, { keep: 1, glow: 0.1 }),
    paint(at(cyl(0.4, 0.5, 0.86, 9), 0, 0.5, 0), 0xf2e2cc, { keep: 1 }),
    ...eyes(0.17, 0.66, 0.43, 0.09, 0xfff070, 1.6),
    paint(at(box(0.22, 0.04, 0.04), 0, 0.5, 0.47), 0x3a2020, { keep: 1 }),
  ];
  const spots: [number, number][] = [[0, 0], [0.7, 0.5], [-0.65, 0.9], [0.4, 2.1], [-0.3, 3.3], [0.8, 4.2], [-0.75, 5.3]];
  for (const [rr, a] of spots) {
    const r = Math.abs(rr) * 0.95;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = 0.92 + 0.78 * Math.sqrt(Math.max(0, 1 - (r / 1.12) * (r / 1.12))) + 0.02;
    parts.push(paint(at(sphere(0.13, 6, 4), x, y, z, 0, 0, 0, 1, 0.5, 1), 0xffffff, { keep: 1, glow: 1.1 }));
  }
  for (const sx of [1, -1]) {
    parts.push(paint(at(cyl(0.13, 0.15, 0.3, 6), 0.22 * sx, 0.13, 0), 0xe0ccb2, {
      keep: 1,
      bend: (_x, y, _z, o) => {
        o[2] = 0.2 * sx * (1 - y / 0.3);
      },
    }));
  }
  return merge(parts);
}

/** Pebble golem: chunky rock body, swinging arms, a glowing crystal heart. */
export function golemGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    paint(at(dode(0.85), 0, 1.05, 0, 0.3, 0.2, 0, 1.12, 1, 0.92), W),
    paint(at(dode(0.42), 0, 1.92, 0.12, 0.5, 0, 0.2), W),
    paint(at(box(0.12, 0.08, 0.06), 0.16, 1.96, 0.5), 0x7ff8ff, { keep: 1, glow: 2 }),
    paint(at(box(0.12, 0.08, 0.06), -0.16, 1.96, 0.5), 0x7ff8ff, { keep: 1, glow: 2 }),
    paint(at(octa(0.26), 0, 1.1, 0.8, 0, 0, 0, 1, 1.3, 1), 0x7ff8ff, { keep: 1, glow: 1.8 }),
    paint(at(box(0.42, 0.5, 0.45), 0.42, 0.26, 0), 0xb0b0b0),
    paint(at(box(0.42, 0.5, 0.45), -0.42, 0.26, 0), 0xb0b0b0),
    paint(at(cone(0.12, 0.35, 5), 0.5, 1.75, -0.1, 0, 0, -0.4), 0x8ff0c0, { keep: 1, glow: 0.8 }),
  ];
  for (const sx of [1, -1]) {
    parts.push(paint(at(dode(0.4), 1.08 * sx, 0.95, 0, 0, 0, 0, 0.8, 1.45, 0.8), W, {
      bend: (_x, y, _z, o) => {
        o[2] = 0.32 * sx * Math.max(0, 1.3 - y);
      },
    }));
  }
  return merge(parts);
}

/** Clump: five bodies squashed together, too many eyes. */
export function clumpGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const blobs: [number, number, number, number][] = [[0, 0.75, 0, 0.75], [0.6, 0.55, 0.25, 0.5], [-0.55, 0.5, 0.3, 0.52], [0.25, 0.5, -0.55, 0.5], [-0.3, 1.3, -0.1, 0.45]];
  blobs.forEach(([x, y, z, r], k) => {
    parts.push(paint(at(sphere(r, 9, 7), x, y, z), k % 2 ? 0xe8e8e8 : W, {
      glow: 0.15,
      bend: (_x, yy, _z, o) => {
        o[1] = 0.07 * (yy - y + r) * (k % 2 ? 1 : -1);
      },
    }));
    const ex = x + 0.14, ey = y + r * 0.35, ez = z + r * 0.85;
    parts.push(paint(at(sphere(0.09, 5, 4), ex, ey, ez), 0xfff07a, { keep: 1, glow: 1.6 }));
    parts.push(paint(at(sphere(0.07, 5, 4), ex - 0.26, ey + 0.05, ez - 0.02), 0xfff07a, { keep: 1, glow: 1.6 }));
  });
  return merge(parts);
}

/** Vault guardian (elite): armoured golem with gold plates, horns and a burning visor. */
export function eliteGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    paint(at(dode(0.8), 0, 1.0, 0, 0, 0.3, 0, 1.15, 1.05, 0.95), W),
    paint(at(box(1.1, 0.5, 0.2), 0, 1.1, 0.72), 0xffd166, { keep: 1, glow: 0.15 }),
    paint(at(box(0.62, 0.55, 0.6), 0, 1.95, 0.05), W),
    paint(at(box(0.5, 0.1, 0.08), 0, 2.0, 0.37), 0xff5a3a, { keep: 1, glow: 2.2 }),
    paint(at(cone(0.12, 0.6, 5), 0.32, 2.4, 0, 0, 0, -0.5), 0xffe6a0, { keep: 1 }),
    paint(at(cone(0.12, 0.6, 5), -0.32, 2.4, 0, 0, 0, 0.5), 0xffe6a0, { keep: 1 }),
    paint(at(box(0.45, 0.5, 0.45), 0.4, 0.25, 0), 0x909090),
    paint(at(box(0.45, 0.5, 0.45), -0.4, 0.25, 0), 0x909090),
    paint(at(cyl(0.55, 0.55, 0.12, 8), -1.15, 1.0, 0.2, 0, 0, Math.PI / 2), 0xffd166, { keep: 1, glow: 0.2 }),
  ];
  parts.push(paint(at(dode(0.42), 1.05, 0.95, 0, 0, 0, 0, 0.85, 1.4, 0.85), W, {
    bend: (_x, y, _z, o) => {
      o[2] = 0.3 * Math.max(0, 1.3 - y);
    },
  }));
  return merge(parts);
}

// ---------------------------------------------------------------------------------------------
// Bosses (radius ~1 at scale 1; scaled by en.r)
// ---------------------------------------------------------------------------------------------

/** The Foreman: a stout mole in a hard hat with a headlamp, swinging a pickaxe. */
function foremanGeo(): THREE.BufferGeometry {
  const parts = [
    paint(at(sphere(1, 12, 9), 0, 1.0, 0, 0, 0, 0, 1, 1.0, 0.95), W),
    paint(at(sphere(0.7, 10, 8), 0, 0.85, 0.42, 0, 0, 0, 1, 0.9, 0.7), 0xffe0c0, { keep: 1 }),
    paint(at(new THREE.SphereGeometry(0.6, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, 1.78, -0.2), 0xe8a417, { keep: 1 }),
    paint(at(cyl(0.78, 0.78, 0.06, 14), 0, 1.78, -0.15), 0xe8a417, { keep: 1 }),
    paint(at(cyl(0.14, 0.17, 0.16, 8), 0, 2.02, 0.32, Math.PI / 2, 0, 0), 0xfffbe0, { keep: 1, glow: 3 }),
    paint(at(sphere(0.2, 8, 6), 0, 1.3, 0.97), 0xff8fa8, { keep: 1, glow: 0.3 }),
    ...eyes(0.3, 1.5, 0.82, 0.09, 0x1a1010, 0),
    paint(at(box(0.3, 0.3, 0.42), 0.45, 0.15, 0.1), 0x5a3a28, { keep: 1 }),
    paint(at(box(0.3, 0.3, 0.42), -0.45, 0.15, 0.1), 0x5a3a28, { keep: 1 }),
  ];
  // pickaxe arm swings
  const swing: BendFn = (_x, y, z, o) => {
    o[2] = 0.35 * Math.max(0, y - 0.6);
    o[1] = -0.15 * Math.max(0, z);
  };
  parts.push(paint(at(cyl(0.22, 0.2, 0.8, 7), 1.02, 1.0, 0.2, 0.6, 0, -0.4), W, { bend: swing }));
  parts.push(paint(at(cyl(0.06, 0.06, 1.7, 6), 1.25, 1.35, 0.55, 1.2, 0, 0), 0x8a5a30, { keep: 1, bend: swing }));
  parts.push(paint(at(cone(0.12, 1.2, 4), 1.25, 1.95, 0.85, 0, 0, Math.PI / 2), 0xc8d0dc, { keep: 1, glow: 0.15, bend: swing }));
  return merge(parts);
}

/** Sporemother: a towering mushroom matron with a frilled skirt, glowing spots, and sporelings. */
function sporemotherGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    paint(at(new THREE.SphereGeometry(1.25, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.6), 0, 1.55, 0, 0, 0, 0, 1, 0.75, 1), W, { glow: 0.3 }),
    paint(at(cyl(1.28, 0.7, 0.2, 14), 0, 1.55, 0), 0xf6dfff, { keep: 1, glow: 0.25 }),
    paint(at(cyl(0.55, 0.85, 1.5, 12), 0, 0.75, 0), 0xf3e6d8, { keep: 1 }),
    paint(at(cyl(0.95, 1.05, 0.35, 14, ), 0, 0.15, 0), W, { glow: 0.1 }),
    ...eyes(0.25, 1.15, 0.62, 0.12, 0xb8ff6a, 2),
    paint(at(box(0.4, 0.06, 0.06), 0, 0.9, 0.7), 0x301828, { keep: 1 }),
  ];
  for (let k = 0; k < 10; k++) {
    const a = k * 2.4;
    const r = 0.35 + (k % 4) * 0.22;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = 1.55 + 0.75 * 1.25 * Math.sqrt(Math.max(0, 1 - (r / 1.25) * (r / 1.25)));
    parts.push(paint(at(sphere(0.15, 6, 4), x, y, z, 0, 0, 0, 1, 0.5, 1), 0xe8ff9a, { keep: 1, glow: 1.6 }));
  }
  for (let k = 0; k < 4; k++) {
    const a = k * 1.57 + 0.6;
    parts.push(paint(at(new THREE.SphereGeometry(0.28, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), Math.cos(a) * 1.3, 0.3, Math.sin(a) * 1.3), W, {
      glow: 0.5,
      bend: (_x, y, _z, o) => {
        o[1] = 0.12 * (y > 0.3 ? 1 : 0);
      },
    }));
    parts.push(paint(at(cyl(0.1, 0.12, 0.3, 6), Math.cos(a) * 1.3, 0.15, Math.sin(a) * 1.3), 0xf3e6d8, { keep: 1 }));
  }
  return merge(parts);
}

/** The Drowned Engine: a riveted boiler on treads with a chimney and one big lamp eye. */
function engineGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    paint(at(cyl(0.85, 0.85, 1.8, 12), 0, 1.05, 0, Math.PI / 2, 0, 0), W),
    paint(at(cyl(0.88, 0.88, 0.12, 12), 0, 1.05, 0.72, Math.PI / 2, 0, 0), 0x8a9aa8, { keep: 1 }),
    paint(at(cyl(0.88, 0.88, 0.12, 12), 0, 1.05, -0.72, Math.PI / 2, 0, 0), 0x8a9aa8, { keep: 1 }),
    paint(at(cyl(0.4, 0.4, 0.2, 12), 0, 1.15, 0.95, Math.PI / 2, 0, 0), 0x2a3440, { keep: 1 }),
    paint(at(sphere(0.3, 10, 8), 0, 1.15, 1.02), 0x9ff6ff, { keep: 1, glow: 3 }),
    paint(at(cyl(0.22, 0.28, 0.9, 8), 0.35, 2.05, -0.4), 0x5a6a78, { keep: 1 }),
    paint(at(cyl(0.3, 0.22, 0.12, 8), 0.35, 2.52, -0.4), 0xff9a4a, { keep: 1, glow: 1.5 }),
    paint(at(box(0.5, 0.45, 2.0), 0.85, 0.25, 0), 0x2a2a30, { keep: 1 }),
    paint(at(box(0.5, 0.45, 2.0), -0.85, 0.25, 0), 0x2a2a30, { keep: 1 }),
  ];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    parts.push(paint(at(sphere(0.07, 4, 3), Math.cos(a) * 0.86, 1.05 + Math.sin(a) * 0.86, 0.4), 0xd0d8e0, { keep: 1 }));
  }
  // pistons pump
  for (const sx of [1, -1]) {
    parts.push(paint(at(cyl(0.12, 0.12, 0.8, 6), 0.95 * sx, 1.0, 0.3, 0, 0, 0), 0xc0c8d0, {
      keep: 1,
      bend: (_x, y, _z, o) => {
        o[1] = 0.25 * (y > 1.0 ? 1 : 0.3) * sx;
      },
    }));
  }
  return merge(parts);
}

/** Prism Warden: a floating crystal heart ringed by shards. */
function prismGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    paint(at(octa(0.95), 0, 1.6, 0, 0, 0.4, 0, 0.9, 1.4, 0.9), W, { glow: 0.55 }),
    paint(at(octa(0.45), 0, 1.6, 0, 0, 0.2, 0, 1, 1.3, 1), 0xffffff, { keep: 1, glow: 2.2 }),
    ...eyes(0.22, 1.75, 0.72, 0.1, 0x2a0a20, 0),
  ];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    parts.push(paint(at(octa(0.28), Math.cos(a) * 1.45, 1.4 + (k % 2) * 0.4, Math.sin(a) * 1.45, 0, a, 0.3, 0.6, 1.5, 0.6), W, {
      glow: 0.7,
      bend: (_x, _y, _z, o) => {
        o[1] = 0.25 * (k % 2 ? 1 : -1);
      },
    }));
  }
  return merge(parts);
}

/** Anvil King: an anvil-bodied tyrant with a molten crown and hammer fists. */
function anvilGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    paint(at(box(1.0, 0.5, 0.8), 0, 0.25, 0), 0x3a3238, { keep: 1 }),
    paint(at(box(0.6, 0.6, 0.55), 0, 0.75, 0), W),
    paint(at(box(2.0, 0.6, 0.95), 0, 1.35, 0), W),
    paint(at(cone(0.42, 0.9, 4), 1.3, 1.35, 0, 0, 0, -Math.PI / 2, 1, 1, 0.8), W),
    paint(at(box(0.9, 0.08, 0.7), 0, 1.68, 0), 0xff7a2a, { keep: 1, glow: 1.6 }),
    ...eyes(0.25, 1.38, 0.49, 0.1, 0xffd040, 2.4),
    paint(at(cyl(0.45, 0.5, 0.25, 8), 0, 1.85, 0), 0xffc040, { keep: 1, glow: 0.6 }),
  ];
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    parts.push(paint(at(cone(0.09, 0.32, 4), Math.cos(a) * 0.38, 2.1, Math.sin(a) * 0.38), 0xffd060, { keep: 1, glow: 1.2 }));
  }
  for (const sx of [1, -1]) {
    parts.push(paint(at(box(0.55, 0.55, 0.55), 1.25 * sx, 0.75, 0.25), 0x2a2228, {
      keep: 1,
      bend: (_x, _y, _z, o) => {
        o[1] = 0.35 * sx;
        o[2] = 0.15;
      },
    }));
  }
  return merge(parts);
}

/** Boss geometries indexed like BOSSES. */
export function bossGeos(): THREE.BufferGeometry[] {
  return [foremanGeo(), sporemotherGeo(), engineGeo(), prismGeo(), anvilGeo()];
}

// ---------------------------------------------------------------------------------------------
// The delver and the lantern
// ---------------------------------------------------------------------------------------------

/** The delver: miner's helmet, blue cloak, red scarf, backpack. Faces +z; legs step (bend scaled by walk). */
export function delverGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const sx of [1, -1]) {
    parts.push(paint(at(box(0.15, 0.2, 0.24), 0.12 * sx, 0.1, 0.03), 0x3b2a20, {
      keep: 1,
      bend: (_x, y, _z, o) => {
        o[2] = 0.12 * sx * (1 - y / 0.25);
        o[1] = 0.04 * sx;
      },
    }));
  }
  parts.push(
    paint(at(cyl(0.2, 0.36, 0.6, 10), 0, 0.46, 0), 0x3d6fd9, { keep: 1 }),
    paint(at(cyl(0.2, 0.2, 0.02, 10), 0, 0.2, 0.0), 0x2a4fa8, { keep: 1 }),
    paint(at(new THREE.TorusGeometry(0.19, 0.075, 5, 10), 0, 0.73, 0, Math.PI / 2, 0, 0), 0xe0483a, { keep: 1 }),
    paint(at(box(0.1, 0.24, 0.04), 0.1, 0.6, 0.2, 0.2, 0, 0.2), 0xe0483a, { keep: 1 }),
    paint(at(sphere(0.27, 12, 9), 0, 0.98, 0), 0xffd3ac, { keep: 1 }),
    paint(at(sphere(0.045, 5, 4), 0.09, 1.0, 0.25), 0x1a1214, { keep: 1 }),
    paint(at(sphere(0.045, 5, 4), -0.09, 1.0, 0.25), 0x1a1214, { keep: 1 }),
    paint(at(sphere(0.05, 5, 4), 0.17, 0.92, 0.2), 0xff9a8a, { keep: 1 }),
    paint(at(sphere(0.05, 5, 4), -0.17, 0.92, 0.2), 0xff9a8a, { keep: 1 }),
    paint(at(new THREE.SphereGeometry(0.3, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, 1.06, -0.01), 0xf2b52c, { keep: 1 }),
    paint(at(cyl(0.38, 0.38, 0.04, 14), 0, 1.07, 0.03), 0xf2b52c, { keep: 1 }),
    paint(at(cyl(0.07, 0.08, 0.06, 8), 0, 1.22, 0.24, Math.PI / 2 - 0.4, 0, 0), 0xfff4c0, { keep: 1, glow: 1.5 }),
    paint(at(box(0.36, 0.38, 0.2), 0, 0.58, -0.26), 0x8a5a34, { keep: 1 }),
    paint(at(box(0.38, 0.1, 0.22), 0, 0.8, -0.26), 0x6a4026, { keep: 1 }),
    paint(at(cyl(0.025, 0.025, 0.85, 5), -0.12, 0.85, -0.38, 0, 0, 0.7), 0x8a5a30, { keep: 1 }),
    paint(at(cone(0.05, 0.35, 4), -0.38, 1.17, -0.38, 0, 0, -0.9), 0xc8d0dc, { keep: 1 }),
    paint(at(cyl(0.06, 0.07, 0.3, 6), 0.3, 0.55, 0.12, 0.3, 0, -0.9), 0x3d6fd9, { keep: 1 }),
  );
  return merge(parts);
}

/** Hand lantern (origin at the handle). The glass glows; the light itself is a point light. */
export function lanternGeo(): THREE.BufferGeometry {
  return merge([
    paint(at(new THREE.TorusGeometry(0.06, 0.015, 4, 8), 0, 0.02, 0), 0x3a3030, { keep: 1 }),
    paint(at(cyl(0.05, 0.1, 0.07, 8), 0, -0.07, 0), 0x40342c, { keep: 1 }),
    paint(at(cyl(0.085, 0.085, 0.16, 8), 0, -0.19, 0), 0xffd27a, { keep: 1, glow: 3.2 }),
    paint(at(cyl(0.1, 0.1, 0.04, 8), 0, -0.29, 0), 0x40342c, { keep: 1 }),
  ]);
}

// ---------------------------------------------------------------------------------------------
// The Wyrm
// ---------------------------------------------------------------------------------------------

/** Wyrm skull (upper head), facing +z, about 2.4 m long at scale 1. */
export function wyrmSkullGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    paint(at(dode(1), 0, 0.55, 0, 0.2, 0.3, 0, 1.15, 0.8, 1.35), W),
    paint(at(box(1.3, 0.45, 1.5), 0, 0.35, 1.0, 0.1, 0, 0), W),
    paint(at(box(1.1, 0.12, 1.3), 0, 0.08, 1.05), 0xff6a20, { keep: 1, glow: 2.5 }),
    ...eyes(0.55, 0.8, 0.95, 0.17, 0xffe040, 3),
    paint(at(cone(0.22, 1.5, 5), 0.6, 1.35, -0.4, -0.9, 0, -0.35), 0xd8c8a8, { keep: 1 }),
    paint(at(cone(0.22, 1.5, 5), -0.6, 1.35, -0.4, -0.9, 0, 0.35), 0xd8c8a8, { keep: 1 }),
    paint(at(cone(0.18, 0.8, 4), 0, 1.25, 0.1, -0.5, 0, 0), 0xd8c8a8, { keep: 1 }),
  ];
  for (let k = 0; k < 5; k++) {
    const x = -0.5 + k * 0.25;
    parts.push(paint(at(cone(0.06, 0.3, 4), x, -0.05, 1.6, Math.PI, 0, 0), 0xfff4e0, { keep: 1 }));
  }
  return merge(parts);
}

/** Wyrm lower jaw (hinged at the origin), facing +z. */
export function wyrmJawGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    paint(at(box(1.15, 0.32, 1.6), 0, -0.16, 0.85), W),
    paint(at(box(0.95, 0.06, 1.3), 0, 0.02, 0.85), 0xff6a20, { keep: 1, glow: 2.5 }),
  ];
  for (let k = 0; k < 4; k++) {
    const x = -0.4 + k * 0.27;
    parts.push(paint(at(cone(0.06, 0.28, 4), x, 0.12, 1.5), 0xfff4e0, { keep: 1 }));
  }
  return merge(parts);
}

/** One neck/body plate of the Wyrm. */
export function wyrmSegGeo(): THREE.BufferGeometry {
  return merge([
    paint(at(dode(1), 0, 0, 0, 0.3, 0.2, 0), W),
    paint(at(cone(0.25, 0.7, 4), 0, 0.95, 0, 0, 0, 0), 0xd8c8a8, { keep: 1 }),
    paint(at(sphere(0.6, 7, 5), 0, -0.3, 0.45), 0xff8a40, { keep: 1, glow: 0.6 }),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Pickups
// ---------------------------------------------------------------------------------------------

/** XP gem: a stretched faceted crystal; tint per tier via instance colour, self-lit. */
export function gemGeo(): THREE.BufferGeometry {
  return merge([
    paint(at(octa(0.2), 0, 0, 0, 0, 0, 0, 0.8, 1.35, 0.8), W, { glow: 0.55 }),
    paint(at(octa(0.09), 0.04, 0.05, 0.08, 0, 0, 0, 0.8, 1.2, 0.8), 0xfff0b0, { keep: 1, glow: 0.8 }),
  ]);
}

/** Treasure chest. */
export function chestGeo(): THREE.BufferGeometry {
  return merge([
    paint(at(box(0.9, 0.5, 0.6), 0, 0.25, 0), 0x8a4a22, { keep: 1 }),
    paint(at(cyl(0.3, 0.3, 0.9, 8, ), 0, 0.5, 0, 0, 0, Math.PI / 2, 1, 1, 1), 0x9a5a2a, { keep: 1 }),
    paint(at(box(0.94, 0.08, 0.64), 0, 0.5, 0), 0xffd166, { keep: 1, glow: 1.6 }),
    paint(at(box(0.08, 0.55, 0.64), 0.3, 0.32, 0), 0xffd166, { keep: 1, glow: 0.4 }),
    paint(at(box(0.08, 0.55, 0.64), -0.3, 0.32, 0), 0xffd166, { keep: 1, glow: 0.4 }),
    paint(at(box(0.16, 0.16, 0.06), 0, 0.42, 0.32), 0xfff0a0, { keep: 1, glow: 1.8 }),
  ]);
}

/** Heal orb: a little glowing heart-ish bauble. */
export function healGeo(): THREE.BufferGeometry {
  return merge([
    paint(at(sphere(0.16, 8, 6), 0.09, 0.05, 0), 0xff6a8a, { keep: 1, glow: 1.4 }),
    paint(at(sphere(0.16, 8, 6), -0.09, 0.05, 0), 0xff6a8a, { keep: 1, glow: 1.4 }),
    paint(at(cone(0.2, 0.26, 8), 0, -0.13, 0, Math.PI, 0, 0), 0xff6a8a, { keep: 1, glow: 1.4 }),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Props (tinted by instance colour where the parts are white)
// ---------------------------------------------------------------------------------------------

export function rockGeo(): THREE.BufferGeometry {
  return merge([paint(at(dode(1), 0, 0.3, 0, 0.3, 0.5, 0.1, 1, 0.7, 1), W)]);
}

export function stalagmiteGeo(): THREE.BufferGeometry {
  return merge([
    paint(at(cone(0.6, 2.6, 6), 0, 1.3, 0), W),
    paint(at(cone(0.35, 1.4, 5), 0.5, 0.7, 0.2, 0, 0, -0.15), 0xe0e0e0),
    paint(at(dode(0.6), 0, 0.15, 0, 0, 0, 0, 1.2, 0.5, 1.2), 0xd0d0d0),
  ]);
}

/** Crystal cluster: tinted, self-lit. */
export function crystalGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const spikes: [number, number, number, number, number][] = [[0, 0, 0, 0, 1.2], [0.28, 0.1, 0.4, -0.35, 0.8], [-0.3, -0.05, -0.3, 0.4, 0.75], [0.1, 0.32, 0.2, 0.3, 0.6], [-0.15, -0.3, -0.35, -0.2, 0.55]];
  for (const [x, z, rx, rz, h] of spikes) {
    parts.push(paint(at(cyl(0.12, 0.16, h, 6), x, h / 2, z, rx, 0, rz), W, { glow: 0.4 }));
    const tipY = h;
    const tip = at(cone(0.12, 0.28, 6), 0, h / 2 + 0.14, 0, 0, 0, 0);
    at(tip, x, tipY / 2, z, rx, 0, rz);
    // tip shares the spike's rotation around its own base: approximate by placing on top
    parts.push(paint(tip, W, { glow: 0.75 }));
  }
  return merge(parts);
}

/** Glowing mushroom (cap tinted + self-lit, white spots). */
export function mushroomGeo(): THREE.BufferGeometry {
  return merge([
    paint(at(cyl(0.09, 0.13, 0.7, 6), 0, 0.35, 0), 0xe8e0d0, { keep: 1, glow: 0.15 }),
    paint(at(new THREE.SphereGeometry(0.42, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0.68, 0, 0, 0, 0, 1, 0.65, 1), W, { glow: 0.55 }),
    paint(at(sphere(0.06, 4, 3), 0.18, 0.88, 0.1), 0xffffff, { keep: 1, glow: 1.4 }),
    paint(at(sphere(0.05, 4, 3), -0.15, 0.86, -0.12), 0xffffff, { keep: 1, glow: 1.4 }),
  ]);
}

/** A short piece of mine rail with sleepers (lies along x, 2 m long). */
export function railGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    paint(at(box(2.0, 0.06, 0.06), 0, 0.09, 0.32), 0x9aa0a8, { keep: 1, glow: 0.05 }),
    paint(at(box(2.0, 0.06, 0.06), 0, 0.09, -0.32), 0x9aa0a8, { keep: 1, glow: 0.05 }),
  ];
  for (let k = 0; k < 4; k++) parts.push(paint(at(box(0.18, 0.06, 0.9), -0.75 + k * 0.5, 0.03, 0), 0x5a3a22, { keep: 1 }));
  return merge(parts);
}

/** Lantern post: timber post with a hanging lamp that glows (tinted). */
export function lampPostGeo(): THREE.BufferGeometry {
  return merge([
    paint(at(box(0.16, 2.2, 0.16), 0, 1.1, 0), 0x5a3a22, { keep: 1 }),
    paint(at(box(0.7, 0.1, 0.1), 0.28, 2.1, 0), 0x5a3a22, { keep: 1 }),
    paint(at(cyl(0.1, 0.12, 0.08, 6), 0.55, 1.88, 0), 0x3a3030, { keep: 1 }),
    paint(at(cyl(0.11, 0.11, 0.2, 6), 0.55, 1.74, 0), W, { glow: 2.4 }),
  ]);
}

/** Timber support frame (two posts and a beam). */
export function timberGeo(): THREE.BufferGeometry {
  return merge([
    paint(at(box(0.2, 2.4, 0.2), -1.0, 1.2, 0, 0, 0, 0.05), 0x6a4428, { keep: 1 }),
    paint(at(box(0.2, 2.4, 0.2), 1.0, 1.2, 0, 0, 0, -0.05), 0x6a4428, { keep: 1 }),
    paint(at(box(2.6, 0.22, 0.24), 0, 2.4, 0), 0x6a4428, { keep: 1 }),
  ]);
}

/** Rusted pipe run with a valve wheel. */
export function pipeGeo(): THREE.BufferGeometry {
  return merge([
    paint(at(cyl(0.22, 0.22, 3, 8), 0, 0.25, 0, 0, 0, Math.PI / 2), 0x6a7480),
    paint(at(cyl(0.28, 0.28, 0.14, 8), 1.0, 0.25, 0, 0, 0, Math.PI / 2), 0x8a6a50),
    paint(at(cyl(0.28, 0.28, 0.14, 8), -1.0, 0.25, 0, 0, 0, Math.PI / 2), 0x8a6a50),
    paint(at(new THREE.TorusGeometry(0.3, 0.05, 4, 10), 0, 0.75, 0), 0xb04a30, { keep: 1 }),
    paint(at(cyl(0.05, 0.05, 0.3, 5), 0, 0.55, 0), 0x6a7480),
  ]);
}

/** Broken gear (lies flat). */
export function gearGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [paint(at(cyl(0.8, 0.8, 0.18, 12), 0, 0.09, 0), W), paint(at(cyl(0.25, 0.25, 0.22, 8), 0, 0.1, 0), 0x404850, { keep: 1 })];
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    parts.push(paint(at(box(0.25, 0.16, 0.25), Math.cos(a) * 0.88, 0.08, Math.sin(a) * 0.88, 0, -a, 0), W));
  }
  return merge(parts);
}

/** Falling rock for the Wyrmfall. */
export function boulderGeo(): THREE.BufferGeometry {
  return merge([
    paint(at(dode(1), 0, 0, 0, 0.4, 0.2, 0.7, 1, 0.85, 1), W),
    paint(at(dode(0.5), 0.4, 0.35, 0.2), 0xd0d0d0),
    paint(at(octa(0.25), -0.45, 0.2, 0.4), 0xff7a2a, { keep: 1, glow: 1.8 }),
  ]);
}

/** Flat unit quad on the floor (XZ), uv 0..1, for decals. */
export function floorQuad(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(2, 2);
  g.rotateX(-Math.PI / 2);
  return g;
}
