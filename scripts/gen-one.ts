/** Worker for gen-levels.ts: generates the listed levels into a JSON file. */
import { writeFileSync } from 'node:fs';
import { generateLevel, targetWinRate } from '../src/game/gen';

const [out, seedArg, ...levelArgs] = process.argv.slice(2);
const seed = Number(seedArg);
const res: unknown[] = [];
for (const arg of levelArgs) {
  const level = Number(arg);
  const c = generateLevel(level, seed, { tries: level >= 50 ? 120 : 60, runs: 150 });
  res.push(c.def);
  console.log(`L${level}: ${c.def.cols}x${c.def.rows} ${c.def.cells.filter((x) => x >= 0).length} pieces, bench ${c.def.benchSlots}, win ${c.winRate.toFixed(2)} (target ${targetWinRate(level)}), near-miss ${c.nearMissRate.toFixed(2)}, auto ${c.cascadeShare.toFixed(2)}`);
}
writeFileSync(out, JSON.stringify(res));
