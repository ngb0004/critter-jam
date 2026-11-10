/**
 * RENDER contract guard: presentation code never writes the World and never calls the sim's movers.
 * Static scan of src/delve/render/*.ts (debug.ts is exempt: its stress rig builds and edits its OWN private
 * World behind ?debug and never touches the live run).
 */
import { describe, expect, it } from 'vitest';

// vite's raw glob: no node fs needed (the repo has no @types/node)
const SOURCES = import.meta.glob(['./*.ts', '!./*.test.ts', '!./debug.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const files = Object.keys(SOURCES).map((k) => k.replace('./', ''));
const read = (f: string): string => SOURCES['./' + f];

/** Identifiers that hold a World in render code. */
const WORLD_VARS = ['w', 'world', 'liveWorld', 'f.w'];

describe('render is read-only', () => {
  it('has files to scan', () => {
    expect(files.length).toBeGreaterThan(4);
  });

  for (const f of files) {
    it(`${f} never assigns into the World`, () => {
      const src = read(f)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      const bad: string[] = [];
      for (const v of WORLD_VARS) {
        const esc = v.replace('.', '\\.');
        // w.anything... = value (not ==), compound assignment, ++/--
        const re = new RegExp(`(?<![\\w.])${esc}\\.[\\w.\\[\\]+\\-* ]*?(?<![=!<>])(=(?!=)|\\+=|-=|\\*=|/=|\\+\\+|--)`, 'g');
        for (const m of src.matchAll(re)) {
          const line = src.slice(0, m.index).split('\n').length;
          bad.push(`${f}:${line}: ${m[0]}`);
        }
      }
      expect(bad).toEqual([]);
    });

    it(`${f} never steps the sim or pushes events`, () => {
      const src = read(f);
      expect(src).not.toMatch(/\b(step|choose)\s*\(\s*w\b/);
      expect(src).not.toMatch(/events\.push\(/);
      expect(src).not.toMatch(/from '\.\.\/sim\//);
    });
  }
});
