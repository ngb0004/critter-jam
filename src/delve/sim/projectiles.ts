/**
 * Player projectiles (BUILD): straight, homing and orbit motion; grid collision; pierce; splash; statuses.
 *
 * Hit rules: a straight/homing projectile hits each enemy at most once (per-projectile memory of up to 8 enemy
 * uids), so separate knives of one cast can each land. Orbit bodies use the per-source 0.2 s gate instead
 * (spec 7.2). Splash projectiles burst on the first enemy: full damage to it, splashFrac to the others
 * (gated per source), status on all of them.
 *
 * Stable fields read by RENDER: spell, x, y, vx, vy, r, kind (PK), life, splash.
 */
import { DT, TICK_HZ } from '../core/constants';
import { fcos, fsin } from '../core/fmath';
import type { World } from '../core/world';
import { SPELLS, SPELL_X } from '../content/spells';
import { slotScale } from './build';
import { dealDamage, DMG, canHit } from './damage';
import { knockback } from './enemies';
import { flushProcs } from './rules';
import { splashAt } from './spells';
import { applyStatus } from './statuses';
import { spawnZone } from './zones';

/** Projectile motion kinds (World.pr.kind). */
export const PK = { STRAIGHT: 0, HOMING: 1, ORBIT: 2 } as const;

/** Per-projectile hit memory size. */
export const PR_HIT_MEM = 8;
/** Largest enemy radius a projectile query must reach (bosses). */
const QUERY_PAD = 2.2;

export function spawnProjectile(
  w: World, spellIdx: number, slot: number, x: number, y: number, vx: number, vy: number, r: number,
  dmg: number, lifeTicks: number, pierce: number, splash: number, kind: number,
): number {
  const pr = w.pr;
  const i = pr.alloc();
  if (i < 0) return -1;
  pr.spell[i] = spellIdx;
  pr.slot[i] = slot;
  pr.x[i] = x;
  pr.y[i] = y;
  pr.vx[i] = vx;
  pr.vy[i] = vy;
  pr.r[i] = r;
  pr.dmg[i] = dmg;
  pr.splash[i] = splash;
  pr.life[i] = lifeTicks;
  pr.pierce[i] = pierce;
  pr.target[i] = -1;
  pr.targetUid[i] = 0;
  pr.kind[i] = kind;
  pr.aux0[i] = 0;
  pr.aux1[i] = 0;
  w.spells.prHitN[i] = 0;
  return i;
}

/** Remember that projectile i hit enemy uid; returns false if it already had. */
function firstHit(w: World, i: number, uid: number): boolean {
  const mem = w.spells.prHit;
  const n = w.spells.prHitN[i];
  const base = i * PR_HIT_MEM;
  for (let k = 0; k < n; k++) if (mem[base + k] === uid) return false;
  if (n < PR_HIT_MEM) {
    mem[base + n] = uid;
    w.spells.prHitN[i] = n + 1;
  } else {
    mem[base + (uid & (PR_HIT_MEM - 1))] = uid;
  }
  return true;
}

export function updateProjectiles(w: World): void {
  const pr = w.pr;
  const en = w.en;
  const p = w.player;
  const phase = w.spells.orbitPhase;
  const buf = w.qA;
  const echo = w.build.rules.echoStone;
  for (let i = 0; i < pr.hi; i++) {
    if (!pr.alive[i]) continue;
    if (--pr.life[i] <= 0) {
      pr.release(i);
      continue;
    }
    const si = pr.spell[i];
    const def = SPELLS[si];
    const X = SPELL_X[si];
    const slot = pr.slot[i];
    const orbit = pr.kind[i] === PK.ORBIT;
    if (orbit) {
      const a = pr.aux0[i] + phase * def.speed;
      const nx = p.x + fcos(a) * pr.aux1[i];
      const ny = p.y + fsin(a) * pr.aux1[i];
      pr.vx[i] = (nx - pr.x[i]) * TICK_HZ;
      pr.vy[i] = (ny - pr.y[i]) * TICK_HZ;
      pr.x[i] = nx;
      pr.y[i] = ny;
      if (echo && pr.life[i] % 30 === 0) {
        const z = spawnZone(w, si, slot, nx, ny, 0.9, pr.dmg[i] * 0.35, Math.round(TICK_HZ * w.stats.durationMul), 15, false);
        if (z >= 0) w.zn.aux0[z] = slotScale(w, slot) * 0.35;
      }
    } else {
      if (pr.kind[i] === PK.HOMING) {
        const t = pr.target[i];
        if (t >= 0 && en.alive[t] && en.uid[t] === pr.targetUid[i]) {
          const dx = en.x[t] - pr.x[i];
          const dy = en.y[t] - pr.y[i];
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          pr.vx[i] += ((dx / d) * def.speed - pr.vx[i]) * 0.15;
          pr.vy[i] += ((dy / d) * def.speed - pr.vy[i]) * 0.15;
        }
      }
      pr.x[i] += pr.vx[i] * DT;
      pr.y[i] += pr.vy[i] * DT;
    }
    // collide
    const px = pr.x[i];
    const py = pr.y[i];
    const pRad = pr.r[i];
    const n = w.grid.queryCircle(px, py, pRad + QUERY_PAD, buf);
    let dead = false;
    for (let q = 0; q < n; q++) {
      const e = buf[q];
      if (!en.alive[e]) continue;
      const dx = en.x[e] - px;
      const dy = en.y[e] - py;
      const rr = pRad + en.r[e];
      if (dx * dx + dy * dy > rr * rr) continue;
      const st = def.status;
      if (orbit) {
        if (!canHit(w, e, slot)) continue;
        if (st) applyStatus(w, e, st.kind, st.stacks, st.seconds, st.dps * slotScale(w, slot), st.maxStacks, slot, X.spreads);
        dealDamage(w, e, pr.dmg[i], slot, DMG.CAN_CRIT);
        if (en.alive[e]) knockback(w, e, p.x, p.y, X.knock);
        continue;
      }
      if (!firstHit(w, i, en.uid[e])) continue;
      if (pr.splash[i] > 0) {
        if (st) applyStatus(w, e, st.kind, st.stacks, st.seconds, st.dps * slotScale(w, slot), st.maxStacks, slot, X.spreads);
        dealDamage(w, e, pr.dmg[i], slot, DMG.CAN_CRIT | DMG.NO_STAMP);
        splashAt(w, px, py, pr.splash[i], pr.dmg[i] * X.splashFrac, slot, si, e);
        dead = true;
        break;
      }
      if (st) applyStatus(w, e, st.kind, st.stacks, st.seconds, st.dps * slotScale(w, slot), st.maxStacks, slot, X.spreads);
      dealDamage(w, e, pr.dmg[i], slot, DMG.CAN_CRIT | DMG.NO_STAMP);
      if (en.alive[e]) knockback(w, e, px, py, X.knock);
      if (--pr.pierce[i] < 0) {
        dead = true;
        break;
      }
    }
    if (dead) {
      pr.release(i);
      continue;
    }
    if (!orbit) {
      const r2 = px * px + py * py;
      if (r2 > (w.arenaR + 2) * (w.arenaR + 2)) pr.release(i);
    }
  }
  flushProcs(w);
}
