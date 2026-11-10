/**
 * The World: all simulation state, struct-of-arrays pools, and the fixed-order step (CORE).
 *
 * Rules (see ARCHITECTURE.md):
 *  - step() is the only way time advances; it is driven only by the input byte and offer choices.
 *  - No Math.random / Date / performance.now / transcendental Math in sim code (lint.test.ts).
 *  - Pools are allocated once; hot loops do not allocate.
 *  - Presentation reads World and drains World.events; it never writes the World.
 */
import { CAP, DT, TICK_HZ, TIMELINE, WORLD } from './constants';
import { EV, EventQueue } from './events';
import { Grid } from './grid';
import { SlotPool } from './pool';
import { deriveRng, Rng } from './rng';
import type { ChoiceCode, InputFrame, Modifiers, PlayerStats, SpecId } from './types';
import { DEATH, defaultStats } from './types';

import { createPlayerState, initPlayer, updatePlayer, type PlayerState } from '../sim/player';
import { createSpawnState, updateSpawning, type SpawnState } from '../sim/spawn';
import { updateEnemies } from '../sim/enemies';
import { createBossState, updateBosses, type BossState } from '../sim/bosses';
import { createHazardState, updateHazards, type HazardState } from '../sim/hazards';
import { createSpellState, updateSpells, type SpellState } from '../sim/spells';
import { updateProjectiles } from '../sim/projectiles';
import { updateZones } from '../sim/zones';
import { updateStatuses } from '../sim/statuses';
import { createXpState, updateGems, type XpState } from '../sim/xp';
import { createBuildState, initBuild, type BuildState } from '../sim/build';
import { applyChoice, createOfferState, type OfferState } from '../sim/offers';
import { SPECS } from '../content/specs';

// ---------------------------------------------------------------------------------------------
// Pools. Every pool extends SlotPool (alive[], uid[], hi, count, alloc(), release()).
// Owners may use the aux fields for their own per-slot data; document what you use.
// ---------------------------------------------------------------------------------------------

/** Enemies, bosses, elites, clumps and the Wyrm head. Spawned/moved by COMBAT, damaged by BUILD. */
export class EnemyPool extends SlotPool {
  readonly def = new Int16Array(this.cap); // EnemyDef index, or BossDef index when flags & BOSS
  readonly flags = new Uint8Array(this.cap); // EF.*
  readonly x = new Float32Array(this.cap);
  readonly y = new Float32Array(this.cap);
  readonly vx = new Float32Array(this.cap); // velocity this tick (m/s), set by enemies.ts
  readonly vy = new Float32Array(this.cap);
  readonly kx = new Float32Array(this.cap); // knockback velocity (m/s), decays
  readonly ky = new Float32Array(this.cap);
  readonly r = new Float32Array(this.cap); // body radius (m)
  readonly hp = new Float32Array(this.cap);
  readonly maxHp = new Float32Array(this.cap);
  readonly speed = new Float32Array(this.cap); // m/s
  readonly slow = new Float32Array(this.cap); // speed multiplier from statuses (1 = none), written by statuses.ts
  readonly dmg = new Float32Array(this.cap); // contact damage per touch
  readonly xp = new Float32Array(this.cap); // XP dropped on death
  readonly armor = new Float32Array(this.cap); // flat damage reduction hook (Ironhide etc.)
  readonly spawnTick = new Int32Array(this.cap);
  readonly flash = new Uint8Array(this.cap); // hit-flash ticks remaining (renderer reads)
  readonly touchCd = new Uint8Array(this.cap); // contact-damage cooldown ticks
  readonly aux0 = new Float32Array(this.cap); // COMBAT: AI state per kind
  readonly aux1 = new Float32Array(this.cap);
  readonly auxI = new Int32Array(this.cap); // COMBAT: formation id / boss pattern state
  /** Last tick each damage source hit this enemy: [i * CAP.hitSources + src]. BUILD (damage.ts). */
  readonly hitStamp = new Int32Array(this.cap * CAP.hitSources);
  /** Statuses: [i * CAP.statuses + ST.kind]. BUILD (statuses.ts). */
  readonly stStacks = new Float32Array(this.cap * CAP.statuses);
  readonly stTicks = new Int32Array(this.cap * CAP.statuses);
  readonly stDps = new Float32Array(this.cap * CAP.statuses); // damage per stack per second
  readonly stSrc = new Int8Array(this.cap * CAP.statuses); // SRC that applied it (for kill credit)

  constructor() {
    super(CAP.enemies);
  }
}

/** Player projectiles (BUILD). */
export class ProjectilePool extends SlotPool {
  readonly spell = new Int16Array(this.cap); // SpellDef index (renderer picks fx from it)
  readonly slot = new Int8Array(this.cap); // build slot / SRC id for hit stamps
  readonly x = new Float32Array(this.cap);
  readonly y = new Float32Array(this.cap);
  readonly vx = new Float32Array(this.cap); // m/s
  readonly vy = new Float32Array(this.cap);
  readonly r = new Float32Array(this.cap); // collision radius
  readonly dmg = new Float32Array(this.cap);
  readonly splash = new Float32Array(this.cap); // splash radius on hit (0 = none)
  readonly life = new Int32Array(this.cap); // ticks left
  readonly pierce = new Int16Array(this.cap);
  readonly target = new Int32Array(this.cap); // enemy slot or -1
  readonly targetUid = new Int32Array(this.cap); // uid of that enemy when targeted
  readonly kind = new Uint8Array(this.cap); // BUILD-defined motion kind (0 straight, 1 homing, 2 orbit...)
  readonly aux0 = new Float32Array(this.cap);
  readonly aux1 = new Float32Array(this.cap);
  constructor() {
    super(CAP.projectiles);
  }
}

/** Player ground zones, auras made visible, puddles (BUILD). Hostile ground uses telegraphs. */
export class ZonePool extends SlotPool {
  readonly spell = new Int16Array(this.cap);
  readonly slot = new Int8Array(this.cap);
  readonly x = new Float32Array(this.cap);
  readonly y = new Float32Array(this.cap);
  readonly r = new Float32Array(this.cap);
  readonly dmg = new Float32Array(this.cap); // damage per pulse
  readonly life = new Int32Array(this.cap); // ticks left
  readonly maxLife = new Int32Array(this.cap);
  readonly period = new Int16Array(this.cap); // ticks between pulses
  readonly follow = new Uint8Array(this.cap); // 1 = sticks to the player
  readonly aux0 = new Float32Array(this.cap);
  constructor() {
    super(CAP.zones);
  }
}

/** XP gems and pickups (BUILD xp.ts). */
export class GemPool extends SlotPool {
  readonly x = new Float32Array(this.cap);
  readonly y = new Float32Array(this.cap);
  readonly vx = new Float32Array(this.cap);
  readonly vy = new Float32Array(this.cap);
  readonly value = new Float32Array(this.cap); // XP
  readonly tier = new Uint8Array(this.cap); // 0 small .. 3 huge, 4 chest, 5 heal orb
  readonly born = new Int32Array(this.cap);
  readonly state = new Uint8Array(this.cap); // 0 resting, 1 flying to player
  constructor() {
    super(CAP.gems);
  }
}

/** Telegraphed hostile ground (COMBAT hazards.ts / bosses.ts). Red = damage, violet = formation. */
export class TelegraphPool extends SlotPool {
  readonly shape = new Uint8Array(this.cap); // TG_SHAPE
  readonly color = new Uint8Array(this.cap); // TG_COLOR
  readonly flags = new Uint8Array(this.cap); // TGF
  readonly x = new Float32Array(this.cap);
  readonly y = new Float32Array(this.cap);
  readonly x2 = new Float32Array(this.cap); // lane end / cone direction point
  readonly y2 = new Float32Array(this.cap);
  readonly r = new Float32Array(this.cap); // circle radius / lane half-width / cone length
  readonly arc = new Float32Array(this.cap); // cone half-angle (rad)
  readonly start = new Int32Array(this.cap); // tick it appeared
  readonly impact = new Int32Array(this.cap); // tick it resolves (fill reaches the edge)
  readonly linger = new Int32Array(this.cap); // ticks it stays after impact
  readonly dmgPct = new Float32Array(this.cap); // fraction of player max HP
  readonly owner = new Int32Array(this.cap); // enemy slot (boss) or -1
  readonly resolved = new Uint8Array(this.cap);
  constructor() {
    super(CAP.telegraphs);
  }
}

/** Player summons (BUILD spells.ts summon behaviour). */
export class AllyPool extends SlotPool {
  readonly spell = new Int16Array(this.cap);
  readonly slot = new Int8Array(this.cap);
  readonly x = new Float32Array(this.cap);
  readonly y = new Float32Array(this.cap);
  readonly vx = new Float32Array(this.cap);
  readonly vy = new Float32Array(this.cap);
  readonly life = new Int32Array(this.cap);
  readonly cd = new Int32Array(this.cap);
  readonly target = new Int32Array(this.cap);
  readonly aux0 = new Float32Array(this.cap);
  constructor() {
    super(CAP.allies);
  }
}

// ---------------------------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------------------------

/** Everything that seeds a run. Same SeedConfig + spec + inputs + choices = same run. */
export interface SeedConfig {
  day: number; // delve day number (core/daily.ts)
  daySeed: number; // uint32
  attempt: number; // attempt index (seeds burst jitter only)
  omenId: string;
  twistId: string;
}

export interface WorldRng {
  /** Shared by everyone today: spawn positions/kinds, formations. */
  spawn: Rng;
  /** Shared: burst positions and nominal times. */
  hazard: Rng;
  /** Shared: boss attack choices. */
  boss: Rng;
  /** Per attempt: +-0.5 s burst jitter (spec 2.3). */
  jitter: Rng;
  /** Combat rolls (crits, procs). Seeded per day + spec. */
  combat: Rng;
  /** Relic tables / doors. */
  loot: Rng;
}

export interface RunScore {
  totalDamage: number; // tie-break
  kills: number;
  bossesKilled: number;
  staggerSeconds: number;
  fusions: number;
}

export interface World {
  readonly cfg: SeedConfig;
  readonly specId: SpecId;
  readonly mods: Modifiers;
  /** Ticks simulated (paused time is not counted). seconds = tick / 60. */
  tick: number;
  /** Current layer 1..5, 6 = the Core. */
  layer: number;
  over: boolean;
  deathCause: number; // DEATH.*
  arenaR: number;
  readonly rng: WorldRng;
  readonly en: EnemyPool;
  readonly pr: ProjectilePool;
  readonly zn: ZonePool;
  readonly gm: GemPool;
  readonly tg: TelegraphPool;
  readonly al: AllyPool;
  readonly grid: Grid;
  /** Two scratch buffers for grid queries (A for outer loops, B for nested ones). */
  readonly qA: Int32Array;
  readonly qB: Int32Array;
  readonly events: EventQueue;
  /** Derived stats: written only by build.recomputeStats. */
  stats: PlayerStats;
  readonly score: RunScore;
  // per-module state, each type owned by its module:
  readonly player: PlayerState;
  readonly spawn: SpawnState;
  readonly boss: BossState;
  readonly hazard: HazardState;
  readonly spells: SpellState;
  readonly build: BuildState;
  readonly xp: XpState;
  readonly offer: OfferState;
}

export const seconds = (w: World): number => w.tick * DT;
export const minutes = (w: World): number => w.tick / (TICK_HZ * 60);

export function createWorld(seed: SeedConfig, specIn: SpecId, mods: Modifiers): World {
  // fail safe: an unknown spec id (stale save, bad URL) falls back to Ember instead of crashing the boot
  const specId: SpecId = Object.prototype.hasOwnProperty.call(SPECS, specIn) ? specIn : 'ember';
  const s = seed.daySeed >>> 0;
  const specSalt = specId === 'ember' ? 1 : 2;
  const en = new EnemyPool();
  const w = {
    cfg: seed,
    specId,
    mods,
    tick: 0,
    layer: 1,
    over: false,
    deathCause: DEATH.NONE,
    arenaR: WORLD.arenaRadius * mods.arenaMul,
    rng: {
      spawn: deriveRng(s, 1),
      hazard: deriveRng(s, 2),
      boss: deriveRng(s, 3),
      jitter: deriveRng(s, 4, seed.attempt | 0),
      combat: deriveRng(s, 5, specSalt),
      loot: deriveRng(s, 6, specSalt),
    },
    en,
    pr: new ProjectilePool(),
    zn: new ZonePool(),
    gm: new GemPool(),
    tg: new TelegraphPool(),
    al: new AllyPool(),
    grid: new Grid(CAP.enemies),
    qA: new Int32Array(CAP.enemies),
    qB: new Int32Array(CAP.enemies),
    events: new EventQueue(CAP.events),
    stats: defaultStats(),
    score: { totalDamage: 0, kills: 0, bossesKilled: 0, staggerSeconds: 0, fusions: 0 },
  } as Partial<World> as Record<string, unknown>;
  const ww = w as unknown as World;
  w.player = createPlayerState();
  w.spawn = createSpawnState(ww);
  w.boss = createBossState();
  w.hazard = createHazardState(ww);
  w.spells = createSpellState();
  w.build = createBuildState(ww);
  w.xp = createXpState();
  w.offer = createOfferState(ww);
  // init order: build first (stats, signature spell), then the player (max HP from stats)
  initBuild(ww);
  initPlayer(ww);
  return ww;
}

/** True while the sim is paused waiting for a choice. */
export const awaitingChoice = (w: World): boolean => w.offer.open !== null;

/**
 * Advance one 60 Hz tick. Returns false (and does nothing) when the run is over or an offer is open.
 * The step order is a contract: see ARCHITECTURE.md "Step order".
 */
export function step(w: World, input: InputFrame): boolean {
  if (w.over || w.offer.open !== null) return false;
  w.tick++;
  updateClock(w); //            1 CORE: layer / Core transitions
  updatePlayer(w, input); //    2 COMBAT: movement, dash, regen (heal cap)
  updateSpawning(w); //         3 COMBAT: pressure, trash spawns, queue/clumps
  updateBosses(w); //           4 COMBAT: boss spawn at :40, AI, attack telegraphs
  updateHazards(w); //          5 COMBAT: bursts, telegraph resolution, formations, Wyrmfall
  updateEnemies(w); //          6 COMBAT: chase, separation, knockback, contact damage
  const en = w.en; //           7 CORE: spatial hash
  w.grid.rebuild(en.alive, en.x, en.y, en.hi);
  updateSpells(w); //           8 BUILD: cooldowns, casts, summons, orbits, auras
  updateProjectiles(w); //      9 BUILD: move, collide, splash
  updateZones(w); //           10 BUILD: zone pulses
  updateStatuses(w); //        11 BUILD: burn/poison/chill ticks, spread
  updateGems(w); //            12 BUILD: magnet, pickup, decay, level-ups (may open an offer)
  return true;
}

/** Apply a choice to the open offer. Returns false if there is no open offer or the code is invalid. */
export function choose(w: World, code: ChoiceCode): boolean {
  if (w.offer.open === null) return false;
  return applyChoice(w, code);
}

function updateClock(w: World): void {
  const t = w.tick * DT;
  const layer = t >= TIMELINE.coreStart ? 6 : Math.min(TIMELINE.layers, Math.floor(t / TIMELINE.layerSeconds) + 1);
  if (layer !== w.layer) {
    w.layer = layer;
    if (layer === 6) w.events.push(EV.CORE_ENTER, w.tick);
    else w.events.push(EV.LAYER_CHANGE, w.tick, layer);
  }
}
