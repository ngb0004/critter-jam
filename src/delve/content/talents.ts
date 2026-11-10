/**
 * Talent rows 0-1 for the two slice classes (BUILD), spec 5.2. One pick per boss kill, row by row
 * (5 bosses, 2 rows in the slice: later kills skip the talent card). Columns: area / single / survival.
 * Each costs at most ln 1.12 in the ledger. Effect bodies are rule flags read by sim/damage, statuses, spells.
 */
import type { TalentDef } from '../core/types';
import { rules } from '../sim/rules';

export const TALENTS: readonly TalentDef[] = [
  // Pyre (Ember)
  { id: 'wildfire', classId: 'pyre', row: 0, column: 'area', name: 'Wildfire', desc: 'Burning enemies spread their fire to 2 neighbours when they die.',
    hooks: { onAcquire: (w) => { rules(w).wildfire = true; } } },
  { id: 'kindledCore', classId: 'pyre', row: 0, column: 'single', name: 'Kindled Core', desc: '+40% damage to the toughest enemy on the field.',
    hooks: { onAcquire: (w) => { rules(w).kindledCore = true; } } },
  { id: 'ashShroud', classId: 'pyre', row: 0, column: 'survival', name: 'Ash Shroud', desc: '+10 armor.',
    hooks: { modifyStats: (_w, s) => { s.armor += 10; } } },
  { id: 'searingWake', classId: 'pyre', row: 1, column: 'area', name: 'Searing Wake', desc: 'Splash, aura and zone radius +20%.',
    hooks: { onAcquire: (w) => { rules(w).searingWake = true; } } },
  { id: 'focusedFlame', classId: 'pyre', row: 1, column: 'single', name: 'Focused Flame', desc: 'Fire spells deal +30% damage to bosses and elites.',
    hooks: { onAcquire: (w) => { rules(w).focusedFlame = true; } } },
  { id: 'warmHearth', classId: 'pyre', row: 1, column: 'survival', name: 'Warm Hearth', desc: '+20% max HP.',
    hooks: { modifyStats: (_w, s) => { s.maxHpMul *= 1.2; } } },
  // Cutpurse (Venom)
  { id: 'plague', classId: 'cutpurse', row: 0, column: 'area', name: 'Plague', desc: 'Poison spreads to 2 neighbours instead of 1.',
    hooks: { onAcquire: (w) => { rules(w).plague = true; } } },
  { id: 'opportunist', classId: 'cutpurse', row: 0, column: 'single', name: 'Opportunist', desc: '+30% damage to poisoned bosses and elites.',
    hooks: { onAcquire: (w) => { rules(w).opportunist = true; } } },
  { id: 'slipAway', classId: 'cutpurse', row: 0, column: 'survival', name: 'Slip Away', desc: '+1 dash charge.',
    hooks: { modifyStats: (_w, s) => { s.dashCharges += 1; } } },
  { id: 'virulence', classId: 'cutpurse', row: 1, column: 'area', name: 'Virulence', desc: 'Poison holds 4 more stacks and lasts 25% longer.',
    hooks: { onAcquire: (w) => { rules(w).virulence = true; } } },
  { id: 'deepCuts', classId: 'cutpurse', row: 1, column: 'single', name: 'Deep Cuts', desc: '+10% crit chance; crits add 2 poison stacks.',
    hooks: { onAcquire: (w) => { rules(w).deepCuts = true; }, modifyStats: (_w, s) => { s.critChance += 0.1; } } },
  { id: 'lightFeet', classId: 'cutpurse', row: 1, column: 'survival', name: 'Light Feet', desc: '+10% move speed, +8% max HP.',
    hooks: { modifyStats: (_w, s) => { s.moveSpeedMul *= 1.1; s.maxHpMul *= 1.08; } } },
];

export const talentById = (id: string): TalentDef | undefined => TALENTS.find((t) => t.id === id);
