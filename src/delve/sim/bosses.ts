/**
 * Descent bosses (COMBAT), spec 3.1.
 *
 * - One boss per layer, spawned at second 40 of layers 1-5 with FIXED HP (BAL.bossHP x Omen), never
 *   rubber-banded. An unkilled boss carries over (it does not despawn), so several can be alive; on
 *   entering the Core each carried boss's remaining HP is capped at 50% of its max.
 * - Damage soak (spec 3.1 "the boss soaks 50% of your damage"; BAL.bossSoak, 10% since BOT v0.2, ramped in over
 *   BAL.bossSoakRamp s): while a boss is alive and within 18 m,
 *   damage to trash is DIVERTED, not duplicated: trash takes x(1 - BAL.bossSoak) (damage.ts reads
 *   `divert`) and the diverted part lands on the nearest boss next tick, so trash clearing drops while a
 *   boss is up. The Wyrm maw ring uses the same mechanism (hazards.ts). Damage accounting: measured at
 *   the start of updateBosses from w.score.totalDamage, committed at the end of updateHazards
 *   (`trashDmgTick` is shared with the Wyrm maw ring).
 * - Patterns (all telegraphed, wind-up >= 1.2 s in the Descent, 0.8 s in the Core):
 *     slam   circle at where you are heading; the boss leaps onto it at impact.
 *     spores 3-5 lingering puddles around you (red floor that keeps hurting).
 *     charge a lane from the boss through you to the wall; it sprints down it at impact.
 *     beam   three beams from the boss that reflect once off the arena wall.
 *   The Foreman slams; Sporemother slams + spores; the Drowned Engine charges; the Prism Warden beams +
 *   spores; the Anvil King cycles all four.
 * - Soft enrage: after BAL.enrageStart (25 s) alive the volley rate ramps to 2.5x over BAL.enrageLen (60 s) (speed +30% at full).
 * - Kill reward: 0.6 level of XP, 25% max HP healed over the next seconds (inside the heal cap), a talent pick (OK.TALENT), and a chest (EV.CHEST a = 0, then
 *   OK.DOOR: BUILD shows Relic / Forge / Elite). The Elite door calls startEliteDoor(); clearing the
 *   guardian within 20 s gives a 4-relic pick (OK.RELIC, `relicChoices` = 4) plus BUILD's forge().
 *
 * EV.CHEST a: 0 chest dropped (boss kill), 1 elite door fight started, 2 elite cleared, 3 elite escaped.
 *
 * Stable fields read by UI/RENDER: active (most recent live boss slot or -1), defIdx, spawnedTick,
 * slot[5], enrage[5], liveCount, eliteSlot, eliteEndTick, relicChoices.
 */
import { BAL, CAP, DT, secToTicks } from '../core/constants';
import { EV } from '../core/events';
import { cosIdx, sinIdx } from '../core/fmath';
import type { World } from '../core/world';
import { EF, SRC, TG_COLOR, TG_SHAPE, TGF } from '../core/types';
import { BOSSES } from '../content/bosses';
import { EN } from '../content/enemies';
import { addTelegraphCat, cancelTelegraphsOf, TGC } from './hazards';
import { addXpLevels } from './xp';
import { queueOffer, OK } from './offers';
import { contactDmg } from './spawn';
import { CONTACT_MUL, releaseEnemy, spawnEnemy } from './enemies';
import { DMG, dealDamage } from './damage';
import { forge } from './build';
import { queueHeal } from './player';

const NB = 5;
// The soak share is read from BAL.bossSoak at use (FIX v0.2: the old module-level `SOAK_SHARE = BAL.bossSoak` copy was
// captured once at load, so `delve-pop --set bossSoak=...` sweeps never reached it; nothing read it any more).
const SOAK_RANGE = 18;
/** Share of max HP healed (through the heal cap) on each boss kill. */
export const BOSS_KILL_HEAL = 0.25;
/**
 * Boss pattern damage (fraction of max HP). The per-pattern numbers below are relative to the v1 reference
 * BAL.bossBurst 0.13; BAL.bossBurst scales them all (v0.2: bosses live 20-30 s now, so each hit is softer).
 */
const bossPct = (x: number): number => (x * BAL.bossBurst) / 0.13;
/** Seconds between volleys at enrage 1, per boss. */
const VOLLEY = [4.4, 4.8, 5.0, 5.0, 4.0];
/** Preferred distance to the player (0 = chase), per boss. */
const KEEP = [2.6, 6, 7.5, 8.5, 2.8];
const MOVE = 0;
const HOLD = 1;
const CHARGE = 2;
const LEAP = 3;
const LEAP_TICKS = 12;
const CHARGE_SPEED = 24;

export interface BossState {
  /** Enemy slot of the most recently spawned live boss, or -1. */
  active: number;
  defIdx: number;
  spawnedTick: number;
  /** Bitmask of layers whose boss has spawned (bit = layer). */
  spawnedMask: number;
  /** Kept for old readers: next volley tick of the active boss. */
  nextAttack: number;
  // per boss def (0..4)
  slot: Int32Array;
  uid: Int32Array;
  spawnTick: Int32Array;
  next: Int32Array;
  step: Int32Array;
  mode: Uint8Array;
  /** Mode to enter when a HOLD ends (LEAP / CHARGE / MOVE). */
  after: Uint8Array;
  modeEnd: Int32Array;
  chargeTicks: Int32Array;
  mvx: Float64Array;
  mvy: Float64Array;
  tx: Float64Array; // leap target
  ty: Float64Array;
  enrage: Float64Array;
  lastHp: Float64Array;
  liveCount: number;
  coreCapped: boolean;
  // damage accounting
  lastTotal: number;
  /** Damage dealt to non-boss, non-Wyrm targets since the last snapshot. */
  trashDmgTick: number;
  /** Fraction of damage to trash diverted away this tick (damage.ts applies x(1 - divert) to trash). */
  divert: number;
  /** 0 none, 1 boss soak, 2 Wyrm maw ring: who receives the diverted damage. */
  divertSrc: number;
  /** divert / divertSrc that were in effect while trashDmgTick was dealt (the previous tick). */
  divertPrev: number;
  divertSrcPrev: number;
  // chest / elite door
  chests: number;
  eliteSlot: number;
  eliteUid: number;
  eliteEndTick: number;
  elitesCleared: number;
  /** How many relics the next OK.RELIC offer should show (BUILD reads; 4 after an Elite clear). */
  relicChoices: number;
}

export function createBossState(): BossState {
  return {
    active: -1, defIdx: -1, spawnedTick: 0, spawnedMask: 0, nextAttack: 0,
    slot: new Int32Array(NB).fill(-1), uid: new Int32Array(NB), spawnTick: new Int32Array(NB),
    next: new Int32Array(NB), step: new Int32Array(NB), mode: new Uint8Array(NB), after: new Uint8Array(NB),
    modeEnd: new Int32Array(NB), chargeTicks: new Int32Array(NB),
    mvx: new Float64Array(NB), mvy: new Float64Array(NB), tx: new Float64Array(NB), ty: new Float64Array(NB),
    enrage: new Float64Array(NB).fill(1), lastHp: new Float64Array(NB),
    liveCount: 0, coreCapped: false, lastTotal: 0, trashDmgTick: 0, divert: 0, divertSrc: 0, divertPrev: 0, divertSrcPrev: 0,
    chests: 0, eliteSlot: -1, eliteUid: 0, eliteEndTick: 0, elitesCleared: 0, relicChoices: 3,
  };
}

function liveSlot(w: World, k: number): number {
  const b = w.boss;
  const i = b.slot[k];
  if (i < 0) return -1;
  if (!w.en.alive[i] || w.en.uid[i] !== b.uid[k]) {
    b.slot[k] = -1;
    return -1;
  }
  return i;
}

/** Soft enrage multiplier for boss k at the current tick (1 .. BAL.enrageMax). */
export function bossEnrage(w: World, k: number): number {
  const alive = (w.tick - w.boss.spawnTick[k]) * DT;
  const x = (alive - BAL.enrageStart) / BAL.enrageLen;
  if (x <= 0) return 1;
  return 1 + (BAL.enrageMax - 1) * (x > 1 ? 1 : x);
}

export function updateBosses(w: World): void {
  const b = w.boss;
  const t = w.tick * DT;
  measureDamage(w);
  b.divertPrev = b.divert;
  b.divertSrcPrev = b.divertSrc;
  b.divert = 0;
  b.divertSrc = 0;

  // spawn at second 40 of each Descent layer
  if (w.layer <= 5) {
    const layerT = t - (w.layer - 1) * 60;
    const bit = 1 << w.layer;
    if (layerT >= BAL.bossTime && (b.spawnedMask & bit) === 0) {
      b.spawnedMask |= bit;
      spawnBoss(w, w.layer - 1);
    }
  }
  // carry-over cap into the Core (spec 3.1)
  if (!b.coreCapped && w.layer >= 6) {
    b.coreCapped = true;
    for (let k = 0; k < NB; k++) {
      const i = liveSlot(w, k);
      if (i < 0) continue;
      const cap = BAL.carryCap * w.en.maxHp[i];
      if (w.en.hp[i] > cap) w.en.hp[i] = cap;
      b.lastHp[k] = w.en.hp[i];
    }
  }

  // AI per live boss
  let live = 0;
  let nearest = -1;
  let nearestD = SOAK_RANGE * SOAK_RANGE;
  let nearestK = -1;
  b.active = -1;
  let newest = -1;
  for (let k = 0; k < NB; k++) {
    const i = liveSlot(w, k);
    if (i < 0) continue;
    live++;
    if (b.spawnTick[k] >= newest) {
      newest = b.spawnTick[k];
      b.active = i;
      b.defIdx = k;
      b.spawnedTick = b.spawnTick[k];
      b.nextAttack = b.next[k];
    }
    bossAi(w, k, i);
    const dx = w.en.x[i] - w.player.x;
    const dy = w.en.y[i] - w.player.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < nearestD) {
      nearestD = d2;
      nearest = i;
      nearestK = k;
    }
  }
  b.liveCount = live;

  // damage soak: what was diverted away from trash last tick lands on the nearest boss
  if (nearest >= 0 && b.trashDmgTick > 0 && !w.over && b.divertSrcPrev === 1 && b.divertPrev > 0 && b.divertPrev < 1) {
    const diverted = (b.trashDmgTick * b.divertPrev) / (1 - b.divertPrev);
    dealDamage(w, nearest, diverted / mightDiv(w), SRC.OTHER, DMG.NO_STAMP | DMG.DOT | DMG.IGNORE_ARMOR);
  }
  if (nearest >= 0) {
    // v0.2: the soak ramps in over BAL.bossSoakRamp s after the spawn (a full 50% cut in trash clearing at the
    // shared :40 tick piled weak builds into one 10 s bucket right after each boss arrived)
    const age = (w.tick - b.spawnTick[nearestK]) * DT;
    b.divert = BAL.bossSoakRamp > 0 && age < BAL.bossSoakRamp ? (BAL.bossSoak * age) / BAL.bossSoakRamp : BAL.bossSoak;
    b.divertSrc = 1;
  }

  // elite door timer
  if (b.eliteSlot >= 0) {
    const e = b.eliteSlot;
    if (!w.en.alive[e] || w.en.uid[e] !== b.eliteUid) b.eliteSlot = -1;
    else if (w.tick >= b.eliteEndTick) releaseEnemy(w, e); // escaped: onEliteReleased(killed = false)
  }
}

/** Damage accounting: how much landed on things other than bosses and the Wyrm since the snapshot. */
function measureDamage(w: World): void {
  const b = w.boss;
  const delta = w.score.totalDamage - b.lastTotal;
  let direct = 0;
  for (let k = 0; k < NB; k++) {
    if (b.lastHp[k] <= 0) continue;
    const i = liveSlot(w, k);
    const cur = i >= 0 ? w.en.hp[i] : 0;
    if (b.lastHp[k] > cur) direct += b.lastHp[k] - cur;
  }
  const tr = delta - direct - w.hazard.headDmgTick;
  b.trashDmgTick = tr > 0 ? tr : 0;
}

/** End of the hazard step: everything dealt so far is accounted (mirrors excluded). */
export function commitDamageSnapshot(w: World): void {
  const b = w.boss;
  b.lastTotal = w.score.totalDamage;
  for (let k = 0; k < NB; k++) {
    const i = liveSlot(w, k);
    b.lastHp[k] = i >= 0 ? w.en.hp[i] : 0;
  }
  w.hazard.headDmgTick = 0;
}

function spawnBoss(w: World, k: number): void {
  const en = w.en;
  const i = en.alloc();
  if (i < 0) return;
  const def = BOSSES[k];
  const hp = BAL.bossHP[k] * w.mods.bossHpMul;
  const p = w.player;
  // day-seeded side of the screen
  const a = w.rng.boss.angleIdx();
  const lim = w.arenaR - def.radius - 1;
  let x = p.x + cosIdx(a) * 10;
  let y = p.y + sinIdx(a) * 10;
  if (x * x + y * y > lim * lim) {
    x = p.x - cosIdx(a) * 10;
    y = p.y - sinIdx(a) * 10;
    const r2 = x * x + y * y;
    if (r2 > lim * lim) {
      const s = lim / Math.sqrt(r2);
      x *= s;
      y *= s;
    }
  }
  en.def[i] = k;
  en.flags[i] = EF.BOSS | EF.NO_KNOCKBACK;
  en.x[i] = x;
  en.y[i] = y;
  en.vx[i] = en.vy[i] = en.kx[i] = en.ky[i] = 0;
  en.r[i] = def.radius;
  en.hp[i] = en.maxHp[i] = hp;
  en.speed[i] = def.speed;
  en.slow[i] = 1;
  en.dmg[i] = contactDmg(w) * 1.6 * CONTACT_MUL;
  en.xp[i] = 0;
  en.armor[i] = 0;
  en.spawnTick[i] = w.tick;
  en.flash[i] = 0;
  en.touchCd[i] = 0;
  en.aux0[i] = 0;
  en.aux1[i] = 0;
  en.auxI[i] = 0;
  en.hitStamp.fill(-10000, i * CAP.hitSources, (i + 1) * CAP.hitSources);
  en.stStacks.fill(0, i * CAP.statuses, (i + 1) * CAP.statuses);
  en.stTicks.fill(0, i * CAP.statuses, (i + 1) * CAP.statuses);
  en.stDps.fill(0, i * CAP.statuses, (i + 1) * CAP.statuses);
  const b = w.boss;
  b.slot[k] = i;
  b.uid[k] = en.uid[i];
  b.spawnTick[k] = w.tick;
  b.next[k] = w.tick + secToTicks(2.2);
  b.step[k] = 0;
  b.mode[k] = MOVE;
  b.after[k] = MOVE;
  b.enrage[k] = 1;
  b.lastHp[k] = hp;
  b.active = i;
  b.defIdx = k;
  b.spawnedTick = w.tick;
  w.events.push(EV.BOSS_SPAWN, w.tick, i, k, k + 1, x, y, hp);
}

// ---------------------------------------------------------------------------------------------
// AI and patterns
// ---------------------------------------------------------------------------------------------

function bossAi(w: World, k: number, i: number): void {
  const b = w.boss;
  const en = w.en;
  const p = w.player;
  const def = BOSSES[k];
  const enr = bossEnrage(w, k);
  b.enrage[k] = enr;
  const tick = w.tick;
  const mode = b.mode[k];
  if (mode === HOLD) {
    en.vx[i] = 0;
    en.vy[i] = 0;
    if (tick >= b.modeEnd[k]) {
      const after = b.after[k];
      b.after[k] = MOVE;
      if (after === LEAP) {
        // hop onto the slam so it lands at impact
        b.mode[k] = LEAP;
        b.modeEnd[k] = tick + LEAP_TICKS;
        b.mvx[k] = ((b.tx[k] - en.x[i]) * 60) / LEAP_TICKS;
        b.mvy[k] = ((b.ty[k] - en.y[i]) * 60) / LEAP_TICKS;
        en.touchCd[i] = 45; // no contact hit stacked on the slam it just landed
      } else if (after === CHARGE) {
        b.mode[k] = CHARGE;
        b.modeEnd[k] = tick + b.chargeTicks[k];
        const cd = b.chargeTicks[k] + 12; // the lane already hit; no contact stacked on it
        en.touchCd[i] = cd > 255 ? 255 : cd;
      } else b.mode[k] = MOVE;
    }
    return;
  }
  if (mode === LEAP || mode === CHARGE) {
    en.vx[i] = b.mvx[k];
    en.vy[i] = b.mvy[k];
    if (tick >= b.modeEnd[k]) b.mode[k] = MOVE;
    return;
  }

  // MOVE: keep the preferred distance, orbit a little
  const dx = p.x - en.x[i];
  const dy = p.y - en.y[i];
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / d;
  const uy = dy / d;
  const sp = def.speed * (1 + 0.2 * (enr - 1)) * en.slow[i];
  const keep = KEEP[k];
  let radial = 1;
  if (keep > 0) radial = d > keep + 1 ? 1 : d < keep - 1 ? -0.8 : 0;
  const orbit = keep > 0 ? (k & 1 ? 0.7 : -0.7) : 0;
  en.vx[i] = (ux * radial - uy * orbit) * sp;
  en.vy[i] = (uy * radial + ux * orbit) * sp;

  if (tick >= b.next[k] && !w.over) {
    const pats = def.patterns;
    const pat = pats[b.step[k] % pats.length];
    b.step[k]++;
    if (pat === 'slam') patSlam(w, k, i, enr);
    else if (pat === 'spores') patSpores(w, i, enr);
    else if (pat === 'charge') patCharge(w, k, i);
    else patBeam(w, k, i);
    // the Anvil King adds a slam to every other volley once enraged
    if (k === 4 && enr >= 1.5 && pat !== 'slam' && (b.step[k] & 1) === 0) patSlamAt(w, k, i, p.x, p.y, 2.4, 1.6, false);
    b.next[k] = tick + secToTicks(VOLLEY[k] / enr);
  }
}

function windMul(w: World): number {
  return w.layer >= 6 ? 0.75 : 1;
}

function patSlamAt(w: World, k: number, i: number, x: number, y: number, r: number, wind: number, leap: boolean): number {
  const lim = w.arenaR - 0.5;
  const r2 = x * x + y * y;
  if (r2 > lim * lim) {
    const s = lim / Math.sqrt(r2);
    x *= s;
    y *= s;
  }
  const tgi = addTelegraphCat(w, TG_SHAPE.CIRCLE, TG_COLOR.RED, x, y, r, wind * windMul(w), bossPct(0.12), TGF.BOSS, i, TGC.BOSS, 0);
  if (tgi >= 0 && leap) {
    const b = w.boss;
    b.mode[k] = HOLD;
    b.after[k] = LEAP;
    b.modeEnd[k] = w.tg.impact[tgi] - LEAP_TICKS;
    b.tx[k] = x;
    b.ty[k] = y;
  }
  return tgi;
}

function patSlam(w: World, k: number, i: number, enr: number): void {
  const p = w.player;
  // aim where you are heading (0.35 s lead), so standing still is not the only way to get hit
  const x = p.x + p.vx * 0.35;
  const y = p.y + p.vy * 0.35;
  const r = k === 4 ? 3.0 : 2.6;
  patSlamAt(w, k, i, x, y, r, 1.3, true);
  if (enr >= 2) {
    // enraged: an aftershock ring around the landing point
    const t2 = addTelegraphCat(w, TG_SHAPE.RING, TG_COLOR.RED, x, y, r + 2.6, 1.9 * windMul(w), bossPct(0.1), TGF.BOSS, i, TGC.BOSS, 0);
    if (t2 >= 0) w.tg.arc[t2] = r + 0.6;
  }
}

function patSpores(w: World, i: number, enr: number): void {
  const p = w.player;
  const rng = w.rng.boss;
  const n = 3 + (enr >= 1.6 ? 1 : 0) + (enr >= 2.2 ? 1 : 0);
  const base = rng.angleIdx();
  for (let s = 0; s < n; s++) {
    let x: number;
    let y: number;
    if (s === 0) {
      x = p.x + p.vx * 0.4;
      y = p.y + p.vy * 0.4;
    } else {
      const a = base + (s * 4096) / (n - 1);
      const d = 2.6 + 1.4 * rng.next();
      x = p.x + cosIdx(a) * d;
      y = p.y + sinIdx(a) * d;
    }
    addTelegraphCat(w, TG_SHAPE.CIRCLE, TG_COLOR.RED, x, y, 1.6, 1.25 * windMul(w), bossPct(0.06), TGF.BOSS | TGF.LINGER_HURTS, i, TGC.BOSS, 4);
  }
}

/** Distance from (x, y) along unit (ux, uy) to the arena wall (radius R). */
function toWall(x: number, y: number, ux: number, uy: number, R: number): number {
  const pu = x * ux + y * uy;
  const c = x * x + y * y - R * R;
  const disc = pu * pu - c;
  if (disc <= 0) return 0;
  const t = -pu + Math.sqrt(disc);
  return t > 0 ? t : 0;
}

function patCharge(w: World, k: number, i: number): void {
  const en = w.en;
  const p = w.player;
  const b = w.boss;
  const dx = p.x - en.x[i];
  const dy = p.y - en.y[i];
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / d;
  const uy = dy / d;
  const R = w.arenaR - en.r[i] - 0.3;
  let len = toWall(en.x[i], en.y[i], ux, uy, R);
  if (len > 30) len = 30;
  if (len < 4) len = 4;
  const ex = en.x[i] + ux * len;
  const ey = en.y[i] + uy * len;
  const tgi = addTelegraphCat(w, TG_SHAPE.LANE, TG_COLOR.RED, en.x[i], en.y[i], 1.3, 1.4 * windMul(w), bossPct(0.16), TGF.BOSS, i, TGC.BOSS, 0);
  if (tgi < 0) return;
  w.tg.x2[tgi] = ex;
  w.tg.y2[tgi] = ey;
  // hold during the wind-up, then sprint the lane
  b.mode[k] = HOLD;
  b.after[k] = CHARGE;
  b.modeEnd[k] = w.tg.impact[tgi];
  b.mvx[k] = ux * CHARGE_SPEED;
  b.mvy[k] = uy * CHARGE_SPEED;
  b.chargeTicks[k] = Math.max(1, Math.round((len / CHARGE_SPEED) * 60));
}

function patBeam(w: World, k: number, i: number): void {
  const en = w.en;
  const p = w.player;
  const b = w.boss;
  const dx = p.x - en.x[i];
  const dy = p.y - en.y[i];
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  const R = w.arenaR;
  // three beams: at you, and +-40 degrees (455 table steps)
  for (let s = -1; s <= 1; s++) {
    const ca = cosIdx(s * 455);
    const sa = sinIdx(s * 455);
    const ux = (dx / d) * ca - (dy / d) * sa;
    const uy = (dx / d) * sa + (dy / d) * ca;
    const l1 = toWall(en.x[i], en.y[i], ux, uy, R);
    const hx = en.x[i] + ux * l1;
    const hy = en.y[i] + uy * l1;
    const t1 = addTelegraphCat(w, TG_SHAPE.LANE, TG_COLOR.RED, en.x[i], en.y[i], 0.8, 1.5 * windMul(w), bossPct(0.13), TGF.BOSS, i, TGC.BOSS, 0);
    if (t1 < 0) continue;
    w.tg.x2[t1] = hx;
    w.tg.y2[t1] = hy;
    // reflect off the wall: u' = u - 2 (u.n) n, n = H / |H|
    const hl = Math.sqrt(hx * hx + hy * hy) || 1;
    const nx = hx / hl;
    const ny = hy / hl;
    const un = ux * nx + uy * ny;
    const rx = ux - 2 * un * nx;
    const ry = uy - 2 * un * ny;
    const sx = hx - nx * 0.05;
    const sy = hy - ny * 0.05;
    let l2 = toWall(sx, sy, rx, ry, R);
    if (l2 > 16) l2 = 16;
    const t2 = addTelegraphCat(w, TG_SHAPE.LANE, TG_COLOR.RED, sx, sy, 0.8, 1.5 * windMul(w), bossPct(0.13), TGF.BOSS, i, TGC.BOSS, 0);
    if (t2 >= 0) {
      w.tg.x2[t2] = sx + rx * l2;
      w.tg.y2[t2] = sy + ry * l2;
      w.tg.impact[t2] = w.tg.impact[t1]; // the reflection lands with its beam
    }
  }
  b.mode[k] = HOLD;
  b.after[k] = MOVE;
  b.modeEnd[k] = w.tick + secToTicks(1.5 * windMul(w)) + 6;
}

// ---------------------------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------------------------

/** Called by damage.killEnemy for an enemy with EF.BOSS, before it is released. */
export function onBossKilled(w: World, i: number): void {
  const b = w.boss;
  let k = w.en.def[i];
  if (k < 0 || k >= NB) k = 0;
  w.score.bossesKilled++;
  w.events.push(EV.BOSS_KILL, w.tick, i, k, k + 1, w.en.x[i], w.en.y[i], (w.tick - b.spawnTick[k]) * DT);
  if (b.slot[k] === i) b.slot[k] = -1;
  if (b.active === i) b.active = -1;
  cancelTelegraphsOf(w, i);
  addXpLevels(w, BAL.bossXP);
  // QA (non-gamer pacing): a boss kill restores a quarter of max HP, paid out inside the heal cap
  queueHeal(w, BOSS_KILL_HEAL * w.player.maxHp);
  queueOffer(w, OK.TALENT);
  b.chests++;
  w.events.push(EV.CHEST, w.tick, 0, k, 0, w.en.x[i], w.en.y[i]);
  b.relicChoices = 3;
  queueOffer(w, OK.DOOR);
}

/**
 * The chest's Elite door (BUILD calls this when the player takes it): a guardian with 40 x hpU HP
 * appears 7 m away; kill it within 20 s for a 4-relic pick plus a Forge.
 */
export function startEliteDoor(w: World): void {
  const b = w.boss;
  if (b.eliteSlot >= 0 && w.en.alive[b.eliteSlot] && w.en.uid[b.eliteSlot] === b.eliteUid) return;
  const p = w.player;
  const a = w.rng.boss.angleIdx();
  const lim = w.arenaR - 2;
  let x = p.x + cosIdx(a) * 7;
  let y = p.y + sinIdx(a) * 7;
  if (x * x + y * y > lim * lim) {
    x = p.x - cosIdx(a) * 7;
    y = p.y - sinIdx(a) * 7;
  }
  const i = spawnEnemy(w, EN.ELITE, x, y, EF.ELITE | EF.NO_KNOCKBACK);
  if (i < 0) return;
  b.eliteSlot = i;
  b.eliteUid = w.en.uid[i];
  b.eliteEndTick = w.tick + secToTicks(BAL.eliteDoorT);
  w.events.push(EV.CHEST, w.tick, 1, 0, 0, x, y, BAL.eliteDoorT);
}

/** enemies.releaseEnemy reports the guardian leaving: killed (reward) or escaped (timeout). */
export function onEliteReleased(w: World, killed: boolean): void {
  const b = w.boss;
  b.eliteSlot = -1;
  const p = w.player;
  if (killed) {
    b.elitesCleared++;
    b.relicChoices = 4;
    w.events.push(EV.CHEST, w.tick, 2, 0, 0, p.x, p.y);
    forge(w); // BUILD's Forge: +1 rank to two owned spells
    queueOffer(w, OK.RELIC);
  } else {
    w.events.push(EV.CHEST, w.tick, 3, 0, 0, p.x, p.y);
  }
}

/** dealDamage multiplies by (1 + might); mirrored shares divide it back out (guarded). */
export function mightDiv(w: World): number {
  const m = 1 + w.stats.might;
  return m > 0.05 ? m : 0.05;
}
