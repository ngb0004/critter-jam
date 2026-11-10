/**
 * Per-second run log (UI/app, read-only on the World) and the plain-words death summary for the results screen
 * (spec 3.3: "Overrun at 8:12: kill rate fell behind at 7:40."). Sampling allocates nothing per tick.
 */
import { DEATH } from '../core/types';
import { fmtTime } from './format';

const MAX_SEC = 900;

export class RunLog {
  /** HP fraction at the end of each sim second. */
  readonly hp = new Float32Array(MAX_SEC);
  readonly enemies = new Uint16Array(MAX_SEC);
  readonly kills = new Uint32Array(MAX_SEC);
  n = 0;
  burstHits = 0;
  hurtByBoss = 0;
  bossesSeen = 0;

  reset(): void {
    this.n = 0;
    this.burstHits = 0;
    this.hurtByBoss = 0;
    this.bossesSeen = 0;
  }

  /** Call with the world's current second; records once per new second. */
  sample(sec: number, hpFrac: number, enemies: number, kills: number): void {
    const s = Math.floor(sec);
    while (this.n <= s && this.n < MAX_SEC) {
      this.hp[this.n] = hpFrac;
      this.enemies[this.n] = Math.min(65535, enemies);
      this.kills[this.n] = kills;
      this.n++;
    }
  }

  /** Last second (before `endSec`) at which HP was at or above `frac`, or -1. */
  lastHealthy(endSec: number, frac = 0.7): number {
    for (let s = Math.min(this.n - 1, Math.floor(endSec)); s >= 0; s--) if (this.hp[s] >= frac) return s;
    return -1;
  }
}

export interface DeathSummary {
  /** "Overrun at 8:12" */
  title: string;
  /** One plain sentence: what happened. */
  line: string;
  /** One plain sentence: what to try next. */
  tip: string;
}

export interface DeathContext {
  bossName?: string;
  /** Seconds since the Wyrm surfaced (Wyrmfall deaths). */
  wyrmSec?: number;
  staggerSec?: number;
  /** player.dmgByCause (indexed by DEATH.*): damage taken per cause over the run. */
  dmgByCause?: ArrayLike<number>;
  /** Boss index (content/bosses.ts order) of the newest boss still alive at death, or -1 / undefined. */
  liveBoss?: number;
  /** Non-fused spells owned, their highest rank, and fusions made (for the build tip). */
  spells?: number;
  maxRank?: number;
  fusions?: number;
}

/**
 * What beats each boss, in plain words (v0.2 review: casual players died to the same boss three times with the same
 * generic tip and had no idea what to try differently). Index = content/bosses.ts order.
 */
export const BOSS_TIPS: readonly string[] = [
  'The Foreman leaps onto its red circle: walk out sideways the moment the circle appears.',
  'Sporemother leaves spore puddles that keep hurting: circle her and never back into an old puddle.',
  'The Drowned Engine charges down its red lane: step or dash sideways out of the lane, not backwards.',
  'Prism Warden beams are long lanes that bounce off the wall: cross them sideways, then keep circling.',
  'The Anvil King mixes every attack: keep circling and save your dash for its charge lane.',
];

/** "You spread over 6 spells" tip, or '' when the build is focused enough. */
function buildTip(ctx: DeathContext): string {
  if ((ctx.spells ?? 0) >= 4 && (ctx.maxRank ?? 5) < 4 && !(ctx.fusions ?? 0)) {
    return `You spread over ${ctx.spells} spells, none above rank ${Math.floor(ctx.maxRank ?? 3)}. Ranking one or two up to 5 hits much harder, and that is how spells fuse.`;
  }
  return '';
}

const RED_TIP = 'When the floor turns red, walk out before it fills. A dash makes you immune.';

export function deathSummary(cause: number, sec: number, log: RunLog | null, ctx: DeathContext = {}): DeathSummary {
  const at = fmtTime(sec);
  switch (cause) {
    case DEATH.CHIP: {
      // pick the story from where the damage came from, not only the killing blow
      const d = ctx.dmgByCause;
      const contact = d ? d[DEATH.CHIP] + d[DEATH.BOSS] : 0;
      const red = d ? d[DEATH.BURST] : 0;
      if (d && red > contact && red > 0) {
        const pct = Math.round((100 * red) / Math.max(1e-6, red + contact + d[DEATH.WYRMFALL]));
        return {
          title: `Worn down at ${at}`,
          line: `Red floor did ${pct}% of your damage; the crowd landed the last hit.`,
          tip: RED_TIP,
        };
      }
      // the moment HP dropped below half for good
      const healthy = log ? log.lastHealthy(sec, 0.5) : -1;
      const gap = sec - healthy;
      return {
        title: `Overrun at ${at}`,
        line: healthy < 0
          ? 'The crowd was too thick from the start.'
          : gap <= 6
            ? `It went fast: healthy at ${fmtTime(healthy)}, down ${Math.max(1, Math.round(gap))} s later.`
            : gap > 40
              ? `You dropped below half health at ${fmtTime(healthy)} and never got it back.`
              : `Your kill rate fell behind at ${fmtTime(healthy)}.`,
        tip: buildTip(ctx)
          || (ctx.liveBoss !== undefined && ctx.liveBoss >= 0 && BOSS_TIPS[ctx.liveBoss] ? `${ctx.bossName ?? 'The boss'} was still up. ${BOSS_TIPS[ctx.liveBoss]}` : '')
          || 'Area spells (splash, auras, puddles) thin the crowd. Two keywords at high rank can fuse.',
      };
    }
    case DEATH.BURST:
      return {
        title: `Caught on the red floor at ${at}`,
        line: log && log.burstHits > 1 ? `Red floor hit you ${log.burstHits} times this run.` : 'A red circle filled while you stood in it.',
        tip: RED_TIP,
      };
    case DEATH.BOSS:
      return {
        title: `Felled by ${ctx.bossName ?? 'a boss'} at ${at}`,
        line: 'Bosses hit hard up close and keep coming while trash spawns.',
        tip: (ctx.liveBoss !== undefined && BOSS_TIPS[ctx.liveBoss]) || 'Keep moving around the boss and step off its red floor.',
      };
    case DEATH.WYRMFALL:
      return {
        title: `Swallowed by the Wyrmfall at ${at}`,
        line: ctx.wyrmSec !== undefined
          ? `You held out ${Math.max(0, Math.round(ctx.wyrmSec))} s against the Wyrm${ctx.staggerSec ? `, staggering it for ${Math.round(ctx.staggerSec)} s` : ''}.`
          : 'Nobody outlives the Wyrm. You made it to the very end.',
        tip: (ctx.staggerSec ?? 0) >= 44.5
          ? 'Full stagger: nobody outlives the Wyrm. That is the whole dive.'
          : 'Hit the Wyrm inside the gold ring to stagger its breath.',
      };
    default:
      return { title: `You left the dive at ${at}`, line: 'Quitting counts as a try. Your best still stands.', tip: 'Retries are free and only your best counts.' };
  }
}
