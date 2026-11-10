/**
 * Keyboard + floating touch joystick -> one input byte per tick (UI). The byte is the truth that is
 * recorded; quantisation to 64 directions happens in core/input.encodeInput.
 *
 * Touch (spec 4.1): the joystick appears where the thumb lands, drawn 50 px above the thumb (Flock Rescue's
 * touch lift) so the ring stays visible; dragging steers. A short tap (< 180 ms and < 12 px) dashes, and so does a
 * quick tap with a second finger while the first one steers (so a dash never costs the steering thumb).
 * A dash tap leaves a small ring where the finger was, so the player sees it registered.
 * Keyboard: WASD / arrows, Space or Shift to dash. The HUD dash button calls queueDash().
 */
import { encodeInput } from '../core/input';
import type { InputFrame } from '../core/types';

const LIFT_PX = 50;
const STICK_R = 46;
const DEAD_PX = 7;
const TAP_MS = 180;
const TAP_PX = 12;
/** Second-finger taps get a little more slack (thumbs land harder). */
const TAP2_MS = 260;
const TAP2_PX = 18;

export class InputSampler {
  private keys = new Set<string>();
  private dashQueued = false;
  private pid: number | null = null;
  private ox = 0;
  private oy = 0;
  private tx = 0;
  private ty = 0;
  private downAt = 0;
  private moved = false;
  private pid2: number | null = null;
  private p2x = 0;
  private p2y = 0;
  private p2At = 0;
  /** Latest position of the second finger (it takes over steering if the first one lifts). */
  private p2cx = 0;
  private p2cy = 0;
  /** Only sample/route when a run is live. */
  enabled = false;
  /** Last device used, logged for fairness boards (spec 4.4). */
  device: 'keyboard' | 'touch' = 'keyboard';
  /** Called once when the player first moves (first-run caption flow). */
  onFirstMove: (() => void) | null = null;
  private stick: HTMLElement;
  private knob: HTMLElement;

  constructor(private readonly surface: HTMLElement) {
    this.stick = document.createElement('div');
    this.stick.className = 'dv-stick hidden';
    this.knob = document.createElement('div');
    this.knob.className = 'dv-knob';
    this.stick.appendChild(this.knob);
    document.body.appendChild(this.stick);

    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
      // repeats re-add held movement keys (a key held through a pause/blur keeps working after resume),
      // but never re-trigger a dash
      this.keys.add(e.code);
      if (e.repeat) return;
      if (e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.dashQueued = true;
      this.device = 'keyboard';
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.release());

    surface.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (this.pid !== null) {
        // a second finger: candidate dash tap
        if (this.pid2 === null && e.pointerType !== 'mouse') {
          this.pid2 = e.pointerId;
          this.p2x = this.p2cx = e.clientX;
          this.p2y = this.p2cy = e.clientY;
          this.p2At = performance.now();
        }
        return;
      }
      this.pid = e.pointerId;
      this.ox = this.tx = e.clientX;
      this.oy = this.ty = e.clientY;
      this.downAt = performance.now();
      this.moved = false;
      this.device = e.pointerType === 'mouse' ? 'keyboard' : 'touch';
      try {
        surface.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events */
      }
      this.stick.style.left = `${this.ox}px`;
      this.stick.style.top = `${this.oy - (e.pointerType === 'mouse' ? 0 : LIFT_PX)}px`;
      this.knob.style.transform = '';
      this.stick.classList.remove('hidden');
      e.preventDefault();
    });
    surface.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.pid2) {
        this.p2cx = e.clientX;
        this.p2cy = e.clientY;
        return;
      }
      if (e.pointerId !== this.pid) return;
      this.tx = e.clientX;
      this.ty = e.clientY;
      const dx = this.tx - this.ox;
      const dy = this.ty - this.oy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > TAP_PX) this.moved = true;
      // floating base: drag past the rim pulls the base along (no dead stick after a long swipe)
      if (d > STICK_R * 1.6) {
        const k = (d - STICK_R * 1.6) / d;
        this.ox += dx * k;
        this.oy += dy * k;
        this.stick.style.left = `${this.ox}px`;
        this.stick.style.top = `${this.oy - (this.device === 'touch' ? LIFT_PX : 0)}px`;
      }
      const ddx = this.tx - this.ox;
      const ddy = this.ty - this.oy;
      const dd = Math.sqrt(ddx * ddx + ddy * ddy);
      const k = dd > STICK_R ? STICK_R / dd : 1;
      this.knob.style.transform = `translate(${ddx * k}px, ${ddy * k}px)`;
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId === this.pid2) {
        this.pid2 = null;
        const dx = e.clientX - this.p2x;
        const dy = e.clientY - this.p2y;
        if (e.type === 'pointerup' && performance.now() - this.p2At < TAP2_MS && dx * dx + dy * dy < TAP2_PX * TAP2_PX) this.tapDash(e.clientX, e.clientY);
        return;
      }
      if (e.pointerId !== this.pid) return;
      if (e.type === 'pointerup' && !this.moved && performance.now() - this.downAt < TAP_MS) this.tapDash(e.clientX, e.clientY);
      this.pid = null;
      this.knob.style.transform = '';
      if (this.pid2 !== null) {
        // hand-off: the second finger takes over steering, re-anchored where it is now
        this.pid = this.pid2;
        this.pid2 = null;
        this.ox = this.tx = this.p2cx;
        this.oy = this.ty = this.p2cy;
        this.downAt = performance.now();
        this.moved = true; // a hand-off is never a dash tap
        try {
          surface.setPointerCapture(this.pid);
        } catch {
          /* synthetic events */
        }
        this.stick.style.left = `${this.ox}px`;
        this.stick.style.top = `${this.oy - (this.device === 'touch' ? LIFT_PX : 0)}px`;
        return;
      }
      this.stick.classList.add('hidden');
    };
    surface.addEventListener('pointerup', end);
    surface.addEventListener('pointercancel', end);
  }

  private tapDash(x: number, y: number): void {
    if (!this.enabled) return;
    this.dashQueued = true;
    const fx = document.createElement('div');
    fx.className = 'dv-tapfx';
    fx.style.left = `${x}px`;
    fx.style.top = `${y}px`;
    document.body.appendChild(fx);
    window.setTimeout(() => fx.remove(), 450);
  }

  /** Drop a queued dash (a dash key pressed while the card picker was open must not fire after the pick). */
  clearDash(): void {
    this.dashQueued = false;
  }

  /** Dash on the next tick (HUD dash button). */
  queueDash(): void {
    if (this.enabled) this.dashQueued = true;
  }

  /** Sample once per sim tick. Screen up = sim +y. */
  sample(): InputFrame {
    let dx = 0;
    let dy = 0;
    const k = this.keys;
    if (k.has('KeyA') || k.has('ArrowLeft')) dx -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) dx += 1;
    if (k.has('KeyW') || k.has('ArrowUp')) dy += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) dy -= 1;
    if (this.pid !== null) {
      const tx = this.tx - this.ox;
      const ty = this.ty - this.oy;
      if (tx * tx + ty * ty > DEAD_PX * DEAD_PX) {
        dx = tx;
        dy = -ty;
      }
    }
    const dash = this.dashQueued;
    this.dashQueued = false;
    if ((dx !== 0 || dy !== 0) && this.onFirstMove) {
      const f = this.onFirstMove;
      this.onFirstMove = null;
      f();
    }
    return encodeInput(dx, dy, dash);
  }

  /** True while a finger/mouse is steering or a key is held. */
  get active(): boolean {
    return this.pid !== null || this.keys.size > 0;
  }

  /** Drop held keys and the stick (pause, blur, screen change). */
  release(): void {
    this.keys.clear();
    this.dashQueued = false;
    if (this.pid !== null) {
      try {
        this.surface.releasePointerCapture(this.pid);
      } catch {
        /* not captured */
      }
    }
    this.pid = null;
    this.pid2 = null;
    this.stick.classList.add('hidden');
  }

  reset(): void {
    this.release();
  }
}
