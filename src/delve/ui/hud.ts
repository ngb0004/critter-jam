/**
 * In-run HUD (UI). DOM over the canvas; reads the World and events only. Every element is written only when its
 * value changes (no per-frame layout thrash).
 *
 *   top:     XP bar + level pill, HP bar with numbers, spell slots (keyword glyph + rank pips), run timer,
 *            layer chip, pause button
 *   centre:  layer / boss / Core / Wyrmfall banners, first-run captions, toasts
 *   boss:    name, HP bar, enrage tag; elite countdown; Wyrm stagger meter
 *   edges:   off-screen boss arrow, low-HP vignette
 *   bottom:  dash button with cooldown ring + charges, reroll / banish counts
 */
import { BAL, DT, WORLD, secToTicks } from '../core/constants';
import { EV, type EventQueue } from '../core/events';
import { EF, TG_COLOR, TG_SHAPE } from '../core/types';
import type { World } from '../core/world';
import { BOSSES } from '../content/bosses';
import { layerDef } from '../content/layers';
import { SPELLS } from '../content/spells';
import { fmtTime } from '../app/format';
import { glyph, KW_COLOR } from './glyphs';
import { fusionPairs } from './fusionhint';

export { fmtTime };

export interface ScreenPoint {
  x: number;
  y: number;
  /** true when the point is inside the viewport (with a margin). */
  onScreen: boolean;
}
export type Projector = (simX: number, simY: number, out: ScreenPoint) => void;

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];

export class Hud {
  readonly root: HTMLElement;
  private q = <T extends HTMLElement = HTMLElement>(s: string) => this.root.querySelector(s) as T;
  private el: Record<string, HTMLElement> = {};
  private cache: Record<string, string | number> = {};
  private captionUntil = 0;
  private toastUntil = 0;
  private bannerUntil = 0;
  private pt: ScreenPoint = { x: 0, y: 0, onScreen: true };
  private bossShownUid = -1;
  onPause: (() => void) | null = null;
  onDash: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'dv-hud';
    this.root.innerHTML = `
      <div class="dv-vignette"></div>
      <div class="dv-hud-top">
        <div class="dv-xpbar"><div class="dv-xpfill"></div><span class="dv-lv">Lv 1</span></div>
        <div class="dv-toprow">
          <div class="dv-left">
            <div class="dv-hp" role="meter" aria-label="Health">${glyph('heart', 'dv-ico dv-hp-ico')}<div class="dv-hp-bar"><div class="dv-hp-lag"></div><div class="dv-hp-fill"></div></div><span class="dv-hp-num">100</span></div>
          </div>
          <div class="dv-mid">
            <div class="dv-clock">0:00</div>
            <div class="dv-where"><span class="dv-where-dot"></span><span class="dv-where-txt"></span></div>
          </div>
          <div class="dv-right"><button class="dv-iconbtn dv-pausebtn" aria-label="Pause">${glyph('pause')}</button></div>
        </div>
        <div class="dv-bossbar hidden"><div class="dv-boss-name"><span class="dv-boss-txt"></span><span class="dv-boss-tag"></span></div><div class="dv-boss-track"><div class="dv-boss-lag"></div><div class="dv-boss-fill"></div></div></div>
      </div>
      <div class="dv-banner"><div class="dv-banner-kicker"></div><div class="dv-banner-title"></div><div class="dv-banner-sub"></div></div>
      <div class="dv-caption"></div>
      <div class="dv-toast"></div>
      <div class="dv-arrow hidden">${glyph('arrow')}<span>BOSS</span></div>
      <div class="dv-hud-bottom">
        <div class="dv-bl"><div class="dv-slots"></div><div class="dv-counts"><span class="dv-count dv-count-rr" title="Rerolls">${glyph('reroll')}<b>2</b></span><span class="dv-count dv-count-ban" title="Banishes">${glyph('banish')}<b>1</b></span></div></div>
        <button class="dv-dashbtn" aria-label="Dash"><svg viewBox="0 0 64 64" class="dv-dashring"><circle cx="32" cy="32" r="28" class="dv-ring-bg"/><circle cx="32" cy="32" r="28" class="dv-ring-fg"/></svg>${glyph('dash', 'dv-ico dv-dash-ico')}<span class="dv-dash-n"></span></button>
      </div>`;
    parent.appendChild(this.root);
    for (const k of ['xpfill', 'lv', 'hp-fill', 'hp-lag', 'hp-num', 'hp', 'slots', 'clock', 'where-txt', 'where-dot', 'bossbar', 'boss-txt', 'boss-tag', 'boss-fill', 'boss-lag',
      'banner', 'banner-kicker', 'banner-title', 'banner-sub', 'caption', 'toast', 'arrow', 'vignette', 'dashbtn', 'dash-n', 'count-rr', 'count-ban']) {
      this.el[k] = this.q(`.dv-${k}`);
    }
    this.el.ringfg = this.root.querySelector('.dv-ring-fg') as unknown as HTMLElement;
    this.q('.dv-pausebtn').addEventListener('click', () => this.onPause?.());
    const dashBtn = this.el.dashbtn;
    dashBtn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.onDash?.();
    });
  }

  private set(key: string, v: string | number, apply: (v: string | number) => void): void {
    if (this.cache[key] === v) return;
    this.cache[key] = v;
    apply(v);
  }

  /** Forget cached values (new run). */
  reset(): void {
    this.cache = {};
    this.captionUntil = this.toastUntil = this.bannerUntil = 0;
    this.el.caption.classList.remove('show');
    this.el.toast.classList.remove('show');
    this.el.banner.classList.remove('show');
    this.bossShownUid = -1;
  }

  /** First-run caption (big, centre). */
  say(text: string, ms = 3000, low = false): void {
    this.el.caption.textContent = text;
    this.el.caption.classList.toggle('low', low);
    this.el.caption.classList.add('show');
    this.captionUntil = performance.now() + ms;
  }

  toast(html: string, ms = 1800, kind = ''): void {
    const t = this.el.toast;
    t.innerHTML = html;
    t.className = `dv-toast show ${kind}`;
    this.toastUntil = performance.now() + ms;
  }

  banner(kicker: string, title: string, sub: string, color: string, ms = 2600, top = false): void {
    const b = this.el.banner;
    b.classList.toggle('top', top);
    b.style.setProperty('--bd', `${ms}ms`);
    this.el['banner-kicker'].textContent = kicker;
    this.el['banner-title'].textContent = title;
    this.el['banner-sub'].textContent = sub;
    b.style.setProperty('--bc', color);
    b.classList.remove('show');
    void b.offsetWidth; // restart the animation
    b.classList.add('show');
    this.bannerUntil = performance.now() + ms;
  }

  /** Banners and toasts from sim events (read-only). */
  onEvents(ev: EventQueue, w: World): void {
    for (let i = 0; i < ev.n; i++) {
      switch (ev.kind[i]) {
        case EV.LAYER_CHANGE: {
          const L = layerDef(ev.a[i]);
          this.banner(`Layer ${ROMAN[ev.a[i]] ?? ev.a[i]}`, L.name, 'A boss wakes at :40', hex(L.palette.accent));
          break;
        }
        case EV.CORE_ENTER:
          this.banner('5:00', 'The Core', 'No more layers. It only gets worse. Hold on.', '#ffd166', 3200);
          break;
        case EV.BOSS_SPAWN: {
          const b = BOSSES[ev.b[i]];
          // upper third and short (QA: a centred 2.8 s banner covered the boss and its landing ring)
          if (b) this.banner('Boss', b.name, b.intro, hex(b.color), 1400, true);
          break;
        }
        case EV.BOSS_KILL: {
          const b = BOSSES[ev.b[i]];
          this.toast(`${glyph('crown')} <b>${b ? b.name : 'Boss'} down!</b> in ${Math.round(ev.v[i])} s`, 2200, 'gold');
          break;
        }
        case EV.WYRMFALL:
          if (ev.a[i] === 0) this.banner('11:52', 'The Wyrmfall', 'Something enormous is coming. Find the gold ring.', '#ffd34d', 3200);
          else this.banner('12:00', 'The Wyrm', 'Hit it inside the gold ring to stagger its breath.', '#ff5a3d', 3200);
          break;
        case EV.STAGGER:
          this.toast(`${glyph('wyrm')} Stagger +${ev.v[i].toFixed(0)} s`, 900, 'gold');
          break;
        case EV.FORMATION:
          // v0.2: name what is really violet on screen. The renderer marks a formation with a 1 s violet outline
          // (TG_COLOR.VIOLET, 0xb070ff) and then tints its critters violet (actors.ts EF.FORMATION); the floor itself
          // stays its normal colour, and red on the floor is only ever a burst. So the caption talks about critters.
          this.toast(ev.a[i] === 1
            ? '<span><b>Formation!</b> A wall of violet critters sweeps in. Find the gap.</span>'
            : '<span><b>Formation!</b> A ring of violet critters closes in. Slip through the gap.</span>', 2400, 'violet');
          break;
        case EV.CHEST:
          if (ev.a[i] === 0) this.toast(`${glyph('chest')} <b>A chest!</b> Grab the gold.`, 2000, 'gold');
          else if (ev.a[i] === 1) this.toast('<b>Elite!</b> Beat it in 20 s.', 2000, 'red');
          else if (ev.a[i] === 2) this.toast(`${glyph('relic')} <b>Elite cleared!</b>`, 2000, 'gold');
          else if (ev.a[i] === 3) this.toast('The elite got away.', 1600);
          break;
        case EV.BURST_HIT:
          if (ev.b[i] === 1) this.toast(`${glyph('dash')} Dodged!`, 700, 'gold');
          break;
      }
    }
    void w;
  }

  update(w: World, project: Projector | null, vw: number, vh: number): void {
    const now = performance.now();
    const p = w.player;
    // XP + level
    const xpPct = Math.max(0, Math.min(100, (100 * w.xp.xp) / Math.max(1, w.xp.xpNext)));
    this.set('xp', Math.round(xpPct * 4) / 4, (v) => (this.el.xpfill.style.transform = `scaleX(${Number(v) / 100})`));
    this.set('lv', w.xp.level, (v) => (this.el.lv.textContent = `Lv ${v}`));
    // gems that would level you up are lying within 6 m: pulse the bar (QA: cautious players starved for cards)
    let near = 0;
    const gm = w.gm;
    for (let i = 0; i < gm.hi; i++) {
      if (!gm.alive[i] || gm.tier[i] > 3) continue;
      const dx = gm.x[i] - p.x, dy = gm.y[i] - p.y;
      if (dx * dx + dy * dy < 36) near += gm.value[i];
    }
    this.set('xpnear', w.xp.xp + near >= w.xp.xpNext && near > 0 ? 1 : 0, (v) => this.el.xpfill.parentElement!.classList.toggle('grab', v === 1));
    // HP
    const hpFrac = Math.max(0, Math.min(1, p.hp / Math.max(1, p.maxHp)));
    this.set('hp', Math.round(hpFrac * 400) / 400, (v) => {
      this.el['hp-fill'].style.transform = `scaleX(${v})`;
      this.el['hp-lag'].style.transform = `scaleX(${v})`;
      this.el.hp.classList.toggle('low', Number(v) < 0.3);
    });
    // narrow phones: just the current HP (QA: "115/115" crowded the timer)
    this.set('hpn', vw < 440 ? String(Math.ceil(p.hp)) : `${Math.ceil(p.hp)}/${Math.round(p.maxHp)}`, (v) => (this.el['hp-num'].textContent = String(v)));
    this.set('hurt', p.hurtFlash > 0 ? 1 : 0, (v) => this.el.hp.classList.toggle('hurt', v === 1));
    this.set('vig', hpFrac < 0.3 && !w.over ? (hpFrac < 0.15 ? 2 : 1) : 0, (v) => {
      this.el.vignette.classList.toggle('on', v !== 0);
      this.el.vignette.classList.toggle('crit', v === 2);
    });
    // spell slots
    let sig = 0;
    const b = w.build;
    for (let s = 0; s < b.slotSpell.length; s++) sig = (sig * 41 + (b.slotSpell[s] + 2) * 13 + Math.round(b.slotRank[s] * 2)) % 1000000007;
    this.set('slots', sig, () => this.renderSlots(w));
    // clock + layer
    const sec = w.tick * DT;
    this.set('clock', Math.floor(sec), (v) => (this.el.clock.textContent = fmtTime(Number(v))));
    const L = layerDef(w.layer);
    this.set('where', w.layer, (v) => {
      const n = Number(v);
      this.el['where-txt'].textContent = n <= 5 ? `Layer ${n} · ${L.name}` : 'The Core';
      this.el['where-dot'].style.background = hex(L.palette.accent);
    });
    // boss / elite / wyrm bar
    this.updateBossBar(w, project, vw, vh);
    // dash
    const maxCh = Math.max(1, w.stats.dashCharges);
    const full = secToTicks(WORLD.dashCooldown);
    const ready = p.dashCharges > 0;
    const frac = ready ? 1 : 1 - Math.max(0, Math.min(1, p.dashCd / full));
    this.set('dash', Math.round(frac * 60), (v) => {
      (this.el.ringfg as unknown as SVGCircleElement).style.strokeDashoffset = String(176 * (1 - Number(v) / 60));
    });
    this.set('dashready', ready ? 1 : 0, (v) => this.el.dashbtn.classList.toggle('ready', v === 1));
    this.set('dashn', maxCh > 1 ? `${p.dashCharges}` : '', (v) => (this.el['dash-n'].textContent = String(v)));
    // rerolls / banish
    this.set('rr', w.offer.rerollsLeft, (v) => {
      this.el['count-rr'].querySelector('b')!.textContent = String(v);
      this.el['count-rr'].classList.toggle('none', v === 0);
    });
    this.set('ban', w.offer.banishesLeft, (v) => {
      this.el['count-ban'].querySelector('b')!.textContent = String(v);
      this.el['count-ban'].classList.toggle('none', v === 0);
    });
    // timers
    if (this.captionUntil && now > this.captionUntil) {
      this.el.caption.classList.remove('show');
      this.captionUntil = 0;
    }
    if (this.toastUntil && now > this.toastUntil) {
      this.el.toast.classList.remove('show');
      this.toastUntil = 0;
    }
    if (this.bannerUntil && now > this.bannerUntil) {
      this.el.banner.classList.remove('show');
      this.bannerUntil = 0;
    }
    // a live red telegraph on or right next to the delver: the banner steps back so it never hides the warning
    this.set('bfaint', this.bannerUntil && dangerNear(w, 1.5) ? 1 : 0, (v) => this.el.banner.classList.toggle('faint', v === 1));
  }

  private renderSlots(w: World): void {
    const b = w.build;
    let html = '';
    for (let s = 0; s < b.slotSpell.length; s++) {
      const si = b.slotSpell[s];
      if (si < 0) {
        html += '<span class="dv-slot empty"></span>';
        continue;
      }
      const sp = SPELLS[si];
      const k0 = sp.keywords[0];
      const k1 = sp.keywords[1];
      const r = b.slotRank[s];
      let pips = '';
      if (!sp.fusion) for (let i = 1; i <= 5; i++) pips += `<i class="${r >= i ? 'on' : r >= i - 0.5 ? 'half' : ''}"></i>`;
      html += `<span class="dv-slot ${sp.fusion ? 'fused' : ''}" title="${sp.name}" style="--kw:${KW_COLOR[k0]};--kw2:${KW_COLOR[k1 ?? k0]}">${glyph(k0)}${k1 ? glyph(k1, 'dv-ico dv-ico2') : ''}<span class="dv-pips">${pips}</span></span>`;
    }
    // fusion meters: once two owned spells can fuse, show how close they are (R5 + R4)
    const pairs = fusionPairs(w);
    if (pairs.length) {
      html += '<span class="dv-fmeters">';
      for (const p of pairs.slice(0, 2)) {
        html += `<span class="dv-fmeter${p.progress >= 1 ? ' ready' : ''}" title="${p.name}: one spell at rank 5, the other at rank 4" style="--kw:${KW_COLOR[p.a]};--kw2:${KW_COLOR[p.b]}">${glyph(p.a)}${glyph(p.b)}<b>${p.name}</b><i><u style="width:${Math.round(p.progress * 100)}%"></u></i></span>`;
      }
      html += '</span>';
    }
    this.el.slots.innerHTML = html;
  }

  private updateBossBar(w: World, project: Projector | null, vw: number, vh: number): void {
    const h = w.hazard;
    let slot = -1;
    let name = '';
    let tag = '';
    let color = '#ff4d3d';
    if (h.wyrmActive && h.headSlot >= 0 && w.en.alive[h.headSlot]) {
      slot = h.headSlot;
      name = 'The Wyrm';
      tag = `stagger ${Math.round(h.stagger)} / ${BAL.staggerCap} s`;
      color = '#ffd34d';
    } else if (w.boss.active >= 0 && w.en.alive[w.boss.active] && (w.en.flags[w.boss.active] & EF.BOSS)) {
      slot = w.boss.active;
      const d = BOSSES[w.boss.defIdx];
      name = d ? d.name : 'Boss';
      color = d ? hex(d.color) : color;
      const enr = w.boss.defIdx >= 0 ? w.boss.enrage[w.boss.defIdx] : 1;
      tag = enr > 1.05 ? 'ENRAGED' : w.boss.liveCount > 1 ? `+${w.boss.liveCount - 1} more` : '';
    } else if (w.boss.eliteSlot >= 0 && w.en.alive[w.boss.eliteSlot]) {
      slot = w.boss.eliteSlot;
      name = 'Elite';
      tag = `${Math.max(0, Math.ceil((w.boss.eliteEndTick - w.tick) * DT))} s`;
      color = '#c070ff';
    }
    const bar = this.el.bossbar;
    if (slot < 0) {
      this.set('boss', '', () => bar.classList.add('hidden'));
      this.el.arrow.classList.add('hidden');
      return;
    }
    this.set('boss', name, (v) => {
      bar.classList.remove('hidden');
      this.el['boss-txt'].textContent = String(v);
      bar.style.setProperty('--bc', color);
    });
    this.set('bosstag', tag, (v) => {
      this.el['boss-tag'].textContent = String(v);
      this.el['boss-tag'].classList.toggle('hot', v === 'ENRAGED');
    });
    const frac = Math.max(0, Math.min(1, w.en.hp[slot] / Math.max(1, w.en.maxHp[slot])));
    this.set('bosshp', Math.round(frac * 500) / 500, (v) => {
      this.el['boss-fill'].style.transform = `scaleX(${v})`;
      this.el['boss-lag'].style.transform = `scaleX(${v})`;
    });
    if (this.bossShownUid !== w.en.uid[slot]) this.bossShownUid = w.en.uid[slot];
    // off-screen arrow
    if (!project) return;
    project(w.en.x[slot], w.en.y[slot], this.pt);
    const a = this.el.arrow;
    if (this.pt.onScreen) {
      a.classList.add('hidden');
      return;
    }
    const cx = vw / 2;
    const cy = vh / 2;
    let dx = this.pt.x - cx;
    let dy = this.pt.y - cy;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= d;
    dy /= d;
    const m = 44;
    // keep the arrow (and its label below it) clear of the top HUD: timer, layer line and the boss bar's name
    // (QA v0.1: the WYRM label sat on the boss name at top centre)
    const bb = bar.getBoundingClientRect();
    const sr = this.root.getBoundingClientRect();
    const top = Math.max(m + 40, bb.bottom - sr.top + 26);
    const bottom = vh - m - 40;
    const tx = dx !== 0 ? (cx - m) / Math.abs(dx) : 1e9;
    const ty = dy < 0 ? (cy - top) / -dy : dy > 0 ? (bottom - cy) / dy : 1e9;
    const t = Math.max(0, Math.min(tx, ty));
    let ax = cx + dx * t;
    let ay = cy + dy * t;
    // v0.2 review: keep the arrow and its label out of the dash button (where the right thumb rests) and the spell
    // slots: slide to the nearest free side of the box, staying on screen
    for (const box of [this.el.dashbtn, this.el.slots]) {
      const rb = box.getBoundingClientRect();
      if (rb.width <= 0) continue;
      const pad = 22;
      // the arrow glyph spans ay-17..ay+17, its label ay+20..ay+34
      const l = rb.left - sr.left - 17 - pad, r = rb.right - sr.left + 17 + pad;
      const tp = rb.top - sr.top - 34 - pad, bt = rb.bottom - sr.top + 17 + pad;
      if (ax <= l || ax >= r || ay <= tp || ay >= bt) continue;
      const opts: [number, number][] = [[ax, tp], [ax, bt], [l, ay], [r, ay]];
      let bx = ax, by = ay, bd = 1e9;
      for (const [ox, oy] of opts) {
        if (ox < m - 20 || ox > vw - m + 20 || oy < top - 20 || oy > vh - 20) continue;
        const dd = Math.abs(ox - ax) + Math.abs(oy - ay);
        if (dd < bd) { bd = dd; bx = ox; by = oy; }
      }
      ax = bx;
      ay = by;
    }
    const deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    a.classList.remove('hidden');
    a.style.transform = `translate(${ax.toFixed(1)}px, ${ay.toFixed(1)}px)`;
    // the `rotate` property composes with the pulse animation's transform
    (a.firstElementChild as HTMLElement).style.setProperty('rotate', `${deg.toFixed(0)}deg`);
    a.style.setProperty('--bc', color);
    (a.lastElementChild as HTMLElement).textContent = name === 'The Wyrm' ? 'WYRM' : name === 'Elite' ? 'ELITE' : 'BOSS';
  }
}

/** Is an unresolved red (hostile) telegraph within `m` metres of the delver? (read-only) */
function dangerNear(w: World, m: number): boolean {
  const tg = w.tg;
  const px = w.player.x, py = w.player.y;
  for (let i = 0; i < tg.hi; i++) {
    if (!tg.alive[i] || tg.resolved[i] || tg.color[i] !== TG_COLOR.RED) continue;
    let d: number;
    if (tg.shape[i] === TG_SHAPE.LANE) {
      const ex = tg.x2[i] - tg.x[i], ey = tg.y2[i] - tg.y[i];
      const L2 = ex * ex + ey * ey || 1e-6;
      const u = Math.max(0, Math.min(1, ((px - tg.x[i]) * ex + (py - tg.y[i]) * ey) / L2));
      const qx = tg.x[i] + ex * u - px, qy = tg.y[i] + ey * u - py;
      d = Math.sqrt(qx * qx + qy * qy) - tg.r[i];
    } else {
      const qx = tg.x[i] - px, qy = tg.y[i] - py;
      d = Math.sqrt(qx * qx + qy * qy) - tg.r[i];
    }
    if (d < m) return true;
  }
  return false;
}

export const hex = (c: number): string => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;
