/**
 * Balance and engine constants (CORE owns the file; COMBAT/BUILD may tune numbers they own,
 * noting the change in ARCHITECTURE.md's changelog).
 *
 * Seeded from spec v1 section 7 (v1.1 values) and the balance macro-sim
 * (scratchpad/balance/v11/sim.js DEFAULTS, final.json round 6). Time in seconds unless a name
 * ends in Ticks. Distances in metres. "m" in formulas = minutes.
 */

/** Bump whenever sim constants or sim logic change (stored replays of another version are refused). 2 = FIX v1 pass. */
export const SIM_VERSION = 2;
export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;
export const secToTicks = (s: number): number => Math.round(s * TICK_HZ);

/** Pool capacities (struct-of-arrays sizes). */
export const CAP = {
  enemies: 512, // 400 drawn trash + bosses/elites/summons headroom
  renderCapTrash: 400, // spec 7.1: excess spawns queue, then merge into Clumps
  spawnQueue: 200,
  projectiles: 512,
  zones: 128,
  gems: 768,
  telegraphs: 96,
  allies: 32, // summons (BUILD); uses the allies pool
  events: 8192,
  hitSources: 12, // per-enemy hit-stamp slots: 0..5 spell slots, 6..8 fusion/relic, 9..11 misc
  statuses: 6,
} as const;

/** World geometry. The arena is a disc centred at the origin. */
export const WORLD = {
  arenaRadius: 26,
  gridCell: 2,
  playerRadius: 0.45, // visual radius
  playerHurtFrac: 0.7, // hurtbox = 70% of visual (spec 4.2)
  playerSpeed: 5.2, // m/s
  dashDist: 3, // m (spec 4.1)
  dashTicks: 9, // dash travel time (0.15 s)
  dashCooldown: 6, // s
  dashBurstImmunity: 0.25, // s, bursts only, never Wyrmfall
  spawnRingMin: 13, // trash spawns just off-screen around the player
  spawnRingMax: 16,
  screenShort: 18,
  screenLong: 32,
  gemPickupRadius: 2.6, // base magnet radius (Magnet +20%/rank); sim/xp.ts PICKUP_BASE matches
  gemCollectRadius: 0.6,
} as const;

/** Run timeline. */
export const TIMELINE = {
  layerSeconds: 60,
  layers: 5,
  coreStart: 300,
  bossAt: 40, // boss spawns at second 40 of each layer
  formationsFrom: 360,
  wyrmT: 720,
} as const;

/** Spec section 7 balance constants (v1.1), names follow the macro-sim. */
export const BAL = {
  // pressure 7.1. BOT balance pass (real-sim bot population, scripts/delve-pop.ts): was hp0 11, hpC 0.34,
  // coreStep 1.5, dmg0 2.0, dmgD 0.16, dmgC 0.2, burstRate 0.05/0.15/0.15, burstPct 0.12/0.09, telegraphCore 0.8.
  // FIX pass (QA): bursts moved toward the spec (0.29 -> 0.22 of max HP, layer growth 0.45 -> 0.34; red floor
  // was ~90% of deaths and killed novices in layers 1-2) and pressure moved into the late Descent and the horde
  // (hp0 16 -> 13 with hpD 0.33 -> 0.45, dmg0 3 -> 2.2 with dmgD 0.2 -> 0.46: gentler layers 1-2 for players without
  // crowd awareness, about the same at 5:00; hpC 0.42 -> 0.48, coreStep 1.6 -> 1.7 over a wider 310-410 s ramp,
  // dmgC 0.25 -> 0.3). Bot deaths: overrun ~50% / red ~50% (was 8% / 90%). A fully
  // overrun-driven tuning (spec 60-75%) compressed every tier into one Core wall (CV 0.12, 9% in one 10 s
  // bucket), so this stops halfway; see ARCHITECTURE.md changelog "FIX v1".
  hp0: 13, hpD: 0.45, hpC: 0.48, coreStep: 1.7, coreStepT0: 310, coreStepT1: 410,
  n0: 1.6, nD: 0.2, nC: 0.08,
  dmg0: 2.2, dmgD: 0.46, dmgC: 0.3,
  kappa: 0.012, nsafeScale: 10, nsafeE: 1.5, chipE: 0.8,
  burstRate0: 0.08, burstRateD: 0.34, burstRateC: 0.1,
  burstPct0: 0.22, burstPctC: 0.05, burstCap: 0.85,
  telegraphDescent: 1.2, telegraphCore: 1.0, burstJitter: 0.5,
  // formations
  formT: 360, formGapLo: 20, formGapHi: 30, formLen: 4, formNsafe: 15, formMass: 25,
  // render cap, clumps
  renderCap: 400, queueCap: 200, clumpSize: 5, radiusCapFrac: 0.38,
  // bosses 3.1
  // FIX pass: x2 (spec v1.0 values were [250, 750, 1600, 3000, 4600]); with the soak now DIVERTING damage (spec 3.1)
  // bosses lived 7-15 s and died before showing their patterns
  bossHP: [500, 1500, 3200, 6000, 9200] as readonly number[],
  bossTime: 40, bossBurst: 0.13, enrageMax: 2.5, enrageStart: 20, enrageLen: 40,
  bossXP: 0.6, carryCap: 0.5, eliteDoorHP: 40, eliteDoorT: 20,
  // Wyrmfall 7.4
  wyrmT: 720, wyrmD0: 0.005, wyrmDbl: 30, staggerDmg: 1800, staggerCap: 45, mawRadius: 4, ringShare: 0.5,
  rockRate: 0.12, rockPct: 0.12,
  // player power 7.2/7.3
  baseDps: 30, fitLo: 0.35, fitHi: 1.35,
  rankMult: [0, 1.0, 1.5, 2.1, 2.8, 3.6] as readonly number[],
  fusionMult: 2.4, maxFusions: 3, fusionLowRank: 4, fusionHighRank: 5,
  might: 0.08, mightCap: 0.4, haste: 0.06, hasteCap: 1.5, area: 0.1, areaCap: 0.6,
  critChance: 0.05, critCap: 0.5, critMult: 2.2,
  vit: 0.15, vitCap: 0.75, armor: 6, K0: 40, Km: 10, drCap: 0.75,
  regenRank: 0.005, healCap: 0.015,
  magnetStep: 0.2, magnetCap: 1.3,
  lbStep: 0.03, lbCap: 0.6,
  maxExtraProjectiles: 3,
  hitIntervalTicks: 12, // one hit per source per target per 0.2 s
  baseMaxHp: 100,
  // XP 6.5
  xp0: 14, xpGrowth: 1.07, xpFlatL: 20, xpGrowth2: 1.03, xpCore: 0.85, // FIX: xp0 16 -> 14, xpCore 0.7 -> 0.85 (pick cadence)
  gemDecayCore: 8, // seconds; gems decay in the Core only
  // slots 6.1
  spellSlots: 6, passiveSlots: 4, maxRank: 5,
  // offers 6.4
  choices: 3, rerolls: 2, banishes: 1, rarityW: { common: 100, rare: 35, epic: 10 }, epicGate: 120,
  pityStart: -0.05, pityStep: 0.01, ownedBoost: 2.0, kwCap: 2.5, fusionGuarantee: 3,
  mendPct: 0.3, mendDur: 20, mendCutoff: 720,
} as const;

/** Daily points anchors (spec 9.1): [seconds, points], linear between anchors. */
export const POINT_ANCHORS: readonly (readonly [number, number])[] = [
  [0, 0], [60, 50], [120, 150], [180, 230], [240, 315], [300, 400], [360, 500],
  [420, 600], [480, 700], [540, 800], [600, 900], [660, 1000],
];
