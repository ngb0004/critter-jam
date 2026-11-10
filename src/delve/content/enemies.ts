/**
 * Trash enemy content (COMBAT). Index in ENEMIES = World.en.def for non-boss enemies.
 * Indices 0..6 are stable (RENDER keys meshes off `mesh`); new kinds are appended.
 *
 * Movement identities (sim/enemies.ts, AI table below):
 *  - bat:     flier, weaves in loose swarms (spawned in packs), light knockback, fast.
 *  - slime:   hops in bursts; splits into two slimelets on death under the Splitting rule.
 *  - beetle:  armoured (flat armor), commits to a heading and re-aims every ~1 s (sidestep it).
 *  - shroom:  slow walker that leaves lingering spore puddles (red floor) behind it.
 *  - golem:   elite heavy, no knockback; stops and slams a telegraphed circle when close.
 *  - clump:   5 queued bodies merged (5x HP, 5x XP), slow and heavy.
 *  - elite:   the chest's Elite door (40 x hpU), slams like a golem.
 *  - slimelet: Splitting children.
 *  - wyrm:    the Wyrm's head in the maw ring (12:00+). Cannot die; damage on it staggers the breath.
 */
import type { EnemyDef } from '../core/types';

export const ENEMIES: readonly EnemyDef[] = [
  { id: 'bat', name: 'Cave Bat', hpMul: 0.7, dmgMul: 0.8, speed: 3.7, radius: 0.35, xpMul: 0.9, mesh: 'bat', color: 0x8a6cff },
  { id: 'slime', name: 'Glow Slime', hpMul: 1.25, dmgMul: 1, speed: 2.6, radius: 0.45, xpMul: 1.2, mesh: 'slime', color: 0x5ce0b0 },
  { id: 'beetle', name: 'Lamp Beetle', hpMul: 1.0, dmgMul: 1.1, speed: 3.1, radius: 0.42, xpMul: 1.1, mesh: 'beetle', color: 0xffb347 },
  { id: 'shroom', name: 'Mushroom Walker', hpMul: 1.6, dmgMul: 1.2, speed: 1.9, radius: 0.5, xpMul: 1.4, mesh: 'shroom', color: 0xf2c98e },
  { id: 'golem', name: 'Pebble Golem', hpMul: 3.4, dmgMul: 1.6, speed: 1.7, radius: 0.72, xpMul: 2.8, mesh: 'golem', color: 0x9aa7b8 },
  { id: 'clump', name: 'Clump', hpMul: 5, dmgMul: 2, speed: 2.0, radius: 0.9, xpMul: 5, mesh: 'clump', color: 0xc070ff },
  { id: 'elite', name: 'Vault Guardian', hpMul: 40, dmgMul: 2.2, speed: 2.5, radius: 1.0, xpMul: 15, mesh: 'elite', color: 0xffd166 },
  { id: 'slimelet', name: 'Slimelet', hpMul: 0.45, dmgMul: 0.6, speed: 3.0, radius: 0.3, xpMul: 0.5, mesh: 'slime', color: 0x8ff5d0 },
  { id: 'wyrm', name: 'The Wyrm', hpMul: 1, dmgMul: 0, speed: 0, radius: 2.4, xpMul: 0, mesh: 'elite', color: 0xff3b2f },
];
export const ENEMY_IDX: ReadonlyMap<string, number> = new Map(ENEMIES.map((e, i) => [e.id, i]));

/** Numeric indices for sim code (avoid Map lookups in hot paths). */
export const EN = {
  BAT: 0, SLIME: 1, BEETLE: 2, SHROOM: 3, GOLEM: 4, CLUMP: 5, ELITE: 6, SLIMELET: 7, WYRM: 8,
} as const;

/** Per-kind behaviour numbers (sim/enemies.ts). Same order as ENEMIES. */
export interface EnemyAi {
  /** Separation push strength (fliers barely separate). */
  sep: number;
  /** Knockback taken multiplier (0 = immune). */
  kb: number;
  /** Flat armor as a fraction of the Descent-only unit HP (hp0 e^(hpD L_d)), so it plateaus at 5:00; 0 = none. */
  armorFrac: number;
}
export const ENEMY_AI: readonly EnemyAi[] = [
  { sep: 0.35, kb: 1.2, armorFrac: 0 }, // bat
  { sep: 1, kb: 1, armorFrac: 0 }, // slime
  { sep: 1, kb: 0.6, armorFrac: 0.08 }, // beetle
  { sep: 1, kb: 0.8, armorFrac: 0 }, // shroom
  { sep: 1.4, kb: 0, armorFrac: 0.05 }, // golem
  { sep: 1.6, kb: 0.25, armorFrac: 0 }, // clump
  { sep: 1.6, kb: 0, armorFrac: 0.04 }, // elite
  { sep: 0.8, kb: 1.3, armorFrac: 0 }, // slimelet
  { sep: 0, kb: 0, armorFrac: 0 }, // wyrm
];
