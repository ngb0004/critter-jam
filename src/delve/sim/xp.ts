/**
 * Gems, XP and leveling (BUILD), spec 6.5.
 *
 *  - Kills drop gems worth en.xp (big values split into a small fountain of gems).
 *  - Gems inside the magnet radius (1.6 m x Magnet) fly to the player, accelerating; collected on contact.
 *  - In the Core, resting gems decay after mods.gemDecaySec (8 s; Gold Fever 6 s).
 *  - XP = value x Magnet XP mult (<= 1.3) x Modifiers x 0.7 in the Core.
 *  - xpNext(L) = 16 x 1.07^(L-1) to L20, then x1.03 per level. Each level-up queues a LEVEL offer.
 *  - Tier 4 = chest pickup (queues a DOOR offer), tier 5 = heal orb (value = fraction of max HP, via the heal cap).
 *
 * Stable fields read by UI: level, xp, xpNext. Gem pool fields for RENDER: x, y, tier, value, state, born.
 */
import { BAL, DT, TICK_HZ, WORLD } from '../core/constants';
import { EV } from '../core/events';
import { fpow, sinIdx, cosIdx } from '../core/fmath';
import type { World } from '../core/world';
import { OK, queueOffer } from './offers';
import { healPlayer } from './player';

export interface XpState {
  level: number;
  xp: number;
  xpNext: number;
  /** XP collected / dropped, for routing telemetry. */
  collected: number;
  dropped: number;
  /** Rotating cursor for merging gems when the pool is full. */
  mergeCursor: number;
}

export function createXpState(): XpState {
  return { level: 1, xp: 0, xpNext: xpNeeded(1), collected: 0, dropped: 0, mergeCursor: 0 };
}

/**
 * Onboarding ramp (integrator, feel pass): the spec curve put the first pick at 0:28-0:46 in bot runs, far from
 * spec 6.5's "a pick every ~10 s early". The first four levels are cheaper (first card at ~0:10); from level 5 on
 * the spec curve is unchanged, so this only adds about two early picks.
 */
const XP_RAMP = [5, 8, 11, 14];

/** XP needed to go from level L to L+1. */
export function xpNeeded(L: number): number {
  if (L >= 1 && L <= XP_RAMP.length) return XP_RAMP[L - 1];
  if (L <= BAL.xpFlatL) return BAL.xp0 * fpow(BAL.xpGrowth, L - 1);
  return BAL.xp0 * fpow(BAL.xpGrowth, BAL.xpFlatL - 1) * fpow(BAL.xpGrowth2, L - BAL.xpFlatL);
}

export const tierOf = (v: number): number => (v < 2 ? 0 : v < 6 ? 1 : v < 20 ? 2 : 3);

function placeGem(w: World, x: number, y: number, vx: number, vy: number, value: number, tier: number): number {
  const gm = w.gm;
  const i = gm.alloc();
  if (i < 0) {
    // pool full: fold the value into a resting XP gem (rotating cursor, deterministic)
    if (tier >= 4) return -1;
    for (let k = 0; k < gm.hi; k++) {
      const j = (w.xp.mergeCursor + k) % gm.hi;
      if (gm.alive[j] && gm.tier[j] < 4) {
        gm.value[j] += value;
        gm.tier[j] = tierOf(gm.value[j]);
        w.xp.mergeCursor = j + 1;
        return j;
      }
    }
    return -1;
  }
  gm.x[i] = x;
  gm.y[i] = y;
  gm.vx[i] = vx;
  gm.vy[i] = vy;
  gm.value[i] = value;
  gm.tier[i] = tier;
  gm.born[i] = w.tick;
  gm.state[i] = 0;
  return i;
}

/** Drop a gem worth `value` XP at (x, y). Values above 8 burst into a small fountain (up to 5 gems). */
export function dropGem(w: World, x: number, y: number, value: number): void {
  w.xp.dropped += value;
  if (value > 8) {
    const n = value > 40 ? 5 : value > 20 ? 4 : 3;
    fountain(w, x, y, value, n, 3);
    return;
  }
  placeGem(w, x, y, 0, 0, value, tierOf(value));
}

/** A gem fountain (fusion moments, bosses): `n` gems sharing `value`, thrown outward. Counts as dropped. */
export function dropGemFountain(w: World, x: number, y: number, value: number, n: number): void {
  w.xp.dropped += value;
  fountain(w, x, y, value, n, 6);
}

function fountain(w: World, x: number, y: number, value: number, n: number, speed: number): void {
  const each = value / n;
  const tier = tierOf(each);
  const a0 = (w.tick * 977) & 4095; // deterministic, no RNG stream consumed
  for (let k = 0; k < n; k++) {
    const a = (a0 + ((4096 * k) / n) | 0) & 4095;
    const s = speed * (0.7 + 0.3 * ((k * 5) % 3));
    placeGem(w, x, y, cosIdx(a) * s, sinIdx(a) * s, each, tier);
  }
}

/** Drop a chest (tier 4) or heal orb (tier 5, value = fraction of max HP). */
export function dropPickup(w: World, x: number, y: number, tier: 4 | 5, value: number): number {
  return placeGem(w, x, y, 0, 0, value, tier);
}

/** Add XP from a pickup (applies Magnet XP multiplier, Omen/Twist, Core squeeze). */
export function addXp(w: World, amount: number): void {
  const core = w.layer >= 6 ? BAL.xpCore : 1;
  gainRaw(w, amount * w.stats.xpMul * w.mods.xpMul * core);
}

/** Add a fraction of the current level's requirement (boss rewards). */
export function addXpLevels(w: World, levels: number): void {
  gainRaw(w, levels * w.xp.xpNext);
}

function gainRaw(w: World, amount: number): void {
  const s = w.xp;
  s.xp += amount;
  while (s.xp >= s.xpNext) {
    s.xp -= s.xpNext;
    s.level++;
    s.xpNext = xpNeeded(s.level);
    w.events.push(EV.LEVEL_UP, w.tick, s.level, 0, 0, w.player.x, w.player.y);
    queueOffer(w, OK.LEVEL);
  }
}

/** Magnet radius at Magnet 0 (m). A touch above WORLD.gemPickupRadius: phone players cannot weave onto every gem. */
const PICKUP_BASE = 2.6; // QA: 2.2 starved cautious players of their first card
/** The lantern's glow: resting gems within this range creep toward the player (m, m/s). */
const GLOW_R = 6;
const GLOW_SPEED = 1.8;
const PULL0 = 7; // m/s when a gem starts flying
const PULL_ACC = 40; // m/s^2
const PULL_MAX = 26;

export function updateGems(w: World): void {
  const gm = w.gm;
  const p = w.player;
  const pick = (PICKUP_BASE > WORLD.gemPickupRadius ? PICKUP_BASE : WORLD.gemPickupRadius) * w.stats.magnetMul;
  const glow = GLOW_R * w.stats.magnetMul;
  const glow2 = glow * glow;
  const pick2 = pick * pick;
  const col = WORLD.gemCollectRadius;
  const col2 = col * col;
  const decay = w.layer >= 6 ? Math.round(w.mods.gemDecaySec * TICK_HZ) : 0;
  const R = w.arenaR - 0.5;
  for (let i = 0; i < gm.hi; i++) {
    if (!gm.alive[i]) continue;
    let dx = p.x - gm.x[i];
    let dy = p.y - gm.y[i];
    let d2 = dx * dx + dy * dy;
    if (gm.state[i] === 0) {
      // fountain slide with friction, kept inside the arena
      if (gm.vx[i] !== 0 || gm.vy[i] !== 0) {
        gm.x[i] += gm.vx[i] * DT;
        gm.y[i] += gm.vy[i] * DT;
        gm.vx[i] *= 0.9;
        gm.vy[i] *= 0.9;
        if (gm.vx[i] * gm.vx[i] + gm.vy[i] * gm.vy[i] < 0.01) {
          gm.vx[i] = 0;
          gm.vy[i] = 0;
        }
        const r2 = gm.x[i] * gm.x[i] + gm.y[i] * gm.y[i];
        if (r2 > R * R) {
          const k = R / Math.sqrt(r2);
          gm.x[i] *= k;
          gm.y[i] *= k;
        }
        dx = p.x - gm.x[i];
        dy = p.y - gm.y[i];
        d2 = dx * dx + dy * dy;
      }
      const young = w.tick - gm.born[i] < 12; // fountain gems fly out before they can be pulled
      if (d2 < glow2 && d2 >= pick2 && !young && gm.vx[i] === 0 && gm.vy[i] === 0) {
        const d = Math.sqrt(d2);
        gm.x[i] += (dx / d) * GLOW_SPEED * DT;
        gm.y[i] += (dy / d) * GLOW_SPEED * DT;
      }
      if (d2 < pick2 && !young) {
        gm.state[i] = 1;
        gm.born[i] = w.tick; // flying since
      } else if (decay > 0 && gm.tier[i] < 4 && w.tick - gm.born[i] > decay) {
        gm.release(i);
        continue;
      }
    }
    if (gm.state[i] === 1) {
      const d = Math.sqrt(d2) || 1;
      let sp = PULL0 + PULL_ACC * (w.tick - gm.born[i]) * DT;
      if (sp > PULL_MAX) sp = PULL_MAX;
      const step = sp * DT;
      if (d2 < col2 || step >= d) {
        collect(w, i);
        continue;
      }
      gm.vx[i] = (dx / d) * sp;
      gm.vy[i] = (dy / d) * sp;
      gm.x[i] += gm.vx[i] * DT;
      gm.y[i] += gm.vy[i] * DT;
    }
  }
}

function collect(w: World, i: number): void {
  const gm = w.gm;
  const tier = gm.tier[i];
  const v = gm.value[i];
  w.events.push(EV.GEM_PICKUP, w.tick, i, tier, 0, gm.x[i], gm.y[i], v);
  gm.release(i);
  if (tier === 4) queueOffer(w, OK.DOOR);
  else if (tier === 5) healPlayer(w, v * w.player.maxHp);
  else {
    w.xp.collected += v;
    addXp(w, v);
  }
}
