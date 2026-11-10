import { describe, expect, it } from 'vitest';
import { BAL } from '../core/constants';
import { createWorld } from '../core/world';
import { seedForDay } from '../core/daily';
import { buildModifiers } from '../content/omens';
import { PASSIVES } from '../content/passives';
import type { Card } from '../sim/offers';
import { armorDRAt, cardNumbers, rankGain, rankLine } from './cardcopy';

const world = () => {
  const seed = seedForDay(312);
  return createWorld(seed, 'ember', buildModifiers(seed.omenId, seed.twistId));
};
const card = (kind: Card['kind'], ref: string, rank: number): Card => ({ kind, ref, title: ref, desc: '', keywords: [], rank, rarity: 'common' });

describe('card numbers (v0.2: cards say exactly what the pick does)', () => {
  it('rank-up gain follows BAL.rankMult step by step', () => {
    expect(rankLine(1, 2)).toBe('Rank 1 → 2: +50% damage');
    expect(rankLine(2, 3)).toBe('Rank 2 → 3: +40% damage');
    expect(rankLine(3, 4)).toBe('Rank 3 → 4: +33% damage');
    expect(rankLine(4, 5)).toBe('Rank 4 → 5: +29% damage');
    for (let r = 1; r < 5; r++) expect(rankGain(r, r + 1)).toBeCloseTo(BAL.rankMult[r + 1] / BAL.rankMult[r] - 1, 6);
    expect(rankLine(2, 2.5)).toBe('Rank 2 → 2.5: +20% damage'); // Core half-rank: 1.5 -> 1.8
  });

  it('rank-up card reads the owned rank from the build', () => {
    const w = world();
    const sig = w.build.slotSpell[0];
    expect(sig).toBeGreaterThanOrEqual(0);
    w.build.slotRank[0] = 3;
    const ref = ['firebolt', 'creepingRot'].find((id) => cardNumbers(w, card('rank', id, 4)).startsWith('Rank 3'));
    expect(ref).toBeDefined();
  });

  it('passives state their totals with the content numbers', () => {
    const w = world();
    const might = PASSIVES.find((p) => p.id === 'might')!;
    expect(cardNumbers(w, card('passive', 'might', 2))).toBe(`Spells: +${Math.round(2 * might.perRank * 100)}% damage in total (max +40%)`);
    expect(cardNumbers(w, card('passive', 'vitality', 1))).toBe('Max health: +15% in total (max +75%)');
    expect(cardNumbers(w, card('passive', 'regen', 1))).toBe('Heal 0.5% of max health per second');
    expect(cardNumbers(w, card('passive', 'crit', 1))).toBe(`5% of hits deal ${BAL.critMult}x damage`);
  });

  it('armor matches the sim formula at minute 0', () => {
    const w = world();
    const dr = armorDRAt(6, 0, w.mods.armorK0);
    expect(dr).toBeCloseTo(6 / (6 + w.mods.armorK0), 9);
    expect(cardNumbers(w, card('passive', 'armor', 1))).toContain(`critter hits -${Math.round(dr * 100)}%`);
  });

  it('cards that already state their numbers get no extra line', () => {
    const w = world();
    expect(cardNumbers(w, card('relic', 'lanternOil', 0))).toBe('');
    expect(cardNumbers(w, card('spell', 'chainSpark', 1))).toBe('');
  });
});
