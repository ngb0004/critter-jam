/**
 * Spell content (BUILD). 16 offerable spells + 3 fusion results.
 *
 * Calibration (spec 7.2): at rank 1 and fit 1 a pure single-target spell deals about 30 DPS to one target;
 * area spells deal 0.25-0.40 of that per target (phi), so they win on crowds and lose on bosses. Numbers below
 * are per hit at rank 1, fit 1; sim/spells.ts multiplies by fit x R(rank) (x fusionMult for fusions).
 *
 * Ownership of the 16 (so all three fusions are reachable for both slice specs):
 *   Ember (Pyre):    firebolt (signature), flareNova, magmaOrbs
 *   Venom (Cutpurse): creepingRot (signature), rotNeedles, shivFan
 *   Neutral:          cinderTrail (fire), bileFlask (poison), chainSpark + thunderclap (storm),
 *                     shadeBolt + gloomWisps (shadow), frostNova (frost), lanternHalo + sunSpear (radiant),
 *                     steelOrbit (steel)
 * Behaviour kinds covered: projectile, splash, chain, orbit, aura, zone, summon, dot-spread.
 *
 * Index in SPELLS is the numeric spell id used in pools/events (SPELL_IDX maps id -> index).
 */
import type { SpellDef } from '../core/types';
import { ST } from '../core/types';

export const SPELLS: readonly SpellDef[] = [
  // --- Ember (Pyre) ---------------------------------------------------------------------------
  { id: 'firebolt', name: 'Firebolt', keywords: ['fire'], behavior: 'splash', target: 'nearest', owner: 'ember', rarity: 'common',
    cooldown: 0.65, damage: 22, count: 1, radius: 2, speed: 15, pierce: 0, duration: 1.3, areaness: 0.7, fx: 'fire',
    status: { kind: ST.BURN, stacks: 1, seconds: 2, dps: 2.5, maxStacks: 5 },
    desc: 'A bolt that bursts in a 2 m splash and sets things burning.' },
  { id: 'flareNova', name: 'Flare Nova', keywords: ['fire'], behavior: 'aura', target: 'self', owner: 'pyre', rarity: 'rare',
    cooldown: 2.2, damage: 24, count: 1, radius: 4.2, speed: 0, pierce: 0, duration: 0.35, areaness: 0.9, fx: 'fire',
    status: { kind: ST.BURN, stacks: 1, seconds: 2, dps: 3, maxStacks: 5 },
    desc: 'A ring of flame bursts out of you and shoves the crowd back.' },
  { id: 'magmaOrbs', name: 'Magma Orbs', keywords: ['orbit'], behavior: 'orbit', target: 'self', owner: 'pyre', rarity: 'common',
    cooldown: 4, damage: 9, count: 2, radius: 3.0, speed: 3.4, pierce: 99, duration: 3.2, areaness: 0.45, fx: 'fire',
    status: { kind: ST.BURN, stacks: 1, seconds: 2, dps: 3, maxStacks: 5 },
    desc: 'Two molten orbs circle you, scorching what they touch.' },
  // --- Venom (Cutpurse) -----------------------------------------------------------------------
  { id: 'creepingRot', name: 'Creeping Rot', keywords: ['poison'], behavior: 'dot-spread', target: 'nearest', owner: 'venom', rarity: 'common',
    cooldown: 1.0, damage: 4, count: 2, radius: 2.5, speed: 11, pierce: 0, duration: 1.4, areaness: 0.6, fx: 'poison',
    status: { kind: ST.POISON, stacks: 2, seconds: 4, dps: 3, maxStacks: 12 },
    desc: 'Poison darts for fresh targets. When a host dies, the rot jumps to its neighbour.' },
  { id: 'rotNeedles', name: 'Rot Needles', keywords: ['poison'], behavior: 'projectile', target: 'nearest', owner: 'cutpurse', rarity: 'common',
    cooldown: 0.9, damage: 4, count: 3, radius: 0, speed: 17, pierce: 1, duration: 0.9, areaness: 0.3, fx: 'poison',
    status: { kind: ST.POISON, stacks: 1, seconds: 3, dps: 2, maxStacks: 12 },
    desc: 'A spray of needles that poison everything they pierce.' },
  { id: 'shivFan', name: 'Shiv Fan', keywords: ['blade'], behavior: 'projectile', target: 'nearest', owner: 'cutpurse', rarity: 'common',
    cooldown: 1.1, damage: 9, count: 5, radius: 0, speed: 18, pierce: 0, duration: 0.75, areaness: 0.25, fx: 'blade',
    desc: 'Five knives in a tight fan. Brutal up close.' },
  // --- neutral --------------------------------------------------------------------------------
  { id: 'cinderTrail', name: 'Cinder Trail', keywords: ['fire'], behavior: 'zone', target: 'self', owner: null, rarity: 'common',
    cooldown: 0.45, damage: 4, count: 1, radius: 1.1, speed: 0, pierce: 0, duration: 2.4, areaness: 0.8, fx: 'fire',
    status: { kind: ST.BURN, stacks: 1, seconds: 1.5, dps: 2, maxStacks: 5 },
    desc: 'You leave burning footprints. Make them chase you through it.' },
  { id: 'bileFlask', name: 'Bile Flask', keywords: ['poison'], behavior: 'zone', target: 'densest', owner: null, rarity: 'common',
    cooldown: 2.8, damage: 2, count: 1, radius: 2.2, speed: 0, pierce: 0, duration: 4, areaness: 0.85, fx: 'poison',
    status: { kind: ST.POISON, stacks: 1, seconds: 3, dps: 0.8, maxStacks: 12 },
    desc: 'Lob a flask into the thickest crowd; it leaves a bubbling puddle.' },
  { id: 'chainSpark', name: 'Chain Spark', keywords: ['storm'], behavior: 'chain', target: 'nearest', owner: null, rarity: 'common',
    cooldown: 1.3, damage: 16, count: 4, radius: 4, speed: 0, pierce: 0, duration: 0, areaness: 0.5, fx: 'storm',
    status: { kind: ST.SHOCK, stacks: 1, seconds: 2, dps: 0, maxStacks: 3 },
    desc: 'Lightning that jumps between 4 enemies. Shocked foes take more damage.' },
  { id: 'thunderclap', name: 'Thunderclap', keywords: ['storm'], behavior: 'splash', target: 'densest', owner: null, rarity: 'rare',
    cooldown: 2.4, damage: 28, count: 1, radius: 2.6, speed: 0, pierce: 0, duration: 0, areaness: 0.75, fx: 'storm',
    status: { kind: ST.SHOCK, stacks: 1, seconds: 2, dps: 0, maxStacks: 3 },
    desc: 'A bolt from the cave roof strikes the thickest crowd.' },
  { id: 'shadeBolt', name: 'Shade Bolt', keywords: ['shadow'], behavior: 'projectile', target: 'strongest', owner: null, rarity: 'common',
    cooldown: 1.2, damage: 13, count: 1, radius: 0, speed: 12, pierce: 2, duration: 1.6, areaness: 0.2, fx: 'shadow',
    status: { kind: ST.SHADOW, stacks: 1, seconds: 4, dps: 5, maxStacks: 4 },
    desc: 'A slow bolt for the toughest foe; its gloom ignores armor.' },
  { id: 'gloomWisps', name: 'Gloom Wisps', keywords: ['shadow'], behavior: 'summon', target: 'nearest', owner: null, rarity: 'rare',
    cooldown: 5, damage: 6, count: 2, radius: 0.5, speed: 7, pierce: 0, duration: 7, areaness: 0.25, fx: 'shadow',
    status: { kind: ST.SHADOW, stacks: 1, seconds: 3, dps: 3, maxStacks: 4 },
    desc: 'Two wisps hunt on their own and nibble with gloom.' },
  { id: 'frostNova', name: 'Frost Nova', keywords: ['frost'], behavior: 'aura', target: 'self', owner: null, rarity: 'common',
    cooldown: 2.6, damage: 16, count: 1, radius: 4.0, speed: 0, pierce: 0, duration: 0.35, areaness: 0.8, fx: 'frost',
    status: { kind: ST.CHILL, stacks: 2, seconds: 6, dps: 45, maxStacks: 5 },
    desc: 'A pulse of cold that slows everything near you. Five chills shatter.' },
  { id: 'lanternHalo', name: 'Lantern Halo', keywords: ['radiant'], behavior: 'aura', target: 'self', owner: null, rarity: 'common',
    cooldown: 0.5, damage: 5, count: 1, radius: 3.0, speed: 0, pierce: 0, duration: 0.5, areaness: 0.85, fx: 'radiant',
    desc: 'Your lantern flares and burns what comes close.' },
  { id: 'steelOrbit', name: 'Steel Orbit', keywords: ['steel'], behavior: 'orbit', target: 'self', owner: null, rarity: 'common',
    cooldown: 5, damage: 10, count: 3, radius: 2.6, speed: 4.2, pierce: 99, duration: 4, areaness: 0.4, fx: 'steel',
    desc: 'Three iron hammers spin around you and knock things flat.' },
  { id: 'sunSpear', name: 'Sun Spear', keywords: ['radiant'], behavior: 'projectile', target: 'nearest', owner: null, rarity: 'epic',
    cooldown: 1.5, damage: 34, count: 1, radius: 0, speed: 24, pierce: 8, duration: 1.2, areaness: 0.35, fx: 'radiant',
    desc: 'A spear of light that pierces a whole line.' },
  // --- fusion results (never offered directly; slotDamage applies fusionMult and the parents' fit sum) ---
  { id: 'plasmaArc', name: 'Plasma Arc', keywords: ['fire', 'storm'], behavior: 'chain', target: 'nearest', owner: null, rarity: 'epic', fusion: true,
    cooldown: 0.8, damage: 7, count: 7, radius: 5, speed: 0, pierce: 0, duration: 0, areaness: 0.7, fx: 'plasma',
    status: { kind: ST.BURN, stacks: 2, seconds: 3, dps: 2, maxStacks: 8 },
    desc: 'White-hot lightning leaps through 7 enemies and leaves them burning.' },
  { id: 'feverBloom', name: 'Fever Bloom', keywords: ['fire', 'poison'], behavior: 'zone', target: 'densest', owner: null, rarity: 'epic', fusion: true,
    cooldown: 1.6, damage: 2.4, count: 2, radius: 2.4, speed: 0, pierce: 0, duration: 4, areaness: 0.9, fx: 'fever',
    status: { kind: ST.POISON, stacks: 2, seconds: 4, dps: 0.45, maxStacks: 8 },
    desc: 'Burning toxic flowers erupt in the two thickest crowds. Burn and rot at once.' },
  { id: 'nightshade', name: 'Nightshade', keywords: ['poison', 'shadow'], behavior: 'dot-spread', target: 'nearest', owner: null, rarity: 'epic', fusion: true,
    cooldown: 0.8, damage: 5, count: 3, radius: 4, speed: 13, pierce: 1, duration: 1.6, areaness: 0.7, fx: 'nightshade',
    status: { kind: ST.SHADOW, stacks: 3, seconds: 5, dps: 1.4, maxStacks: 12 },
    desc: 'Black rot that ignores armor and spreads to two neighbours, twice as far.' },
];

/**
 * Behaviour parameters that do not fit SpellDef (BUILD-private). Read by sim/spells.ts via SPELL_X[idx].
 *  splashFrac  splash: damage share for enemies other than the one hit (thunderclap has no primary: 1)
 *  fan         projectile/dot-spread: total spread angle (rad) of a multi-projectile cast
 *  period      zone: ticks between pulses
 *  chains      chain: independent chains per cast
 *  spreads     the status spreads on death (Creeping Rot identity; Nightshade, Fever Bloom)
 *  status2     a second status (Fever Bloom burns too)
 *  knock       knockback impulse (m/s)
 */
export interface SpellExtra {
  splashFrac: number;
  fan: number;
  period: number;
  chains: number;
  spreads: boolean;
  status2?: SpellDef['status'];
  knock: number;
}

const X: Record<string, Partial<SpellExtra>> = {
  firebolt: { splashFrac: 0.6, knock: 2.5 },
  flareNova: { knock: 7 },
  magmaOrbs: { knock: 3 },
  creepingRot: { fan: 0, spreads: true, knock: 0 },
  rotNeedles: { fan: 0.32, knock: 1 },
  shivFan: { fan: 0.42, knock: 1.5 },
  cinderTrail: { period: 18, knock: 0 },
  bileFlask: { period: 30, knock: 0 },
  chainSpark: { chains: 1, knock: 1 },
  thunderclap: { splashFrac: 1, knock: 3 },
  shadeBolt: { knock: 1 },
  gloomWisps: { knock: 0.5 },
  frostNova: { knock: 2 },
  lanternHalo: { knock: 1.2 },
  steelOrbit: { knock: 6 },
  sunSpear: { knock: 2 },
  plasmaArc: { chains: 1, knock: 2 },
  feverBloom: { period: 30, spreads: true, status2: { kind: ST.BURN, stacks: 1, seconds: 2, dps: 0.45, maxStacks: 6 }, knock: 0 },
  nightshade: { fan: 0.3, spreads: true, knock: 0 },
};

export const SPELL_X: readonly SpellExtra[] = SPELLS.map((s) => ({
  splashFrac: 0.6, fan: 0.4, period: 30, chains: 1, spreads: false, knock: 2, ...X[s.id],
}));

export const SPELL_IDX: ReadonlyMap<string, number> = new Map(SPELLS.map((s, i) => [s.id, i]));
export const spellIndex = (id: string): number => {
  const i = SPELL_IDX.get(id);
  if (i === undefined) throw new Error(`unknown spell ${id}`);
  return i;
};
