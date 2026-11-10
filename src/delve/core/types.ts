/**
 * Shared contract types (CORE). Content definitions, Modifiers, input frames, choices,
 * derived player stats and small enums. Changing anything here is a contract change:
 * tell every owner (see ARCHITECTURE.md).
 */
import type { World } from './world';

// ---------------------------------------------------------------------------------------------
// Keywords and small enums
// ---------------------------------------------------------------------------------------------

export const KEYWORDS = ['fire', 'frost', 'storm', 'poison', 'shadow', 'radiant', 'steel', 'blade', 'summon', 'orbit'] as const;
export type Keyword = (typeof KEYWORDS)[number];
/** Bit for a keyword in keyword masks (sim code uses masks, content uses names). */
export const kwBit = (k: Keyword): number => 1 << KEYWORDS.indexOf(k);

export type SpecId = 'ember' | 'venom';
export type ClassId = 'pyre' | 'cutpurse';
export type Rarity = 'common' | 'rare' | 'epic';
export type BiomeId = 'lamp' | 'fungal' | 'flooded' | 'crystal' | 'forge' | 'core';

/** Enemy pool flags (bitmask in World.en.flags). */
export const EF = {
  BOSS: 1,
  ELITE: 2,
  CLUMP: 4,
  FORMATION: 8,
  WYRM: 16, // the Wyrm's head (hit target during Wyrmfall)
  NO_KNOCKBACK: 32,
  SUMMONED: 64, // spawned by a boss; gives no XP
} as const;

/** Status slots per enemy (index into the World.en.st* arrays: i * CAP.statuses + kind). */
export const ST = {
  BURN: 0,
  POISON: 1,
  CHILL: 2,
  SHOCK: 3,
  SHADOW: 4, // shadow mark: damage over time that ignores armor (Ironhide)
  SPARE: 5,
} as const;
export type StatusKind = (typeof ST)[keyof typeof ST];

/** Telegraph shapes and colours (World.tg.shape / .color). */
export const TG_SHAPE = { CIRCLE: 0, LANE: 1, CONE: 2, RING: 3 } as const;
export const TG_COLOR = { RED: 0, VIOLET: 1, GOLD: 2 } as const;
/** Telegraph flags. */
export const TGF = {
  TRUE_DAMAGE: 1, // ignores DR (Wyrmfall rocks)
  NO_DASH_IMMUNITY: 2,
  BOSS: 4,
  LINGER_HURTS: 8, // keeps hurting during linger (spore puddles), per-second damage = dmgPct
  MAW: 16, // the Wyrm maw ring (not damaging; marks the stagger zone)
} as const;

/** Why a run ended (spec 3.3). */
export const DEATH = { NONE: 0, CHIP: 1, BURST: 2, BOSS: 3, WYRMFALL: 4 } as const;
export type DeathCause = (typeof DEATH)[keyof typeof DEATH];

/** Damage-source ids used in events and hit stamps. 0..5 = spell slots; others below. */
export const SRC = {
  SLOT0: 0,
  FUSION: 6,
  RELIC: 7,
  STATUS: 8,
  ALLY: 9,
  WYRM: 10,
  OTHER: 11,
} as const;

// ---------------------------------------------------------------------------------------------
// Input frames and choices (the ONLY things that drive a run)
// ---------------------------------------------------------------------------------------------

/**
 * One byte per tick: bits 0-5 direction (0..63, angle = d*TAU/64, 0 = +x, 16 = +y),
 * bit 6 = moving, bit 7 = dash pressed this tick.
 */
export type InputFrame = number;
export const IN_MOVE = 0x40;
export const IN_DASH = 0x80;
export const IN_DIR_MASK = 0x3f;

/**
 * A choice made while the sim is paused on an offer. Encoded as one byte in replays:
 * 0..7 pick card i, 8 reroll, 16..23 banish card i, 32 skip (only where allowed).
 */
export type ChoiceCode = number;
export const CH_PICK = 0;
export const CH_REROLL = 8;
export const CH_BANISH = 16;
export const CH_SKIP = 32;

// ---------------------------------------------------------------------------------------------
// Derived player stats (BUILD writes via recomputeStats, COMBAT/RENDER read)
// ---------------------------------------------------------------------------------------------

export interface PlayerStats {
  maxHpMul: number; // 1 + Vitality (+ omen/twist)
  armor: number; // flat armor; DR = armor / (armor + K0 + Km*m), cap 75%
  regenPerSec: number; // fraction of max HP per second (before the heal cap)
  healCap: number; // fraction of max HP per second, ALL healing combined
  might: number; // additive damage bucket (incl. Limit Break)
  haste: number; // cast-rate multiplier (1 + haste, capped)
  areaMul: number; // radius multiplier (1 + area, capped)
  critChance: number;
  critMult: number;
  magnetMul: number; // pickup radius multiplier
  xpMul: number; // XP multiplier from Magnet (<= 1.3) and modifiers
  moveSpeedMul: number;
  extraProjectiles: number; // <= 3
  durationMul: number; // zone/status duration multiplier (Lantern Oil etc.)
  dashCharges: number;
}

export function defaultStats(): PlayerStats {
  return {
    maxHpMul: 1, armor: 0, regenPerSec: 0, healCap: 0.015, might: 0, haste: 1, areaMul: 1,
    critChance: 0, critMult: 2.2, magnetMul: 1, xpMul: 1, moveSpeedMul: 1, extraProjectiles: 0,
    durationMul: 1, dashCharges: 1,
  };
}

// ---------------------------------------------------------------------------------------------
// Modifiers: what Omens, Twists (and Heat later) change. Composed once at createWorld.
// All multipliers default to 1, adds to 0. Sim modules read World.mods; nothing writes it after start.
// ---------------------------------------------------------------------------------------------

export interface Modifiers {
  // pressure (COMBAT reads)
  spawnRateMul: number;
  unitHpMul: number;
  contactDmgMul: number;
  densityMul: number; // area-target density hint (Swarming)
  bossHpMul: number;
  burstRateMul: number;
  burstSizeMul: number;
  telegraphExtra: number; // seconds added to every telegraph (Long Fuse)
  nSafeAdd: number;
  arenaMul: number;
  // damage rules (BUILD reads in dealDamage)
  smallHitThreshold: number; // Ironhide: hits under this ...
  smallHitMul: number; // ... are multiplied by this (1 = off)
  bigHitCritMul: number; // Ironhide: crits on big hits x this
  // XP and offers (BUILD reads)
  xpPerUnitMul: number;
  xpMul: number;
  choices: number;
  rerolls: number;
  banishes: number;
  rareWeight: number;
  epicGateSec: number;
  gemDecaySec: number;
  freeMagnetRank: number;
  // caps (BUILD reads in recomputeStats; COMBAT reads healCap via stats)
  hasteCapMul: number;
  areaCapAdd: number;
  healCap: number;
  maxHpMul: number;
  mightPerRankAdd: number;
  armorK0: number;
  /** Free-form flags for rules that need code (e.g. 'swarming'), checked with mods.tags.has(). */
  tags: Set<string>;
}

export function defaultModifiers(): Modifiers {
  return {
    spawnRateMul: 1, unitHpMul: 1, contactDmgMul: 1, densityMul: 1, bossHpMul: 1, burstRateMul: 1,
    burstSizeMul: 1, telegraphExtra: 0, nSafeAdd: 0, arenaMul: 1,
    smallHitThreshold: 0, smallHitMul: 1, bigHitCritMul: 1,
    xpPerUnitMul: 1, xpMul: 1, choices: 3, rerolls: 2, banishes: 1, rareWeight: 35, epicGateSec: 120,
    gemDecaySec: 8, freeMagnetRank: 0,
    hasteCapMul: 1, areaCapAdd: 0, healCap: 0.015, maxHpMul: 1, mightPerRankAdd: 0, armorK0: 40,
    tags: new Set(),
  };
}

// ---------------------------------------------------------------------------------------------
// Content definitions (BUILD/COMBAT own the data files; the shapes are CORE contract)
// ---------------------------------------------------------------------------------------------

/** How a spell behaves. sim/spells.ts dispatches on this. */
export type SpellBehavior =
  | 'projectile' // fires at a target; hits and maybe pierces
  | 'splash' // projectile that bursts in an area on first hit (Firebolt)
  | 'chain' // instant hit that jumps between enemies (Chain Spark)
  | 'orbit' // N bodies orbiting the player
  | 'aura' // periodic pulse around the player
  | 'zone' // ground area placed at a target (densest cluster) for a duration
  | 'summon' // allies that seek enemies
  | 'dot-spread'; // applies a status that spreads on death (Creeping Rot)

export type TargetRule = 'nearest' | 'densest' | 'random' | 'self' | 'strongest' | 'behind';

export interface SpellDef {
  id: string;
  name: string;
  /** One keyword for normal spells, two for fusions. */
  keywords: readonly Keyword[];
  behavior: SpellBehavior;
  target: TargetRule;
  /** null = neutral (any spec); a class id = class-shared; a spec id = spec-only. */
  owner: null | ClassId | SpecId;
  rarity: Rarity;
  /** Seconds between casts at rank 1 before Haste. */
  cooldown: number;
  /** Damage per hit at rank 1 (before fit, rank multiplier, buckets). */
  damage: number;
  /** Projectiles/bodies/jumps per cast. */
  count: number;
  /** Area radius in metres (splash, aura, zone; orbit radius for orbit). */
  radius: number;
  /** Projectile speed m/s (projectile kinds) or orbit angular speed rad/s. */
  speed: number;
  /** Enemies a projectile passes through (0 = stops on first hit). */
  pierce: number;
  /** Lifetime in seconds (projectiles, zones, summons). */
  duration: number;
  /** Status applied on hit, if any. dps is per stack per second at rank 1. */
  status?: { kind: StatusKind; stacks: number; seconds: number; dps: number; maxStacks: number };
  /** 0..1 how area-ish (balance ledger; area per-target damage 0.25-0.40 of single). */
  areaness: number;
  /** Visual hint for the renderer (palette key). */
  fx: string;
  desc: string;
  /** True for fusion results (never offered directly). */
  fusion?: boolean;
}

export type PassiveStat = 'might' | 'haste' | 'area' | 'crit' | 'vitality' | 'armor' | 'regen' | 'magnet';
export interface PassiveDef {
  id: PassiveStat;
  name: string;
  /** Per-rank value (fraction or flat armor). */
  perRank: number;
  /** Cap on the summed value (same units). */
  cap: number;
  rarity: Rarity;
  desc: string;
  icon: string;
}

export interface FusionDef {
  id: string;
  /** Unordered keyword pair. */
  a: Keyword;
  b: Keyword;
  /** SpellDef id of the result (a SpellDef with fusion: true). */
  result: string;
  name: string;
  desc: string;
}

/** Rule hooks. All optional; each is called by the named owner module at the named moment. */
export interface RelicHooks {
  onAcquire?(w: World): void; // build.ts, once
  onCast?(w: World, slot: number): void; // spells.ts, after each cast
  onKill?(w: World, enemy: number, src: number): void; // damage.ts killEnemy (proc-budgeted)
  onZoneCreate?(w: World, zone: number): void; // zones.ts
  onDash?(w: World): void; // player.ts
  onProjectileSpawn?(w: World, proj: number, first: boolean): void; // projectiles.ts
  modifyStats?(w: World, s: PlayerStats): void; // build.ts recomputeStats
}
export interface RelicDef {
  id: string;
  name: string;
  desc: string;
  /** Ledger cost: the bot-measured "more" multiplier, x1.05-1.15. */
  ledger: number;
  rarity: Rarity;
  hooks: RelicHooks;
}

export interface TalentDef {
  id: string;
  name: string;
  desc: string;
  classId: ClassId;
  /** 0-based row; the slice ships rows 0 and 1. */
  row: number;
  /** area | single | survival column. */
  column: 'area' | 'single' | 'survival';
  hooks: RelicHooks;
}

/** Omens (weekly) and Twists (daily) are pure Modifier transforms. */
export interface ModifierDef {
  id: string;
  name: string;
  desc: string;
  favours?: readonly SpecId[];
  apply(m: Modifiers): void;
}
export type OmenDef = ModifierDef;
export type TwistDef = ModifierDef;

export interface SpecDef {
  id: SpecId;
  classId: ClassId;
  name: string;
  className: string;
  signature: string; // SpellDef id
  desc: string;
  hpMul: number;
  /** Balance profile: area share (spec 5.1 table). */
  area: number;
  color: number;
}

export interface EnemyDef {
  id: string;
  name: string;
  /** Multipliers on the time-based unit values (hpU, contact dmg). */
  hpMul: number;
  dmgMul: number;
  speed: number; // m/s
  radius: number;
  xpMul: number;
  mesh: 'bat' | 'slime' | 'beetle' | 'shroom' | 'golem' | 'clump' | 'elite';
  color: number;
}

export interface BossDef {
  id: string;
  name: string;
  layer: number; // 1..5
  radius: number;
  speed: number;
  color: number;
  /** Attack patterns this boss uses (bosses.ts implements them). */
  patterns: readonly ('slam' | 'spores' | 'charge' | 'beam')[];
  intro: string;
}

export interface LayerDef {
  index: number; // 1..5, 6 = Core
  name: string;
  biome: BiomeId;
  /** Enemy ids that spawn in this layer, with weights. */
  enemies: readonly (readonly [string, number])[];
  boss: string | null;
  /** Palette for the renderer (floor, wall, fog, light). */
  palette: { floor: number; wall: number; fog: number; light: number; accent: number };
}
