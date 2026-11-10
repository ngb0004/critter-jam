/**
 * 8 rule-changing relics (BUILD), spec 5.3. Each one is a hook bundle; the effect bodies live in
 * sim/rules.ts (lazy function references, so this table stays data). No relic grants revives,
 * invulnerability beyond the dash, or uncapped healing (sim/build.test.ts lints the hook names).
 * ledger = bot-measured "more" multiplier budget (x1.05-1.15).
 */
import type { RelicDef } from '../core/types';
import { emberHeartOnKill, graveBloomOnKill, mothWingOnDash, overchargeOnCast, rules, splitShotOnSpawn } from '../sim/rules';

export const RELICS: readonly RelicDef[] = [
  { id: 'lanternOil', name: 'Lantern Oil', desc: 'Zones, puddles and orbits last 50% longer.', ledger: 1.08, rarity: 'common',
    hooks: { modifyStats: (_w, s) => { s.durationMul *= 1.5; } } },
  { id: 'splitShot', name: 'Split Shot', desc: 'The first projectile of every cast forks in two.', ledger: 1.1, rarity: 'rare',
    hooks: { onProjectileSpawn: splitShotOnSpawn } },
  { id: 'ironLung', name: 'Iron Lung', desc: '+1 dash charge.', ledger: 1.06, rarity: 'common',
    hooks: { modifyStats: (_w, s) => { s.dashCharges += 1; } } },
  { id: 'graveBloom', name: 'Grave Bloom', desc: 'Poisoned enemies leave a toxic puddle when they die (4 per second at most).', ledger: 1.12, rarity: 'rare',
    hooks: { onKill: graveBloomOnKill } },
  { id: 'overcharge', name: 'Overcharge', desc: 'Every 10th cast fires twice.', ledger: 1.1, rarity: 'rare',
    hooks: { onCast: overchargeOnCast } },
  { id: 'emberHeart', name: 'Ember Heart', desc: 'Burning enemies pop in a fiery blast when they die (6 per second at most).', ledger: 1.1, rarity: 'rare',
    hooks: { onKill: emberHeartOnKill } },
  { id: 'mothWing', name: 'Moth Wing', desc: 'Dashing leaves a trail of burning cinders.', ledger: 1.06, rarity: 'common',
    hooks: { onDash: mothWingOnDash } },
  { id: 'echoStone', name: 'Echo Stone', desc: 'Your orbits count as zones: they drop scorched rings as they spin.', ledger: 1.08, rarity: 'epic',
    hooks: { onAcquire: (w) => { rules(w).echoStone = true; } } },
];

export const relicById = (id: string): RelicDef | undefined => RELICS.find((r) => r.id === id);
