/**
 * Balance and engine constants (CORE owns the file; COMBAT/BUILD may tune numbers they own,
 * noting the change in ARCHITECTURE.md's changelog).
 *
 * Seeded from spec v1 section 7 (v1.1 values) and the balance macro-sim
 * (scratchpad/balance/v11/sim.js DEFAULTS, final.json round 6). Time in seconds unless a name
 * ends in Ticks. Distances in metres. "m" in formulas = minutes.
 */

/** Bump whenever sim constants or sim logic change (stored replays of another version are refused). 2 = FIX v1 pass, 3 = BOT v0.2 balance, 4 = FIX v0.2 (enrage, layer mix fade-in, Swarming HP). */
export const SIM_VERSION = 4;
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
  // pressure 7.1. History: v1 skeleton hp0 11 hpC 0.34 coreStep 1.5 dmg0 2.0 dmgD 0.16 dmgC 0.2 burstRate 0.05/0.15/0.15
  // burstPct 0.12/0.09; BOT v1 raised bursts (the horde never reached a moving bot); FIX v1 (hp0 13 hpD 0.45 hpC 0.48
  // coreStep 1.7 dmg0 2.2 dmgD 0.46 burstRate 0.08/0.34/0.1 burstPct 0.22/0.05) left deaths 49% overrun / 50% red,
  // a 10:48 ceiling and 5.9% of daily bests in one 10 s bucket.
  // BOT v0.2 (real-engine population, scripts/delve-pop.ts, ARCHITECTURE.md changelog "BOT v0.2"):
  //  - bursts back toward the spec (size 0.22 -> 0.16 of max HP, layer growth 0.34 -> 0.30, Core growth 0.10 -> 0.06):
  //    red floor ~30% of deaths, overrun ~65% (spec 60-75%).
  //  - gentler first layers, steeper late Descent (hp0 13 -> 14 with hpD 0.45 -> 0.58; contact dmg0 2.2 -> 1.0 with
  //    dmgD 0.46 -> 0.66; spawn n0 1.6 -> 1.3 with nD 0.2 -> 0.26): novices reach layers 3-4, the late Descent filters.
  //  - the Core: a bigger early step (x2.1 over 5:00-9:00, was x1.7 over 5:10-6:50) then slow growth (hpC 0.48 -> 0.21):
  //    the low late-Core slope spreads the strong players out (gate 2) and lets the best reach the 12:00 Wyrmfall.
  hp0: 14, hpD: 0.58, hpC: 0.21, coreStep: 2.1, coreStepT0: 300, coreStepT1: 540,
  n0: 1.3, nD: 0.26, nC: 0.08,
  dmg0: 1.0, dmgD: 0.66, dmgC: 0.3,
  kappa: 0.012, nsafeScale: 10, nsafeE: 1.5, chipE: 0.8,
  burstRate0: 0.07, burstRateD: 0.3, burstRateC: 0.06,
  burstPct0: 0.16, burstPctC: 0.06, burstCap: 0.85,
  telegraphDescent: 1.2, telegraphCore: 1.0, burstJitter: 0.5,
  // formations
  formT: 360, formGapLo: 20, formGapHi: 30, formLen: 4, formNsafe: 15, formMass: 25,
  // render cap, clumps
  renderCap: 400, queueCap: 200, clumpSize: 5, radiusCapFrac: 0.38,
  // bosses 3.1. FIX v1 doubled v1.0 HP to [500, 1500, 3200, 6000, 9200] and bosses still died 9-18 s after spawning.
  // BOT v0.2: HP [550, 1900, 2400, 7000, 10000] -> median kills ~20-30 s; the soak (spec 3.1: 50% diverted) is 10%,
  // ramped in over 8 s: a 50% cut in trash clearing at the shared :40 tick overran every weak build in the same 10 s
  // (piles of 7-9% right after the L4/L5 bosses); patterns hit softer (bossBurst 0.13 -> 0.10 scales every pattern in
  // sim/bosses.ts) and the soft enrage starts later and ramps slower (20 s / 40 s -> 25 s / 60 s, spec v1.1 60 s).
  // FIX v0.2: enrage 25 s / 60 s -> 35 s / 80 s. Weak builds that cannot kill the 7000 HP Prism Warden met its enrage at
  // 4:05, right as layer 5 began, and 6.9% of all daily bests fell in 4:10-4:20 (gate 2); with this and the 20 s layer mix
  // fade-in (sim/spawn.ts MIX_BLEND_S) the 4:00-5:00 share drops from 22% to ~17-20%.
  bossHP: [550, 1900, 2400, 7000, 10000] as readonly number[],
  bossTime: 40, bossBurst: 0.1, enrageMax: 2.5, enrageStart: 35, enrageLen: 80,
  bossXP: 0.6, carryCap: 0.5, bossSoak: 0.1, bossSoakRamp: 8, eliteDoorHP: 40, eliteDoorT: 20,
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
