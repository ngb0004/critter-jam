/**
 * Repair pass over public/levels.json: re-measures every level with more runs,
 * and regenerates any that sit far off the curve or that a casual player can
 * almost never win, trying several fresh seeds and keeping the closest.
 *   npx tsx scripts/repair-levels.ts [maxOff=0.18] [minWin=0.12]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CAREFUL, CASUAL, measure } from '../src/game/bot';
import { generateLevel, targetWinRate } from '../src/game/gen';
import { LevelDef } from '../src/game/jam';

const maxOff = Number(process.argv[2] ?? 0.18);
const minWin = Number(process.argv[3] ?? 0.12);
const levels = JSON.parse(readFileSync('public/levels.json', 'utf8')) as LevelDef[];
const t0 = Date.now();
let repaired = 0;
for (let i = 0; i < levels.length; i++) {
  const level = i + 1;
  const target = targetWinRate(level);
  const d = measure(levels[i], CASUAL, 200, 11);
  const careful = measure(levels[i], CAREFUL, 80, 12).winRate;
  const bad = Math.abs(d.winRate - target) > maxOff || d.winRate < minWin || careful < Math.min(0.5, target + 0.1);
  if (!bad) continue;
  let best = { def: levels[i], off: Math.abs(d.winRate - target), win: d.winRate, careful };
  for (const seed of [21, 34, 55, 89, 144, 233]) {
    const c = generateLevel(level, seed, { tries: level >= 50 ? 140 : 80, runs: 150 });
    const cw = measure(c.def, CAREFUL, 80, 12).winRate;
    const off = Math.abs(c.winRate - target) + (cw < Math.min(0.5, target + 0.1) ? 0.3 : 0);
    if (off < best.off) best = { def: c.def, off, win: c.winRate, careful: cw };
    if (best.off < 0.06) break;
  }
  if (best.def !== levels[i]) {
    levels[i] = best.def;
    repaired++;
  }
  console.log(`L${level}: was ${d.winRate.toFixed(2)} (careful ${careful.toFixed(2)}) → now ${best.win.toFixed(2)} (careful ${best.careful.toFixed(2)}) target ${target}`);
}
writeFileSync('public/levels.json', JSON.stringify(levels));
console.log(`repaired ${repaired} levels in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
