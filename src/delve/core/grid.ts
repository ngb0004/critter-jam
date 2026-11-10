/**
 * Uniform spatial hash for enemies (CORE). Rebuilt once per tick by world.step after enemies move
 * (counting sort, no allocation). Queries return candidate enemy slots; callers do the exact
 * distance test and the alive check (an enemy killed earlier this tick is still listed).
 */
import { WORLD } from './constants';

export class Grid {
  readonly cell: number;
  readonly dim: number;
  readonly origin: number;
  readonly start: Int32Array; // dim*dim+1 prefix sums
  readonly items: Int32Array;
  private readonly cellOf: Int32Array;
  private readonly cursor: Int32Array;

  constructor(cap: number, halfExtent = WORLD.arenaRadius + 4, cell: number = WORLD.gridCell) {
    this.cell = cell;
    this.dim = Math.ceil((halfExtent * 2) / cell);
    this.origin = -halfExtent;
    this.start = new Int32Array(this.dim * this.dim + 1);
    this.items = new Int32Array(cap);
    this.cellOf = new Int32Array(cap);
    this.cursor = new Int32Array(this.dim * this.dim);
  }

  cellIndex(x: number, y: number): number {
    let cx = Math.floor((x - this.origin) / this.cell);
    let cy = Math.floor((y - this.origin) / this.cell);
    if (cx < 0) cx = 0;
    else if (cx >= this.dim) cx = this.dim - 1;
    if (cy < 0) cy = 0;
    else if (cy >= this.dim) cy = this.dim - 1;
    return cy * this.dim + cx;
  }

  /** Rebuild from pool arrays: slots 0..hi with alive[i] set. */
  rebuild(alive: Uint8Array, xs: Float32Array, ys: Float32Array, hi: number): void {
    const start = this.start;
    start.fill(0);
    for (let i = 0; i < hi; i++) {
      if (!alive[i]) continue;
      const c = this.cellIndex(xs[i], ys[i]);
      this.cellOf[i] = c;
      start[c + 1]++;
    }
    for (let c = 0; c < start.length - 1; c++) start[c + 1] += start[c];
    const cursor = this.cursor;
    cursor.set(start.subarray(0, start.length - 1));
    for (let i = 0; i < hi; i++) {
      if (!alive[i]) continue;
      this.items[cursor[this.cellOf[i]]++] = i;
    }
  }

  /**
   * Write candidate slots whose cell overlaps the circle into `out`; returns the count
   * (truncated at out.length). Order is deterministic (cell-major, then slot order).
   */
  queryCircle(x: number, y: number, r: number, out: Int32Array): number {
    const cs = this.cell;
    let x0 = Math.floor((x - r - this.origin) / cs);
    let x1 = Math.floor((x + r - this.origin) / cs);
    let y0 = Math.floor((y - r - this.origin) / cs);
    let y1 = Math.floor((y + r - this.origin) / cs);
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 >= this.dim) x1 = this.dim - 1;
    if (y1 >= this.dim) y1 = this.dim - 1;
    let n = 0;
    const max = out.length;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const c = cy * this.dim + cx;
        for (let k = this.start[c], e = this.start[c + 1]; k < e; k++) {
          if (n >= max) return n;
          out[n++] = this.items[k];
        }
      }
    }
    return n;
  }
}
