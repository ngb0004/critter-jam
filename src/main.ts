import { haptic, sfx } from './audio';
import { JamState, LevelDef, MoveEvent, addBenchSlots, canTap, currentVehicle, newState, tap } from './game/jam';
import { Rng } from './game/rng';
import { COLORS, JamScene } from './render3d/scene';
import { SaveData, loadSave, recordWin, writeSave } from './save';

/**
 * Critter Jam shell: screens, HUD, input, economy. The rules live in
 * game/jam.ts and the picture in render3d/scene.ts.
 */

type Screen = 'home' | 'playing' | 'won' | 'lost' | 'ad';

const OFFER_COINS = 150;
const OFFER_SLOTS = 2;
const AD_SLOTS = 1;
const WIN_COINS = 15;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $('stage');
const canvas = $<HTMLCanvasElement>('game');
const overlay = $('overlay');
const hud = $('hud');
const levelEl = $('level');
const coinsEl = $('coins');
const vehiclesEl = $('vehicles');
const benchEl = $('bench');
const toastEl = $('toast');

const params = new URLSearchParams(location.search);
const save: SaveData = loadSave();
sfx.enabled = save.sound;
let levels: LevelDef[] = [];
let scene: JamScene | null = null;
let state: JamState | null = null;
let screen: Screen = 'home';
let levelId = 1;
let offerUsed = false;
let cssW = 0;
let cssH = 0;
let autoTimer = 0;
const autoRng = new Rng(7);

// ---------------------------------------------------------------- layout

function layout(): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(vw, Math.round(vh * 0.62));
  stage.style.width = w + 'px';
  stage.style.height = vh + 'px';
  stage.style.left = Math.round((vw - w) / 2) + 'px';
  cssW = w;
  cssH = vh;
  scene?.resize(w, vh, window.devicePixelRatio || 1);
}
window.addEventListener('resize', layout);

function getScene(): JamScene {
  if (!scene) {
    scene = new JamScene(canvas);
    scene.resize(cssW, cssH, window.devicePixelRatio || 1);
  }
  return scene;
}

// ----------------------------------------------------------------- levels

async function loadLevels(): Promise<void> {
  const res = await fetch(import.meta.env.BASE_URL + 'levels.json');
  levels = (await res.json()) as LevelDef[];
}

function levelDef(id: number): LevelDef {
  // Past the authored set, loop with a fresh seed so play never stops.
  return { ...levels[(id - 1) % levels.length], id };
}

// ------------------------------------------------------------------ play

function startLevel(id: number): void {
  sfx.unlock();
  levelId = id;
  state = newState(levelDef(id));
  offerUsed = false;
  screen = 'playing';
  overlay.innerHTML = '';
  hud.classList.remove('hidden');
  getScene().load(state);
  updateHud();
  toast(`Level ${id}`);
}

function handleTap(cell: number): void {
  if (!state || screen !== 'playing') return;
  if (!canTap(state, cell)) {
    if (state.cells[cell] >= 0) {
      sfx.bad();
      scene!.nudge();
      haptic(8);
    }
    return;
  }
  const events = tap(state, cell)!;
  scene!.play(state, events);
  handleEvents(events);
  updateHud();
}

function handleEvents(events: MoveEvent[]): void {
  for (const e of events) {
    switch (e.type) {
      case 'board': {
        sfx.board(state!.fill);
        const v = scene!.vehicleSpot();
        scene!.burst(v.x, v.z, COLORS[e.color]);
        haptic(6);
        break;
      }
      case 'bench':
        sfx.bench();
        break;
      case 'benchBoard':
        sfx.board(0);
        break;
      case 'depart':
        sfx.depart();
        haptic(12);
        break;
      case 'won':
        window.setTimeout(finishWin, 900);
        break;
      case 'lost':
        window.setTimeout(showLost, 600);
        break;
      default:
        break;
    }
  }
}

function updateHud(): void {
  if (!state) return;
  const s = state;
  levelEl.textContent = `Level ${levelId}`;
  coinsEl.textContent = `🪙 ${save.coins}`;
  const left = s.def.vehicles.length - s.vehicleIdx;
  const v = currentVehicle(s);
  vehiclesEl.innerHTML = `<span class="swatch" style="background:${hex(v)}"></span> ${left} to go`;
  const slots: string[] = [];
  for (let i = 0; i < s.def.benchSlots; i++) {
    const c = s.bench[i];
    slots.push(`<i class="${c === undefined ? '' : 'on'}" style="${c === undefined ? '' : `background:${hex(c)}`}"></i>`);
  }
  benchEl.innerHTML = slots.join('');
  benchEl.classList.toggle('danger', s.bench.length >= s.def.benchSlots - 1);
}

function hex(c: number | null): string {
  return c === null ? '#ccc' : '#' + COLORS[c].toString(16).padStart(6, '0');
}

function toast(text: string): void {
  toastEl.textContent = text;
  toastEl.classList.remove('show');
  void toastEl.offsetWidth;
  toastEl.classList.add('show');
}

// --------------------------------------------------------------- results

function finishWin(): void {
  if (!state || screen !== 'playing') return;
  screen = 'won';
  const spare = state.def.benchSlots - state.bench.length;
  const bonus = Math.max(0, spare - 2) * 3;
  const coins = WIN_COINS + bonus;
  save.coins += coins;
  save.wins++;
  if (levelId >= save.level) save.level = levelId + 1;
  const streak = recordWin(save);
  writeSave(save);
  sfx.win();
  haptic(30);
  overlay.innerHTML = `
    <div class="screen center">
      <div class="card pop">
        <div class="big">🎉</div>
        <h2>Level ${levelId} clear!</h2>
        <p class="coins-won">🪙 +${coins}${bonus ? ` <small>(+${bonus} tidy bench)</small>` : ''}</p>
        ${streak.extended ? `<p class="streak">🔥 ${save.streak}-day streak${streak.frozeDay ? ' <small>(freeze used)</small>' : ''}</p>` : ''}
        <button class="btn primary" data-act="next">Next level ▶</button>
        <button class="btn ghost" data-act="home">Home</button>
      </div>
    </div>`;
  hud.classList.add('hidden');
}

function showLost(): void {
  if (!state || screen !== 'playing') return;
  screen = 'lost';
  sfx.lose();
  haptic(40);
  const left = state.def.vehicles.length - state.vehicleIdx;
  const total = state.def.vehicles.length;
  const canPay = save.coins >= OFFER_COINS && !offerUsed;
  overlay.innerHTML = `
    <div class="screen center dim">
      <div class="card pop">
        <h2>Bench full!</h2>
        <p class="muted">${total - left} of ${total} buses away. So close.</p>
        <div class="offer">
          <div class="offer-art">🪑🪑</div>
          <div>
            <b>+${OFFER_SLOTS} bench seats</b>
            <div class="muted">and keep going</div>
          </div>
          <button class="btn primary" data-act="offer" ${canPay ? '' : 'disabled'}>🪙 ${OFFER_COINS}</button>
        </div>
        <button class="btn green" data-act="ad">▶ Watch ad for +${AD_SLOTS} seat</button>
        <button class="btn ghost" data-act="retry">Give up</button>
      </div>
    </div>`;
}

function continueWith(slots: number): void {
  if (!state) return;
  addBenchSlots(state, slots);
  screen = 'playing';
  overlay.innerHTML = '';
  hud.classList.remove('hidden');
  scene!.load(stateSnapshotForScene());
  updateHud();
  toast(`+${slots} seat${slots > 1 ? 's' : ''}!`);
}

/** The scene rebuilds from the current state (bench grew), so re-load it as is. */
function stateSnapshotForScene(): JamState {
  return state!;
}

/** Placeholder rewarded ad: a short countdown. Swapped for a real SDK on the app build. */
function showFakeAd(onDone: () => void): void {
  screen = 'ad';
  let left = 3;
  overlay.innerHTML = `<div class="screen center ad"><div class="card"><p class="muted">Ad</p><h2 id="ad-count">${left}</h2><p class="muted">(placeholder: a rewarded video plays here)</p></div></div>`;
  const t = window.setInterval(() => {
    left--;
    const el = document.getElementById('ad-count');
    if (el) el.textContent = String(left);
    if (left <= 0) {
      window.clearInterval(t);
      onDone();
    }
  }, 1000);
}

// ------------------------------------------------------------------ home

function showHome(): void {
  screen = 'home';
  hud.classList.add('hidden');
  const next = save.level;
  overlay.innerHTML = `
    <div class="screen home">
      <div class="logo"><div class="emoji">🚌🐾</div><h1>Critter Jam</h1><p>Tap a critter. Fill the bus.</p></div>
      <div class="stats">
        <span>🪙 ${save.coins}</span>
        <span>🔥 ${save.streak}</span>
      </div>
      <div style="flex:1"></div>
      <div class="card center">
        <p class="muted" style="margin:0">Level ${next}</p>
        <button class="btn primary big-btn" data-act="play" data-level="${next}">Play ▶</button>
      </div>
      <div class="row">
        <button class="toggle" data-act="sound">Sound: ${save.sound ? 'on' : 'off'}</button>
        ${next > 1 ? `<button class="toggle" data-act="replay">Replay a level</button>` : ''}
      </div>
    </div>`;
  if (!scene || !state) {
    // Show the first level behind the menu.
    state = newState(levelDef(next));
    getScene().load(state);
  }
}

// ----------------------------------------------------------------- input

let pointerDown = false;
canvas.addEventListener('pointerdown', (e) => {
  sfx.unlock();
  pointerDown = true;
  const r = canvas.getBoundingClientRect();
  const cell = getScene().pick(e.clientX - r.left, e.clientY - r.top);
  if (cell >= 0) handleTap(cell);
});
canvas.addEventListener('pointerup', () => (pointerDown = false));
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || pointerDown) return;
  const r = canvas.getBoundingClientRect();
  const cell = getScene().pick(e.clientX - r.left, e.clientY - r.top);
  scene?.setHighlight(state && cell >= 0 && canTap(state, cell) ? cell : -1);
});

overlay.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el) return;
  sfx.unlock();
  switch (el.dataset.act) {
    case 'play':
      startLevel(Number(el.dataset.level) || save.level);
      break;
    case 'next':
      startLevel(levelId + 1);
      break;
    case 'retry':
      startLevel(levelId);
      break;
    case 'home':
      showHome();
      break;
    case 'offer':
      if (save.coins >= OFFER_COINS) {
        save.coins -= OFFER_COINS;
        offerUsed = true;
        writeSave(save);
        sfx.coin();
        continueWith(OFFER_SLOTS);
      }
      break;
    case 'ad':
      showFakeAd(() => continueWith(AD_SLOTS));
      break;
    case 'sound':
      save.sound = !save.sound;
      sfx.enabled = save.sound;
      writeSave(save);
      showHome();
      break;
    case 'replay': {
      const n = Number(prompt(`Which level? (1–${save.level - 1})`));
      if (n >= 1 && n < save.level) startLevel(n);
      break;
    }
  }
});

// ------------------------------------------------------------------ loop

// ?capture steps the game one video frame at a time (see __jam.advance) for smooth ad recording.
const capture = params.has('capture');
let virtualNow = 0;

function frame(now: number): void {
  if (!capture) requestAnimationFrame(frame);
  tick(now);
}

function tick(now: number): void {
  const t = now / 1000;
  if (params.has('auto') && state && screen === 'playing' && t > autoTimer) {
    // Autopilot for testing and ad recording: a casual bot's next move.
    autoTimer = t + 0.45;
    const cells: number[] = [];
    for (let i = 0; i < state.cells.length; i++) if (canTap(state, i)) cells.push(i);
    const v = currentVehicle(state);
    const match = cells.filter((i) => state!.cells[i] === v);
    const pick = match.length ? match[0] : cells[autoRng.int(cells.length)];
    if (pick !== undefined) handleTap(pick);
  }
  scene?.render(t);
}

(window as unknown as { __jam: unknown }).__jam = {
  get state() {
    return state;
  },
  get scene() {
    return scene;
  },
  startLevel,
  save,
  tap: handleTap,
  /** Capture mode: advance by whole video frames. */
  advance(frames = 1, fps = 30) {
    for (let i = 0; i < frames; i++) {
      virtualNow += 1000 / fps;
      tick(virtualNow);
    }
  },
};

layout();
void loadLevels().then(() => {
  const lv = Number(params.get('level'));
  if (lv) startLevel(lv);
  else showHome();
  if (capture) tick(0);
  else requestAnimationFrame(frame);
});
