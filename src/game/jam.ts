/**
 * Critter Jam core rules. Pure and deterministic; no DOM.
 *
 * A yard of critters in colour groups stands in a grid. Row 0 is the front,
 * next to the road. Colour-coded vehicles pull up one at a time, each taking
 * CAP critters of its colour. Tap a critter with a clear path to the front
 * (through empty cells, 4-directionally): if it matches the vehicle it boards;
 * otherwise it waits on the bench. When the bench is full you lose. Rows at
 * the back are hidden until the rows in front of them clear out.
 */

export const CAP = 3;
export const EMPTY = -1;
export const BLOCKED = -2;

export type Color = number;

export interface LevelDef {
  id: number;
  cols: number;
  rows: number;
  /** Row-major, row 0 at the front. Colour index, EMPTY or BLOCKED. */
  cells: number[];
  /** Vehicle colours in order of arrival; each takes CAP critters. */
  vehicles: Color[];
  benchSlots: number;
  /** How many occupied rows from the front show their colours. */
  visibleRows: number;
}

export type Status = 'playing' | 'won' | 'lost';

export interface JamState {
  def: LevelDef;
  cells: Int8Array;
  /** Waiting critters, in arrival order. */
  bench: Color[];
  vehicleIdx: number;
  /** Critters already aboard the current vehicle. */
  fill: number;
  moves: number;
  boarded: number;
  status: Status;
}

export type MoveEvent =
  | { type: 'board'; cell: number; color: Color }
  | { type: 'bench'; cell: number; color: Color }
  | { type: 'benchBoard'; color: Color; n: number }
  | { type: 'depart'; color: Color }
  | { type: 'arrive'; color: Color }
  | { type: 'won' }
  | { type: 'lost' };

export function newState(def: LevelDef): JamState {
  const cells = Int8Array.from(def.cells);
  const st: JamState = { def, cells, bench: [], vehicleIdx: 0, fill: 0, moves: 0, boarded: 0, status: 'playing' };
  return st;
}

export function cloneState(s: JamState): JamState {
  return { ...s, cells: Int8Array.from(s.cells), bench: s.bench.slice() };
}

export function totalCritters(def: LevelDef): number {
  let n = 0;
  for (const c of def.cells) if (c >= 0) n++;
  return n;
}

export function currentVehicle(s: JamState): Color | null {
  return s.vehicleIdx < s.def.vehicles.length ? s.def.vehicles[s.vehicleIdx] : null;
}

/**
 * Which critters can reach the front. Flood-fills empty cells from row 0;
 * a critter is reachable if it stands in row 0 or next to a flooded cell.
 */
export function reachable(s: JamState, out?: Uint8Array): Uint8Array {
  const { cols, rows } = s.def;
  const n = cols * rows;
  const res: Uint8Array = out ?? new Uint8Array(n);
  res.fill(0);
  const flood = new Uint8Array(n);
  const stack: number[] = [];
  for (let c = 0; c < cols; c++) {
    if (s.cells[c] === EMPTY) {
      flood[c] = 1;
      stack.push(c);
    } else if (s.cells[c] >= 0) res[c] = 1;
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % cols;
    const y = (i - x) / cols;
    const nb = [x > 0 ? i - 1 : -1, x < cols - 1 ? i + 1 : -1, y > 0 ? i - cols : -1, y < rows - 1 ? i + cols : -1];
    for (const j of nb) {
      if (j < 0) continue;
      const v = s.cells[j];
      if (v === EMPTY && !flood[j]) {
        flood[j] = 1;
        stack.push(j);
      } else if (v >= 0) res[j] = 1;
    }
  }
  return res;
}

/** Row visibility: a row shows its colours once fewer than visibleRows occupied rows stand in front of it. */
export function visibleRowMask(s: JamState): boolean[] {
  const { cols, rows, visibleRows } = s.def;
  const mask: boolean[] = [];
  let occupiedAhead = 0;
  for (let r = 0; r < rows; r++) {
    mask.push(occupiedAhead < visibleRows);
    let any = false;
    for (let c = 0; c < cols; c++) if (s.cells[r * cols + c] >= 0) any = true;
    if (any) occupiedAhead++;
  }
  return mask;
}

export function isVisible(s: JamState, cell: number): boolean {
  return visibleRowMask(s)[Math.floor(cell / s.def.cols)];
}

/** Board critters from the bench onto the current vehicle, cycling vehicles as they fill. */
function settle(s: JamState, events?: MoveEvent[]): void {
  for (;;) {
    const v = currentVehicle(s);
    if (v === null) {
      s.status = 'won';
      events?.push({ type: 'won' });
      return;
    }
    if (s.fill >= CAP) {
      s.vehicleIdx++;
      s.fill = 0;
      events?.push({ type: 'depart', color: v });
      const nv = currentVehicle(s);
      if (nv !== null) events?.push({ type: 'arrive', color: nv });
      continue;
    }
    let took = 0;
    for (let i = 0; i < s.bench.length && s.fill < CAP; ) {
      if (s.bench[i] === v) {
        s.bench.splice(i, 1);
        s.fill++;
        s.boarded++;
        took++;
      } else i++;
    }
    if (took) events?.push({ type: 'benchBoard', color: v, n: took });
    if (s.fill < CAP) return;
  }
}

/** Can this cell be tapped right now? */
export function canTap(s: JamState, cell: number, reach = reachable(s)): boolean {
  return s.status === 'playing' && s.cells[cell] >= 0 && reach[cell] === 1;
}

/** Apply a tap. Returns the events, or null if the tap was illegal. Mutates `s`. */
export function tap(s: JamState, cell: number, events: MoveEvent[] = []): MoveEvent[] | null {
  if (!canTap(s, cell)) return null;
  const color = s.cells[cell];
  s.cells[cell] = EMPTY;
  s.moves++;
  const v = currentVehicle(s)!;
  if (color === v && s.fill < CAP) {
    s.fill++;
    s.boarded++;
    events.push({ type: 'board', cell, color });
  } else {
    s.bench.push(color);
    events.push({ type: 'bench', cell, color });
    if (s.bench.length >= s.def.benchSlots) {
      // Full bench: the next vehicle may still rescue it, so settle first.
      settle(s, events);
      if (s.status === 'playing' && s.bench.length >= s.def.benchSlots) {
        s.status = 'lost';
        events.push({ type: 'lost' });
      }
      return events;
    }
  }
  settle(s, events);
  return events;
}

/** Add bench capacity (rewarded video / End Game Offer). Lets a lost game continue. */
export function addBenchSlots(s: JamState, n: number): void {
  s.def = { ...s.def, benchSlots: s.def.benchSlots + n };
  if (s.status === 'lost') s.status = 'playing';
}

/** Checks the level is well formed: every colour has exactly CAP critters per vehicle. */
export function validate(def: LevelDef): string | null {
  if (def.cells.length !== def.cols * def.rows) return 'cell count';
  const counts = new Map<number, number>();
  for (const c of def.cells) if (c >= 0) counts.set(c, (counts.get(c) ?? 0) + 1);
  const need = new Map<number, number>();
  for (const v of def.vehicles) need.set(v, (need.get(v) ?? 0) + CAP);
  for (const [c, n] of counts) if (need.get(c) !== n) return `colour ${c}: ${n} critters for ${need.get(c) ?? 0} seats`;
  for (const [c] of need) if (!counts.has(c)) return `colour ${c}: vehicles but no critters`;
  if (def.benchSlots < 1) return 'bench';
  return null;
}
