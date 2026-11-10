/** Omens (weekly) and Twists (daily) for the slice (BUILD), spec section 8. */
import type { Modifiers, OmenDef, TwistDef } from '../core/types';
import { defaultModifiers } from '../core/types';

export const OMENS: readonly OmenDef[] = [
  // no `favours` claim until it is re-gated on bot data (QA: Swarming helped Venom +15%, Ember +2%)
  { id: 'swarming', name: 'Swarming',
    desc: 'Many more of them, each one weaker and worth less.',
    apply: (m) => { m.spawnRateMul *= 1.6; m.unitHpMul *= 0.6; m.xpPerUnitMul *= 0.6; m.densityMul *= 1.6; m.tags.add('swarming'); } },
  { id: 'ironhide', name: 'Ironhide',
    desc: 'Hits under 15 damage barely scratch them. Big crits crack shells.',
    // spec v1.1 numbers (x0.85 small hits, x1.10 big crits); the old x0.3 / x1.15 was a v1.0+ overshoot
    apply: (m) => { m.smallHitThreshold = 15; m.smallHitMul = 0.85; m.bigHitCritMul = 1.1; m.tags.add('ironhide'); } },
];

export const TWISTS: readonly TwistDef[] = [
  { id: 'leanSeam', name: 'Lean Seam', desc: 'XP x0.9, but level-ups offer 4 choices.',
    apply: (m) => { m.xpMul *= 0.9; m.choices = 4; } },
  { id: 'longFuse', name: 'Long Fuse', desc: 'Telegraphs +0.2 s; bursts hit 8% harder.',
    apply: (m) => { m.telegraphExtra += 0.2; m.burstSizeMul *= 1.08; } },
];

export const omenById = (id: string): OmenDef | undefined => OMENS.find((o) => o.id === id);
export const twistById = (id: string): TwistDef | undefined => TWISTS.find((t) => t.id === id);

/** Compose the run's Modifiers. Unknown ids are ignored (no omen / no twist). */
export function buildModifiers(omenId: string, twistId: string): Modifiers {
  const m = defaultModifiers();
  omenById(omenId)?.apply(m);
  twistById(twistId)?.apply(m);
  return m;
}
