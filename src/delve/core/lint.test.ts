/**
 * Determinism lint: sim/, content/ and core/ (except daily.ts, replay.ts I/O helpers and tests)
 * must not use non-deterministic or engine-dependent APIs.
 */
import { describe, expect, it } from 'vitest';
import { BAL, CAP, SIM_VERSION, TIMELINE, WORLD } from './constants';

// vite's raw glob: no node fs needed (the repo has no @types/node)
const SOURCES = import.meta.glob(['../sim/**/*.ts', '../content/**/*.ts', '../core/**/*.ts', '!../**/*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
// daily.ts formats calendar labels for the UI; it is a pure function of the time the app passes in.
const isExempt = (rel: string): boolean => /(^\.\/|\/core\/)daily\.ts$/.test(rel);
const BANNED: [RegExp, string][] = [
  [/Math\.(random|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|exp|expm1|log|log2|log10|log1p|pow|hypot|cbrt)\b/, 'transcendental/random Math'],
  [/\bDate\b/, 'Date'],
  [/performance\.now/, 'performance.now'],
  [/\*\*/, '** operator (use fpow)'],
  [/\bcrypto\./, 'crypto'],
];

describe('determinism lint', () => {
  it('scans the sim sources', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(20);
  });
  it('no banned APIs in sim code', () => {
    const problems: string[] = [];
    for (const [rel, raw] of Object.entries(SOURCES)) {
      if (isExempt(rel)) continue;
      const src = raw.replace(/\/\*[\s\S]*?\*\//g, (m: string) => m.replace(/[^\n]/g, ' '));
      src.split('\n').forEach((line: string, i: number) => {
        const code = line.replace(/\/\/.*$/, '');
        for (const [re, why] of BANNED) if (re.test(code)) problems.push(`${rel}:${i + 1} ${why}: ${line.trim()}`);
      });
    }
    expect(problems).toEqual([]);
  });
});

// --- SIM_VERSION guard: changing sim constants without bumping SIM_VERSION would let stored replays replay wrongly.

/** FNV-1a over the JSON of the sim constant tables. */
function constantsHash(): string {
  const s = JSON.stringify({ BAL, CAP, TIMELINE, WORLD });
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16);
}

/** SIM_VERSION -> constants hash. When you change BAL/CAP/TIMELINE/WORLD: bump SIM_VERSION and add the new hash. */
const KNOWN: Record<number, string> = { 2: 'cac0b8aa' };

describe('SIM_VERSION', () => {
  it('is bumped whenever the sim constants change', () => {
    expect(constantsHash()).toBe(KNOWN[SIM_VERSION]);
  });
});
