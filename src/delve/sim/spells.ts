/**
 * Spell casting per behaviour (BUILD), spec 4.1 / 7.2. Each slot counts down its cooldown (divided by Haste)
 * and casts by its SpellDef.behavior:
 *
 *   projectile  fan of `count` bolts at the target; pierce; per-projectile hit memory
 *   splash      bolt that bursts on its first enemy (Firebolt); speed 0 = instant strike from above (Thunderclap)
 *   chain       instant arc that jumps `count` times within `radius` (Chain Spark; Plasma Arc runs 2 chains)
 *   orbit       `count` bodies orbiting the player for `duration` (recast replaces them)
 *   aura        pulse around the player (Frost Nova, Flare Nova, Lantern Halo), with a visual ring zone
 *   zone        ground area at the player (Cinder Trail) or the densest cluster (Bile Flask, Fever Bloom)
 *   summon      allies in the `al` pool that hunt on their own (Gloom Wisps)
 *   dot-spread  darts that prefer targets without the status; the status spreads on death (Creeping Rot)
 *
 * Area coverage (spec 7.2): area spells really query the spatial hash, so targets = min(on-screen, pi r^2 rho)
 * falls out of the sim. Radii scale with Area and are capped at 38% of the short screen axis.
 *
 * Stable fields read by RENDER/UI: orbitPhase, fusionNova (-1 or the slot whose shockwave fires next tick).
 * Allies (`al` pool): spell, slot, x, y, vx, vy, life, target. aux0 = damage per bite.
 */
import { BAL, CAP, DT, TICK_HZ, WORLD } from '../core/constants';
import { EV } from '../core/events';
import { fatan2, fcos, fsin, TAU } from '../core/fmath';
import type { World } from '../core/world';
import { EF, SRC } from '../core/types';
import { SPELLS, SPELL_X } from '../content/spells';
import { onCast, onProjectileSpawn, slotScale } from './build';
import { dealDamage, DMG } from './damage';
import { knockback } from './enemies';
import { healPlayer } from './player';
import { PK, PR_HIT_MEM, spawnProjectile } from './projectiles';
import { createProcQueue, flushProcs, type ProcQueue } from './rules';
import { applyStatus, createStatusState, type StatusState } from './statuses';
import { spawnZone } from './zones';

export interface SpellState {
  /** Shared orbit clock (seconds) so orbit bodies stay evenly spaced. */
  orbitPhase: number;
  /** Deferred procs (rules.ts). */
  procs: ProcQueue;
  /** Status spread bookkeeping (statuses.ts). */
  status: StatusState;
  /** Per-projectile hit memory: uids of enemies hit, [i * PR_HIT_MEM + k]. */
  prHit: Int32Array;
  prHitN: Uint8Array;
  /** Scratch query buffers (each used by exactly one nesting level). */
  qSplash: Int32Array;
  qChain: Int32Array;
  qDense: Int32Array;
  qDense2: Int32Array;
  qProc: Int32Array;
  /** Enemies already struck by the current chain cast. */
  chainSeen: Int32Array;
  chainSeenN: number;
  /** Overcharge: slot to recast and the tick to do it (0.2 s later, so hit gates have reopened). */
  pendingRecast: number;
  recastTick: number;
  overchargeCount: number;
  /** Slot whose fusion shockwave fires at the start of the next updateSpells, or -1. */
  fusionNova: number;
  /** Highest-HP enemy this tick (Kindled Core), or -1. */
  topHp: number;
}

export function createSpellState(): SpellState {
  return {
    orbitPhase: 0,
    procs: createProcQueue(),
    status: createStatusState(),
    prHit: new Int32Array(CAP.projectiles * PR_HIT_MEM),
    prHitN: new Uint8Array(CAP.projectiles),
    qSplash: new Int32Array(CAP.enemies),
    qChain: new Int32Array(CAP.enemies),
    qDense: new Int32Array(CAP.enemies),
    qDense2: new Int32Array(CAP.enemies),
    qProc: new Int32Array(CAP.enemies),
    chainSeen: new Int32Array(32),
    chainSeenN: 0,
    pendingRecast: -1,
    recastTick: 0,
    overchargeCount: 0,
    fusionNova: -1,
    topHp: -1,
  };
}

/** Spec 7.2: area radius never exceeds 38% of the short screen axis. */
export const RADIUS_CAP = BAL.radiusCapFrac * WORLD.screenShort;
const TARGET_RANGE = 11;
const NOVA_R = 6.8;

/** Per-hit damage for a slot: def.damage x fit x R(rank) (x fusionMult). Buckets are applied by dealDamage. */
export function slotDamage(w: World, slot: number): number {
  const si = w.build.slotSpell[slot];
  if (si < 0) return 0;
  return SPELLS[si].damage * slotScale(w, slot);
}

/** Radius after Area (and Searing Wake for area kinds), capped. */
export function areaRadius(w: World, base: number, areaKind: boolean): number {
  let r = base * w.stats.areaMul;
  if (areaKind && w.build.rules.searingWake) r *= 1.2;
  return r > RADIUS_CAP ? RADIUS_CAP : r;
}

/** Nearest live enemy to (x, y) within maxR, or -1. Linear scan (casts are rare). */
export function nearestEnemy(w: World, x: number, y: number, maxR: number): number {
  const en = w.en;
  let best = -1;
  let bestD = maxR * maxR;
  for (let i = 0; i < en.hi; i++) {
    if (!en.alive[i]) continue;
    const dx = en.x[i] - x;
    const dy = en.y[i] - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function strongestEnemy(w: World, x: number, y: number, maxR: number): number {
  const en = w.en;
  let best = -1;
  let bestHp = -1;
  const r2 = maxR * maxR;
  for (let i = 0; i < en.hi; i++) {
    if (!en.alive[i]) continue;
    const dx = en.x[i] - x;
    const dy = en.y[i] - y;
    if (dx * dx + dy * dy > r2) continue;
    if (en.hp[i] > bestHp) {
      bestHp = en.hp[i];
      best = i;
    }
  }
  return best;
}

/**
 * Densest cluster: sample up to 24 enemies near the player and count neighbours within r of each
 * (grid queries). Optionally ignores candidates within exR of (exX, exY). Returns an enemy slot or -1.
 */
export function densestEnemy(w: World, r: number, exX = 0, exY = 0, exR = 0): number {
  const en = w.en;
  const p = w.player;
  const sp = w.spells;
  const n = w.grid.queryCircle(p.x, p.y, TARGET_RANGE, sp.qDense);
  if (n === 0) return -1;
  const stride = n > 24 ? Math.ceil(n / 24) : 1;
  const tr2 = TARGET_RANGE * TARGET_RANGE;
  const ex2 = exR * exR;
  const r2 = r * r;
  let best = -1;
  let bestScore = -1;
  for (let k = 0; k < n; k += stride) {
    const c = sp.qDense[k];
    if (!en.alive[c]) continue;
    const cx = en.x[c];
    const cy = en.y[c];
    const pdx = cx - p.x;
    const pdy = cy - p.y;
    const pd = pdx * pdx + pdy * pdy;
    if (pd > tr2) continue;
    if (exR > 0) {
      const ex = cx - exX;
      const ey = cy - exY;
      if (ex * ex + ey * ey < ex2) continue;
    }
    const m = w.grid.queryCircle(cx, cy, r, sp.qDense2);
    let cnt = 0;
    for (let j = 0; j < m; j++) {
      const o = sp.qDense2[j];
      if (!en.alive[o]) continue;
      const dx = en.x[o] - cx;
      const dy = en.y[o] - cy;
      if (dx * dx + dy * dy <= r2) cnt++;
    }
    // more neighbours first; nearer to the player breaks ties
    const score = cnt * 1000 - pd;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

function randomEnemyNear(w: World, x: number, y: number, r: number): number {
  const n = w.grid.queryCircle(x, y, r, w.qA);
  if (n === 0) return -1;
  const start = w.rng.combat.int(n);
  for (let k = 0; k < n; k++) {
    const e = w.qA[(start + k) % n];
    if (w.en.alive[e] && (w.en.flags[e] & EF.WYRM) === 0) return e;
  }
  return -1;
}

/** Nearest enemy not in chainSeen within maxR of (x, y), via the grid. */
function nearestUnseen(w: World, x: number, y: number, maxR: number): number {
  const en = w.en;
  const sp = w.spells;
  const n = w.grid.queryCircle(x, y, maxR, sp.qChain);
  let best = -1;
  let bestD = maxR * maxR;
  for (let q = 0; q < n; q++) {
    const e = sp.qChain[q];
    if (!en.alive[e]) continue;
    let seen = false;
    for (let k = 0; k < sp.chainSeenN; k++) if (sp.chainSeen[k] === e) seen = true;
    if (seen) continue;
    const dx = en.x[e] - x;
    const dy = en.y[e] - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

function markSeen(w: World, e: number): void {
  const sp = w.spells;
  if (sp.chainSeenN < sp.chainSeen.length) sp.chainSeen[sp.chainSeenN++] = e;
}

/** dot-spread targeting: nearest enemies, preferring ones without the status (cost +6 m) and not yet picked. */
function freshTarget(w: World, kind: number): number {
  const en = w.en;
  const p = w.player;
  const sp = w.spells;
  let best = -1;
  let bestD = TARGET_RANGE * TARGET_RANGE + 1000;
  const r2 = TARGET_RANGE * TARGET_RANGE;
  for (let i = 0; i < en.hi; i++) {
    if (!en.alive[i]) continue;
    const dx = en.x[i] - p.x;
    const dy = en.y[i] - p.y;
    let d = dx * dx + dy * dy;
    if (d > r2) continue;
    let seen = false;
    for (let k = 0; k < sp.chainSeenN; k++) if (sp.chainSeen[k] === i) seen = true;
    if (seen) continue;
    if (en.stStacks[i * CAP.statuses + kind] > 0) d += 36;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export function updateSpells(w: World): void {
  const b = w.build;
  const sp = w.spells;
  sp.orbitPhase += DT;
  // Kindled Core: the toughest enemy on the field
  if (b.rules.kindledCore) {
    const en = w.en;
    let best = -1;
    let hp = 0;
    for (let i = 0; i < en.hi; i++) {
      if (!en.alive[i] || en.flags[i] & EF.WYRM) continue;
      if (en.hp[i] > hp) {
        hp = en.hp[i];
        best = i;
      }
    }
    sp.topHp = best;
  } else sp.topHp = -1;
  // Mend: 30% over 20 s, through the heal cap
  if (b.mendTicks > 0) {
    b.mendTicks--;
    healPlayer(w, (BAL.mendPct * w.player.maxHp) / (BAL.mendDur * TICK_HZ));
  }
  if (sp.fusionNova >= 0) {
    fusionShockwave(w, sp.fusionNova);
    sp.fusionNova = -1;
  }
  for (let s = 0; s < b.slotSpell.length; s++) {
    const si = b.slotSpell[s];
    if (si < 0) continue;
    if (sp.pendingRecast === s && w.tick >= sp.recastTick) {
      sp.pendingRecast = -1;
      if (cast(w, s)) w.events.push(EV.CAST, w.tick, s, si, 1, w.player.x, w.player.y);
    }
    if (b.slotCd[s] > 0) {
      b.slotCd[s]--;
      continue;
    }
    const def = SPELLS[si];
    if (cast(w, s)) {
      b.slotCasts[s]++;
      b.slotCd[s] = Math.max(6, Math.round((def.cooldown * TICK_HZ) / w.stats.haste));
      w.events.push(EV.CAST, w.tick, s, si, 0, w.player.x, w.player.y);
      const before = sp.pendingRecast;
      onCast(w, s);
      if (sp.pendingRecast >= 0 && before !== sp.pendingRecast) sp.recastTick = w.tick + BAL.hitIntervalTicks;
    } else {
      b.slotCd[s] = 6; // nothing to hit: retry in 0.1 s
    }
  }
  updateAllies(w);
  flushProcs(w);
}

function cast(w: World, s: number): boolean {
  const b = w.build;
  const si = b.slotSpell[s];
  const def = SPELLS[si];
  const X = SPELL_X[si];
  const p = w.player;
  const en = w.en;
  const sp = w.spells;
  const dmg = slotDamage(w, s);
  const scale = slotScale(w, s);
  const st = def.status;
  switch (def.behavior) {
    case 'projectile':
    case 'dot-spread':
    case 'splash': {
      sp.chainSeenN = 0;
      const t = def.target === 'strongest' ? strongestEnemy(w, p.x, p.y, TARGET_RANGE)
        : def.target === 'densest' ? densestEnemy(w, areaRadius(w, def.radius, true))
          : def.target === 'random' ? randomEnemyNear(w, p.x, p.y, TARGET_RANGE)
            : def.behavior === 'dot-spread' && st ? freshTarget(w, st.kind)
              : nearestEnemy(w, p.x, p.y, TARGET_RANGE);
      if (t < 0) return false;
      if (def.speed <= 0) {
        // instant strike from above (Thunderclap): full damage to everything in the radius
        splashAt(w, en.x[t], en.y[t], areaRadius(w, def.radius, true), dmg * X.splashFrac, s, si, -1);
        return true;
      }
      const n = def.count + w.stats.extraProjectiles;
      const splash = def.behavior === 'splash' ? areaRadius(w, def.radius, true) : 0;
      const life = Math.round(def.duration * TICK_HZ);
      if (def.behavior === 'dot-spread') {
        // each dart picks its own fresh target
        let tt = t;
        for (let k = 0; k < n; k++) {
          if (k > 0 && st) tt = freshTarget(w, st.kind);
          if (tt < 0) tt = t;
          markSeen(w, tt);
          const a = fatan2(en.y[tt] - p.y, en.x[tt] - p.x) + (n > 1 ? X.fan * ((k % 2) * 2 - 1) * 0.5 : 0);
          const pi = spawnProjectile(w, si, s, p.x, p.y, fcos(a) * def.speed, fsin(a) * def.speed, 0.32, dmg, life, def.pierce, 0, PK.HOMING);
          if (pi >= 0) {
            w.pr.target[pi] = tt;
            w.pr.targetUid[pi] = en.uid[tt];
            onProjectileSpawn(w, pi, k === 0);
          }
        }
        return true;
      }
      const base = fatan2(en.y[t] - p.y, en.x[t] - p.x);
      for (let k = 0; k < n; k++) {
        const a = n > 1 ? base - X.fan / 2 + (X.fan * k) / (n - 1) : base;
        const pi = spawnProjectile(w, si, s, p.x, p.y, fcos(a) * def.speed, fsin(a) * def.speed, def.behavior === 'splash' ? 0.35 : 0.3,
          dmg, life, def.pierce, splash, PK.STRAIGHT);
        if (pi >= 0) {
          w.pr.target[pi] = t;
          w.pr.targetUid[pi] = en.uid[t];
          onProjectileSpawn(w, pi, k === 0);
        }
      }
      return true;
    }
    case 'chain': {
      sp.chainSeenN = 0;
      const jumpR = areaRadius(w, def.radius, false);
      let any = false;
      for (let c = 0; c < X.chains; c++) {
        let t = nearestUnseen(w, p.x, p.y, TARGET_RANGE);
        if (t < 0) break;
        any = true;
        let cx = p.x;
        let cy = p.y;
        for (let j = 0; j < def.count && t >= 0; j++) {
          markSeen(w, t);
          const tx = en.x[t];
          const ty = en.y[t];
          w.events.push(EV.HIT, w.tick, t, s, 3, cx, cy, 0); // c = 3: chain segment from (x,y) to the target
          if (st) applyStatus(w, t, st.kind, st.stacks, st.seconds, st.dps * scale, st.maxStacks, s, X.spreads);
          dealDamage(w, t, dmg, s, DMG.CAN_CRIT | DMG.NO_STAMP);
          if (en.alive[t]) knockback(w, t, cx, cy, X.knock);
          cx = tx;
          cy = ty;
          t = nearestUnseen(w, cx, cy, jumpR);
        }
      }
      return any;
    }
    case 'aura': {
      if (nearestEnemy(w, p.x, p.y, TARGET_RANGE) < 0) return false;
      const r = areaRadius(w, def.radius, true);
      const buf = w.qA;
      const n = w.grid.queryCircle(p.x, p.y, r + 1.5, buf);
      for (let q = 0; q < n; q++) {
        const e = buf[q];
        if (!en.alive[e]) continue;
        const dx = en.x[e] - p.x;
        const dy = en.y[e] - p.y;
        const rr = r + en.r[e];
        if (dx * dx + dy * dy > rr * rr) continue;
        if (st) applyStatus(w, e, st.kind, st.stacks, st.seconds, st.dps * scale, st.maxStacks, s, X.spreads);
        dealDamage(w, e, dmg, s, DMG.CAN_CRIT | DMG.NO_STAMP);
        if (en.alive[e]) knockback(w, e, p.x, p.y, X.knock);
      }
      spawnZone(w, si, s, p.x, p.y, r, 0, Math.max(12, Math.round(def.duration * TICK_HZ)), 999, true);
      return true;
    }
    case 'zone': {
      const r = areaRadius(w, def.radius, true);
      const life = Math.round(def.duration * TICK_HZ * w.stats.durationMul);
      if (def.target === 'self') {
        if (nearestEnemy(w, p.x, p.y, TARGET_RANGE + 2) < 0) return false;
        const z = spawnZone(w, si, s, p.x, p.y, r, dmg, life, X.period, false);
        if (z >= 0) w.zn.aux0[z] = scale;
        return z >= 0;
      }
      let placed = 0;
      let lx = 0;
      let ly = 0;
      for (let k = 0; k < def.count; k++) {
        const t = densestEnemy(w, r, lx, ly, placed > 0 ? r * 1.5 : 0);
        if (t < 0) break;
        lx = en.x[t];
        ly = en.y[t];
        const z = spawnZone(w, si, s, lx, ly, r, dmg, life, X.period, false);
        if (z >= 0) {
          w.zn.aux0[z] = scale;
          placed++;
        }
      }
      return placed > 0;
    }
    case 'orbit': {
      // a recast replaces this slot's bodies so haste never stacks orbits
      const pr = w.pr;
      for (let i = 0; i < pr.hi; i++) if (pr.alive[i] && pr.kind[i] === PK.ORBIT && pr.slot[i] === s) pr.release(i);
      const n = def.count + w.stats.extraProjectiles;
      const orbitR = areaRadius(w, def.radius, false);
      const life = Math.round(def.duration * TICK_HZ * w.stats.durationMul);
      for (let k = 0; k < n; k++) {
        const pi = spawnProjectile(w, si, s, p.x, p.y, 0, 0, 0.5, dmg, life, 999, 0, PK.ORBIT);
        if (pi >= 0) {
          w.pr.aux0[pi] = (TAU * k) / n; // phase offset
          w.pr.aux1[pi] = orbitR; // orbit radius
          pr.x[pi] = p.x + fcos(pr.aux0[pi] + sp.orbitPhase * def.speed) * orbitR;
          pr.y[pi] = p.y + fsin(pr.aux0[pi] + sp.orbitPhase * def.speed) * orbitR;
        }
      }
      return true;
    }
    case 'summon': {
      if (nearestEnemy(w, p.x, p.y, TARGET_RANGE + 4) < 0) return false;
      const al = w.al;
      const want = def.count + w.stats.extraProjectiles;
      const life = Math.round(def.duration * TICK_HZ);
      let have = 0;
      for (let i = 0; i < al.hi; i++) {
        if (!al.alive[i] || al.slot[i] !== s) continue;
        have++;
        al.life[i] = life;
        al.aux0[i] = dmg;
      }
      for (; have < want; have++) {
        const i = al.alloc();
        if (i < 0) break;
        const a = (TAU * have) / want;
        al.spell[i] = si;
        al.slot[i] = s;
        al.x[i] = p.x + fcos(a) * 0.8;
        al.y[i] = p.y + fsin(a) * 0.8;
        al.vx[i] = 0;
        al.vy[i] = 0;
        al.life[i] = life;
        al.cd[i] = 10;
        al.target[i] = -1;
        al.aux0[i] = dmg;
      }
      return true;
    }
  }
  return false;
}

const ALLY_BITE_TICKS = 30;
const ALLY_REACH = 0.55;

/** Summons: retarget every 10 ticks, chase, bite on a cooldown; idle near the player. */
function updateAllies(w: World): void {
  const al = w.al;
  const en = w.en;
  const p = w.player;
  for (let i = 0; i < al.hi; i++) {
    if (!al.alive[i]) continue;
    if (--al.life[i] <= 0) {
      al.release(i);
      continue;
    }
    if (al.cd[i] > 0) al.cd[i]--;
    const si = al.spell[i];
    const def = SPELLS[si];
    const slot = al.slot[i];
    let t = al.target[i];
    if (t >= 0 && !en.alive[t]) t = -1;
    if (t < 0 || (w.tick + i) % 10 === 0) {
      // stay within 10 m of the player
      const nt = nearestEnemy(w, al.x[i], al.y[i], 9);
      if (nt >= 0) {
        const dx = en.x[nt] - p.x;
        const dy = en.y[nt] - p.y;
        t = dx * dx + dy * dy < 144 ? nt : -1;
      } else t = -1;
    }
    al.target[i] = t;
    let tx: number;
    let ty: number;
    if (t >= 0) {
      tx = en.x[t];
      ty = en.y[t];
    } else {
      const a = sp_phase(w) * 2 + i;
      tx = p.x + fcos(a) * 1.4;
      ty = p.y + fsin(a) * 1.4;
    }
    const dx = tx - al.x[i];
    const dy = ty - al.y[i];
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const speed = def.speed * (t >= 0 ? 1 : 0.8);
    al.vx[i] += ((dx / d) * speed - al.vx[i]) * 0.2;
    al.vy[i] += ((dy / d) * speed - al.vy[i]) * 0.2;
    al.x[i] += al.vx[i] * DT;
    al.y[i] += al.vy[i] * DT;
    if (t >= 0 && al.cd[i] === 0 && d < ALLY_REACH + en.r[t]) {
      al.cd[i] = ALLY_BITE_TICKS;
      const st = def.status;
      if (st) applyStatus(w, t, st.kind, st.stacks, st.seconds, st.dps * slotScale(w, slot), st.maxStacks, slot);
      dealDamage(w, t, al.aux0[i], slot, DMG.CAN_CRIT | DMG.NO_STAMP);
      if (en.alive[t]) knockback(w, t, al.x[i], al.y[i], SPELL_X[si].knock);
      // bounce off after a bite
      al.vx[i] = -al.vx[i] * 0.5;
      al.vy[i] = -al.vy[i] * 0.5;
    }
  }
}
const sp_phase = (w: World): number => w.spells.orbitPhase;

/** The fusion's big moment: a shockwave from the player that flattens the crowd. */
function fusionShockwave(w: World, slot: number): void {
  const en = w.en;
  const p = w.player;
  const dmg = 25 * slotScale(w, slot);
  const buf = w.qA;
  const n = w.grid.queryCircle(p.x, p.y, NOVA_R + 1.5, buf);
  for (let q = 0; q < n; q++) {
    const e = buf[q];
    if (!en.alive[e]) continue;
    const dx = en.x[e] - p.x;
    const dy = en.y[e] - p.y;
    const rr = NOVA_R + en.r[e];
    if (dx * dx + dy * dy > rr * rr) continue;
    dealDamage(w, e, dmg, SRC.FUSION, DMG.NO_STAMP);
    if (en.alive[e]) knockback(w, e, p.x, p.y, 12);
  }
  w.events.push(EV.HIT, w.tick, -1, SRC.FUSION, 4, p.x, p.y, NOVA_R);
}

/**
 * Damage everything in a radius (splash). exclude = enemy already hit directly (or -1). Gated per source,
 * applies the spell's status. Used by projectiles.ts too. Uses its own scratch buffer (safe inside qA loops).
 */
export function splashAt(w: World, x: number, y: number, r: number, dmg: number, slot: number, spellIdx: number, exclude = -1): void {
  const en = w.en;
  const def = SPELLS[spellIdx];
  const X = SPELL_X[spellIdx];
  const st = def.status;
  const scale = slot < BAL.spellSlots ? slotScale(w, slot) : 1;
  const buf = w.spells.qSplash;
  const n = w.grid.queryCircle(x, y, r + 1.5, buf);
  for (let q = 0; q < n; q++) {
    const e = buf[q];
    if (e === exclude || !en.alive[e]) continue;
    const dx = en.x[e] - x;
    const dy = en.y[e] - y;
    const rr = r + en.r[e];
    if (dx * dx + dy * dy > rr * rr) continue;
    if (st) applyStatus(w, e, st.kind, st.stacks, st.seconds, st.dps * scale, st.maxStacks, slot, X.spreads);
    dealDamage(w, e, dmg, slot, DMG.CAN_CRIT);
    if (en.alive[e]) knockback(w, e, x, y, X.knock);
  }
  w.events.push(EV.HIT, w.tick, -1, slot, 4, x, y, r); // c = 4: splash ring at (x,y), v = radius
}
