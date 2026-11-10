import { describe, expect, it } from 'vitest';
import { seedForDay } from '../core/daily';
import { Rng } from '../core/rng';
import { choose, createWorld, type World } from '../core/world';
import { CH_BANISH, CH_PICK, CH_REROLL, kwBit, type SpecId } from '../core/types';
import { buildModifiers } from '../content/omens';
import { SPELLS, spellIndex } from '../content/spells';
import { addSpell, slotOf } from './build';
import { canBanish, levelPool, OK, queueOffer, type Card } from './offers';

function world(spec: SpecId = 'ember', day = 312, twist = 'none'): World {
  const seed = seedForDay(day, 0);
  return createWorld({ ...seed, twistId: twist }, spec, buildModifiers(seed.omenId, twist));
}
const sig = (cards: Card[]): string => cards.map((c) => `${c.kind}:${c.ref}:${c.rank}`).join(',');

/** Drive `n` level offers, picking with a seeded chooser; returns the sequence of offered card lists. */
function drive(w: World, n: number, chooser: Rng): string[] {
  const seen: string[] = [];
  for (let k = 0; k < n; k++) {
    queueOffer(w, OK.LEVEL);
    while (w.offer.open) {
      seen.push(sig(w.offer.open.cards));
      choose(w, CH_PICK + chooser.int(w.offer.open.cards.length));
    }
  }
  return seen;
}

describe('offers (spec 6.4)', () => {
  it('are deterministic for the same day, spec and history', () => {
    for (const spec of ['ember', 'venom'] as SpecId[]) {
      const a = drive(world(spec), 25, new Rng(7));
      const b = drive(world(spec), 25, new Rng(7));
      expect(a).toEqual(b);
      expect(a.length).toBe(25);
    }
  });

  it('change with history, day and spec', () => {
    const base = drive(world('ember'), 12, new Rng(7));
    expect(drive(world('ember'), 12, new Rng(8))).not.toEqual(base);
    expect(drive(world('ember', 313), 12, new Rng(7))).not.toEqual(base);
    expect(drive(world('venom'), 12, new Rng(7))).not.toEqual(base);
  });

  it('reroll and banish are deterministic, limited to 2 and 1, and banish removes the item for the run', () => {
    const run = (): string[] => {
      const w = world('ember');
      queueOffer(w, OK.LEVEL);
      const out = [sig(w.offer.open!.cards)];
      expect(choose(w, CH_REROLL)).toBe(true);
      out.push(sig(w.offer.open!.cards));
      expect(choose(w, CH_REROLL)).toBe(true);
      expect(choose(w, CH_REROLL)).toBe(false);
      const victim = w.offer.open!.cards.find((c) => canBanish(w, c))!;
      const vi = w.offer.open!.cards.indexOf(victim);
      expect(choose(w, CH_BANISH + vi)).toBe(true);
      expect(choose(w, CH_BANISH)).toBe(false);
      out.push(sig(w.offer.open!.cards));
      // banished item never comes back
      for (let k = 0; k < 15; k++) {
        expect(w.offer.open!.cards.some((c) => c.ref === victim.ref)).toBe(false);
        choose(w, CH_PICK);
        queueOffer(w, OK.LEVEL);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });

  it('never banishes the rank-up of your own signature spell', () => {
    const w = world('ember');
    queueOffer(w, OK.LEVEL);
    const sigCard = { kind: 'rank', ref: 'firebolt', title: '', desc: '', keywords: ['fire'], rank: 2, rarity: 'common' } as Card;
    expect(canBanish(w, sigCard)).toBe(false);
    expect(canBanish(w, { ...sigCard, ref: 'chainSpark' } as Card)).toBe(true);
    w.offer.open!.cards[0] = sigCard;
    expect(choose(w, CH_BANISH)).toBe(false);
    expect(w.offer.banishesLeft).toBe(1);
  });

  it('always offers an upgrade of something owned, never a keyword triple, and the right count', () => {
    for (const spec of ['ember', 'venom'] as SpecId[]) {
      for (const twist of ['none', 'leanSeam']) {
        const w = world(spec, 312, twist);
        const r = new Rng(99);
        for (let k = 0; k < 40; k++) {
          queueOffer(w, OK.LEVEL);
          const cards = w.offer.open!.cards;
          if (cards[0].kind !== 'limit' && cards[0].kind !== 'mend') {
            expect(cards.length).toBe(Math.min(w.mods.choices, cards.length));
            const owned = cards.some((c) => c.kind === 'rank' || c.kind === 'fusion' || (c.kind === 'passive' && c.rank > 1));
            const poolHasUpgrade = levelPool(w).some((it) => it.upgrade);
            if (poolHasUpgrade) expect(owned).toBe(true);
            if (cards.length >= 3) {
              let common = 0xffff;
              for (const c of cards) {
                let m = 0;
                for (const kw of c.keywords) m |= kwBit(kw);
                common &= m;
              }
              expect(common).toBe(0);
            }
          }
          choose(w, CH_PICK + r.int(cards.length));
        }
      }
    }
  });

  it('epic cards are gated before 2:00 (mods.epicGateSec)', () => {
    const w = world('ember');
    expect(levelPool(w).some((it) => it.card.rarity === 'epic' && it.card.kind !== 'fusion')).toBe(false);
    w.tick = 60 * 130;
    expect(levelPool(w).some((it) => it.card.ref === 'sunSpear')).toBe(true);
  });

  it('keyword affinity and the rank-up boost raise weights; pity moves +1% per pick without a rare', () => {
    const w = world('ember');
    const pool = levelPool(w);
    const fire = pool.find((it) => it.card.ref === 'cinderTrail')!;
    const frost = pool.find((it) => it.card.ref === 'frostNova')!;
    expect(fire.weight).toBe(frost.weight * 1.5); // 1 owned fire spell: x1.5
    const rank = pool.find((it) => it.card.kind === 'rank' && it.card.ref === 'firebolt')!;
    expect(rank.weight).toBe(100 * 3 * 2 * 100); // common x kw(2 half-steps + 1) x rank-up 2 x pity 100
    const p0 = w.offer.pityPct;
    expect(p0).toBe(-5);
    queueOffer(w, OK.LEVEL);
    const hadRare = w.offer.open!.hadRare;
    choose(w, CH_PICK);
    expect(w.offer.pityPct).toBe(hadRare ? -5 : -4);
  });

  it('an eligible fusion is offered within 3 picks of eligibility', () => {
    for (let day = 300; day < 312; day++) {
      const w = world('ember', day);
      w.tick = 60 * 200;
      w.build.slotRank[slotOf(w, spellIndex('firebolt'))] = 5;
      const s = addSpell(w, spellIndex('chainSpark'));
      w.build.slotRank[s] = 4;
      let offeredAt = -1;
      for (let k = 0; k < 3 && offeredAt < 0; k++) {
        queueOffer(w, OK.LEVEL);
        const cards = w.offer.open!.cards;
        const fi = cards.findIndex((c) => c.kind === 'fusion');
        if (fi >= 0) offeredAt = k;
        else {
          // pick something that does not touch the fusion parents
          const safe = cards.findIndex((c) => c.kind === 'passive' || (c.kind === 'spell' && !c.keywords.includes('fire') && !c.keywords.includes('storm')));
          choose(w, CH_PICK + Math.max(0, safe));
        }
      }
      expect(offeredAt, `day ${day}`).toBeGreaterThanOrEqual(0);
      const fi = w.offer.open!.cards.findIndex((c) => c.kind === 'fusion');
      choose(w, CH_PICK + fi);
      expect(w.build.slotSpell.includes(spellIndex('plasmaArc'))).toBe(true);
      expect(w.score.fusions).toBe(1);
    }
  });

  it('Core rank-ups are half-ranks and Tempered offers appear in the Core', () => {
    const w = world('venom');
    w.tick = 60 * 310;
    w.layer = 6;
    const pool = levelPool(w);
    const rank = pool.find((it) => it.card.kind === 'rank')!;
    expect(rank.card.rank).toBe(1.5);
    expect(pool.some((it) => it.card.kind === 'tempered')).toBe(true);
  });

  it('a boss talent pick is followed by the chest doors; Relic door offers 3 relics', () => {
    const w = world('ember');
    queueOffer(w, OK.TALENT);
    expect(w.offer.open!.kind).toBe(OK.TALENT);
    expect(w.offer.open!.cards.length).toBe(3);
    queueOffer(w, OK.DOOR); // same-tick duplicate from COMBAT is dropped
    choose(w, CH_PICK);
    expect(w.build.talents.length).toBe(1);
    expect(w.offer.open!.kind).toBe(OK.DOOR);
    const relicDoor = w.offer.open!.cards.findIndex((c) => c.ref === 'relic');
    choose(w, CH_PICK + relicDoor);
    expect(w.offer.open!.kind).toBe(OK.RELIC);
    expect(w.offer.open!.cards.length).toBe(3);
    choose(w, CH_PICK);
    expect(w.build.relics.length).toBe(1);
    expect(w.offer.open).toBeNull();
    expect(w.offer.queue.length).toBe(0);
  });

  it('new spells stop once all 6 slots are full', () => {
    const w = world('ember');
    for (const id of ['chainSpark', 'shadeBolt', 'frostNova', 'steelOrbit', 'bileFlask']) addSpell(w, spellIndex(id));
    expect(levelPool(w).some((it) => it.card.kind === 'spell')).toBe(false);
    expect(SPELLS.length).toBeGreaterThan(16);
  });
});
