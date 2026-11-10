/**
 * Integer hashes for seeds (CORE). xxhash32 over 32-bit words and FNV-1a.
 * Pure integer maths (Math.imul, shifts) so results are identical everywhere.
 */

const P1 = 0x9e3779b1;
const P2 = 0x85ebca77;
const P3 = 0xc2b2ae3d;
const P4 = 0x27d4eb2f;
const P5 = 0x165667b1;

const rotl = (x: number, r: number) => (x << r) | (x >>> (32 - r));

/** xxhash32 of a list of 32-bit words (each word is treated as 4 little-endian bytes). */
export function xxh32(words: ArrayLike<number>, seed = 0): number {
  const n = words.length;
  let i = 0;
  let h: number;
  if (n >= 4) {
    let v1 = (seed + P1 + P2) | 0;
    let v2 = (seed + P2) | 0;
    let v3 = seed | 0;
    let v4 = (seed - P1) | 0;
    for (; i + 4 <= n; i += 4) {
      v1 = Math.imul(rotl((v1 + Math.imul(words[i] | 0, P2)) | 0, 13), P1);
      v2 = Math.imul(rotl((v2 + Math.imul(words[i + 1] | 0, P2)) | 0, 13), P1);
      v3 = Math.imul(rotl((v3 + Math.imul(words[i + 2] | 0, P2)) | 0, 13), P1);
      v4 = Math.imul(rotl((v4 + Math.imul(words[i + 3] | 0, P2)) | 0, 13), P1);
    }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) | 0;
  } else {
    h = (seed + P5) | 0;
  }
  h = (h + n * 4) | 0;
  for (; i < n; i++) {
    h = (h + Math.imul(words[i] | 0, P3)) | 0;
    h = Math.imul(rotl(h, 17), P4);
  }
  h ^= h >>> 15;
  h = Math.imul(h, P2);
  h ^= h >>> 13;
  h = Math.imul(h, P3);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Convenience: hash any number of integer parts. Allocates a tiny array; do not call per enemy per tick. */
export function hashInts(...parts: number[]): number {
  return xxh32(parts, 0x5eed);
}

/** FNV-1a step over one 32-bit word (used for rolling history hashes). */
export function fnv1a(h: number, word: number): number {
  let x = h >>> 0;
  for (let k = 0; k < 4; k++) {
    x ^= (word >>> (k * 8)) & 0xff;
    x = Math.imul(x, 0x01000193);
  }
  return x >>> 0;
}

export const FNV_SEED = 0x811c9dc5;

/** Stable 32-bit hash of a string (content ids, salts). */
export function hashString(s: string, seed = 0): number {
  let h = (FNV_SEED ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return xxh32([h], seed);
}

/** Incremental hasher for state hashes (replay verification). Feeds raw float bits. */
export class StateHasher {
  private h = FNV_SEED;
  private readonly f64 = new Float64Array(1);
  private readonly u32 = new Uint32Array(this.f64.buffer);

  int(v: number): this {
    this.h = fnv1a(this.h, v | 0);
    return this;
  }
  num(v: number): this {
    this.f64[0] = v;
    this.h = fnv1a(fnv1a(this.h, this.u32[0]), this.u32[1]);
    return this;
  }
  /** Hash the raw bytes of a typed array (first `len` elements). */
  array(a: Float32Array | Int32Array | Uint8Array | Int16Array | Uint16Array | Int8Array | Float64Array, len = a.length): this {
    const bytes = new Uint8Array(a.buffer, a.byteOffset, len * a.BYTES_PER_ELEMENT);
    let h = this.h;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193);
    }
    this.h = h >>> 0;
    return this;
  }
  digest(): number {
    return xxh32([this.h], 0x7a11) >>> 0;
  }
}
