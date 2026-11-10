/**
 * The 8 passives with caps (BUILD), spec 7.3, plus the Core-only Tempered offers (spec 6.5).
 * Caps are enforced in sim/build.ts recomputeStats (one place), using these numbers and BAL.
 */
import type { PassiveDef, PlayerStats } from '../core/types';

export const PASSIVES: readonly PassiveDef[] = [
  { id: 'might', name: 'Might', perRank: 0.08, cap: 0.4, rarity: 'common', icon: 'fist', desc: 'Your spells hit 8% harder.' },
  { id: 'haste', name: 'Haste', perRank: 0.06, cap: 0.5, rarity: 'common', icon: 'clock', desc: 'Your spells fire 6% more often.' },
  { id: 'area', name: 'Wide Reach', perRank: 0.1, cap: 0.6, rarity: 'common', icon: 'ring', desc: 'Bigger splashes, auras and puddles (+10%).' },
  { id: 'crit', name: 'Keen Eye', perRank: 0.05, cap: 0.5, rarity: 'rare', icon: 'eye', desc: '+5% chance for a hit to do double damage or more.' },
  { id: 'vitality', name: 'Vitality', perRank: 0.15, cap: 0.75, rarity: 'common', icon: 'heart', desc: '+15% max health.' },
  { id: 'armor', name: 'Armor', perRank: 6, cap: 999, rarity: 'common', icon: 'shield', desc: 'Take less damage from hits. Works best early in the run.' },
  { id: 'regen', name: 'Regen', perRank: 0.005, cap: 0.015, rarity: 'rare', icon: 'leaf', desc: 'Slowly heal over time.' },
  { id: 'magnet', name: 'Magnet', perRank: 0.2, cap: 1.0, rarity: 'common', icon: 'magnet', desc: 'Grab gems from farther away (+20%), and a little more XP.' },
];

/** Core-only trade-offs: about +0.03 ln P each with a cost. At most BAL-defined 6 per run. */
export interface TemperedDef {
  id: string;
  name: string;
  desc: string;
  apply(s: PlayerStats): void;
}

export const TEMPERED: readonly TemperedDef[] = [
  { id: 'tmpEdge', name: 'Tempered Edge', desc: '+6% damage, -4% max HP.', apply: (s) => { s.might += 0.06; s.maxHpMul *= 0.96; } },
  { id: 'tmpFuse', name: 'Short Fuse', desc: '+5% cast rate, -1.5 armor.', apply: (s) => { s.haste += 0.05; s.armor -= 1.5; } },
  { id: 'tmpReach', name: 'Long Reach', desc: '+8% spell radius, -3% move speed.', apply: (s) => { s.areaMul += 0.08; s.moveSpeedMul *= 0.97; } },
  { id: 'tmpEye', name: 'Hard Eye', desc: '+4% crit chance, -4% max HP.', apply: (s) => { s.critChance += 0.04; s.maxHpMul *= 0.96; } },
  { id: 'tmpEmber', name: 'Banked Embers', desc: '+5% damage, -10% pickup radius.', apply: (s) => { s.might += 0.05; s.magnetMul *= 0.9; } },
  { id: 'tmpGrit', name: 'Grit', desc: '+8% max HP, -3% damage.', apply: (s) => { s.maxHpMul *= 1.08; s.might -= 0.03; } },
];
