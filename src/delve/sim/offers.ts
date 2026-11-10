/**
 * Level-up, talent, chest-door and relic offers (BUILD), spec 6.4 / 6.5 / 3.1.
 *
 * Level-up offers follow spec 6.4 exactly:
 *   rng      = Rng(xxhash32(daySeed, specId, pickIdx, historyHash, rerollIdx))
 *   pool     = eligible(slotsFree, owned, dayPool, t)         nothing new once slots are full
 *   w(item)  = rarityW (100 / rare 35 / epic 10)
 *            x stageGate (epic = 0 before mods.epicGateSec)
 *            x min(2.5, 1 + 0.5 x ownedKeywordMatches)
 *            x (rank-up of something owned ? 2 : 1)
 *            x pity (rare/epic: 1 + offset, offset starts -5%, +1% per pick without a rare, resets)
 *   offers   = weighted sample without replacement (mods.choices cards)
 *   enforce  >= 1 card upgrades something owned
 *   enforce  an eligible fusion is offered within 3 picks of becoming eligible (replaces the lowest-weight card)
 *   enforce  the cards never all share one keyword
 *   historyHash = fnv1a(historyHash, hashString(pickedId))
 * All weights are integers (x2 for the keyword half-steps, x100 for pity), so the draw is reproducible.
 * 2 rerolls (each increments rerollIdx) and 1 banish per run (mods). In the Core, spell rank-ups are half-ranks
 * and Tempered trade-offs join the pool. Saturated builds get Limit Break (+3% Might, to +60%) and Mend.
 *
 * A boss kill (bosses.ts queues OK.TALENT) also queues the chest: a DOOR offer (Relic / Forge / Elite) right
 * after the talent. If COMBAT queues OK.DOOR itself on the same tick, the duplicate is dropped.
 *
 * Stable fields read by UI: open (null or { kind, cards }), rerollsLeft, banishesLeft, queue.length, pityPct.
 */
import { BAL } from '../core/constants';
import { EV } from '../core/events';
import { FNV_SEED, fnv1a, hashInts, hashString } from '../core/hash';
import { Rng } from '../core/rng';
import type { World } from '../core/world';
import type { Keyword, PassiveStat, Rarity } from '../core/types';
import { CH_BANISH, CH_PICK, CH_REROLL, CH_SKIP, kwBit } from '../core/types';
import { FUSIONS } from '../content/fusions';
import { PASSIVES, TEMPERED } from '../content/passives';
import { RELICS } from '../content/relics';
import { SPECS } from '../content/specs';
import { SPELLS, spellIndex } from '../content/spells';
import { TALENTS } from '../content/talents';
import * as bosses from './bosses';
import {
  addPassive, addRelic, addSpell, addTalent, addTempered, eligibleFusions, forge, freeSpellSlots, fuse, rankMult, rankUp,
  recomputeStats, slotOf, startMend, TEMPER_MAX,
} from './build';

/** Offer kinds. */
export const OK = { LEVEL: 0, TALENT: 1, DOOR: 2, RELIC: 3 } as const;
export type OfferKind = (typeof OK)[keyof typeof OK];

export type CardKind = 'spell' | 'rank' | 'passive' | 'fusion' | 'talent' | 'relic' | 'door' | 'limit' | 'tempered' | 'mend';

export interface Card {
  kind: CardKind;
  /** Content id (spell id, passive id, fusion id, talent id, relic id, door id, tempered id). */
  ref: string;
  title: string;
  desc: string;
  keywords: readonly Keyword[];
  /** Rank after taking the card (spells/passives; x.5 for Core half-ranks), 0 otherwise. */
  rank: number;
  rarity: Rarity;
  /** For fusions: the two slots consumed. */
  slots?: [number, number];
  /** Today's fit of the spell (spec 7.2), for new spells and rank-ups. */
  fit?: number;
  /** One-line numbers for the card (e.g. "x1.5 -> x2.1 damage"). */
  detail?: string;
  /** Integer offer weight (debug / tests). */
  weight?: number;
}

export interface OpenOffer {
  kind: OfferKind;
  cards: Card[];
  /** The offer showed a rare or epic card (pity bookkeeping). */
  hadRare: boolean;
}

export interface OfferState {
  open: OpenOffer | null;
  queue: OfferKind[];
  /** Level-up picks taken so far. */
  pickIdx: number;
  historyHash: number;
  rerollIdx: number;
  rerollsLeft: number;
  banishesLeft: number;
  banished: Set<string>;
  /** Pity offset in percent: starts at -5, +1 per level pick without a rare, resets on a rare. */
  pityPct: number;
  /** pickIdx when each FUSIONS[i] first became eligible (-1 = not yet). */
  fusionFirst: Int32Array;
  /** Tick of the last DOOR offer queued (drops a same-tick duplicate). */
  doorTick: number;
  /** Relic offers drawn (salts the relic draw). */
  relicDraws: number;
}

export function createOfferState(w: World): OfferState {
  return {
    open: null, queue: [], pickIdx: 0, historyHash: FNV_SEED, rerollIdx: 0,
    rerollsLeft: w.mods.rerolls, banishesLeft: w.mods.banishes, banished: new Set(),
    pityPct: Math.round(BAL.pityStart * 100), fusionFirst: new Int32Array(FUSIONS.length).fill(-1), doorTick: -1, relicDraws: 0,
  };
}

/** Queue an offer; opens immediately if none is open (the sim then pauses). A talent also queues the chest door. */
export function queueOffer(w: World, kind: OfferKind): void {
  const o = w.offer;
  if (kind === OK.DOOR) {
    if (o.doorTick === w.tick) return;
    o.doorTick = w.tick;
  }
  o.queue.push(kind);
  if (kind === OK.TALENT && o.doorTick !== w.tick) {
    o.doorTick = w.tick;
    o.queue.push(OK.DOOR);
  }
  if (o.open === null) openNext(w);
}

function openNext(w: World): void {
  const o = w.offer;
  while (o.open === null && o.queue.length > 0) {
    const kind = o.queue.shift()!;
    const cards = kind === OK.TALENT ? talentCards(w) : kind === OK.DOOR ? doorCards(w) : kind === OK.RELIC ? relicCards(w) : levelCards(w);
    if (cards.length === 0) continue;
    o.open = { kind, cards, hadRare: cards.some((c) => c.rarity !== 'common' && c.kind !== 'fusion') };
    w.events.push(EV.OFFER_SHOWN, w.tick, kind, cards.length);
  }
}

const specSalt = (w: World): number => (w.specId === 'ember' ? 1 : 2);

/** The spec 6.4 offer RNG. */
export function offerRng(w: World): Rng {
  const o = w.offer;
  return new Rng(hashInts(w.cfg.daySeed, specSalt(w), o.pickIdx, o.historyHash, o.rerollIdx));
}

function eligibleOwner(w: World, owner: string | null): boolean {
  return owner === null || owner === w.specId || owner === SPECS[w.specId].classId;
}

interface Item {
  card: Card;
  weight: number;
  kw: number;
  upgrade: boolean;
}

const KW_ALL = (kws: readonly Keyword[]): number => {
  let m = 0;
  for (const k of kws) m |= kwBit(k);
  return m;
};


/** Build the weighted level-up pool (exported for tests and the bot). */
export function levelPool(w: World): Item[] {
  const b = w.build;
  const o = w.offer;
  const m = w.mods;
  const t = w.tick / 60;
  const inCore = w.layer >= 6;
  const pool: Item[] = [];
  const freeSpell = freeSpellSlots(w) > 0;
  const freePassive = b.passiveOrder.length < BAL.passiveSlots;
  const rarW = (r: Rarity): number => (r === 'rare' ? m.rareWeight : BAL.rarityW[r]);
  const gate = (r: Rarity): number => (r === 'epic' && t < m.epicGateSec ? 0 : 1);
  const pity = (r: Rarity): number => (r === 'common' ? 100 : 100 + o.pityPct);
  // keyword affinity in half-steps: 2 x min(2.5, 1 + 0.5k) = min(5, 2 + k)
  const kwF = (mask: number): number => {
    if (mask === 0) return 2;
    let k = 0;
    for (let s = 0; s < b.slotSpell.length; s++) if (b.slotSpell[s] >= 0 && (b.slotKw[s] & mask) !== 0) k++;
    return Math.min(5, 2 + k);
  };
  const push = (card: Card, mask: number, upgrade: boolean): void => {
    const wgt = rarW(card.rarity) * gate(card.rarity) * kwF(mask) * (upgrade ? 2 : 1) * pity(card.rarity);
    if (wgt <= 0) return;
    card.weight = wgt;
    pool.push({ card, weight: wgt, kw: mask, upgrade });
  };
  // fusions (never stage-gated: their parents already are)
  for (const f of eligibleFusions(w)) {
    const res = SPELLS[spellIndex(f.def.result)];
    const mask = KW_ALL(res.keywords);
    const card: Card = {
      kind: 'fusion', ref: f.def.id, title: f.def.name, desc: res.desc, keywords: res.keywords, rank: BAL.maxRank, rarity: 'epic',
      slots: [f.slotA, f.slotB], detail: `${SPELLS[b.slotSpell[f.slotA]].name} + ${SPELLS[b.slotSpell[f.slotB]].name}`,
    };
    const wgt = BAL.rarityW.epic * kwF(mask) * 2 * 100;
    card.weight = wgt;
    pool.push({ card, weight: wgt, kw: mask, upgrade: true });
  }
  for (let i = 0; i < SPELLS.length; i++) {
    const d = SPELLS[i];
    if (d.fusion || o.banished.has(d.id)) continue;
    const mask = KW_ALL(d.keywords);
    const slot = slotOf(w, i);
    if (slot >= 0) {
      const r = b.slotRank[slot];
      if (r >= BAL.maxRank) continue;
      const next = Math.min(BAL.maxRank, r + (inCore ? 0.5 : 1));
      push({
        kind: 'rank', ref: d.id, title: d.name, desc: d.desc, keywords: d.keywords, rank: next, rarity: d.rarity, fit: b.fit[i],
        detail: `+${Math.round((rankMult(next) / Math.max(1e-6, rankMult(r)) - 1) * 100)}% damage`,
      }, mask, true);
    } else if (freeSpell && eligibleOwner(w, d.owner)) {
      push({
        // no "fit today xN" jargon (QA): the card shows "Strong today" when the fit is high
        kind: 'spell', ref: d.id, title: d.name, desc: d.desc, keywords: d.keywords, rank: 1, rarity: d.rarity, fit: b.fit[i],
      }, mask, false);
    }
  }
  for (const pd of PASSIVES) {
    if (o.banished.has(pd.id)) continue;
    const r = b.passives[pd.id];
    if (r >= BAL.maxRank || (r === 0 && !freePassive)) continue;
    push({ kind: 'passive', ref: pd.id, title: pd.name, desc: pd.desc, keywords: [], rank: r + 1, rarity: pd.rarity }, 0, r > 0);
  }
  if (inCore && b.tempered.length < TEMPER_MAX) {
    for (const td of TEMPERED) {
      if (o.banished.has(td.id)) continue;
      push({ kind: 'tempered', ref: td.id, title: td.name, desc: td.desc, keywords: [], rank: 0, rarity: 'rare' }, 0, false);
    }
  }
  return pool;
}

function sampleOne(items: Item[], rng: Rng, filter: (it: Item) => boolean): number {
  let total = 0;
  for (const it of items) if (filter(it)) total += it.weight;
  if (total <= 0) return -1;
  let roll = rng.int(total);
  for (let k = 0; k < items.length; k++) {
    if (!filter(items[k])) continue;
    if (roll < items[k].weight) return k;
    roll -= items[k].weight;
  }
  return -1;
}

function levelCards(w: World): Card[] {
  const o = w.offer;
  const pool = levelPool(w);
  const rng = offerRng(w);
  const picks: Item[] = [];
  const n = w.mods.choices;
  while (picks.length < n && pool.length > 0) {
    const k = sampleOne(pool, rng, () => true);
    if (k < 0) break;
    picks.push(pool[k]);
    pool.splice(k, 1);
  }
  /** Index of the lowest-weight pick we may replace (never a fusion, never the only upgrade). */
  const victim = (): number => {
    const ups = picks.filter((p) => p.upgrade).length;
    let v = -1;
    for (let i = 0; i < picks.length; i++) {
      const p = picks[i];
      if (p.card.kind === 'fusion' || (p.upgrade && ups <= 1)) continue;
      if (v < 0 || p.weight < picks[v].weight) v = i;
    }
    return v;
  };
  const replaceWith = (k: number): void => {
    const v = victim();
    if (v < 0 || k < 0) return;
    const it = pool[k];
    pool.splice(k, 1);
    pool.push(picks[v]);
    picks[v] = it;
  };
  // enforce: at least one card upgrades something owned
  if (picks.length > 0 && !picks.some((p) => p.upgrade)) {
    const k = sampleOne(pool, rng, (it) => it.upgrade);
    if (k >= 0) {
      let v = 0;
      for (let i = 1; i < picks.length; i++) if (picks[i].weight < picks[v].weight) v = i;
      const it = pool[k];
      pool.splice(k, 1);
      picks[v] = it;
    }
  }
  // enforce: an eligible fusion is offered within 3 picks of eligibility
  for (let f = 0; f < FUSIONS.length; f++) {
    const k = pool.findIndex((it) => it.card.kind === 'fusion' && it.card.ref === FUSIONS[f].id);
    const inPicks = picks.some((p) => p.card.kind === 'fusion' && p.card.ref === FUSIONS[f].id);
    if (k < 0 && !inPicks) {
      o.fusionFirst[f] = -1; // eligibility lapsed: the 3-pick window restarts when it returns
      continue;
    }
    if (o.fusionFirst[f] < 0) o.fusionFirst[f] = o.pickIdx;
    if (!inPicks && o.pickIdx - o.fusionFirst[f] >= BAL.fusionGuarantee - 1 && !picks.some((p) => p.card.kind === 'fusion')) {
      replaceWith(k);
    }
  }
  // enforce: the cards never all share one keyword
  if (picks.length >= 3) {
    let common = 0xffff;
    for (const p of picks) common &= p.kw;
    if (common !== 0) {
      const k = sampleOne(pool, rng, (it) => (it.kw & common) === 0);
      replaceWith(k);
    }
  }
  const out = picks.map((p) => p.card);
  if (out.length === 0) {
    if (w.build.limitBreak * BAL.lbStep < BAL.lbCap) {
      out.push({ kind: 'limit', ref: 'limitBreak', title: 'Limit Break', desc: '+3% damage (up to +60%).', keywords: [], rank: 0, rarity: 'common' });
    }
    if (w.tick / 60 < BAL.mendCutoff && w.build.mendTicks === 0) {
      out.push({ kind: 'mend', ref: 'mend', title: 'Mend', desc: 'Heal 30% of max HP over 20 s.', keywords: [], rank: 0, rarity: 'common' });
    }
    if (out.length === 0) out.push({ kind: 'limit', ref: 'limitBreak', title: 'Limit Break', desc: 'Your power is at its peak.', keywords: [], rank: 0, rarity: 'common' });
  }
  return out;
}

function talentCards(w: World): Card[] {
  const cls = SPECS[w.specId].classId;
  const row = w.build.talents.length;
  return TALENTS.filter((t) => t.classId === cls && t.row === row).map((t) => ({
    kind: 'talent' as const, ref: t.id, title: t.name, desc: t.desc, keywords: [], rank: 0, rarity: 'rare' as const, detail: t.column,
  }));
}

type EliteStarter = (w: World) => void;
/** COMBAT may export startEliteDoor(w) from bosses.ts (spec 3.1 Elite door); until then the Elite door is hidden. */
const eliteStarter = (): EliteStarter | null => {
  const f = (bosses as unknown as Record<string, unknown>).startEliteDoor;
  return typeof f === 'function' ? (f as EliteStarter) : null;
};

function doorCards(w: World): Card[] {
  const b = w.build;
  const out: Card[] = [];
  if (RELICS.some((r) => !b.relics.includes(r.id))) {
    out.push({ kind: 'door', ref: 'relic', title: 'Relic Door', desc: 'Choose 1 of 3 relics that bend the rules.', keywords: [], rank: 0, rarity: 'rare' });
  }
  let forgeable = 0;
  for (let s = 0; s < b.slotSpell.length; s++) if (b.slotSpell[s] >= 0 && b.slotRank[s] < BAL.maxRank) forgeable++;
  if (forgeable > 0) {
    out.push({ kind: 'door', ref: 'forge', title: 'Forge Door', desc: '+1 rank to your two strongest unfinished spells.', keywords: [], rank: 0, rarity: 'common' });
  }
  if (eliteStarter()) {
    out.push({ kind: 'door', ref: 'elite', title: 'Elite Door', desc: 'Fight an elite for 20 s. Win: a relic and a Forge.', keywords: [], rank: 0, rarity: 'epic' });
  }
  return out;
}

function relicCards(w: World): Card[] {
  const b = w.build;
  const o = w.offer;
  const left = RELICS.filter((r) => !b.relics.includes(r.id));
  const rng = new Rng(hashInts(w.cfg.daySeed, specSalt(w), 0x5e11c, o.relicDraws, o.historyHash));
  o.relicDraws++;
  const rw = (r: Rarity): number => (r === 'rare' ? w.mods.rareWeight : BAL.rarityW[r]);
  const items: Item[] = left.map((r) => ({
    card: { kind: 'relic', ref: r.id, title: r.name, desc: r.desc, keywords: [], rank: 0, rarity: r.rarity } as Card,
    weight: rw(r.rarity), kw: 0, upgrade: false,
  }));
  const out: Card[] = [];
  while (out.length < 3 && items.length > 0) {
    const k = sampleOne(items, rng, () => true);
    if (k < 0) break;
    out.push(items[k].card);
    items.splice(k, 1);
  }
  return out;
}

/** Apply a ChoiceCode to the open offer (see core/types CH_*). */
/** Banish rules: never fusions / Limit Break / Mend, and never the rank-up of your own signature spell (it would quietly kill the run's main fusion route). */
export function canBanish(w: World, c: Card): boolean {
  if (c.kind === 'fusion' || c.kind === 'limit' || c.kind === 'mend') return false;
  return !(c.kind === 'rank' && c.ref === SPECS[w.specId].signature);
}

export function applyChoice(w: World, code: number): boolean {
  const o = w.offer;
  const open = o.open;
  if (!open) return false;
  if (code === CH_REROLL) {
    if (o.rerollsLeft <= 0 || open.kind !== OK.LEVEL) return false;
    o.rerollsLeft--;
    o.rerollIdx++;
    open.cards = levelCards(w);
    return true;
  }
  if (code >= CH_BANISH && code < CH_BANISH + 8) {
    const c = open.cards[code - CH_BANISH];
    if (!c || o.banishesLeft <= 0 || open.kind !== OK.LEVEL || c.kind === 'fusion' || c.kind === 'limit' || c.kind === 'mend') return false;
    if (!canBanish(w, c)) return false;
    o.banishesLeft--;
    o.banished.add(c.ref);
    o.rerollIdx++;
    open.cards = levelCards(w);
    return true;
  }
  if (code === CH_SKIP) return false;
  if (code < CH_PICK || code >= CH_PICK + 8) return false;
  const c = open.cards[code - CH_PICK];
  if (!c) return false;
  o.open = null;
  takeCard(w, c);
  if (open.kind === OK.LEVEL) {
    o.pickIdx++;
    o.rerollIdx = 0;
    o.pityPct = open.hadRare ? Math.round(BAL.pityStart * 100) : o.pityPct + Math.round(BAL.pityStep * 100);
  }
  o.historyHash = fnv1a(o.historyHash, hashString(c.ref));
  openNext(w);
  return true;
}

function takeCard(w: World, c: Card): void {
  switch (c.kind) {
    case 'spell':
      addSpell(w, spellIndex(c.ref));
      break;
    case 'rank': {
      const slot = slotOf(w, spellIndex(c.ref));
      rankUp(w, slot, c.rank - w.build.slotRank[slot]);
      break;
    }
    case 'passive':
      addPassive(w, c.ref as PassiveStat);
      break;
    case 'fusion': {
      const f = FUSIONS.find((x) => x.id === c.ref)!;
      fuse(w, f, c.slots![0], c.slots![1]);
      break;
    }
    case 'talent':
      addTalent(w, c.ref);
      break;
    case 'relic':
      addRelic(w, c.ref);
      break;
    case 'door':
      if (c.ref === 'relic') w.offer.queue.unshift(OK.RELIC);
      else if (c.ref === 'forge') forge(w);
      else if (c.ref === 'elite') eliteStarter()?.(w);
      break;
    case 'tempered':
      addTempered(w, c.ref);
      break;
    case 'limit':
      w.build.limitBreak++;
      recomputeStats(w);
      break;
    case 'mend':
      startMend(w);
      break;
    default:
      break;
  }
}
