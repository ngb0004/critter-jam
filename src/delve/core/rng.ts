/**
 * Seeded integer RNG (CORE). mulberry32 state, uint32 outputs.
 * next() divides by 2^32 (exact), so float draws are reproducible on every engine.
 * Streams are derived from hashes; never share one stream across unrelated systems.
 */
import { xxh32 } from './hash';

export class Rng {
  /** Raw state, exposed for state hashing and snapshots. */
  s: number;

  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }

  /** Uniform uint32. */
  u32(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.u32() / 4294967296;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Uniform float in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Index 0..63 direction (for angles use fmath DIR64 tables). */
  dir64(): number {
    return this.u32() & 63;
  }

  /** Angle index into the fmath sine table (0..ANGLES-1). */
  angleIdx(): number {
    return this.u32() & 4095;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
}

/** Derive an independent stream from a seed and integer salts. */
export function deriveRng(seed: number, ...salts: number[]): Rng {
  return new Rng(xxh32([seed, ...salts], 0xde17e));
}
