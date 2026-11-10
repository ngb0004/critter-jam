/**
 * The damage pipeline and death (BUILD), spec 7.2. Every hit on an enemy goes through dealDamage; every
 * death goes through killEnemy.
 *
 * dealDamage(amount) where amount = per-hit base x fit x R(rank) (spells.ts) applies, in order:
 *   hit gate      one hit per source per target per 0.2 s (unless NO_STAMP: DoTs, per-projectile memory)
 *   buckets       x (1 + Might + Limit Break)    [additive bucket]
 *   talents       Kindled Core x1.4 on the toughest enemy, Focused Flame x1.3 fire vs big, Opportunist x1.3
 *   shock         x (1 + 0.08 per shock stack)
 *   crit          chance stats.critChance at x stats.critMult (Ironhide: x1.10 more on big crits); procs never crit
 *   Ironhide      hits under 15: x0.85 ramping to x1 at 15 (spec v1.1) (shadow / IGNORE_ARMOR skips it); then flat enemy armor
 * Haste lives in the cooldowns, RelicMult in the relic rules, uptime is the player's.
 */
import { BAL, CAP } from '../core/constants';
import { EV } from '../core/events';
import type { World } from '../core/world';
import { EF, kwBit, ST } from '../core/types';
import { onBossKilled } from './bosses';
import { releaseEnemy } from './enemies';
import { onWyrmDamage } from './hazards';
import { applyStatus, onEnemyDeath } from './statuses';
import { dropGem } from './xp';
import { onKill, slotScale } from './build';

/** dealDamage flags. */
export const DMG = {
  CAN_CRIT: 1,
  DOT: 2, // damage over time: no flash, HIT event has c = 2
  IGNORE_ARMOR: 4, // shadow: skips Ironhide's small-hit rule and enemy armor
  NO_STAMP: 8, // do not check/stamp the per-source hit gate
  PROC: 16, // relic proc / shatter: never crits, cannot trigger Deep Cuts
} as const;

const FIRE = kwBit('fire');
const SHOCK_PER_STACK = 0.08;

/** True if src may hit enemy e this tick (0.2 s per source per target). */
export function canHit(w: World, e: number, src: number): boolean {
  return w.tick - w.en.hitStamp[e * CAP.hitSources + src] >= BAL.hitIntervalTicks;
}
export function stampHit(w: World, e: number, src: number): void {
  w.en.hitStamp[e * CAP.hitSources + src] = w.tick;
}

/**
 * Deal `amount` (already including fit x rank) to enemy e from damage source src (SRC id / slot).
 * Kills via killEnemy. Returns damage dealt.
 */
export function dealDamage(w: World, e: number, amount: number, src: number, flags: number): number {
  const en = w.en;
  if (!en.alive[e] || amount <= 0) return 0;
  if ((flags & DMG.NO_STAMP) === 0) {
    if (!canHit(w, e, src)) return 0;
    stampHit(w, e, src);
  }
  const b = w.build;
  const ru = b.rules;
  let dmg = amount * (1 + w.stats.might);
  const big = (en.flags[e] & (EF.BOSS | EF.ELITE)) !== 0;
  if (ru.kindledCore && e === w.spells.topHp) dmg *= 1.4;
  if (big) {
    if (ru.focusedFlame && src < BAL.spellSlots && (b.slotKw[src] & FIRE) !== 0) dmg *= 1.3;
    if (ru.opportunist && en.stStacks[e * CAP.statuses + ST.POISON] > 0) dmg *= 1.3;
  }
  const shock = en.stStacks[e * CAP.statuses + ST.SHOCK];
  if (shock > 0) dmg *= 1 + SHOCK_PER_STACK * shock;
  let crit = 0;
  if ((flags & (DMG.CAN_CRIT | DMG.PROC)) === DMG.CAN_CRIT && w.stats.critChance > 0 && w.rng.combat.next() < w.stats.critChance) {
    dmg *= w.stats.critMult;
    crit = 1;
    if (dmg >= w.mods.smallHitThreshold) dmg *= w.mods.bigHitCritMul;
    if (ru.deepCuts && src < BAL.spellSlots) {
      applyStatus(w, e, ST.POISON, 2, 3, 3 * slotScale(w, src), 12, src);
    }
  }
  if ((flags & DMG.IGNORE_ARMOR) === 0) {
    // Ironhide: x smallHitMul (0.85, spec v1.1) for tiny hits, ramping linearly to x1 at the threshold (no cliff).
    const thr = w.mods.smallHitThreshold;
    if (dmg < thr) dmg *= w.mods.smallHitMul + (1 - w.mods.smallHitMul) * (dmg / thr);
    dmg -= en.armor[e];
    if (dmg <= 0) return 0;
  }
  // boss soak / Wyrm ring: part of the damage to trash is diverted (bosses.ts routes it to the boss / head)
  const dv = w.boss.divert;
  if (dv > 0 && (en.flags[e] & (EF.BOSS | EF.ELITE | EF.WYRM)) === 0) dmg *= 1 - dv;
  if (dmg > en.hp[e]) dmg = en.hp[e];
  en.hp[e] -= dmg;
  w.score.totalDamage += dmg;
  if ((flags & DMG.DOT) === 0) en.flash[e] = 6;
  w.events.push(EV.HIT, w.tick, e, src, flags & DMG.DOT ? 2 : crit, en.x[e], en.y[e], dmg);
  if (en.flags[e] & EF.WYRM) onWyrmDamage(w, dmg);
  if (en.hp[e] <= 0) killEnemy(w, e, src);
  return dmg;
}

/** Kill enemy e (credit src). Order: boss hook, status spread, gem, relic hooks, event, release. */
export function killEnemy(w: World, e: number, src: number): void {
  const en = w.en;
  if (!en.alive[e]) return;
  const flags = en.flags[e];
  if (flags & EF.WYRM) return; // the Wyrm head cannot die
  if (flags & EF.BOSS) onBossKilled(w, e);
  onEnemyDeath(w, e);
  const xp = flags & EF.SUMMONED ? 0 : en.xp[e];
  if (xp > 0) dropGem(w, en.x[e], en.y[e], xp);
  onKill(w, e, src);
  w.score.kills++;
  w.events.push(EV.KILL, w.tick, e, en.def[e], flags, en.x[e], en.y[e], xp);
  releaseEnemy(w, e);
}
