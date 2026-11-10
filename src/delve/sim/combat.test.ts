/**
 * COMBAT tests: lethality, the 14:32 Wyrmfall bound, the heal cap, telegraph minimums, boss timeline,
 * carry-over cap, formations and determinism of the combat systems.
 */
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000 });
import { seedForDay } from '../core/daily';
import { EV } from '../core/events';
import { encodeInput } from '../core/input';
import { DEATH, EF, TGF, type SpecId } from '../core/types';
import { choose, createWorld, step, type World } from '../core/world';
import { hashWorld } from '../core/replay';
import { buildModifiers } from '../content/omens';
import { BAL, TICK_HZ } from '../core/constants';
import { BOUND_SECONDS, healPlayer, queueHeal, refreshMaxHp } from './player';
import { pointInTelegraph } from './hazards';

const MAX_TICKS = 16 * 60 * TICK_HZ;

function world(spec: SpecId = 'ember', day = 312, attempt = 0, omen?: string, twist?: string): World {
  const seed = seedForDay(day, attempt);
  return createWorld(seed, spec, buildModifiers(omen ?? seed.omenId, twist ?? seed.twistId));
}

/** Run until over (or the tick cap). `input` returns the input byte; `before` may tamper with stats. */
function run(w: World, input: (w: World) => number, before?: (w: World) => void, onEvents?: (w: World) => void): void {
  let guard = 0;
  while (!w.over && w.tick < MAX_TICKS && guard++ < MAX_TICKS * 3) {
    if (w.offer.open) {
      choose(w, 0);
      continue;
    }
    before?.(w);
    w.events.clear();
    step(w, input(w));
    onEvents?.(w);
  }
}

/** Circle-kite around the arena and step into the maw ring once the Wyrm is up. */
function kite(w: World): number {
  const p = w.player;
  const h = w.hazard;
  if (h.wyrmActive) return encodeInput(h.mawX - p.x, h.mawY - p.y, false);
  const r = Math.sqrt(p.x * p.x + p.y * p.y) || 1;
  const pull = r > 14 ? (r - 14) * 0.3 : 0;
  return encodeInput(-p.y / r - (p.x / r) * pull, p.x / r - (p.y / r) * pull, false);
}

/** Make the player near-invulnerable to everything but the Wyrmfall, with 10x damage, capped armor and silly regen. */
function stress(w: World): void {
  w.stats.might = 9; // 10x damage
  w.stats.armor = 1e7; // DR cap 75%
  w.stats.regenPerSec = 5; // 500%/s requested: the heal cap must hold it to 1.5%/s
  // (max HP is left alone: breath and the heal cap both scale with it, so it cannot move the bound)
  // top up anything non-Wyrm damage took (as if every burst and touch were dodged), except breath
  if (!w.hazard.wyrmActive) w.player.hp = w.player.maxHp;
}

/** Remove every damage source except the breath: no contact, telegraphs deal nothing. */
function pacify(w: World): void {
  for (let i = 0; i < w.en.hi; i++) if (w.en.alive[i]) w.en.touchCd[i] = 200;
  for (let i = 0; i < w.tg.hi; i++) if (w.tg.alive[i]) w.tg.dmgPct[i] = 0;
}

describe('combat: lethality', () => {
  it('a do-nothing player dies, and not to the Wyrmfall', () => {
    const w = world('ember');
    run(w, () => 0);
    expect(w.over).toBe(true);
    expect(w.tick).toBeLessThan(BAL.wyrmT * TICK_HZ);
    expect(w.deathCause).not.toBe(DEATH.WYRMFALL);
    expect(w.deathCause).not.toBe(DEATH.NONE);
  });

  it('a do-nothing Venom player under Swarming dies too', () => {
    const w = world('venom', 312, 0, 'swarming', 'leanSeam');
    run(w, () => 0);
    expect(w.over).toBe(true);
    expect(w.tick).toBeLessThan(BAL.wyrmT * TICK_HZ);
  });
});

describe('combat: the 14:32 bound (spec 7.4)', () => {
  it('a 10x-damage, armor-capped, regen-maxed kiter standing in the maw still dies by 14:32', () => {
    const w = world('ember');
    let maxStagger = 0;
    run(w, kite, stress, (ww) => {
      maxStagger = Math.max(maxStagger, ww.hazard.stagger);
    });
    expect(w.over).toBe(true);
    // breath, rocks or a late burst: whatever ends it, it reaches the Wyrmfall and ends by 14:32
    expect(w.tick).toBeGreaterThan(BAL.wyrmT * TICK_HZ);
    expect(w.tick).toBeLessThanOrEqual(BOUND_SECONDS * TICK_HZ);
    expect(maxStagger).toBeLessThanOrEqual(BAL.staggerCap);
    expect(w.hazard.stagger).toBeGreaterThan(0); // the ring/head damage race is live
  });

  it('the breath alone ends a run before the backstop even at the full 45 s stagger', () => {
    const w = world('venom');
    run(w, kite, (ww) => {
      stress(ww);
      pacify(ww);
      if (ww.hazard.wyrmActive) {
        ww.hazard.stagger = BAL.staggerCap;
        ww.hazard.staggerDmg = 0;
      }
    });
    expect(w.over).toBe(true);
    expect(w.deathCause).toBe(DEATH.WYRMFALL);
    // 720 + 45 + 106.5 s of breath = 871.5 s: dead by breath, before player.ts's 872 s backstop
    expect(w.tick).toBeLessThan(BOUND_SECONDS * TICK_HZ);
    expect(w.tick).toBeGreaterThan((BAL.wyrmT + BAL.staggerCap + 100) * TICK_HZ);
  });

  it('an over-cap heal stat cannot extend past 14:32', () => {
    const w = world('ember');
    run(w, kite, (ww) => {
      stress(ww);
      ww.stats.healCap = 1; // a bug elsewhere must not break the bound
      if (ww.hazard.wyrmActive) ww.hazard.stagger = BAL.staggerCap;
    });
    expect(w.over).toBe(true);
    expect(w.tick).toBeLessThanOrEqual(BOUND_SECONDS * TICK_HZ);
  });
});

describe('combat: heal cap (1.5% of max HP per second, all healing combined)', () => {
  it('direct heals within one tick are capped at 1.5%/60 of max HP', () => {
    const w = world();
    w.tick = 100;
    w.player.hp = 10;
    let healed = 0;
    for (let k = 0; k < 50; k++) healed += healPlayer(w, 40);
    expect(healed).toBeCloseTo((0.015 * w.player.maxHp) / TICK_HZ, 9);
    expect(w.player.healOverflow).toBeGreaterThan(1900);
  });

  it('regen + lump heals + direct heals never exceed 1.5% in any 1 s window of a live run', () => {
    const w = world('venom');
    let lowest = Infinity;
    const healedAt: number[] = [];
    const maxHpAt: number[] = [];
    run(w, kite, (ww) => {
      ww.stats.regenPerSec = 3;
      ww.stats.maxHpMul = 1 + (ww.tick % 600) / 300; // max HP flicker must not leak healing either
      refreshMaxHp(ww);
    }, (ww) => {
      // extra heals inside the same tick as the step's regen
      healPlayer(ww, 25);
      if (ww.tick % 30 === 0) queueHeal(ww, 30);
      healedAt[ww.tick] = ww.player.healedTotal;
      maxHpAt[ww.tick] = Math.max(maxHpAt[ww.tick - 1] ?? 0, ww.player.maxHp);
      if (ww.tick > 3 * 60 * TICK_HZ) ww.over = true; // three minutes is plenty
    });
    for (let t = TICK_HZ + 1; t < healedAt.length; t++) {
      if (healedAt[t] === undefined || healedAt[t - TICK_HZ] === undefined) continue;
      const win = healedAt[t] - healedAt[t - TICK_HZ];
      lowest = Math.min(lowest, win);
      expect(win).toBeLessThanOrEqual(0.015 * BAL.baseMaxHp * 3 + 1e-6);
      expect(win).toBeLessThanOrEqual(maxHpAt[t] * 0.015 * (1 + 1e-9) + 1e-6);
    }
    expect(lowest).toBeLessThan(Infinity);
  });
});

describe('combat: telegraphs and bosses', () => {
  it('every telegraph has the minimum wind-up (1.2 s Descent, 0.8 s Core) and bosses spawn at :40 with fixed HP', () => {
    const w = world('ember');
    const spawns: { t: number; hp: number; layer: number }[] = [];
    let minDescent = Infinity;
    let minCore = Infinity;
    run(w, kite, (ww) => stress(ww), (ww) => {
      const ev = ww.events;
      for (let k = 0; k < ev.n; k++) {
        if (ev.kind[k] === EV.TELEGRAPH) {
          const isMaw = (ww.tg.flags[ev.a[k]] & TGF.MAW) !== 0;
          if (isMaw) continue;
          if (ww.layer >= 6) minCore = Math.min(minCore, ev.v[k]);
          else minDescent = Math.min(minDescent, ev.v[k]);
        }
        if (ev.kind[k] === EV.BOSS_SPAWN) spawns.push({ t: ww.tick / TICK_HZ, hp: ev.v[k], layer: ev.c[k] });
      }
      if (ww.tick > 9 * 60 * TICK_HZ) ww.over = true;
    });
    expect(minDescent).toBeGreaterThanOrEqual(1.2 - 1e-6);
    expect(minCore).toBeGreaterThanOrEqual(0.8 - 1e-6);
    expect(spawns.map((s) => s.layer)).toEqual([1, 2, 3, 4, 5]);
    spawns.forEach((s, k) => {
      expect(s.t).toBeCloseTo(k * 60 + 40, 1);
      expect(s.hp).toBe(BAL.bossHP[k]);
    });
  });

  it('unkilled bosses carry over and are capped at 50% HP on entering the Core', () => {
    const w = world('venom');
    run(w, kite, (ww) => {
      stress(ww);
      ww.stats.might = -1; // deal no damage at all
    }, (ww) => {
      if (ww.tick >= 300 * TICK_HZ + 2) ww.over = true;
    });
    const b = w.boss;
    let alive = 0;
    for (let k = 0; k < 5; k++) {
      const i = b.slot[k];
      if (i < 0 || !w.en.alive[i]) continue;
      alive++;
      expect(w.en.flags[i] & EF.BOSS).toBeTruthy();
      expect(w.en.hp[i]).toBeLessThanOrEqual(0.5 * w.en.maxHp[i] + 1e-3);
    }
    expect(alive).toBe(5);
  });

  it('formations start at 6:00 and the maw opens before 12:00', () => {
    const w = world('ember');
    const forms: number[] = [];
    let mawAt = -1;
    run(w, kite, stress, (ww) => {
      const ev = ww.events;
      for (let k = 0; k < ev.n; k++) {
        if (ev.kind[k] === EV.FORMATION) forms.push(ww.tick / TICK_HZ);
        if (ev.kind[k] === EV.WYRMFALL && mawAt < 0) mawAt = ww.tick / TICK_HZ;
      }
      if (ww.tick > 12.2 * 60 * TICK_HZ) ww.over = true;
    });
    expect(forms.length).toBeGreaterThanOrEqual(15);
    expect(forms[0]).toBeGreaterThanOrEqual(360);
    for (let k = 1; k < forms.length; k++) {
      expect(forms[k] - forms[k - 1]).toBeGreaterThanOrEqual(19);
      expect(forms[k] - forms[k - 1]).toBeLessThanOrEqual(31);
    }
    expect(mawAt).toBeGreaterThan(700);
    expect(mawAt).toBeLessThan(720);
  });

  it('cones, lanes and rings resolve against the 70% hurtbox', () => {
    const w = world();
    const tg = w.tg;
    const i = tg.alloc();
    // cone: apex at origin, pointing +x, half-angle 0.4 rad, length 6
    tg.shape[i] = 2;
    tg.x[i] = 0;
    tg.y[i] = 0;
    tg.x2[i] = 6;
    tg.y2[i] = 0;
    tg.r[i] = 6;
    tg.arc[i] = 0.4;
    expect(pointInTelegraph(w, i, 3, 0, 0.3)).toBe(true);
    expect(pointInTelegraph(w, i, 3, 2.5, 0.3)).toBe(false);
    expect(pointInTelegraph(w, i, -2, 0, 0.3)).toBe(false);
    expect(pointInTelegraph(w, i, 6.2, 0, 0.3)).toBe(true);
    // ring: outer 5, inner 3
    tg.shape[i] = 3;
    tg.r[i] = 5;
    tg.arc[i] = 3;
    expect(pointInTelegraph(w, i, 4, 0, 0.3)).toBe(true);
    expect(pointInTelegraph(w, i, 1, 0, 0.3)).toBe(false);
    // lane from (0,0) to (10,0), half-width 1
    tg.shape[i] = 1;
    tg.x2[i] = 10;
    tg.y2[i] = 0;
    tg.r[i] = 1;
    expect(pointInTelegraph(w, i, 5, 1.2, 0.3)).toBe(true);
    expect(pointInTelegraph(w, i, 5, 1.4, 0.3)).toBe(false);
  });
});

describe('combat: determinism', () => {
  it('two identical kiting runs to 6:30 hash the same; another attempt jitters the bursts', () => {
    const go = (attempt: number) => {
      const w = world('ember', 312, attempt);
      run(w, kite, stress, (ww) => {
        if (ww.tick >= 390 * TICK_HZ) ww.over = true;
      });
      return { hash: hashWorld(w), bursts: w.hazard.bursts, jitter: w.hazard.burstJitter };
    };
    const a = go(0);
    const b = go(0);
    const c = go(1);
    expect(a.hash).toBe(b.hash);
    expect(c.hash).not.toBe(a.hash);
    expect(a.bursts).toBeGreaterThan(20);
  });
});
