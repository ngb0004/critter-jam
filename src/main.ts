import { haptic, sfx } from './audio';
import { JamState, LevelDef, MoveEvent, addBenchSlots, canTap, cloneState, currentVehicle, fits, magnet, newState, shuffle, tap } from './game/jam';
import { solveFrom } from './game/solver';
import { Rng } from './game/rng';
import { COLORS, JamScene, SKINS, SkinName } from './render3d/scene';
import { SaveData, loadSave, recordWin, writeSave } from './save';

/**
 * Critter Jam shell: screens, HUD, input, economy. The rules live in
 * game/jam.ts and the picture in render3d/scene.ts.
 */

type Screen = 'home' | 'playing' | 'won' | 'lost' | 'ad' | 'shop';

const OFFER_COINS = 150;
const OFFER_SLOTS = 2;
const AD_SLOTS = 1;
const WIN_COINS = 15;
/** Boosters: what they cost in coins, and how they're described in the shop. */
type Booster = 'undo' | 'magnet' | 'shuffle';
const BOOSTERS: Record<Booster, { cost: number; icon: string; name: string; blurb: string }> = {
  undo: { cost: 40, icon: '↶', name: 'Undo', blurb: 'Take back your last move.' },
  magnet: { cost: 120, icon: '🧲', name: 'Magnet', blurb: 'Fill the current cart from anywhere.' },
  shuffle: { cost: 80, icon: '🔀', name: 'Shuffle', blurb: 'Deal the remaining pieces again.' },
};
/** A free booster every few wins keeps the habit going. */
const GIFT_EVERY = 3;

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
const chainEl = $('chain');

const params = new URLSearchParams(location.search);
// ?skin=gems|critters picks the look; gems is the default.
const skinName: SkinName = params.get('skin') === 'critters' ? 'critters' : 'gems';
const skin = SKINS[skinName];
document.title = skin.title;
document.documentElement.style.setProperty('--sky', '#' + skin.sky.toString(16).padStart(6, '0'));
const save: SaveData = loadSave();
sfx.enabled = save.sound;
let levels: LevelDef[] = [];
let scene: JamScene | null = null;
let state: JamState | null = null;
let screen: Screen = 'home';
let levelId = 1;
let offerUsed = false;
/** Undo history: states before each tap, newest last. */
let history: JamState[] = [];
/** Consecutive direct boardings without benching. */
let chain = 0;
const shuffleRng = new Rng(Date.now() & 0xffff);
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
    scene = new JamScene(canvas, skinName);
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
  history = [];
  chain = 0;
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
  history.push(cloneState(state));
  if (history.length > 30) history.shift();
  const events = tap(state, cell)!;
  scene!.play(state, events);
  handleEvents(events);
  updateHud();
}

// -------------------------------------------------------------- boosters

function useBooster(kind: Booster): void {
  if (!state || screen !== 'playing') return;
  if (save.boosters[kind] <= 0) {
    showShop(kind);
    return;
  }
  let used = false;
  switch (kind) {
    case 'undo': {
      const prev = history.pop();
      if (!prev) break;
      state = prev;
      scene!.load(state);
      chain = 0;
      used = true;
      break;
    }
    case 'magnet': {
      history.push(cloneState(state));
      const events = magnet(state);
      if (!events) {
        history.pop();
        break;
      }
      scene!.play(state, events);
      handleEvents(events);
      used = true;
      break;
    }
    case 'shuffle': {
      // Deal again until the solver says it's still winnable (it nearly always is first time).
      let dealt: JamState | null = null;
      for (let i = 0; i < 8 && !dealt; i++) {
        const trial = cloneState(state);
        shuffle(trial, () => shuffleRng.next());
        if (solveFrom(trial, 60_000).solvable) dealt = trial;
      }
      if (!dealt) break;
      history.push(cloneState(state));
      state = dealt;
      scene!.load(state);
      used = true;
      break;
    }
  }
  if (!used) {
    sfx.bad();
    toast(kind === 'undo' ? 'Nothing to undo' : 'No effect');
    return;
  }
  save.boosters[kind]--;
  writeSave(save);
  sfx.coin();
  haptic(12);
  updateHud();
}

function showShop(kind: Booster): void {
  const b = BOOSTERS[kind];
  const can = save.coins >= b.cost;
  screen = 'shop';
  overlay.innerHTML = `
    <div class="screen center dim">
      <div class="card pop">
        <div class="shop">
          <div class="ic">${b.icon}</div>
          <div><b>${b.name}</b><div class="muted" style="text-align:left">${b.blurb}</div></div>
          <button class="btn primary" data-act="buy" data-kind="${kind}" ${can ? '' : 'disabled'}>🪙 ${b.cost}</button>
        </div>
        ${can ? '' : `<p class="muted">You have 🪙 ${save.coins}. Win levels to earn more.</p>`}
        <button class="btn ghost" data-act="close">Close</button>
      </div>
    </div>`;
}

function bumpChain(events: MoveEvent[]): void {
  for (const e of events) {
    if (e.type === 'bench') chain = 0;
    if (e.type === 'board' || e.type === 'pull') {
      chain++;
      if (chain >= 3) {
        const hot = chain >= 6;
        chainEl.textContent = hot ? `🔥 CHAIN ×${chain}!` : `Chain ×${chain}`;
        chainEl.className = `chain show${hot ? ' hot' : ''}`;
        void chainEl.offsetWidth;
        chainEl.classList.add('show');
        if (chain === 5 || chain === 10 || chain === 15) {
          const bonus = chain === 5 ? 5 : chain === 10 ? 15 : 30;
          save.coins += bonus;
          writeSave(save);
          sfx.coin();
          toast(`+${bonus} 🪙 chain bonus!`);
        }
      }
    }
  }
}

function handleEvents(events: MoveEvent[]): void {
  bumpChain(events);
  for (const e of events) {
    switch (e.type) {
      case 'board':
      case 'pull': {
        sfx.board(state!.fill);
        const v = scene!.vehicleSpot();
        scene!.burst(v.x, v.z, COLORS[e.color] ?? 0xffffff, e.type === 'pull' ? 14 : 8);
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
  for (const k of ['undo', 'magnet', 'shuffle'] as Booster[]) {
    const n = save.boosters[k];
    const el = document.getElementById('n-' + k)!;
    el.textContent = n > 0 ? String(n) : '';
    el.parentElement!.classList.toggle('empty', n <= 0);
  }
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
  // A gift booster every few wins.
  let gift: Booster | null = null;
  if (save.wins % GIFT_EVERY === 0) {
    gift = (['undo', 'magnet', 'shuffle'] as Booster[])[Math.floor(save.wins / GIFT_EVERY) % 3];
    save.boosters[gift]++;
  }
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
        <p class="coins-won">🪙 +${coins}${bonus ? ` <small>(+${bonus} tidy tray)</small>` : ''}</p>
        ${streak.extended ? `<p class="streak">🔥 ${save.streak}-day streak${streak.frozeDay ? ' <small>(freeze used)</small>' : ''}</p>` : ''}
        ${gift ? `<p class="gift">${BOOSTERS[gift].icon} +1 ${BOOSTERS[gift].name} <small>gift!</small></p>` : ''}
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
        <h2>${skinName === 'gems' ? 'Tray full!' : 'Bench full!'}</h2>
        <p class="muted">${total - left} of ${total} ${skinName === 'gems' ? 'carts' : 'buses'} away. So close.</p>
        <div class="offer">
          <div class="offer-art">${skinName === 'gems' ? '🪙✨' : '🪑🪑'}</div>
          <div>
            <b>+${OFFER_SLOTS} tray slots</b>
            <div class="muted">and keep going</div>
          </div>
          <button class="btn primary" data-act="offer" ${canPay ? '' : 'disabled'}>🪙 ${OFFER_COINS}</button>
        </div>
        <button class="btn green" data-act="ad">▶ Watch ad for +${AD_SLOTS} slot</button>
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
  scene!.load(state);
  updateHud();
  toast(`+${slots} slot${slots > 1 ? 's' : ''}!`);
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
      <div class="logo"><div class="emoji">${skinName === 'gems' ? '💎' : '🚌🐾'}</div><h1>${skin.title}</h1><p>${skin.tagline}</p></div>
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

hud.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-boost]');
  if (!el) return;
  sfx.unlock();
  useBooster(el.dataset.boost as Booster);
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
    case 'buy': {
      const kind = el.dataset.kind as Booster;
      if (save.coins >= BOOSTERS[kind].cost) {
        save.coins -= BOOSTERS[kind].cost;
        save.boosters[kind]++;
        writeSave(save);
        sfx.coin();
      }
      overlay.innerHTML = '';
      screen = 'playing';
      updateHud();
      if (save.boosters[kind] > 0) useBooster(kind);
      break;
    }
    case 'close':
      overlay.innerHTML = '';
      screen = 'playing';
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
    const match = cells.filter((i) => v !== null && fits(state!.cells[i], v));
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
