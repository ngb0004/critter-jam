// Ad 2, "So close": smooth play, then the tray fills with the last cart in sight. Fail ad of the real loop.
const path = require('path');
const { open, installLayer, setCaption, setCount, endCard, Frames, encode } = require('./common.cjs');

const out = process.argv[2];
const quick = process.argv.includes('--quick');
const level = Number(process.argv[process.argv.indexOf('--level') + 1] || 12);

(async () => {
  const { browser, page } = await open(`http://localhost:4191/critter-jam/?level=${level}&capture`, { dpr: quick ? 1 : 3 });
  // The player: good play until a few carts remain, then stumbles by benching the wrong
  // colours. Scout levels for one where that stumble ends in a late, believable loss.
  const policy = `
    const j = window.__jam;
    const s = j.state;
    if (!s || s.status !== 'playing') return { status: s ? s.status : '', left: 0, total: 0, bench: 0, slots: 0, progress: s ? s.boarded / s.def.cells.filter((c) => c >= 0).length : 0 };
    const v = s.def.vehicles[s.vehicleIdx];
    const cols = s.def.cols;
    const left = s.def.vehicles.length - s.vehicleIdx;
    const stumble = left <= STUMBLE_AT;
    const order = [];
    if (!stumble) {
      for (let c = 0; c < s.cells.length; c++) if (s.cells[c] === v || s.cells[c] === 40) order.push(c);
      for (let c = 0; c < s.cells.length; c++) { if (s.cells[c] < 0 || order.includes(c)) continue; const b = c + cols; if (b < s.cells.length && (s.cells[b] === v || s.cells[b] === 40)) order.push(c); }
    }
    const rest = [];
    for (let c = 0; c < s.cells.length; c++) if (s.cells[c] >= 0 && !order.includes(c) && s.cells[c] !== v && s.cells[c] !== 40) rest.push(c);
    const matches = [];
    for (let c = 0; c < s.cells.length; c++) if (s.cells[c] === v || s.cells[c] === 40) matches.push(c);
    const before = s.moves;
    for (const c of [...order, ...rest, ...matches]) { j.tap(c); if (j.state.moves !== before) break; }
    const t = j.state;
    return { status: t.status, left: t.def.vehicles.length - t.vehicleIdx, total: t.def.vehicles.length, bench: t.bench.length, slots: t.def.benchSlots, progress: t.boarded / t.def.cells.filter((c) => c >= 0).length };`;
  const stepFn = (stumbleAt) => new Function(policy.replace('STUMBLE_AT', String(stumbleAt)));
  const scout = async (lv, stumbleAt) => {
    await page.goto(`http://localhost:4191/critter-jam/?level=${lv}&capture`);
    await page.waitForTimeout(400);
    return page.evaluate(
      ([src, n]) => {
        const f = new Function(src.replace('STUMBLE_AT', String(n)));
        let r = null;
        let taps = 0;
        for (let i = 0; i < 150; i++) { r = f(); taps++; if (r.status !== 'playing') break; }
        return { ...r, taps };
      },
      [policy, stumbleAt],
    );
  };
  let best = { lv: level, stumbleAt: 3, score: -1 };
  for (let lv = level; lv <= level + 12; lv++) {
    for (const stumbleAt of [3, 4, 5]) {
      const r = await scout(lv, stumbleAt);
      if (r.status !== 'lost') continue;
      // A loss late in the level, with plenty of clean play before it.
      const score = r.progress * 10 + Math.min(r.taps, 25) * 0.3;
      if (score > best.score) best = { lv, stumbleAt, score, r };
    }
  }
  console.log('recording', JSON.stringify(best));
  const STUMBLE = best.stumbleAt;
  await page.goto(`http://localhost:4191/critter-jam/?level=${best.lv}&capture`);
  await page.waitForTimeout(800);
  await installLayer(page);
  const frames = new Frames(path.join(out, 'soclose-frames'));
  const step = () => page.evaluate(([src, n]) => new Function(src.replace('STUMBLE_AT', String(n)))(), [policy, STUMBLE]);
  void stepFn;

  let t = 0;
  let nextTapAt = 1.0;
  let lostAt = -1;
  let last = { left: 0, total: 0, bench: 0, slots: 7 };
  while (frames.seconds < 40) {
    const fps = 30;
    if (lostAt < 0 && t >= nextTapAt) {
      const r = await step();
      last = r;
      if (r.status === 'lost') lostAt = t;
      if (r.status === 'won') break;
      nextTapAt = t + (r.left <= STUMBLE ? 0.9 : 0.5);
    }
    const left = last.left;
    let cap = 'Fill every cart to win 🚂';
    if (t > 5 && left > 2) cap = 'Watch the tray… 👀';
    if (left <= STUMBLE && lostAt < 0) cap = last.bench >= last.slots - 1 ? 'ONE slot left!! 😱' : `Just ${left} cart${left > 1 ? 's' : ''} left!`;
    if (lostAt >= 0) cap = `NOOO! ${last.total - left}/${last.total} 😭`;
    await setCaption(page, cap);
    await setCount(page, `🚂 ${last.total ? last.total - left : 0}/${last.total || '?'}`);
    await frames.shoot(page);
    await page.evaluate((f) => window.__jam.advance(1, f), fps);
    t += 1 / fps;
    if (lostAt >= 0 && t - lostAt > 2.6) break;
    if (quick && frames.n > 900) break;
  }
  await endCard(page, `<div class="em">😩💎</div><h1>Only 3%</h1><p>fill every cart.<br><b>Can you?</b></p><div class="cta">Play free ▶</div>`);
  await frames.shoot(page, 75);
  await browser.close();
  encode(frames.dir, path.join(out, 'ad-gem-so-close.mp4'));
  console.log('wrote', path.join(out, 'ad-gem-so-close.mp4'), frames.seconds.toFixed(1) + 's', 'lostAt', lostAt.toFixed(1));
})();
