/**
 * Spell/passive slots, ranks, fusions, relics, talents, Tempered, derived stats (BUILD), spec 6.1-6.2, 7.2-7.3.
 *
 * Stable fields read by UI/RENDER: slotSpell[], slotRank[], slotFit[], slotCasts[], passives, passiveOrder,
 * relics, talents, tempered, fusions, limitBreak, mendTicks.
 *
 * recomputeStats is the only writer of World.stats and applies every cap of spec 7.3 in one place.
 * Fusions (spec 6.2): one parent at rank 5, the other at rank 4+, different keywords, max 3 per run. The result
 * keeps the lower slot at rank 5 with fit = fit_a + fit_b and deals x fusionMult (2.4), so F = 2.4 x 30 x 3.6 x
 * (fit_a + fit_b) in DPS terms, about x2.4 on the pair. It frees the other slot.
 */
import { BAL } from '../core/constants';
import { EV } from '../core/events';
import { hashInts } from '../core/hash';
import type { World } from '../core/world';
import type { FusionDef, PassiveStat, PlayerStats, RelicHooks } from '../core/types';
import { defaultStats, kwBit, SRC } from '../core/types';
import { FUSIONS } from '../content/fusions';
import { PASSIVES, TEMPERED } from '../content/passives';
import { RELICS } from '../content/relics';
import { SPECS } from '../content/specs';
import { SPELLS, spellIndex } from '../content/spells';
import { TALENTS } from '../content/talents';
import { refreshMaxHp } from './player';
import { createRules, type BuildRules } from './rules';
import { dropGemFountain } from './xp';

type KillHook = NonNullable<RelicHooks['onKill']>;
type CastHook = NonNullable<RelicHooks['onCast']>;
type DashHook = NonNullable<RelicHooks['onDash']>;
type ZoneHook = NonNullable<RelicHooks['onZoneCreate']>;
type ProjHook = NonNullable<RelicHooks['onProjectileSpawn']>;

export interface BuildHooks {
  kill: KillHook[];
  cast: CastHook[];
  dash: DashHook[];
  zone: ZoneHook[];
  proj: ProjHook[];
}

export interface BuildState {
  /** SpellDef index per slot, -1 = empty. */
  slotSpell: Int16Array;
  /** Rank 1..5 (half-ranks in the Core). Fusion results sit at 5. */
  slotRank: Float32Array;
  /** Ticks until the slot casts again. */
  slotCd: Int32Array;
  /** Daily fit of the spell in the slot (spec 7.2); a fusion holds fit_a + fit_b. */
  slotFit: Float32Array;
  slotCasts: Int32Array;
  /** Keyword bitmask of the spell in the slot (kwBit). */
  slotKw: Uint16Array;
  /** Daily fit per spell (index = spell idx), drawn from the day seed per spec. */
  fit: Float32Array;
  passives: Record<PassiveStat, number>;
  passiveOrder: PassiveStat[];
  relics: string[];
  talents: string[];
  /** Tempered ids taken (Core only, repeats allowed, at most TEMPER_MAX). */
  tempered: string[];
  fusions: number;
  limitBreak: number;
  /** Mend: ticks of healing left (30% over 20 s, inside the heal cap). */
  mendTicks: number;
  rules: BuildRules;
  hooks: BuildHooks;
}

export const TEMPER_MAX = 6;

export function createBuildState(w: World): BuildState {
  const fit = new Float32Array(SPELLS.length);
  const sig = SPECS[w.specId].signature;
  const salt = w.specId === 'ember' ? 1 : 2;
  for (let i = 0; i < SPELLS.length; i++) {
    const d = SPELLS[i];
    if (d.id === sig || d.fusion) {
      fit[i] = 1;
      continue;
    }
    const h = hashInts(w.cfg.daySeed, salt, i, 0xf17);
    fit[i] = BAL.fitLo + ((BAL.fitHi - BAL.fitLo) * (h % 1001)) / 1000;
  }
  return {
    slotSpell: new Int16Array(BAL.spellSlots).fill(-1),
    slotRank: new Float32Array(BAL.spellSlots),
    slotCd: new Int32Array(BAL.spellSlots),
    slotFit: new Float32Array(BAL.spellSlots),
    slotCasts: new Int32Array(BAL.spellSlots),
    slotKw: new Uint16Array(BAL.spellSlots),
    fit,
    passives: { might: 0, haste: 0, area: 0, crit: 0, vitality: 0, armor: 0, regen: 0, magnet: 0 },
    passiveOrder: [],
    relics: [],
    talents: [],
    tempered: [],
    fusions: 0,
    limitBreak: 0,
    mendTicks: 0,
    rules: createRules(),
    hooks: { kill: [], cast: [], dash: [], zone: [], proj: [] },
  };
}

/** Give the spec's signature spell and free passives (Twist), then compute stats. */
export function initBuild(w: World): void {
  addSpell(w, spellIndex(SPECS[w.specId].signature));
  for (let k = 0; k < w.mods.freeMagnetRank; k++) addPassive(w, 'magnet');
  recomputeStats(w);
}

const kwMask = (si: number): number => {
  let m = 0;
  for (const k of SPELLS[si].keywords) m |= kwBit(k);
  return m;
};

/** Put a spell in the first free slot at rank 1. Returns the slot, or -1 if full. */
export function addSpell(w: World, spellIdx: number): number {
  const b = w.build;
  for (let s = 0; s < b.slotSpell.length; s++) {
    if (b.slotSpell[s] === -1) {
      b.slotSpell[s] = spellIdx;
      b.slotRank[s] = 1;
      b.slotCd[s] = 20; // a third of a second before the first cast
      b.slotFit[s] = b.fit[spellIdx];
      b.slotCasts[s] = 0;
      b.slotKw[s] = kwMask(spellIdx);
      return s;
    }
  }
  return -1;
}

export function slotOf(w: World, spellIdx: number): number {
  const b = w.build;
  for (let s = 0; s < b.slotSpell.length; s++) if (b.slotSpell[s] === spellIdx) return s;
  return -1;
}

export function freeSpellSlots(w: World): number {
  let n = 0;
  for (let s = 0; s < w.build.slotSpell.length; s++) if (w.build.slotSpell[s] < 0) n++;
  return n;
}

export function rankUp(w: World, slot: number, by = 1): void {
  const b = w.build;
  if (slot < 0 || b.slotSpell[slot] < 0) return;
  b.slotRank[slot] = Math.min(BAL.maxRank, b.slotRank[slot] + by);
}

/** Rank multiplier R for a (possibly half) rank: R = [1.0, 1.5, 2.1, 2.8, 3.6], linear between. */
export function rankMult(rank: number): number {
  if (rank <= 1) return BAL.rankMult[1];
  const lo = Math.floor(rank);
  if (lo >= BAL.maxRank) return BAL.rankMult[BAL.maxRank];
  const t = rank - lo;
  const a = BAL.rankMult[lo];
  return a + (BAL.rankMult[lo + 1] - a) * t;
}

/** fit x R(rank) x (fusionMult for fusion results): the slot's damage scale. */
export function slotScale(w: World, slot: number): number {
  const b = w.build;
  const si = b.slotSpell[slot];
  if (si < 0) return 0;
  const f = SPELLS[si].fusion ? BAL.fusionMult : 1;
  return b.slotFit[slot] * rankMult(b.slotRank[slot]) * f;
}

export function addPassive(w: World, stat: PassiveStat): void {
  const b = w.build;
  if (b.passives[stat] === 0) {
    if (b.passiveOrder.length >= BAL.passiveSlots) return;
    b.passiveOrder.push(stat);
  }
  b.passives[stat] = Math.min(BAL.maxRank, b.passives[stat] + 1);
  recomputeStats(w);
}

export function addRelic(w: World, id: string): void {
  const r = RELICS.find((x) => x.id === id);
  if (!r || w.build.relics.includes(id)) return;
  w.build.relics.push(id);
  r.hooks.onAcquire?.(w);
  rebuildHooks(w);
  recomputeStats(w);
}

export function addTalent(w: World, id: string): void {
  const t = TALENTS.find((x) => x.id === id);
  if (!t || w.build.talents.includes(id)) return;
  w.build.talents.push(id);
  t.hooks.onAcquire?.(w);
  rebuildHooks(w);
  recomputeStats(w);
}

export function addTempered(w: World, id: string): void {
  if (w.build.tempered.length >= TEMPER_MAX || !TEMPERED.some((t) => t.id === id)) return;
  w.build.tempered.push(id);
  recomputeStats(w);
}

/** Forge door: +1 rank to the two highest-ranked owned spells that are not maxed. */
export function forge(w: World): void {
  const b = w.build;
  for (let k = 0; k < 2; k++) {
    let best = -1;
    for (let s = 0; s < b.slotSpell.length; s++) {
      if (b.slotSpell[s] < 0 || b.slotRank[s] >= BAL.maxRank) continue;
      if (best < 0 || b.slotRank[s] > b.slotRank[best]) best = s;
    }
    if (best < 0) break;
    rankUp(w, best, 1);
  }
}

/** Start Mend: 30% max HP over 20 s, through the heal cap (spec 7.4). */
export function startMend(w: World): void {
  w.build.mendTicks = Math.round(BAL.mendDur * 60);
}

function rebuildHooks(w: World): void {
  const h: BuildHooks = { kill: [], cast: [], dash: [], zone: [], proj: [] };
  const add = (x: RelicHooks): void => {
    if (x.onKill) h.kill.push(x.onKill);
    if (x.onCast) h.cast.push(x.onCast);
    if (x.onDash) h.dash.push(x.onDash);
    if (x.onZoneCreate) h.zone.push(x.onZoneCreate);
    if (x.onProjectileSpawn) h.proj.push(x.onProjectileSpawn);
  };
  for (const id of w.build.relics) add(RELICS.find((r) => r.id === id)!.hooks);
  for (const id of w.build.talents) add(TALENTS.find((t) => t.id === id)!.hooks);
  w.build.hooks = h;
}

/** Recompute World.stats from passives, Limit Break, Tempered, relics, talents and Modifiers; then apply every cap. */
export function recomputeStats(w: World): void {
  const b = w.build;
  const m = w.mods;
  const s: PlayerStats = defaultStats();
  const P = b.passives;
  const per = (id: PassiveStat): number => PASSIVES.find((p) => p.id === id)!.perRank;
  // passives, each capped (spec 7.3)
  const mightP = Math.min(BAL.mightCap, P.might * (per('might') + m.mightPerRankAdd));
  const lb = Math.min(BAL.lbCap, b.limitBreak * BAL.lbStep);
  s.might = mightP + lb;
  s.haste = 1 + P.haste * per('haste');
  s.areaMul = 1 + P.area * per('area');
  s.critChance = P.crit * per('crit');
  s.critMult = BAL.critMult;
  s.maxHpMul = (1 + Math.min(BAL.vitCap, P.vitality * per('vitality'))) * SPECS[w.specId].hpMul;
  s.armor = P.armor * per('armor');
  s.regenPerSec = P.regen * per('regen');
  s.healCap = m.healCap;
  s.magnetMul = 1 + P.magnet * per('magnet');
  s.xpMul = Math.min(BAL.magnetCap, Math.sqrt(1 + BAL.magnetStep * P.magnet));
  // Tempered, relics, talents
  for (const id of b.tempered) TEMPERED.find((t) => t.id === id)!.apply(s);
  for (const id of b.relics) RELICS.find((r) => r.id === id)?.hooks.modifyStats?.(w, s);
  for (const id of b.talents) TALENTS.find((t) => t.id === id)?.hooks.modifyStats?.(w, s);
  // global caps (spec 7.3): whatever the source, these hold
  const mightCeil = BAL.mightCap + BAL.lbCap + 0.3; // passive + Limit Break + Tempered headroom
  if (s.might > mightCeil) s.might = mightCeil;
  const hasteCap = BAL.hasteCap * m.hasteCapMul;
  if (s.haste > hasteCap) s.haste = hasteCap;
  if (s.haste < 0.5) s.haste = 0.5;
  const areaCap = 1 + BAL.areaCap + m.areaCapAdd;
  if (s.areaMul > areaCap) s.areaMul = areaCap;
  if (s.critChance > BAL.critCap) s.critChance = BAL.critCap;
  if (s.critChance < 0) s.critChance = 0;
  if (s.armor < 0) s.armor = 0;
  const hpCap = (1 + BAL.vitCap) * SPECS[w.specId].hpMul * 1.35; // Vitality cap + talent/tempered headroom
  if (s.maxHpMul > hpCap) s.maxHpMul = hpCap;
  if (s.regenPerSec > BAL.healCap) s.regenPerSec = BAL.healCap;
  if (s.xpMul > BAL.magnetCap) s.xpMul = BAL.magnetCap;
  if (s.extraProjectiles > BAL.maxExtraProjectiles) s.extraProjectiles = BAL.maxExtraProjectiles;
  if (s.dashCharges > 3) s.dashCharges = 3;
  w.stats = s;
  refreshMaxHp(w);
}

/** Fusions currently possible: different keywords, one parent at rank 5 and the other at rank >= 4. */
export function eligibleFusions(w: World): { def: FusionDef; slotA: number; slotB: number }[] {
  const b = w.build;
  const out: { def: FusionDef; slotA: number; slotB: number }[] = [];
  if (b.fusions >= BAL.maxFusions) return out;
  for (const f of FUSIONS) {
    if (slotOf(w, spellIndex(f.result)) >= 0) continue; // one of each fusion per run
    let found = false;
    for (let i = 0; i < b.slotSpell.length && !found; i++) {
      const si = b.slotSpell[i];
      if (si < 0 || SPELLS[si].fusion || (b.slotKw[i] & kwBit(f.a)) === 0) continue;
      for (let j = 0; j < b.slotSpell.length; j++) {
        const sj = b.slotSpell[j];
        if (j === i || sj < 0 || SPELLS[sj].fusion || (b.slotKw[j] & kwBit(f.b)) === 0) continue;
        if (b.slotKw[i] === b.slotKw[j]) continue; // different keywords
        const hi = Math.max(b.slotRank[i], b.slotRank[j]);
        const lo = Math.min(b.slotRank[i], b.slotRank[j]);
        if (hi >= BAL.fusionHighRank && lo >= BAL.fusionLowRank) {
          out.push({ def: f, slotA: i, slotB: j });
          found = true;
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Consume two slots into the fusion result (lower slot index keeps it) and free the other. Triggers the
 * big moment: FUSION event (renderer: darkened reel reveal), a shockwave next tick, and a gem fountain.
 */
export function fuse(w: World, def: FusionDef, slotA: number, slotB: number): number {
  const b = w.build;
  const keep = Math.min(slotA, slotB);
  const drop = Math.max(slotA, slotB);
  const res = spellIndex(def.result);
  const fitSum = b.slotFit[slotA] + b.slotFit[slotB];
  b.slotSpell[drop] = -1;
  b.slotRank[drop] = 0;
  b.slotFit[drop] = 0;
  b.slotKw[drop] = 0;
  b.slotCd[drop] = 0;
  b.slotSpell[keep] = res;
  b.slotRank[keep] = BAL.maxRank;
  b.slotFit[keep] = fitSum;
  b.slotKw[keep] = kwMask(res);
  b.slotCd[keep] = 30;
  b.slotCasts[keep] = 0;
  b.fusions++;
  w.score.fusions = b.fusions;
  // orbit/summon bodies of the consumed spells go away with them
  const pr = w.pr;
  for (let i = 0; i < pr.hi; i++) if (pr.alive[i] && (pr.slot[i] === slotA || pr.slot[i] === slotB)) pr.release(i);
  const al = w.al;
  for (let i = 0; i < al.hi; i++) if (al.alive[i] && (al.slot[i] === slotA || al.slot[i] === slotB)) al.release(i);
  w.spells.fusionNova = keep;
  w.events.push(EV.FUSION, w.tick, res, keep, b.fusions, w.player.x, w.player.y);
  dropGemFountain(w, w.player.x, w.player.y, 0.2 * w.xp.xpNext, 14);
  return keep;
}

// --- relic / talent hook dispatch (called by other modules) -------------------------------------

/** On-kill hooks. Kills credited to SRC.RELIC (proc damage) do not fire them: procs cannot proc. */
export function onKill(w: World, e: number, src: number): void {
  const hk = w.build.hooks.kill;
  if (hk.length === 0 || src === SRC.RELIC) return;
  for (let i = 0; i < hk.length; i++) hk[i](w, e, src);
}
export function onCast(w: World, slot: number): void {
  const hk = w.build.hooks.cast;
  for (let i = 0; i < hk.length; i++) hk[i](w, slot);
}
export function onDash(w: World): void {
  const hk = w.build.hooks.dash;
  for (let i = 0; i < hk.length; i++) hk[i](w);
}
export function onZoneCreate(w: World, zone: number): void {
  const hk = w.build.hooks.zone;
  for (let i = 0; i < hk.length; i++) hk[i](w, zone);
}
export function onProjectileSpawn(w: World, proj: number, first: boolean): void {
  const hk = w.build.hooks.proj;
  for (let i = 0; i < hk.length; i++) hk[i](w, proj, first);
}
