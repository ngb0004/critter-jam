/**
 * Delve Daily bot population on the REAL sim (BOT). Parallel (child processes), deterministic.
 *
 *   npx tsx scripts/delve-pop.ts [--players 400] [--days 312,319,326] [--workers 4] [--omen-bots 24]
 *                                [--write-table] [--json out.json] [--quick]
 *
 * Population (per day, daily best per player, spec 7.5 tiers):
 *   casual 50%  e 0.00-0.35  random/decent picks   1-2 attempts
 *   average 30% e 0.30-0.55  decent/greedy          1-3
 *   good 15%    e 0.55-0.80  decent/greedy          2-5
 *   great 4%    e 0.80-0.93  decent/greedy          6-12
 *   elite 1%    e 0.93-1.00  greedy/decent          10-20
 * (BOT v0.2 moved casual/average down: the QA naive personas, which play like first-day humans, died at 2-3 min
 * while the old casual tier lived to ~7 min; spec 7.5's casual median is 4:14.)
 * Prints: daily-best percentiles overall / per tier / per spec, death causes, the largest 10 s bucket,
 * runs past 14:00, an Omen experiment (same bots, Omen forced off / Swarming / Ironhide), fusion counts,
 * picks per minute, onboarding (first card, layer 3 reach), fusions and 12:00 reach per tier. --write-table
 * regenerates src/delve/bot/population.ts (the pooled "Top N% est." table plus one table per weekly Omen).
 */
import { fork } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { seedForDay } from '../src/delve/core/daily';
import { Rng } from '../src/delve/core/rng';
import type { SpecId } from '../src/delve/core/types';
import type { PickPolicy } from '../src/delve/bot/bot';
import { runBot, type RunResult } from '../src/delve/bot/runner';
import { BAL } from '../src/delve/core/constants';
import { SPELLS } from '../src/delve/content/spells';
import { ENEMIES } from '../src/delve/content/enemies';

/** --set hp0=14,spell.firebolt.damage=20,enemy.bat.speed=4 : runtime overrides for sweeps (never saved). */
function applySet(spec: string): void {
  if (!spec) return;
  for (const kv of spec.split(',')) {
    const [k, v] = kv.split('=');
    const parts = k.split('.');
    const num = Number(v);
    if (parts[0] === 'spell') (SPELLS.find((x) => x.id === parts[1]) as unknown as Record<string, number>)[parts[2]] = num;
    else if (parts[0] === 'enemy') (ENEMIES.find((x) => x.id === parts[1]) as unknown as Record<string, number>)[parts[2]] = num;
    else if (parts.length === 2 && Array.isArray((BAL as unknown as Record<string, unknown>)[parts[0]])) ((BAL as unknown as Record<string, number[]>)[parts[0]])[Number(parts[1])] = num;
    else if (parts[0] === 'dmgScale') {
      // scale every spell's hit and status damage (sweeps only)
      for (const sp of SPELLS) {
        (sp as unknown as Record<string, number>).damage *= num;
        if (sp.status) (sp.status as unknown as Record<string, number>).dps *= num;
      }
    }
    else {
      if (!(k in BAL)) throw new Error(`unknown BAL key ${k}`);
      (BAL as unknown as Record<string, number>)[k] = num;
    }
  }
}

interface Job {
  id: number;
  group: 'pop' | 'omen';
  player: number;
  tier: string;
  day: number;
  attempt: number;
  spec: SpecId;
  e: number;
  policy: PickPolicy;
  botSeed: number;
  omenId?: string;
}
type Res = Omit<RunResult, 'replay'> & { job: Job };

// ------------------------------------------------------------------ worker
function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}

const TIERS = [
  { name: 'casual', share: 0.5, lo: 0.0, hi: 0.35, pol: [['random', 0.5], ['decent', 0.5]], att: [1, 2] },
  { name: 'average', share: 0.3, lo: 0.3, hi: 0.55, pol: [['decent', 0.8], ['greedy', 0.2]], att: [1, 3] },
  { name: 'good', share: 0.15, lo: 0.55, hi: 0.8, pol: [['decent', 0.5], ['greedy', 0.5]], att: [2, 5] },
  { name: 'great', share: 0.04, lo: 0.8, hi: 0.93, pol: [['decent', 0.6], ['greedy', 0.4]], att: [6, 12] },
  { name: 'elite', share: 0.01, lo: 0.93, hi: 1.0, pol: [['greedy', 0.5], ['decent', 0.5]], att: [10, 20] },
] as const;

function buildJobs(players: number, days: number[], omenBots: number): Job[] {
  const jobs: Job[] = [];
  let id = 0;
  const r = new Rng(0xb07b07);
  for (const day of days) {
    for (let p = 0; p < players; p++) {
      // stratified tiers so small populations keep the exact shares
      const u = (p + 0.5) / players;
      let acc = 0;
      let tier: (typeof TIERS)[number] = TIERS[0];
      for (const t of TIERS) {
        acc += t.share;
        if (u < acc) {
          tier = t;
          break;
        }
        tier = t;
      }
      const e = tier.lo + (tier.hi - tier.lo) * r.next();
      const pu = r.next();
      const policy = (pu < tier.pol[0][1] ? tier.pol[0][0] : tier.pol[1][0]) as PickPolicy;
      const spec: SpecId = p % 2 === 0 ? 'ember' : 'venom';
      const attempts = tier.att[0] + r.int(tier.att[1] - tier.att[0] + 1);
      const botSeed = (r.next() * 4294967296) >>> 0;
      for (let a = 0; a < attempts; a++) {
        jobs.push({ id: id++, group: 'pop', player: day * 100000 + p, tier: tier.name, day, attempt: a, spec, e, policy, botSeed: (botSeed + a * 7919) >>> 0 });
      }
    }
  }
  // Omen experiment: the same mid-skill bots under no Omen / Swarming / Ironhide
  for (const day of days) {
    for (let b = 0; b < omenBots; b++) {
      const spec: SpecId = b % 2 === 0 ? 'ember' : 'venom';
      const e = 0.5 + 0.3 * ((b * 0.618) % 1);
      for (const omenId of ['', 'swarming', 'ironhide']) {
        jobs.push({ id: id++, group: 'omen', player: b, tier: 'omen', day, attempt: b % 3, spec, e, policy: 'greedy', botSeed: 1000 + b, omenId });
      }
    }
  }
  return jobs;
}

async function runAll(jobs: Job[], workers: number): Promise<Res[]> {
  // longest-first is unknown; interleave and hand out small batches
  const queue = jobs.slice();
  const results: Res[] = [];
  const script = resolve(import.meta.dirname, 'delve-pop.ts');
  const t0 = Date.now();
  let done = 0;
  await Promise.all(
    Array.from({ length: workers }, () =>
      new Promise<void>((res, rej) => {
        const child = fork(script, ['--worker', '--set', arg('set', '')], { execArgv: ['--import', 'tsx'] });
        const feed = (): void => {
          const batch = queue.splice(0, 6);
          if (batch.length === 0) {
            child.kill();
            res();
            return;
          }
          child.send(batch);
        };
        child.on('message', (out: Res[]) => {
          results.push(...out);
          done += out.length;
          if (done % 120 < out.length) process.stderr.write(`  ${done}/${jobs.length} runs (${((Date.now() - t0) / 1000).toFixed(0)} s)\n`);
          feed();
        });
        child.on('error', rej);
        feed();
      }),
    ),
  );
  return results;
}

const fmt = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function q(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const x = (p / 100) * (sorted.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  return i + 1 < sorted.length ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i];
}
const median = (a: number[]): number => q(a.slice().sort((x, y) => x - y), 50);
function pctLine(label: string, vals: number[]): string {
  const s = vals.slice().sort((a, b) => a - b);
  return `${label.padEnd(16)} n=${String(s.length).padStart(5)}  p10 ${fmt(q(s, 10))}  p25 ${fmt(q(s, 25))}  p50 ${fmt(q(s, 50))}  p75 ${fmt(q(s, 75))}  p90 ${fmt(q(s, 90))}  p99 ${fmt(q(s, 99))}  max ${fmt(s[s.length - 1] ?? 0)}`;
}

/** --ladder N: fixed skill rungs x both specs x days, N attempts each (decent picks): the skill curve. */
async function ladder(n: number): Promise<void> {
  const days = arg('days', '312,319,326').split(',').map(Number);
  const workers = Number(arg('workers', String(Math.max(1, cpus().length))));
  const rungs = arg('rungs', '0.05,0.2,0.35,0.5,0.65,0.8,0.95').split(',').map(Number);
  const jobs: Job[] = [];
  let id = 0;
  for (const e of rungs) for (const spec of ['ember', 'venom'] as SpecId[]) for (const day of days) for (let a = 0; a < n; a++) {
    jobs.push({ id: id++, group: 'pop', player: id, tier: String(e), day, attempt: a, spec, e, policy: (arg('policy', 'decent') as PickPolicy), botSeed: 500 + a * 31 + day });
  }
  if (arg('set', '')) console.log(`overrides: ${arg('set', '')}`);
  const t0 = Date.now();
  const res = await runAll(jobs, workers);
  console.log(`ladder: ${jobs.length} runs in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  const causeName = ['-', 'chip', 'red', 'boss', 'wyrm'];
  for (const e of rungs) {
    const parts: string[] = [];
    for (const spec of ['ember', 'venom']) {
      const sel = res.filter((r) => r.job.e === e && r.job.spec === spec);
      const ss = sel.map((r) => r.sec).sort((a, b) => a - b);
      parts.push(`${spec} p25 ${fmt(q(ss, 25))} p50 ${fmt(q(ss, 50))} p75 ${fmt(q(ss, 75))}`);
    }
    const sel = res.filter((r) => r.job.e === e);
    const c = [0, 0, 0, 0, 0];
    for (const r of sel) c[r.cause]++;
    const fp = median(sel.map((r) => r.firstPick));
    console.log(`e ${e.toFixed(2)}  ${parts.join(' | ')} | ${c.map((x, i) => (i ? `${causeName[i]} ${Math.round((100 * x) / sel.length)}%` : '')).join(' ').trim()} | xp ${(100 * median(sel.map((r) => r.xpShare))).toFixed(0)}% fp ${fp.toFixed(0)}s fus ${(sel.reduce((s2, r) => s2 + r.fusions, 0) / sel.length).toFixed(1)}`);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--ladder')) return ladder(Number(arg('ladder', '4')));
  const quick = process.argv.includes('--quick');
  const players = Number(arg('players', quick ? '120' : '400'));
  const days = arg('days', '312,319,326').split(',').map(Number);
  const workers = Number(arg('workers', String(Math.max(1, cpus().length))));
  const omenBots = Number(arg('omen-bots', quick ? '0' : '24'));
  const jobs = buildJobs(players, days, omenBots);
  const t0 = Date.now();
  if (arg('set', '')) console.log(`overrides: ${arg('set', '')}`);
  console.log(`delve-pop: ${players} players x days ${days.join(',')} (+${omenBots} omen bots/day x 3), ${jobs.length} runs on ${workers} workers`);
  const res = await runAll(jobs, workers);
  const wall = (Date.now() - t0) / 1000;
  res.sort((a, b) => a.job.id - b.job.id);
  const pop = res.filter((r) => r.job.group === 'pop');
  const simSec = pop.reduce((s, r) => s + r.sec, 0);
  console.log(`done in ${wall.toFixed(0)} s wall (${(simSec / 60).toFixed(0)} sim-minutes, ${(simSec / wall).toFixed(0)}x real time)\n`);

  // daily bests
  const best = new Map<number, Res>();
  for (const r of pop) {
    const b = best.get(r.job.player);
    if (!b || r.sec > b.sec) best.set(r.job.player, r);
  }
  const bests = [...best.values()];
  const secs = bests.map((r) => r.sec);
  console.log('== Daily best (one per player per day) ==');
  console.log(pctLine('ALL', secs));
  for (const t of TIERS) console.log(pctLine(t.name, bests.filter((r) => r.job.tier === t.name).map((r) => r.sec)));
  for (const sp of ['ember', 'venom']) console.log(pctLine(sp, bests.filter((r) => r.job.spec === sp).map((r) => r.sec)));
  for (const d of days) console.log(pctLine(`day ${d}`, bests.filter((r) => r.job.day === d).map((r) => r.sec)));
  for (const o of omensOf(days)) console.log(pctLine(`omen ${o}`, bests.filter((r) => seedForDay(r.job.day).omenId === o).map((r) => r.sec)));
  for (const pol of ['random', 'decent', 'greedy']) console.log(pctLine(`policy ${pol}`, bests.filter((r) => r.job.policy === pol).map((r) => r.sec)));
  const s = secs.slice().sort((a, b) => a - b);
  const p50 = q(s, 50);
  console.log(`ratios p90/p50 ${(q(s, 90) / p50).toFixed(3)}  p99/p50 ${(q(s, 99) / p50).toFixed(3)}  CV ${(sd(secs) / mean(secs)).toFixed(3)}`);

  // spec spread per tier (daily best medians)
  console.log('\n== Spec spread (median daily best, ember / venom, max/min) ==');
  for (const t of [...TIERS.map((x) => x.name), 'ALL']) {
    const sel = bests.filter((r) => t === 'ALL' || r.job.tier === t);
    const me = median(sel.filter((r) => r.job.spec === 'ember').map((r) => r.sec));
    const mv = median(sel.filter((r) => r.job.spec === 'venom').map((r) => r.sec));
    console.log(`${t.padEnd(8)} ember ${fmt(me)}  venom ${fmt(mv)}  spread ${(Math.max(me, mv) / Math.min(me, mv)).toFixed(3)}`);
  }

  // 10 s buckets on daily bests
  const buckets = new Map<number, number>();
  for (const v of secs) buckets.set(Math.floor(v / 10), (buckets.get(Math.floor(v / 10)) ?? 0) + 1);
  let bk = 0;
  let bn = 0;
  for (const [k, n] of buckets) if (n > bn) [bk, bn] = [k, n];
  const top5 = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log(`\n== Largest 10 s bucket (daily best): ${fmt(bk * 10)}-${fmt(bk * 10 + 10)} ${((100 * bn) / secs.length).toFixed(2)}%  (top 5: ${top5.map(([k, n]) => `${fmt(k * 10)} ${((100 * n) / secs.length).toFixed(1)}%`).join(', ')})`);
  // histogram (30 s)
  console.log('histogram (30 s bins, daily best):');
  const h30 = new Map<number, number>();
  for (const v of secs) h30.set(Math.floor(v / 30), (h30.get(Math.floor(v / 30)) ?? 0) + 1);
  const maxB = Math.max(...h30.values());
  for (let k = 0; k <= Math.max(...h30.keys()); k++) {
    const n = h30.get(k) ?? 0;
    console.log(`  ${fmt(k * 30).padStart(5)} ${'#'.repeat(Math.round((40 * n) / maxB)).padEnd(40)} ${((100 * n) / secs.length).toFixed(1)}%`);
  }

  // all runs: bounds and causes
  const all = res;
  const maxRun = Math.max(...all.map((r) => r.sec));
  console.log(`\n== Bound: longest run ${fmt(maxRun)} (${maxRun.toFixed(2)} s); runs past 14:00: ${all.filter((r) => r.sec >= 840).length}; past 14:32: ${all.filter((r) => r.sec > 872).length}; unfinished: ${all.filter((r) => r.cause === 0).length}`);
  const causeName = ['none', 'overrun (chip)', 'red floor (burst)', 'boss', 'wyrmfall'];
  const causes = [0, 0, 0, 0, 0];
  for (const r of pop) causes[r.cause]++;
  console.log('== Death causes (all population runs) ==');
  console.log('  ' + causes.map((n, i) => `${causeName[i]} ${((100 * n) / pop.length).toFixed(1)}%`).join('  '));
  for (const t of TIERS) {
    const sel = pop.filter((r) => r.job.tier === t.name);
    const c = [0, 0, 0, 0, 0];
    for (const r of sel) c[r.cause]++;
    console.log(`  ${t.name.padEnd(8)} ` + c.map((n, i) => `${causeName[i].split(' ')[0]} ${((100 * n) / Math.max(1, sel.length)).toFixed(0)}%`).join('  '));
  }
  const dmg = [0, 0, 0, 0, 0];
  for (const r of pop) r.dmgByCause.forEach((v, i) => (dmg[i] += v));
  const dsum = dmg.reduce((a, b) => a + b, 0) || 1;
  console.log('  damage taken share: ' + dmg.map((v, i) => `${causeName[i].split(' ')[0]} ${((100 * v) / dsum).toFixed(0)}%`).slice(1).join('  '));

  // onboarding (casual)
  console.log('\n== Onboarding ==');
  for (const t of ['casual', 'average']) {
    const sel = pop.filter((r) => r.job.tier === t);
    const fp = sel.map((r) => r.firstPick).filter((v) => v >= 0).sort((a, b) => a - b);
    console.log(`  ${t}: reach layer 3 (2:00) ${((100 * sel.filter((r) => r.sec >= 120).length) / sel.length).toFixed(0)}% of runs; first card p50 ${q(fp, 50).toFixed(1)} s, p90 ${q(fp, 90).toFixed(1)} s, within 15 s ${((100 * fp.filter((v) => v <= 15).length) / sel.length).toFixed(0)}%; L1 boss killed ${((100 * sel.filter((r) => r.bossKillAt[0] >= 0).length) / sel.length).toFixed(0)}%, L3 ${((100 * sel.filter((r) => r.bossKillAt[2] >= 0).length) / sel.length).toFixed(0)}%`);
  }
  const bossT = [0, 1, 2, 3, 4].map((b) => {
    const k = pop.map((r) => r.bossKillAt[b]).filter((v) => v >= 0).map((v) => v - (b * 60 + 40));
    return `L${b + 1} ${k.length ? median(k).toFixed(0) : '-'} s`;
  });
  console.log(`  median boss kill time after spawn: ${bossT.join(', ')}`);

  // picks per minute
  console.log('\n== Level-up cards per minute (mean over runs alive that minute) ==');
  const line: string[] = [];
  for (let m = 0; m < 14; m++) {
    const alive = pop.filter((r) => r.sec >= (m + 1) * 60);
    if (alive.length < 5) break;
    line.push(`${m}:${(alive.reduce((s2, r) => s2 + (r.picksByMin[m] ?? 0), 0) / alive.length).toFixed(1)}`);
  }
  console.log('  ' + line.join('  '));
  const gaps = pop.filter((r) => r.sec >= 300).map((r) => r.maxPickGap);
  console.log(`  longest Descent gap between cards: p50 ${median(gaps).toFixed(1)} s`);

  // fusions
  console.log('\n== Fusions ==');
  const fc = new Map<string, number>();
  let nf = [0, 0, 0, 0];
  for (const r of pop) {
    nf[Math.min(3, r.fusions)]++;
    for (const f of r.fusionIds) fc.set(f, (fc.get(f) ?? 0) + 1);
  }
  console.log(`  runs with 0/1/2/3 fusions: ${nf.map((n) => ((100 * n) / pop.length).toFixed(0) + '%').join(' / ')}`);
  console.log(`  by fusion: ${[...fc.entries()].map(([k, n]) => `${k} ${n}`).join(', ')}`);
  for (const t of TIERS) {
    const sel = pop.filter((r) => r.job.tier === t.name);
    const fb = bests.filter((r) => r.job.tier === t.name);
    console.log(`  ${t.name.padEnd(8)} runs with a fusion ${((100 * sel.filter((r) => r.fusions > 0).length) / Math.max(1, sel.length)).toFixed(0)}%, daily bests with a fusion ${((100 * fb.filter((r) => r.fusions > 0).length) / Math.max(1, fb.length)).toFixed(0)}%, reached 12:00 ${sel.filter((r) => r.sec >= 720).length}/${sel.length} runs`);
  }
  for (const sp of ['ember', 'venom']) {
    const sel = pop.filter((r) => r.job.spec === sp && r.fusionAt.length);
    console.log(`  ${sp}: first fusion median ${sel.length ? fmt(median(sel.map((r) => r.fusionAt[0]))) : '-'} (${sel.length} runs)`);
  }
  const lateRuns = pop.filter((r) => r.sec >= 720);
  if (lateRuns.length) console.log(`  Wyrmfall: ${lateRuns.length} runs reached 12:00, stagger median ${median(lateRuns.map((r) => r.stagger)).toFixed(0)} s, max ${Math.max(...lateRuns.map((r) => r.stagger))} s`);

  // omen experiment
  const om = res.filter((r) => r.job.group === 'omen');
  if (om.length) {
    console.log('\n== Omen effect (same greedy bots e 0.5-0.8, median survival vs no Omen) ==');
    for (const o of ['swarming', 'ironhide']) {
      const parts: string[] = [];
      for (const sp of ['ember', 'venom', 'all']) {
        const base = om.filter((r) => r.job.omenId === '' && (sp === 'all' || r.job.spec === sp)).map((r) => r.sec);
        const with_ = om.filter((r) => r.job.omenId === o && (sp === 'all' || r.job.spec === sp)).map((r) => r.sec);
        const m0 = median(base);
        const m1 = median(with_);
        parts.push(`${sp} ${fmt(m0)} -> ${fmt(m1)} (${m1 >= m0 ? '+' : ''}${((100 * (m1 - m0)) / m0).toFixed(1)}%)`);
      }
      console.log(`  ${o.padEnd(9)} ${parts.join('  ')}`);
    }
  }

  if (process.argv.includes('--write-table')) {
    const byOmen: Record<string, number[]> = {};
    for (const o of omensOf(days)) byOmen[o] = bests.filter((r) => seedForDay(r.job.day).omenId === o).map((r) => r.sec);
    writeTable(secs, days, players, pop.length, byOmen);
  }
  const json = arg('json', '');
  if (json) writeFileSync(json, JSON.stringify(res));
}

function mean(a: number[]): number {
  return a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
}
function sd(a: number[]): number {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / Math.max(1, a.length - 1));
}

/** The Omens the given days run under (weekly Omen of each day), in first-seen order. */
function omensOf(days: number[]): string[] {
  const out: string[] = [];
  for (const d of days) {
    const o = seedForDay(d).omenId;
    if (o && !out.includes(o)) out.push(o);
  }
  return out;
}

function quantileTable(secs: number[]): [number, number][] {
  const s = secs.slice().sort((a, b) => a - b);
  const ps = [0, 1, 5, 10, 25, 50, 75, 90, 95, 99, 99.9];
  const quantiles: [number, number][] = [];
  for (const p of ps) {
    let v = Math.round(q(s, p));
    if (quantiles.length && v <= quantiles[quantiles.length - 1][1]) v = quantiles[quantiles.length - 1][1] + 1;
    quantiles.push([p, v]);
  }
  quantiles.push([100, Math.max(872, quantiles[quantiles.length - 1][1] + 1)]);
  return quantiles;
}

function writeTable(secs: number[], days: number[], players: number, runs: number, byOmen: Record<string, number[]>): void {
  const quantiles = quantileTable(secs);
  const omenRows = Object.entries(byOmen)
    .filter(([, v]) => v.length >= 100)
    .map(([o, v]) => {
      const od = days.filter((d) => seedForDay(d).omenId === o);
      return `  ${o}: {
    source: 'bot-population estimate, ${o} days ${od.join(', ')}: ${v.length} real-sim daily bests (scripts/delve-pop.ts)',
    quantiles: ${JSON.stringify(quantileTable(v))},
  },`;
    });
  const src = `/**
 * BOT-POPULATION ESTIMATE, not real players. Generated by scripts/delve-pop.ts --write-table on the real sim:
 * ${players} bot players x days ${days.join(', ')} (${secs.length} daily bests from ${runs} runs), tiered skill
 * (casual 50% / average 30% / good 15% / great 4% / elite 1%), kiting bots with human-like reaction and noise,
 * random / decent / greedy pick policies, 1-20 attempts per tier. Survival time in seconds.
 * The UI must always label this as an estimate ("Top 18% est."). Regenerate after balance changes.
 *
 * BOT_POPULATION is every day pooled (what app/percentile.ts shows). BOT_POPULATION_BY_OMEN holds one table per
 * weekly Omen (only the days that ran under it); populationForOmen(id) returns it, or the pooled table for an Omen
 * without one. UI: pass populationForOmen(seed.omenId) as the \`pop\` argument of topLabel / topPercent / shareRank.
 */
import type { Population } from '../app/percentile';

export const BOT_POPULATION: Population = {
  source: 'bot-population estimate: ${secs.length} real-sim daily bests (scripts/delve-pop.ts)',
  quantiles: ${JSON.stringify(quantiles)},
};

/** Per-Omen tables (daily bests on the days that ran under that weekly Omen). */
export const BOT_POPULATION_BY_OMEN: Readonly<Record<string, Population>> = {
${omenRows.join('\n')}
};

/** The table for a day's Omen (falls back to the pooled table). */
export function populationForOmen(omenId: string): Population {
  return Object.prototype.hasOwnProperty.call(BOT_POPULATION_BY_OMEN, omenId) ? BOT_POPULATION_BY_OMEN[omenId] : BOT_POPULATION;
}
`;
  writeFileSync(resolve(import.meta.dirname, '../src/delve/bot/population.ts'), src);
  console.log(`\nwrote src/delve/bot/population.ts: ${JSON.stringify(quantiles)}`);
  for (const [o, v] of Object.entries(byOmen)) console.log(`  ${o} (${v.length}): ${v.length >= 100 ? JSON.stringify(quantileTable(v)) : 'too few daily bests, not written'}`);
}

// ------------------------------------------------------------------ entry
if (process.argv.includes('--worker')) {
  applySet(arg('set', ''));
  process.on('message', (jobs: Job[]) => {
    const out: Res[] = [];
    for (const j of jobs) {
      const r = runBot({
        seed: seedForDay(j.day, j.attempt),
        spec: j.spec,
        bot: { skill: { e: j.e }, policy: j.policy, seed: j.botSeed },
        omenId: j.omenId,
      });
      delete r.replay;
      out.push({ ...r, job: j });
    }
    process.send!(out);
  });
} else {
  main();
}

