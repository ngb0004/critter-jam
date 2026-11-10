/**
 * Player ground zones, puddles and visible aura rings (BUILD).
 * A zone pulses every `period` ticks, hitting every enemy inside (per-source 0.2 s gate, so overlapping zones of
 * one slot do not stack) and applying the spell's status(es). dmg 0 = visual only (aura flash ring).
 * zn.aux0 = status damage scale (slot fit x R at cast time, or relicPower for relic puddles).
 * zn.slot may be SRC.RELIC for relic zones (Grave Bloom puddles, Moth Wing cinders): kills then do not proc.
 *
 * Stable fields read by RENDER: spell, x, y, r, life, maxLife, follow, dmg (0 = ring flash).
 */
import type { World } from '../core/world';
import { SPELLS, SPELL_X } from '../content/spells';
import { onZoneCreate } from './build';
import { dealDamage, DMG } from './damage';
import { flushProcs } from './rules';
import { applyStatus } from './statuses';

/** Spawn a zone. dmg 0 = visual only (aura flash). period = ticks between pulses. follow = stick to player. */
export function spawnZone(
  w: World, spellIdx: number, slot: number, x: number, y: number, r: number, dmg: number,
  lifeTicks: number, period: number, follow: boolean,
): number {
  const zn = w.zn;
  const i = zn.alloc();
  if (i < 0) return -1;
  zn.spell[i] = spellIdx;
  zn.slot[i] = slot;
  zn.x[i] = x;
  zn.y[i] = y;
  zn.r[i] = r;
  zn.dmg[i] = dmg;
  zn.life[i] = lifeTicks < 1 ? 1 : lifeTicks;
  zn.maxLife[i] = zn.life[i];
  zn.period[i] = period < 1 ? 1 : period;
  zn.follow[i] = follow ? 1 : 0;
  zn.aux0[i] = 1;
  if (dmg > 0) onZoneCreate(w, i);
  return i;
}

export function updateZones(w: World): void {
  const zn = w.zn;
  const en = w.en;
  const buf = w.qA;
  for (let i = 0; i < zn.hi; i++) {
    if (!zn.alive[i]) continue;
    if (--zn.life[i] <= 0) {
      zn.release(i);
      continue;
    }
    if (zn.follow[i]) {
      zn.x[i] = w.player.x;
      zn.y[i] = w.player.y;
    }
    if (zn.dmg[i] <= 0 || (zn.maxLife[i] - zn.life[i]) % zn.period[i] !== 1) continue;
    const si = zn.spell[i];
    const def = SPELLS[si];
    const st = def.status;
    const st2 = SPELL_X[si].status2;
    const spreads = SPELL_X[si].spreads;
    const scale = zn.aux0[i];
    const slot = zn.slot[i];
    const zx = zn.x[i];
    const zy = zn.y[i];
    const zr = zn.r[i];
    const dmg = zn.dmg[i];
    const n = w.grid.queryCircle(zx, zy, zr + 1.5, buf);
    for (let q = 0; q < n; q++) {
      const e = buf[q];
      if (!en.alive[e]) continue;
      const dx = en.x[e] - zx;
      const dy = en.y[e] - zy;
      const rr = zr + en.r[e];
      if (dx * dx + dy * dy > rr * rr) continue;
      if (st) applyStatus(w, e, st.kind, st.stacks, st.seconds, st.dps * scale, st.maxStacks, slot, spreads);
      if (st2) applyStatus(w, e, st2.kind, st2.stacks, st2.seconds, st2.dps * scale, st2.maxStacks, slot);
      dealDamage(w, e, dmg, slot, DMG.CAN_CRIT);
    }
  }
  flushProcs(w);
}
