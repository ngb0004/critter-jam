import { describe, expect, it } from 'vitest';
import { DEATH } from '../core/types';
import { nextMilestone, parSeconds, pointsFor, topUp } from './points';
import { estimatePercentile, POPULATION, shareRank, SPEC_SIM_POPULATION, topLabel, topPercent } from './percentile';
import { shareText, topKeywords } from './share';
import { SPELL_IDX } from '../content/spells';
import { freshSave, loadSave, migrate, peekDay, SAVE_KEY, settleRun, weekDaysPlayed, weekStrip, writeSave, type KV } from './save';
import { deathSummary, RunLog } from './runlog';
import { fmtCountdown, fmtTime } from './format';

const run = (day: number, sec: number, damage = 1000) => ({ day, sec, damage, spec: 'ember', keywords: ['fire', 'storm'], level: 10, kills: 100, cause: DEATH.CHIP });

class MemKV implements KV {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

describe('daily points (spec 9.1)', () => {
  it('hits the anchors', () => {
    expect(pointsFor(0)).toBe(0);
    expect(pointsFor(60)).toBe(50);
    expect(pointsFor(120)).toBe(150);
    expect(pointsFor(300)).toBe(400);
    expect(pointsFor(420)).toBe(600);
    expect(pointsFor(540)).toBe(800);
    expect(pointsFor(660)).toBe(1000);
    expect(pointsFor(14 * 60)).toBe(1000);
  });
  it('is linear per second between anchors and monotone', () => {
    expect(pointsFor(150)).toBe(190); // 150 + 80 * 30/60
    let prev = -1;
    for (let s = 0; s <= 900; s++) {
      const p = pointsFor(s);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });
  it('day normalisation clamps to 0.92..1.08', () => {
    expect(pointsFor(300, 360 / 2)).toBe(pointsFor(300 * 1.08));
    expect(pointsFor(300, 360 * 2)).toBe(pointsFor(300 * 0.92));
    expect(parSeconds()).toBe(660);
  });
  it('top-up pays only the difference', () => {
    expect(topUp(420, 300)).toBe(200);
    expect(topUp(300, 420)).toBe(0);
    expect(nextMilestone(301)).toEqual({ sec: 360, points: 500 });
    expect(nextMilestone(700)).toBeNull();
  });
});

describe('settleRun: best of day, attempts, ledger top-ups', () => {
  it('pays on run end and tops up on a new best only', () => {
    const s = freshSave();
    const a = settleRun(s, run(312, 300));
    expect(a).toMatchObject({ attempt: 0, newBest: true, gained: 400, dayPoints: 400, firstDive: true });
    const b = settleRun(s, run(312, 200));
    expect(b).toMatchObject({ attempt: 1, newBest: false, gained: 0, dayPoints: 400 });
    const c = settleRun(s, run(312, 420));
    expect(c).toMatchObject({ attempt: 2, newBest: true, gained: 200, dayPoints: 600, prevBestSec: 300 });
    expect(s.totalPoints).toBe(600);
    expect(s.ledger.map((e) => [e.points, e.reason])).toEqual([[400, 'first'], [200, 'topup']]);
    const d = peekDay(s, 312);
    expect(d.tries).toBe(3);
    expect(d.bestSec).toBe(420);
    expect(d.firstDiveSec).toBe(300);
    expect(s.history).toHaveLength(3);
  });
  it('tie on time breaks on damage, without extra points', () => {
    const s = freshSave();
    settleRun(s, run(1, 400, 500));
    const t = settleRun(s, run(1, 400, 900));
    expect(t.newBest).toBe(true);
    expect(t.gained).toBe(0);
    expect(peekDay(s, 1).bestDamage).toBe(900);
  });
  it('days are independent and the week counts days played', () => {
    const s = freshSave();
    // day 312 = Mon 2026-11-09 (week starts day 4 + 7k)
    for (const d of [312, 313, 315]) settleRun(s, run(d, 100));
    settleRun(s, run(311, 100)); // previous week (Sunday)
    expect(weekDaysPlayed(s, 315)).toBe(3);
    expect(weekStrip(s, 312)).toEqual([true, true, false, true, false, false, false]);
    expect(s.totalPoints).toBe(pointsFor(100) * 4);
  });
});

describe('save storage', () => {
  it('round-trips through a KV and survives garbage', () => {
    const kv = new MemKV();
    const s = freshSave();
    settleRun(s, run(5, 333));
    s.settings.volume = 0.3;
    expect(writeSave(s, kv)).toBe(true);
    const back = loadSave(kv);
    expect(back.settings.volume).toBe(0.3);
    expect(peekDay(back, 5).bestSec).toBe(333);
    kv.setItem(SAVE_KEY, '{not json');
    expect(loadSave(kv).version).toBe(2);
    expect(loadSave(null).days).toEqual({});
  });
  it('a throwing storage never throws', () => {
    const bad: KV = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
    expect(loadSave(bad).version).toBe(2);
    expect(writeSave(freshSave(), bad)).toBe(false);
  });
  it('migrates the v1 skeleton save', () => {
    const v1 = { version: 1, volume: 0.4, muted: true, damageNumbers: false, reducedMotion: true, lastSpec: 'venom', totalPoints: 150, days: { 312: { bestSec: 120, bestDamage: 9, bestSpec: 'venom', tries: 2, points: 150, firstDiveSec: 0 } }, seenCaptions: ['move'] };
    const s = migrate(v1);
    expect(s.version).toBe(2);
    expect(s.settings).toMatchObject({ volume: 0.4, muted: true, damageNumbers: false, reducedMotion: true, screenShake: false });
    expect(s.lastSpec).toBe('venom');
    expect(peekDay(s, 312)).toMatchObject({ bestSec: 120, tries: 2, points: 150, firstDiveSec: -1 });
    expect(s.seenCaptions).toEqual(['move']);
  });
  it('drops an unknown lastSpec (a stale or hand-edited save must not crash the boot)', () => {
    expect(migrate({ lastSpec: 'frost' }).lastSpec).toBe('ember');
    expect(migrate({ lastSpec: 42 }).lastSpec).toBe('ember');
  });
  it('prunes old replays and caps the number of days', () => {
    const days: Record<string, unknown> = {};
    for (let d = 1; d <= 200; d++) days[d] = { bestSec: d, tries: 1, bestReplay: 'x'.repeat(10) };
    const s = migrate({ days });
    expect(Object.keys(s.days).length).toBe(120);
    expect(peekDay(s, 200).bestReplay).toBe('xxxxxxxxxx');
    expect(peekDay(s, 186).bestReplay).toBe('xxxxxxxxxx');
    expect(peekDay(s, 185).bestReplay).toBe('');
    expect(peekDay(s, 100).bestSec).toBe(100);
    expect(peekDay(s, 80).tries).toBe(0);
  });
});

describe('percentile estimate', () => {
  it('is monotone and labelled as an estimate', () => {
    let prev = -1;
    for (let s = 0; s <= 900; s += 5) {
      const p = estimatePercentile(s);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
    expect(estimatePercentile(391, SPEC_SIM_POPULATION)).toBeCloseTo(50, 5);
    // the live table is regenerated by scripts/delve-pop.ts; its p50 row must map back to 50
    expect(estimatePercentile(POPULATION.quantiles.find(([p]) => p === 50)![1])).toBeCloseTo(50, 5);
    expect(POPULATION.source).toMatch(/estimate/);
    expect(topLabel(531, SPEC_SIM_POPULATION)).toBe('Top 10% est.');
    expect(topLabel(391, SPEC_SIM_POPULATION)).toBe('Top 50% est.');
    expect(topPercent(900)).toBe(0.1);
    expect(topLabel(900)).toBe('Top 0.1% est.');
  });
  it('never shows "Top 99%": below the median it says what share of bot runs you beat', () => {
    expect(topLabel(100, SPEC_SIM_POPULATION)).toMatch(/^Beat \d+% of bot runs \(est\.\)$/);
    expect(topLabel(10, SPEC_SIM_POPULATION)).toBe('Beat <1% of bot runs (est.)');
    expect(shareRank(77)).toBe('Reached Layer 2');
    expect(shareRank(310, SPEC_SIM_POPULATION)).toBe('Reached the Core');
    expect(shareRank(531, SPEC_SIM_POPULATION)).toBe('Top 10% est.');
  });
});

describe('share card', () => {
  it('matches the spec format', () => {
    expect(shareText({ day: 312, seconds: 462, specId: 'ember', keywords: ['fire', 'storm', 'poison', 'shadow'] }))
      .toBe(`DELVE #312 | 7:42 | ${shareRank(462)} | Ember | [fire][storm][poison]`);
    expect(shareText({ day: 1, seconds: 61, specId: 'venom', keywords: [], url: 'https://x/delve/' })).toBe(`DELVE #1 | 1:01 | ${shareRank(61)} | Venom | [-]\nhttps://x/delve/`);
  });
  it('top keywords: fusions first, then rank', () => {
    const fb = SPELL_IDX.get('firebolt')!;
    const pa = SPELL_IDX.get('plasmaArc')!;
    const fr = SPELL_IDX.get('frostNova')!;
    const sb = SPELL_IDX.get('shadeBolt')!;
    expect(topKeywords([fb, fr, pa, sb, -1, -1], [5, 3, 5, 4, 0, 0])).toEqual(['fire', 'storm', 'shadow']);
    expect(topKeywords([fb, -1], [1, 0])).toEqual(['fire']);
  });
});

describe('death summary (spec 3.3)', () => {
  it('names cause and minute in plain words', () => {
    const log = new RunLog();
    for (let s = 0; s <= 492; s++) log.sample(s, s < 460 ? 1 : 1 - (s - 460) / 33, 100, s);
    const d = deathSummary(DEATH.CHIP, 492.4, log);
    expect(d.title).toBe('Overrun at 8:12');
    expect(d.line).toBe('Your kill rate fell behind at 7:56.'); // last second at >= 50% HP
    // red floor did most of the damage: the story is the red floor, even though the crowd landed the last hit
    const r = deathSummary(DEATH.CHIP, 123, log, { dmgByCause: [0, 37, 63, 11, 0] });
    expect(r.title).toBe('Worn down at 2:03');
    expect(r.tip).toMatch(/red/);
    expect(deathSummary(DEATH.BURST, 63, null).title).toBe('Caught on the red floor at 1:03');
    expect(deathSummary(DEATH.BOSS, 100, null, { bossName: 'The Foreman' }).title).toBe('Felled by The Foreman at 1:40');
    expect(deathSummary(DEATH.WYRMFALL, 760, null, { wyrmSec: 40, staggerSec: 9 }).line).toContain('40 s');
    expect(deathSummary(DEATH.NONE, 10, null).title).toBe('You left the dive at 0:10');
  });
  it('formats', () => {
    expect(fmtTime(462.9)).toBe('7:42');
    expect(fmtCountdown(3 * 3600e3 + 12 * 60e3)).toBe('3h 12m');
    expect(fmtCountdown(30e3)).toBe('30s');
  });
});
