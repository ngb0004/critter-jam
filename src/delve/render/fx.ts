/**
 * Pooled presentation effects (RENDER). All pools are fixed-size ring buffers allocated once; spawning
 * overwrites the oldest entry when full, so a busy frame never allocates or stalls.
 *
 *  Particles  one THREE.Points draw: sparks, embers, death pops, trails, motes
 *  Glows      camera-facing additive billboards (soft) and sparkles (4-point star), rebuilt every frame
 *             from transient emitters (projectiles, gems, wisps) plus short-lived flashes
 *  Rings      expanding floor shock rings (splash, fusion shockwave, level-up, boss slam)
 *  Beams      flat additive segments (chain lightning, dash streaks)
 *  Numbers    damage numbers from a digit atlas (one draw)
 */
import * as THREE from 'three';
import { beamMaterial, digitMaterial, glowMaterial, particleMaterial, ringMaterial } from './materials';
import { floorQuad } from './geo';
import { writeTRS } from './util';

export class Particles {
  readonly points: THREE.Points;
  readonly cap: number;
  private head = 0;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly vel: Float32Array;
  private readonly base: Float32Array; // rgb at full alpha
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size0: Float32Array;
  private readonly grav: Float32Array;
  private readonly drag: Float32Array;
  private hiWater = 0;
  readonly mat: THREE.ShaderMaterial;
  /** Burst-count multiplier (the renderer lowers it with the quality level). */
  scale = 1;

  constructor(cap: number) {
    this.cap = cap;
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 3);
    this.size = new Float32Array(cap);
    this.vel = new Float32Array(cap * 3);
    this.base = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.size0 = new Float32Array(cap);
    this.grav = new Float32Array(cap);
    this.drag = new Float32Array(cap);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.mat = particleMaterial();
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  /** Spawn one particle (sim coords x, y; height z). colour hex, intensity k. */
  emit(x: number, h: number, y: number, vx: number, vh: number, vy: number, hex: number, k: number, size: number, life: number, grav = 0, drag = 0): void {
    const i = this.head;
    this.head = (i + 1) % this.cap;
    if (this.head > this.hiWater) this.hiWater = this.head;
    if (i + 1 > this.hiWater) this.hiWater = i + 1;
    const o = i * 3;
    this.pos[o] = x;
    this.pos[o + 1] = h;
    this.pos[o + 2] = -y;
    this.vel[o] = vx;
    this.vel[o + 1] = vh;
    this.vel[o + 2] = -vy;
    this.base[o] = ((hex >> 16) & 255) / 255 * k;
    this.base[o + 1] = ((hex >> 8) & 255) / 255 * k;
    this.base[o + 2] = (hex & 255) / 255 * k;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size0[i] = size;
    this.grav[i] = grav;
    this.drag[i] = drag;
  }

  /** Radial burst. */
  burst(x: number, h: number, y: number, n: number, speed: number, up: number, hex: number, k: number, size: number, life: number, grav = -9): void {
    const m = Math.ceil(n * this.scale);
    for (let j = 0; j < m; j++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.35 + Math.random() * 0.65);
      this.emit(x, h, y, Math.cos(a) * s, up * (0.4 + Math.random() * 0.8), Math.sin(a) * s, hex, k * (0.6 + Math.random() * 0.5), size * (0.6 + Math.random() * 0.7), life * (0.6 + Math.random() * 0.6), grav, 2.5);
    }
  }

  update(dt: number): void {
    const n = this.hiWater;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      if (this.life[i] <= 0) {
        this.size[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const t = Math.max(0, this.life[i] / this.maxLife[i]);
      const dr = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[o] *= dr;
      this.vel[o + 2] *= dr;
      this.vel[o + 1] = this.vel[o + 1] * dr + this.grav[i] * dt;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      if (this.pos[o + 1] < 0.02 && this.grav[i] < 0) {
        this.pos[o + 1] = 0.02;
        this.vel[o + 1] *= -0.35;
      }
      const a = t < 0.6 ? t / 0.6 : 1;
      this.col[o] = this.base[o] * a;
      this.col[o + 1] = this.base[o + 1] * a;
      this.col[o + 2] = this.base[o + 2] * a;
      this.size[i] = this.size0[i] * (0.4 + 0.6 * t);
    }
    const g = this.points.geometry;
    g.setDrawRange(0, n);
    (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.size as THREE.BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    this.size.fill(0);
  }
}

/** Billboard sprite batch rebuilt every frame: call begin(), add() many, end(). */
export class SpriteBatch {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  private readonly e: Float32Array;
  private readonly c: Float32Array;
  constructor(cap: number, shape: 0 | 1) {
    const g = new THREE.PlaneGeometry(1, 1);
    this.mesh = new THREE.InstancedMesh(g, glowMaterial(shape), cap);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.e = this.mesh.instanceMatrix.array as Float32Array;
    this.c = this.mesh.instanceColor.array as Float32Array;
  }
  begin(): void {
    this.n = 0;
  }
  /** Sim coords; size = diameter in metres; colour hex x intensity. */
  add(x: number, h: number, y: number, size: number, hex: number, k: number): void {
    const i = this.n;
    if (i >= this.mesh.instanceMatrix.count) return;
    this.n = i + 1;
    const o = i * 16;
    const e = this.e;
    e[o] = size; e[o + 1] = 0; e[o + 2] = 0; e[o + 3] = 0;
    e[o + 4] = 0; e[o + 5] = size; e[o + 6] = 0; e[o + 7] = 0;
    e[o + 8] = 0; e[o + 9] = 0; e[o + 10] = size; e[o + 11] = 0;
    e[o + 12] = x; e[o + 13] = h; e[o + 14] = -y; e[o + 15] = 1;
    const c = i * 3;
    this.c[c] = ((hex >> 16) & 255) / 255 * k;
    this.c[c + 1] = ((hex >> 8) & 255) / 255 * k;
    this.c[c + 2] = (hex & 255) / 255 * k;
  }
  end(): void {
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }
  get count(): number {
    return this.n;
  }
}

/** Short-lived glows (hit flashes, muzzle flashes, impacts) feeding a SpriteBatch each frame. */
export class Flashes {
  private readonly cap: number;
  private head = 0;
  private readonly d: Float32Array; // x, h, y, size0, size1, life, maxLife, hex, k
  constructor(cap: number) {
    this.cap = cap;
    this.d = new Float32Array(cap * 9);
  }
  add(x: number, h: number, y: number, size0: number, size1: number, life: number, hex: number, k: number): void {
    const o = this.head * 9;
    this.head = (this.head + 1) % this.cap;
    const d = this.d;
    d[o] = x; d[o + 1] = h; d[o + 2] = y; d[o + 3] = size0; d[o + 4] = size1; d[o + 5] = life; d[o + 6] = life; d[o + 7] = hex; d[o + 8] = k;
  }
  update(dt: number, out: SpriteBatch): void {
    const d = this.d;
    for (let i = 0; i < this.cap; i++) {
      const o = i * 9;
      if (d[o + 5] <= 0) continue;
      d[o + 5] -= dt;
      const t = Math.max(0, d[o + 5] / d[o + 6]);
      out.add(d[o], d[o + 1], d[o + 2], d[o + 4] + (d[o + 3] - d[o + 4]) * t, d[o + 7], d[o + 8] * t);
    }
  }
  clear(): void {
    for (let i = 0; i < this.cap; i++) this.d[i * 9 + 5] = 0;
  }
}

/** Instanced flat decals with a per-instance vec4 aA (rings and beams share this). */
class FlatPool {
  readonly mesh: THREE.InstancedMesh;
  protected readonly a: THREE.InstancedBufferAttribute;
  protected readonly cap: number;
  protected head = 0;
  protected readonly life: Float32Array;
  protected readonly maxLife: Float32Array;
  constructor(cap: number, geo: THREE.BufferGeometry, mat: THREE.Material) {
    this.cap = cap;
    this.a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aA', this.a);
    geo.setAttribute('aB', new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4));
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
  }
}

export class Rings extends FlatPool {
  private readonly d: Float32Array; // x, h, y, r0, r1, thick, k, hex
  constructor(cap: number) {
    super(cap, floorQuad(), ringMaterial());
    this.d = new Float32Array(cap * 8);
    this.mesh.renderOrder = 4;
  }
  add(x: number, y: number, r0: number, r1: number, life: number, hex: number, k: number, thick = 0.25, h = 0.06): void {
    const i = this.head;
    this.head = (i + 1) % this.cap;
    const o = i * 8;
    const d = this.d;
    d[o] = x; d[o + 1] = h; d[o + 2] = y; d[o + 3] = r0; d[o + 4] = r1; d[o + 5] = thick; d[o + 6] = k; d[o + 7] = hex;
    this.life[i] = life;
    this.maxLife[i] = life;
  }
  update(dt: number): void {
    const e = this.mesh.instanceMatrix.array as Float32Array;
    const c = this.mesh.instanceColor!.array as Float32Array;
    const a = this.a.array as Float32Array;
    let n = 0;
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const prog = 1 - Math.max(0, this.life[i] / this.maxLife[i]);
      const o = i * 8;
      const d = this.d;
      const ease = 1 - (1 - prog) * (1 - prog) * (1 - prog);
      const r = d[o + 3] + (d[o + 4] - d[o + 3]) * ease;
      writeTRS(e, n, d[o], d[o + 1], -d[o + 2], 0, 0, 0, r, 1, r);
      const hex = d[o + 7];
      c[n * 3] = ((hex >> 16) & 255) / 255;
      c[n * 3 + 1] = ((hex >> 8) & 255) / 255;
      c[n * 3 + 2] = (hex & 255) / 255;
      a[n * 4] = prog;
      a[n * 4 + 1] = d[o + 5];
      a[n * 4 + 2] = d[o + 6];
      n++;
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
    this.a.needsUpdate = true;
  }
  clear(): void {
    this.life.fill(0);
  }
}

export class Beams extends FlatPool {
  private readonly d: Float32Array; // x0, y0, x1, y1, h, width, hex, k
  constructor(cap: number) {
    const g = new THREE.PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2);
    g.translate(0.5, 0, 0);
    super(cap, g, beamMaterial());
    this.d = new Float32Array(cap * 8);
    this.mesh.renderOrder = 6;
  }
  add(x0: number, y0: number, x1: number, y1: number, h: number, width: number, life: number, hex: number, k: number): void {
    const i = this.head;
    this.head = (i + 1) % this.cap;
    const o = i * 8;
    const d = this.d;
    d[o] = x0; d[o + 1] = y0; d[o + 2] = x1; d[o + 3] = y1; d[o + 4] = h; d[o + 5] = width; d[o + 6] = hex; d[o + 7] = k;
    this.life[i] = life;
    this.maxLife[i] = life;
  }
  /** A jagged lightning bolt from a to b made of `segs` beams. */
  bolt(x0: number, y0: number, x1: number, y1: number, h: number, hex: number, k: number, life = 0.2, width = 0.32, segs = 5): void {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = -dy / len, ny = dx / len;
    let px = x0, py = y0;
    for (let s = 1; s <= segs; s++) {
      const t = s / segs;
      const j = s === segs ? 0 : (Math.random() - 0.5) * Math.min(1.4, len * 0.25);
      const qx = x0 + dx * t + nx * j, qy = y0 + dy * t + ny * j;
      this.add(px, py, qx, qy, h, width, life, hex, k);
      this.add(px, py, qx, qy, h, width * 0.35, life * 0.7, 0xffffff, k);
      px = qx;
      py = qy;
    }
  }
  update(dt: number): void {
    const e = this.mesh.instanceMatrix.array as Float32Array;
    const c = this.mesh.instanceColor!.array as Float32Array;
    const a = this.a.array as Float32Array;
    let n = 0;
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const t = Math.max(0, this.life[i] / this.maxLife[i]);
      const o = i * 8;
      const d = this.d;
      const dx = d[o + 2] - d[o], dy = d[o + 3] - d[o + 1];
      const len = Math.sqrt(dx * dx + dy * dy);
      // local +x along the segment: three dir (dx, -dy) -> yaw = atan2(dy, dx) rotating +x toward -z
      const yaw = Math.atan2(dy, dx) - Math.PI / 2;
      writeTRS(e, n, d[o], d[o + 4], -d[o + 1], yaw + Math.PI / 2, 0, 0, len, 1, d[o + 5] * (0.6 + 0.4 * t));
      const hex = d[o + 6];
      c[n * 3] = ((hex >> 16) & 255) / 255;
      c[n * 3 + 1] = ((hex >> 8) & 255) / 255;
      c[n * 3 + 2] = (hex & 255) / 255;
      a[n * 4] = t * d[o + 7] * (0.7 + Math.random() * 0.3);
      n++;
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
    this.a.needsUpdate = true;
  }
  clear(): void {
    this.life.fill(0);
  }
}

/** Digit atlas: 11 cells (0-9 and '!'), r = fill, g = outline. */
function digitAtlas(): THREE.CanvasTexture {
  const cw = 64, ch = 80;
  const c = document.createElement('canvas');
  c.width = cw * 11;
  c.height = ch;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  g.font = '900 66px system-ui, -apple-system, "Segoe UI", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  const chars = '0123456789!';
  for (let i = 0; i < 11; i++) {
    const x = i * cw + cw / 2, y = ch / 2 + 3;
    g.strokeStyle = 'rgb(0,255,0)';
    g.lineWidth = 12;
    g.strokeText(chars[i], x, y);
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = 'rgb(255,0,0)';
    g.fillText(chars[i], x, y);
    g.globalCompositeOperation = 'source-over';
  }
  const t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}

const MAX_DIGITS = 6; // 5 digits + an optional '!' on crits
const NS = 13; // floats per number: x, h, y, vx, vh, life, maxLife, value, hex, size, crit, alpha mult, key

export class DamageNumbers {
  readonly mesh: THREE.InstancedMesh;
  private readonly cap: number;
  private head = 0;
  private readonly d: Float32Array;
  private readonly a: THREE.InstancedBufferAttribute;
  /** Spawns allowed this frame (budget keeps a crowd from turning into soup). */
  budget = 0;
  /** The delver's floor position: numbers fade out right around it so they never cover the delver. */
  px = 0;
  py = 0;
  /** Running typical hit size (EMA), so sizes read relative to the build's current power. */
  private ref = 20;
  /** Per enemy slot: the live number that hits on it fold into (aggregation), or -1. */
  private readonly byKey = new Int16Array(1024).fill(-1);

  constructor(cap: number) {
    this.cap = cap;
    this.d = new Float32Array(cap * NS);
    const g = new THREE.PlaneGeometry(0.62, 0.78);
    this.a = new THREE.InstancedBufferAttribute(new Float32Array(cap * MAX_DIGITS * 4), 4);
    this.a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aA', this.a);
    this.mesh = new THREE.InstancedMesh(g, digitMaterial(digitAtlas()), cap * MAX_DIGITS);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * MAX_DIGITS * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.count = 0;
  }

  /**
   * A hit on enemy slot `key` (or -1). Hits on the same critter within ~0.45 s fold into one number that ticks up and
   * re-pops; sizes follow the hit relative to the running typical hit (small chip damage is small and dim); new numbers
   * only spawn while the budget allows, so a 400-critter Core reads as a few numbers, not soup.
   */
  hit(key: number, x: number, h: number, y: number, value: number, hex: number, crit: boolean, dot: boolean): void {
    if (value < 1) return;
    if (!dot) this.ref += (value - this.ref) * 0.03;
    const d = this.d;
    const k = key >= 0 && key < 1024 ? key : -1;
    if (k >= 0) {
      const j = this.byKey[k];
      if (j >= 0) {
        const o = j * NS;
        const age = d[o + 6] - d[o + 5];
        // a target under constant fire (the Wyrm) re-pops forever: once the total would pass 5 digits, start a fresh
        // number instead of pinning at "99999" (v0.2 review)
        if (d[o + 5] > 0 && d[o + 12] === k && age < 0.45 && d[o + 7] + value <= 99999) {
          d[o + 7] = d[o + 7] + value;
          if (crit) d[o + 10] = 1;
          if (d[o + 10]) d[o + 8] = 0xffd23a;
          else if (!dot) d[o + 8] = hex;
          d[o + 9] = this.sizeFor(d[o + 7], d[o + 10] > 0, false);
          d[o + 11] = 1;
          // re-pop and hold: a number that keeps climbing stays readable
          d[o + 5] = Math.max(d[o + 5], d[o + 6] - 0.06);
          return;
        }
      }
    }
    if (this.budget <= 0) return;
    // tiny DoT ticks never get their own number unless budget is plentiful
    if (dot && value < this.ref * 0.25 && this.budget < 2) return;
    const life = crit ? 0.9 : dot ? 0.55 : 0.7;
    const j = this.add(x, h, y, value, crit ? 0xffd23a : hex, this.sizeFor(value, crit, dot), life, crit ? 1 : 0);
    if (j < 0) return;
    const o = j * NS;
    d[o + 11] = value < this.ref * 0.35 && !crit ? 0.7 : 1;
    d[o + 12] = k;
    if (k >= 0) this.byKey[k] = j;
  }

  private sizeFor(v: number, crit: boolean, dot: boolean): number {
    const lr = Math.log2(Math.max(0.05, v / Math.max(1, this.ref)));
    const base = crit ? 0.72 : dot ? 0.38 : 0.48;
    return base * Math.max(0.55, Math.min(crit ? 1.35 : 1.15, 1 + 0.2 * lr));
  }

  /** crit = 1 adds a '!' and a bigger pop with a wobble. Returns the number's index or -1. */
  add(x: number, h: number, y: number, value: number, hex: number, size: number, life = 0.75, crit = 0): number {
    if (this.budget <= 0) return -1;
    const v = Math.round(value);
    if (v <= 0) return -1;
    this.budget--;
    const idx = this.head;
    const o = this.head * NS;
    this.head = (this.head + 1) % this.cap;
    const d = this.d;
    d[o] = x + (Math.random() - 0.5) * 0.6; d[o + 1] = h + Math.random() * 0.3; d[o + 2] = y + (Math.random() - 0.5) * 0.3;
    d[o + 3] = (Math.random() - 0.5) * 1.4; d[o + 4] = crit ? 3.4 : 2.6;
    d[o + 5] = life; d[o + 6] = life; d[o + 7] = Math.min(99999, v); d[o + 8] = hex; d[o + 9] = size; d[o + 10] = crit;
    d[o + 11] = 1; d[o + 12] = -1;
    return idx;
  }

  update(dt: number): void {
    const e = this.mesh.instanceMatrix.array as Float32Array;
    const c = this.mesh.instanceColor!.array as Float32Array;
    const a = this.a.array as Float32Array;
    const d = this.d;
    const slow = Math.max(0, 1 - 3.2 * dt);
    let n = 0;
    for (let i = 0; i < this.cap; i++) {
      const o = i * NS;
      if (d[o + 5] <= 0) continue;
      d[o + 5] -= dt;
      const t = Math.max(0, d[o + 5] / d[o + 6]);
      const age = d[o + 6] - d[o + 5];
      // float up and settle (ease-out), drifting a little sideways
      d[o + 4] *= slow;
      d[o + 3] *= slow;
      d[o] += d[o + 3] * dt;
      d[o + 1] += d[o + 4] * dt;
      const crit = d[o + 10] > 0;
      // pop: overshoot in over ~0.1 s, settle, then shrink away at the end
      const pin = age < 0.11 ? age / 0.11 : 1;
      const pop = pin < 1 ? 0.4 + 1.25 * pin * (2 - pin) * (crit ? 1.25 : 1) : 1 + (crit ? 0.25 : 0.12) * Math.max(0, 1 - (age - 0.11) * 6);
      const s = d[o + 9] * pop * (t < 0.25 ? 0.7 + 1.2 * t : 1);
      const pdx = d[o] - this.px, pdy = d[o + 2] - this.py;
      const pd = Math.sqrt(pdx * pdx + pdy * pdy);
      const clearK = pd >= 2.2 ? 1 : pd <= 1.0 ? 0 : (pd - 1.0) / 1.2;
      const alpha = (t < 0.3 ? t / 0.3 : 1) * d[o + 11] * clearK;
      if (alpha < 0.02) continue;
      const v = Math.round(d[o + 7]);
      const digits = v >= 10000 ? 5 : v >= 1000 ? 4 : v >= 100 ? 3 : v >= 10 ? 2 : 1;
      const glyphs = digits + (crit ? 1 : 0);
      const wob = crit && age < 0.35 ? Math.sin(age * 60) * 0.06 * (1 - age / 0.35) : 0;
      let rem = v;
      const hex = d[o + 8];
      for (let k = glyphs - 1; k >= 0; k--) {
        let dg: number;
        if (crit && k === glyphs - 1) dg = 10;
        else {
          dg = rem % 10;
          rem = Math.floor(rem / 10);
        }
        const j = n++;
        const m = j * 16;
        e[m] = s; e[m + 1] = 0; e[m + 2] = 0; e[m + 3] = 0;
        e[m + 4] = 0; e[m + 5] = s; e[m + 6] = 0; e[m + 7] = 0;
        e[m + 8] = 0; e[m + 9] = 0; e[m + 10] = s; e[m + 11] = 0;
        e[m + 12] = d[o]; e[m + 13] = d[o + 1]; e[m + 14] = -d[o + 2]; e[m + 15] = 1;
        a[j * 4] = dg;
        a[j * 4 + 1] = alpha;
        a[j * 4 + 2] = k - (glyphs - 1) / 2 + (crit && k === glyphs - 1 ? -0.25 : 0);
        a[j * 4 + 3] = wob;
        c[j * 3] = ((hex >> 16) & 255) / 255;
        c[j * 3 + 1] = ((hex >> 8) & 255) / 255;
        c[j * 3 + 2] = (hex & 255) / 255;
      }
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
    this.a.needsUpdate = true;
  }

  clear(): void {
    for (let i = 0; i < this.cap; i++) this.d[i * NS + 5] = 0;
    this.byKey.fill(-1);
  }
}
