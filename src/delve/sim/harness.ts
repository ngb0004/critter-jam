/**
 * Spell bench harness (BUILD, test/tool only; not used by the game). Runs BUILD's systems against static
 * dummy enemies, so spells can be measured in isolation: single-target DPS, per-target area DPS, crowd DPS.
 */
import { CAP } from '../core/constants';
import { seedForDay } from '../core/daily';
import type { SpecId } from '../core/types';
import { createWorld, type World } from '../core/world';
import { defaultModifiers } from '../core/types';
import { SPELLS, spellIndex } from '../content/spells';
import { addSpell } from './build';
import { spawnEnemy } from './enemies';
import { updateProjectiles } from './projectiles';
import { updateSpells } from './spells';
import { updateStatuses } from './statuses';
import { updateZones } from './zones';

export interface BenchResult {
  id: string;
  dps: number;
  hit: number;
  perTarget: number;
}

/** A world with only `spellId` in slot 0 (rank, fit 1) and `n` immortal dummies in a disc of radius `spread` at `dist` m. */
export function benchWorld(spellId: string, rank: number, n: number, dist: number, spread: number, spec: SpecId = 'ember'): World {
  const seed = seedForDay(312, 0);
  const w = createWorld(seed, spec, defaultModifiers());
  const b = w.build;
  b.slotSpell.fill(-1);
  const s = addSpell(w, spellIndex(spellId));
  b.slotRank[s] = rank;
  b.slotFit[s] = 1;
  for (let k = 0; k < n; k++) {
    // deterministic sunflower disc
    const r = spread * Math.sqrt((k + 0.5) / n);
    const a = k * 2.39996;
    const x = dist + r * cosA(a);
    const y = r * sinA(a);
    const e = spawnEnemy(w, 0, x, y, 0);
    if (e >= 0) {
      w.en.hp[e] = w.en.maxHp[e] = 1e6;
      w.en.xp[e] = 0;
    }
  }
  return w;
}
// small-angle-free trig for the harness only (not sim code): polynomial on [-pi, pi]
function sinA(a: number): number {
  let x = a % 6.283185307179586;
  if (x > 3.141592653589793) x -= 6.283185307179586;
  let t = x;
  let s = x;
  for (let k = 1; k < 12; k++) {
    t *= (-x * x) / ((2 * k) * (2 * k + 1));
    s += t;
  }
  return s;
}
const cosA = (a: number): number => sinA(a + 1.5707963267948966);

/** Run BUILD systems for `ticks` with static enemies. */
export function benchRun(w: World, ticks: number): void {
  for (let t = 0; t < ticks; t++) {
    w.tick++;
    w.grid.rebuild(w.en.alive, w.en.x, w.en.y, w.en.hi);
    updateSpells(w);
    updateProjectiles(w);
    updateZones(w);
    updateStatuses(w);
    w.events.clear();
  }
}

export function bench(spellId: string, rank = 1, n = 1, dist = 4, spread = 0, ticks = 1200): BenchResult {
  const w = benchWorld(spellId, rank, n, dist, spread, SPELLS[spellIndex(spellId)].owner === 'venom' || SPELLS[spellIndex(spellId)].owner === 'cutpurse' ? 'venom' : 'ember');
  benchRun(w, ticks);
  const secs = ticks / 60;
  let hit = 0;
  for (let i = 0; i < w.en.hi; i++) if (w.en.alive[i] && w.en.hp[i] < w.en.maxHp[i]) hit++;
  void CAP;
  return { id: spellId, dps: w.score.totalDamage / secs, hit, perTarget: hit ? w.score.totalDamage / secs / hit : 0 };
}
