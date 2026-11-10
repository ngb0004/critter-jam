import { describe, expect, it } from 'vitest';
import { Rng } from './rng';
import { seedForDay } from './daily';
import { choose, step } from './world';
import { deserializeReplay, hashWorld, playReplay, Recorder, ReplayVersionError, serializeReplay, worldForReplay, type Replay } from './replay';
import { SIM_VERSION } from './constants';
import { IN_DASH, IN_MOVE, type SpecId } from './types';

/** Drive a fresh world with pseudo-random inputs for `ticks` ticks, recording everything. */
function record(specId: SpecId, inputSeed: number, ticks: number, day = 312): { replay: Replay; hash: number; tick: number } {
  const seed = seedForDay(day, 0);
  const rec = new Recorder(seed, specId);
  const w = worldForReplay({ v: SIM_VERSION, seed, specId, frames: new Uint8Array(0), choices: [] });
  const r = new Rng(inputSeed);
  let dir = 0;
  let guard = 0;
  while (w.tick < ticks && !w.over && guard++ < ticks * 4) {
    if (w.offer.open) {
      const code = r.int(w.offer.open.cards.length);
      if (choose(w, code)) rec.choice(w.tick, code);
      continue;
    }
    if (w.tick % 45 === 0) dir = r.int(64);
    // circle-kite: mostly move, occasionally dash
    const f = dir | IN_MOVE | (r.int(240) === 0 ? IN_DASH : 0);
    w.events.clear();
    if (step(w, f)) rec.frame(f);
  }
  return { replay: rec.finish(), hash: hashWorld(w), tick: w.tick };
}

describe('replay determinism', () => {
  for (const spec of ['ember', 'venom'] as const) {
    it(`${spec}: same seed + same inputs = same state hash after 3,600 ticks`, () => {
      const a = record(spec, 42, 3600);
      const b = record(spec, 42, 3600);
      expect(a.tick).toBe(b.tick);
      expect(a.hash).toBe(b.hash);
      // playing the recorded log back reproduces the run exactly
      const w = playReplay(a.replay);
      expect(w.tick).toBe(a.tick);
      expect(hashWorld(w)).toBe(a.hash);
      // and survives serialisation
      const w2 = playReplay(deserializeReplay(serializeReplay(a.replay)));
      expect(hashWorld(w2)).toBe(a.hash);
    });
  }

  it('different inputs give a different run', () => {
    const a = record('ember', 1, 1200);
    const b = record('ember', 2, 1200);
    expect(a.hash).not.toBe(b.hash);
  });

  it('step does nothing while an offer is open', () => {
    const seed = seedForDay(312);
    const w = worldForReplay({ v: SIM_VERSION, seed, specId: 'ember', frames: new Uint8Array(0), choices: [] });
    let n = 0;
    while (!w.offer.open && !w.over && n++ < 20000) step(w, 0);
    if (w.offer.open) {
      const t = w.tick;
      const h = hashWorld(w);
      expect(step(w, IN_MOVE)).toBe(false);
      expect(w.tick).toBe(t);
      expect(hashWorld(w)).toBe(h);
    }
  });
});

describe('full-run replay determinism (integrator)', () => {
  // A bot plays a whole run to its death the way main.ts does (events drained only every 7 ticks, choices
  // recorded at the paused tick); the recorded log, serialised and played back, must land on the same state.
  for (const [spec, e] of [['ember', 0.95], ['venom', 0.75]] as const) {
    it(`${spec}: a played run to death replays to the identical state hash`, async () => {
      const { botChoose, botInput } = await import('../bot/bot');
      const { buildModifiers } = await import('../content/omens');
      const { createWorld } = await import('./world');
      const seed = seedForDay(313, 1);
      const w = createWorld(seed, spec, buildModifiers(seed.omenId, seed.twistId));
      const rec = new Recorder(seed, spec);
      let picks = 0;
      while (!w.over && w.tick < 60 * 60 * 15) {
        if (w.offer.open) {
          const t = w.tick;
          const c = botChoose(w);
          if (choose(w, c)) {
            rec.choice(t, c);
            picks++;
          }
          continue;
        }
        const f = botInput(w, { e });
        if (step(w, f)) rec.frame(f);
        if (w.tick % 7 === 0) w.events.clear();
      }
      expect(w.over).toBe(true);
      expect(w.tick).toBeGreaterThan(60 * 90);
      expect(picks).toBeGreaterThan(10);
      const r = deserializeReplay(serializeReplay(rec.finish()));
      const back = playReplay(r);
      expect(back.over).toBe(true);
      expect(back.tick).toBe(w.tick);
      expect(back.deathCause).toBe(w.deathCause);
      expect(back.score.totalDamage).toBe(w.score.totalDamage);
      expect(hashWorld(back)).toBe(hashWorld(w));
    }, 60000);
  }
});

describe('replay versioning', () => {
  it('refuses a replay recorded on another sim version, and keeps Modifiers tags', () => {
    const seed = seedForDay(312, 0);
    const rec = new Recorder(seed, 'ember', ['debug-guard']);
    for (let k = 0; k < 30; k++) rec.frame(0);
    const r = deserializeReplay(serializeReplay(rec.finish()));
    expect(r.v).toBe(SIM_VERSION);
    expect(r.tags).toEqual(['debug-guard']);
    expect(worldForReplay(r).mods.tags.has('debug-guard')).toBe(true);
    expect(playReplay(r).tick).toBe(30);
    expect(() => playReplay({ ...r, v: SIM_VERSION - 1 })).toThrow(ReplayVersionError);
  });
});
