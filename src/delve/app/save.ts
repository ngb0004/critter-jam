/**
 * Local save (UI/app). Everything lives in one localStorage key, every access is wrapped in try/catch
 * (private mode, quota, blocked storage all fall back to an in-memory save that still works for the session).
 *
 *   settings      volume / mute / damage numbers / screen shake / reduced motion
 *   days[day]     best run of the day (time, damage tie-break, spec, glyphs), attempts, points paid for it
 *   ledger        every points payment: the first pay-out of a day and each top-up on a new best (spec 9.1)
 *   history       the last 60 runs (any day), newest last
 *   seenCaptions  one-time first-run captions already shown (spec 4.3)
 *
 * settleRun() is the only writer of days/ledger/history and is pure apart from the object it is given,
 * so tests can drive it without a DOM.
 */
import { weekNumber } from '../core/daily';
import { SPEC_IDS } from '../content/specs';
import { pointsFor } from './points';

export interface Settings {
  /** Master volume 0..1. */
  volume: number;
  muted: boolean;
  damageNumbers: boolean;
  screenShake: boolean;
  reducedMotion: boolean;
}

export interface DaySave {
  bestSec: number;
  bestDamage: number;
  bestSpec: string;
  bestKeywords: string[];
  bestLevel: number;
  tries: number;
  /** Points already paid for this day (= pointsFor(bestSec) at the time of the best). */
  points: number;
  /** Survival of the day's first attempt (First Dive board, spec 2.2); -1 = none yet. */
  firstDiveSec: number;
  /** Serialized replay of the best run (core/replay serializeReplay), '' if not stored. */
  bestReplay: string;
}

export interface LedgerEntry {
  day: number;
  /** Points paid by this entry (> 0). */
  points: number;
  reason: 'first' | 'topup';
  sec: number;
  /** Wall-clock ms (presentation only). */
  at: number;
}

export interface RunRecord {
  day: number;
  attempt: number;
  spec: string;
  sec: number;
  cause: number;
  level: number;
  kills: number;
  damage: number;
  keywords: string[];
  newBest: boolean;
  at: number;
}

export interface DelveSave {
  version: 2;
  settings: Settings;
  lastSpec: string;
  /** Lifetime points (sum of the ledger). */
  totalPoints: number;
  days: Record<string, DaySave>;
  ledger: LedgerEntry[];
  history: RunRecord[];
  seenCaptions: string[];
}

export const SAVE_KEY = 'delve-daily.save.v1';
const HISTORY_MAX = 60;
const LEDGER_MAX = 400;
/** days{} keeps at most this many days (stats only; the newest by day number). */
export const DAYS_MAX = 120;
/** Best replays are kept only for days within this many days of the newest day (they are ~10-15 KB each). */
export const REPLAY_KEEP_DAYS = 14;

/**
 * Storage health, for a one-line "progress can't be saved" note. `ok` turns false when storage is missing, a read
 * throws, or a write fails.
 */
export const saveHealth = { ok: true };

/** Prune days{} in place: cap the number of days and drop replays of old days (stats are kept). */
export function pruneDays(days: Record<string, DaySave>): void {
  const keys = Object.keys(days).map(Number).sort((a, b) => b - a);
  if (!keys.length) return;
  const newest = keys[0];
  for (let i = 0; i < keys.length; i++) {
    const k = String(keys[i]);
    if (i >= DAYS_MAX) delete days[k];
    else if (keys[i] < newest - REPLAY_KEEP_DAYS && days[k].bestReplay) days[k].bestReplay = '';
  }
}

function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function defaultSettings(): Settings {
  const reduced = prefersReducedMotion();
  return { volume: 0.7, muted: false, damageNumbers: true, screenShake: !reduced, reducedMotion: reduced };
}

export function freshSave(): DelveSave {
  return { version: 2, settings: defaultSettings(), lastSpec: 'ember', totalPoints: 0, days: {}, ledger: [], history: [], seenCaptions: [] };
}

export function emptyDay(): DaySave {
  return { bestSec: 0, bestDamage: 0, bestSpec: '', bestKeywords: [], bestLevel: 0, tries: 0, points: 0, firstDiveSec: -1, bestReplay: '' };
}

/** Minimal storage surface (localStorage or a test double). */
export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

function defaultStore(): KV | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);

/** Normalise anything parsed from storage (v1 or v2, partial, corrupted) into a valid v2 save. */
export function migrate(raw: unknown): DelveSave {
  const s = freshSave();
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as Record<string, unknown>;
  const rs = (r.settings && typeof r.settings === 'object' ? r.settings : r) as Record<string, unknown>; // v1 kept settings top-level
  s.settings = {
    volume: Math.min(1, Math.max(0, num(rs.volume, s.settings.volume))),
    muted: bool(rs.muted, s.settings.muted),
    damageNumbers: bool(rs.damageNumbers, s.settings.damageNumbers),
    reducedMotion: bool(rs.reducedMotion, s.settings.reducedMotion),
    screenShake: bool(rs.screenShake, !bool(rs.reducedMotion, s.settings.reducedMotion)),
  };
  // an unknown spec id (renamed, future version, hand-edited) must never reach createWorld
  if (typeof r.lastSpec === 'string' && (SPEC_IDS as readonly string[]).includes(r.lastSpec)) s.lastSpec = r.lastSpec;
  s.totalPoints = Math.max(0, Math.floor(num(r.totalPoints, 0)));
  if (r.days && typeof r.days === 'object') {
    for (const [k, v] of Object.entries(r.days as Record<string, unknown>)) {
      if (!v || typeof v !== 'object' || !/^-?\d+$/.test(k)) continue;
      const d = v as Record<string, unknown>;
      s.days[k] = {
        bestSec: num(d.bestSec, 0),
        bestDamage: num(d.bestDamage, 0),
        bestSpec: typeof d.bestSpec === 'string' ? d.bestSpec : '',
        bestKeywords: Array.isArray(d.bestKeywords) ? d.bestKeywords.filter((x): x is string => typeof x === 'string').slice(0, 3) : [],
        bestLevel: num(d.bestLevel, 0),
        tries: Math.max(0, Math.floor(num(d.tries, 0))),
        points: Math.max(0, Math.floor(num(d.points, 0))),
        // v1 stored 0 for "none"; a 0 s first dive is impossible, so treat 0 as none
        firstDiveSec: num(d.firstDiveSec, -1) > 0 ? num(d.firstDiveSec, -1) : -1,
        bestReplay: typeof d.bestReplay === 'string' ? d.bestReplay : '',
      };
    }
  }
  pruneDays(s.days);
  if (Array.isArray(r.ledger)) s.ledger = (r.ledger as LedgerEntry[]).filter((e) => e && typeof e.points === 'number').slice(-LEDGER_MAX);
  if (Array.isArray(r.history)) s.history = (r.history as RunRecord[]).filter((e) => e && typeof e.sec === 'number').slice(-HISTORY_MAX);
  if (Array.isArray(r.seenCaptions)) s.seenCaptions = (r.seenCaptions as unknown[]).filter((x): x is string => typeof x === 'string');
  return s;
}

export function loadSave(store: KV | null = defaultStore()): DelveSave {
  if (!store) saveHealth.ok = false;
  try {
    const raw = store?.getItem(SAVE_KEY);
    if (!raw) return freshSave();
    return migrate(JSON.parse(raw));
  } catch {
    saveHealth.ok = false;
    return freshSave();
  }
}

/** Returns false if the write failed (private mode, quota). A failed replay write is retried without replays. */
export function writeSave(d: DelveSave, store: KV | null = defaultStore()): boolean {
  if (!store) {
    saveHealth.ok = false;
    return false;
  }
  pruneDays(d.days);
  try {
    store.setItem(SAVE_KEY, JSON.stringify(d));
    saveHealth.ok = true;
    return true;
  } catch {
    try {
      // quota: drop stored replays (largest item) and keep the rest
      const slim: DelveSave = { ...d, days: {} };
      for (const [k, v] of Object.entries(d.days)) slim.days[k] = { ...v, bestReplay: '' };
      store.setItem(SAVE_KEY, JSON.stringify(slim));
      return true;
    } catch {
      saveHealth.ok = false;
      return false;
    }
  }
}

export function daySave(d: DelveSave, day: number): DaySave {
  return (d.days[String(day)] ??= emptyDay());
}

/** Read-only peek (does not create the day). */
export function peekDay(d: DelveSave, day: number): DaySave {
  return d.days[String(day)] ?? emptyDay();
}

export interface RunInput {
  day: number;
  sec: number;
  damage: number;
  spec: string;
  keywords: string[];
  level: number;
  kills: number;
  cause: number;
  replay?: string;
  /** Wall clock ms (presentation only). */
  at?: number;
}

export interface RunOutcome {
  /** 0-based attempt index of this run. */
  attempt: number;
  newBest: boolean;
  /** Previous best of the day in seconds (0 if this was the first run). */
  prevBestSec: number;
  /** Points paid now (first pay-out or top-up), never negative. */
  gained: number;
  /** Points the day is worth after this run. */
  dayPoints: number;
  firstOfDay: boolean;
  firstDive: boolean;
}

/**
 * Settle a finished run (spec 2.2 + 9.1): attempts++, best-of-day with the damage tie-break, points paid on run
 * end at pointsFor(best), topped up on a new best (only the difference), ledger + history appended.
 */
export function settleRun(d: DelveSave, r: RunInput, p50Bot = 360): RunOutcome {
  const ds = daySave(d, r.day);
  const attempt = ds.tries;
  ds.tries++;
  const firstDive = attempt === 0;
  if (firstDive) ds.firstDiveSec = r.sec;
  const prevBestSec = ds.bestSec;
  const newBest = attempt === 0 || r.sec > ds.bestSec || (r.sec === ds.bestSec && r.damage > ds.bestDamage);
  let gained = 0;
  if (newBest) {
    ds.bestSec = r.sec;
    ds.bestDamage = r.damage;
    ds.bestSpec = r.spec;
    ds.bestKeywords = r.keywords.slice(0, 3);
    ds.bestLevel = r.level;
    if (r.replay !== undefined) ds.bestReplay = r.replay;
    const pts = pointsFor(r.sec, p50Bot);
    gained = Math.max(0, pts - ds.points);
    if (gained > 0) {
      d.ledger.push({ day: r.day, points: gained, reason: ds.points === 0 ? 'first' : 'topup', sec: r.sec, at: r.at ?? 0 });
      if (d.ledger.length > LEDGER_MAX) d.ledger.splice(0, d.ledger.length - LEDGER_MAX);
      ds.points += gained;
      d.totalPoints += gained;
    }
  }
  d.history.push({
    day: r.day, attempt, spec: r.spec, sec: r.sec, cause: r.cause, level: r.level, kills: r.kills, damage: r.damage,
    keywords: r.keywords.slice(0, 3), newBest, at: r.at ?? 0,
  });
  if (d.history.length > HISTORY_MAX) d.history.splice(0, d.history.length - HISTORY_MAX);
  return { attempt, newBest, prevBestSec, gained, dayPoints: ds.points, firstOfDay: firstDive, firstDive };
}

/** Days played (>= 1 attempt) in the week of `day` (Monday 10:00 UTC weeks), for the weekly chest (spec 9.2: 5 of 7). */
export function weekDaysPlayed(d: DelveSave, day: number): number {
  const wk = weekNumber(day);
  let n = 0;
  for (const [k, v] of Object.entries(d.days)) if (v.tries > 0 && weekNumber(Number(k)) === wk) n++;
  return n;
}

/** Points earned in the week of `day`. */
export function weekPoints(d: DelveSave, day: number): number {
  const wk = weekNumber(day);
  let n = 0;
  for (const [k, v] of Object.entries(d.days)) if (weekNumber(Number(k)) === wk) n += v.points;
  return n;
}

/** Days of the week of `day` as 7 flags (Monday first): played? */
export function weekStrip(d: DelveSave, day: number): boolean[] {
  const wk = weekNumber(day);
  const monday = wk * 7 + 4;
  const out: boolean[] = [];
  for (let i = 0; i < 7; i++) out.push((d.days[String(monday + i)]?.tries ?? 0) > 0);
  return out;
}
