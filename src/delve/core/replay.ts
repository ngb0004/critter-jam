/**
 * Replays: record / play back input logs, and hash World state (CORE), spec 12.
 *
 * A replay is the SeedConfig + spec + one input byte per simulated tick + the choices made
 * while paused (with the tick at which they were made). Frames are run-length encoded for storage.
 */
import { SIM_VERSION } from './constants';
import { StateHasher } from './hash';
import type { ChoiceCode, InputFrame, SpecId } from './types';
import { choose, createWorld, step, type SeedConfig, type World } from './world';
import { buildModifiers } from '../content/omens';

export interface ReplayChoice {
  tick: number;
  code: ChoiceCode;
}
export interface Replay {
  v: number; // SIM_VERSION
  seed: SeedConfig;
  specId: SpecId;
  frames: Uint8Array; // frames[k] = input for tick k+1
  choices: ReplayChoice[];
  /** Extra Modifiers tags the run had (e.g. 'debug-guard'); omitted when none. */
  tags?: string[];
}

/** A replay recorded on another sim version replays to a different result: refuse it instead of lying. */
export class ReplayVersionError extends Error {
  constructor(readonly v: number) {
    super(`replay sim version ${v} != SIM_VERSION ${SIM_VERSION}`);
  }
}

/** True if the replay was recorded on this sim version. */
export const replayCompatible = (r: { v: number }): boolean => r.v === SIM_VERSION;

/** Records a run as it is played. Call frame() after each step that returned true, choice() for each accepted choice. */
export class Recorder {
  private buf = new Uint8Array(60 * 60 * 16);
  private n = 0;
  readonly choices: ReplayChoice[] = [];
  constructor(readonly seed: SeedConfig, readonly specId: SpecId, readonly tags: readonly string[] = []) {}

  frame(f: InputFrame): void {
    if (this.n >= this.buf.length) {
      const nb = new Uint8Array(this.buf.length * 2);
      nb.set(this.buf);
      this.buf = nb;
    }
    this.buf[this.n++] = f;
  }
  choice(tick: number, code: ChoiceCode): void {
    this.choices.push({ tick, code });
  }
  finish(): Replay {
    const r: Replay = { v: SIM_VERSION, seed: { ...this.seed }, specId: this.specId, frames: this.buf.slice(0, this.n), choices: this.choices.slice() };
    if (this.tags.length) r.tags = this.tags.slice();
    return r;
  }
}

/** Fresh world for a replay (modifiers rebuilt from the omen/twist ids). */
export function worldForReplay(r: Replay): World {
  const mods = buildModifiers(r.seed.omenId, r.seed.twistId);
  for (const t of r.tags ?? []) mods.tags.add(t);
  return createWorld(r.seed, r.specId, mods);
}

/**
 * Play a replay to the end (or maxTicks). Choices are applied while the world is paused at their tick.
 * Returns the world; check world.tick, world.over, hashWorld(world).
 */
export function playReplay(r: Replay, maxTicks = Infinity): World {
  if (!replayCompatible(r)) throw new ReplayVersionError(r.v);
  const w = worldForReplay(r);
  let ci = 0;
  let fi = 0;
  let guard = 0;
  while (fi < r.frames.length && w.tick < maxTicks && !w.over) {
    while (w.offer.open !== null && ci < r.choices.length && r.choices[ci].tick === w.tick) {
      choose(w, r.choices[ci++].code);
    }
    if (w.offer.open !== null) {
      // replay has no choice for this pause: invalid / truncated
      if (++guard > 4) break;
      continue;
    }
    w.events.clear();
    if (step(w, r.frames[fi])) fi++;
  }
  return w;
}

/** Hash everything that matters for determinism. Equal hashes = same run (with overwhelming probability). */
export function hashWorld(w: World): number {
  const h = new StateHasher();
  h.int(w.tick).int(w.layer).int(w.over ? 1 : 0).int(w.deathCause);
  const p = w.player;
  h.num(p.x).num(p.y).num(p.hp).num(p.maxHp).int(p.dashCharges).int(p.dashCd);
  for (const r of [w.rng.spawn, w.rng.hazard, w.rng.boss, w.rng.jitter, w.rng.combat, w.rng.loot]) h.int(r.s);
  const en = w.en;
  h.int(en.count).int(en.hi).array(en.alive, en.hi).array(en.x, en.hi).array(en.y, en.hi).array(en.hp, en.hi);
  h.int(w.pr.count).array(w.pr.alive, w.pr.hi).array(w.pr.x, w.pr.hi).array(w.pr.y, w.pr.hi);
  h.int(w.gm.count).array(w.gm.alive, w.gm.hi).array(w.gm.x, w.gm.hi).array(w.gm.value, w.gm.hi);
  h.int(w.zn.count).int(w.tg.count).array(w.tg.alive, w.tg.hi).array(w.tg.x, w.tg.hi);
  h.int(w.xp.level).num(w.xp.xp).num(w.score.totalDamage).int(w.score.kills).int(w.offer.pickIdx).int(w.offer.historyHash);
  h.array(w.build.slotSpell).array(w.build.slotRank);
  return h.digest();
}

// --- storage encoding: RLE (byte, run<=255) pairs, base64 ----------------------------------------

export function rleEncode(frames: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < frames.length; ) {
    const b = frames[i];
    let run = 1;
    while (i + run < frames.length && frames[i + run] === b && run < 255) run++;
    out.push(b, run);
    i += run;
  }
  return Uint8Array.from(out);
}
export function rleDecode(data: Uint8Array): Uint8Array {
  let n = 0;
  for (let i = 1; i < data.length; i += 2) n += data[i];
  const out = new Uint8Array(n);
  let k = 0;
  for (let i = 0; i + 1 < data.length; i += 2) out.fill(data[i], k, (k += data[i + 1]));
  return out;
}

const toB64 = (u: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
};
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Compact JSON string for saving/sharing a replay. */
export function serializeReplay(r: Replay): string {
  const o: Record<string, unknown> = { v: r.v, seed: r.seed, specId: r.specId, f: toB64(rleEncode(r.frames)), c: r.choices.map((c) => [c.tick, c.code]) };
  if (r.tags?.length) o.t = r.tags;
  return JSON.stringify(o);
}
/** Parse a stored replay. The version is kept as recorded; playReplay refuses a mismatch (see replayCompatible). */
export function deserializeReplay(s: string): Replay {
  const o = JSON.parse(s) as { v: number; seed: SeedConfig; specId: SpecId; f: string; c: [number, number][]; t?: string[] };
  const r: Replay = { v: Number(o.v) || 0, seed: o.seed, specId: o.specId, frames: rleDecode(fromB64(o.f)), choices: o.c.map(([tick, code]) => ({ tick, code })) };
  if (Array.isArray(o.t) && o.t.length) r.tags = o.t.filter((x): x is string => typeof x === 'string');
  return r;
}
