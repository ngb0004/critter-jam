import { BLOCKED, CAP, EMPTY, LevelDef, validate } from './jam';
import { BotProfile, CASUAL, measure } from './bot';
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
  const t = Math.min(1, level / 150);
  const colors = Math.round(3 + t * 4 + rng.range(-0.5, 0.5));
  const vehiclesPerColor = Math.round(2 + t * 3 + rng.range(-0.5, 0.5));
  const critters = colors * vehiclesPerColor * CAP;
  const cols = Math.min(8, Math.max(5, Math.round(4.5 + t * 3)));
  const rows = Math.ceil((critters * 1.25) / cols) + 1;
  return {
    cols,
    rows,
    colors: Math.max(3, colors),
    vehiclesPerColor: Math.max(2, vehiclesPerColor),
    benchSlots: level < 20 ? 7 : level < 60 ? 6 : 5,
    visibleRows: level < 12 ? rows : Math.max(3, 5 - Math.floor(t * 2)),
    blocked: level < 10 ? 0 : 0.04 + t * 0.06,
    clumping: 0.8 - t * 0.5,
  };
}

export function randomLevel(id: number, p: GenParams, rng: Rng): LevelDef {
  const n = p.cols * p.rows;
  const cells = new Array<number>(n).fill(EMPTY);
  const critters = p.colors * p.vehiclesPerColor * CAP;
  // Scenery blocks, never in the front row.
  const blocks = Math.round(n * p.blocked);
  for (let b = 0; b < blocks; b++) {
    const i = p.cols + rng.int(n - p.cols);
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
  // Vehicle order: random, but biased toward colours standing near the front early on.
  const vehicles: number[] = [];
  for (let c = 0; c < p.colors; c++) for (let k = 0; k < p.vehiclesPerColor; k++) vehicles.push(c);
  rng.shuffle(vehicles);
  const frontness = new Map<number, number>();
  spots.forEach((cell, i) => frontness.set(painted[i], (frontness.get(painted[i]) ?? 0) + Math.floor(cell / p.cols)));
  vehicles.sort((a, b) => (frontness.get(a)! + rng.range(-8, 8)) - (frontness.get(b)! + rng.range(-8, 8)));
  const def: LevelDef = { id, cols: p.cols, rows: p.rows, cells, vehicles, benchSlots: p.benchSlots, visibleRows: p.visibleRows };
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
  for (let t = 0; t < tries; t++) {
    const p = paramsFor(level, rng);
    // Nudge the bite: harder targets get fewer bench slots or more shuffling.
    if (target < 0.6) p.clumping = Math.max(0.1, p.clumping - 0.25);
    if (target < 0.4) p.benchSlots = Math.max(4, p.benchSlots - 1);
    if (target > 0.9) p.clumping = Math.min(0.95, p.clumping + 0.15);
    let def: LevelDef;
    try {
      def = randomLevel(level, p, rng);
    } catch {
      continue;
    }
    const sol = solve(def, 150_000);
    if (!sol.solvable) continue;
    const d = measure(def, profile, runs, seed + t);
    const cand = { def, ...d };
    if (!best || Math.abs(d.winRate - target) < Math.abs(best.winRate - target)) best = cand;
    if (Math.abs(d.winRate - target) < 0.06) break;
  }
  if (!best) throw new Error(`no solvable level for ${level}`);
  return best;
}
