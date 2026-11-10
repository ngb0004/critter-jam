/**
 * Relic / talent rule bodies and the deferred proc queue (BUILD).
 *
 * Procs (spec 7.2 / 7.3): on-kill effects are not resolved inside the kill (that would recurse through
 * dealDamage -> killEnemy -> onKill while a grid query is being iterated). They are queued here and flushed
 * at the end of each BUILD system. Proc damage uses src = SRC.RELIC, and kills credited to SRC.RELIC never
 * fire on-kill hooks, so procs cannot proc (one generation deep). Each proc kind has a per-second budget.
 *
 * Shatter (Frost: 5 chill stacks) also goes through this queue, credited to the spell slot that chilled.
 */
import { CAP, TICK_HZ } from '../core/constants';
import { EV } from '../core/events';
import { DIR_X, DIR_Y } from '../core/fmath';
import type { World } from '../core/world';
import { EF, ST, SRC } from '../core/types';
import { spellIndex } from '../content/spells';
import { dealDamage, DMG } from './damage';
import { knockback } from './enemies';
import { spawnProjectile } from './projectiles';
import { spawnZone } from './zones';
import { rankMult } from './build';

/** Rule flags set by relic / talent onAcquire hooks. Read by spells/damage/statuses. */
export interface BuildRules {
  echoStone: boolean;
  wildfire: boolean;
  kindledCore: boolean;
  searingWake: boolean;
  focusedFlame: boolean;
  plague: boolean;
  opportunist: boolean;
  virulence: boolean;
  deepCuts: boolean;
}
export function createRules(): BuildRules {
  return {
    echoStone: false, wildfire: false, kindledCore: false, searingWake: false, focusedFlame: false,
    plague: false, opportunist: false, virulence: false, deepCuts: false,
  };
}
export const rules = (w: World): BuildRules => w.build.rules;

// ---------------------------------------------------------------------------------------------
// Proc queue
// ---------------------------------------------------------------------------------------------

export const PROC = { BLAST: 0, SHATTER: 1, PUDDLE: 2, CINDER: 3 } as const;
/** Max procs per second per kind (spec 7.3: Grave Bloom <= 4 puddles/s). */
const BUDGET = [6, 30, 4, 12];
const PROC_CAP = 64;

export interface ProcQueue {
  n: number;
  kind: Uint8Array;
  x: Float32Array;
  y: Float32Array;
  r: Float32Array;
  dmg: Float32Array;
  src: Int8Array;
  /** Budget window: counts per kind since windowTick. */
  used: Int32Array;
  windowTick: number;
}
export function createProcQueue(): ProcQueue {
  return {
    n: 0, kind: new Uint8Array(PROC_CAP), x: new Float32Array(PROC_CAP), y: new Float32Array(PROC_CAP),
    r: new Float32Array(PROC_CAP), dmg: new Float32Array(PROC_CAP), src: new Int8Array(PROC_CAP),
    used: new Int32Array(4), windowTick: 0,
  };
}

/** Queue a proc. Returns false if the per-second budget or the queue is exhausted. */
export function pushProc(w: World, kind: number, x: number, y: number, r: number, dmg: number, src: number): boolean {
  const q = w.spells.procs;
  if (w.tick - q.windowTick >= TICK_HZ) {
    q.windowTick = w.tick;
    q.used.fill(0);
  }
  if (q.used[kind] >= BUDGET[kind] || q.n >= PROC_CAP) return false;
  q.used[kind]++;
  const i = q.n++;
  q.kind[i] = kind;
  q.x[i] = x;
  q.y[i] = y;
  q.r[i] = r;
  q.dmg[i] = dmg;
  q.src[i] = src;
  return true;
}

/** Resolve queued procs (called at the end of each BUILD system). Procs queued while flushing run too. */
export function flushProcs(w: World): void {
  const q = w.spells.procs;
  const en = w.en;
  let k = 0;
  while (k < q.n) {
    const kind = q.kind[k];
    const x = q.x[k];
    const y = q.y[k];
    const r = q.r[k];
    const dmg = q.dmg[k];
    const src = q.src[k];
    k++;
    if (kind === PROC.PUDDLE || kind === PROC.CINDER) {
      const si = kind === PROC.PUDDLE ? IDX_BILE() : IDX_CINDER();
      const life = Math.round((kind === PROC.PUDDLE ? 2.5 : 2) * TICK_HZ * w.stats.durationMul);
      const rp = relicPower(w);
      const z = spawnZone(w, si, SRC.RELIC, x, y, r, dmg * rp, life, 24, false);
      if (z >= 0) w.zn.aux0[z] = rp;
      continue;
    }
    // BLAST / SHATTER: instant damage in a radius
    const buf = w.spells.qProc;
    const n = w.grid.queryCircle(x, y, r + 1.5, buf);
    for (let j = 0; j < n; j++) {
      const e = buf[j];
      if (!en.alive[e]) continue;
      const dx = en.x[e] - x;
      const dy = en.y[e] - y;
      const rr = r + en.r[e];
      if (dx * dx + dy * dy > rr * rr) continue;
      dealDamage(w, e, dmg, src, DMG.NO_STAMP | DMG.PROC);
      if (en.alive[e]) knockback(w, e, x, y, 3);
    }
    w.events.push(EV.HIT, w.tick, -1, src, 4, x, y, r);
  }
  q.n = 0;
}

let bileIdx = -1;
let cinderIdx = -1;
const IDX_BILE = (): number => (bileIdx >= 0 ? bileIdx : (bileIdx = spellIndex('bileFlask')));
const IDX_CINDER = (): number => (cinderIdx >= 0 ? cinderIdx : (cinderIdx = spellIndex('cinderTrail')));

/**
 * Damage scale for relic effects: the strongest slot's fit x R(rank) (at least 1), so relics keep pace
 * with the build without stacking on themselves.
 */
export function relicPower(w: World): number {
  const b = w.build;
  let best = 1;
  for (let s = 0; s < b.slotSpell.length; s++) {
    if (b.slotSpell[s] < 0) continue;
    const v = b.slotFit[s] * rankMult(b.slotRank[s]);
    if (v > best) best = v;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Relic hook bodies (referenced from content/relics.ts)
// ---------------------------------------------------------------------------------------------

/** Grave Bloom: a poisoned enemy leaves a toxic puddle (budget 4/s). */
export function graveBloomOnKill(w: World, e: number, _src: number): void {
  const en = w.en;
  if (en.stStacks[e * CAP.statuses + ST.POISON] <= 0) return;
  pushProc(w, PROC.PUDDLE, en.x[e], en.y[e], 1.6, 5, SRC.RELIC);
}

/** Ember Heart: a burning enemy pops in a 2 m blast (budget 6/s). */
export function emberHeartOnKill(w: World, e: number, _src: number): void {
  const en = w.en;
  const k = e * CAP.statuses + ST.BURN;
  if (en.stStacks[k] <= 0) return;
  pushProc(w, PROC.BLAST, en.x[e], en.y[e], 2, (8 + 2 * en.stStacks[k]) * relicPower(w), SRC.RELIC);
}

/** Overcharge: every 10th cast (all slots together) fires twice. */
export function overchargeOnCast(w: World, slot: number): void {
  const sp = w.spells;
  sp.overchargeCount++;
  if (sp.overchargeCount % 10 === 0) sp.pendingRecast = slot;
}

/** Moth Wing: three cinder patches along the dash path. */
export function mothWingOnDash(w: World): void {
  const p = w.player;
  const d = p.dashDir & 63;
  for (let k = 0; k < 3; k++) {
    const t = 0.5 + k;
    pushProc(w, PROC.CINDER, p.x + DIR_X[d] * t, p.y + DIR_Y[d] * t, 1.2, 6, SRC.RELIC);
  }
}

/** Split Shot: the first projectile of a cast forks (the fork never forks again). */
export function splitShotOnSpawn(w: World, proj: number, first: boolean): void {
  if (!first) return;
  const pr = w.pr;
  // rotate the velocity by about 0.3 rad (cos 0.955, sin 0.296) for the fork
  const c = 0.955;
  const s = 0.296;
  const vx = pr.vx[proj] * c - pr.vy[proj] * s;
  const vy = pr.vx[proj] * s + pr.vy[proj] * c;
  const f = spawnProjectile(w, pr.spell[proj], pr.slot[proj], pr.x[proj], pr.y[proj], vx, vy, pr.r[proj], pr.dmg[proj], pr.life[proj],
    pr.pierce[proj], pr.splash[proj], pr.kind[proj]);
  if (f >= 0) w.spells.prHitN[f] = 0;
}

/** True for bosses and elites (single-target talents). */
export const isBig = (w: World, e: number): boolean => (w.en.flags[e] & (EF.BOSS | EF.ELITE)) !== 0;
