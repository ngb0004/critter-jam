/**
 * Small presentation-side helpers (RENDER). Nothing here is used by the sim, so ordinary Math is fine.
 * Prop layout uses its own seeded RNG (from the day seed) so every player sees the same cave today.
 */

export const TAU = Math.PI * 2;

/** mulberry32: tiny seeded RNG for deterministic prop layout (presentation only). */
export function rng32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash -> [0, 1). Stable per slot uid (animation phases, sparkle timing). */
export function hash01(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Spell fx id -> colour (linear-ish hex, boosted in shaders). */
export const FX_COLORS: Record<string, number> = {
  fire: 0xff7a2f, poison: 0x8dff5a, storm: 0x7fd4ff, shadow: 0xb070ff, frost: 0xa8e8ff, radiant: 0xffe48a,
  steel: 0xd0d8e8, blade: 0xe8e8f0, plasma: 0xc8e0ff, fever: 0xd0ff40, nightshade: 0x9040ff,
};
/** Spell fx id -> small integer used by the zone shader. */
export const FX_ID: Record<string, number> = {
  fire: 0, poison: 1, storm: 2, shadow: 3, frost: 4, radiant: 5, steel: 6, blade: 6, plasma: 2, fever: 7, nightshade: 3,
};

/** Status colours indexed by ST kind (burn, poison, chill, shock, shadow). */
export const STATUS_COLORS = [0xff6a1a, 0x7dff3a, 0x8fd8ff, 0xbfe8ff, 0x9a4dff, 0xffffff];

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
/** Frame-rate independent exponential approach factor. */
export function damp(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

/**
 * Write a T * Ry(yaw) * Rx(pitch) * Rz(roll) * S matrix straight into an instance-matrix array (no allocation).
 * Positive pitch tips local +z downward (lean forward); yaw rotates local +z toward +x.
 */
export function writeTRS(
  e: Float32Array, i: number, x: number, y: number, z: number,
  yaw: number, pitch: number, roll: number, sx: number, sy: number, sz: number,
): void {
  const cy = Math.cos(yaw), syw = Math.sin(yaw);
  const o = i * 16;
  if (pitch === 0 && roll === 0) {
    e[o] = cy * sx; e[o + 1] = 0; e[o + 2] = -syw * sx; e[o + 3] = 0;
    e[o + 4] = 0; e[o + 5] = sy; e[o + 6] = 0; e[o + 7] = 0;
    e[o + 8] = syw * sz; e[o + 9] = 0; e[o + 10] = cy * sz; e[o + 11] = 0;
  } else {
    const cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
    e[o] = (cy * cr + syw * sp * sr) * sx; e[o + 1] = cp * sr * sx; e[o + 2] = (-syw * cr + cy * sp * sr) * sx; e[o + 3] = 0;
    e[o + 4] = (-cy * sr + syw * sp * cr) * sy; e[o + 5] = cp * cr * sy; e[o + 6] = (syw * sr + cy * sp * cr) * sy; e[o + 7] = 0;
    e[o + 8] = syw * cp * sz; e[o + 9] = -sp * sz; e[o + 10] = cy * cp * sz; e[o + 11] = 0;
  }
  e[o + 12] = x; e[o + 13] = y; e[o + 14] = z; e[o + 15] = 1;
}

/** Write an RGB triple (0..1+, may exceed 1 for bloom) from a hex colour times k. */
export function writeHex(a: Float32Array, i: number, hex: number, k: number): void {
  const o = i * 3;
  a[o] = ((hex >> 16) & 255) / 255 * k;
  a[o + 1] = ((hex >> 8) & 255) / 255 * k;
  a[o + 2] = (hex & 255) / 255 * k;
}

/** Mix two hex colours, returns hex. */
export function mixHex(a: number, b: number, t: number): number {
  const r = Math.round(lerp((a >> 16) & 255, (b >> 16) & 255, t));
  const g = Math.round(lerp((a >> 8) & 255, (b >> 8) & 255, t));
  const bl = Math.round(lerp(a & 255, b & 255, t));
  return (r << 16) | (g << 8) | bl;
}

/**
 * Previous/current snapshot of a pool's positions, for interpolating between sim ticks on
 * high refresh displays. Slots whose uid changed since the last snapshot snap (no lerp).
 */
export class Interp {
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly cx: Float32Array;
  readonly cy: Float32Array;
  readonly uid: Int32Array;
  constructor(cap: number) {
    this.px = new Float32Array(cap);
    this.py = new Float32Array(cap);
    this.cx = new Float32Array(cap);
    this.cy = new Float32Array(cap);
    this.uid = new Int32Array(cap).fill(-1);
  }

  /** Call once per new sim tick (or whenever the world changed). */
  snap(alive: Uint8Array, uid: Int32Array, xs: Float32Array, ys: Float32Array, hi: number): void {
    for (let i = 0; i < hi; i++) {
      if (!alive[i]) continue;
      if (this.uid[i] !== uid[i]) {
        this.uid[i] = uid[i];
        this.px[i] = this.cx[i] = xs[i];
        this.py[i] = this.cy[i] = ys[i];
      } else {
        this.px[i] = this.cx[i];
        this.py[i] = this.cy[i];
        this.cx[i] = xs[i];
        this.cy[i] = ys[i];
      }
    }
  }

  /** Reset (new world). */
  clear(): void {
    this.uid.fill(-1);
  }

  x(i: number, a: number): number {
    return this.px[i] + (this.cx[i] - this.px[i]) * a;
  }
  y(i: number, a: number): number {
    return this.py[i] + (this.cy[i] - this.py[i]) * a;
  }
}

/**
 * The Core's heartbeat, from the sim tick (presentation only; audio and renderer share it so the thump and the
 * vignette pump land together). Returns the seconds into the current beat, or -1 before the Core.
 * The beat quickens from 1.25 s to 0.5 s over the first ~9 minutes of the Core.
 */
export function coreBeatPhase(tick: number): number {
  const sec = tick / 60 - 300;
  if (sec < 0) return -1;
  const period = Math.max(0.5, 1.25 - (sec / 60) * 0.08);
  return sec % period;
}

/** Heartbeat pump 0..~1 (lub-dub), louder the deeper into the Core. */
export function coreHeartbeat(tick: number): number {
  const ph = coreBeatPhase(tick);
  if (ph < 0) return 0;
  const min = (tick / 60 - 300) / 60;
  const lub = Math.exp(-ph * 12);
  const dub = ph > 0.2 ? 0.7 * Math.exp(-(ph - 0.2) * 12) : 0;
  return Math.min(1, lub + dub) * (0.3 + 0.7 * clamp01(min / 7));
}
