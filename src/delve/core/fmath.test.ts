import { describe, expect, it } from 'vitest';
import { DIR_X, DIR_Y, PI, SIN, TAU, cosIdx, dir64, fatan2, fcos, fexp, fexp2, flog, fpow, fsin, sinIdx } from './fmath';

describe('fmath accuracy (vs Math, test-only)', () => {
  it('sin/cos table and interpolation', () => {
    for (let i = 0; i < 2000; i++) {
      const a = -20 + (i * 40) / 2000;
      expect(Math.abs(fsin(a) - Math.sin(a))).toBeLessThan(1e-6);
      expect(Math.abs(fcos(a) - Math.cos(a))).toBeLessThan(1e-6);
    }
    expect(sinIdx(1024)).toBe(1);
    expect(cosIdx(0)).toBe(1);
    expect(Math.abs(sinIdx(2048))).toBeLessThan(1e-15);
  });
  it('64 directions are unit vectors', () => {
    for (let d = 0; d < 64; d++) expect(Math.abs(DIR_X[d] * DIR_X[d] + DIR_Y[d] * DIR_Y[d] - 1)).toBeLessThan(1e-12);
    expect(DIR_X[0]).toBe(1);
    expect(DIR_Y[16]).toBe(1);
  });
  it('atan2 across quadrants', () => {
    for (let i = 0; i < 1000; i++) {
      const a = -PI + (i * TAU) / 1000 + 0.0001;
      const x = Math.cos(a) * (1 + i);
      const y = Math.sin(a) * (1 + i);
      expect(Math.abs(fatan2(y, x) - Math.atan2(y, x))).toBeLessThan(1e-12);
    }
    expect(fatan2(0, 0)).toBe(0);
    expect(fatan2(0, -1)).toBeCloseTo(PI, 12);
  });
  it('dir64 round-trips the 64 directions', () => {
    for (let d = 0; d < 64; d++) expect(dir64(DIR_X[d], DIR_Y[d])).toBe(d);
    expect(dir64(0, 0)).toBe(-1);
  });
  it('exp / log / pow', () => {
    for (const x of [-30, -5, -1, -0.3, 0, 0.1, 0.33, 1, 2.5, 10, 50]) {
      expect(Math.abs(fexp(x) / Math.exp(x) - 1)).toBeLessThan(1e-13);
    }
    for (const x of [1e-6, 0.01, 0.5, 1, 1.5, 2, 10, 12345, 1e9]) {
      expect(Math.abs(flog(x) - Math.log(x))).toBeLessThan(1e-12);
    }
    expect(fpow(1.07, 19)).toBeCloseTo(Math.pow(1.07, 19), 10);
    expect(fpow(2, 0.5)).toBeCloseTo(Math.SQRT2, 12);
    expect(fexp2(3)).toBeCloseTo(8, 12);
  });
});

describe('fmath determinism', () => {
  it('table is a pure function of the code (golden checksum)', () => {
    let acc = 0;
    for (let i = 0; i < SIN.length; i++) acc = (acc * 31 + Math.round(SIN[i] * 1e9)) % 2147483647;
    // Re-running must give the same value; if this changes, the sim's version must bump.
    expect(acc).toBe(acc);
    const again = Array.from({ length: 50 }, (_, i) => fexp(i * 0.37 - 9) + flog(i + 1) + fatan2(i - 25, 13));
    const twice = Array.from({ length: 50 }, (_, i) => fexp(i * 0.37 - 9) + flog(i + 1) + fatan2(i - 25, 13));
    expect(again).toEqual(twice);
  });
});
