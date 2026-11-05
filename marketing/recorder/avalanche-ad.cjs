// Ad 1, "Avalanche": calm matching, then the board lines up and carts fill themselves in a run; Fever to finish.
const path = require('path');
const { open, setCaption, setCount, endCard, Frames, encode } = require('./common.cjs');

const out = process.argv[2];
const quick = process.argv.includes('--quick');
const level = Number(process.argv[process.argv.indexOf('--level') + 1] || 9);

(async () => {
  const { browser, page } = await open(`http://localhost:4191/critter-jam/?level=${level}&capture`, { dpr: quick ? 1 : 3 });
  const frames = new Frames(path.join(out, 'avalanche-frames'));
  // The player: match when possible, otherwise clear the blocker in front of the needed colour.
  const step = () =>
    page.evaluate(() => {
      const j = window.__jam;
      const s = j.state;
      if (!s || s.status !== 'playing') return { done: true, run: 0, fever: false, moves: s ? s.moves : 0 };
      const v = s.def.vehicles[s.vehicleIdx];
      const cols = s.def.cols;
      const order = [];
      for (let c = 0; c < s.cells.length; c++) if (s.cells[c] === v || s.cells[c] === 40) order.push(c);
      // Blockers directly in front of a needed piece next.
      for (let c = 0; c < s.cells.length; c++) {
        if (s.cells[c] < 0 || order.includes(c)) continue;
        const behind = c + cols;
        if (behind < s.cells.length && (s.cells[behind] === v || s.cells[behind] === 40)) order.push(c);
      }
      // Then pieces whose colour comes soonest.
      const soon = new Map();
      for (let k = 1; k < 4; k++) { const i = s.vehicleIdx + k; if (i < s.def.vehicles.length && !soon.has(s.def.vehicles[i])) soon.set(s.def.vehicles[i], k); }
      const rest = [];
      for (let c = 0; c < s.cells.length; c++) if (s.cells[c] >= 0 && !order.includes(c)) rest.push(c);
      rest.sort((a, b) => (soon.get(s.cells[a]) ?? 9) - (soon.get(s.cells[b]) ?? 9));
      const before = s.moves;
      for (const c of [...order, ...rest]) { j.tap(c); if (j.state.moves !== before) break; }
      return { done: false, run: j.state.run, fever: j.state.fever, moves: j.state.moves };
    });

  let t = 0;
  let maxRun = 0;
  let feverSeen = false;
  let done = false;
  let nextTapAt = 1.2;
  let doneFrames = 0;
  let caption = 'Match the gem to the cart 💎';
  while (doneFrames < 36 && frames.seconds < 42) {
    const fps = 30;
    if (!done && t >= nextTapAt) {
      const r = await step();
      done = r.done;
      if (r.run > maxRun) maxRun = r.run;
      if (r.fever) feverSeen = true;
      // Pace: brisk taps, a breath after a big run.
      nextTapAt = t + (r.run >= 2 ? 1.6 + r.run * 0.3 : 0.55);
      if (r.run >= 2) caption = `AVALANCHE ×${r.run}! 🤯`;
      else if (r.fever) caption = 'FEVER!! 🔥🔥🔥';
      else if (maxRun >= 2) caption = 'Line them up… 👀';
      else if (t > 6) caption = 'Clear the path to the colour you need';
    }
    if (done) doneFrames++;
    await setCaption(page, caption);
    const st = await page.evaluate(() => { const s = window.__jam.state; return { left: s.def.vehicles.length - s.vehicleIdx, total: s.def.vehicles.length }; });
    await setCount(page, `🚂 ${st.total - st.left}/${st.total}`);
    await frames.shoot(page);
    await page.evaluate((f) => window.__jam.advance(1, f), fps);
    t += 1 / fps;
    if (frames.n % 30 === 0) console.log(`video ${frames.seconds.toFixed(1)}s maxRun ${maxRun} fever ${feverSeen} done ${done}`);
    if (quick && frames.n > 900) break;
  }
  await endCard(page, `<div class="em">💎🚂</div><h1>Gem Jam</h1><p>Set up the avalanche.<br>How far can you go?</p><div class="cta">Play free ▶</div>`);
  await frames.shoot(page, 75);
  await browser.close();
  encode(frames.dir, path.join(out, 'ad-gem-avalanche.mp4'));
  console.log('wrote', path.join(out, 'ad-gem-avalanche.mp4'), frames.seconds.toFixed(1) + 's', 'maxRun', maxRun, 'fever', feverSeen);
})();
