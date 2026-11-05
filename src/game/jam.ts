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
/** A prism: a wild piece that fits any collector. */
export const WILD = 40;

export type Color = number;

export type Special = 'prism' | 'magnet';

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
  /** Special pieces by cell. A prism is wild; a magnet pulls its two mates in with it. */
  specials?: Record<number, Special>;
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
  /** Collectors filled automatically in a row during the current tap. */
  run: number;
}

export type MoveEvent =
  | { type: 'board'; cell: number; color: Color }
  /** A piece pulled straight from the yard by a magnet (special piece or booster). */
  | { type: 'pull'; cell: number; color: Color }
  | { type: 'bench'; cell: number; color: Color }
  | { type: 'benchBoard'; color: Color; n: number }
  /** An avalanche: a collector arrived to find its colour ready and filled itself. */
  | { type: 'cascade'; cells: number[]; color: Color; run: number }
  | { type: 'depart'; color: Color }
  | { type: 'arrive'; color: Color }
  | { type: 'won' }
  | { type: 'lost' };

export function newState(def: LevelDef): JamState {
  const cells = Int8Array.from(def.cells);
  // Prisms live on the board as WILD so every rule sees them as "any colour".
  for (const [cell, kind] of Object.entries(def.specials ?? {})) if (kind === 'prism') cells[Number(cell)] = WILD;
  const st: JamState = { def, cells, bench: [], vehicleIdx: 0, fill: 0, moves: 0, boarded: 0, status: 'playing', run: 0 };
  return st;
}

/** Does a piece of this colour fit a collector of colour `v`? */
export function fits(color: number, v: number): boolean {
  return color === v || color === WILD;
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
  let arrived = false;
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
      arrived = true;
      continue;
    }
    let took = 0;
    for (const want of [v, WILD]) {
      for (let i = 0; i < s.bench.length && s.fill < CAP; ) {
        if (s.bench[i] === want) {
          s.bench.splice(i, 1);
          s.fill++;
          s.boarded++;
          took++;
        } else i++;
      }
    }
    if (took) events?.push({ type: 'benchBoard', color: v, n: took });
    if (s.fill < CAP && arrived) {
      // Avalanche: the colour is already fully reachable, so the collector helps itself.
      const need = CAP - s.fill;
      const ready = readyCells(s, v);
      if (ready.length >= need) {
        const cells = ready.slice(0, need);
        for (const c of cells) {
          s.cells[c] = EMPTY;
          s.fill++;
          s.boarded++;
        }
        s.run++;
        events?.push({ type: 'cascade', cells, color: v, run: s.run });
      }
    }
    if (s.fill < CAP) return;
    arrived = false;
  }
}

/** Reachable pieces that fit collector colour `v`, exact colour before prisms, nearest the front first. */
function readyCells(s: JamState, v: Color): number[] {
  const reach = reachable(s);
  const cols = s.def.cols;
  const out: number[] = [];
  for (let i = 0; i < reach.length; i++) if (reach[i] && fits(s.cells[i], v)) out.push(i);
  out.sort((a, b) => (s.cells[a] === WILD ? 1 : 0) - (s.cells[b] === WILD ? 1 : 0) || Math.floor(a / cols) - Math.floor(b / cols));
  return out;
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
  s.run = 0;
  const v = currentVehicle(s)!;
  if (fits(color, v) && s.fill < CAP) {
    s.fill++;
    s.boarded++;
    events.push({ type: 'board', cell, color });
    // A magnet piece drags the collector's remaining mates straight out of the yard.
    if (s.def.specials?.[cell] === 'magnet') pull(s, v, CAP - s.fill, events);
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

/** Pull up to `n` pieces of colour `v` from anywhere in the yard onto the current collector, deepest first. */
function pull(s: JamState, v: Color, n: number, events: MoveEvent[]): void {
  const cols = s.def.cols;
  const owned: number[] = [];
  for (let i = 0; i < s.cells.length; i++) if (s.cells[i] === v) owned.push(i);
  owned.sort((a, b) => Math.floor(b / cols) - Math.floor(a / cols));
  for (const cell of owned.slice(0, n)) {
    s.cells[cell] = EMPTY;
    s.fill++;
    s.boarded++;
    events.push({ type: 'pull', cell, color: v });
  }
}

/** Magnet booster: fill the current collector from anywhere (yard first, then the bench). Mutates `s`. */
export function magnet(s: JamState, events: MoveEvent[] = []): MoveEvent[] | null {
  if (s.status !== 'playing') return null;
  const v = currentVehicle(s)!;
  const before = s.fill;
  s.run = 0;
  pull(s, v, CAP - s.fill, events);
  if (s.fill === before) return null;
  s.moves++;
  settle(s, events);
  return events;
}

/**
 * Shuffle booster: deal the remaining yard pieces into new positions (specials
 * stay put). The caller checks solvability and may retry with another seed.
 */
export function shuffle(s: JamState, rnd: () => number): void {
  const fixed = new Set(Object.keys(s.def.specials ?? {}).map(Number));
  const cells: number[] = [];
  for (let i = 0; i < s.cells.length; i++) if (s.cells[i] >= 0 && !fixed.has(i)) cells.push(i);
  const colors = cells.map((i) => s.cells[i]);
  for (let i = colors.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [colors[i], colors[j]] = [colors[j], colors[i]];
  }
  cells.forEach((cell, k) => (s.cells[cell] = colors[k]));
  s.moves++;
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
  let wilds = 0;
  def.cells.forEach((c, i) => {
    if (c < 0) return;
    if (def.specials?.[i] === 'prism') wilds++;
    else counts.set(c, (counts.get(c) ?? 0) + 1);
  });
  const need = new Map<number, number>();
  for (const v of def.vehicles) need.set(v, (need.get(v) ?? 0) + CAP);
  let short = 0;
  for (const [c, n] of need) {
    const have = counts.get(c) ?? 0;
    if (have > n) return `colour ${c}: ${have} pieces for ${n} seats`;
    short += n - have;
  }
  for (const [c] of counts) if (!need.has(c)) return `colour ${c}: pieces but no collector`;
  if (short !== wilds) return `${wilds} prisms for ${short} open seats`;
  if (def.benchSlots < 1) return 'bench';
  return null;
}
