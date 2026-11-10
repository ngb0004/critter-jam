import { describe, expect, it } from 'vitest';
import { BAL } from '../core/constants';
import { seedForDay } from '../core/daily';
import { EV } from '../core/events';
import { createWorld, type World } from '../core/world';
import type { SpecId } from '../core/types';
import { buildModifiers } from '../content/omens';
import { PASSIVES, TEMPERED } from '../content/passives';
import { RELICS } from '../content/relics';
import { SPELLS, spellIndex } from '../content/spells';
import { FUSIONS } from '../content/fusions';
import { TALENTS } from '../content/talents';
import { addPassive, addRelic, addSpell, addTalent, addTempered, eligibleFusions, fuse, recomputeStats, slotOf } from './build';
import { armorDR, healPlayer } from './player';

function world(spec: SpecId = 'ember', day = 312, omen?: string, twist?: string): World {
  const seed = seedForDay(day, 0);
  return createWorld(seed, spec, buildModifiers(omen ?? seed.omenId, twist ?? seed.twistId));
}

function setSpell(w: World, id: string, rank: number): number {
  let s = slotOf(w, spellIndex(id));
  if (s < 0) s = addSpell(w, spellIndex(id));
  w.build.slotRank[s] = rank;
  return s;
}

describe('content', () => {
  it('16 offerable spells, 3 fusion results, all 8 behaviour kinds', () => {
    const offer = SPELLS.filter((s) => !s.fusion);
    expect(offer.length).toBe(16);
    expect(SPELLS.filter((s) => s.fusion).length).toBe(3);
    const kinds = new Set(offer.map((s) => s.behavior));
    for (const k of ['projectile', 'splash', 'chain', 'orbit', 'aura', 'zone', 'summon', 'dot-spread']) expect(kinds.has(k as never)).toBe(true);
    const kws = new Set(offer.flatMap((s) => s.keywords));
    for (const k of ['fire', 'poison', 'storm', 'shadow', 'frost', 'steel', 'blade', 'orbit', 'radiant']) expect(kws.has(k as never)).toBe(true);
    expect(PASSIVES.length).toBe(8);
    expect(RELICS.length).toBe(8);
    expect(TALENTS.filter((t) => t.classId === 'pyre').length).toBe(6);
    expect(TALENTS.filter((t) => t.classId === 'cutpurse').length).toBe(6);
  });

  it('every fusion is reachable for both slice specs (parents exist in each spec pool)', () => {
    for (const spec of ['ember', 'venom'] as SpecId[]) {
      const cls = spec === 'ember' ? 'pyre' : 'cutpurse';
      const pool = SPELLS.filter((s) => !s.fusion && (s.owner === null || s.owner === spec || s.owner === cls));
      for (const f of FUSIONS) {
        expect(pool.some((s) => s.keywords.includes(f.a)), `${spec} ${f.id} ${f.a}`).toBe(true);
        expect(pool.some((s) => s.keywords.includes(f.b)), `${spec} ${f.id} ${f.b}`).toBe(true);
      }
    }
  });

  it('no relic or talent hook grants revives, invulnerability or direct healing', () => {
    const banned = /revive|invuln|immune|hp\s*=|\.hp\s*\+=|healPlayer/i;
    for (const r of [...RELICS, ...TALENTS]) {
      for (const h of Object.values(r.hooks)) expect(banned.test(String(h)), r.id).toBe(false);
    }
  });
});

describe('caps hold (spec 7.3)', () => {
  it('maxing every passive, Limit Break, Tempered and all relics/talents never breaks a cap', () => {
    for (const spec of ['ember', 'venom'] as SpecId[]) {
      const w = world(spec);
      // only 4 passive slots
      for (const p of PASSIVES) for (let k = 0; k < 9; k++) addPassive(w, p.id);
      expect(w.build.passiveOrder.length).toBe(BAL.passiveSlots);
      // fill the rest by force to test the stat caps on every passive
      for (const p of PASSIVES) w.build.passives[p.id] = BAL.maxRank;
      w.build.limitBreak = 999;
      for (let k = 0; k < 20; k++) for (const t of TEMPERED) addTempered(w, t.id);
      expect(w.build.tempered.length).toBe(6);
      for (const r of RELICS) addRelic(w, r.id);
      for (const t of TALENTS) addTalent(w, t.id);
      recomputeStats(w);
      const s = w.stats;
      expect(s.haste).toBeLessThanOrEqual(BAL.hasteCap * w.mods.hasteCapMul + 1e-9);
      expect(s.areaMul).toBeLessThanOrEqual(1 + BAL.areaCap + w.mods.areaCapAdd + 1e-9);
      expect(s.critChance).toBeLessThanOrEqual(BAL.critCap + 1e-9);
      expect(s.might).toBeLessThanOrEqual(BAL.mightCap + BAL.lbCap + 0.3 + 1e-9);
      expect(s.xpMul).toBeLessThanOrEqual(BAL.magnetCap + 1e-9);
      expect(s.regenPerSec).toBeLessThanOrEqual(BAL.healCap + 1e-9);
      expect(s.extraProjectiles).toBeLessThanOrEqual(BAL.maxExtraProjectiles);
      expect(s.maxHpMul).toBeLessThanOrEqual((1 + BAL.vitCap) * 1.35 + 1e-9);
      expect(armorDR(w)).toBeLessThanOrEqual(BAL.drCap);
      // ranks never pass 5
      for (const p of PASSIVES) addPassive(w, p.id);
      for (const p of PASSIVES) expect(w.build.passives[p.id]).toBeLessThanOrEqual(BAL.maxRank);
    }
  });

  it('passive values per rank match the spec table', () => {
    const w = world('ember', 312, 'none', 'none');
    for (let k = 0; k < 5; k++) {
      addPassive(w, 'might');
      addPassive(w, 'haste');
      addPassive(w, 'area');
      addPassive(w, 'magnet');
    }
    expect(w.stats.might).toBeCloseTo(0.4, 6);
    expect(w.stats.haste).toBeCloseTo(1.3, 6);
    expect(w.stats.areaMul).toBeCloseTo(1.5, 6);
    expect(w.stats.magnetMul).toBeCloseTo(2, 6);
    expect(w.stats.xpMul).toBeCloseTo(Math.min(1.3, Math.sqrt(2)), 6);
  });

  it('all healing respects the 1.5%/s heal cap', () => {
    const w = world('ember');
    w.player.hp = 10;
    w.tick = 100;
    let healed = 0;
    for (let k = 0; k < 10; k++) healed += healPlayer(w, 50);
    expect(healed).toBeLessThanOrEqual(w.stats.healCap * w.player.maxHp + 1e-9);
  });
});

describe('fusions (spec 6.2)', () => {
  it('rank 5 + rank 4 with different keywords triggers; consumes both, frees a slot, x2.4 on the fit sum', () => {
    const w = world('ember');
    const a = slotOf(w, spellIndex('firebolt'));
    w.build.slotRank[a] = 5;
    const b = setSpell(w, 'chainSpark', 3);
    expect(eligibleFusions(w).length).toBe(0); // rank 3 is not enough
    w.build.slotRank[b] = 4;
    const el = eligibleFusions(w);
    expect(el.length).toBe(1);
    expect(el[0].def.id).toBe('plasmaArc');
    const fitSum = w.build.slotFit[a] + w.build.slotFit[b];
    const keep = fuse(w, el[0].def, el[0].slotA, el[0].slotB);
    expect(w.build.slotSpell[keep]).toBe(spellIndex('plasmaArc'));
    expect(w.build.slotRank[keep]).toBe(5);
    expect(w.build.slotFit[keep]).toBeCloseTo(fitSum, 5);
    expect(w.build.slotSpell.filter((s) => s >= 0).length).toBe(1);
    expect(w.score.fusions).toBe(1);
    let sawFusion = false;
    for (let i = 0; i < w.events.n; i++) if (w.events.kind[i] === EV.FUSION) sawFusion = true;
    expect(sawFusion).toBe(true);
    expect(w.spells.fusionNova).toBe(keep);
    expect(eligibleFusions(w).length).toBe(0);
  });

  it('same keyword never fuses; all three slice fusions reachable; max 3 per run', () => {
    const w = world('ember');
    setSpell(w, 'firebolt', 5);
    setSpell(w, 'cinderTrail', 5); // fire + fire
    expect(eligibleFusions(w).length).toBe(0);
    setSpell(w, 'bileFlask', 4);
    expect(eligibleFusions(w).map((f) => f.def.id)).toEqual(['feverBloom']);
    const v = world('venom');
    setSpell(v, 'creepingRot', 5);
    setSpell(v, 'shadeBolt', 4);
    expect(eligibleFusions(v).map((f) => f.def.id)).toEqual(['nightshade']);
    v.build.fusions = 3;
    expect(eligibleFusions(v).length).toBe(0);
  });
});

describe('fusion uniqueness', () => {
  it('a fusion result already owned is not offered again', () => {
    const w = world('venom');
    setSpell(w, 'creepingRot', 5);
    setSpell(w, 'shadeBolt', 4);
    const el = eligibleFusions(w);
    fuse(w, el[0].def, el[0].slotA, el[0].slotB);
    setSpell(w, 'rotNeedles', 5);
    setSpell(w, 'gloomWisps', 5);
    expect(eligibleFusions(w).length).toBe(0);
  });
});
