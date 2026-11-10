/**
 * Deterministic maths for the simulation (CORE).
 *
 * The sim may use + - * / and Math.sqrt, Math.floor/ceil/round/trunc/abs/min/max/imul/fround/sign
 * (all exactly specified by IEEE-754 / ECMAScript). Everything transcendental goes through here:
 * Math.sin/cos/tan/exp/log/pow/atan2/hypot and the `**` operator are NOT bit-identical across
 * browsers and are banned in sim/, content/ and core/ (see lint.test.ts).
 *
 * Tables are generated at load time with Taylor series using only + - * /, so they are identical
 * on every engine.
 */

export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;
export const LN2 = 0.6931471805599453;
export const SQRT2 = 1.4142135623730951;

/** Sine table resolution: angles per full turn. */
export const ANGLES = 4096;
const ANGLE_MASK = ANGLES - 1;
const RAD_TO_IDX = ANGLES / TAU;

/** sin via Taylor series for |x| <= PI/2 (deterministic, ~1e-16). */
function taylorSin(x: number): number {
  const x2 = x * x;
  let term = x;
  let sum = x;
  for (let k = 1; k < 12; k++) {
    term = (-term * x2) / ((2 * k) * (2 * k + 1));
    sum += term;
  }
  return sum;
}

/** SIN[i] = sin(i * TAU / ANGLES), one extra entry for interpolation. */
export const SIN = new Float64Array(ANGLES + 1);
for (let i = 0; i <= ANGLES; i++) {
  // reduce to [-PI/2, PI/2] by quadrant symmetry using exact integer arithmetic
  const q = i & ANGLE_MASK;
  const quarter = ANGLES / 4;
  let v: number;
  if (q <= quarter) v = taylorSin((q * TAU) / ANGLES);
  else if (q <= 2 * quarter) v = taylorSin(((2 * quarter - q) * TAU) / ANGLES);
  else if (q <= 3 * quarter) v = -taylorSin(((q - 2 * quarter) * TAU) / ANGLES);
  else v = -taylorSin(((ANGLES - q) * TAU) / ANGLES);
  SIN[i] = v > 1 ? 1 : v < -1 ? -1 : v;
}

/** sin of an integer table angle (0..ANGLES-1, wraps). */
export function sinIdx(i: number): number {
  return SIN[i & ANGLE_MASK];
}
/** cos of an integer table angle (wraps). */
export function cosIdx(i: number): number {
  return SIN[(i + ANGLES / 4) & ANGLE_MASK];
}

/** sin(rad) with linear interpolation between table entries (max error ~3e-7). */
export function fsin(rad: number): number {
  const f = rad * RAD_TO_IDX;
  const fl = Math.floor(f);
  const t = f - fl;
  const i = fl & ANGLE_MASK;
  return SIN[i] + (SIN[i + 1] - SIN[i]) * t;
}
export function fcos(rad: number): number {
  return fsin(rad + HALF_PI);
}

/** 64 input directions: DIR_X[d], DIR_Y[d] for d = 0..63, angle = d * TAU / 64, d = 0 is +x, 16 is +y. */
export const DIR_X = new Float64Array(64);
export const DIR_Y = new Float64Array(64);
for (let d = 0; d < 64; d++) {
  DIR_X[d] = cosIdx(d * 64);
  DIR_Y[d] = sinIdx(d * 64);
}

/** atan(z) for |z| <= 1 by one half-angle reduction and a Taylor series. */
function atanUnit(z: number): number {
  // atan(z) = 2 atan(z / (1 + sqrt(1 + z^2))) ; brings |z| <= tan(PI/8)
  const r = z / (1 + Math.sqrt(1 + z * z));
  const r2 = r * r;
  let term = r;
  let sum = r;
  for (let k = 1; k < 16; k++) {
    term = -term * r2;
    sum += term / (2 * k + 1);
  }
  return 2 * sum;
}

/** Deterministic atan2(y, x) in (-PI, PI]. */
export function fatan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  let a: number;
  if (ax >= ay) a = atanUnit(ay / ax);
  else a = HALF_PI - atanUnit(ax / ay);
  if (x < 0) a = PI - a;
  return y < 0 ? -a : a;
}

/** Quantise a direction vector to one of 64 directions (0..63). Returns -1 for the zero vector. */
export function dir64(x: number, y: number): number {
  if (x === 0 && y === 0) return -1;
  let a = fatan2(y, x);
  if (a < 0) a += TAU;
  return Math.round((a * 64) / TAU) & 63;
}

/** Exact 2^k for integer k (repeated doubling is exact in binary floating point). */
function pow2i(k: number): number {
  let r = 1;
  if (k >= 0) for (let i = 0; i < k; i++) r *= 2;
  else for (let i = 0; i < -k; i++) r *= 0.5;
  return r;
}

/** Deterministic e^x (relative error ~1e-15). Clamped to avoid Infinity. */
export function fexp(x: number): number {
  if (x > 700) x = 700;
  if (x < -700) return 0;
  const k = Math.round(x / LN2);
  const r = x - k * LN2;
  // Taylor for |r| <= 0.347
  let term = 1;
  let sum = 1;
  for (let n = 1; n < 18; n++) {
    term = (term * r) / n;
    sum += term;
  }
  return sum * pow2i(k);
}

/** Deterministic natural log for x > 0 (returns -Infinity for 0, NaN for negatives). */
export function flog(x: number): number {
  if (!(x > 0)) return x === 0 ? -Infinity : NaN;
  let e = 0;
  let m = x;
  while (m >= 2) {
    m *= 0.5;
    e++;
  }
  while (m < 1) {
    m *= 2;
    e--;
  }
  if (m > SQRT2) {
    m *= 0.5;
    e++;
  }
  // ln(m) = 2 atanh(s), s = (m-1)/(m+1), |s| <= 0.1716
  const s = (m - 1) / (m + 1);
  const s2 = s * s;
  let term = s;
  let sum = s;
  for (let k = 1; k < 20; k++) {
    term *= s2;
    sum += term / (2 * k + 1);
  }
  return 2 * sum + e * LN2;
}

/** Deterministic a^b for a > 0 (and a = 0 -> 0). Integer exponents of any base use repeated squaring. */
export function fpow(a: number, b: number): number {
  if (b === 0) return 1;
  if (Number.isInteger(b) && Math.abs(b) <= 64) {
    let r = 1;
    let base = b < 0 ? 1 / a : a;
    let n = Math.abs(b);
    while (n > 0) {
      if (n & 1) r *= base;
      base *= base;
      n >>= 1;
    }
    return r;
  }
  if (a <= 0) return 0;
  return fexp(b * flog(a));
}

/** 2^x, used by the Wyrmfall breath clock. */
export function fexp2(x: number): number {
  return fexp(x * LN2);
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Squared distance; prefer it over a sqrt when comparing against a radius. */
export const dist2 = (ax: number, ay: number, bx: number, by: number): number => {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
};
