/**
 * Bot survival table (BOT / integrator). Usage: npx tsx scripts/delve-bots.ts [day=312] [attempts=3] [skills=0.5,0.75,0.95]
 */
import { seedForDay } from '../src/delve/core/daily';
import { choose, createWorld, step } from '../src/delve/core/world';
import type { SpecId } from '../src/delve/core/types';
import { buildModifiers } from '../src/delve/content/omens';
import { botChoose, botInput } from '../src/delve/bot/bot';

const day = Number(process.argv[2] ?? 312);
const attempts = Number(process.argv[3] ?? 3);
const skills = (process.argv[4] ?? '0.5,0.75,0.95').split(',').map(Number);
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
for (const spec of ['ember', 'venom'] as SpecId[]) {
  for (const e of skills) {
    const out: string[] = [];
    for (let a = 0; a < attempts; a++) {
      const seed = seedForDay(day, a);
      const w = createWorld(seed, spec, buildModifiers(seed.omenId, seed.twistId));
      while (!w.over && w.tick < 60 * 60 * 16) {
        if (w.offer.open) { choose(w, botChoose(w)); continue; }
        w.events.clear();
        step(w, botInput(w, { e }));
      }
      out.push(`${fmt(w.tick / 60)} c${w.deathCause} L${w.xp.level} b${w.score.bossesKilled} f${w.score.fusions}`);
    }
    console.log(`${spec} e=${e}: ${out.join(' | ')}`);
  }
}
