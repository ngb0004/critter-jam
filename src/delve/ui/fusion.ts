/**
 * Fusion reveal (UI), the run's big moment (spec 6.2). On EV.FUSION the screen darkens, the two parent keywords
 * slide together, a slot reel spins through spell names and lands on the fusion's name with a flash and a ring.
 * The host holds the sim (no ticks) through the landing and only resumes when the overlay starts fading (QA: a red
 * floor could start and land entirely behind a still-opaque overlay). The sim's fusion shockwave (HIT c = 4 from
 * SRC.FUSION one tick after the fusion) then fires as the overlay clears, the "release" beat. Reduced motion: no spin, a short fade.
 */
import { SPELLS } from '../content/spells';
import { escapeHtml } from '../app/format';
import { glyph, KW_COLOR, KW_LABEL } from './glyphs';

const ROW_H = 64;

export class FusionReveal {
  readonly root: HTMLElement;
  private timers: number[] = [];
  active = false;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'dv-fusion hidden';
    this.root.setAttribute('aria-live', 'assertive');
    parent.appendChild(this.root);
  }

  /**
   * Play the reveal for fusion result `spellIdx`. `onWhoosh` fires at the start, `onLand` when the reel stops (boom),
   * `onResume` when the overlay starts fading out (resume the sim: the field must be visible before anything can hurt
   * the player), `onDone` when the overlay is gone.
   */
  show(
    spellIdx: number,
    reduced: boolean,
    cb: { onWhoosh?: (sec: number) => void; onLand?: () => void; onResume?: () => void; onDone?: () => void },
    /** Debug/screenshots only: stop the timeline before landing ('spin') or after it ('land'). */
    freeze?: 'spin' | 'land',
  ): void {
    this.clear();
    const sp = SPELLS[spellIdx];
    if (!sp) {
      cb.onLand?.();
      cb.onResume?.();
      cb.onDone?.();
      return;
    }
    this.active = true;
    const [ka, kb] = [sp.keywords[0], sp.keywords[1] ?? sp.keywords[0]];
    const ca = KW_COLOR[ka] ?? '#fff';
    const cbb = KW_COLOR[kb] ?? '#fff';
    // reel: a deterministic shuffle of other spell names, ending on the result
    const names: string[] = [];
    const pool = SPELLS.filter((s) => s.id !== sp.id).map((s) => s.name);
    for (let i = 0; i < 16; i++) names.push(pool[(i * 7 + spellIdx * 3) % pool.length]);
    names.push(sp.name);
    const spinSec = reduced ? 0 : 1.35;
    this.root.className = `dv-fusion${reduced ? ' reduced' : ''}`;
    this.root.style.setProperty('--ka', ca);
    this.root.style.setProperty('--kb', cbb);
    this.root.innerHTML = `
      <div class="dv-fu-dark"></div>
      <div class="dv-fu-rays"></div>
      <div class="dv-fu-stage">
        <div class="dv-fu-kicker">FUSION</div>
        <div class="dv-fu-parents">
          <span class="dv-fu-p a">${glyph(ka)}<b>${KW_LABEL[ka] ?? ka}</b></span>
          <span class="dv-fu-plus">+</span>
          <span class="dv-fu-p b">${glyph(kb)}<b>${KW_LABEL[kb] ?? kb}</b></span>
        </div>
        <div class="dv-fu-reel"><div class="dv-fu-strip">${names.map((n, i) => `<div class="dv-fu-name${i === names.length - 1 ? ' final' : ''}">${escapeHtml(n)}</div>`).join('')}</div></div>
        <div class="dv-fu-desc">${escapeHtml(sp.desc)}</div>
      </div>
      <div class="dv-fu-ring"></div>
      <div class="dv-fu-flash"></div>`;
    const strip = this.root.querySelector('.dv-fu-strip') as HTMLElement;
    const endY = -(names.length - 1) * ROW_H;
    if (reduced) strip.style.transform = `translateY(${endY}px)`;
    else {
      strip.style.transform = 'translateY(0px)';
      void strip.offsetWidth;
      strip.style.transition = `transform ${spinSec}s cubic-bezier(.12,.62,.2,1.02)`;
      strip.style.transform = `translateY(${endY}px)`;
    }
    this.root.classList.add('in');
    cb.onWhoosh?.(spinSec + 0.2);
    const landAt = reduced ? 350 : 250 + spinSec * 1000;
    if (freeze === 'spin') return;
    this.timers.push(window.setTimeout(() => {
      this.root.classList.add('landed');
      cb.onLand?.();
    }, landAt));
    if (freeze === 'land') return;
    this.timers.push(window.setTimeout(() => {
      this.root.classList.add('out');
      cb.onResume?.();
    }, landAt + (reduced ? 600 : 1000)));
    this.timers.push(window.setTimeout(() => {
      this.clear();
      cb.onDone?.();
    }, landAt + (reduced ? 850 : 1450)));
  }

  private clear(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.root.className = 'dv-fusion hidden';
    this.root.innerHTML = '';
    this.active = false;
  }

  /** Abort (quit to home). */
  cancel(): void {
    this.clear();
  }
}
