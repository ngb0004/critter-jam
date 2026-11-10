/**
 * Statuses (BUILD): burn, poison, chill/shatter, shock, shadow. Per enemy, per kind: stacks, ticks left,
 * damage per stack per second, and the slot that applied it (kill credit).
 *
 *  BURN    DoT, stacks to maxStacks; spreads on death only with the Wildfire talent.
 *  POISON  DoT, high stack caps (Virulence +4, +25% duration); spreads on death when applied by a spreading spell
 *          (Creeping Rot, Fever Bloom): to the nearest neighbour within 2.5 m (Plague: 2 neighbours).
 *  SHADOW  DoT that ignores armor and Ironhide; Nightshade's shadow spreads to 2 neighbours within 4 m.
 *  CHILL   -12% speed per stack (floor 40%); at 5 stacks it SHATTERS: stDps holds the shatter damage, dealt in
 *          0.3 m (a big single hit) through the proc queue, then the chill clears.
 *  SHOCK   +8% damage taken per stack (damage.ts), max 3.
 * DoTs pulse every 0.5 s (staggered per enemy) with DMG.DOT | NO_STAMP. Spread copies 75% of the stacks
 * (at least 1) and at least 2 s, one generation per death (a spread never re-spreads in the same tick).
 */
import { CAP, DT } from '../core/constants';
import { EV } from '../core/events';
import type { World } from '../core/world';
import { ST, SRC, type StatusKind } from '../core/types';
import { dealDamage, DMG } from './damage';
import { pushProc, PROC } from './rules';

const DOT_PERIOD = 30; // ticks
const SHATTER_AT = 5;
const SHATTER_R = 0.3; // the shard burst barely reaches past the frozen body: shatter is a big single hit

export interface StatusState {
  /** Bitmask of status kinds that spread on death, valid while spreadUid[e] === en.uid[e]. */
  spreadMask: Uint8Array;
  spreadUid: Int32Array;
  /** Scratch for neighbour queries during spread (nested inside other queries). */
  q: Int32Array;
}
export function createStatusState(): StatusState {
  return { spreadMask: new Uint8Array(CAP.enemies), spreadUid: new Int32Array(CAP.enemies), q: new Int32Array(CAP.enemies) };
}

/**
 * Add stacks of a status to enemy e. dps is per stack per second (for CHILL: the shatter damage).
 * Refreshes duration (never shortens it); keeps the higher dps. spread = this application spreads on death.
 */
export function applyStatus(
  w: World, e: number, kind: StatusKind, stacks: number, seconds: number, dps: number, maxStacks: number, src: number,
  spread = false,
): void {
  const en = w.en;
  if (!en.alive[e]) return;
  const k = e * CAP.statuses + kind;
  let cap = maxStacks;
  let dur = seconds;
  if (kind === ST.POISON && w.build.rules.virulence) {
    cap += 4;
    dur *= 1.25;
  }
  let s = en.stStacks[k] + stacks;
  if (s > cap) s = cap;
  en.stStacks[k] = s;
  const ticks = Math.round(dur / DT);
  if (ticks > en.stTicks[k]) en.stTicks[k] = ticks;
  if (dps > en.stDps[k]) en.stDps[k] = dps;
  en.stSrc[k] = src;
  if (spread) {
    const st = w.spells.status;
    if (st.spreadUid[e] !== en.uid[e]) {
      st.spreadUid[e] = en.uid[e];
      st.spreadMask[e] = 0;
    }
    st.spreadMask[e] |= 1 << kind;
  }
  if (kind === ST.CHILL && s >= SHATTER_AT) {
    pushProc(w, PROC.SHATTER, en.x[e], en.y[e], SHATTER_R, en.stDps[k], src);
    en.stStacks[k] = 0;
    en.stTicks[k] = 0;
    en.stDps[k] = 0;
  }
  w.events.push(EV.STATUS, w.tick, e, kind, en.stStacks[k], en.x[e], en.y[e]);
}

export function updateStatuses(w: World): void {
  const en = w.en;
  const NS = CAP.statuses;
  for (let e = 0; e < en.hi; e++) {
    if (!en.alive[e]) continue;
    let slow = 1;
    const pulse = (w.tick + e) % DOT_PERIOD === 0;
    for (let kind = 0; kind < NS; kind++) {
      const k = e * NS + kind;
      if (en.stTicks[k] <= 0) continue;
      en.stTicks[k]--;
      if (en.stTicks[k] === 0) {
        en.stStacks[k] = 0;
        en.stDps[k] = 0;
        continue;
      }
      if (kind === ST.CHILL) slow *= 1 - 0.12 * en.stStacks[k];
      else if (pulse && en.stDps[k] > 0 && kind !== ST.SHOCK && en.alive[e]) {
        const flags = DMG.DOT | DMG.NO_STAMP | (kind === ST.SHADOW ? DMG.IGNORE_ARMOR : 0);
        const src = en.stSrc[k] >= 0 ? en.stSrc[k] : SRC.STATUS;
        dealDamage(w, e, en.stStacks[k] * en.stDps[k] * DOT_PERIOD * DT, src, flags);
      }
    }
    if (en.alive[e]) en.slow[e] = slow < 0.4 ? 0.4 : slow;
  }
}

/** Called by killEnemy before the slot is released: spread poison / shadow / (Wildfire) burn to neighbours. */
export function onEnemyDeath(w: World, e: number): void {
  const en = w.en;
  const NS = CAP.statuses;
  const st = w.spells.status;
  const mask = st.spreadUid[e] === en.uid[e] ? st.spreadMask[e] : 0;
  const ru = w.build.rules;
  for (let kind = 0; kind < 5; kind++) {
    const k = e * NS + kind;
    if (en.stStacks[k] <= 0 || en.stTicks[k] <= 0) continue;
    let n = 0;
    let r = 2.5;
    if (kind === ST.POISON && mask & (1 << ST.POISON)) n = ru.plague ? 2 : 1;
    else if (kind === ST.SHADOW && mask & (1 << ST.SHADOW)) {
      n = 2;
      r = 4;
    } else if (kind === ST.BURN && ru.wildfire) n = 2;
    if (n === 0) continue;
    spreadTo(w, e, kind as StatusKind, n, r, (mask & (1 << kind)) !== 0);
  }
}

function spreadTo(w: World, e: number, kind: StatusKind, n: number, r: number, spreads: boolean): void {
  const en = w.en;
  const NS = CAP.statuses;
  const k = e * NS + kind;
  const stacks = Math.max(1, Math.ceil(en.stStacks[k] * 0.75));
  const secs = Math.max(2, en.stTicks[k] * DT);
  const q = w.spells.status.q;
  const cnt = w.grid.queryCircle(en.x[e], en.y[e], r, q);
  // pick the n nearest neighbours that hold fewer stacks than we would give them
  let b0 = -1;
  let d0 = r * r;
  let b1 = -1;
  let d1 = r * r;
  for (let j = 0; j < cnt; j++) {
    const o = q[j];
    if (o === e || !en.alive[o]) continue;
    if (en.stStacks[o * NS + kind] >= stacks) continue;
    const dx = en.x[o] - en.x[e];
    const dy = en.y[o] - en.y[e];
    const d = dx * dx + dy * dy;
    if (d < d0) {
      b1 = b0;
      d1 = d0;
      b0 = o;
      d0 = d;
    } else if (d < d1) {
      b1 = o;
      d1 = d;
    }
  }
  const cap = kind === ST.POISON ? 12 : kind === ST.SHADOW ? 12 : 5;
  if (b0 >= 0) applyStatus(w, b0, kind, stacks, secs, en.stDps[k], cap, en.stSrc[k], spreads);
  if (n > 1 && b1 >= 0) applyStatus(w, b1, kind, stacks, secs, en.stDps[k], cap, en.stSrc[k], spreads);
}
