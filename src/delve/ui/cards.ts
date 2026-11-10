/**
 * Offer picker (UI): level-up cards, talent picks, chest doors (Relic / Forge / Elite) and relic picks.
 * Shown while World.offer.open is set (the sim is paused by the sim itself); calls back with a ChoiceCode.
 *
 * Level-up: 3 (or 4) big cards with a label (NEW / RANK UP / FUSE / ...), keyword chips, rank pips, one line of
 * text and the card's numbers; Reroll and Banish buttons with counts. Keys: 1-4 pick, R reroll, B banish mode,
 * Esc leaves banish mode. Clicks are ignored for 350 ms after the cards appear so a thumb that was steering
 * cannot pick by accident.
 */
import { CH_BANISH, CH_PICK, CH_REROLL, type ChoiceCode } from '../core/types';
import type { World } from '../core/world';
import { canBanish, OK, type Card } from '../sim/offers';
import { PASSIVES } from '../content/passives';
import { SPELL_IDX } from '../content/spells';
import { FUSIONS } from '../content/fusions';
import { escapeHtml } from '../app/format';
import { glyph, kwChip, KW_COLOR } from './glyphs';
import { cardFusionHint } from './fusionhint';
import { cardNumbers } from './cardcopy';

const ARM_MS = 350;
const COLUMN: Record<string, string> = { area: 'Crowds', single: 'Big targets', survival: 'Survival' };

const LABEL: Record<string, [string, string]> = {
  spell: ['NEW', 'new'],
  rank: ['RANK UP', 'rank'],
  fusion: ['FUSE', 'fuse'],
  passive: ['PASSIVE', 'passive'],
  talent: ['TALENT', 'talent'],
  relic: ['RELIC', 'relic'],
  door: ['DOOR', 'door'],
  limit: ['LIMIT BREAK', 'limit'],
  tempered: ['TEMPERED', 'tempered'],
  mend: ['MEND', 'mend'],
};

/** Per-relic / per-talent glyphs (falls back to a star / talent badge). */
const REF_ICON: Record<string, string> = {
  lanternOil: 'lantern', splitShot: 'blade', ironLung: 'dash', graveBloom: 'poison', overcharge: 'storm', emberHeart: 'fire',
  mothWing: 'leaf', echoStone: 'orbit',
  wildfire: 'fire', kindledCore: 'fist', ashShroud: 'shield', searingWake: 'ring', focusedFlame: 'eye', warmHearth: 'heart',
  plague: 'poison', opportunist: 'eye', slipAway: 'dash', virulence: 'skull', deepCuts: 'blade', lightFeet: 'leaf',
};

function cardIcon(c: Card): string {
  if ((c.kind === 'relic' || c.kind === 'talent') && REF_ICON[c.ref]) return glyph(REF_ICON[c.ref], 'dv-ico dv-card-ico');
  if (c.kind === 'passive') {
    const p = PASSIVES.find((x) => x.id === c.ref);
    return glyph(p?.icon ?? 'relic', 'dv-ico dv-card-ico');
  }
  if (c.kind === 'fusion' || c.keywords.length >= 2) {
    return `<span class="dv-card-fuse">${glyph(c.keywords[0], 'dv-ico dv-card-ico')}<i>+</i>${glyph(c.keywords[1] ?? c.keywords[0], 'dv-ico dv-card-ico')}</span>`;
  }
  if (c.keywords.length) return glyph(c.keywords[0], 'dv-ico dv-card-ico');
  if (c.kind === 'door') return glyph(c.ref === 'forge' ? 'steel' : c.ref === 'elite' ? 'skull' : 'door', 'dv-ico dv-card-ico');
  if (c.kind === 'talent') return glyph('talent', 'dv-ico dv-card-ico');
  if (c.kind === 'mend') return glyph('heart', 'dv-ico dv-card-ico');
  if (c.kind === 'limit') return glyph('fist', 'dv-ico dv-card-ico');
  if (c.kind === 'tempered') return glyph('hourglass', 'dv-ico dv-card-ico');
  return glyph('relic', 'dv-ico dv-card-ico');
}

function maxRank(c: Card): number {
  if (c.kind === 'spell' || c.kind === 'rank') return 5;
  if (c.kind === 'passive') {
    const p = PASSIVES.find((x) => x.id === c.ref);
    if (!p || p.cap >= 100) return 0;
    return Math.min(10, Math.max(1, Math.round(p.cap / p.perRank)));
  }
  return 0;
}

function pips(c: Card): string {
  const m = maxRank(c);
  if (!m || c.rank <= 0) return '';
  let h = '<span class="dv-card-pips" aria-label="rank">';
  for (let i = 1; i <= m; i++) {
    const was = c.rank - (c.rank % 1 ? 0.5 : 1);
    const cls = c.rank >= i ? (was >= i ? 'on' : 'new') : c.rank >= i - 0.5 ? 'half' : '';
    h += `<i class="${cls}"></i>`;
  }
  return `${h}</span>`;
}

function label(c: Card): [string, string] {
  if (c.kind === 'passive' && c.rank > 1) return ['RANK UP', 'rank'];
  if (c.kind === 'passive') return ['NEW', 'new'];
  return LABEL[c.kind] ?? [c.kind.toUpperCase(), 'misc'];
}

function accent(c: Card): string {
  if (c.kind === 'fusion') return '#ffd34d';
  if (c.keywords.length) return KW_COLOR[c.keywords[0]] ?? '#fff';
  if (c.kind === 'door') return c.ref === 'elite' ? '#c070ff' : c.ref === 'forge' ? '#ff9a52' : '#ffd34d';
  if (c.kind === 'relic') return '#ffd34d';
  if (c.kind === 'talent') return '#7fe0ff';
  return '#e8dcc8';
}

/** Title of the spell the card makes (fusion cards name the parents). */
function fusionParents(c: Card): string {
  const f = FUSIONS.find((x) => x.id === c.ref || x.result === c.ref);
  return f ? `${f.desc}` : c.keywords.join(' + ');
}

export class CardPicker {
  readonly root: HTMLElement;
  private shownFor: unknown = null;
  private banishMode = false;
  private armedAt = 0;
  private cards: Card[] = [];
  private kind = -1;
  /** Hide even while an offer is open (fusion reveal on top). */
  suppressed = false;
  /** Called when cards appear for the first time in a run (first-run caption). */
  onShown: ((kind: number) => void) | null = null;
  onClick: (() => void) | null = null;

  constructor(parent: HTMLElement, private readonly onChoice: (code: ChoiceCode) => void) {
    this.root = document.createElement('div');
    this.root.className = 'dv-cards hidden';
    this.root.setAttribute('role', 'dialog');
    parent.appendChild(this.root);
    window.addEventListener('keydown', (e) => {
      if (this.root.classList.contains('hidden') || this.suppressed) return;
      if (e.repeat) return;
      const n = Number(e.key);
      if (n >= 1 && n <= this.cards.length) {
        e.preventDefault();
        this.pick(n - 1, true);
      } else if ((e.key === 'r' || e.key === 'R') && this.kind === OK.LEVEL) this.reroll();
      else if ((e.key === 'b' || e.key === 'B') && this.kind === OK.LEVEL) this.toggleBanish();
      else if (e.key === 'Escape' && this.banishMode) this.toggleBanish(false);
    });
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  private pick(i: number, fromKey = false): void {
    if (!fromKey && performance.now() < this.armedAt) return;
    const el = this.root.querySelectorAll<HTMLElement>('.dv-card')[i];
    if (this.banishMode && el?.classList.contains('no-ban')) {
      const hint = this.root.querySelector('.dv-cards-hint');
      if (hint) hint.textContent = 'Your signature spell (and fusions) cannot be banished.';
      return;
    }
    if (this.banishMode) {
      this.banishMode = false;
      el?.classList.add('banished');
      this.onClick?.();
      this.onChoice(CH_BANISH + i);
    } else {
      el?.classList.add('picked');
      this.onClick?.();
      this.onChoice(CH_PICK + i);
    }
  }

  private reroll(): void {
    this.onClick?.();
    this.onChoice(CH_REROLL);
  }

  private toggleBanish(on = !this.banishMode): void {
    this.banishMode = on;
    this.root.classList.toggle('banishing', on);
    this.root.querySelector('.dv-banish')?.classList.toggle('on', on);
    const hint = this.root.querySelector('.dv-cards-hint');
    if (hint) hint.textContent = on ? 'Tap a card to banish it for the rest of the run.' : this.hintText();
  }

  private hintText(): string {
    const touch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
    if (this.kind !== OK.LEVEL) return touch ? 'Tap one to choose' : `Click one, or press 1-${this.cards.length}`;
    return touch ? 'Tap a card' : `Click a card, or press 1-${this.cards.length} · R reroll · B banish`;
  }

  /** Show/refresh when World.offer.open changes; hide when it closes. */
  update(w: World): void {
    const open = w.offer.open;
    if (!open || this.suppressed) {
      if (this.shownFor !== null || this.visible) {
        this.root.classList.add('hidden');
        this.shownFor = null; // re-render when it opens / the suppression lifts
      }
      return;
    }
    if (this.shownFor === open.cards) return;
    const first = this.shownFor === null;
    this.shownFor = open.cards;
    this.cards = open.cards;
    this.kind = open.kind;
    this.banishMode = false;
    this.render(w, first);
    if (first) this.armedAt = performance.now() + ARM_MS;
    this.root.classList.remove('hidden');
    if (first) this.onShown?.(open.kind);
  }

  private render(w: World, animate: boolean): void {
    const o = w.offer;
    const open = o.open!;
    const isLevel = open.kind === OK.LEVEL;
    const hasFuse = open.cards.some((c) => c.kind === 'fusion');
    const title = open.kind === OK.TALENT ? 'Boss down! Pick a talent'
      : open.kind === OK.DOOR ? 'Choose a door'
        : open.kind === OK.RELIC ? 'Choose a relic'
          : hasFuse ? 'Level up! A fusion is ready' : 'Level up!';
    const sub = open.kind === OK.TALENT ? 'Talents shape how your class plays.'
      : open.kind === OK.DOOR ? 'The chest opens three ways.'
        : open.kind === OK.RELIC ? 'Relics bend the rules for the rest of the run.'
          : `Level ${w.xp.level}. Pick a card.`;
    const queued = o.queue.length;
    this.root.className = `dv-cards kind-${open.kind}${animate ? ' enter' : ' swap'}`;
    this.root.innerHTML = `
      <div class="dv-cards-head"><div class="dv-cards-title">${title}</div><div class="dv-cards-sub">${sub}${queued ? ` <span class="dv-cards-queue">+${queued} more</span>` : ''}</div></div>
      <div class="dv-cards-row n${open.cards.length}"></div>
      <div class="dv-cards-foot">
        ${isLevel ? `<button class="dv-btn ghost dv-reroll" ${o.rerollsLeft ? '' : 'disabled'}>${glyph('reroll')}<span>Reroll</span><b>${o.rerollsLeft}</b></button>
        <button class="dv-btn ghost dv-banish" ${o.banishesLeft ? '' : 'disabled'}>${glyph('banish')}<span>Banish</span><b>${o.banishesLeft}</b></button>` : ''}
        <div class="dv-cards-hint">${this.hintText()}</div>
      </div>`;
    const row = this.root.querySelector('.dv-cards-row')!;
    open.cards.forEach((c, i) => {
      const el = document.createElement('button');
      const [lab, labCls] = label(c);
      el.className = `dv-card r-${c.rarity} k-${c.kind}${c.kind === 'door' ? ` door-${c.ref}` : ''}${isLevel && !canBanish(w, c) ? ' no-ban' : ''}`;
      el.style.setProperty('--acc', accent(c));
      el.style.setProperty('--i', String(i));
      const kws = c.keywords.length ? `<div class="dv-card-kws">${c.keywords.map((k) => kwChip(k)).join('')}</div>` : '';
      const spellName = c.kind === 'fusion' ? `<div class="dv-card-parents">${escapeHtml(fusionParents(c))}</div>` : '';
      // exact numbers from the sim's own tables (v0.2); falls back to the offer's detail line
      const nums = isLevel ? cardNumbers(w, c) : '';
      const detailTxt = nums || (c.kind !== 'talent' ? c.detail ?? '' : '');
      const detail = detailTxt ? `<div class="dv-card-detail">${escapeHtml(detailTxt)}</div>` : '';
      const col = c.kind === 'talent' && c.detail ? `<div class="dv-card-col">${escapeHtml(COLUMN[c.detail] ?? c.detail)}</div>` : '';
      const fit = c.fit !== undefined && (c.kind === 'spell' || c.kind === 'rank') && c.fit >= 1.15 ? '<span class="dv-card-fit">Strong today</span>' : '';
      const meta = kws || pips(c) ? `<div class="dv-card-meta">${kws}${pips(c)}</div>` : '';
      const fh = isLevel ? cardFusionHint(w, c) : null;
      const fuseChip = fh ? `<div class="dv-card-fhint${fh.picks <= 1 ? ' near' : ''}">${glyph('relic')}<span>${escapeHtml(fh.text)}</span></div>` : '';
      if (fh && fh.picks <= 1) el.classList.add('fuse-near');
      el.innerHTML = `
        <span class="dv-card-label l-${labCls}">${lab}</span>${fit}
        <span class="dv-card-art">${cardIcon(c)}</span>
        <span class="dv-card-title">${escapeHtml(c.title)}</span>
        ${spellName}${meta}
        <span class="dv-card-desc">${escapeHtml(c.desc)}</span>
        ${detail}${col}${fuseChip}
        <span class="dv-card-key">${i + 1}</span>
        <span class="dv-card-ban">${glyph('banish')} Banish</span>`;
      el.addEventListener('click', () => this.pick(i));
      row.appendChild(el);
    });
    this.root.querySelector('.dv-reroll')?.addEventListener('click', () => this.reroll());
    this.root.querySelector('.dv-banish')?.addEventListener('click', () => this.toggleBanish());
  }
}

/** Spell index for a card that produces a spell (new / rank / fusion), or -1. */
export function cardSpellIdx(c: Card): number {
  if (c.kind === 'spell' || c.kind === 'rank') return SPELL_IDX.get(c.ref) ?? -1;
  if (c.kind === 'fusion') {
    const f = FUSIONS.find((x) => x.id === c.ref || x.result === c.ref);
    return f ? (SPELL_IDX.get(f.result) ?? -1) : -1;
  }
  return -1;
}
