/**
 * Generates the level set to public/levels.json.
 *   npx tsx scripts/gen-levels.ts [count] [seed]
 * Each level is solver-verified and placed on the difficulty curve by the casual bot.
 */
import { writeFileSync } from 'node:fs';
import { generateLevel, targetWinRate } from '../src/game/gen';

const count = Number(process.argv[2] ?? 100);
const seed = Number(process.argv[3] ?? 1);
const out: unknown[] = [];
const t0 = Date.now();
let offSum = 0;
for (let level = 1; level <= count; level++) {
  const c = generateLevel(level, seed, { tries: 60, runs: 150 });
  const target = targetWinRate(level);
  offSum += Math.abs(c.winRate - target);
  out.push(c.def);
  if (level % 10 === 0 || level <= 3)
    console.log(
      `L${level}: ${c.def.cols}x${c.def.rows} ${c.def.cells.filter((x) => x >= 0).length} critters, bench ${c.def.benchSlots}, win ${c.winRate.toFixed(2)} (target ${target}), near-miss ${c.nearMissRate.toFixed(2)}`,
    );
}
writeFileSync('public/levels.json', JSON.stringify(out));
console.log(`wrote ${count} levels in ${((Date.now() - t0) / 1000).toFixed(0)}s, mean |win - target| ${(offSum / count).toFixed(3)}`);
