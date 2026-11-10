/**
 * Full screens (UI): HOME, PAUSE (with settings), RESULTS, and the shared settings panel + how-to card.
 * Pure DOM builders: each returns its root element and reports through callbacks. They read save data and
 * finished-run summaries, never the live sim.
 */
import { SPECS, SPEC_IDS } from '../content/specs';
import { SPELLS, SPELL_IDX } from '../content/spells';
import { omenById, twistById } from '../content/omens';
import type { SeedConfig } from '../core/world';
import type { SpecId } from '../core/types';
import type { Settings } from '../app/save';
import { escapeHtml, fmtCountdown, fmtInt, fmtTime } from '../app/format';
import { glyph, kwChip, KW_COLOR, KW_LABEL, specArt } from './glyphs';
import { estimatePercentile, milestoneLabel, POPULATION, shareRank } from '../app/percentile';
import { nextMilestone } from '../app/points';
import { heroArt, omenArt, twistArt } from './art';

export { fmtTime };

const h = escapeHtml;

// ---------------------------------------------------------------------------------------------------
// Settings panel (home and pause)

export function settingsPanel(s: Settings, onChange: (s: Settings) => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'dv-settings';
  el.innerHTML = `
    <label class="dv-set dv-set-vol"><span class="dv-set-l">${glyph('sound')}Sound</span>
      <input type="range" min="0" max="100" step="5" value="${Math.round(s.volume * 100)}" aria-label="Volume">
      <button class="dv-toggle dv-mute ${s.muted ? '' : 'on'}" role="switch" aria-checked="${!s.muted}" aria-label="Sound on"><i></i></button></label>
    <label class="dv-set"><span class="dv-set-l">Damage numbers</span><button class="dv-toggle ${s.damageNumbers ? 'on' : ''}" data-k="damageNumbers" role="switch" aria-checked="${s.damageNumbers}"><i></i></button></label>
    <label class="dv-set"><span class="dv-set-l">Screen shake</span><button class="dv-toggle ${s.screenShake ? 'on' : ''}" data-k="screenShake" role="switch" aria-checked="${s.screenShake}"><i></i></button></label>
    <label class="dv-set"><span class="dv-set-l">Reduced motion<small>Calmer camera, no flashes</small></span><button class="dv-toggle ${s.reducedMotion ? 'on' : ''}" data-k="reducedMotion" role="switch" aria-checked="${s.reducedMotion}"><i></i></button></label>`;
  const range = el.querySelector('input') as HTMLInputElement;
  range.addEventListener('input', () => {
    s.volume = Number(range.value) / 100;
    if (s.volume > 0 && s.muted) {
      s.muted = false;
      el.querySelector('.dv-mute')!.classList.add('on');
    }
    onChange(s);
  });
  el.querySelector('.dv-mute')!.addEventListener('click', (e) => {
    e.preventDefault();
    s.muted = !s.muted;
    const b = e.currentTarget as HTMLElement;
    b.classList.toggle('on', !s.muted);
    b.setAttribute('aria-checked', String(!s.muted));
    onChange(s);
  });
  el.querySelectorAll<HTMLButtonElement>('.dv-toggle[data-k]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.preventDefault();
      const k = b.dataset.k as 'damageNumbers' | 'screenShake' | 'reducedMotion';
      s[k] = !s[k];
      if (k === 'reducedMotion' && s.reducedMotion && s.screenShake) {
        s.screenShake = false;
        el.querySelector('[data-k="screenShake"]')?.classList.remove('on');
      }
      b.classList.toggle('on', s[k]);
      b.setAttribute('aria-checked', String(s[k]));
      onChange(s);
    }),
  );
  return el;
}

// ---------------------------------------------------------------------------------------------------
// How to play

export function howToCard(open = false, tour = false): string {
  return `<details class="dv-howto" ${open ? 'open' : ''}>
    <summary>${glyph('lantern')}How to play<span class="dv-chev"></span></summary>
    <ul>
      <li><span class="dv-hi move"></span><div><b>Drag to move.</b> One thumb, anywhere on the screen. Keys: WASD or arrows.</div></li>
      <li><span class="dv-hi auto">${glyph('fire')}</span><div><b>You attack on your own.</b> Your spells aim and fire by themselves. You just keep moving.</div></li>
      <li><span class="dv-hi red"></span><div><b>Red floor = move!</b> It fills up, then hits. Walk out before it's full.</div></li>
      <li><span class="dv-hi gold">${glyph('relic')}</span><div><b>Gold = grab.</b> Gems give XP, chests give relics.</div></li>
      <li><span class="dv-hi card">${glyph('reroll')}</span><div><b>Pick a card</b> each level. Two keywords at high rank <b>fuse</b>.</div></li>
      <li><span class="dv-hi dash">${glyph('dash')}</span><div><b>Tap to dash</b> (Space). It makes you immune to red floor for a moment.</div></li>
    </ul>
    ${tour ? `<button class="dv-btn ghost dv-tour">${glyph('play')}<span>Show me (20 s)</span></button>` : ''}
    <p class="dv-howto-foot">5 one-minute layers, each with a boss. Then the Core, which never ends. Everyone gets the same dive today; only your best try counts.</p>
  </details>`;
}

// ---------------------------------------------------------------------------------------------------
// HOME

export interface HomeData {
  seed: SeedConfig;
  msToReset: number;
  bestSec: number;
  bestSpec: string;
  bestKeywords: string[];
  tries: number;
  dayPoints: number;
  weekPoints: number;
  totalPoints: number;
  weekDays: number;
  weekStrip: boolean[];
  todayIdx: number;
  lastSpec: SpecId;
  firstTime: boolean;
  settings: Settings;
  /** One-line storage warning ('' = storage works). */
  saveNote?: string;
  /** Debug / demo session label ('' = a real dive that counts). */
  demo?: string;
}

export interface HomeCallbacks {
  /** The daily reset passed while home was open (rebuild home for the new day). */
  onReset?: () => void;
  onDive: (spec: SpecId) => void;
  onSettings: (s: Settings) => void;
  onClick?: () => void;
  /** Replay the First Dive onboarding. */
  onTour?: () => void;
}

export function homeScreen(parent: HTMLElement, d: HomeData, cb: HomeCallbacks): HTMLElement {
  const el = document.createElement('div');
  el.className = 'dv-screen dv-home';
  const omen = omenById(d.seed.omenId);
  const twist = twistById(d.seed.twistId);
  let spec: SpecId = (SPEC_IDS as readonly string[]).includes(d.lastSpec) ? d.lastSpec : 'ember';
  const specCard = (id: SpecId) => {
    const sd = SPECS[id];
    const sig = SPELLS[SPELL_IDX.get(sd.signature) ?? 0];
    const col = `#${sd.color.toString(16).padStart(6, '0')}`;
    // no "Omen pick" badge: QA found the content's `favours` list disagrees with bot data (Swarming helped Venom more)
    return `<button class="dv-spec ${id === spec ? 'sel' : ''}" data-spec="${id}" style="--sc:${col}" role="radio" aria-checked="${id === spec}">
      <span class="dv-spec-art">${specArt(id)}</span>
      <span class="dv-spec-name">${h(sd.name)}<small>${h(sd.className)}</small></span>
      <span class="dv-spec-sig">${kwChip(sig.keywords[0], false)}<b>${h(sig.name)}</b></span>
      <span class="dv-spec-desc">${h(sd.desc)}</span>
    </button>`;
  };
  const strip = d.weekStrip.map((p, i) => `<i class="${p ? 'on' : ''}${i === d.todayIdx ? ' today' : ''}"></i>`).join('');
  const best = d.tries > 0
    ? `<b>${fmtTime(d.bestSec)}</b><small>${d.bestSpec ? h(SPECS[d.bestSpec as SpecId]?.name ?? '') : ''} ${d.bestKeywords.map((k) => `<i class="dv-dot" style="background:${KW_COLOR[k]}"></i>`).join('')}</small>`
    : '<b>-</b><small>no dive yet</small>';
  const omenFav = '';
  el.innerHTML = `
    <div class="dv-home-inner">
      <div class="dv-col-a">
        <header class="dv-brand">
          <div class="dv-hero">${heroArt()}</div>
          <h1 class="dv-logo">Delve <span>Daily</span></h1>
          ${d.demo ? `<div class="dv-home-demo" role="note">${h(d.demo)} · not saved</div>` : ''}
          <div class="dv-dayline"><span class="dv-daynum">Delve #${d.seed.day}</span><span class="dv-sep">·</span><span class="dv-reset">new dive in <b>${fmtCountdown(d.msToReset)}</b></span></div>
        </header>
        <section class="dv-today" aria-label="Today's rules">
          <div class="dv-mod omen">${omenArt(omen?.id ?? '')}<div class="dv-mod-txt"><span class="dv-mod-k">Weekly Omen</span><b>${h(omen?.name ?? 'Calm')}</b><span>${h(omen?.desc ?? 'Nothing strange this week.')}</span>${omenFav}</div></div>
          <div class="dv-mod twist">${twistArt(twist?.id ?? '')}<div class="dv-mod-txt"><span class="dv-mod-k">Today's Twist</span><b>${h(twist?.name ?? 'None')}</b><span>${h(twist?.desc ?? 'A plain dive.')}</span></div></div>
        </section>
        <section class="dv-stats dv-stats-a">
          <div class="dv-stat"><span class="dv-stat-k">Best today</span>${best}</div>
          <div class="dv-stat"><span class="dv-stat-k">Attempts</span><b>${d.tries}</b><small>today</small></div>
          <div class="dv-stat"><span class="dv-stat-k">Points today</span><b>${fmtInt(d.dayPoints)}</b><small>of 1,000 · ${fmtInt(d.totalPoints)} total</small></div>
          <div class="dv-stat wide"><span class="dv-stat-k">${glyph('chest')}Weekly chest</span><div class="dv-week">${strip}</div><small>${Math.min(5, d.weekDays)}/5 days played${d.weekDays >= 5 ? ' · chest unlocked!' : ''} · ${fmtInt(d.weekPoints)} pts this week</small></div>
        </section>
      </div>
      <div class="dv-col-b">
        <section class="dv-pick"><div class="dv-sec-k">Choose your delver</div><div class="dv-specs" role="radiogroup" aria-label="Delver">${SPEC_IDS.map(specCard).join('')}</div></section>
        <div class="dv-divebar">
          <button class="dv-btn dv-dive">${glyph('lantern')}<span>DIVE</span></button>
          <div class="dv-dive-note">${d.tries === 0 ? 'Same dive for everyone today. Retries are free; your best counts.' : `Try ${d.tries + 1}. Your best (${fmtTime(d.bestSec)}) stays.`}</div>
        </div>
        ${howToCard(false, true)}
        <div class="dv-home-settings"><details><summary>${glyph('gear')}Settings<span class="dv-chev"></span></summary></details></div>
        ${d.saveNote ? `<div class="dv-save-note" role="status">${h(d.saveNote)}</div>` : ''}
        <footer class="dv-foot">No accounts, no ads. The rank is an estimate from bot runs.</footer>
      </div>
    </div>`;
  el.querySelector('.dv-tour')?.addEventListener('click', (e) => {
    e.preventDefault();
    cb.onClick?.();
    cb.onTour?.();
  });
  const setWrap = el.querySelector('.dv-home-settings details')!;
  setWrap.appendChild(settingsPanel(d.settings, cb.onSettings));
  el.querySelectorAll<HTMLButtonElement>('.dv-spec').forEach((b) =>
    b.addEventListener('click', () => {
      spec = b.dataset.spec as SpecId;
      cb.onClick?.();
      el.querySelectorAll('.dv-spec').forEach((x) => {
        x.classList.toggle('sel', x === b);
        x.setAttribute('aria-checked', String(x === b));
      });
    }),
  );
  el.querySelector('.dv-dive')!.addEventListener('click', () => cb.onDive(spec));
  // live countdown; at 0 the host rebuilds home for the new day
  const resetAt = Date.now() + d.msToReset;
  const cd = el.querySelector('.dv-reset b');
  const timer = window.setInterval(() => {
    if (!el.isConnected) {
      window.clearInterval(timer);
      return;
    }
    const left = resetAt - Date.now();
    if (left <= 0) {
      window.clearInterval(timer);
      cb.onReset?.();
      return;
    }
    if (cd) cd.textContent = fmtCountdown(left);
  }, 1000);
  parent.appendChild(el);
  return el;
}

// ---------------------------------------------------------------------------------------------------
// PAUSE

export interface PauseCallbacks {
  onResume: () => void;
  onQuit: () => void;
  onSettings: (s: Settings) => void;
}

export function pauseScreen(parent: HTMLElement, s: Settings, info: { time: string; where: string }, cb: PauseCallbacks): HTMLElement {
  const el = document.createElement('div');
  el.className = 'dv-screen dv-pause';
  el.innerHTML = `
    <div class="dv-panel">
      <div class="dv-panel-k">${h(info.where)} · ${h(info.time)}</div>
      <h2>Paused</h2>
      <button class="dv-btn dv-resume">${glyph('play')}<span>Resume</span></button>
      <div class="dv-sec-k">Settings</div>
      <div class="dv-set-slot"></div>
      ${howToCard(false)}
      <button class="dv-btn ghost danger dv-quit">${glyph('home')}<span>Quit run</span></button>
      <div class="dv-quit-note hidden">Quit? This run ends now and counts as a try. Your best today stays.<div class="dv-row"><button class="dv-btn ghost dv-quit-no">Keep going</button><button class="dv-btn danger dv-quit-yes">Quit</button></div></div>
    </div>`;
  el.querySelector('.dv-set-slot')!.appendChild(settingsPanel(s, cb.onSettings));
  el.querySelector('.dv-resume')!.addEventListener('click', cb.onResume);
  const note = el.querySelector('.dv-quit-note')!;
  el.querySelector('.dv-quit')!.addEventListener('click', () => note.classList.remove('hidden'));
  el.querySelector('.dv-quit-no')!.addEventListener('click', () => note.classList.add('hidden'));
  el.querySelector('.dv-quit-yes')!.addEventListener('click', cb.onQuit);
  parent.appendChild(el);
  return el;
}

// ---------------------------------------------------------------------------------------------------
// RESULTS

export interface ResultsData {
  day: number;
  sec: number;
  title: string;
  line: string;
  tip: string;
  newBest: boolean;
  bestSec: number;
  prevBestSec: number;
  firstOfDay: boolean;
  gained: number;
  dayPoints: number;
  /** Rank line of the day's BEST run (spec 2.2: the day's rank is the best run). */
  top: string;
  topPct: number;
  /** Rank line of this try, shown separately when it is worse than the best. */
  tryTop?: string;
  level: number;
  kills: number;
  bosses: number;
  fusions: number;
  tries: number;
  specId: SpecId;
  /** [spellIdx, rank] of the final build. */
  build: [number, number][];
  relics: string[];
  share: string;
  canShare: boolean;
  /** 'death' or 'quit'. */
  cause?: string;
  /** Spec / keywords of the day's best run (the share card shows the best, not necessarily this run). */
  bestSpec: string;
  bestKeywords: string[];
  /** Skip the count-up show. */
  reduced?: boolean;
  /**
   * Debug / demo run (guard, bot, speed, another day): settled into a session scratch save, never the real one.
   * The text names why (e.g. "Demo run (guarded)"); the screen then never says "First dive today" or claims points.
   */
  demo?: string;
}

export interface ResultsCallbacks {
  onAgain: () => void;
  onHome: () => void;
  onCopy: () => Promise<boolean>;
  onShare: () => Promise<boolean>;
  /** Presentation hooks for sound (optional). */
  onStamp?: () => void;
  onTally?: (progress: number) => void;
  onFanfare?: () => void;
}

/** SVG density curve of the bot population with the run marked ("you beat the shaded part"). */
function rankCurve(sec: number): string {
  const q = POPULATION.quantiles;
  const maxS = q[q.length - 1][1];
  const minS = 0;
  const N = 48;
  const xs: number[] = [];
  const ds: number[] = [];
  const step = (maxS - minS) / N;
  for (let i = 0; i <= N; i++) {
    const x = minS + i * step;
    xs.push(x);
    const a = estimatePercentile(Math.max(minS, x - step * 1.5));
    const b = estimatePercentile(Math.min(maxS, x + step * 1.5));
    ds.push(b - a);
  }
  // light smoothing so the curve reads as a hill, not a staircase
  const sm = ds.map((_, i) => (ds[Math.max(0, i - 1)] + 2 * ds[i] + ds[Math.min(N, i + 1)]) / 4);
  const peak = Math.max(...sm) || 1;
  const W = 200;
  const H = 46;
  const px = (x: number) => ((x - minS) / (maxS - minS)) * W;
  const py = (d: number) => H - 2 - (d / peak) * (H - 8);
  let path = `M0 ${H}`;
  for (let i = 0; i <= N; i++) path += ` L${px(xs[i]).toFixed(1)} ${py(sm[i]).toFixed(1)}`;
  path += ` L${W} ${H} Z`;
  const mx = Math.max(1, Math.min(W - 1, px(Math.min(sec, maxS))));
  const clip = `rk${Math.round(sec * 10)}${Math.floor(Math.random() * 1e6)}`;
  return `<svg class="dv-rank-curve" viewBox="0 0 ${W} ${H + 12}" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <defs><clipPath id="${clip}"><rect x="0" y="0" width="${mx.toFixed(1)}" height="${H}"/></clipPath></defs>
    <path d="${path}" fill="rgba(255,255,255,.1)"/>
    <path d="${path}" fill="var(--teal)" fill-opacity=".55" clip-path="url(#${clip})" class="dv-rank-fill"/>
    <line x1="${mx.toFixed(1)}" y1="2" x2="${mx.toFixed(1)}" y2="${H}" stroke="#fff" stroke-width="2"/>
    <circle cx="${mx.toFixed(1)}" cy="4" r="3.5" fill="#fff"/>
    <text x="0" y="${H + 11}" class="dv-rank-ax">0:00</text><text x="${(W / 2).toFixed(0)}" y="${H + 11}" text-anchor="middle" class="dv-rank-ax">${fmtTime(maxS / 2)}</text><text x="${W}" y="${H + 11}" text-anchor="end" class="dv-rank-ax">${fmtTime(maxS)}</text>
  </svg>`;
}

/**
 * The rank tile. v0.2 review: every first-time run (1:53-2:57) led with a huge "Beat <1% of bot runs" while p10 sits near
 * 4:00, which undercut the reason to dive again. Runs in the bottom tenth lead with progress instead (how deep the best run
 * got and the next depth to aim for); the bot rank drops to small print. The curve stays.
 */
function rankBlock(r: ResultsData): string {
  const low = r.topPct >= 90;
  if (!low) return `<div class="dv-stat dv-rank"><span class="dv-stat-k">Rank today</span><b class="dv-rank-v">${h(r.top)}</b>`;
  const layer = Math.min(5, Math.floor(r.bestSec / 60) + 1);
  const next = r.bestSec < 300 ? (layer < 5 ? `Next: Layer ${layer + 1} at ${fmtTime(layer * 60)}` : 'Next: the Core at 5:00') : 'Next: hold the Core';
  return `<div class="dv-stat dv-rank low"><span class="dv-stat-k">Best today</span><b class="dv-rank-v">${h(milestoneLabel(r.bestSec))}</b><small class="dv-rank-next">${h(next)}</small>`;
}

/** Visual share card: what the copied text stands for, drawn as a little ticket. */
function shareCardArt(r: ResultsData): string {
  const sd = SPECS[r.bestSpec as SpecId] ?? SPECS[r.specId];
  const col = `#${sd.color.toString(16).padStart(6, '0')}`;
  const kws = (r.bestKeywords.length ? r.bestKeywords : []).slice(0, 3);
  return `<div class="dv-ticket" style="--sc:${col}">
    <div class="dv-ticket-l">
      <span class="dv-ticket-k">${glyph('lantern')}DELVE #${r.day}</span>
      <b class="dv-ticket-time">${fmtTime(r.bestSec)}</b>
      <span class="dv-ticket-top">${h(shareRank(r.bestSec))}</span>
    </div>
    <div class="dv-ticket-r">
      <span class="dv-ticket-spec">${h(sd.name)}</span>
      <span class="dv-ticket-kws">${kws.map((k) => `<i style="--kw:${KW_COLOR[k] ?? '#fff'}" title="${h(KW_LABEL[k] ?? k)}">${glyph(k)}</i>`).join('') || '<i>-</i>'}</span>
    </div>
  </div>`;
}

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t) * (1 - t);
}

/** Animate a number in `el` from a to b over ms (calls fmt each frame). Returns a cancel function. */
function countUp(el: Element, a: number, b: number, ms: number, fmt: (n: number) => string, onStep?: (p: number) => void, onEnd?: () => void): () => void {
  const t0 = performance.now();
  let raf = 0;
  let lastShown = '';
  const tick = (now: number) => {
    const p = Math.min(1, (now - t0) / ms);
    const v = a + (b - a) * easeOut(p);
    const s = fmt(p >= 1 ? b : v);
    if (s !== lastShown) {
      lastShown = s;
      el.textContent = s;
      onStep?.(p);
    }
    if (p < 1) raf = requestAnimationFrame(tick);
    else onEnd?.();
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

/** CSS confetti (DOM, ~48 pieces, removed after the burst). */
function confetti(host: HTMLElement): void {
  const box = document.createElement('div');
  box.className = 'dv-confetti';
  const cols = ['#ffd34d', '#ff8a3d', '#8dff5a', '#7af0e0', '#b27bff', '#fff0a8', '#ff5d6e'];
  let html = '';
  for (let i = 0; i < 48; i++) {
    const x = (i * 37) % 100;
    const dx = ((i * 53) % 61) - 30;
    const d = (i % 7) * 0.06;
    const dur = 1.6 + ((i * 13) % 10) / 10;
    const rot = (i * 97) % 720;
    html += `<i style="left:${x}%;--dx:${dx}vw;--rot:${rot}deg;background:${cols[i % cols.length]};animation-delay:${d}s;animation-duration:${dur}s;${i % 3 === 0 ? 'border-radius:50%;' : ''}"></i>`;
  }
  box.innerHTML = html;
  host.appendChild(box);
  window.setTimeout(() => box.remove(), 3600);
}

export function resultsScreen(parent: HTMLElement, r: ResultsData, cb: ResultsCallbacks): HTMLElement {
  const el = document.createElement('div');
  el.className = `dv-screen dv-results${r.newBest ? ' best' : ''}${r.cause === 'quit' ? ' quit' : ''}`;
  const build = r.build.map(([si, rank]) => {
    const sp = SPELLS[si];
    if (!sp) return '';
    return `<span class="dv-bspell ${sp.fusion ? 'fused' : ''}" style="--kw:${KW_COLOR[sp.keywords[0]]};--kw2:${KW_COLOR[sp.keywords[1] ?? sp.keywords[0]]}">${glyph(sp.keywords[0])}${sp.keywords[1] ? glyph(sp.keywords[1]) : ''}<b>${h(sp.name)}</b><small>${sp.fusion ? 'fused' : `R${rank % 1 ? rank.toFixed(1) : rank}`}</small></span>`;
  }).join('');
  const before = Math.max(0, r.dayPoints - r.gained);
  // the day total counts up in lockstep with the "+N" tally, so the two never disagree mid-count (v0.1 QA: "+585" next
  // to "780 / 1,000" was the tally caught halfway while the total already showed its final value)
  const ptsSub = r.demo
    ? `demo points, not saved · <b class="dv-pts-tot">${fmtInt(r.gained > 0 ? before : r.dayPoints)}</b> / 1,000`
    : r.gained > 0
      ? `${r.firstOfDay ? 'earned' : 'topped up'} this try · <b class="dv-pts-tot">${fmtInt(before)}</b> / 1,000 today`
      : `best (${fmtTime(r.bestSec)}) already paid · ${fmtInt(r.dayPoints)} / 1,000`;
  const nxt = nextMilestone(r.bestSec);
  const nextLine = nxt ? `Next: <b>${fmtInt(nxt.points)} pts</b> at ${fmtTime(nxt.sec)}` : 'Max points today!';
  const ribbon = r.newBest
    ? `<div class="dv-res-stamp">${glyph('crown')}<span>${r.demo ? 'Demo run' : r.firstOfDay ? 'First dive today' : 'NEW BEST'}</span></div>${r.firstOfDay ? '' : `<div class="dv-res-was">was ${fmtTime(r.prevBestSec)} · +${fmtTime(Math.max(0, Math.floor(r.sec) - Math.floor(r.prevBestSec)))}</div>`}`
    : `<div class="dv-res-bestline">Best today <b>${fmtTime(r.bestSec)}</b> stays${Math.floor(r.bestSec) > Math.floor(r.sec) ? ` · ${fmtTime(Math.floor(r.bestSec) - Math.floor(r.sec))} short` : ''}</div>`;
  el.innerHTML = `
    <div class="dv-res-glow"></div>
    <div class="dv-res-inner">
      ${r.demo ? `<div class="dv-demo-tag" role="note">${h(r.demo)} · not saved</div>` : ''}
      <div class="dv-res-a">
      <div class="dv-res-k">Delve #${r.day} · try ${r.tries}</div>
      <h2 class="dv-res-title">${h(r.title)}</h2>
      <div class="dv-res-time" aria-label="Survived ${fmtTime(r.sec)}">0:00</div>
      ${ribbon}
      <p class="dv-res-line">${h(r.line)}</p>
      <p class="dv-res-tip">${glyph('lantern')}<span>${h(r.tip)}</span></p>
      </div>
      <div class="dv-res-b">
      <div class="dv-res-grid">
        ${rankBlock(r)}${rankCurve(r.bestSec)}${r.topPct >= 90 ? '' : r.tryTop && r.sec < r.bestSec ? `<small class="dv-rank-try">This try (${fmtTime(r.sec)}): ${h(r.tryTop)}</small>` : ''}<small>${r.topPct >= 90 ? `Bot-run rank: ${h(r.top.replace(' of bot runs', ''))}` : 'estimate from bot runs, not real players'}</small></div>
        <div class="dv-stat dv-pts"><span class="dv-stat-k">Points</span><b class="dv-pts-v">${r.gained > 0 ? '+0' : fmtInt(r.dayPoints)}</b>
          <div class="dv-pts-bar" role="meter" aria-valuemin="0" aria-valuemax="1000" aria-valuenow="${r.dayPoints}" aria-label="Points today"><i class="old" style="width:${before / 10}%"></i><i class="new" style="left:${before / 10}%;--w:${r.gained / 10}%"></i></div>
          <small>${ptsSub}</small><small class="dv-pts-next">${nextLine}</small></div>
      </div>
      <div class="dv-sharecard"><div class="dv-share-k">${r.demo ? 'Share card (demo run)' : 'Share your best today'}</div>
        ${shareCardArt(r)}
        <pre class="dv-share" aria-label="Share text">${h(r.share)}</pre>
        <div class="dv-row"><button class="dv-btn ghost dv-copy">${glyph('copy')}<span>Copy</span></button>${r.canShare ? `<button class="dv-btn ghost dv-nshare">${glyph('share')}<span>Share</span></button>` : ''}</div>
      </div>
      </div>
      <div class="dv-res-c">
      <div class="dv-res-mini">
        <span><b>${r.level}</b>level</span><span><b>${fmtInt(r.kills)}</b>kills</span><span><b>${r.bosses}/5</b>bosses</span><span><b>${r.fusions}</b>fusion${r.fusions === 1 ? '' : 's'}</span>
      </div>
      <div class="dv-res-build">${build}${r.relics.length ? `<span class="dv-brelics">${glyph('relic')}${r.relics.map(h).join(', ')}</span>` : ''}</div>
      </div>
      <div class="dv-res-actions">
        <button class="dv-btn dv-again">${glyph('lantern')}<span>DIVE AGAIN</span></button>
        <button class="dv-btn ghost dv-share-btn" aria-label="Share your best today" title="Copy share text">${glyph(r.canShare ? 'share' : 'copy')}</button>
        <button class="dv-btn ghost dv-home-btn" aria-label="Home">${glyph('home')}</button>
      </div>
      <div class="dv-dive-note">Same dive, new try. Your best stays.</div>
    </div>`;
  const copy = el.querySelector('.dv-copy') as HTMLElement;
  copy.addEventListener('click', async () => {
    const ok = await cb.onCopy();
    copy.querySelector('span')!.textContent = ok ? 'Copied!' : 'Select & copy';
    copy.classList.toggle('ok', ok);
    if (!ok) {
      const pre = el.querySelector('.dv-share')!;
      const range = document.createRange();
      range.selectNodeContents(pre);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    setTimeout(() => {
      copy.querySelector('span')!.textContent = 'Copy';
      copy.classList.remove('ok');
    }, 1800);
  });
  el.querySelector('.dv-nshare')?.addEventListener('click', () => void cb.onShare());
  // pinned share: native sheet where available, else copy; never needs a scroll
  const sb = el.querySelector('.dv-share-btn') as HTMLElement;
  sb.addEventListener('click', async () => {
    const ok = r.canShare ? (await cb.onShare()) || (await cb.onCopy()) : await cb.onCopy();
    sb.classList.toggle('ok', ok);
    sb.setAttribute('aria-label', ok ? 'Copied' : 'Share your best today');
    setTimeout(() => sb.classList.remove('ok'), 1600);
  });
  el.querySelector('.dv-again')!.addEventListener('click', cb.onAgain);
  el.querySelector('.dv-home-btn')!.addEventListener('click', cb.onHome);
  parent.appendChild(el);

  // --- the reveal: time counts up and lands, then the ribbon / fanfare, then the points tally
  const timeEl = el.querySelector('.dv-res-time')!;
  const ptsEl = el.querySelector('.dv-pts-v')!;
  const totEl = el.querySelector('.dv-pts-tot');
  const newBar = el.querySelector<HTMLElement>('.dv-pts-bar i.new');
  const cancels: (() => void)[] = [];
  const timers: number[] = [];
  const later = (ms: number, f: () => void) => timers.push(window.setTimeout(() => el.isConnected && f(), ms));
  const finishAll = () => {
    cancels.forEach((c) => c());
    timers.forEach((t) => clearTimeout(t));
    timeEl.textContent = fmtTime(r.sec);
    if (r.gained > 0) ptsEl.textContent = `+${fmtInt(r.gained)}`;
    if (totEl) totEl.textContent = fmtInt(r.dayPoints);
    if (newBar && newBar.style.width) newBar.style.width = `${r.gained / 10}%`;
    el.classList.add('t-landed', 't-ribbon', 't-points');
  };
  if (r.reduced) {
    finishAll();
    if (r.newBest) cb.onFanfare?.();
    return el;
  }
  const timeMs = Math.min(1500, 500 + r.sec * 2);
  later(250, () => cancels.push(countUp(timeEl, 0, r.sec, timeMs, (n) => fmtTime(Math.floor(n)), undefined, () => {
    el.classList.add('t-landed');
    cb.onStamp?.();
    later(260, () => {
      el.classList.add('t-ribbon');
      if (r.newBest) {
        cb.onFanfare?.();
        confetti(el);
      }
    });
    later(r.newBest ? 900 : 400, () => {
      el.classList.add('t-points');
      if (r.gained > 0) {
        cancels.push(countUp(ptsEl, 0, r.gained, Math.min(1400, 500 + r.gained), (n) => {
          const g = Math.round(n);
          if (totEl) totEl.textContent = fmtInt(before + g);
          if (newBar) {
            newBar.style.transition = 'none';
            newBar.style.width = `${g / 10}%`;
          }
          return `+${fmtInt(g)}`;
        }, (p) => cb.onTally?.(p)));
      }
    });
  })));
  // a tap anywhere skips the show
  el.addEventListener('pointerdown', () => {
    if (!el.classList.contains('t-points')) finishAll();
  }, { once: true });
  return el;
}
