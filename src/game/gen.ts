import { BLOCKED, CAP, EMPTY, LevelDef, Special, validate } from './jam';
import { BotProfile, CAREFUL, CASUAL, measure } from './bot';
import { solve } from './solver';
import { Rng } from './rng';

/**
 * Level generation. A level is random but checked: the solver proves it can be
 * won, and the casual bot's win rate places it on the difficulty curve.
 */
export interface GenParams {
  cols: number;
  rows: number;
  colors: number;
  /** Vehicles per colour, so critters = vehicles × CAP. */
  vehiclesPerColor: number;
  benchSlots: number;
  visibleRows: number;
  /** Share of cells left as scenery blocks. */
  blocked: number;
  /** How clumped colours are: 0 fully shuffled, 1 solid blocks. */
  clumping: number;
  /**
   * How "natural" the bus order is. 0: each bus is the colour with the most
   * critters reachable right now (a forgiving order). Higher values pick less
   * convenient colours more often, which is where the difficulty comes from.
   */
  temperature: number;
  /** Special pieces to place: prisms (wild) and magnets. */
  prisms: number;
  magnets: number;
}

/**
 * The curve: win rate the casual bot should land on, by level number.
 * Easy start, a tough one every fifth level, a real wall every tenth,
 * then relief. Royal Match's documented cadence, roughly.
 */
export function targetWinRate(level: number): number {
  if (level <= 3) return 0.97;
  if (level <= 8) return 0.9;
  const pos = ((level - 1) % 10) + 1;
  switch (pos) {
    case 5:
      return 0.5;
    case 10:
      return 0.3;
    case 1:
    case 6:
      return 0.9;
    case 2:
    case 7:
      return 0.85;
    case 3:
    case 8:
      return 0.75;
    default:
      return 0.65;
  }
}

/** Size grows with level; the curve above sets the bite within that size. */
export function paramsFor(level: number, rng: Rng): GenParams {
  // Boards grow to about 54 critters by level 60 and stay there; past that the
  // bite comes from bus order, hidden rows and the bench, not from size.
  const t = Math.min(1, level / 60);
  const colors = Math.max(3, Math.min(6, Math.round(3 + t * 3 + rng.range(-0.5, 0.5))));
  const vehiclesPerColor = Math.max(2, Math.min(3, Math.round(2 + t * 1.4 + rng.range(-0.4, 0.4))));
  const blockedShare = level < 10 ? 0 : 0.04 + Math.min(1, level / 150) * 0.06;
  const critters = colors * vehiclesPerColor * CAP;
  const cols = Math.min(7, Math.max(5, Math.round(4.5 + t * 2.5)));
  // Packed from the front: just enough rows for the pieces and the scenery.
  const blocks = Math.round(critters * blockedShare);
  const rows = Math.min(10, Math.ceil((critters + blocks) / cols));
  return {
    cols,
    rows,
    colors,
    vehiclesPerColor,
    benchSlots: level < 20 ? 7 : level < 50 ? 6 : 5,
    visibleRows: level < 12 ? rows : Math.max(3, 5 - Math.floor(Math.min(1, level / 150) * 2)),
    blocked: blockedShare,
    clumping: 0.8 - t * 0.5,
    temperature: 0.3 + Math.min(1, level / 150) * 0.6,
    // A prism every third level from 6, a magnet piece on the tough ones from 15.
    prisms: level >= 6 && level % 3 === 0 ? 1 : 0,
    magnets: level >= 15 && (level % 5 === 0 || level % 10 === 7) ? 1 : 0,
  };
}

export function randomLevel(id: number, p: GenParams, rng: Rng): LevelDef {
  const n = p.cols * p.rows;
  const cells = new Array<number>(n).fill(EMPTY);
  const critters = p.colors * p.vehiclesPerColor * CAP;
  // Scenery blocks, never in the front row.
  const blocks = Math.min(Math.round(critters * p.blocked), Math.max(0, n - critters));
  for (let b = 0; b < blocks; b++) {
    const i = p.cols + rng.int(n - p.cols);
    if (cells[i] === BLOCKED) continue;
    cells[i] = BLOCKED;
  }
  // Fill from the front, leaving some holes near the back so paths exist.
  const free: number[] = [];
  for (let i = 0; i < n; i++) if (cells[i] === EMPTY) free.push(i);
  if (free.length < critters) throw new Error('board too small');
  const spots = free.slice(0, critters);
  // Colour assignment: paint in clumps, then shuffle a share of them.
  const pool: number[] = [];
  for (let c = 0; c < p.colors; c++) for (let k = 0; k < p.vehiclesPerColor * CAP; k++) pool.push(c);
  const painted = pool.slice();
  const shuffleShare = 1 - p.clumping;
  const idx = rng.shuffle(spots.map((_, i) => i));
  const toShuffle = idx.slice(0, Math.round(idx.length * shuffleShare));
  const vals = toShuffle.map((i) => painted[i]);
  rng.shuffle(vals);
  toShuffle.forEach((i, k) => (painted[i] = vals[k]));
  spots.forEach((cell, i) => (cells[cell] = painted[i]));
  cleanOpening(cells, p);
  const vehicles = playoutOrder(cells, p, rng);
  const specials = placeSpecials(cells, vehicles, p, rng);
  const def: LevelDef = { id, cols: p.cols, rows: p.rows, cells, vehicles, benchSlots: p.benchSlots, visibleRows: p.visibleRows, ...(specials ? { specials } : {}) };
  const err = validate(def);
  if (err) throw new Error(err);
  return def;
}

export interface Candidate {
  def: LevelDef;
  winRate: number;
  nearMissRate: number;
  avgMoves: number;
}

/** Finds a solvable level whose bot win rate is close to the target. */
export function generateLevel(level: number, seed: number, opts: { tries?: number; runs?: number; profile?: BotProfile } = {}): Candidate {
  const rng = new Rng(seed * 7919 + level);
  const target = targetWinRate(level);
  const tries = opts.tries ?? 40;
  const runs = opts.runs ?? 120;
  const profile = opts.profile ?? CASUAL;
  let best: Candidate | null = null;
  /** Best candidate that failed the fairness gate, as a last resort. */
  let fallback: Candidate | null = null;
  for (let t = 0; t < tries; t++) {
    const p = paramsFor(level, rng);
    // Nudge the bite: harder targets get fewer bench slots or more shuffling.
    if (target < 0.6) {
      p.clumping = Math.max(0.1, p.clumping - 0.25);
      p.temperature += 0.5;
    }
    if (target < 0.4) p.temperature += 0.8;
    // From level 10 on, the hard ones also hide more of the yard.
    if (target < 0.55 && level >= 10) p.visibleRows = Math.min(p.visibleRows, 4);
    if (target > 0.9) {
      p.clumping = Math.min(0.95, p.clumping + 0.15);
      p.temperature = Math.max(0, p.temperature - 0.3);
    }
    // Each try nudges the bite up or down toward the target.
    if (best) {
      const drift = best.winRate > target ? 0.35 : -0.35;
      p.temperature = Math.max(0, p.temperature + drift * (t / tries + 0.5));
    }
    let def: LevelDef;
    try {
      def = randomLevel(level, p, rng);
    } catch {
      continue;
    }
    const sol = solve(def, 250_000);
    if (!sol.solvable) continue;
    const d = measure(def, profile, runs, seed + t);
    const cand = { def, ...d };
    // Quality gate: a careful player must be able to beat every level: at least
    // half the time on normal levels, and clearly more often than a casual one on walls.
    if (target < 0.9 && measure(def, CAREFUL, 60, seed + t + 1).winRate < Math.min(0.5, target + 0.1)) {
      if (!fallback || Math.abs(d.winRate - target) < Math.abs(fallback.winRate - target)) fallback = cand;
      continue;
    }
    // Score: hit the win-rate target, and among those prefer levels whose
    // losses come late (a near miss is what makes "one more go" and the offer work).
    const score = (c: Candidate) => Math.abs(c.winRate - target) + (target < 0.9 ? 0.3 * (1 - c.nearMissRate) : 0);
    if (!best || score(cand) < score(best)) best = cand;
    if (Math.abs(d.winRate - target) < 0.05 && (target >= 0.9 || d.nearMissRate > 0.5)) break;
  }
  if (!best && fallback) return fallback;
  if (!best) {
    // Nothing solvable at this size: redraw with the dials turned down.
    if (tries <= 10) throw new Error(`no solvable level for ${level}`);
    return generateLevel(level, seed + 101, { ...opts, tries: Math.floor(tries / 2) });
  }
  return best;
}

/**
 * Bus order from a simulated playthrough: at each step, the colours with seats
 * left are weighted by how many of their critters are reachable right now, and
 * one is drawn with the given temperature. Its CAP nearest-to-front critters
 * are removed and the next bus is chosen. The result is always playable with
 * perfect information; hidden rows and the bench make it hard.
 */
export function playoutOrder(cells: number[], p: GenParams, rng: Rng): number[] {
  const { cols, rows } = p;
  const board = cells.slice();
  const left = new Map<number, number>();
  for (const c of board) if (c >= 0) left.set(c, (left.get(c) ?? 0) + 1);
  const order: number[] = [];
  const buses = [...left.values()].reduce((a, n) => a + n, 0) / CAP;
  const reach = (): Uint8Array => {
    const n = cols * rows;
    const res = new Uint8Array(n);
    const flood = new Uint8Array(n);
    const stack: number[] = [];
    for (let c = 0; c < cols; c++) {
      if (board[c] === EMPTY) {
        flood[c] = 1;
        stack.push(c);
      } else if (board[c] >= 0) res[c] = 1;
    }
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % cols;
      const y = (i - x) / cols;
      for (const j of [x > 0 ? i - 1 : -1, x < cols - 1 ? i + 1 : -1, y > 0 ? i - cols : -1, y < rows - 1 ? i + cols : -1]) {
        if (j < 0) continue;
        if (board[j] === EMPTY && !flood[j]) {
          flood[j] = 1;
          stack.push(j);
        } else if (board[j] >= 0) res[j] = 1;
      }
    }
    return res;
  };
  while ([...left.values()].some((n) => n > 0)) {
    const r = reach();
    const weights: [number, number][] = [];
    for (const [c, n] of left) {
      if (n <= 0) continue;
      let k = 0;
      for (let i = 0; i < board.length; i++) if (board[i] === c && r[i]) k++;
      // Convenience: reachable critters of this colour, softened by temperature.
      // The temperature ramps up through the level, so the awkward buses come
      // late: losses should be near misses, not early stumbles.
      const progress = order.length / Math.max(1, buses);
      // The first two buses are always the convenient ones: nobody should lose in the opening.
      const temp = order.length < 2 ? 0 : p.temperature * (0.15 + 0.85 * progress * progress);
      weights.push([c, Math.pow(k + 0.3, 1 / (0.15 + temp))]);
    }
    const total = weights.reduce((a, [, w]) => a + w, 0);
    let pick = rng.next() * total;
    let color = weights[weights.length - 1][0];
    for (const [c, w] of weights) {
      pick -= w;
      if (pick <= 0) {
        color = c;
        break;
      }
    }
    order.push(color);
    left.set(color, left.get(color)! - CAP);
    // Remove its CAP most accessible critters: reachable first, then nearest the front.
    const owned = [];
    for (let i = 0; i < board.length; i++) if (board[i] === color) owned.push(i);
    owned.sort((a, b) => (r[b] - r[a]) || (Math.floor(a / cols) - Math.floor(b / cols)));
    for (const i of owned.slice(0, CAP)) board[i] = EMPTY;
  }
  return order;
}

/**
 * Every level opens with a clean first bus: the colour with the most critters
 * in the front row gets a full set there, swapped in from the nearest rows.
 * Nobody should have to dig on move one.
 */
export function cleanOpening(cells: number[], p: GenParams): void {
  const { cols } = p;
  const front = new Map<number, number>();
  for (let c = 0; c < cols; c++) if (cells[c] >= 0) front.set(cells[c], (front.get(cells[c]) ?? 0) + 1);
  if (!front.size) return;
  const [lead] = [...front.entries()].sort((a, b) => b[1] - a[1])[0];
  let have = front.get(lead)!;
  for (let i = cols; i < cells.length && have < CAP; i++) {
    if (cells[i] !== lead) continue;
    // Swap with a front-row critter of another colour.
    const slot = Array.from({ length: cols }, (_, c) => c).find((c) => cells[c] >= 0 && cells[c] !== lead);
    if (slot === undefined) break;
    cells[i] = cells[slot];
    cells[slot] = lead;
    have++;
  }
}

/** Prisms replace a piece that isn't the opening colour; magnets go on a deep piece of a late colour. */
function placeSpecials(cells: number[], vehicles: number[], p: GenParams, rng: Rng): Record<number, Special> | null {
  const out: Record<number, Special> = {};
  const cols = p.cols;
  const first = vehicles[0];
  const pick = (ok: (cell: number) => boolean): number => {
    const opts: number[] = [];
    for (let i = 0; i < cells.length; i++) if (cells[i] >= 0 && !(i in out) && ok(i)) opts.push(i);
    return opts.length ? rng.pick(opts) : -1;
  };
  for (let k = 0; k < p.prisms; k++) {
    const i = pick((c) => cells[c] !== first && Math.floor(c / cols) >= 1);
    if (i >= 0) out[i] = 'prism';
  }
  const late = new Set(vehicles.slice(Math.floor(vehicles.length / 2)));
  for (let k = 0; k < p.magnets; k++) {
    const i = pick((c) => late.has(cells[c]) && Math.floor(c / cols) >= 2);
    if (i >= 0) out[i] = 'magnet';
  }
  return Object.keys(out).length ? out : null;
}
