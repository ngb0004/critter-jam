import { describe, expect, it } from 'vitest';
import { deriveRng, Rng } from './rng';
import { fnv1a, hashInts, hashString, xxh32 } from './hash';

describe('rng', () => {
  it('is deterministic for a seed', () => {
    const a = new Rng(1234);
    const b = new Rng(1234);
    for (let i = 0; i < 1000; i++) expect(a.u32()).toBe(b.u32());
  });
  it('matches the known mulberry32 sequence', () => {
    const r = new Rng(1);
    // reference values for mulberry32(seed = 1)
    expect([r.u32(), r.u32(), r.u32()]).toEqual([2693262067, 11749833, 2265367787]);
  });
  it('next() is in [0,1) and int(n) in range', () => {
    const r = new Rng(99);
    for (let i = 0; i < 10000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      const k = r.int(7);
      expect(Number.isInteger(k) && k >= 0 && k < 7).toBe(true);
    }
  });
  it('derived streams differ by salt and are stable', () => {
    expect(deriveRng(5, 1).u32()).toBe(deriveRng(5, 1).u32());
    expect(deriveRng(5, 1).u32()).not.toBe(deriveRng(5, 2).u32());
  });
});

describe('hash', () => {
  it('xxh32 matches reference vectors for word input', () => {
    // xxh32 of the empty input with seed 0 is the standard 0x02CC5D05
    expect(xxh32([], 0)).toBe(0x02cc5d05);
    expect(xxh32([1, 2, 3, 4, 5], 7)).toBe(xxh32([1, 2, 3, 4, 5], 7));
    expect(xxh32([1, 2, 3, 4, 5], 7)).not.toBe(xxh32([1, 2, 3, 4, 6], 7));
  });
  it('helpers are stable', () => {
    expect(hashInts(1, 2, 3)).toBe(hashInts(1, 2, 3));
    expect(hashString('firebolt')).toBe(hashString('firebolt'));
    expect(fnv1a(0x811c9dc5, 0)).toBeTypeOf('number');
  });
});
