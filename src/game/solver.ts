import { CAP, JamState, LevelDef, cloneState, currentVehicle, newState, reachable, tap } from './jam';

/**
 * Proves a level solvable (with full information) by depth-first search with
 * memoisation, or gives up after `maxNodes`. Returns the winning tap sequence.
 *
 * Pruning: when a reachable critter matches the current vehicle, boarding one
 * of them is never worse than benching something first (the bench move can be
 * made afterwards and reaches the same state), so only boarding moves are
 * expanded in that case.
 */
export interface SolveResult {
  solvable: boolean;
  /** Cells tapped, in order, when solvable. */
  path: number[];
  nodes: number;
  gaveUp: boolean;
}

export function solve(def: LevelDef, maxNodes = 300_000): SolveResult {
  const start = newState(def);
  const seen = new Set<string>();
  let nodes = 0;
  let gaveUp = false;
  const path: number[] = [];
  const reach = new Uint8Array(def.cols * def.rows);

  const key = (s: JamState): string => {
    // Bench order is irrelevant to the outcome (matching critters auto-board whenever their vehicle comes).
    const b = s.bench.slice().sort((a, c) => a - c).join(',');
    return `${s.vehicleIdx}|${s.fill}|${b}|${String.fromCharCode(...Array.from(s.cells, (c) => c + 3))}`;
  };

  const dfs = (s: JamState): boolean => {
    if (s.status === 'won') return true;
    if (s.status === 'lost') return false;
    if (++nodes > maxNodes) {
      gaveUp = true;
      return false;
    }
    const k = key(s);
    if (seen.has(k)) return false;
    seen.add(k);

    reachable(s, reach);
    const v = currentVehicle(s)!;
    const matching: number[] = [];
    const others: number[] = [];
    for (let i = 0; i < reach.length; i++) {
      if (!reach[i]) continue;
      if (s.cells[i] === v && s.fill < CAP) matching.push(i);
      else others.push(i);
    }
    let moves = matching.length ? matching : others;
    if (!matching.length) {
      // Benching: prefer colours that come up soonest, and never overflow needlessly.
      const upcoming = new Map<number, number>();
      for (let i = s.vehicleIdx + 1; i < def.vehicles.length; i++) if (!upcoming.has(def.vehicles[i])) upcoming.set(def.vehicles[i], i);
      moves = others.slice().sort((a, b) => (upcoming.get(s.cells[a]) ?? 1e9) - (upcoming.get(s.cells[b]) ?? 1e9));
      // Deduplicate by colour where the freed cell doesn't matter much: keep all, but colour order helps find a path fast.
    }
    for (const cell of moves) {
      const next = cloneState(s);
      tap(next, cell);
      path.push(cell);
      if (dfs(next)) return true;
      path.pop();
      if (gaveUp) return false;
    }
    return false;
  };

  const solvable = dfs(start);
  return { solvable, path: solvable ? path.slice() : [], nodes, gaveUp };
}
