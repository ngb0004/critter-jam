// Ad 1, "Avalanche": calm matching, then the board lines up and carts fill themselves in a run; Fever to finish.
const path = require('path');
const { open, installLayer, setCaption, setCount, endCard, Frames, encode } = require('./common.cjs');

const out = process.argv[2];
const quick = process.argv.includes('--quick');
// --skin critters films the animals-and-buses look; the output file name carries the skin.
const skin = process.argv.includes('--skin') ? process.argv[process.argv.indexOf('--skin') + 1] : 'gems';
const q = (lv) => `http://localhost:4191/critter-jam/play/?level=${lv}&capture${skin === 'gems' ? '' : `&skin=${skin}`}`;
const level = Number(process.argv[process.argv.indexOf('--level') + 1] || 14);

(async () => {
  const { browser, page } = await open(q(level), { dpr: quick ? 1 : 3 });
  // Scout: play levels silently (no frames drawn) and pick one with a real set-up
  // before its first big avalanche, so the clip has a build-up and a payoff.
  const scout = async (lv) => {
    await page.goto(q(lv));
    await page.waitForTimeout(500);
    return page.evaluate(() => {
      const j = window.__jam;
      let taps = 0, firstBig = -1, maxRun = 0, fever = false;
      for (let step = 0; step < 120; step++) {
        const s = j.state; if (!s || s.status !== 'playing') break;
        const v = s.def.vehicles[s.vehicleIdx]; const cols = s.def.cols;
        const order = [];
        for (let c = 0; c < s.cells.length; c++) if (s.cells[c] === v || s.cells[c] === 40) order.push(c);
        for (let c = 0; c < s.cells.length; c++) { if (s.cells[c] < 0 || order.includes(c)) continue; const b = c + cols; if (b < s.cells.length && (s.cells[b] === v || s.cells[b] === 40)) order.push(c); }
        const soon = new Map(); for (let k = 1; k < 4; k++) { const i = s.vehicleIdx + k; if (i < s.def.vehicles.length && !soon.has(s.def.vehicles[i])) soon.set(s.def.vehicles[i], k); }
        const rest = []; for (let c = 0; c < s.cells.length; c++) if (s.cells[c] >= 0 && !order.includes(c)) rest.push(c);
        rest.sort((a, b) => (soon.get(s.cells[a]) ?? 9) - (soon.get(s.cells[b]) ?? 9));
        const before = s.moves;
        for (const c of [...order, ...rest]) { j.tap(c); if (j.state.moves !== before) break; }
        taps++;
        if (j.state.run > maxRun) maxRun = j.state.run;
        if (j.state.run >= 3 && firstBig < 0) firstBig = taps;
        if (j.state.fever) fever = true;
      }
      const s = j.state;
      return { won: s.status === 'won', taps, firstBig, maxRun, fever };
    });
  };
  let best = { lv: level, score: -1 };
  for (let lv = level; lv <= level + 14; lv++) {
    const r = await scout(lv);
    // We want: a win, 10+ taps of build-up before the first ×3 run, a big max run, and Fever.
    const score = (r.won ? 10 : 0) + (r.firstBig >= 10 ? 10 : r.firstBig >= 6 ? 5 : 0) + Math.min(r.maxRun, 6) * 2 + (r.fever ? 4 : 0);
    console.log(`scout L${lv}`, JSON.stringify(r), 'score', score);
    if (score > best.score) best = { lv, score };
  }
  console.log('recording level', best.lv);
  await page.goto(q(best.lv));
  await page.waitForTimeout(800);
  await installLayer(page);
  const frames = new Frames(path.join(out, `avalanche-${skin}-frames`));
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
  encode(frames.dir, path.join(out, `ad-${skin === 'gems' ? 'gem' : skin}-avalanche.mp4`));
  console.log('wrote', path.join(out, `ad-${skin === 'gems' ? 'gem' : skin}-avalanche.mp4`), frames.seconds.toFixed(1) + 's', 'maxRun', maxRun, 'fever', feverSeen);
})();
