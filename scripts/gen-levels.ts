/**
 * Generates the level set to public/levels.json, using every CPU core.
 *   npx tsx scripts/gen-levels.ts [count=120] [seed=1]
 * Each level is solver-verified and placed on the difficulty curve by the casual
 * bot (see scripts/gen-one.ts, the per-core worker).
 */
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const count = Number(process.argv[2] ?? 120);
const seed = Number(process.argv[3] ?? 1);
const workers = Math.max(1, Math.min(cpus().length, 8));
mkdirSync('.gen', { recursive: true });
const t0 = Date.now();
// Interleave levels across workers so each gets a similar mix of easy and hard.
const jobs = Array.from({ length: workers }, (_, w) => {
  const mine: number[] = [];
  for (let l = 1 + w; l <= count; l += workers) mine.push(l);
  return mine;
});
await Promise.all(
  jobs.map(
    (mine, w) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn('npx', ['tsx', 'scripts/gen-one.ts', `.gen/part-${w}.json`, String(seed), ...mine.map(String)], { stdio: ['ignore', 'inherit', 'inherit'] });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${w} exited ${code}`))));
      }),
  ),
);
const byLevel = new Map<number, unknown>();
for (let w = 0; w < workers; w++) for (const def of JSON.parse(readFileSync(`.gen/part-${w}.json`, 'utf8')) as { id: number }[]) byLevel.set(def.id, def);
writeFileSync('public/levels.json', JSON.stringify(Array.from({ length: count }, (_, i) => byLevel.get(i + 1))));
console.log(`wrote ${count} levels with ${workers} workers in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
