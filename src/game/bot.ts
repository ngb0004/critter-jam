import { CAP, JamState, LevelDef, currentVehicle, isVisible, newState, reachable, tap } from './jam';
import { Rng } from './rng';

/**
 * A stand-in for a casual player, used to measure difficulty. It only sees
 * what the player sees (hidden rows are unknown), plans one or two vehicles
 * ahead, and fumbles with probability `mistake`.
 */
export interface BotProfile {
  /** How many upcoming vehicles the bot takes into account when benching. */
  lookahead: number;
  /** Probability of a random legal tap instead of the planned one. */
  mistake: number;
  /** Bench slots the bot likes to keep free; benching past this needs a good reason. */
  reserve: number;
}

export const CASUAL: BotProfile = { lookahead: 2, mistake: 0.06, reserve: 2 };
export const CAREFUL: BotProfile = { lookahead: 3, mistake: 0.0, reserve: 1 };
export const SLOPPY: BotProfile = { lookahead: 1, mistake: 0.15, reserve: 2 };

export interface RunResult {
  won: boolean;
  moves: number;
  /** Share of critters boarded when the game ended. */
  progress: number;
}

export function playOnce(def: LevelDef, profile: BotProfile, rng: Rng): RunResult {
  const s = newState(def);
  const total = def.cells.filter((c) => c >= 0).length;
  const reach = new Uint8Array(def.cols * def.rows);
  let guard = 0;
  while (s.status === 'playing' && guard++ < 1000) {
    const cell = chooseMove(s, profile, rng, reach);
    if (cell < 0) break;
    tap(s, cell);
  }
  return { won: s.status === 'won', moves: s.moves, progress: s.boarded / total };
}

function chooseMove(s: JamState, p: BotProfile, rng: Rng, reach: Uint8Array): number {
  reachable(s, reach);
  const legal: number[] = [];
  for (let i = 0; i < reach.length; i++) if (reach[i]) legal.push(i);
  if (!legal.length) return -1;
  if (rng.next() < p.mistake) return rng.pick(legal);

  const v = currentVehicle(s)!;
  const seats = CAP - s.fill;
  // Board a matching critter if we can see one.
  const matching = legal.filter((i) => s.cells[i] === v && isVisible(s, i));
  if (matching.length && seats > 0) return bestFreeing(s, matching, rng);

  // Otherwise bench something useful: a visible critter whose vehicle is coming soon.
  const soon = new Map<number, number>();
  for (let k = 1; k <= p.lookahead; k++) {
    const idx = s.vehicleIdx + k;
    if (idx < s.def.vehicles.length && !soon.has(s.def.vehicles[idx])) soon.set(s.def.vehicles[idx], k);
  }
  const free = s.def.benchSlots - s.bench.length;
  const benchedOf = (c: number) => s.bench.filter((b) => b === c).length;
  const candidates = legal
    .filter((i) => isVisible(s, i))
    .map((i) => {
      const c = s.cells[i];
      const k = soon.get(c);
      // Seats still needed for that colour's next vehicle, minus what's already benched.
      const need = k ? Math.max(0, CAP - benchedOf(c)) : 0;
      return { i, score: k ? (need > 0 ? 10 - k : 2) : 0 };
    })
    .sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (best && (best.score >= 8 || free > p.reserve)) {
    const top = candidates.filter((c) => c.score === best.score).map((c) => c.i);
    return bestFreeing(s, top, rng);
  }
  // Nothing sensible is visible: open up a hidden row if we can, else take the least bad option.
  const hidden = legal.filter((i) => !isVisible(s, i));
  if (hidden.length && free > p.reserve) return rng.pick(hidden);
  if (best) return best.i;
  return rng.pick(legal);
}

/** Among equal choices, prefer the one that unblocks the most critters behind it. */
function bestFreeing(s: JamState, cells: number[], rng: Rng): number {
  if (cells.length === 1) return cells[0];
  const cols = s.def.cols;
  let best = cells[0];
  let bestScore = -1;
  for (const i of cells) {
    const y = Math.floor(i / cols);
    const behind = i + cols < s.cells.length && s.cells[i + cols] >= 0 ? 1 : 0;
    const score = behind * 2 + y + rng.next() * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

export interface Difficulty {
  winRate: number;
  /** Share of losses that happened with most critters already boarded. */
  nearMissRate: number;
  avgMoves: number;
}

export function measure(def: LevelDef, profile: BotProfile, runs = 200, seed = 1): Difficulty {
  const rng = new Rng(seed);
  let wins = 0;
  let near = 0;
  let moves = 0;
  for (let i = 0; i < runs; i++) {
    const r = playOnce(def, profile, rng);
    if (r.won) wins++;
    else if (r.progress >= 0.7) near++;
    moves += r.moves;
  }
  return { winRate: wins / runs, nearMissRate: runs - wins ? near / (runs - wins) : 0, avgMoves: moves / runs };
}
