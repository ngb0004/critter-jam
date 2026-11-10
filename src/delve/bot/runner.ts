/**
 * Headless runner (BOT): plays one real-sim run with a Delver and returns telemetry. Pure (no Node APIs),
 * so scripts, workers and tests can all use it. Same seed + spec + bot config = same run.
 */
import { DT, TICK_HZ } from '../core/constants';
import { EV } from '../core/events';
import { hashWorld, Recorder } from '../core/replay';
import type { Replay } from '../core/replay';
import type { SpecId } from '../core/types';
import { DEATH } from '../core/types';
import { choose, createWorld, step, type SeedConfig, type World } from '../core/world';
import { buildModifiers } from '../content/omens';
import { SPELLS } from '../content/spells';
import { OK } from '../sim/offers';
import { Delver, type BotConfig } from './bot';

export interface RunResult {
  sec: number;
  cause: number; // DEATH.*
  layer: number; // 1..5, 6 = Core
  level: number;
  kills: number;
  bosses: number;
  fusions: number;
  fusionIds: string[];
  /** Seconds of each fusion. */
  fusionAt: number[];
  stagger: number;
  /** Seconds of the first level-up card. */
  firstPick: number;
  /** Largest gap between two level-up cards inside the Descent (seconds). */
  maxPickGap: number;
  /** Level-up cards per minute of run time, index = minute. */
  picksByMin: number[];
  /** Seconds when each layer boss died (-1 = never). */
  bossKillAt: number[];
  dmgByCause: number[];
  maxEnemies: number;
  /** Level at the end of each minute. */
  levelByMin: number[];
  /** HP fraction at the end of each minute. */
  hpByMin: number[];
  rerolls: number;
  banishes: number;
  /** XP collected / XP dropped (routing). */
  xpShare: number;
  hash: number;
  replay?: Replay;
}

export interface RunOptions {
  seed: SeedConfig;
  spec: SpecId;
  bot: BotConfig;
  /** Override the seed's Omen ('' = none) for Omen experiments. */
  omenId?: string;
  twistId?: string;
  /** Record a replay (slower; for verification). */
  record?: boolean;
  maxSec?: number;
}

export function runBot(o: RunOptions): RunResult {
  const seed: SeedConfig = { ...o.seed, omenId: o.omenId ?? o.seed.omenId, twistId: o.twistId ?? o.seed.twistId };
  const w: World = createWorld(seed, o.spec, buildModifiers(seed.omenId, seed.twistId));
  const bot = new Delver(o.bot);
  const rec = o.record ? new Recorder(seed, o.spec) : null;
  const maxTick = (o.maxSec ?? 900) * TICK_HZ;
  const picksByMin: number[] = [];
  const fusionIds: string[] = [];
  const fusionAt: number[] = [];
  const bossKillAt = [-1, -1, -1, -1, -1];
  let firstPick = -1;
  let lastPick = 0;
  let maxPickGap = 0;
  let maxEnemies = 0;
  let lastKind = -1;
  const levelByMin: number[] = [];
  const hpByMin: number[] = [];
  while (!w.over && w.tick < maxTick) {
    if (w.offer.open) {
      const kind = w.offer.open.kind;
      if (kind === OK.LEVEL && lastKind !== w.tick) {
        lastKind = w.tick;
        const s = w.tick * DT;
        const m = Math.floor(s / 60);
        picksByMin[m] = (picksByMin[m] ?? 0) + 1;
        if (firstPick < 0) firstPick = s;
        if (s < 300 && s - lastPick > maxPickGap) maxPickGap = s - lastPick;
        lastPick = s;
      }
      const t = w.tick;
      const c = bot.choose(w);
      if (choose(w, c)) rec?.choice(t, c);
      else choose(w, 0); // never stall on a bad code
      continue;
    }
    const f = bot.input(w);
    if (step(w, f)) rec?.frame(f);
    const ev = w.events;
    for (let i = 0; i < ev.n; i++) {
      const type = ev.kind[i];
      if (type === EV.FUSION) {
        fusionAt.push(w.tick * DT);
        fusionIds.push(SPELLS[ev.a[i]]?.id ?? String(ev.a[i]));
      } else if (type === EV.BOSS_KILL) {
        const idx = ev.b[i];
        if (idx >= 0 && idx < 5 && bossKillAt[idx] < 0) bossKillAt[idx] = w.tick * DT;
      }
    }
    ev.clear();
    if (w.en.count > maxEnemies) maxEnemies = w.en.count;
    if (w.tick % 3600 === 0) {
      levelByMin.push(w.xp.level);
      hpByMin.push(w.player.hp / w.player.maxHp);
    }
  }
  if (!w.over) w.deathCause = DEATH.NONE;
  return {
    sec: w.tick * DT,
    cause: w.deathCause,
    layer: w.layer,
    level: w.xp.level,
    kills: w.score.kills,
    bosses: w.score.bossesKilled,
    fusions: w.score.fusions,
    fusionIds,
    fusionAt,
    stagger: w.hazard.stagger,
    firstPick,
    maxPickGap,
    picksByMin: Array.from(picksByMin, (v) => v ?? 0),
    bossKillAt,
    dmgByCause: Array.from(w.player.dmgByCause),
    maxEnemies,
    levelByMin,
    hpByMin,
    xpShare: w.xp.collected / Math.max(1, w.xp.dropped),
    rerolls: bot.rerolls,
    banishes: bot.banishes,
    hash: hashWorld(w),
    replay: rec?.finish(),
  };
}
