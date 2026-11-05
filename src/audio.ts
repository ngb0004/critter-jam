/** Tiny synthesised sound effects; no assets to load. */
class Sfx {
  enabled = true;
  private ctx: AudioContext | null = null;

  unlock(): void {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        this.ctx = null;
      }
    }
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
  }

  private tone(freq: number, dur: number, type: OscillatorType = 'sine', gain = 0.18, slide = 0, delay = 0): void {
    if (!this.enabled || !this.ctx) return;
    const c = this.ctx;
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  tap(): void {
    this.tone(520, 0.07, 'triangle', 0.12, 180);
  }
  board(seat: number): void {
    this.tone(620 + seat * 120, 0.12, 'sine', 0.2, 200);
  }
  bench(): void {
    this.tone(300, 0.14, 'triangle', 0.14, -80);
  }
  depart(): void {
    this.tone(220, 0.25, 'sawtooth', 0.08, 160);
    this.tone(440, 0.18, 'sine', 0.1, 220, 0.08);
  }
  bad(): void {
    this.tone(160, 0.12, 'square', 0.06, -40);
  }
  win(): void {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.22, 'sine', 0.18, 0, i * 0.09));
  }
  lose(): void {
    this.tone(330, 0.3, 'triangle', 0.14, -120);
    this.tone(220, 0.4, 'triangle', 0.12, -90, 0.2);
  }
  coin(): void {
    this.tone(1200, 0.08, 'sine', 0.12, 400);
  }
  /** Avalanche: a rising chord that climbs a step with every collector in the run. */
  cascade(run: number): void {
    const base = 440 * Math.pow(1.122, Math.min(run, 8));
    [1, 1.25, 1.5].forEach((m, i) => this.tone(base * m, 0.28, 'triangle', 0.16, 120, i * 0.05));
    this.tone(base * 2, 0.4, 'sine', 0.1, 300, 0.12);
  }
}

export const sfx = new Sfx();

export function haptic(ms: number): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* unsupported */
  }
}
