/**
 * Headless delver bots (BOT). They play the REAL sim through the same two doors a human uses: one input
 * byte per tick and offer choice codes. Bots only READ the World, so any bot run is an ordinary replay.
 *
 * Movement (one skill scalar `e` in 0..1, every derived knob overridable):
 *  - Every `decideEvery` ticks it scores 16 headings + standing still over a short look-ahead: crowd
 *    threat inside its kiting radius (bosses and elites weigh more), noticed red floor at its impact time,
 *    arena walls, gems (greed), a circle-the-arena flow, momentum and per-decision noise (low skill =
 *    noisier, slower to re-decide, smaller kiting radius, more distracted).
 *  - Telegraphs are noticed per telegraph with probability `notice` after a reaction delay `reactTicks`
 *    (decided from the bot seed + telegraph uid, so it is stable and replayable).
 *  - Dash: used to clear a noticed telegraph it cannot walk out of in time (chance `dashUse` per
 *    telegraph) and as a panic button when pinned.
 *  - Wyrmfall: stands in the gold maw ring with probability `ringUse` (the stagger source).
 *  - Distraction: low skill bots occasionally fumble (hold a stale heading or stop) for a moment.
 *
 * Picks (`policy`):
 *  - 'random': a uniformly random card, no rerolls or banishes.
 *  - 'decent': the value heuristic with noise (sometimes a random card); rerolls only bad offers.
 *  - 'greedy': the value heuristic, rerolls weak offers, banishes a dead card once.
 *
 * Compatibility: `botInput(w, { e })` and `botChoose(w)` keep the old stateless signatures (the page's
 * `?bot=1`, the replay test); they keep one Delver per World in a WeakMap.
 */
import { BAL } from '../core/constants';
import { DIR_X, DIR_Y } from '../core/fmath';
import { encodeInput } from '../core/input';
import { Rng } from '../core/rng';
import type { ChoiceCode, InputFrame } from '../core/types';
import { CH_BANISH, CH_PICK, CH_REROLL, EF, TGF, kwBit } from '../core/types';
import type { World } from '../core/world';
import type { Card } from '../sim/offers';
import { OK } from '../sim/offers';
import { pointInTelegraph } from '../sim/hazards';
import { RELICS } from '../content/relics';
import { SPELLS } from '../content/spells';
import { SPECS } from '../content/specs';

export type PickPolicy = 'random' | 'decent' | 'greedy';

export interface BotSkill {
  /** 0..1 execution skill. Everything below derives from it unless given. */
  e: number;
  /** Chance to notice a given telegraph at all. */
  notice?: number;
  /** Ticks after a telegraph appears before the bot reacts to it. */
  reactTicks?: number;
  /** Metres: enemies inside this push the bot away (the kiting radius). */
  kiteR?: number;
  /** Ticks between movement decisions (human sluggishness). */
  decideEvery?: number;
  /** Score noise per decision (bad headings). */
  noise?: number;
  /** Chance to use the dash to clear a telegraph it cannot walk out of. */
  dashUse?: number;
  /** Chance per Wyrmfall to commit to the maw ring. */
  ringUse?: number;
  /** Fumbles per minute (stale heading / stop for 0.2-0.7 s). */
  fumble?: number;
  /** Gem greed multiplier. */
  greed?: number;
  /** Seconds of look-ahead when scoring headings (foresight). */
  horizon?: number;
  /** Weight of the circle-the-arena habit (good players kite in loops). */
  flow?: number;
  /** When nothing is close: drift toward the horde so spells keep killing (farming). */
  engage?: number;
  /** 0..1 how much the crowd around it registers (casual players watch gems and cards, not the horde). */
  crowdAware?: number;
}

export interface BotConfig {
  skill: BotSkill;
  policy: PickPolicy;
  /** Bot identity: seeds its own noise and pick randomness (not the sim's). */
  seed: number;
}

interface Derived {
  notice: number;
  reactTicks: number;
  kiteR: number;
  decideEvery: number;
  noise: number;
  dashUse: number;
  ringUse: number;
  fumble: number;
  greed: number;
  horizon: number;
  flow: number;
  engage: number;
  crowdAware: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The skill model: how `e` maps onto human-like knobs (BOT tuning lives here). */
export function deriveSkill(s: BotSkill): Derived {
  const e = clamp01(s.e);
  return {
    notice: s.notice ?? 0.72 + 0.27 * e,
    reactTicks: s.reactTicks ?? Math.round(30 - 22 * e),
    kiteR: s.kiteR ?? 0.8 + 1.8 * e,
    decideEvery: s.decideEvery ?? Math.max(2, Math.round(12 - 9 * e)),
    noise: s.noise ?? 1.6 * (1 - e) * (1 - e) + 0.05,
    dashUse: s.dashUse ?? clamp01(-0.1 + 1.05 * e),
    ringUse: s.ringUse ?? clamp01(0.15 + 0.85 * e),
    fumble: s.fumble ?? 10 * (1 - e) * (1 - e),
    greed: s.greed ?? 0.9,
    horizon: s.horizon ?? 0.25 + 0.85 * e,
    flow: s.flow ?? 0.2 + 1.6 * e,
    engage: s.engage ?? 1.2 * e,
    crowdAware: s.crowdAware ?? 0.3 + 0.7 * e,
  };
}

const NDIR = 16;
const MAXN = 256;
const hash32 = (a: number, b: number): number => {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
};

export class Delver {
  readonly cfg: BotConfig;
  readonly k: Derived;
  private readonly rng: Rng;
  private held: InputFrame = 0;
  private heldDx = 0;
  private heldDy = 0;
  private nextDecide = 0;
  private fumbleUntil = -1;
  private ringCommit = -1; // -1 undecided, 0 no, 1 yes
  private panicCd = 0;
  // scratch (no per-tick allocation)
  private readonly nx = new Float32Array(MAXN);
  private readonly ny = new Float32Array(MAXN);
  private readonly nw = new Float32Array(MAXN);
  private readonly nr = new Float32Array(MAXN);
  private readonly ns = new Float32Array(MAXN);
  private readonly tgList = new Int32Array(96);
  private readonly gx = new Float32Array(MAXN);
  private readonly gy = new Float32Array(MAXN);
  private readonly gv = new Float32Array(MAXN);
  private readonly score = new Float64Array(NDIR + 1);
  /** Telemetry: level-up offers seen, rerolls, banishes. */
  rerolls = 0;
  banishes = 0;

  constructor(cfg: BotConfig) {
    this.cfg = cfg;
    this.k = deriveSkill(cfg.skill);
    this.rng = new Rng(cfg.seed ^ 0x5bd1e995);
  }

  /** Is telegraph i noticed by this bot (stable per telegraph)? */
  private notices(w: World, i: number): boolean {
    return hash32(this.cfg.seed, w.tg.uid[i]) < this.k.notice;
  }

  input(w: World): InputFrame {
    const p = w.player;
    const k = this.k;
    const tick = w.tick;
    if (this.panicCd > 0) this.panicCd--;

    // urgent: a noticed telegraph about to land on us overrides the decision cadence
    const tg = w.tg;
    let nT = 0;
    let urgent = false;
    for (let i = 0; i < tg.hi && nT < 96; i++) {
      if (!tg.alive[i] || tg.dmgPct[i] <= 0 || tg.flags[i] & TGF.MAW) continue;
      const lingering = tg.resolved[i] && tg.flags[i] & TGF.LINGER_HURTS && tick < tg.impact[i] + tg.linger[i];
      if (tg.resolved[i] && !lingering) continue;
      if (tick - tg.start[i] < k.reactTicks) continue;
      if (!this.notices(w, i)) continue;
      this.tgList[nT++] = i;
      if (pointInTelegraph(w, i, p.x, p.y, 0.45)) urgent = true;
    }

    if (tick < this.fumbleUntil && !urgent) return this.held;
    if (tick < this.nextDecide && !urgent) return this.held & 0x7f;
    this.nextDecide = tick + k.decideEvery;
    if (k.fumble > 0 && this.rng.next() < (k.fumble / 3600) * k.decideEvery) {
      this.fumbleUntil = tick + 12 + this.rng.int(42);
      if (this.rng.next() < 0.5) this.held = 0; // stopped to look at something
      return this.held;
    }

    // --- gather nearby threats ---
    const en = w.en;
    const speed = 5.2 * w.stats.moveSpeedMul;
    const H = k.horizon;
    const scan = k.kiteR + H * (speed + 4) + 1;
    let n = 0;
    let bossNear = false;
    for (let i = 0; i < en.hi && n < MAXN; i++) {
      if (!en.alive[i]) continue;
      const f = en.flags[i];
      if (f & EF.WYRM) continue;
      const dx = en.x[i] - p.x;
      const dy = en.y[i] - p.y;
      const big = f & (EF.BOSS | EF.ELITE) ? 1 : 0;
      const lim = scan + (big ? 3 : 0) + en.r[i];
      if (dx * dx + dy * dy > lim * lim) continue;
      this.nx[n] = en.x[i];
      this.ny[n] = en.y[i];
      this.nr[n] = en.r[i];
      this.ns[n] = en.speed[i] * en.slow[i];
      this.nw[n] = big ? 3.5 : f & EF.CLUMP ? 1.8 : 1;
      if (big) bossNear = true;
      n++;
    }

    // nearest threat now: when nothing is close, skilled players stop running and let the horde come into range
    let dmin = 1e9;
    let nearX = 0;
    let nearY = 0;
    for (let j = 0; j < n; j++) {
      const dx = this.nx[j] - p.x;
      const dy = this.ny[j] - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < dmin) {
        dmin = d2;
        nearX = dx;
        nearY = dy;
      }
    }
    dmin = Math.sqrt(dmin);
    const safe = dmin > k.kiteR + 2;
    const nl = dmin > 0 && dmin < 1e8 ? dmin : 1;
    nearX /= nl;
    nearY /= nl;
    const h = w.hazard;
    if (h.mawOpen && this.ringCommit < 0) this.ringCommit = this.rng.next() < k.ringUse ? 1 : 0;
    const goMaw = h.mawOpen && this.ringCommit === 1;

    const R = w.arenaR;
    const cr = Math.sqrt(p.x * p.x + p.y * p.y) || 1;
    // flow: circle the arena at ~45% radius (keeps room to run and sweeps gems)
    const flowR = R * 0.45;
    const tx = -p.y / cr;
    const ty = p.x / cr;
    const inward = (cr - flowR) / R;
    const gm = w.gm;
    let ng = 0;
    if (k.greed > 0) {
      for (let i = 0; i < gm.hi && ng < MAXN; i++) {
        if (!gm.alive[i] || gm.state[i] !== 0) continue;
        const gx = gm.x[i] - p.x;
        const gy = gm.y[i] - p.y;
        if (gx * gx + gy * gy > 144) continue;
        this.gx[ng] = gm.x[i];
        this.gy[ng] = gm.y[i];
        this.gv[ng] = gm.tier[i] === 4 ? 40 : gm.tier[i] === 5 ? 25 * (1 - p.hp / p.maxHp) : gm.value[i] + 1;
        ng++;
      }
    }
    const s = this.score;
    let best = NDIR;
    let bestScore = -1e18;
    for (let d = 0; d <= NDIR; d++) {
      const mv = d < NDIR ? 1 : 0;
      const ux = mv ? DIR_X[d * 4] : 0;
      const uy = mv ? DIR_Y[d * 4] : 0;
      const qx = p.x + ux * speed * H;
      const qy = p.y + uy * speed * H;
      let sc = 0;
      // crowd: sample the path at 3 look-ahead times; enemies close in on the lantern meanwhile
      const crowdW = (goMaw && h.inMaw ? 0.35 : 1) * k.crowdAware;
      for (let st = 1; st <= 3; st++) {
        const tt = (H * st) / 3;
        let px = p.x + ux * speed * tt;
        let py = p.y + uy * speed * tt;
        const pr = Math.sqrt(px * px + py * py);
        if (pr > R - 0.6) {
          px *= (R - 0.6) / pr;
          py *= (R - 0.6) / pr;
        }
        const wt = st === 1 ? 1.4 : st === 2 ? 1 : 0.7;
        for (let j = 0; j < n; j++) {
          let ex = this.nx[j];
          let ey = this.ny[j];
          // the enemy chases where we are now (that is how they move)
          const cx = p.x - ex;
          const cy = p.y - ey;
          const cd = Math.sqrt(cx * cx + cy * cy) || 1;
          let step = this.ns[j] * tt;
          if (step > cd - 0.3) step = cd - 0.3 > 0 ? cd - 0.3 : 0;
          ex += (cx / cd) * step;
          ey += (cy / cd) * step;
          const dx = px - ex;
          const dy = py - ey;
          let dd = Math.sqrt(dx * dx + dy * dy) - this.nr[j] - 0.32;
          if (dd < 0) dd = 0;
          if (dd < k.kiteR) {
            const f = (k.kiteR - dd) / k.kiteR;
            sc -= this.nw[j] * wt * crowdW * (f * f * 5 + (dd < 0.35 ? 10 : 0));
          }
        }
      }
      // noticed red floor: will we be inside when it lands?
      for (let j = 0; j < nT; j++) {
        const i = this.tgList[j];
        let left = (tg.impact[i] - tick) / 60;
        if (tg.resolved[i]) left = 0;
        const tt = left < 0.05 ? 0.05 : left > H ? H : left;
        const ax = p.x + ux * speed * tt;
        const ay = p.y + uy * speed * tt;
        if (pointInTelegraph(w, i, ax, ay, 0.5)) sc -= 260 + (tg.flags[i] & TGF.BOSS ? 80 : 0);
        else if (pointInTelegraph(w, i, qx, qy, 0.5)) sc -= 40;
      }
      // walls (being pinned against the rock is how runs end)
      const qr = Math.sqrt(qx * qx + qy * qy);
      if (qr > R - 3) sc -= (qr - (R - 3)) * (10 + 20 * k.flow);
      // flow: the circle-the-arena habit
      if (!goMaw) {
        sc += (safe ? 0.35 : 1) * k.flow * ((ux * tx + uy * ty) * 1.2 - ((ux * p.x + uy * p.y) / cr) * inward * 4);
        if (safe && n > 0) sc += k.engage * (ux * nearX + uy * nearY) * 2;
      }
      else {
        const mx = h.mawX - qx;
        const my = h.mawY - qy;
        const md = Math.sqrt(mx * mx + my * my);
        sc -= md * (h.wyrmActive ? 5 : 2.5);
        if (md < h.mawR - 0.8) sc += 12;
      }
      // gems (gold = grab)
      if (k.greed > 0) {
        let g = 0;
        for (let i = 0; i < ng; i++) {
          const gx = this.gx[i] - qx;
          const gy = this.gy[i] - qy;
          const g2 = gx * gx + gy * gy;
          if (g2 > 81) continue;
          g += this.gv[i] / (1 + g2 * 0.35);
        }
        sc += k.greed * (g > 30 ? 30 : g) * 0.35;
      }
      // momentum, and a bias against standing still
      if (mv) sc += (ux * this.heldDx + uy * this.heldDy) * 0.8;
      else sc -= 1.5;
      sc += (this.rng.next() - 0.5) * k.noise * 8;
      s[d] = sc;
      if (sc > bestScore) {
        bestScore = sc;
        best = d;
      }
    }

    let dash = false;
    if (best < NDIR) {
      this.heldDx = DIR_X[best * 4];
      this.heldDy = DIR_Y[best * 4];
    } else {
      this.heldDx = 0;
      this.heldDy = 0;
    }
    // dash: a telegraph we cannot walk out of, landing soon
    if (urgent && p.dashCharges > 0 && p.dashTicks === 0) {
      for (let j = 0; j < nT; j++) {
        const i = this.tgList[j];
        if (tg.resolved[i]) continue;
        const left = tg.impact[i] - tick;
        if (left > 12 || left < 0) continue;
        if (!pointInTelegraph(w, i, p.x + this.heldDx * speed * (left / 60), p.y + this.heldDy * speed * (left / 60), 0.35)) continue;
        if (hash32(this.cfg.seed ^ 0xda54, w.tg.uid[i]) < k.dashUse) dash = true;
        break;
      }
    }
    // panic dash when pinned (skilled bots only)
    if (!dash && this.panicCd === 0 && p.dashCharges > 0 && p.hp < p.maxHp * 0.45 && bestScore < -25 && best < NDIR) {
      if (this.rng.next() < k.dashUse * 0.6) dash = true;
      this.panicCd = 90;
    }
    void bossNear;
    this.held = best < NDIR ? encodeInput(this.heldDx, this.heldDy, false) : 0;
    return dash ? this.held | 0x80 : this.held;
  }

  // ------------------------------------------------------------------ picks

  choose(w: World): ChoiceCode {
    const open = w.offer.open;
    if (!open || open.cards.length === 0) return CH_PICK;
    const cards = open.cards;
    const pol = this.cfg.policy;
    if (pol === 'random') return CH_PICK + this.rng.int(cards.length);
    let best = 0;
    let bestV = -1e9;
    let worst = 0;
    let worstV = 1e9;
    for (let i = 0; i < cards.length; i++) {
      let v = cardValue(w, cards[i], this.cfg.skill.e);
      if (pol === 'decent') v += (this.rng.next() - 0.5) * 30;
      if (v > bestV) {
        bestV = v;
        best = i;
      }
      if (v < worstV) {
        worstV = v;
        worst = i;
      }
    }
    if (open.kind === OK.LEVEL) {
      const o = w.offer;
      if (pol === 'greedy' && o.banishesLeft > 0 && worstV < 12 && bestV < 40 && cards[worst].kind === 'spell') {
        this.banishes++;
        return CH_BANISH + worst;
      }
      const bar = pol === 'greedy' ? 34 : 18;
      if (o.rerollsLeft > 0 && bestV < bar) {
        this.rerolls++;
        return CH_REROLL;
      }
    }
    if (pol === 'decent' && this.rng.next() < 0.12) return CH_PICK + this.rng.int(cards.length);
    return CH_PICK + best;
  }
}

const SPELL_IDX = new Map(SPELLS.map((s, i) => [s.id, i]));
const RELIC_LEDGER = new Map(RELICS.map((r) => [r.id, r.ledger]));
const PASSIVE_BASE: Record<string, number> = {
  might: 30, haste: 28, area: 24, crit: 20, vitality: 22, armor: 13, regen: 18, magnet: 16,
};

/** The greedy value heuristic: how much a card is worth to this build right now (roughly "% power"). */
export function cardValue(w: World, c: Card, e = 0.7): number {
  const b = w.build;
  const t = w.tick / 60;
  const sig = SPECS[w.specId].signature;
  let ownedKw = 0;
  let filled = 0;
  for (let s = 0; s < b.slotSpell.length; s++) {
    if (b.slotSpell[s] < 0) continue;
    ownedKw |= b.slotKw[s];
    filled++;
  }
  switch (c.kind) {
    case 'fusion':
      return 120;
    case 'rank': {
      const fit = c.fit ?? 1;
      const gain = BAL.rankMult[Math.min(5, Math.floor(c.rank))] / BAL.rankMult[Math.max(1, Math.floor(c.rank) - 1)] - 1;
      let v = 22 + gain * 60 * fit;
      if (c.ref === sig) v += 12;
      // reaching rank 4 unlocks fusions when a partner keyword is owned
      if (Math.floor(c.rank) >= BAL.fusionLowRank && pairKw(c, ownedKw)) v += 18;
      return v;
    }
    case 'spell': {
      const fit = c.fit ?? 1;
      const def = SPELLS[SPELL_IDX.get(c.ref) ?? 0];
      let v = 26 + 16 * fit + def.areaness * 8;
      if (pairKw(c, ownedKw)) v += 16;
      if (filled >= 5) v -= 14;
      if (t > 7) v -= 10; // late spells never reach rank
      return v;
    }
    case 'passive': {
      let v = PASSIVE_BASE[c.ref] ?? 15;
      v -= (c.rank - 1) * 2;
      if (c.ref === 'vitality' || c.ref === 'armor' || c.ref === 'regen') v += (1 - e) * 10;
      if (c.ref === 'magnet') v += t < 3 ? 6 : -6;
      return v;
    }
    case 'talent':
      return c.detail === 'area' ? 34 : c.detail === 'single' ? 28 : 24 + (1 - e) * 12;
    case 'relic': {
      const l = RELIC_LEDGER.get(c.ref) ?? 1.06;
      let v = (l - 1) * 300;
      if (c.ref === 'graveBloom' && !(ownedKw & kwBit('poison'))) v -= 20;
      if (c.ref === 'emberHeart' && !(ownedKw & kwBit('fire'))) v -= 20;
      if (c.ref === 'echoStone' && !(ownedKw & kwBit('orbit')) && !(ownedKw & kwBit('steel'))) v -= 15;
      return v;
    }
    case 'door':
      return c.ref === 'forge' ? 36 : c.ref === 'relic' ? 32 : 12 + 26 * e;
    case 'mend':
      return 60 * (1 - w.player.hp / w.player.maxHp);
    case 'limit':
      return 14;
    case 'tempered':
      return 16;
    default:
      return 10;
  }
}

function pairKw(c: Card, owned: number): boolean {
  const k = c.keywords[0];
  if (!k) return false;
  const want = k === 'fire' ? ['storm', 'poison'] : k === 'storm' ? ['fire'] : k === 'poison' ? ['fire', 'shadow'] : k === 'shadow' ? ['poison'] : [];
  for (const x of want) if (owned & kwBit(x as 'fire')) return true;
  return false;
}

// ------------------------------------------------------------------ stateless compatibility wrappers

const DEFAULT_BOTS = new WeakMap<World, Delver>();
function botFor(w: World, e: number): Delver {
  let b = DEFAULT_BOTS.get(w);
  if (!b || b.cfg.skill.e !== e) {
    b = new Delver({ skill: { e }, policy: 'greedy', seed: (w.cfg.daySeed ^ Math.imul(w.cfg.attempt + 1, 0x9e3779b1)) >>> 0 });
    DEFAULT_BOTS.set(w, b);
  }
  return b;
}

/** One input byte for this tick from the World's default bot (greedy picks). */
export function botInput(w: World, skill: BotSkill = { e: 0.85 }): InputFrame {
  return botFor(w, skill.e).input(w);
}

/** A choice for the open offer from the World's default bot. */
export function botChoose(w: World): ChoiceCode {
  return (DEFAULT_BOTS.get(w) ?? botFor(w, 0.85)).choose(w);
}
