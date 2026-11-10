/**
 * The daily (CORE), spec 2.1. Pure functions of a unix time in ms: callers pass Date.now(); the sim
 * never reads the clock. Reset is 10:00 UTC with no DST shift. Day 0 starts 2026-01-01 10:00 UTC,
 * so 2026-11-09 after 10:00 UTC is DELVE #312.
 */
import { hashString, xxh32 } from './hash';
import { OMENS, TWISTS } from '../content/omens';
import type { SeedConfig } from './world';

export const EPOCH_MS = 1767225600000; // 2026-01-01T00:00:00Z
export const RESET_OFFSET_MS = 10 * 3600 * 1000;
const DAY_MS = 86400 * 1000;
/** Local stand-in for the server salt (spec: revealed at reset). */
export const LOCAL_SALT = hashString('delve-daily-local-salt-v1');

/** delve = floor((unixUTC - 10h - epoch) / 86400). */
export function dayNumber(unixMs: number): number {
  return Math.floor((unixMs - RESET_OFFSET_MS - EPOCH_MS) / DAY_MS);
}
/** Unix ms when day `day` starts (10:00 UTC). */
export function dayStartMs(day: number): number {
  return EPOCH_MS + RESET_OFFSET_MS + day * DAY_MS;
}
/** Milliseconds until the next reset. */
export function msUntilReset(unixMs: number): number {
  return dayStartMs(dayNumber(unixMs) + 1) - unixMs;
}

export function daySeed(day: number, salt = LOCAL_SALT): number {
  return xxh32([day | 0], salt);
}

/** Weeks run Monday 10:00 UTC to Monday 10:00 UTC. Day 0 (2026-01-01) is a Thursday; day 4 is Monday. */
export function weekNumber(day: number): number {
  return Math.floor((day - 4) / 7);
}

export function weeklyOmenId(day: number, salt = LOCAL_SALT): string {
  return OMENS[xxh32([weekNumber(day), 0x0e1], salt) % OMENS.length].id;
}
export function dailyTwistId(day: number, salt = LOCAL_SALT): string {
  return TWISTS[xxh32([day | 0, 0x7a1], salt) % TWISTS.length].id;
}

/** Everything that seeds today's run. attempt seeds only the burst jitter. */
export function seedForDay(day: number, attempt = 0, salt = LOCAL_SALT): SeedConfig {
  return { day, daySeed: daySeed(day, salt), attempt, omenId: weeklyOmenId(day, salt), twistId: dailyTwistId(day, salt) };
}

/** "2026-11-09" style label of the UTC date a delve day starts on. */
export function dayLabel(day: number): string {
  return new Date(dayStartMs(day)).toISOString().slice(0, 10);
}
