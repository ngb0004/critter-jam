import { describe, expect, it } from 'vitest';
import { dayNumber, dayStartMs, daySeed, msUntilReset, seedForDay, weekNumber } from './daily';

describe('daily', () => {
  it('resets at 10:00 UTC', () => {
    const before = Date.UTC(2026, 10, 9, 9, 59, 59);
    const after = Date.UTC(2026, 10, 9, 10, 0, 0);
    expect(dayNumber(after)).toBe(dayNumber(before) + 1);
    expect(dayNumber(after)).toBe(312);
    expect(dayStartMs(312)).toBe(after);
    expect(msUntilReset(before)).toBe(1000);
  });
  it('weeks start on Monday 10:00 UTC', () => {
    const mon = dayNumber(Date.UTC(2026, 10, 9, 12)); // Mon 9 Nov 2026
    const sun = dayNumber(Date.UTC(2026, 10, 8, 12));
    expect(weekNumber(mon)).toBe(weekNumber(sun) + 1);
    expect(weekNumber(mon)).toBe(weekNumber(mon + 6));
  });
  it('seeds are stable and differ per day', () => {
    expect(daySeed(312)).toBe(daySeed(312));
    expect(daySeed(312)).not.toBe(daySeed(313));
    const s = seedForDay(312);
    expect(s.omenId).toBe(seedForDay(313).omenId); // same week
    expect(typeof s.twistId).toBe('string');
  });
});
