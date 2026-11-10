/**
 * First Dive onboarding (UI). Five illustrated panels a non-gamer can read in well under a minute, shown before
 * the very first run (and on demand from the home screen's How to play). One idea per panel, one short line each:
 *
 *   1 Drag to move   2 Spells fire on their own, keep moving   3 Red floor = move (dash)   4 Gold = grab, pick cards (fusion tag)
 *   5 The goal: survive; retries are free, the best try counts (v0.2: five panels, written for non-gamers)
 *
 * Tap Next (or anywhere on the art, or swipe left), Skip at any time. Keys: Enter / Space / Right = next, Esc = skip.
 */
import { glyph } from './glyphs';
import { obAutoArt, obCardsArt, obGoalArt, obMoveArt, obRedArt } from './art';

interface Step {
  art: () => string;
  title: string;
  line: string;
  tag?: string;
}

function steps(touch: boolean): Step[] {
  return [
    { art: obMoveArt, title: 'Drag to move', line: touch ? 'Put one thumb anywhere and drag. That is all the steering there is.' : 'Hold the mouse and drag, or use WASD / the arrow keys.', tag: '1 thumb' },
    { art: obAutoArt, title: 'You attack on your own', line: 'Your spells aim and fire by themselves. Your only job: keep moving, away from the crowd.', tag: 'auto' },
    { art: obRedArt, title: 'Red floor = move', line: touch ? 'Red circles aim where you stand. Walk out before they fill. Trapped? Tap to dash: it dodges most red floor.' : 'Red circles aim where you stand. Walk out before they fill. Trapped? Press Space to dash: it dodges most red floor.', tag: 'red' },
    { art: obCardsArt, title: 'Grab gold, pick cards', line: 'Walk over gold gems to level up, then pick a card. A gold "Fuses with" tag means two spells can merge into a big one.', tag: 'gold' },
    { art: obGoalArt, title: 'Survive as long as you can', line: 'Same cave for everyone today. Retries are free and only your best try counts. Dying early is normal: every try teaches you something.', tag: 'goal' },
  ];
}

export function showOnboarding(parent: HTMLElement, onDone: (skipped: boolean) => void, onClick?: () => void, finalLabel = 'Dive!'): HTMLElement {
  const touch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  const S = steps(touch);
  const el = document.createElement('div');
  el.className = 'dv-screen dv-ob';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'How to play');
  el.innerHTML = `
    <div class="dv-ob-inner">
      <div class="dv-ob-top"><span class="dv-ob-k">${glyph('lantern')}First dive</span><button class="dv-ob-skip">Skip</button></div>
      <div class="dv-ob-track">${S.map((s, i) => `
        <section class="dv-ob-step${i === 0 ? ' on' : ''}" aria-hidden="${i !== 0}">
          <div class="dv-ob-stage">${s.art()}</div>
          <h2>${s.title}</h2>
          <p>${s.line}</p>
        </section>`).join('')}
      </div>
      <div class="dv-ob-dots">${S.map((_, i) => `<i class="${i === 0 ? 'on' : ''}"></i>`).join('')}</div>
      <button class="dv-btn dv-ob-next"><span>Next</span>${glyph('play')}</button>
    </div>`;
  let i = 0;
  const secs = el.querySelectorAll<HTMLElement>('.dv-ob-step');
  const dots = el.querySelectorAll<HTMLElement>('.dv-ob-dots i');
  const next = el.querySelector('.dv-ob-next') as HTMLButtonElement;
  const label = next.querySelector('span')!;
  const go = (n: number) => {
    i = Math.max(0, Math.min(S.length - 1, n));
    secs.forEach((s, k) => {
      s.classList.toggle('on', k === i);
      s.classList.toggle('past', k < i);
      s.setAttribute('aria-hidden', String(k !== i));
    });
    dots.forEach((d, k) => d.classList.toggle('on', k <= i));
    label.textContent = i === S.length - 1 ? finalLabel : 'Next';
    next.classList.toggle('final', i === S.length - 1);
  };
  let done = false;
  const finish = (skipped: boolean) => {
    if (done) return;
    done = true;
    window.removeEventListener('keydown', onKey, true);
    el.classList.add('out');
    window.setTimeout(() => el.remove(), 220);
    onDone(skipped);
  };
  const advance = () => {
    onClick?.();
    if (i >= S.length - 1) finish(false);
    else go(i + 1);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.code === 'Escape') finish(true);
    else if (e.code === 'Enter' || e.code === 'Space' || e.code === 'ArrowRight') advance();
    else if (e.code === 'ArrowLeft') go(i - 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('keydown', onKey, true);
  next.addEventListener('click', advance);
  el.querySelector('.dv-ob-skip')!.addEventListener('click', () => {
    onClick?.();
    finish(true);
  });
  el.querySelectorAll('.dv-ob-stage').forEach((s) => s.addEventListener('click', advance));
  // swipe between panels
  let sx = 0;
  let sy = 0;
  el.addEventListener('pointerdown', (e) => {
    sx = e.clientX;
    sy = e.clientY;
  });
  el.addEventListener('pointerup', (e) => {
    const dx = e.clientX - sx;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(e.clientY - sy) * 1.5) {
      if (dx < 0) advance();
      else go(i - 1);
    }
  });
  parent.appendChild(el);
  next.focus({ preventScroll: true });
  return el;
}
