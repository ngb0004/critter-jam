/**
 * Exact numbers line for level-up cards (UI, v0.2). Every number here is read from the same tables the sim uses
 * (BAL, PASSIVES, rankMult, World.mods), so a card always says what the pick really does:
 *
 *   rank-up   "Rank 2 → 3: +40% damage"  (rankMult ratio; a rank changes only the spell's damage scale, spells.ts)
 *   passive   "Now +16% damage (max +40%)" (the stat after this pick, with its cap)
 *   armor     "Critters hit 13% softer now, red floor 6% (fades over the run)" (player.ts armorDR at this minute)
 *
 * Returns '' when the card already states its numbers in its text (relics, doors, tempered, limit, mend, fusions).
 */
import { BAL, DT } from '../core/constants';
import type { World } from '../core/world';
import type { Card } from '../sim/offers';
import { rankMult } from '../sim/build';
import { PASSIVES } from '../content/passives';
import { SPELL_IDX } from '../content/spells';

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const pct1 = (x: number): string => {
  const v = Math.round(x * 1000) / 10;
  return `${v % 1 ? v.toFixed(1) : v.toFixed(0)}%`;
};
const fmtRank = (r: number): string => (r % 1 ? r.toFixed(1) : r.toFixed(0));

/** Current rank of the spell `ref` in the build, or 0 if not owned. */
function ownedRank(w: World, ref: string): number {
  const si = SPELL_IDX.get(ref);
  if (si === undefined) return 0;
  const b = w.build;
  for (let s = 0; s < b.slotSpell.length; s++) if (b.slotSpell[s] === si) return b.slotRank[s];
  return 0;
}

/** "+N% damage" for going from rank `from` to rank `to` (same formula as sim/build.ts slotScale). */
export function rankGain(from: number, to: number): number {
  return rankMult(to) / Math.max(1e-6, rankMult(Math.max(1, from))) - 1;
}

export function rankLine(from: number, to: number): string {
  return `Rank ${fmtRank(from)} → ${fmtRank(to)}: +${pct(rankGain(from, to))} damage`;
}

/** Armor damage reduction for `armor` points at `minute` (mirrors sim/player.ts armorDR). */
export function armorDRAt(armor: number, minute: number, k0: number): number {
  if (armor <= 0) return 0;
  const dr = armor / (armor + k0 + BAL.Km * minute);
  return dr > BAL.drCap ? BAL.drCap : dr;
}

export function cardNumbers(w: World, c: Card): string {
  if (c.kind === 'rank') {
    const from = ownedRank(w, c.ref) || Math.max(1, c.rank - 1);
    return rankLine(from, c.rank);
  }
  if (c.kind !== 'passive') return '';
  const p = PASSIVES.find((x) => x.id === c.ref);
  if (!p) return '';
  const n = c.rank; // rank after taking the card
  switch (p.id) {
    case 'might': {
      const per = p.perRank + w.mods.mightPerRankAdd;
      return `Spells: +${pct(Math.min(BAL.mightCap, n * per))} damage in total (max +${pct(BAL.mightCap)})`;
    }
    case 'haste':
      return `Spells: +${pct(Math.min(p.cap, n * p.perRank))} cast rate in total`;
    case 'area':
      return `Spell size: +${pct(Math.min(p.cap, n * p.perRank))} in total`;
    case 'crit':
      return `${pct(Math.min(BAL.critCap, n * p.perRank))} of hits deal ${BAL.critMult}x damage`;
    case 'vitality':
      return `Max health: +${pct(Math.min(BAL.vitCap, n * p.perRank))} in total (max +${pct(BAL.vitCap)})`;
    case 'armor': {
      const minute = (w.tick * DT) / 60;
      const dr = armorDRAt(n * p.perRank, minute, w.mods.armorK0);
      return `Now: critter hits -${pct(dr)}, red floor -${pct(dr / 2)}. Fades as time goes on`;
    }
    case 'regen':
      return `Heal ${pct1(Math.min(w.mods.healCap, n * p.perRank))} of max health per second`;
    case 'magnet': {
      const xp = Math.min(BAL.magnetCap, Math.sqrt(1 + BAL.magnetStep * n));
      return `Pickup range +${pct(Math.min(p.cap, n * p.perRank))}, XP +${pct(xp - 1)} in total`;
    }
  }
  return '';
}
