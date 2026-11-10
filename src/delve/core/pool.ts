/**
 * Slot allocator for struct-of-arrays pools (CORE). LIFO free stack (fresh pools hand out 0,1,2...),
 * fully deterministic. Iterate 0..hi and check alive[]. No allocation after construction.
 */
export class SlotPool {
  readonly cap: number;
  readonly alive: Uint8Array;
  /** Monotonic id of the thing in each slot; lets readers notice slot reuse. */
  readonly uid: Int32Array;
  /** One past the highest slot ever used; iterate 0..hi and check alive. */
  hi = 0;
  count = 0;
  private nextUid = 1;
  private readonly free: Int32Array;
  private freeTop = 0;

  constructor(cap: number) {
    this.cap = cap;
    this.alive = new Uint8Array(cap);
    this.uid = new Int32Array(cap);
    this.free = new Int32Array(cap);
    // stack with slot 0 on top
    for (let i = 0; i < cap; i++) this.free[i] = cap - 1 - i;
    this.freeTop = cap;
  }

  /** Returns a slot index, or -1 when full. */
  alloc(): number {
    if (this.freeTop === 0) return -1;
    const i = this.free[--this.freeTop];
    this.alive[i] = 1;
    this.uid[i] = this.nextUid++;
    this.count++;
    if (i + 1 > this.hi) this.hi = i + 1;
    return i;
  }

  release(i: number): void {
    if (!this.alive[i]) return;
    this.alive[i] = 0;
    this.count--;
    this.free[this.freeTop++] = i;
    while (this.hi > 0 && !this.alive[this.hi - 1]) this.hi--;
  }

  /** Free-stack order matters for determinism; this rebuilds it in canonical order. */
  reset(): void {
    this.alive.fill(0);
    this.hi = 0;
    this.count = 0;
    this.freeTop = this.cap;
    for (let i = 0; i < this.cap; i++) this.free[i] = this.cap - 1 - i;
  }
}
