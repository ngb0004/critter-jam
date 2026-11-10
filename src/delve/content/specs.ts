/** Specs in the slice (BUILD). */
import type { SpecDef, SpecId } from '../core/types';

export const SPECS: Record<SpecId, SpecDef> = {
  ember: {
    id: 'ember', classId: 'pyre', name: 'Ember', className: 'Pyre', signature: 'firebolt',
    desc: 'Firebolts that burst in a splash. Burn the crowd.', hpMul: 1, area: 0.85, color: 0xff7a2f,
  },
  venom: {
    id: 'venom', classId: 'cutpurse', name: 'Venom', className: 'Cutpurse', signature: 'creepingRot',
    desc: 'Rot that spreads when they die. Set it and run.', hpMul: 1, area: 0.7, color: 0x7ee05a,
  },
};
export const SPEC_IDS: readonly SpecId[] = ['ember', 'venom'];
