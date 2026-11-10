/**
 * BOT v0.2 balance-pass checks (spec 7.3 / 7.1 findings from the v1.1 macro-sim verification):
 *  1. A max-HP gain (Vitality pick) never adds current HP outside the 1.5%/s heal cap.
 *  2. Burst timing is jittered per RUN, not just per attempt number: two runs on the same day and attempt
 *     that move differently get different burst ticks, while a replay of the same inputs is identical.
 */
import { describe, expect, it } from 'vitest';
import { seedForDay } from '../core/daily';
import { EV } from '../core/events';
import { encodeInput } from '../core/input';
import { BAL, TICK_HZ } from '../core/constants';
import { choose, createWorld, step, type World } from '../core/world';
import { buildModifiers } from '../content/omens';
import { addPassive } from './build';
import { healCapPerSec } from './player';

function world(day = 312, attempt = 0): World {
  const seed = seedForDay(day, attempt);
  const mods = buildModifiers(seed.omenId, seed.twistId);
  mods.tags.add('debug-guard'); // HP floors at 40%: these tests watch timing, not survival
  return createWorld(seed, 'ember', mods);
}

function stepN(w: World, n: number, input: (w: World) => number): void {
  for (let k = 0; k < n && !w.over; k++) {
    if (w.offer.open) {
      choose(w, 0);
      k--;
      continue;
    }
    step(w, input(w));
  }
}

describe('heal cap: max-HP gains (spec 7.3 Vitality leak)', () => {
  it('a Vitality pick adds no current HP at once and pays out at most 1.5%/s', () => {
    const w = world();
    stepN(w, 90 * TICK_HZ, () => 0);
    if (w.over) throw new Error('test run died early');
    // simulate a hurt player taking five Vitality ranks in one go (the worst case for a leak)
    w.mods.tags.delete('debug-guard'); // the guard's 40% HP floor would "heal" a hit player; watch the real rules
    w.player.hp = w.player.maxHp * 0.5;
    w.player.healPending = 0;
    w.stats.regenPerSec = 0;
    const hp0 = w.player.hp;
    const max0 = w.player.maxHp;
    for (let k = 0; k < 5; k++) addPassive(w, 'vitality');
    expect(w.player.maxHp).toBeGreaterThan(max0 * 1.5);
    expect(w.player.hp).toBe(hp0); // nothing leaks at the pick
    // then: healing per second never exceeds the cap of the (new) max HP
    const capPerSec = healCapPerSec(w) * w.player.maxHp;
    let prevHealed = w.player.healedTotal;
    let prevHp = w.player.hp;
    for (let s = 0; s < 10 && !w.over; s++) {
      // freeze the world: no enemies may hit us, we just watch the heal budget
      w.en.count = 0;
      for (let i = 0; i < w.en.hi; i++) w.en.alive[i] = 0;
      w.en.hi = 0;
      stepN(w, TICK_HZ, () => 0);
      const healed = w.player.healedTotal - prevHealed;
      expect(healed).toBeLessThanOrEqual(capPerSec * (1 + 1e-9) + 1e-6);
      // current HP may only go up by what the capped heal paid (damage can only lower it)
      expect(w.player.hp - prevHp).toBeLessThanOrEqual(capPerSec * (1 + 1e-9) + 1e-6);
      prevHealed = w.player.healedTotal;
      prevHp = w.player.hp;
    }
    expect(BAL.healCap).toBeLessThanOrEqual(0.015 + 1e-12);
  });
});

describe('bursts: per-run jitter (spec 7.1: lethal telegraphs must not share a global tick)', () => {
  function burstTicks(w: World, input: (w: World) => number, untilSec: number): number[] {
    const out: number[] = [];
    for (let guard = 0; !w.over && w.tick < untilSec * TICK_HZ && guard < untilSec * TICK_HZ * 3; guard++) {
      if (w.offer.open) {
        choose(w, 0);
        continue;
      }
      w.events.clear();
      step(w, input(w));
      const ev = w.events;
      for (let i = 0; i < ev.n; i++) {
        if (ev.kind[i] === EV.TELEGRAPH && ev.c[i] === 0 /* red */ && w.hazard.cat[ev.a[i]] === 1 /* TGC.BURST */) out.push(w.tick);
      }
    }
    return out;
  }
  const circle = (w: World): number => {
    const p = w.player;
    const r = Math.sqrt(p.x * p.x + p.y * p.y) || 1;
    return encodeInput(-p.y / r - (p.x / r) * (r > 10 ? 0.3 : 0), p.x / r, false);
  };
  const line = (w: World): number => (w.player.x < 18 ? encodeInput(1, 0.2, false) : encodeInput(-0.3, 1, false));

  it('same day + same attempt but different movement => different burst ticks; same inputs => identical', () => {
    const a = burstTicks(world(312, 0), circle, 240);
    const a2 = burstTicks(world(312, 0), circle, 240);
    const b = burstTicks(world(312, 0), line, 240);
    expect(a.length).toBeGreaterThan(5);
    expect(a2).toEqual(a);
    // the shared nominal schedule is the same, the per-run jitter is not: most bursts land on a different tick
    const n = Math.min(a.length, b.length);
    let same = 0;
    for (let i = 0; i < n; i++) if (a[i] === b[i]) same++;
    expect(same).toBeLessThan(n * 0.5);
    // and the jitter stays inside +-BAL.burstJitter of the shared schedule
    for (let i = 0; i < n; i++) expect(Math.abs(a[i] - b[i])).toBeLessThanOrEqual(2 * BAL.burstJitter * TICK_HZ + 1);
  });
});
