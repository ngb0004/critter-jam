/**
 * Enemy pool lifecycle, movement and contact damage (COMBAT), spec 4, 7.1.
 *
 * Per-kind movement (content/enemies.ts ENEMY_AI):
 *  - bat: weaving flier (perpendicular sine wobble, phase per bat; packs share a phase), barely separates.
 *  - slime / slimelet: hop cycle (burst of speed, then a rest).
 *  - beetle: commits to a heading and re-aims every ~0.85 s, so a sidestep makes it overshoot. Armoured.
 *  - shroom: slow walker, drops a lingering spore puddle (hostile telegraph) every ~4.5 s near the player.
 *  - golem / elite: heavy chasers; when close they stop and slam a telegraphed circle around themselves.
 *  - clump: slow heavy chaser.
 *  - formation members (EF.FORMATION): driven by spawn.ts formation state until released.
 *  - wyrm head: does not move.
 * Then: separation through the previous tick's spatial hash, knockback (decays), integration, arena
 * clamp, far-away recycling (enemies left > 24 m behind re-enter on the spawn ring), contact damage.
 *
 * Contact damage: each body that touches the 70% hurtbox deals its `dmg` once per CONTACT_CD ticks
 * (full armor DR). Bosses deal DEATH.BOSS contact.
 *
 * aux usage (World.en): bat aux0 = phase index; beetle aux0/aux1 = heading; shroom aux0 = next puddle
 * tick; golem/elite aux0 = next slam tick, auxI = wind-up end tick (> tick = rooted); clump aux1 = bodies
 * folded into it (spawn.ts); formation members
 * auxI = formation slot + 1 (see spawn.ts). Bosses: bosses.ts owns their aux.
 */
import { BAL, CAP, DT, secToTicks } from '../core/constants';
import { fexp, sinIdx } from '../core/fmath';
import type { World } from '../core/world';
import { DEATH, EF, TG_COLOR, TG_SHAPE, TGF } from '../core/types';
import { EN, ENEMIES, ENEMY_AI } from '../content/enemies';
import { HURT, hurtPlayer } from './player';
import { BODY_DMG, BODY_SPLIT, contactDmg, unitHp, formationSteer } from './spawn';
import { addTelegraphCat, TGC } from './hazards';
import { onEliteReleased } from './bosses';

/** Contact cooldown per enemy (ticks) and contact damage scale. */
export const CONTACT_CD = 40;
export const CONTACT_MUL = 0.9;
/** Distance at which a trash enemy is recycled onto the spawn ring ahead of the player. */
const RECYCLE_DIST = 24;
const RECYCLE_RING = 15;

/** Flat armor for a kind at the current time (Descent-only growth, so it plateaus at 5:00). */
function kindArmor(w: World, def: number): number {
  const f = ENEMY_AI[def]?.armorFrac ?? 0;
  if (f <= 0) return 0;
  const m = (w.tick * DT) / 60;
  const ld = m < 5 ? m : 5;
  return f * BAL.hp0 * fexp(BAL.hpD * ld);
}

/**
 * Spawn a trash enemy of ENEMIES[def] at (x, y). flags = EF.* extras. Returns the slot or -1 (pool full).
 * HP, damage and XP come from the current pressure curves.
 */
export function spawnEnemy(w: World, def: number, x: number, y: number, flags: number): number {
  const en = w.en;
  const i = en.alloc();
  if (i < 0) return -1;
  const d = ENEMIES[def];
  en.def[i] = def;
  en.flags[i] = flags | (ENEMY_AI[def].kb === 0 ? EF.NO_KNOCKBACK : 0);
  en.x[i] = x;
  en.y[i] = y;
  en.vx[i] = 0;
  en.vy[i] = 0;
  en.kx[i] = 0;
  en.ky[i] = 0;
  en.r[i] = d.radius;
  // trash bodies carry 1/BODY_SPLIT of a unit (spawn.ts); the elite guardian and the Wyrm are whole
  const whole = def === EN.ELITE || def === EN.WYRM;
  const share = whole ? 1 : 1 / BODY_SPLIT;
  en.maxHp[i] = en.hp[i] = unitHp(w) * d.hpMul * share;
  en.speed[i] = d.speed;
  en.slow[i] = 1;
  en.dmg[i] = contactDmg(w) * d.dmgMul * CONTACT_MUL * (whole ? 1 : BODY_DMG);
  en.xp[i] = d.xpMul * w.mods.xpPerUnitMul * share;
  en.armor[i] = kindArmor(w, def);
  en.spawnTick[i] = w.tick;
  en.flash[i] = 0;
  en.touchCd[i] = 0;
  en.aux0[i] = 0;
  en.aux1[i] = 0;
  en.auxI[i] = 0;
  if (def === EN.BAT) en.aux0[i] = (Math.imul(en.uid[i], 0x9e3779b1) >>> 20) & 4095;
  else if (def === EN.SHROOM) en.aux0[i] = w.tick + 90 + (en.uid[i] % 120);
  else if (def === EN.GOLEM || def === EN.ELITE) en.aux0[i] = w.tick + 60;
  else if (def === EN.BEETLE) en.auxI[i] = 0;
  en.hitStamp.fill(-10000, i * CAP.hitSources, (i + 1) * CAP.hitSources);
  en.stStacks.fill(0, i * CAP.statuses, (i + 1) * CAP.statuses);
  en.stTicks.fill(0, i * CAP.statuses, (i + 1) * CAP.statuses);
  en.stDps.fill(0, i * CAP.statuses, (i + 1) * CAP.statuses);
  if ((flags & (EF.BOSS | EF.WYRM)) === 0) w.spawn.trashAlive++;
  return i;
}

/**
 * Remove an enemy from the pool (called by damage.killEnemy, or a despawn). A kill (hp <= 0) of a
 * slime/clump under the Splitting rule spawns two slimelets; the Elite door's guardian reports here.
 */
export function releaseEnemy(w: World, i: number): void {
  const en = w.en;
  if (!en.alive[i]) return;
  const flags = en.flags[i];
  const killed = en.hp[i] <= 0;
  const def = en.def[i];
  const x = en.x[i];
  const y = en.y[i];
  if ((flags & (EF.BOSS | EF.WYRM)) === 0) w.spawn.trashAlive--;
  const wasElite = w.boss.eliteSlot === i && w.boss.eliteUid === en.uid[i];
  en.release(i);
  if (wasElite) onEliteReleased(w, killed);
  if (killed && w.spawn.splitting && (flags & EF.BOSS) === 0 && (def === EN.SLIME || def === EN.CLUMP)) {
    for (let k = 0; k < 2; k++) {
      if (w.spawn.trashAlive >= CAP.renderCapTrash) break;
      const j = spawnEnemy(w, EN.SLIMELET, x + (k === 0 ? -0.35 : 0.35), y, 0);
      if (j >= 0) en.xp[j] = (0.5 * w.mods.xpPerUnitMul) / BODY_SPLIT; // spec 8: +0.5 XP per split
    }
  }
}

/** Add knockback impulse (m/s) away from (fx, fy). Scaled per kind; ignores bosses / NO_KNOCKBACK / Wyrm. */
export function knockback(w: World, i: number, fx: number, fy: number, force: number): void {
  const en = w.en;
  if (en.flags[i] & (EF.BOSS | EF.NO_KNOCKBACK | EF.WYRM)) return;
  const k = ENEMY_AI[en.def[i]]?.kb ?? 1;
  if (k <= 0) return;
  const dx = en.x[i] - fx;
  const dy = en.y[i] - fy;
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  en.kx[i] += (dx / d) * force * k;
  en.ky[i] += (dy / d) * force * k;
  // cap stacked knockback so splash + pierce cannot launch a body across the arena
  const s2 = en.kx[i] * en.kx[i] + en.ky[i] * en.ky[i];
  if (s2 > 144) {
    const s = 12 / Math.sqrt(s2);
    en.kx[i] *= s;
    en.ky[i] *= s;
  }
}

export function updateEnemies(w: World): void {
  const en = w.en;
  const p = w.player;
  const hurtR = 0.45 * 0.7; // WORLD.playerRadius * WORLD.playerHurtFrac
  const tick = w.tick;
  const core = w.layer >= 6;
  const slamWind = core ? BAL.telegraphCore : BAL.telegraphDescent;
  const q = w.qA;
  const grid = w.grid;
  const R = w.arenaR;
  for (let i = 0; i < en.hi; i++) {
    if (!en.alive[i]) continue;
    if (en.flash[i] > 0) en.flash[i]--;
    if (en.touchCd[i] > 0) en.touchCd[i]--;
    const flags = en.flags[i];
    if (flags & EF.WYRM) continue;
    const def = en.def[i];
    let dx = p.x - en.x[i];
    let dy = p.y - en.y[i];
    let d = Math.sqrt(dx * dx + dy * dy) || 1;
    const sp = en.speed[i] * en.slow[i];
    const isBoss = (flags & EF.BOSS) !== 0;

    if (!isBoss) {
      // far behind: re-enter on the spawn ring ahead of the player (keeps pressure honest)
      if (d > RECYCLE_DIST && (flags & (EF.ELITE | EF.FORMATION)) === 0) {
        const a = ((Math.imul(en.uid[i], 0x2c1b3c6d) ^ Math.imul(tick, 0x297a2d39)) >>> 20) & 4095;
        let nx = p.x + sinIdx(a + 1024) * RECYCLE_RING;
        let ny = p.y + sinIdx(a) * RECYCLE_RING;
        const r2 = nx * nx + ny * ny;
        if (r2 > (R - 1.5) * (R - 1.5)) {
          nx = p.x - sinIdx(a + 1024) * RECYCLE_RING;
          ny = p.y - sinIdx(a) * RECYCLE_RING;
        }
        en.x[i] = nx;
        en.y[i] = ny;
        en.kx[i] = en.ky[i] = 0;
        dx = p.x - nx;
        dy = p.y - ny;
        d = Math.sqrt(dx * dx + dy * dy) || 1;
      }
      const ux = dx / d;
      const uy = dy / d;
      let vx = ux * sp;
      let vy = uy * sp;
      if (en.auxI[i] > 0 && (flags & EF.FORMATION) !== 0) {
        // formation member: spawn.ts steers it until the formation releases
        formationSteer(w, i);
        vx = en.vx[i];
        vy = en.vy[i];
      } else if (def === EN.BAT) {
        // weave: perpendicular wobble, ~0.7 Hz
        const ph = (en.aux0[i] + tick * 48) & 4095;
        const s = sinIdx(ph) * 0.85;
        vx = (ux - uy * s) * sp;
        vy = (uy + ux * s) * sp;
      } else if (def === EN.SLIME || def === EN.SLIMELET) {
        const per = def === EN.SLIME ? 54 : 40;
        const ph = (tick - en.spawnTick[i] + (en.uid[i] & 31)) % per;
        const hop = ph < (per * 2) / 5 ? 2.25 : 0.15;
        vx *= hop;
        vy *= hop;
      } else if (def === EN.BEETLE) {
        if (tick >= en.auxI[i]) {
          en.aux0[i] = ux;
          en.aux1[i] = uy;
          en.auxI[i] = tick + 44 + (en.uid[i] & 15);
        }
        // keep rolling along the committed heading
        vx = en.aux0[i] * sp;
        vy = en.aux1[i] * sp;
      } else if (def === EN.SHROOM) {
        if (tick >= en.aux0[i]) {
          en.aux0[i] = tick + secToTicks(4.5) + (en.uid[i] % 40);
          if (d < 11) {
            // spore puddle: lingers 4 s, hurts while you stand in it
            addTelegraphCat(w, TG_SHAPE.CIRCLE, TG_COLOR.RED, en.x[i], en.y[i], 1.05, slamWind, 0.05,
              TGF.LINGER_HURTS, i, TGC.PUDDLE, 4);
          }
        }
      } else if (def === EN.GOLEM || def === EN.ELITE) {
        if (en.auxI[i] > tick) {
          vx = 0;
          vy = 0;
        } else if (d < (def === EN.ELITE ? 3.2 : 2.7) && tick >= en.aux0[i]) {
          const rr = def === EN.ELITE ? 3.0 : 2.4;
          const pct = def === EN.ELITE ? 0.14 : 0.1;
          const t = addTelegraphCat(w, TG_SHAPE.CIRCLE, TG_COLOR.RED, en.x[i], en.y[i], rr, slamWind, pct,
            def === EN.ELITE ? TGF.BOSS : 0, i, TGC.SLAM, 0);
          if (t >= 0) {
            en.auxI[i] = w.tg.impact[t] + 6;
            en.aux0[i] = en.auxI[i] + secToTicks(def === EN.ELITE ? 2.2 : 3.5);
            vx = 0;
            vy = 0;
          }
        }
      }
      en.vx[i] = vx;
      en.vy[i] = vy;
    }

    // integrate (bosses.ts set boss vx/vy this tick)
    en.x[i] += (en.vx[i] + en.kx[i]) * DT;
    en.y[i] += (en.vy[i] + en.ky[i]) * DT;
    en.kx[i] *= 0.85;
    en.ky[i] *= 0.85;

    // separation against the previous tick's hash (positions read live)
    if (!isBoss) {
      const ai = ENEMY_AI[def];
      const ri = en.r[i];
      const n = grid.queryCircle(en.x[i], en.y[i], ri + 1.0, q);
      let sx = 0;
      let sy = 0;
      let seen = 0;
      for (let k = 0; k < n && seen < 8; k++) {
        const j = q[k];
        if (j === i || !en.alive[j]) continue;
        const ox = en.x[i] - en.x[j];
        const oy = en.y[i] - en.y[j];
        const rr = ri + en.r[j];
        const o2 = ox * ox + oy * oy;
        if (o2 >= rr * rr) continue;
        seen++;
        const od = Math.sqrt(o2);
        const big = (en.flags[j] & (EF.BOSS | EF.WYRM)) !== 0;
        const push = (rr - od) * (big ? 0.9 : 0.5 * ai.sep);
        if (od > 1e-4) {
          sx += (ox / od) * push;
          sy += (oy / od) * push;
        } else {
          // exactly stacked: split by slot parity (deterministic)
          sx += (i & 1 ? 0.05 : -0.05) * ai.sep;
          sy += (i & 2 ? 0.05 : -0.05) * ai.sep;
        }
      }
      // cap the correction per tick so crowds flow rather than jitter
      const s2 = sx * sx + sy * sy;
      if (s2 > 0.0144) {
        const s = 0.12 / Math.sqrt(s2);
        sx *= s;
        sy *= s;
      }
      en.x[i] += sx;
      en.y[i] += sy;
    }

    // arena wall
    const lim = R - en.r[i];
    const r2 = en.x[i] * en.x[i] + en.y[i] * en.y[i];
    if (r2 > lim * lim) {
      const k = lim / Math.sqrt(r2);
      en.x[i] *= k;
      en.y[i] *= k;
    }

    // contact
    const cx = p.x - en.x[i];
    const cy = p.y - en.y[i];
    const reach = en.r[i] + hurtR;
    if (en.touchCd[i] === 0 && cx * cx + cy * cy < reach * reach) {
      en.touchCd[i] = CONTACT_CD;
      hurtPlayer(w, en.dmg[i], HURT.CONTACT, isBoss ? DEATH.BOSS : DEATH.CHIP);
    }
  }
}

/** Count of enemies currently touching or nearly touching the player (HUD danger hint, bots). */
export function enemiesNear(w: World, r: number): number {
  const en = w.en;
  const p = w.player;
  let n = 0;
  const r2 = r * r;
  for (let i = 0; i < en.hi; i++) {
    if (!en.alive[i] || en.flags[i] & EF.WYRM) continue;
    const dx = en.x[i] - p.x;
    const dy = en.y[i] - p.y;
    if (dx * dx + dy * dy < r2) n++;
  }
  return n;
}
