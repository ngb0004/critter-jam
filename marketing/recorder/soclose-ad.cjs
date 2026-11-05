// Ad 2, "So close": smooth play, then the tray fills with the last cart in sight. Fail ad of the real loop.
const path = require('path');
const { open, installLayer, setCaption, setCount, endCard, Frames, encode } = require('./common.cjs');

const out = process.argv[2];
const quick = process.argv.includes('--quick');
const level = Number(process.argv[process.argv.indexOf('--level') + 1] || 12);

(async () => {
  const { browser, page } = await open(`http://localhost:4191/critter-jam/?level=${level}&capture`, { dpr: quick ? 1 : 3 });
  await installLayer(page);
  const frames = new Frames(path.join(out, 'soclose-frames'));
  // Good play until the last two carts, then deliberately bench the wrong colours: a believable stumble.
  const step = () =>
    page.evaluate(() => {
      const j = window.__jam;
      const s = j.state;
      if (!s || s.status !== 'playing') return { done: true, status: s ? s.status : '', left: 0, total: 0, bench: 0, slots: 0 };
      const v = s.def.vehicles[s.vehicleIdx];
      const cols = s.def.cols;
      const left = s.def.vehicles.length - s.vehicleIdx;
      const stumble = left <= 2;
      const order = [];
      if (!stumble) {
        for (let c = 0; c < s.cells.length; c++) if (s.cells[c] === v || s.cells[c] === 40) order.push(c);
        for (let c = 0; c < s.cells.length; c++) { if (s.cells[c] < 0 || order.includes(c)) continue; const b = c + cols; if (b < s.cells.length && (s.cells[b] === v || s.cells[b] === 40)) order.push(c); }
      }
      const rest = [];
      for (let c = 0; c < s.cells.length; c++) if (s.cells[c] >= 0 && !order.includes(c) && s.cells[c] !== v) rest.push(c);
      const matches = [];
      for (let c = 0; c < s.cells.length; c++) if (s.cells[c] === v) matches.push(c);
      const before = s.moves;
      // In the stumble, take non-matching pieces first so the tray fills; fall back to matches if nothing else is legal.
      for (const c of [...order, ...rest, ...matches]) { j.tap(c); if (j.state.moves !== before) break; }
      const t = j.state;
      return { done: false, status: t.status, left: t.def.vehicles.length - t.vehicleIdx, total: t.def.vehicles.length, bench: t.bench.length, slots: t.def.benchSlots };
    });

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
      nextTapAt = t + (r.left <= 2 ? 0.9 : 0.5);
    }
    const left = last.left;
    let cap = 'Fill every cart to win 🚂';
    if (t > 5 && left > 2) cap = 'Watch the tray… 👀';
    if (left <= 2 && lostAt < 0) cap = last.bench >= last.slots - 1 ? 'ONE slot left!! 😱' : `Just ${left} cart${left > 1 ? 's' : ''} left!`;
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
