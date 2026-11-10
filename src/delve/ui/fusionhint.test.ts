import { describe, expect, it } from 'vitest';
import { createWorld } from '../core/world';
import { seedForDay } from '../core/daily';
import { buildModifiers } from '../content/omens';
import type { Card } from '../sim/offers';
import { cardFusionHint } from './fusionhint';
import { addSpell } from '../sim/build';
import { SPELL_IDX } from '../content/spells';
import { BOSS_TIPS, deathSummary } from '../app/runlog';
import { DEATH } from '../core/types';
import { BOSSES } from '../content/bosses';

const world = () => {
  const seed = seedForDay(312);
  return createWorld(seed, 'ember', buildModifiers(seed.omenId, seed.twistId));
};
const card = (kind: Card['kind'], ref: string, rank: number): Card => ({ kind, ref, title: ref, desc: '', keywords: [], rank, rarity: 'common' });

describe('fusion hint in plain words (v0.2 review: "(R5 + R4)" was jargon)', () => {
  it('a new partner card says which ranks fuse and how many picks remain', () => {
    const w = world();
    w.build.slotRank[0] = 2; // Firebolt (Ember signature) at rank 2
    const h = cardFusionHint(w, card('spell', 'bileFlask', 1));
    expect(h).not.toBeNull();
    expect(h!.text).not.toMatch(/R5|R4/);
    expect(h!.text).toContain('Fever Bloom');
    expect(h!.text).toContain('Firebolt');
    // best split: Firebolt 2 -> 5 (3 picks) + Bile Flask 1 -> 4 (3 picks) = 6
    expect(h!.picks).toBe(6);
  });

  it('one pick away and unlocking read as such', () => {
    const w = world();
    w.build.slotRank[0] = 5;
    const s = addSpell(w, SPELL_IDX.get('bileFlask')!);
    w.build.slotRank[s] = 2;
    const one = cardFusionHint(w, card('rank', 'bileFlask', 3));
    expect(one!.picks).toBe(1);
    expect(one!.text).toMatch(/^1 pick from Fever Bloom/);
    w.build.slotRank[s] = 3;
    const now = cardFusionHint(w, card('rank', 'bileFlask', 4));
    expect(now!.picks).toBe(0);
    expect(now!.text).toMatch(/^Unlocks Fever Bloom/);
  });
});

describe('death tips name the counter to the boss that was up (v0.2 review)', () => {
  it('one tip per boss', () => expect(BOSS_TIPS.length).toBe(BOSSES.length));
  it('boss deaths and crowd deaths with a live boss use the boss tip', () => {
    const b = deathSummary(DEATH.BOSS, 175, null, { bossName: 'The Drowned Engine', liveBoss: 2 });
    expect(b.tip).toContain('sideways');
    const c = deathSummary(DEATH.CHIP, 175, null, { bossName: 'The Drowned Engine', liveBoss: 2, spells: 2, maxRank: 4 });
    expect(c.tip).toContain('Drowned Engine');
  });
  it('a spread, unfused build gets the focus tip', () => {
    const c = deathSummary(DEATH.CHIP, 175, null, { spells: 6, maxRank: 2, fusions: 0, liveBoss: -1 });
    expect(c.tip).toMatch(/spread over 6 spells/);
  });
});
