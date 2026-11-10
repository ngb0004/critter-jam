/**
 * Fusion discoverability (UI, read-only on the World). QA: fusions need two spells with different keywords at
 * R5 + R4 and nothing during a run said which spells pair up. These helpers drive:
 *   - a chip on NEW / RANK UP cards: "Fuses with Firebolt -> Plasma Arc (R5 + R4)"
 *   - a small two-icon fusion meter under the HUD slots once a partner is owned.
 * Same rule as sim/build.eligibleFusions (one of each fusion per run, max fusions, parents not fused).
 */
import { BAL } from '../core/constants';
import type { Keyword } from '../core/types';
import type { World } from '../core/world';
import { FUSIONS } from '../content/fusions';
import { SPELLS, SPELL_IDX } from '../content/spells';
import type { Card } from '../sim/offers';

export interface FusionPair {
  name: string;
  a: Keyword;
  b: Keyword;
  slotA: number;
  slotB: number;
  /** 0..1 toward R5 + R4. */
  progress: number;
}

function ownsSpell(w: World, idx: number): boolean {
  for (let s = 0; s < w.build.slotSpell.length; s++) if (w.build.slotSpell[s] === idx) return true;
  return false;
}

function fusionOpen(w: World, result: string): boolean {
  if (w.build.fusions >= BAL.maxFusions) return false;
  const ri = SPELL_IDX.get(result);
  return ri === undefined || !ownsSpell(w, ri);
}

const pairProgress = (ra: number, rb: number): number => {
  const hi = Math.max(ra, rb);
  const lo = Math.min(ra, rb);
  return Math.min(1, (Math.min(hi, BAL.fusionHighRank) + Math.min(lo, BAL.fusionLowRank)) / (BAL.fusionHighRank + BAL.fusionLowRank));
};

/** Owned pairs that can still fuse (best pair per fusion). */
export function fusionPairs(w: World): FusionPair[] {
  const b = w.build;
  const out: FusionPair[] = [];
  for (const f of FUSIONS) {
    if (!fusionOpen(w, f.result)) continue;
    let best: FusionPair | null = null;
    for (let i = 0; i < b.slotSpell.length; i++) {
      const si = b.slotSpell[i];
      if (si < 0 || SPELLS[si].fusion || !SPELLS[si].keywords.includes(f.a)) continue;
      for (let j = 0; j < b.slotSpell.length; j++) {
        const sj = b.slotSpell[j];
        if (j === i || sj < 0 || SPELLS[sj].fusion || !SPELLS[sj].keywords.includes(f.b)) continue;
        if (b.slotKw[i] === b.slotKw[j]) continue;
        const p = pairProgress(b.slotRank[i], b.slotRank[j]);
        if (!best || p > best.progress) best = { name: f.name, a: f.a, b: f.b, slotA: i, slotB: j, progress: p };
      }
    }
    if (best) out.push(best);
  }
  return out;
}

/** "Fuses with Firebolt -> Plasma Arc (R5 + R4)" for a NEW / RANK UP spell card, or ''. */
export function cardFusionHint(w: World, c: Card): string {
  if (c.kind !== 'spell' && c.kind !== 'rank') return '';
  const ci = SPELL_IDX.get(c.ref);
  if (ci === undefined) return '';
  const sp = SPELLS[ci];
  if (sp.fusion) return '';
  const b = w.build;
  for (const f of FUSIONS) {
    if (!fusionOpen(w, f.result)) continue;
    const mine: Keyword | null = sp.keywords.includes(f.a) ? f.b : sp.keywords.includes(f.b) ? f.a : null;
    if (!mine) continue;
    for (let s = 0; s < b.slotSpell.length; s++) {
      const si = b.slotSpell[s];
      if (si < 0 || si === ci || SPELLS[si].fusion || !SPELLS[si].keywords.includes(mine)) continue;
      if (SPELLS[si].keywords.length === sp.keywords.length && SPELLS[si].keywords.every((k) => sp.keywords.includes(k))) continue;
      return `Fuses with ${SPELLS[si].name} → ${f.name} (R${BAL.fusionHighRank} + R${BAL.fusionLowRank})`;
    }
  }
  return '';
}
