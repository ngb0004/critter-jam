/**
 * Player movement, HP, dash, healing through the heal cap (COMBAT), spec 4.1, 7.2, 7.3.
 *
 * - Movement: quantised 64-direction input, accelerates toward the target velocity (snappy but not
 *   instant), stops with a short slide. The arena is a disc; the player is clamped inside it.
 * - Hurtbox: 70% of the visual radius (WORLD.playerHurtFrac), used by enemies.ts and hazards.ts.
 * - Dash: tap / Space. 3 m in 0.15 s, 6 s cooldown per charge, 0.25 s immunity to BURSTS only
 *   (never Wyrmfall breath or rocks, never contact).
 * - HP: maxHP = 100 x stats.maxHpMul x mods.maxHpMul. DR = A / (A + K0 + 10m), cap 75%; bursts take
 *   half of DR; TRUE damage ignores DR.
 * - Healing: EVERY heal goes through healPlayer, which enforces stats.healCap x maxHp per second as a
 *   strict per-tick budget (so any 1 s window heals at most 1.5% + one tick of rounding). Amounts over
 *   the budget are not stored; they are added to `healOverflow` (Lightburn reads and clears it).
 *   queueHeal() spreads a lump heal (heal orb, Mend) over time inside the same budget.
 *
 * Stable fields read by RENDER/UI: x, y, vx, vy, facing, moving, hp, maxHp, dashTicks, dashCd,
 * dashCharges, hurtFlash, burstImmune, lastHurtCause, lastHurtTick.
 */
import { BAL, DT, TICK_HZ, WORLD, secToTicks } from '../core/constants';
import { EV } from '../core/events';
import { DIR_X, DIR_Y } from '../core/fmath';
import type { InputFrame } from '../core/types';
import { DEATH, IN_DASH, IN_DIR_MASK, IN_MOVE } from '../core/types';
import type { World } from '../core/world';
import { onDash } from './build';

/** Movement feel. */
export const MOVE = {
  accel: 48, // m/s^2 toward the target velocity (full speed in ~0.11 s)
  decel: 60, // m/s^2 when the stick is released
  turnBoost: 1.6, // extra accel when reversing (keeps dodges crisp)
} as const;

/** Hard backstop for the 14:32 bound (spec 7.4): nothing survives this tick. */
export const BOUND_SECONDS = 872;

export interface PlayerState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number; // 0..63
  moving: boolean;
  hp: number;
  maxHp: number;
  /** Highest max HP this run (max-HP gains above it queue a capped heal). */
  maxHpPeak: number;
  dashCd: number; // ticks until a charge comes back
  dashCharges: number;
  dashTicks: number; // > 0 while dashing
  dashDir: number;
  burstImmune: number; // ticks of burst-only immunity left
  hurtFlash: number; // ticks, renderer
  /** Heal budget left in the current tick, and which tick it belongs to. */
  healLeft: number;
  healWindowTick: number;
  /** Lump heals waiting to be applied inside the cap (heal orbs, Mend). */
  healPending: number;
  /** Healing requested above the cap since BUILD last cleared it (Lightburn converts it). */
  healOverflow: number;
  /** Total healed this run (telemetry, tests). */
  healedTotal: number;
  /** Healing since the last HEAL event (one event per second, not per tick). */
  healAcc: number;
  /** DEATH.* of the last damage taken and its tick (results screen: "Overrun at 8:12"). */
  lastHurtCause: number;
  lastHurtTick: number;
  /** Damage taken this run by cause, indexed by DEATH.* (results breakdown). */
  dmgByCause: Float64Array;
  /** Tick of the last dash start (hazards: formation breaks). */
  lastDashTick: number;
}

export function createPlayerState(): PlayerState {
  return {
    x: 0, y: 0, vx: 0, vy: 0, facing: 48, moving: false, hp: 100, maxHp: 100, maxHpPeak: 100,
    dashCd: 0, dashCharges: 1, dashTicks: 0, dashDir: 0, burstImmune: 0, hurtFlash: 0,
    healLeft: 0, healWindowTick: -1, healPending: 0, healOverflow: 0, healedTotal: 0, healAcc: 0,
    lastHurtCause: DEATH.NONE, lastHurtTick: 0, dmgByCause: new Float64Array(5), lastDashTick: -100000,
  };
}

export function initPlayer(w: World): void {
  const p = w.player;
  p.maxHp = BAL.baseMaxHp * w.stats.maxHpMul * w.mods.maxHpMul;
  p.maxHpPeak = p.maxHp;
  p.hp = p.maxHp;
  p.dashCharges = w.stats.dashCharges;
}

/**
 * Call after stats change (build.recomputeStats calls this). A max-HP gain (Vitality) is paid out as
 * a queued heal INSIDE the heal cap, so stacking max HP can never heal past 1.5%/s (spec 7.3 lint).
 * Only an actual increase over the run's highest max HP so far queues HP (stat flicker does not).
 */
export function refreshMaxHp(w: World): void {
  const p = w.player;
  const next = BAL.baseMaxHp * w.stats.maxHpMul * w.mods.maxHpMul;
  if (next > p.maxHpPeak) {
    if (w.tick > 0) queueHeal(w, next - p.maxHpPeak);
    else p.hp += next - p.maxHp;
    p.maxHpPeak = next;
  }
  p.maxHp = next;
  if (p.hp > p.maxHp) p.hp = p.maxHp;
}

export function updatePlayer(w: World, input: InputFrame): void {
  const p = w.player;
  const dir = input & IN_DIR_MASK;
  p.moving = (input & IN_MOVE) !== 0;
  if (p.hurtFlash > 0) p.hurtFlash--;
  if (p.burstImmune > 0) p.burstImmune--;

  // dash charges (Iron Lung etc. may raise stats.dashCharges)
  const maxCharges = w.stats.dashCharges;
  if (p.dashCharges > maxCharges) p.dashCharges = maxCharges;
  if (p.dashCharges < maxCharges) {
    if (p.dashCd > 0) p.dashCd--;
    if (p.dashCd <= 0) {
      p.dashCharges++;
      p.dashCd = p.dashCharges < maxCharges ? secToTicks(WORLD.dashCooldown) : 0;
    }
  }
  if ((input & IN_DASH) !== 0 && p.dashTicks === 0 && p.dashCharges > 0) {
    p.dashCharges--;
    if (p.dashCd <= 0) p.dashCd = secToTicks(WORLD.dashCooldown);
    p.dashTicks = WORLD.dashTicks;
    p.dashDir = p.moving ? dir : p.facing;
    p.burstImmune = secToTicks(WORLD.dashBurstImmunity);
    p.lastDashTick = w.tick;
    w.events.push(EV.DASH, w.tick, p.dashDir, 0, 0, p.x, p.y);
    onDash(w);
  }

  const speed = WORLD.playerSpeed * w.stats.moveSpeedMul;
  if (p.dashTicks > 0) {
    p.dashTicks--;
    const ds = (WORLD.dashDist / WORLD.dashTicks) * TICK_HZ;
    p.vx = DIR_X[p.dashDir] * ds;
    p.vy = DIR_Y[p.dashDir] * ds;
    p.facing = p.dashDir;
    if (p.dashTicks === 0) {
      // leave the dash at running speed, not dash speed
      p.vx = DIR_X[p.dashDir] * speed;
      p.vy = DIR_Y[p.dashDir] * speed;
    }
  } else {
    let tx = 0;
    let ty = 0;
    if (p.moving) {
      tx = DIR_X[dir] * speed;
      ty = DIR_Y[dir] * speed;
      p.facing = dir;
    }
    const ex = tx - p.vx;
    const ey = ty - p.vy;
    const err = Math.sqrt(ex * ex + ey * ey);
    if (err > 0) {
      let a = p.moving ? MOVE.accel : MOVE.decel;
      // reversing direction: extra grip so a dodge is not mushy
      if (p.moving && p.vx * tx + p.vy * ty < 0) a *= MOVE.turnBoost;
      const stepV = a * DT;
      if (err <= stepV) {
        p.vx = tx;
        p.vy = ty;
      } else {
        p.vx += (ex / err) * stepV;
        p.vy += (ey / err) * stepV;
      }
    }
  }
  p.x += p.vx * DT;
  p.y += p.vy * DT;
  // stay inside the arena disc; kill the outward velocity component so we slide along the wall
  const R = w.arenaR - WORLD.playerRadius;
  const r2 = p.x * p.x + p.y * p.y;
  if (r2 > R * R) {
    const d = Math.sqrt(r2);
    const nx = p.x / d;
    const ny = p.y / d;
    p.x = nx * R;
    p.y = ny * R;
    const vn = p.vx * nx + p.vy * ny;
    if (vn > 0) {
      p.vx -= vn * nx;
      p.vy -= vn * ny;
    }
  }

  // regen and pending lump heals, all inside the heal cap
  if (w.stats.regenPerSec > 0) healPlayer(w, w.stats.regenPerSec * p.maxHp * DT);
  if (p.healPending > 0) {
    const h = healInternal(w, p.healPending, false);
    p.healPending -= h;
    if (p.hp >= p.maxHp) p.healPending = 0; // nothing to heal: do not bank it
  }

  if (p.healAcc > 0 && w.tick % TICK_HZ === 0) {
    w.events.push(EV.HEAL, w.tick, 0, 0, 0, p.x, p.y, p.healAcc);
    p.healAcc = 0;
  }

  // the 14:32 bound (spec 7.4) is a property of the breath; this is the belt-and-braces backstop
  if (w.tick >= BOUND_SECONDS * TICK_HZ && !w.over) hurtPlayer(w, p.maxHp * 10, HURT.TRUE, DEATH.WYRMFALL);
}

/** Damage-reduction fraction from armor at the current minute (spec 7.2). */
export function armorDR(w: World): number {
  const m = w.tick / (TICK_HZ * 60);
  const a = w.stats.armor;
  if (a <= 0) return 0;
  const dr = a / (a + w.mods.armorK0 + BAL.Km * m);
  return dr > BAL.drCap ? BAL.drCap : dr;
}

/**
 * Damage kinds. CONTACT: full DR. BURST: half DR, dash-immune. TRUE: no DR, never immune (Wyrmfall
 * breath, rocks). BURST_HARD: half DR, NOT dash-immune (telegraphs flagged NO_DASH_IMMUNITY).
 */
export const HURT = { CONTACT: 0, BURST: 1, TRUE: 2, BURST_HARD: 3 } as const;

/**
 * Damage the player. cause: DEATH.* recorded if this kills. Returns damage taken.
 */
export function hurtPlayer(w: World, amount: number, kind: number, cause: number): number {
  const p = w.player;
  if (w.over || amount <= 0) return 0;
  let dmg = amount;
  if (kind === HURT.BURST) {
    if (p.burstImmune > 0) return 0;
    dmg *= 1 - 0.5 * armorDR(w);
  } else if (kind === HURT.BURST_HARD) {
    dmg *= 1 - 0.5 * armorDR(w);
  } else if (kind === HURT.CONTACT) {
    dmg *= 1 - armorDR(w);
  }
  if (dmg <= 0) return 0;
  const c = cause === DEATH.NONE ? DEATH.CHIP : cause;
  p.hp -= dmg;
  // debug-only (?guard=1, never saved or ranked): HP floors at 40% except for the Wyrmfall, so tests can see the late game
  if (c !== DEATH.WYRMFALL && p.hp < p.maxHp * 0.4 && w.mods.tags.has('debug-guard')) p.hp = p.maxHp * 0.4;
  p.dmgByCause[c] += dmg;
  p.lastHurtCause = c;
  p.lastHurtTick = w.tick;
  // breath ticks every frame: do not strobe the hurt flash for it
  if (c !== DEATH.WYRMFALL || kind !== HURT.TRUE || dmg > p.maxHp * 0.02) p.hurtFlash = 8;
  w.events.push(EV.PLAYER_HURT, w.tick, c, kind, 0, p.x, p.y, dmg);
  if (p.hp <= 0) {
    p.hp = 0;
    w.over = true;
    w.deathCause = c;
    w.events.push(EV.DEATH, w.tick, w.deathCause, 0, 0, p.x, p.y, w.tick * DT);
  }
  return dmg;
}

/** The heal cap as a fraction of max HP per second (never above the spec's ceiling of 1.8%/s). */
export function healCapPerSec(w: World): number {
  const c = w.stats.healCap;
  return c < 0 ? 0 : c > 0.018 ? 0.018 : c;
}

function healInternal(w: World, amount: number, countOverflow: boolean): number {
  const p = w.player;
  if (w.over || amount <= 0) return 0;
  if (p.healWindowTick !== w.tick) {
    p.healWindowTick = w.tick;
    p.healLeft = healCapPerSec(w) * p.maxHp * DT;
  }
  let h = amount < p.healLeft ? amount : p.healLeft;
  if (countOverflow && amount > h) p.healOverflow += amount - h;
  if (p.hp + h > p.maxHp) h = p.maxHp - p.hp;
  if (h <= 0) return 0;
  p.hp += h;
  p.healLeft -= h;
  p.healedTotal += h;
  p.healAcc += h;
  return h;
}

/**
 * ALL healing goes through here: at most stats.healCap x maxHp per second, enforced per tick.
 * Returns HP healed now; the excess is lost (and counted in healOverflow for Lightburn).
 */
export function healPlayer(w: World, amount: number): number {
  return healInternal(w, amount, true);
}

/** Queue a lump heal (heal orb, Mend) that is paid out inside the heal cap over the next seconds. */
export function queueHeal(w: World, amount: number): void {
  const p = w.player;
  if (w.over || amount <= 0) return;
  p.healPending += amount;
  if (p.healPending > p.maxHp) p.healPending = p.maxHp;
}
