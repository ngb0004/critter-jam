/**
 * Delve Daily entry (UI). Boots the page and owns the app state machine:
 *
 *   home -> run <-> paused -> dead -> results -> run (dive again) | home
 *
 * Runs the fixed 60 Hz loop (accumulator; the sim advances only through step() with one input byte per tick and
 * choose() with card choices), drains sim events into renderer / HUD / audio, records the replay, keeps the
 * per-second run log for the death summary, and settles the run (best of day, points top-up) on death.
 * Pausing (menu, hidden tab, fusion reveal) simply stops calling step(): paused time is never simulated.
 *
 * Debug URL params (tests / Playwright): ?day=N (CORE), ?speed=N sim ticks per real tick (1-120),
 * ?bot=1 autoplay with the BOT kiting bot (cards picked after a short delay), ?bot=idle stand still,
 * ?go=ember|venom start a run immediately, ?fresh=1 ignore the save (in-memory only).
 */
import './style.css';
import * as THREE from 'three';
import { DT } from './core/constants';
import { dayNumber, msUntilReset, seedForDay } from './core/daily';
import { EV } from './core/events';
import { Recorder, serializeReplay } from './core/replay';
import { choose, createWorld, step, type World } from './core/world';
import { DEATH, TG_COLOR, type ChoiceCode, type SpecId } from './core/types';
import { buildModifiers } from './content/omens';
import { BOSSES } from './content/bosses';
import { layerDef } from './content/layers';
import { relicById } from './content/relics';
import { SPEC_IDS } from './content/specs';
import { DelveRenderer } from './render/renderer';
import { botChoose, botInput } from './bot/bot';
import { Hud, type Projector } from './ui/hud';
import { CardPicker } from './ui/cards';
import { FusionReveal } from './ui/fusion';
import { InputSampler } from './ui/input';
import { homeScreen, pauseScreen, resultsScreen } from './ui/screens';
import { showOnboarding } from './ui/onboard';
import { DelveAudio } from './app/audio';
import { fmtTime } from './app/format';
import { deathSummary, RunLog } from './app/runlog';
import { freshSave, loadSave, peekDay, saveHealth, settleRun, weekDaysPlayed, weekPoints, weekStrip, writeSave, type Settings } from './app/save';
import { topLabel, topPercent } from './app/percentile';
import { canNativeShare, copyText, nativeShare, shareText, topKeywords } from './app/share';
import { weekNumber } from './core/daily';

type AppState = 'home' | 'run' | 'paused' | 'dead' | 'results';

// ---------------------------------------------------------------------------------------------------
// Fatal-error fallback: any exception before boot finishes (or a loop that keeps throwing) shows a plain screen with a
// "Reset save" way out instead of a black page.
let booted = false;
let fatalShown = false;
function showFatal(err: unknown): void {
  if (fatalShown) return;
  fatalShown = true;
  console.error(err);
  const el = document.createElement('div');
  el.className = 'dv-fatal';
  el.setAttribute('role', 'alertdialog');
  el.style.cssText = 'position:fixed;inset:0;z-index:99;display:grid;place-items:center;background:#0b0810;color:#f4ead8;font:700 16px/1.4 Nunito,system-ui,sans-serif;text-align:center;padding:16px';
  el.innerHTML = '<div><div style="font-size:22px;margin-bottom:8px">Something went wrong.</div>' +
    '<div style="opacity:.8;margin-bottom:16px">The cave collapsed while loading. Resetting the save usually fixes it.</div>' +
    '<button type="button" data-a="reset" style="font:inherit;padding:10px 18px;border-radius:999px;border:0;background:#ffc27a;color:#2a1a08;margin:4px">Reset save</button>' +
    '<button type="button" data-a="reload" style="font:inherit;padding:10px 18px;border-radius:999px;border:2px solid #ffc27a;background:none;color:#ffc27a;margin:4px">Reload</button></div>';
  el.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).getAttribute('data-a');
    if (a === 'reset') {
      try {
        localStorage.removeItem('delve-daily.save.v1');
      } catch {
        /* storage blocked: nothing to reset */
      }
    }
    if (a) location.reload();
  });
  document.body.appendChild(el);
}
window.addEventListener('error', (e) => {
  if (!booted) showFatal(e.error ?? e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  if (!booted) showFatal(e.reason);
});

const params = new URLSearchParams(location.search);
const clampSpeed = (n: number): number => Math.max(1, Math.min(120, Math.floor(n) || 1));
let SPEED = clampSpeed(Number(params.get('speed') ?? '1'));
/** '1' bot moves + picks, 'move' bot moves only (cards wait for a human / test), 'idle' stand still. */
let BOT = params.get('bot');
const FRESH = params.get('fresh') === '1';
/** ?guard=1 (debug): HP floors at 40% except for Wyrmfall damage; such runs are never settled, saved or ranked. */
const GUARD = params.get('guard') === '1';
/**
 * Debug/demo runs (guard, bot, a non-default speed, or a ?day other than today) settle into this session-only scratch
 * save, never into the player's real bests, points or history.
 */
const scratch = freshSave();
const sandboxed = (day: number): boolean => GUARD || BOT !== null || SPEED !== 1 || (params.has('day') && day !== dayNumber(Date.now()));
const runSave = (day: number) => (sandboxed(day) ? scratch : save);

const stage = document.getElementById('dv-stage')!;
const canvas = document.getElementById('dv-canvas') as HTMLCanvasElement;
const ui = document.getElementById('dv-ui')!;

const save = FRESH ? freshSave() : loadSave();
let saveDirty = false;
const persist = (): void => {
  saveDirty = false;
  if (!FRESH) writeSave(save);
};
/** Mid-run writes are deferred (JSON of the whole save on the main thread is a hitch): flushed on pause / run end. */
const persistSoon = (): void => {
  if (state === 'run') saveDirty = true;
  else persist();
};
const audio = new DelveAudio();
const renderer = new DelveRenderer(canvas);
const input = new InputSampler(stage);
const hud = new Hud(ui);
const fusion = new FusionReveal(ui);
const log = new RunLog();
hud.root.classList.add('hidden');

let state: AppState = 'home';
let world: World | null = null;
let rec: Recorder | null = null;
let screen: HTMLElement | null = null;
let acc = 0;
let last = performance.now();
let holdForFusion = false;
let botPickAt = 0;

function applySettings(s: Settings): void {
  audio.volume = s.volume;
  audio.muted = s.muted;
  const o = renderer.opts as unknown as Record<string, unknown>;
  o.reducedMotion = s.reducedMotion;
  o.damageNumbers = s.damageNumbers;
  o.screenShake = s.screenShake && !s.reducedMotion;
  document.documentElement.classList.toggle('dv-reduced', s.reducedMotion);
}
applySettings(save.settings);
const onSettings = (s: Settings): void => {
  save.settings = s;
  applySettings(s);
  persist();
};

const cards = new CardPicker(ui, (code: ChoiceCode) => {
  if (!world) return;
  const t = world.tick;
  if (choose(world, code)) rec?.choice(t, code);
  input.clearDash();
});
cards.onClick = () => audio.click();
cards.onShown = (kind) => {
  if (kind === 0) caption('card', 'Pick a card.', 2600);
};

hud.onPause = () => pause();
hud.onDash = () => input.queueDash();

function today(): number {
  const q = params.get('day');
  return q !== null && q !== '' && Number.isFinite(Number(q)) ? Math.floor(Number(q)) : dayNumber(Date.now());
}

function caption(id: string, text: string, ms = 3500): void {
  if (save.seenCaptions.includes(id)) return;
  save.seenCaptions.push(id);
  persistSoon();
  // while cards are up the caption sits at the bottom edge, clear of the buttons
  hud.say(text, ms, world?.offer.open != null);
}

function clearScreen(): void {
  screen?.remove();
  screen = null;
}

// ---------------------------------------------------------------------------------------------------
// HOME

function showHome(): void {
  clearScreen();
  fusion.cancel();
  state = 'home';
  input.enabled = false;
  input.release();
  hud.root.classList.add('hidden');
  cards.suppressed = true;
  cards.update(world ?? idleWorld());
  const day = today();
  const sv = runSave(day);
  const ds = peekDay(sv, day);
  const wk = weekNumber(day);
  screen = homeScreen(ui, {
    seed: seedForDay(day),
    msToReset: msUntilReset(Date.now()),
    bestSec: ds.bestSec,
    bestSpec: ds.bestSpec,
    bestKeywords: ds.bestKeywords,
    tries: ds.tries,
    dayPoints: ds.points,
    weekPoints: weekPoints(sv, day),
    totalPoints: sv.totalPoints,
    weekDays: weekDaysPlayed(sv, day),
    weekStrip: weekStrip(sv, day),
    todayIdx: day - (wk * 7 + 4),
    lastSpec: validSpec(save.lastSpec),
    firstTime: save.history.length === 0,
    settings: save.settings,
    saveNote: !FRESH && !saveHealth.ok ? "Progress can't be saved in this browser mode." : '',
  }, {
    onReset: () => {
      if (state === 'home') showHome();
    },
    onDive: (spec) => {
      if (save.seenCaptions.includes('onboard') || BOT) startRun(spec);
      else tour(() => startRun(spec));
    },
    onTour: () => tour(null),
    onSettings,
    onClick: () => {
      audio.unlock();
      audio.click();
    },
  });
  // idle world behind the title (never stepped): the renderer shows the lantern in layer 1
  if (!world || world.tick > 0) world = idleWorld();
}

/** First Dive onboarding; `then` runs the dive afterwards (null = just watching from How to play). */
function tour(then: (() => void) | null): void {
  audio.unlock();
  const home = screen;
  home?.classList.add('dv-under');
  showOnboarding(ui, () => {
    if (!save.seenCaptions.includes('onboard')) {
      save.seenCaptions.push('onboard');
      persist();
    }
    home?.classList.remove('dv-under');
    if (then && state === 'home') then();
  }, () => audio.click(), then ? 'Dive!' : 'Got it');
}

function validSpec(id: string): SpecId {
  return ((SPEC_IDS as readonly string[]).includes(id) ? id : 'ember') as SpecId;
}

function idleWorld(): World {
  const seed = seedForDay(today());
  return createWorld(seed, validSpec(save.lastSpec), buildModifiers(seed.omenId, seed.twistId));
}

// ---------------------------------------------------------------------------------------------------
// RUN

function startRun(spec: SpecId): void {
  audio.unlock();
  audio.click();
  clearScreen();
  fusion.cancel();
  const day = today();
  const ds = peekDay(runSave(day), day);
  const seed = seedForDay(day, ds.tries);
  save.lastSpec = spec;
  persist();
  const mods = buildModifiers(seed.omenId, seed.twistId);
  if (GUARD) mods.tags.add('debug-guard');
  world = createWorld(seed, spec, mods);
  rec = new Recorder(seed, spec, [...mods.tags].filter((t) => t.startsWith('debug-')));
  log.reset();
  acc = 0;
  holdForFusion = false;
  botPickAt = 0;
  state = 'run';
  input.reset();
  input.enabled = true;
  cards.suppressed = false;
  hud.reset();
  hud.root.classList.remove('hidden');
  const touch = matchMedia('(pointer: coarse)').matches;
  if (!save.seenCaptions.includes('move')) caption('move', touch ? 'Drag to move. You attack on your own.' : 'Drag or WASD to move. You attack on your own.', 4500);
  else hud.banner('Delve #' + day, layerDef(1).name, `Try ${ds.tries + 1}. Best ${ds.tries ? fmtTime(ds.bestSec) : '-'}`, '#ffc27a', 2000);
}

function pause(): void {
  if (state !== 'run' || !world) return;
  state = 'paused';
  input.release();
  input.enabled = false;
  audio.suspend(true);
  if (saveDirty) persist();
  const w = world;
  screen = pauseScreen(ui, save.settings, { time: fmtTime(w.tick * DT), where: w.layer <= 5 ? `Layer ${w.layer}` : 'The Core' }, {
    onResume: resume,
    onQuit: () => {
      audio.suspend(false);
      clearScreen();
      endRun(true);
    },
    onSettings,
  });
}

function resume(): void {
  if (state !== 'paused') return;
  clearScreen();
  audio.suspend(false);
  state = 'run';
  input.enabled = true;
  acc = 0;
  last = performance.now();
}

/** Settle the run (death or quit) and schedule the results screen. */
function endRun(quit: boolean): void {
  const w = world;
  if (!w || state === 'dead' || state === 'results') return;
  state = 'dead';
  input.enabled = false;
  input.release();
  const sec = w.tick * DT;
  const cause = quit ? DEATH.NONE : w.deathCause;
  const keywords = topKeywords(w.build.slotSpell, w.build.slotRank);
  let replay = '';
  try {
    if (rec) replay = serializeReplay(rec.finish());
  } catch {
    replay = '';
  }
  const sv = runSave(w.cfg.day);
  const out = settleRun(sv, {
    day: w.cfg.day, sec, damage: w.score.totalDamage, spec: w.specId, keywords, level: w.xp.level, kills: w.score.kills, cause, replay, at: Date.now(),
  });
  persist();
  const ds = peekDay(sv, w.cfg.day);
  const sum = deathSummary(cause, sec, log, {
    bossName: w.boss.defIdx >= 0 ? BOSSES[w.boss.defIdx]?.name : undefined,
    wyrmSec: sec - 720,
    staggerSec: w.score.staggerSeconds,
    dmgByCause: w.player.dmgByCause,
  });
  const share = shareText({ day: w.cfg.day, seconds: ds.bestSec, specId: (ds.bestSpec || w.specId) as SpecId, keywords: ds.bestKeywords, url: location.origin + location.pathname });
  const build: [number, number][] = [];
  for (let s = 0; s < w.build.slotSpell.length; s++) if (w.build.slotSpell[s] >= 0) build.push([w.build.slotSpell[s], w.build.slotRank[s]]);
  const data = {
    day: w.cfg.day, sec, title: sum.title, line: sum.line, tip: sum.tip,
    newBest: out.newBest, bestSec: ds.bestSec, prevBestSec: out.prevBestSec, firstOfDay: out.firstOfDay,
    gained: out.gained, dayPoints: out.dayPoints, top: topLabel(ds.bestSec), topPct: topPercent(ds.bestSec), tryTop: topLabel(sec),
    level: w.xp.level, kills: w.score.kills, bosses: w.score.bossesKilled, fusions: w.score.fusions, tries: ds.tries,
    specId: w.specId, build, relics: w.build.relics.map((id) => relicById(id)?.name ?? id), share, canShare: canNativeShare(),
    cause: quit ? 'quit' : 'death', bestSpec: ds.bestSpec || w.specId, bestKeywords: ds.bestKeywords, reduced: save.settings.reducedMotion,
  };
  const delay = quit ? 150 : 1500;
  window.setTimeout(() => {
    if (state !== 'dead') return;
    state = 'results';
    hud.root.classList.add('hidden');
    fusion.cancel();
    cards.suppressed = true;
    clearScreen();
    screen = resultsScreen(ui, data, {
      onAgain: () => startRun(w.specId),
      onHome: () => showHome(),
      onCopy: () => copyText(share),
      onShare: () => nativeShare(share),
      onStamp: () => audio.stamp(),
      onTally: (p) => audio.tally(p),
      onFanfare: () => audio.fanfare(),
    });
  }, delay);
}

// ---------------------------------------------------------------------------------------------------
// Events -> presentation

function drain(w: World): void {
  const ev = w.events;
  for (let i = 0; i < ev.n; i++) {
    const k = ev.kind[i];
    if (k === EV.FUSION && state === 'run') {
      holdForFusion = true;
      cards.suppressed = true;
      fusion.show(ev.a[i], save.settings.reducedMotion, {
        onWhoosh: (s) => audio.fusionWhoosh(s),
        onLand: () => audio.fusionBoom(),
        onResume: () => {
          holdForFusion = false;
          acc = 0;
          last = performance.now();
        },
        onDone: () => {
          cards.suppressed = false;
        },
      });
    } else if (k === EV.TELEGRAPH && ev.c[i] === TG_COLOR.RED) caption('red', 'Red floor = move!', 2600);
    else if (k === EV.CHEST && ev.a[i] === 0) caption('gold', 'Gold = grab!', 2400);
    else if (k === EV.BURST_HIT && ev.v[i] > 0) log.burstHits++;
  }
  renderer.onEvents(ev);
  audio.onEvents(ev, w);
  hud.onEvents(ev, w);
  ev.clear();
}

const tmpV = new THREE.Vector3();
const project: Projector = (x, y, out) => {
  tmpV.set(x, 0, -y).project(renderer.camera);
  const vw = stage.clientWidth;
  const vh = stage.clientHeight;
  out.x = ((tmpV.x + 1) / 2) * vw;
  out.y = ((1 - tmpV.y) / 2) * vh;
  out.onScreen = tmpV.z < 1 && out.x > 30 && out.x < vw - 30 && out.y > 90 && out.y < vh - 60;
};

let frameErrors = 0;
function frame(now: number): void {
  requestAnimationFrame(frame);
  try {
    frameInner(now);
    frameErrors = 0;
  } catch (err) {
    if (++frameErrors === 1) console.error(err);
    if (frameErrors > 30) showFatal(err);
  }
}

let uiPaused = false;
function frameInner(now: number): void {
  if (uiPaused !== (state === 'paused')) {
    uiPaused = state === 'paused';
    ui.classList.toggle('dv-paused', uiPaused);
  }
  const realDt = Math.min(0.25, (now - last) / 1000);
  last = now;
  const w = world;
  if (w && state === 'run') {
    if (!holdForFusion) {
      acc += realDt * SPEED;
      const maxSteps = 6 * SPEED;
      let steps = 0;
      while (acc >= DT && steps < maxSteps) {
        if (w.offer.open !== null || w.over) {
          acc = 0;
          break;
        }
        const f = BOT === '1' || BOT === 'move' ? botInput(w) : BOT === 'idle' ? 0 : input.sample();
        if (step(w, f)) {
          rec?.frame(f);
          if (w.tick % 60 === 0) log.sample(w.tick * DT, w.player.hp / Math.max(1, w.player.maxHp), w.en.count, w.score.kills);
        }
        acc -= DT;
        steps++;
        if (w.events.n > 7000) break; // drain before the queue overflows at high debug speeds
      }
      if (acc > DT * maxSteps) acc = 0;
    }
    if (BOT === '1' && w.offer.open && !fusion.active && cards.visible) {
      if (!botPickAt) botPickAt = now + (SPEED > 1 ? 150 : 600);
      else if (now >= botPickAt) {
        botPickAt = 0;
        const code = botChoose(w);
        const t = w.tick;
        if (choose(w, code)) rec?.choice(t, code);
      }
    }
  }
  if (w) {
    drain(w);
    if (state === 'run' || state === 'paused' || state === 'dead') {
      hud.update(w, project, stage.clientWidth, stage.clientHeight);
      if (state === 'run') cards.update(w);
    }
    if (state === 'run' && w.over) endRun(false);
    // first time a pile of gems lies uncollected: tell the player to walk into them
    if (state === 'run' && w.gm.count >= 15 && !w.offer.open && !save.seenCaptions.includes('gems')) caption('gems', 'Gold = grab! Walk over gems to level up.', 3200);
    renderer.render(w, state === 'paused' ? 0 : realDt);
  }
}

// ---------------------------------------------------------------------------------------------------
// Boot

function resize(): void {
  renderer.resize(stage.clientWidth, stage.clientHeight);
}
window.addEventListener('resize', resize);
window.visualViewport?.addEventListener('resize', resize);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    pause();
    audio.suspend(true); // every state: the home/results drone and fanfare must not play in a hidden tab
    if (saveDirty) persist();
  } else {
    if (state !== 'paused') audio.suspend(false);
    if (state === 'home') showHome(); // the daily may have reset while the tab was away
  }
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' || e.code === 'KeyP') {
    if (state === 'run' && !cards.visible) pause();
    else if (state === 'paused' && e.code === 'Escape') resume();
  } else if ((e.code === 'Enter' || e.code === 'Space') && state === 'home' && !(e.target instanceof HTMLButtonElement)) {
    (screen?.querySelector('.dv-dive') as HTMLButtonElement | null)?.click();
  }
});
// any first gesture unlocks audio (iOS needs a touch)
window.addEventListener('pointerdown', () => audio.unlock(), { once: true });

resize();
world = idleWorld();
showHome();
const go = params.get('go');
if (go && (SPEC_IDS as readonly string[]).includes(go)) startRun(go as SpecId);
requestAnimationFrame(frame);
booted = true;

// debug handles for tests and the console (read-only by convention)
const dbg = window as unknown as {
  __delve: () => World | null;
  __delveUI: () => { state: AppState; fusion: boolean; cards: boolean; speed: number; bot: string | null };
  __delveDebug: { setSpeed(n: number): void; setBot(mode: string | null): void; previewFusion(spellIdx: number, freeze?: 'spin' | 'land'): void; endPreview(): void; previewResults(sec: number, prevBestSec: number): void };
};
dbg.__delve = () => world;
dbg.__delveUI = () => ({ state, fusion: fusion.active, cards: cards.visible, speed: SPEED, bot: BOT });
// presentation-only knobs (the sim is still driven only by step/choose)
dbg.__delveDebug = {
  setSpeed: (n) => {
    SPEED = clampSpeed(n);
  },
  setBot: (mode) => {
    BOT = mode;
  },
  previewFusion: (spellIdx, freeze) => {
    fusion.show(spellIdx, save.settings.reducedMotion, { onWhoosh: (s) => audio.fusionWhoosh(s), onLand: () => audio.fusionBoom() }, freeze);
  },
  endPreview: () => fusion.cancel(),
  // screenshot aid: a results screen from made-up numbers (never touches the save)
  previewResults: (sec, prevBestSec) => {
    clearScreen();
    hud.root.classList.add('hidden');
    state = 'results';
    const best = Math.max(sec, prevBestSec);
    const kws = ['fire', 'storm', 'radiant'];
    const share = shareText({ day: today(), seconds: best, specId: 'ember', keywords: kws, url: location.origin + location.pathname });
    screen = resultsScreen(ui, {
      day: today(), sec, title: sec >= 720 ? 'The Wyrm took you at ' + fmtTime(sec) : 'Overrun at ' + fmtTime(sec), line: 'Preview of the results screen.', tip: 'Dash through red floor when you cannot walk out.',
      newBest: sec > prevBestSec, bestSec: best, prevBestSec, firstOfDay: prevBestSec <= 0, gained: sec > prevBestSec ? 220 : 0, dayPoints: 820,
      top: topLabel(sec), topPct: topPercent(sec), level: 41, kills: 7210, bosses: 5, fusions: 1, tries: 3, specId: 'ember',
      build: [[0, 5], [3, 5], [5, 4]], relics: ['Lantern Oil'], share, canShare: false, cause: 'death', bestSpec: 'ember', bestKeywords: kws, reduced: save.settings.reducedMotion,
    }, { onAgain: () => showHome(), onHome: () => showHome(), onCopy: () => copyText(share), onShare: () => nativeShare(share), onStamp: () => audio.stamp(), onTally: (p) => audio.tally(p), onFanfare: () => audio.fanfare() });
  },
};
