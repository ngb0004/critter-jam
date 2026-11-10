/** The five Descent bosses (COMBAT). HP comes from BAL.bossHP[layer-1] x mods.bossHpMul. */
import type { BossDef } from '../core/types';

export const BOSSES: readonly BossDef[] = [
  { id: 'foreman', name: 'The Foreman', layer: 1, radius: 1.3, speed: 2.0, color: 0xffa940, patterns: ['slam'], intro: 'Watch the red floor.' },
  { id: 'sporemother', name: 'Sporemother', layer: 2, radius: 1.5, speed: 1.6, color: 0xb26bff, patterns: ['slam', 'spores'], intro: 'Spores linger. Keep moving.' },
  { id: 'drownedEngine', name: 'The Drowned Engine', layer: 3, radius: 1.6, speed: 1.8, color: 0x3fa9ff, patterns: ['charge'], intro: 'It charges in lanes. Step aside.' },
  { id: 'prismWarden', name: 'Prism Warden', layer: 4, radius: 1.5, speed: 1.7, color: 0xff7ad9, patterns: ['beam', 'spores'], intro: 'Beams bounce. Find the gap.' },
  { id: 'anvilKing', name: 'Anvil King', layer: 5, radius: 1.8, speed: 1.9, color: 0xff4d3d, patterns: ['slam', 'spores', 'charge', 'beam'], intro: 'Everything at once.' },
];
