/**
 * Bursts, telegraph resolution, the Wyrmfall, rocks and stagger (COMBAT), spec 4.2, 7.1, 7.3, 7.4.
 *
 * Bursts: a Poisson process at lambda(t) = BAL.burstRate0 e^(burstRateD L_d) e^(burstRateC c) x Omen
 * (BOT v0.2: 0.07 e^(0.30 L_d) e^(0.06 c)). Nominal times, shapes,
 * offsets and rotations come from w.rng.hazard with a FIXED number of draws per burst and depend only
 * on the nominal time, so every player gets the same pattern today (offsets are relative to wherever
 * you stand). Each RUN shifts each burst by +-BAL.burstJitter s: w.rng.jitter (per attempt) mixed with a hash of
 * the run's own state, so two players on the same attempt number do not share a lethal tick (spec 2.3, 7.1).
 * Shapes: circles from 0:00, lanes from 2:00, cones from 3:00, double bursts in the Core ramping in from 8:00.
 * Size: min(0.85, burstPct0 e^(burstPctC c)) x maxHP (BOT v0.2: 0.16 e^(0.06 c)) (bursts take half DR; a dash gives 0.25 s immunity).
 *
 * Telegraphs: wind-up >= 1.2 s in the Descent, 0.8 s in the Core (+ Long Fuse). Shapes:
 *   CIRCLE (x, y, r) | LANE (x, y) -> (x2, y2), half-width r | CONE apex (x, y), direction toward
 *   (x2, y2), length r, half-angle arc | RING annulus: outer r, INNER radius in `arc`.
 * The player hurtbox is 70% of the visual radius. LINGER_HURTS telegraphs (spore puddles) deal half of
 * dmgPct on impact, then dmgPct x maxHP per second while you stand in them for `linger` ticks.
 *
 * Wyrmfall (12:00): the maw (4 m ring at the arena edge, day-seeded angle) opens at 11:52, the head
 * (EF.WYRM enemy) surfaces at 12:00 and the breath starts: W = 0.005 x 2^((t - 720 - s)/30) x maxHP/s,
 * TRUE damage. While you stand in the ring, 50% of the damage you deal elsewhere is diverted onto the head;
 * every 1,800 damage on the head staggers the clock by 1 s (s <= 45). Rocks fall on telegraphs (TRUE
 * damage, dash does not help), much more often inside the ring. With the 1.5%/s heal cap every run
 * ends by 14:32; player.ts also hard-stops at 872 s.
 *
 * Stable fields read by RENDER/UI: wyrmActive, mawOpen, mawX, mawY, mawR, headSlot, stagger,
 * staggerDmg, breathPerSec, inMaw.
 */
import { BAL, DT, TICK_HZ, WORLD, secToTicks } from '../core/constants';
import { EV } from '../core/events';
import { cosIdx, fcos, fexp, fexp2, flog, sinIdx } from '../core/fmath';
import { deriveRng, type Rng } from '../core/rng';
import { hashInts } from '../core/hash';
import type { World } from '../core/world';
import { DEATH, EF, SRC, TG_COLOR, TG_SHAPE, TGF } from '../core/types';
import { EN } from '../content/enemies';
import { HURT, hurtPlayer } from './player';
import { spawnEnemy } from './enemies';
import { DMG, dealDamage } from './damage';
import { commitDamageSnapshot, mightDiv } from './bosses';

/** Telegraph categories (per-category caps keep the 96-slot pool from starving bursts). */
export const TGC = { GENERIC: 0, BURST: 1, BOSS: 2, PUDDLE: 3, SLAM: 4, ROCK: 5, FORMATION: 6, MAW: 7 } as const;
const TGC_CAP = [16, 10, 28, 14, 10, 12, 4, 1];

/** Wyrmfall timing. */
const MAW_OPEN = BAL.wyrmT - 8; // the ring appears 8 s early so players can plan
const ROCK_RATE_OUT = 0.12; // rocks per second outside the maw ring (spec 7.4: 0.12/s)
const ROCK_RATE_IN = 0.36; // inside it (3x: the ring is the risky place to stand)
const ROCK_R = 1.35;
const HEAD_HP = 1e9;

export interface HazardState {
  // bursts (shared schedule + per-attempt jitter)
  burstNominal: number; // tick of the next nominal burst
  burstJitter: number; // ticks of jitter for it
  burstShape: number;
  burstU: number; // uniform for offset distance
  burstA: number; // offset angle idx
  burstRot: number; // shape rotation idx
  burstDouble: number; // uniform: second burst in the late Core
  bursts: number;
  /** Kept for old readers: fraction of the next burst owed (unused by the schedule). */
  nextBurstAcc: number;
  // telegraph bookkeeping (parallel to w.tg slots)
  cat: Uint8Array;
  ownerUid: Int32Array;
  catCount: Int32Array;
  // Wyrmfall
  rockRng: Rng;
  rockAcc: number;
  mawOpen: boolean;
  wyrmActive: boolean;
  mawX: number;
  mawY: number;
  mawR: number;
  mawTg: number;
  headSlot: number;
  headUid: number;
  inMaw: boolean;
  /** Stagger seconds banked (<= BAL.staggerCap). */
  stagger: number;
  /** Damage dealt to the Wyrm head toward the next stagger second. */
  staggerDmg: number;
  /** Total damage on the head this run. */
  headDmgTotal: number;
  /** Head damage since the last damage snapshot (bosses.ts accounting). */
  headDmgTick: number;
  breathPerSec: number; // fraction of max HP per second, for the HUD
}

export function createHazardState(w: World): HazardState {
  const h: HazardState = {
    burstNominal: 0, burstJitter: 0, burstShape: 0, burstU: 0, burstA: 0, burstRot: 0, burstDouble: 1, bursts: 0,
    nextBurstAcc: 0,
    cat: new Uint8Array(96), ownerUid: new Int32Array(96), catCount: new Int32Array(8),
    rockRng: deriveRng(w.cfg.daySeed >>> 0, 0x70c, w.cfg.attempt | 0),
    rockAcc: 0, mawOpen: false, wyrmActive: false, mawX: 0, mawY: 0, mawR: BAL.mawRadius, mawTg: -1,
    headSlot: -1, headUid: 0, inMaw: false,
    stagger: 0, staggerDmg: 0, headDmgTotal: 0, headDmgTick: 0, breathPerSec: 0,
  };
  scheduleBurst(w, h, 0);
  return h;
}

/** lambda(t) for a nominal time in seconds (shared; does not depend on the player). */
function burstRate(w: World, t: number): number {
  const m = t / 60;
  const ld = m < 5 ? m : 5;
  const c = m > 5 ? m - 5 : 0;
  return BAL.burstRate0 * fexp(BAL.burstRateD * ld) * fexp(BAL.burstRateC * c) * w.mods.burstRateMul;
}

/** Draw the next burst after nominal tick `from`. Exactly 6 hazard draws + 1 jitter draw. */
function scheduleBurst(w: World, h: HazardState, from: number): void {
  const r = w.rng.hazard;
  const u = r.next();
  const lam = burstRate(w, from * DT);
  let gap = -flog(1 - u) / lam;
  if (gap < 0.7) gap = 0.7;
  if (gap > 40) gap = 40;
  h.burstNominal = from + secToTicks(gap);
  h.burstShape = r.next();
  h.burstU = r.next();
  h.burstA = r.angleIdx();
  h.burstRot = r.angleIdx();
  h.burstDouble = r.next();
  h.burstJitter = burstJitterTicks(w, h);
}

/**
 * Per-run burst jitter in ticks, uniform in +-BAL.burstJitter s. The attempt-seeded draw alone is identical for
 * every player's Nth attempt (a whole cohort would get the same lethal tick), so it is mixed with a hash of this
 * run's own state (lantern position, tick, burst count): replayable, but different for every run that has moved
 * differently (spec 7.1 finding: lethal telegraphs must not run on global timestamps).
 */
function burstJitterTicks(w: World, h: HazardState): number {
  const p = w.player;
  const own = hashInts(w.cfg.daySeed >>> 0, w.cfg.attempt | 0, h.bursts, w.tick, Math.floor(p.x * 64) | 0, Math.floor(p.y * 64) | 0) / 4294967296;
  let u = w.rng.jitter.next() + own;
  if (u >= 1) u -= 1;
  return Math.round((u * 2 - 1) * BAL.burstJitter * TICK_HZ);
}

/**
 * Create a telegraph. windupSec is clamped to the minimum (1.2 s Descent / 0.8 s Core) and gets
 * mods.telegraphExtra. dmgPct is a fraction of player max HP. Returns the slot or -1.
 */
export function addTelegraph(
  w: World, shape: number, color: number, x: number, y: number, r: number,
  windupSec: number, dmgPct: number, flags: number, owner: number,
): number {
  return addTelegraphCat(w, shape, color, x, y, r, windupSec, dmgPct, flags, owner, TGC.GENERIC, 0);
}

/** addTelegraph with a category (per-category cap) and a linger time in seconds. */
export function addTelegraphCat(
  w: World, shape: number, color: number, x: number, y: number, r: number,
  windupSec: number, dmgPct: number, flags: number, owner: number, cat: number, lingerSec: number,
): number {
  const h = w.hazard;
  if (h.catCount[cat] >= TGC_CAP[cat]) return -1;
  const tg = w.tg;
  const i = tg.alloc();
  if (i < 0) return -1;
  const minWind = w.layer >= 6 ? BAL.telegraphCore : BAL.telegraphDescent;
  const wind = (windupSec < minWind ? minWind : windupSec) + w.mods.telegraphExtra;
  tg.shape[i] = shape;
  tg.color[i] = color;
  tg.flags[i] = flags;
  tg.x[i] = x;
  tg.y[i] = y;
  tg.x2[i] = x;
  tg.y2[i] = y;
  tg.r[i] = r;
  tg.arc[i] = 0;
  tg.start[i] = w.tick;
  tg.impact[i] = w.tick + secToTicks(wind);
  tg.linger[i] = secToTicks(lingerSec);
  tg.dmgPct[i] = dmgPct;
  tg.owner[i] = owner;
  tg.resolved[i] = 0;
  h.cat[i] = cat;
  h.ownerUid[i] = owner >= 0 ? w.en.uid[owner] : 0;
  h.catCount[cat]++;
  w.events.push(EV.TELEGRAPH, w.tick, i, shape, color, x, y, wind);
  return i;
}

function releaseTg(w: World, i: number): void {
  const h = w.hazard;
  if (!w.tg.alive[i]) return;
  if (h.catCount[h.cat[i]] > 0) h.catCount[h.cat[i]]--;
  w.tg.release(i);
}

/** Cancel the unresolved telegraphs owned by enemy slot e (boss death). */
export function cancelTelegraphsOf(w: World, e: number): void {
  const tg = w.tg;
  for (let k = 0; k < tg.hi; k++) if (tg.alive[k] && tg.owner[k] === e && !tg.resolved[k]) releaseTg(w, k);
}

/** Is the player's hurtbox inside telegraph i? */
export function playerInTelegraph(w: World, i: number): boolean {
  const p = w.player;
  return pointInTelegraph(w, i, p.x, p.y, WORLD.playerRadius * WORLD.playerHurtFrac);
}

/** Is a circle (x, y, radius hr) overlapping telegraph i? (bots use it with their own margins) */
export function pointInTelegraph(w: World, i: number, px: number, py: number, hr: number): boolean {
  const tg = w.tg;
  const shape = tg.shape[i];
  if (shape === TG_SHAPE.CIRCLE || shape === TG_SHAPE.RING) {
    const dx = px - tg.x[i];
    const dy = py - tg.y[i];
    const d2 = dx * dx + dy * dy;
    const rr = tg.r[i] + hr;
    if (d2 >= rr * rr) return false;
    if (shape === TG_SHAPE.RING && tg.arc[i] > 0) {
      const inner = tg.arc[i] - hr;
      if (inner > 0 && d2 <= inner * inner) return false;
    }
    return true;
  }
  if (shape === TG_SHAPE.LANE) {
    const ax = tg.x[i], ay = tg.y[i], bx = tg.x2[i], by = tg.y2[i];
    const vx = bx - ax, vy = by - ay;
    const len2 = vx * vx + vy * vy || 1;
    let t = ((px - ax) * vx + (py - ay) * vy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + vx * t - px, cy = ay + vy * t - py;
    const rr = tg.r[i] + hr;
    return cx * cx + cy * cy < rr * rr;
  }
  if (shape === TG_SHAPE.CONE) {
    const dx = px - tg.x[i];
    const dy = py - tg.y[i];
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d >= tg.r[i] + hr) return false;
    if (d <= hr) return true;
    let ux = tg.x2[i] - tg.x[i];
    let uy = tg.y2[i] - tg.y[i];
    const ul = Math.sqrt(ux * ux + uy * uy) || 1;
    ux /= ul;
    uy /= ul;
    const dot = (dx * ux + dy * uy) / d;
    // widen the half-angle by the hurtbox's angular size (small-angle approximation of asin)
    let a = tg.arc[i] + hr / d;
    if (a > 3.14159) a = 3.14159;
    return dot >= fcos(a);
  }
  return false;
}

export function updateHazards(w: World): void {
  const t = w.tick * DT;
  const h = w.hazard;
  const p = w.player;
  const tick = w.tick;

  // --- bursts ---
  if (tick >= h.burstNominal + h.burstJitter) {
    fireBurst(w, h, h.burstNominal);
    scheduleBurst(w, h, h.burstNominal);
  }

  // --- Wyrmfall ---
  if (t >= MAW_OPEN && !h.mawOpen) openMaw(w, h);
  if (h.mawOpen) {
    const dx = p.x - h.mawX;
    const dy = p.y - h.mawY;
    h.inMaw = dx * dx + dy * dy < h.mawR * h.mawR;
  }
  if (t >= BAL.wyrmT) {
    if (!h.wyrmActive) {
      h.wyrmActive = true;
      surfaceHead(w, h);
      w.events.push(EV.WYRMFALL, tick, 1, 0, 0, h.mawX, h.mawY);
    }
    // keep the head topped up (it cannot die)
    const hs = h.headSlot;
    if (hs >= 0 && w.en.alive[hs] && w.en.uid[hs] === h.headUid) {
      w.en.hp[hs] = HEAD_HP;
      // the ring (spec 7.4): half of what you deal elsewhere is DIVERTED onto the head (trash clearing halves)
      const b = w.boss;
      const trash = b.trashDmgTick;
      if (trash > 0 && b.divertSrcPrev === 2 && b.divertPrev > 0 && b.divertPrev < 1) {
        const share = (trash * b.divertPrev) / (1 - b.divertPrev) / mightDiv(w);
        dealDamage(w, hs, share, SRC.WYRM, DMG.NO_STAMP | DMG.DOT | DMG.IGNORE_ARMOR);
      }
      if (h.inMaw) {
        b.divert = Math.max(b.divert, BAL.ringShare);
        b.divertSrc = 2;
      }
    }
    rocks(w, h);
    h.breathPerSec = BAL.wyrmD0 * fexp2((t - BAL.wyrmT - h.stagger) / BAL.wyrmDbl);
    hurtPlayer(w, (h.breathPerSec * p.maxHp) / TICK_HZ, HURT.TRUE, DEATH.WYRMFALL);
  }

  // --- resolve telegraphs ---
  const tg = w.tg;
  const en = w.en;
  for (let i = 0; i < tg.hi; i++) {
    if (!tg.alive[i]) continue;
    const fl = tg.flags[i];
    if (fl & TGF.MAW) continue;
    // a golem/elite slam dies with its owner
    if (!tg.resolved[i] && h.cat[i] === TGC.SLAM) {
      const o = tg.owner[i];
      if (o >= 0 && (!en.alive[o] || en.uid[o] !== h.ownerUid[i])) {
        releaseTg(w, i);
        continue;
      }
    }
    if (!tg.resolved[i] && tick >= tg.impact[i]) {
      tg.resolved[i] = 1;
      if (tg.dmgPct[i] > 0 && !w.over && playerInTelegraph(w, i)) {
        const kind = fl & TGF.TRUE_DAMAGE ? HURT.TRUE : fl & TGF.NO_DASH_IMMUNITY ? HURT.BURST_HARD : HURT.BURST;
        const immune = kind === HURT.BURST && p.burstImmune > 0;
        const pct = fl & TGF.LINGER_HURTS ? tg.dmgPct[i] * 0.5 : tg.dmgPct[i];
        const cause = fl & TGF.BOSS ? DEATH.BOSS : fl & TGF.TRUE_DAMAGE ? DEATH.WYRMFALL : DEATH.BURST;
        const dealt = hurtPlayer(w, pct * p.maxHp, kind, cause);
        w.events.push(EV.BURST_HIT, tick, i, immune ? 1 : 0, 0, tg.x[i], tg.y[i], dealt);
      }
    } else if (tg.resolved[i] && fl & TGF.LINGER_HURTS && tick < tg.impact[i] + tg.linger[i]) {
      if (playerInTelegraph(w, i)) {
        hurtPlayer(w, (tg.dmgPct[i] * p.maxHp) / TICK_HZ, HURT.BURST, fl & TGF.BOSS ? DEATH.BOSS : DEATH.BURST);
      }
    }
    if (tg.resolved[i] && tick >= tg.impact[i] + tg.linger[i] + 6) releaseTg(w, i);
  }

  commitDamageSnapshot(w);
}

function fireBurst(w: World, h: HazardState, nominal: number): void {
  const p = w.player;
  const t = nominal * DT;
  const m = t / 60;
  const c = m > 5 ? m - 5 : 0;
  let size = BAL.burstPct0 * fexp(BAL.burstPctC * c);
  if (size > BAL.burstCap) size = BAL.burstCap;
  size *= w.mods.burstSizeMul;
  // shape by time: circles, then lanes (2:00), then cones (3:00)
  let shape: number = TG_SHAPE.CIRCLE;
  if (t >= 180) shape = h.burstShape < 0.45 ? TG_SHAPE.CIRCLE : h.burstShape < 0.75 ? TG_SHAPE.LANE : TG_SHAPE.CONE;
  else if (t >= 120) shape = h.burstShape < 0.6 ? TG_SHAPE.CIRCLE : TG_SHAPE.LANE;
  const off = 3.2 * h.burstU;
  const ox = p.x + cosIdx(h.burstA) * off;
  const oy = p.y + sinIdx(h.burstA) * off;
  const ux = cosIdx(h.burstRot);
  const uy = sinIdx(h.burstRot);
  const wind = w.layer >= 6 ? BAL.telegraphCore : BAL.telegraphDescent;
  emitBurst(w, shape, ox, oy, ux, uy, size, wind);
  // late Core: sometimes a second, offset circle a beat later (ramps in over 8:00-10:00: a hard step at 8:00 piled
  // daily bests into one 10 s bucket)
  if (t >= 480 && h.burstDouble < 0.35 * Math.min(1, (t - 480) / 120)) {
    emitBurst(w, TG_SHAPE.CIRCLE, p.x - cosIdx(h.burstA) * 3.4, p.y - sinIdx(h.burstA) * 3.4, ux, uy, size, wind + 0.35);
  }
  h.bursts++;
}

function emitBurst(w: World, shape: number, x: number, y: number, ux: number, uy: number, size: number, wind: number): void {
  const tg = w.tg;
  if (shape === TG_SHAPE.LANE) {
    const L = 7;
    const i = addTelegraphCat(w, TG_SHAPE.LANE, TG_COLOR.RED, x - ux * L, y - uy * L, 1.05, wind, size, 0, -1, TGC.BURST, 0);
    if (i >= 0) {
      tg.x2[i] = x + ux * L;
      tg.y2[i] = y + uy * L;
    }
  } else if (shape === TG_SHAPE.CONE) {
    const back = 4.2;
    const len = 7.5;
    const i = addTelegraphCat(w, TG_SHAPE.CONE, TG_COLOR.RED, x - ux * back, y - uy * back, len, wind, size, 0, -1, TGC.BURST, 0);
    if (i >= 0) {
      tg.x2[i] = tg.x[i] + ux * len;
      tg.y2[i] = tg.y[i] + uy * len;
      tg.arc[i] = 0.42;
    }
  } else {
    addTelegraphCat(w, TG_SHAPE.CIRCLE, TG_COLOR.RED, x, y, 2.3, wind, size, 0, -1, TGC.BURST, 0);
  }
}

function openMaw(w: World, h: HazardState): void {
  h.mawOpen = true;
  // day-seeded angle: everyone's Wyrm breaks in at the same place
  const a = deriveRng(w.cfg.daySeed >>> 0, 0x3a3).angleIdx();
  const d = w.arenaR - BAL.mawRadius - 0.2;
  h.mawX = cosIdx(a) * d;
  h.mawY = sinIdx(a) * d;
  h.mawR = BAL.mawRadius;
  const i = addTelegraphCat(w, TG_SHAPE.RING, TG_COLOR.GOLD, h.mawX, h.mawY, h.mawR, 0, 0, TGF.MAW, -1, TGC.MAW, 0);
  if (i >= 0) {
    w.tg.arc[i] = h.mawR - 0.45;
    w.tg.impact[i] = w.tick + secToTicks(BAL.wyrmT - MAW_OPEN); // fill completes as the head surfaces
    w.tg.linger[i] = 1 << 28;
  }
  h.mawTg = i;
  w.events.push(EV.WYRMFALL, w.tick, 0, 0, 0, h.mawX, h.mawY);
}

function surfaceHead(w: World, h: HazardState): void {
  // the head sits at the arena edge behind the ring centre
  const k = (w.arenaR - 1) / (Math.sqrt(h.mawX * h.mawX + h.mawY * h.mawY) || 1);
  const i = spawnEnemy(w, EN.WYRM, h.mawX * k, h.mawY * k, EF.WYRM | EF.NO_KNOCKBACK);
  if (i < 0) return;
  w.en.hp[i] = w.en.maxHp[i] = HEAD_HP;
  w.en.dmg[i] = 0;
  w.en.xp[i] = 0;
  w.en.armor[i] = 0;
  h.headSlot = i;
  h.headUid = w.en.uid[i];
}

function rocks(w: World, h: HazardState): void {
  const p = w.player;
  const rate = h.inMaw ? ROCK_RATE_IN : ROCK_RATE_OUT;
  h.rockAcc += rate * DT;
  if (h.rockAcc < 1) return;
  h.rockAcc -= 1;
  const r = h.rockRng;
  const a = r.angleIdx();
  const u = r.next();
  let x: number;
  let y: number;
  if (h.inMaw) {
    // inside the ring: near you, so standing still in the ring is not free
    x = p.x + cosIdx(a) * 2.2 * u;
    y = p.y + sinIdx(a) * 2.2 * u;
  } else {
    x = p.x + cosIdx(a) * (1 + 4 * u);
    y = p.y + sinIdx(a) * (1 + 4 * u);
  }
  addTelegraphCat(w, TG_SHAPE.CIRCLE, TG_COLOR.RED, x, y, ROCK_R, 1.0, BAL.rockPct,
    TGF.TRUE_DAMAGE | TGF.NO_DASH_IMMUNITY, -1, TGC.ROCK, 0);
}

/** Damage landed on the Wyrm head (called by damage.dealDamage). Every staggerDmg = +1 s, cap 45 s. */
export function onWyrmDamage(w: World, dmg: number): void {
  const h = w.hazard;
  h.headDmgTotal += dmg;
  h.headDmgTick += dmg;
  if (h.stagger >= BAL.staggerCap) return;
  h.staggerDmg += dmg;
  while (h.staggerDmg >= BAL.staggerDmg && h.stagger < BAL.staggerCap) {
    h.staggerDmg -= BAL.staggerDmg;
    h.stagger++;
    w.score.staggerSeconds = h.stagger;
    w.events.push(EV.STAGGER, w.tick, h.stagger, 0, 0, h.mawX, h.mawY, 1);
  }
  if (h.stagger >= BAL.staggerCap) h.staggerDmg = 0;
}
