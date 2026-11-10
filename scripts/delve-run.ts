/**
 * Headless Delve Daily runs (BOT). Usage: npx tsx scripts/delve-run.ts [spec=ember] [day=312] [runs=5]
 * Prints survival time, death cause, level, kills, bosses and the replay hash per run.
 */
import { seedForDay } from '../src/delve/core/daily';
import { hashWorld, Recorder } from '../src/delve/core/replay';
import { choose, createWorld, step } from '../src/delve/core/world';
import type { SpecId } from '../src/delve/core/types';
import { buildModifiers } from '../src/delve/content/omens';
import { botChoose, botInput } from '../src/delve/bot/bot';

const spec = (process.argv[2] ?? 'ember') as SpecId;
const day = Number(process.argv[3] ?? 312);
const runs = Number(process.argv[4] ?? 5);
const MAX = 60 * 60 * 16;

for (let a = 0; a < runs; a++) {
  const seed = seedForDay(day, a);
  const w = createWorld(seed, spec, buildModifiers(seed.omenId, seed.twistId));
  const rec = new Recorder(seed, spec);
  const t0 = performance.now();
  while (!w.over && w.tick < MAX) {
    if (w.offer.open) {
      const c = botChoose(w);
      if (choose(w, c)) rec.choice(w.tick, c);
      continue;
    }
    const f = botInput(w, { e: 0.4 + 0.15 * a });
    w.events.clear();
    if (step(w, f)) rec.frame(f);
  }
  const sec = w.tick / 60;
  console.log(
    `${spec} day ${day} attempt ${a}: ${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')} cause ${w.deathCause} lvl ${w.xp.level} kills ${w.score.kills} bosses ${w.score.bossesKilled} fusions ${w.score.fusions} hash ${hashWorld(w).toString(16)} (${(performance.now() - t0).toFixed(0)} ms, ${rec.finish().frames.length} frames)`,
  );
}
