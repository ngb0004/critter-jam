/** Keyword fusions in the slice (BUILD), spec 6.2. */
import type { FusionDef, Keyword } from '../core/types';

export const FUSIONS: readonly FusionDef[] = [
  { id: 'plasmaArc', a: 'fire', b: 'storm', result: 'plasmaArc', name: 'Plasma Arc', desc: 'Fire + Storm' },
  { id: 'feverBloom', a: 'fire', b: 'poison', result: 'feverBloom', name: 'Fever Bloom', desc: 'Fire + Poison' },
  { id: 'nightshade', a: 'poison', b: 'shadow', result: 'nightshade', name: 'Nightshade', desc: 'Poison + Shadow' },
];

export function findFusion(a: Keyword, b: Keyword): FusionDef | undefined {
  for (const f of FUSIONS) if ((f.a === a && f.b === b) || (f.a === b && f.b === a)) return f;
  return undefined;
}
