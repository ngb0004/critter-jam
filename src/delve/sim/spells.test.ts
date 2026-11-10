import { describe, expect, it } from 'vitest';
import { CAP } from '../core/constants';
import { seedForDay } from '../core/daily';
import { choose, createWorld, step, type World } from '../core/world';
import { CH_PICK, ST, SRC, type SpecId } from '../core/types';
import { buildModifiers } from '../content/omens';
import { SPELLS } from '../content/spells';
import { botInput } from '../bot/bot';
import { addRelic, addTalent } from './build';
import { dealDamage, DMG, killEnemy } from './damage';
import { bench, benchRun, benchWorld } from './harness';
import { applyStatus } from './statuses';
import { RADIUS_CAP, areaRadius } from './spells';

describe('spell behaviours', () => {
  it('every spell (incl. fusions) damages a crowd, and area spells hit many targets', () => {
    for (const s of SPELLS) {
      const r = bench(s.id, 1, 30, 3, 3, 600);
      expect(r.dps, s.id).toBeGreaterThan(5);
      if (s.areaness >= 0.75 && s.behavior !== 'zone') expect(r.hit, s.id).toBeGreaterThanOrEqual(8);
    }
  });

  it('rank-5 spells hit about x3.6 harder than rank 1', () => {
    const a = bench('shivFan', 1, 1, 1.7, 0, 600);
    const b = bench('shivFan', 5, 1, 1.7, 0, 600);
    expect(b.dps / a.dps).toBeGreaterThan(3.2);
    expect(b.dps / a.dps).toBeLessThan(4);
  });

  it('area radius is capped at 38% of the short screen axis', () => {
    const w = benchWorld('firebolt', 1, 0, 3, 0);
    w.stats.areaMul = 10;
    expect(areaRadius(w, 3, true)).toBe(RADIUS_CAP);
    expect(RADIUS_CAP).toBeCloseTo(6.84, 2);
  });

  it('one hit per source per target per 0.2 s', () => {
    const w = benchWorld('firebolt', 1, 1, 3, 0);
    const e = 0;
    const d1 = dealDamage(w, e, 10, 0, 0);
    const d2 = dealDamage(w, e, 10, 0, 0);
    w.tick += 12;
    const d3 = dealDamage(w, e, 10, 0, 0);
    const d4 = dealDamage(w, e, 10, 1, 0); // another source is not gated
    expect(d1).toBeGreaterThan(0);
    expect(d2).toBe(0);
    expect(d3).toBeGreaterThan(0);
    expect(d4).toBeGreaterThan(0);
  });

  it('Creeping Rot spreads to a neighbour on death; plain poison does not', () => {
    const w = benchWorld('creepingRot', 1, 3, 3, 0.6, 'venom');
    w.grid.rebuild(w.en.alive, w.en.x, w.en.y, w.en.hi);
    applyStatus(w, 0, ST.POISON, 6, 4, 3, 12, 0, true);
    applyStatus(w, 1, ST.POISON, 6, 4, 3, 12, 0, false);
    killEnemy(w, 0, 0);
    expect(w.en.stStacks[2 * CAP.statuses + ST.POISON]).toBeGreaterThan(0);
    const before = w.en.stStacks[2 * CAP.statuses + ST.POISON];
    killEnemy(w, 1, 0);
    expect(w.en.stStacks[2 * CAP.statuses + ST.POISON]).toBe(before);
  });

  it('5 chill stacks shatter; shock amplifies damage', () => {
    const w = benchWorld('frostNova', 1, 1, 1.5, 0);
    w.grid.rebuild(w.en.alive, w.en.x, w.en.y, w.en.hi);
    const hp0 = w.en.hp[0];
    applyStatus(w, 0, ST.CHILL, 5, 3, 100, 5, 0);
    benchRun(w, 1);
    expect(hp0 - w.en.hp[0]).toBeGreaterThanOrEqual(100);
    expect(w.en.stStacks[0 * CAP.statuses + ST.CHILL]).toBe(0);
    const v = benchWorld('frostNova', 1, 2, 3, 0.5);
    v.build.slotSpell.fill(-1);
    const plain = dealDamage(v, 0, 10, 11, DMG.NO_STAMP);
    applyStatus(v, 1, ST.SHOCK, 3, 2, 0, 3, 0);
    const shocked = dealDamage(v, 1, 10, 11, DMG.NO_STAMP);
    expect(shocked / plain).toBeCloseTo(1.24, 3);
  });

  it('procs cannot proc and stay inside their budget (Ember Heart)', () => {
    const w = benchWorld('firebolt', 1, 60, 3, 2.5);
    w.build.slotSpell.fill(-1);
    addRelic(w, 'emberHeart');
    w.grid.rebuild(w.en.alive, w.en.x, w.en.y, w.en.hi);
    for (let i = 0; i < 60; i++) {
      w.en.hp[i] = w.en.maxHp[i] = 1;
      applyStatus(w, i, ST.BURN, 3, 5, 1, 5, 0);
    }
    // a kill by the relic itself must not queue another proc
    killEnemy(w, 0, SRC.RELIC);
    expect(w.spells.procs.n).toBe(0);
    for (let i = 1; i < 30; i++) killEnemy(w, i, 0);
    expect(w.spells.procs.n).toBeLessThanOrEqual(6);
    benchRun(w, 1); // blasts kill burning neighbours (credited to RELIC): no cascade
    expect(w.spells.procs.n).toBe(0);
  });

  it('talent and relic rules change behaviour (Plague: 2 neighbours)', () => {
    const w = benchWorld('creepingRot', 1, 3, 3, 0.6, 'venom');
    addTalent(w, 'plague');
    w.grid.rebuild(w.en.alive, w.en.x, w.en.y, w.en.hi);
    applyStatus(w, 0, ST.POISON, 6, 4, 3, 12, 0, true);
    killEnemy(w, 0, 0);
    expect(w.en.stStacks[1 * CAP.statuses + ST.POISON]).toBeGreaterThan(0);
    expect(w.en.stStacks[2 * CAP.statuses + ST.POISON]).toBeGreaterThan(0);
  });
});

/** A simple build chooser: fusion > new spell (until 4) > rank-up > passive > anything. */
function simpleChoice(w: World): number {
  const cards = w.offer.open!.cards;
  const spells = w.build.slotSpell.filter((x) => x >= 0).length;
  const score = (c: (typeof cards)[number]): number =>
    c.kind === 'fusion' ? 9 : c.kind === 'spell' && spells < 4 ? 8 : c.kind === 'rank' ? 6 : c.kind === 'passive' ? 4 : c.kind === 'door' && c.ref === 'relic' ? 3 : 1;
  let best = 0;
  for (let i = 1; i < cards.length; i++) if (score(cards[i]) > score(cards[best])) best = i;
  return CH_PICK + best;
}

describe('bots', () => {
  for (const spec of ['ember', 'venom'] as SpecId[]) {
    it(`${spec}: a simple kiting bot gains levels, builds and kills things`, () => {
      const seed = seedForDay(312, 0);
      const w = createWorld(seed, spec, buildModifiers(seed.omenId, seed.twistId));
      let guard = 0;
      let levelAt60 = 0;
      while (!w.over && w.tick < 60 * 150 && guard++ < 60 * 400) {
        if (w.offer.open) {
          choose(w, simpleChoice(w));
          continue;
        }
        w.events.clear();
        step(w, botInput(w, { e: 0.8 }));
        if (w.tick === 60 * 60) levelAt60 = w.xp.level;
      }
      expect(levelAt60 === 0 ? w.xp.level : levelAt60).toBeGreaterThanOrEqual(3);
      expect(w.xp.level).toBeGreaterThanOrEqual(4);
      expect(w.score.kills).toBeGreaterThan(50);
      expect(w.build.slotSpell.filter((x) => x >= 0).length).toBeGreaterThanOrEqual(2);
    });
  }
});

describe('omens in the damage pipeline', () => {
  it('Ironhide: tiny hits x0.85 ramping to x1 at 15; shadow ignores it', () => {
    const seed = seedForDay(312, 0);
    const w = createWorld(seed, 'ember', buildModifiers('ironhide', 'none'));
    const e = benchWorld('firebolt', 1, 1, 3, 0); // just for a dummy layout
    void e;
    w.grid.rebuild(w.en.alive, w.en.x, w.en.y, w.en.hi);
    const slot = w.en.alloc();
    w.en.hp[slot] = w.en.maxHp[slot] = 1e6;
    w.en.armor[slot] = 0;
    w.en.flags[slot] = 0;
    const tiny = dealDamage(w, slot, 1, 11, DMG.NO_STAMP);
    const mid = dealDamage(w, slot, 7.5, 11, DMG.NO_STAMP);
    const big = dealDamage(w, slot, 20, 11, DMG.NO_STAMP);
    const shade = dealDamage(w, slot, 5, 11, DMG.NO_STAMP | DMG.IGNORE_ARMOR);
    expect(tiny).toBeCloseTo(1 * (0.85 + 0.15 / 15), 5);
    expect(mid).toBeCloseTo(7.5 * 0.925, 5);
    expect(big).toBeCloseTo(20, 5);
    expect(shade).toBeCloseTo(5, 5);
  });
});
