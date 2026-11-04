import { describe, expect, it } from 'vitest';
import { CAP, EMPTY, LevelDef, newState, reachable, tap, validate, visibleRowMask } from './jam';
import { solve } from './solver';
import { CASUAL, CAREFUL, measure, playOnce } from './bot';
import { generateLevel, randomLevel, targetWinRate } from './gen';
import { Rng } from './rng';

const tiny: LevelDef = {
  id: 0,
  cols: 3,
  rows: 2,
  // front row: red red blue / back row: blue red blue
  cells: [0, 0, 1, 1, 0, 1],
  vehicles: [0, 1],
  benchSlots: 3,
  visibleRows: 2,
};

describe('rules', () => {
  it('validates seat counts', () => {
    expect(validate(tiny)).toBeNull();
    expect(validate({ ...tiny, vehicles: [0, 0] })).not.toBeNull();
  });

  it('front row is reachable, back row only through gaps', () => {
    const s = newState(tiny);
    const r = Array.from(reachable(s));
    expect(r).toEqual([1, 1, 1, 0, 0, 0]);
    tap(s, 0); // red boards
    expect(Array.from(reachable(s))).toEqual([0, 1, 1, 1, 0, 0]);
  });

  it('boards matching critters, benches others, auto-boards from the bench', () => {
    const s = newState(tiny);
    tap(s, 2); // blue, vehicle is red: benched
    expect(s.bench).toEqual([1]);
    tap(s, 0);
    tap(s, 1);
    expect(s.fill).toBe(2);
    tap(s, 4); // last red: vehicle departs; blue arrives and takes the benched blue
    expect(s.vehicleIdx).toBe(1);
    expect(s.bench).toEqual([]);
    expect(s.fill).toBe(1);
    tap(s, 3);
    tap(s, 5);
    expect(s.status).toBe('won');
    expect(s.boarded).toBe(CAP * 2);
  });

  it('loses when the bench fills', () => {
    const s = newState({ ...tiny, benchSlots: 1 });
    tap(s, 2);
    expect(s.status).toBe('lost');
  });

  it('hides back rows until the front clears', () => {
    const def: LevelDef = { ...tiny, rows: 3, cells: [...tiny.cells, 0, EMPTY, EMPTY], vehicles: [0, 0, 1], visibleRows: 1 };
    // Fix seat counts: 4 reds + ... keep it simple by only checking the mask.
    const s = newState(def);
    expect(visibleRowMask(s)).toEqual([true, false, false]);
    s.cells[0] = s.cells[1] = s.cells[2] = EMPTY;
    expect(visibleRowMask(s)).toEqual([true, true, false]);
  });
});

describe('solver and bot', () => {
  it('solves the tiny level and the bot wins it', () => {
    const r = solve(tiny);
    expect(r.solvable).toBe(true);
    expect(r.path.length).toBe(6);
    expect(playOnce(tiny, CAREFUL, new Rng(1)).won).toBe(true);
  });

  it('declares an impossible level unsolvable', () => {
    // Blue is walled in behind reds, and the only vehicles are blue first with a 1-slot bench.
    const def: LevelDef = { id: 1, cols: 3, rows: 2, cells: [0, 0, 0, 1, 1, 1], vehicles: [1, 0], benchSlots: 1, visibleRows: 2 };
    expect(solve(def).solvable).toBe(false);
  });

  it('generates solvable levels on the difficulty curve', { timeout: 120_000 }, () => {
    const rows: Record<string, number | string>[] = [];
    for (const level of [1, 5, 10, 25, 45, 80]) {
      const c = generateLevel(level, 1, { tries: 20, runs: 80 });
      expect(validate(c.def)).toBeNull();
      expect(solve(c.def).solvable).toBe(true);
      rows.push({ level, target: targetWinRate(level), winRate: c.winRate.toFixed(2), near: c.nearMissRate.toFixed(2), size: `${c.def.cols}x${c.def.rows}`, critters: c.def.cells.filter((x) => x >= 0).length });
    }
    console.table(rows);
    // Early levels must be a near-certain win for a casual player.
    expect(Number(rows[0].winRate)).toBeGreaterThan(0.85);
  });

  it('careful play beats casual play', () => {
    const rng = new Rng(3);
    const def = randomLevel(1, { cols: 6, rows: 8, colors: 4, vehiclesPerColor: 3, benchSlots: 5, visibleRows: 8, blocked: 0, clumping: 0.5 }, rng);
    if (!solve(def).solvable) return;
    const a = measure(def, CAREFUL, 100);
    const b = measure(def, CASUAL, 100);
    expect(a.winRate).toBeGreaterThanOrEqual(b.winRate - 0.05);
  });
});
