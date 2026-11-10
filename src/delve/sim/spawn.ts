/**
 * Pressure curves, trash spawning, the render cap queue, Clumps and formations (COMBAT), spec 7.1.
 *
 * - n(t) = 1.6 e^(0.20 L_d) e^(0.08 c) units/s (x Omen), hpU and contact damage per spec 7.1, with
 *   the Core-entry HP step ramped 1.0 -> 1.5 over 5:20-6:20.
 * - Kinds come from the layer's weighted mix (content/layers.ts). Every spawn draws exactly three
 *   numbers from w.rng.spawn (kind, angle, distance), so the stream stays aligned for everyone.
 *   Bats arrive in packs that share an anchor (a swarm).
 * - Render cap: at most 400 trash bodies. Excess spawns queue (<= 200 units); when room frees up,
 *   5 queued units come back as one Clump (5x HP, 5x XP); fewer than 5 come back singly.
 * - Formations from 6:00, every 20-30 s on a DAY-seeded schedule (identical for every player): a ring
 *   that closes in on where you stood, or a wall that sweeps across. A violet marker shows 1 s first.
 *
 * Stable fields read by UI/RENDER/BOT: trashAlive, queued, clumps, formationUntil, nextFormationTick.
 */
import { BAL, CAP, DT, TICK_HZ, secToTicks } from '../core/constants';
import { EV } from '../core/events';
import { cosIdx, fexp, sinIdx } from '../core/fmath';
import { deriveRng, type Rng } from '../core/rng';
import type { World } from '../core/world';
import { EF, TG_COLOR, TG_SHAPE } from '../core/types';
import { EN, ENEMY_IDX } from '../content/enemies';
import { LAYERS } from '../content/layers';
import { releaseEnemy, spawnEnemy } from './enemies';
import { addTelegraphCat, TGC } from './hazards';

/**
 * Bodies per spec "unit": each unit of n(t) arrives as BODY_SPLIT bodies with 1/BODY_SPLIT of the HP
 * and XP (mass and XP flow match spec 7.1; the horde just looks like a horde). Contact damage per body
 * is scaled by BODY_DMG so a crowd of half-size bodies does not double the chip.
 */
export const BODY_SPLIT = 2;
export const BODY_DMG = 0.65;
const SPAWN_RING_MIN = 14.5;
const SPAWN_RING_MAX = 17.5;
const MAX_FORMATIONS = 4;
/** Ring formation geometry. */
const RING_R = 9;
const RING_N = 24;
/** Wall formation geometry. */
const WALL_N = 20;
const WALL_GAP = 0.85;
const WALL_DIST = 11;
const WALL_SPEED = 3.2;

/** Precomputed layer mixes (numeric defs and cumulative weights). */
interface Mix {
  defs: Int16Array;
  cum: Float64Array;
  total: number;
}
const MIXES: Mix[] = LAYERS.map((l) => {
  const defs = new Int16Array(l.enemies.length);
  const cum = new Float64Array(l.enemies.length);
  let t = 0;
  l.enemies.forEach(([id, wt], k) => {
    defs[k] = ENEMY_IDX.get(id) ?? 0;
    t += wt;
    cum[k] = t;
  });
  return { defs, cum, total: t };
});

export interface SpawnState {
  acc: number; // fractional spawns owed
  queued: number; // units waiting for room under the render cap
  trashAlive: number;
  /** Units dropped because the queue was full (telemetry). */
  dropped: number;
  clumps: number;
  spawned: number;
  /** Slot cursor for in-place Clump merges. */
  mergeCursor: number;
  /** Splitting rule active (Omen tag 'splitting'). */
  splitting: boolean;
  // bat packs
  packLeft: number;
  packAx: number; // anchor offset from the player
  packAy: number;
  packTick: number;
  // formations (day-seeded schedule)
  formRng: Rng;
  nextFormationTick: number;
  pendingKind: number; // -1 none, 0 ring, 1 wall
  pendingTick: number;
  pendingX: number;
  pendingY: number;
  pendingUx: number;
  pendingUy: number;
  pendingDef: number;
  /** Tick until which a formation is on the field (HUD / N_safe hint). */
  formationUntil: number;
  formations: number;
  fActive: Uint8Array;
  fKind: Uint8Array;
  fCx: Float64Array;
  fCy: Float64Array;
  fUx: Float64Array;
  fUy: Float64Array;
  fRelease: Int32Array;
}

export function createSpawnState(w: World): SpawnState {
  return {
    acc: 0, queued: 0, trashAlive: 0, dropped: 0, clumps: 0, spawned: 0, mergeCursor: 0,
    splitting: w.mods.tags.has('splitting'),
    packLeft: 0, packAx: 0, packAy: 0, packTick: -1000,
    formRng: deriveRng(w.cfg.daySeed >>> 0, 0xf0, 0x4d),
    nextFormationTick: secToTicks(BAL.formT),
    pendingKind: -1, pendingTick: 0, pendingX: 0, pendingY: 0, pendingUx: 1, pendingUy: 0, pendingDef: EN.BEETLE,
    formationUntil: 0, formations: 0,
    fActive: new Uint8Array(MAX_FORMATIONS), fKind: new Uint8Array(MAX_FORMATIONS),
    fCx: new Float64Array(MAX_FORMATIONS), fCy: new Float64Array(MAX_FORMATIONS),
    fUx: new Float64Array(MAX_FORMATIONS), fUy: new Float64Array(MAX_FORMATIONS),
    fRelease: new Int32Array(MAX_FORMATIONS),
  };
}

/** Minutes split into Descent (capped at 5) and Core minutes. Writes into the module scratch. */
let LD = 0;
let CM = 0;
function split(w: World): void {
  const m = (w.tick * DT) / 60;
  LD = m < 5 ? m : 5;
  CM = m > 5 ? m - 5 : 0;
}

/** Core-entry HP step, ramped 1.0 -> 1.5 over 5:20-6:20. */
export function coreStep(w: World): number {
  const t = w.tick * DT;
  if (t <= BAL.coreStepT0) return 1;
  if (t >= BAL.coreStepT1) return BAL.coreStep;
  return 1 + ((BAL.coreStep - 1) * (t - BAL.coreStepT0)) / (BAL.coreStepT1 - BAL.coreStepT0);
}

/** Unit HP hpU(t) (spec 7.1), including Omen multipliers. */
export function unitHp(w: World): number {
  split(w);
  return BAL.hp0 * fexp(BAL.hpD * LD) * fexp(BAL.hpC * CM) * coreStep(w) * w.mods.unitHpMul;
}
/** Spawn rate in BODIES/s: n(t) units/s x BODY_SPLIT. */
export function spawnRate(w: World): number {
  split(w);
  return BAL.n0 * fexp(BAL.nD * LD) * fexp(BAL.nC * CM) * w.mods.spawnRateMul * BODY_SPLIT;
}
/** Contact damage per touch (before the per-kind multiplier). */
export function contactDmg(w: World): number {
  split(w);
  return BAL.dmg0 * fexp(BAL.dmgD * LD) * fexp(BAL.dmgC * CM) * w.mods.contactDmgMul;
}

function pickKind(w: World, u: number): number {
  const mix = MIXES[(w.layer < 1 ? 1 : w.layer > 6 ? 6 : w.layer) - 1];
  const roll = u * mix.total;
  for (let k = 0; k < mix.defs.length; k++) if (roll < mix.cum[k]) return mix.defs[k];
  return mix.defs[mix.defs.length - 1];
}

/** A point on the spawn ring around the player, kept inside the arena (tries the far side first). */
let SX = 0;
let SY = 0;
function ringPoint(w: World, a: number, dist: number): void {
  const p = w.player;
  const lim = w.arenaR - 1.2;
  let x = p.x + cosIdx(a) * dist;
  let y = p.y + sinIdx(a) * dist;
  if (x * x + y * y > lim * lim) {
    x = p.x - cosIdx(a) * dist;
    y = p.y - sinIdx(a) * dist;
    if (x * x + y * y > lim * lim) {
      // squeezed against the wall on both sides: rotate a quarter turn, then clamp
      x = p.x + cosIdx(a + 1024) * dist;
      y = p.y + sinIdx(a + 1024) * dist;
      const r2 = x * x + y * y;
      if (r2 > lim * lim) {
        const k = lim / Math.sqrt(r2);
        x *= k;
        y *= k;
      }
    }
  }
  SX = x;
  SY = y;
}

function spawnOne(w: World): void {
  const s = w.spawn;
  const rng = w.rng.spawn;
  const u = rng.next();
  const a = rng.angleIdx();
  const dist = rng.range(SPAWN_RING_MIN, SPAWN_RING_MAX);
  const def = pickKind(w, u);
  const p = w.player;
  if (def === EN.BAT && s.packLeft > 0 && w.tick - s.packTick < 50) {
    // join the current swarm
    s.packLeft--;
    const k = s.packLeft;
    let x = p.x + s.packAx + cosIdx(k * 700) * 0.9;
    let y = p.y + s.packAy + sinIdx(k * 700) * 0.9;
    const lim = w.arenaR - 1.2;
    const r2 = x * x + y * y;
    if (r2 > lim * lim) {
      const kk = lim / Math.sqrt(r2);
      x *= kk;
      y *= kk;
    }
    spawnEnemy(w, def, x, y, 0);
  } else {
    ringPoint(w, a, dist);
    if (def === EN.BAT) {
      s.packLeft = 2 + (a & 1) + (w.mods.densityMul > 1 ? 2 : 0);
      s.packAx = SX - p.x;
      s.packAy = SY - p.y;
      s.packTick = w.tick;
    }
    spawnEnemy(w, def, SX, SY, 0);
  }
  s.spawned++;
}

/** Bring queued units back: 5 at a time as a Clump, otherwise singly. */
function releaseQueue(w: World): void {
  const s = w.spawn;
  let budget = 3;
  while (budget-- > 0 && s.queued > 0 && s.trashAlive < CAP.renderCapTrash) {
    const rng = w.rng.spawn;
    const a = rng.angleIdx();
    const dist = rng.range(SPAWN_RING_MIN, SPAWN_RING_MAX);
    ringPoint(w, a, dist);
    if (s.queued >= BAL.clumpSize) {
      s.queued -= BAL.clumpSize;
      const j = spawnEnemy(w, EN.CLUMP, SX, SY, EF.CLUMP);
      if (j >= 0) {
        w.en.aux1[j] = BAL.clumpSize; // bodies folded into this clump
        s.clumps++;
      }
    } else {
      s.queued--;
      spawnEnemy(w, pickKind(w, rng.next()), SX, SY, 0);
    }
  }
}

export function updateSpawning(w: World): void {
  const s = w.spawn;
  s.acc += spawnRate(w) * DT;
  while (s.acc >= 1) {
    s.acc -= 1;
    if (s.trashAlive >= CAP.renderCapTrash || s.queued > 0) {
      // at the cap (or still draining the queue): queue the unit so mass is never lost
      if (s.queued < BAL.queueCap) s.queued++;
      else s.dropped++;
      continue;
    }
    spawnOne(w);
  }
  if (s.queued > 0) releaseQueue(w);
  if (s.queued >= BAL.clumpSize - 1 && s.trashAlive >= CAP.renderCapTrash) mergeInPlace(w);
  updateFormations(w);
}

/**
 * Field pinned at the cap: fold queued units into the farthest of the next 24 plain bodies (cursor walk,
 * deterministic). A plain body becomes a Clump (itself + 4 queued = 5 bodies' worth); an existing Clump
 * grows by 5 bodies (HP, XP, a little radius). Mass keeps arriving without new draw calls.
 */
function mergeInPlace(w: World): void {
  const s = w.spawn;
  const en = w.en;
  const p = w.player;
  const hi = en.hi;
  if (hi === 0) return;
  let best = -1;
  let bestD = -1;
  for (let n = 0; n < 24; n++) {
    s.mergeCursor = s.mergeCursor + 1 < hi ? s.mergeCursor + 1 : 0;
    const i = s.mergeCursor;
    if (!en.alive[i] || (en.flags[i] & (EF.BOSS | EF.WYRM | EF.ELITE | EF.FORMATION)) !== 0) continue;
    if (en.def[i] === EN.SLIMELET) continue;
    const dx = en.x[i] - p.x;
    const dy = en.y[i] - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > bestD) {
      bestD = d2;
      best = i;
    }
  }
  if (best < 0 || bestD < 36) return;
  const i = best;
  if (en.def[i] === EN.CLUMP) {
    if (s.queued < BAL.clumpSize) return;
    const part = en.maxHp[i] / (en.aux1[i] > 0 ? en.aux1[i] : BAL.clumpSize);
    const parts = en.aux1[i] > 0 ? en.aux1[i] : BAL.clumpSize;
    en.hp[i] += part * BAL.clumpSize;
    en.maxHp[i] += part * BAL.clumpSize;
    en.xp[i] += (en.xp[i] / parts) * BAL.clumpSize;
    en.aux1[i] = parts + BAL.clumpSize;
    if (en.r[i] < 1.4) en.r[i] += 0.05;
    s.queued -= BAL.clumpSize;
    s.clumps++;
    return;
  }
  const x = en.x[i];
  const y = en.y[i];
  const frac = en.hp[i] / (en.maxHp[i] || 1);
  releaseEnemy(w, i); // hp > 0: a despawn, not a kill (no gem, no Splitting)
  const j = spawnEnemy(w, EN.CLUMP, x, y, EF.CLUMP);
  if (j >= 0) {
    // keep the wounds the absorbed body had (1 of the 5 parts)
    en.hp[j] -= (en.maxHp[j] / BAL.clumpSize) * (1 - frac);
    en.aux1[j] = BAL.clumpSize;
    s.queued -= BAL.clumpSize - 1;
    s.clumps++;
  }
}

// ---------------------------------------------------------------------------------------------
// Formations (spec 7.1): from 6:00, every 20-30 s, day-seeded. Ring or wall, violet marker first.
// ---------------------------------------------------------------------------------------------

const FORM_KINDS = [EN.BEETLE, EN.SLIME, EN.BAT] as const;

function updateFormations(w: World): void {
  const s = w.spawn;
  const p = w.player;
  if (w.tick >= s.nextFormationTick) {
    const r = s.formRng;
    // exactly four draws per formation: kind, angle, member kind, gap
    const kind = r.next() < 0.5 ? 0 : 1;
    const a = r.angleIdx();
    const mk = FORM_KINDS[r.int(FORM_KINDS.length)];
    const gap = r.range(BAL.formGapLo, BAL.formGapHi);
    s.nextFormationTick += secToTicks(gap);
    s.pendingKind = kind;
    s.pendingDef = mk;
    s.pendingUx = cosIdx(a);
    s.pendingUy = sinIdx(a);
    let mk2 = -1;
    if (kind === 0) {
      s.pendingX = p.x;
      s.pendingY = p.y;
      mk2 = addTelegraphCat(w, TG_SHAPE.RING, TG_COLOR.VIOLET, p.x, p.y, RING_R + 0.4, 1.0, 0, 0, -1, TGC.FORMATION, 0);
      if (mk2 >= 0) w.tg.arc[mk2] = RING_R - 0.4; // ring inner radius
    } else {
      // wall comes from the -u side, sweeping along +u
      const cx = p.x - s.pendingUx * WALL_DIST;
      const cy = p.y - s.pendingUy * WALL_DIST;
      s.pendingX = cx;
      s.pendingY = cy;
      const half = (WALL_N * WALL_GAP) / 2;
      mk2 = addTelegraphCat(w, TG_SHAPE.LANE, TG_COLOR.VIOLET, cx + s.pendingUy * half, cy - s.pendingUx * half, 0.6, 1.0, 0, 0, -1, TGC.FORMATION, 0);
      if (mk2 >= 0) {
        w.tg.x2[mk2] = cx - s.pendingUy * half;
        w.tg.y2[mk2] = cy + s.pendingUx * half;
      }
    }
    s.pendingTick = mk2 >= 0 ? w.tg.impact[mk2] : w.tick + TICK_HZ;
  }
  if (s.pendingKind >= 0 && w.tick >= s.pendingTick) {
    spawnFormation(w);
    s.pendingKind = -1;
  }
  // retire finished formation slots
  for (let f = 0; f < MAX_FORMATIONS; f++) if (s.fActive[f] && w.tick >= s.fRelease[f] + 2) s.fActive[f] = 0;
}

function spawnFormation(w: World): void {
  const s = w.spawn;
  let f = -1;
  for (let k = 0; k < MAX_FORMATIONS; k++) if (!s.fActive[k]) { f = k; break; }
  if (f < 0) return;
  const kind = s.pendingKind;
  const n = kind === 0 ? RING_N : WALL_N;
  const lim = w.arenaR - 0.8;
  let made = 0;
  for (let k = 0; k < n; k++) {
    if (s.trashAlive >= CAP.renderCapTrash) break;
    let x: number;
    let y: number;
    if (kind === 0) {
      const a = (k * 4096) / n;
      x = s.pendingX + cosIdx(a) * RING_R;
      y = s.pendingY + sinIdx(a) * RING_R;
    } else {
      const off = (k - (n - 1) / 2) * WALL_GAP;
      x = s.pendingX + s.pendingUy * off;
      y = s.pendingY - s.pendingUx * off;
    }
    const r2 = x * x + y * y;
    if (r2 > lim * lim) {
      const kk = lim / Math.sqrt(r2);
      x *= kk;
      y *= kk;
    }
    const i = spawnEnemy(w, s.pendingDef, x, y, EF.FORMATION);
    if (i < 0) break;
    w.en.auxI[i] = f + 1;
    made++;
  }
  if (made === 0) return;
  s.fActive[f] = 1;
  s.fKind[f] = kind;
  s.fCx[f] = s.pendingX;
  s.fCy[f] = s.pendingY;
  s.fUx[f] = s.pendingUx;
  s.fUy[f] = s.pendingUy;
  s.fRelease[f] = w.tick + secToTicks(kind === 0 ? BAL.formLen + 0.5 : 6);
  s.formationUntil = s.fRelease[f];
  s.formations++;
  w.events.push(EV.FORMATION, w.tick, kind, made, 0, s.pendingX, s.pendingY);
}

/** Steer formation member i (called by enemies.ts). Releases it to normal AI when its formation ends. */
export function formationSteer(w: World, i: number): void {
  const s = w.spawn;
  const en = w.en;
  const f = en.auxI[i] - 1;
  if (f < 0 || f >= MAX_FORMATIONS || w.tick >= s.fRelease[f]) {
    en.auxI[i] = 0;
    en.flags[i] &= ~EF.FORMATION;
    // chase from here on
    const dx = w.player.x - en.x[i];
    const dy = w.player.y - en.y[i];
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    en.vx[i] = (dx / d) * en.speed[i] * en.slow[i];
    en.vy[i] = (dy / d) * en.speed[i] * en.slow[i];
    return;
  }
  const sp = en.speed[i] * en.slow[i];
  if (s.fKind[f] === 0) {
    const dx = s.fCx[f] - en.x[i];
    const dy = s.fCy[f] - en.y[i];
    const d = Math.sqrt(dx * dx + dy * dy);
    const k = d > 0.6 ? sp / d : 0;
    en.vx[i] = dx * k;
    en.vy[i] = dy * k;
  } else {
    const ws = WALL_SPEED * en.slow[i];
    en.vx[i] = s.fUx[f] * ws;
    en.vy[i] = s.fUy[f] * ws;
  }
}
