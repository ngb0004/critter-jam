/**
 * Fusion discoverability (UI, read-only on the World). QA: fusions need two spells with different keywords at
 * R5 + R4 and nothing during a run said which spells pair up. These helpers drive:
 *   - a chip on NEW / RANK UP cards in plain words: "Rank this to 5 and Firebolt to 4 to fuse them into Plasma Arc"
 *     (v0.2 review), highlighted once the fusion is one pick away
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

export interface CardFusionHint {
  text: string;
  /** Picks still needed after this card (0 = this pick unlocks the fusion). */
  picks: number;
}

/** Picks needed to raise `from` to `to` when each pick adds `step` ranks. */
const picksTo = (from: number, to: number, step: number): number => (from >= to ? 0 : Math.ceil((to - from) / Math.max(0.5, step) - 1e-6));

/**
 * Plain-words fusion hint for a NEW / RANK UP spell card (v0.2 review: "(R5 + R4)" was jargon and casual pickers never
 * fused): "Rank this to 5 and Firebolt to 4 to fuse them into Fever Bloom (3 more picks)", "1 pick from Fever Bloom!",
 * "Unlocks Fever Bloom!". Picks the partner and the 5/4 split that need the fewest picks. null = no fusion partner owned.
 */
export function cardFusionHint(w: World, c: Card): CardFusionHint | null {
  if (c.kind !== 'spell' && c.kind !== 'rank') return null;
  const ci = SPELL_IDX.get(c.ref);
  if (ci === undefined) return null;
  const sp = SPELLS[ci];
  if (sp.fusion) return null;
  const b = w.build;
  let cur = 0;
  for (let s = 0; s < b.slotSpell.length; s++) if (b.slotSpell[s] === ci) cur = b.slotRank[s];
  const after = c.rank > 0 ? c.rank : cur + 1;
  const step = Math.max(0.5, after - cur);
  let best: { partner: string; fusion: string; meHi: boolean; picks: number } | null = null;
  for (const f of FUSIONS) {
    if (!fusionOpen(w, f.result)) continue;
    const mine: Keyword | null = sp.keywords.includes(f.a) ? f.b : sp.keywords.includes(f.b) ? f.a : null;
    if (!mine) continue;
    for (let s = 0; s < b.slotSpell.length; s++) {
      const si = b.slotSpell[s];
      if (si < 0 || si === ci || SPELLS[si].fusion || !SPELLS[si].keywords.includes(mine)) continue;
      if (SPELLS[si].keywords.length === sp.keywords.length && SPELLS[si].keywords.every((k) => sp.keywords.includes(k))) continue;
      const pr = b.slotRank[s];
      const hiMe = picksTo(after, BAL.fusionHighRank, step) + picksTo(pr, BAL.fusionLowRank, step);
      const loMe = picksTo(after, BAL.fusionLowRank, step) + picksTo(pr, BAL.fusionHighRank, step);
      const meHi = hiMe <= loMe;
      const picks = Math.min(hiMe, loMe);
      if (!best || picks < best.picks) best = { partner: SPELLS[si].name, fusion: f.name, meHi, picks };
    }
  }
  if (!best) return null;
  const hi = BAL.fusionHighRank;
  const lo = BAL.fusionLowRank;
  let text: string;
  if (best.picks === 0) text = `Unlocks ${best.fusion}! (fuses with ${best.partner})`;
  else if (best.picks === 1) text = `1 pick from ${best.fusion}! (with ${best.partner})`;
  else text = `Rank this to ${best.meHi ? hi : lo} and ${best.partner} to ${best.meHi ? lo : hi} to fuse them into ${best.fusion} (${best.picks} more picks)`;
  return { text, picks: best.picks };
}
