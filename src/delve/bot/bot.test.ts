import { describe, expect, it } from 'vitest';
import { seedForDay } from '../core/daily';
import { hashWorld, playReplay } from '../core/replay';
import { runBot } from './runner';

describe('bots (BOT)', () => {
  it('a bot run is deterministic and its recorded inputs replay to the same state', () => {
    const opts = { seed: seedForDay(320, 1), spec: 'venom' as const, bot: { skill: { e: 0.6 }, policy: 'decent' as const, seed: 9 }, maxSec: 150, record: true };
    const a = runBot(opts);
    const b = runBot(opts);
    expect(a.hash).toBe(b.hash);
    expect(a.sec).toBe(b.sec);
    const back = playReplay(a.replay!);
    expect(back.tick).toBe(Math.round(a.sec * 60));
    expect(hashWorld(back)).toBe(a.hash);
  }, 60000);

  it('random, decent and greedy policies all make legal picks and level up', () => {
    for (const policy of ['random', 'decent', 'greedy'] as const) {
      const r = runBot({ seed: seedForDay(321, 0), spec: 'ember', bot: { skill: { e: 0.5 }, policy, seed: 3 }, maxSec: 90 });
      expect(r.level).toBeGreaterThanOrEqual(5);
      expect(r.firstPick).toBeGreaterThan(0);
      expect(r.firstPick).toBeLessThan(30);
    }
  }, 60000);
});
