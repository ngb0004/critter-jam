/**
 * Synthesised WebAudio SFX (app). No audio files: every sound is oscillators + one shared noise buffer.
 *
 * Graph:  voices -> [panner] -> sfx bus -> master -> compressor -> out
 *                            \-> echo send (cave slap-back: delay + damped feedback) -> master
 *         ambience (per-biome drone + air, Wyrm breath hiss) -> master
 * The sfx bus ducks under the fusion reveal so the boom owns the moment.
 *
 * Driven by sim events (read-only) plus a few UI calls (fusion whoosh/boom, clicks). `onEvents(ev, w)` also
 * reads the World each frame (read-only) for the listener position (stereo pan), the biome drone, the Core
 * heartbeat (shared with the renderer via render/util coreBeatPhase) and the Wyrm's breath.
 *
 * Many hits layer cleanly: each sound kind has a minimum gap and a live-voice cap, there is a global voice cap
 * (big moments bypass it), and every voice gets a little random pitch so a crowd never machine-guns one note.
 * The gem arpeggio climbs a pentatonic scale with the pickup combo.
 */
import { EV, type EventQueue } from '../core/events';
import { SRC, TG_COLOR } from '../core/types';
import type { World } from '../core/world';
import { SPELLS } from '../content/spells';
import { ENEMIES } from '../content/enemies';
import { coreBeatPhase } from '../render/util';

/** Major pentatonic over two-plus octaves from A4 (the gem arpeggio climbs this). */
const PENTA = [440, 494, 554, 659, 740, 880, 988, 1109, 1319, 1480, 1760, 1976, 2217, 2637];
/** Biome drone roots (index = layer, 6 = Core). */
const DRONE = [55, 55, 49, 41.2, 61.7, 46.2, 36.7];
/** Live voices allowed per sound kind (hits and pops would otherwise swamp everything). */
const CAP: Record<string, number> = { hit: 6, crit: 3, kill: 6, gem: 5, cast: 3, warn: 3, status: 2, hurt: 2 };
const GLOBAL_CAP = 34;

interface VoiceOpts {
  slideTo?: number;
  delay?: number;
  attack?: number;
  detune?: number;
  pan?: number;
  send?: number;
  kind?: string;
}

export class DelveAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private echo: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private _volume = 0.7;
  private _muted = false;
  private last: Record<string, number> = {};
  private live: Record<string, number> = {};
  private combo = 0;
  private comboAt = 0;
  private hitVar = 0;
  private voices = 0;
  // world-driven state
  private listenerX = 0;
  private droneLayer = -1;
  private droneOsc: OscillatorNode[] = [];
  private droneGain: GainNode | null = null;
  private airFilter: BiquadFilterNode | null = null;
  private breathGain: GainNode | null = null;
  private breathFilter: BiquadFilterNode | null = null;
  private lastBeat = -1;
  private lastTick = -1;

  get volume(): number {
    return this._volume;
  }
  set volume(v: number) {
    this._volume = Math.min(1, Math.max(0, v));
    this.applyVolume();
  }
  get muted(): boolean {
    return this._muted;
  }
  set muted(m: boolean) {
    this._muted = m;
    this.applyVolume();
  }

  /** Must be called from a user gesture (Dive button) to start audio on mobile. */
  unlock(): void {
    if (!this.ctx) {
      try {
        const AC = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)!;
        const ctx = new AC();
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -16;
        comp.knee.value = 14;
        comp.ratio.value = 5;
        comp.attack.value = 0.003;
        comp.release.value = 0.18;
        const master = ctx.createGain();
        master.gain.value = 0;
        master.connect(comp).connect(ctx.destination);
        const sfx = ctx.createGain();
        sfx.connect(master);
        // cave slap-back: two taps with damped feedback
        const echo = ctx.createGain();
        echo.gain.value = 1;
        const d1 = ctx.createDelay(1);
        d1.delayTime.value = 0.19;
        const d2 = ctx.createDelay(1);
        d2.delayTime.value = 0.31;
        const fb = ctx.createGain();
        fb.gain.value = 0.34;
        const damp = ctx.createBiquadFilter();
        damp.type = 'lowpass';
        damp.frequency.value = 1700;
        const wet = ctx.createGain();
        wet.gain.value = 0.55;
        echo.connect(d1);
        echo.connect(d2);
        d1.connect(damp);
        d2.connect(damp);
        damp.connect(fb).connect(d1);
        damp.connect(wet).connect(master);
        const len = Math.floor(ctx.sampleRate * 1.0);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = buf.getChannelData(0);
        let s = 0x9e3779b9;
        for (let i = 0; i < len; i++) {
          s ^= s << 13;
          s ^= s >>> 17;
          s ^= s << 5;
          d[i] = ((s >>> 0) / 4294967296) * 2 - 1;
        }
        this.ctx = ctx;
        this.master = master;
        this.sfx = sfx;
        this.echo = echo;
        this.noise = buf;
        this.buildAmbience();
      } catch {
        this.ctx = null;
      }
    }
    if (this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => undefined);
    this.applyVolume();
  }

  /** Pause/resume the audio clock with the app (tab hidden, pause menu). */
  suspend(on: boolean): void {
    if (!this.ctx) return;
    if (on && this.ctx.state === 'running') void this.ctx.suspend().catch(() => undefined);
    if (!on && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  applyVolume(): void {
    if (!this.master || !this.ctx) return;
    const v = this._muted ? 0 : this._volume * this._volume * 0.9; // perceptual curve
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  // --- plumbing -------------------------------------------------------------------------------------

  private ok(key: string, minMs: number, important = false): boolean {
    if (!this.ctx || this._muted || this._volume <= 0) return false;
    const now = performance.now();
    if (now - (this.last[key] ?? -1e9) < minMs) return false;
    if (!important && this.voices > GLOBAL_CAP) return false;
    const cap = CAP[key];
    if (cap !== undefined && (this.live[key] ?? 0) >= cap) return false;
    this.last[key] = now;
    return true;
  }

  private env(g: GainNode, t: number, peak: number, attack: number, dur: number): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  private track(node: AudioScheduledSourceNode, kind?: string): void {
    this.voices++;
    if (kind) this.live[kind] = (this.live[kind] ?? 0) + 1;
    node.onended = () => {
      this.voices--;
      if (kind) this.live[kind] = Math.max(0, (this.live[kind] ?? 1) - 1);
    };
  }

  /** Route a voice's gain node: optional stereo pan, optional echo send. */
  private out(g: GainNode, o: VoiceOpts): void {
    const c = this.ctx!;
    let node: AudioNode = g;
    if (o.pan && c.createStereoPanner) {
      const p = c.createStereoPanner();
      p.pan.value = Math.max(-0.8, Math.min(0.8, o.pan));
      g.connect(p);
      node = p;
    }
    node.connect(this.sfx!);
    if (o.send && this.echo) {
      const s = c.createGain();
      s.gain.value = o.send;
      node.connect(s).connect(this.echo);
    }
  }

  private tone(freq: number, dur: number, type: OscillatorType, peak: number, o: VoiceOpts = {}): void {
    const c = this.ctx;
    if (!c || !this.sfx) return;
    const t = c.currentTime + (o.delay ?? 0);
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (o.detune) osc.detune.value = o.detune;
    if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.slideTo), t + dur);
    this.env(g, t, peak, o.attack ?? 0.006, dur);
    osc.connect(g);
    this.out(g, o);
    osc.start(t);
    osc.stop(t + dur + 0.03);
    this.track(osc, o.kind);
  }

  private noiseBurst(dur: number, peak: number, filter: BiquadFilterType, f0: number, f1: number, o: VoiceOpts & { q?: number } = {}): void {
    const c = this.ctx;
    if (!c || !this.sfx || !this.noise) return;
    const t = c.currentTime + (o.delay ?? 0);
    const src = c.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bf = c.createBiquadFilter();
    bf.type = filter;
    bf.Q.value = o.q ?? 1;
    bf.frequency.setValueAtTime(f0, t);
    bf.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = c.createGain();
    this.env(g, t, peak, o.attack ?? 0.005, dur);
    src.connect(bf).connect(g);
    this.out(g, o);
    src.start(t, (this.hitVar++ % 10) * 0.09);
    src.stop(t + dur + 0.03);
    this.track(src, o.kind);
  }

  /** Random pitch spread in cents. */
  private jit(c: number): number {
    return (Math.random() * 2 - 1) * c;
  }

  private panOf(x: number): number {
    return (x - this.listenerX) / 14;
  }

  /** Duck the sfx bus (fusion reveal) and bring it back. */
  private duck(depth: number, holdSec: number): void {
    const c = this.ctx;
    if (!c || !this.sfx) return;
    const g = this.sfx.gain;
    const t = c.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(depth, t + 0.08);
    g.setValueAtTime(depth, t + holdSec);
    g.linearRampToValueAtTime(1, t + holdSec + 0.25);
  }

  // --- ambience -------------------------------------------------------------------------------------

  private buildAmbience(): void {
    const c = this.ctx!;
    const g = c.createGain();
    g.gain.value = 0;
    g.connect(this.master!);
    for (let i = 0; i < 2; i++) {
      const o = c.createOscillator();
      o.type = i === 0 ? 'sine' : 'triangle';
      o.frequency.value = DRONE[1] * (i === 0 ? 1 : 1.5);
      o.detune.value = i === 0 ? -4 : 5;
      const og = c.createGain();
      og.gain.value = i === 0 ? 0.5 : 0.14;
      o.connect(og).connect(g);
      o.start();
      this.droneOsc.push(o);
    }
    // cave air: slow filtered noise
    const air = c.createBufferSource();
    air.buffer = this.noise;
    air.loop = true;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380;
    lp.Q.value = 0.7;
    const ag = c.createGain();
    ag.gain.value = 0.22;
    air.connect(lp).connect(ag).connect(g);
    air.start();
    this.airFilter = lp;
    this.droneGain = g;
    // the Wyrm's breath: a band of hiss that swells with the breath damage
    const br = c.createBufferSource();
    br.buffer = this.noise;
    br.loop = true;
    br.playbackRate.value = 0.7;
    const bf = c.createBiquadFilter();
    bf.type = 'bandpass';
    bf.frequency.value = 500;
    bf.Q.value = 0.8;
    const bg = c.createGain();
    bg.gain.value = 0;
    br.connect(bf).connect(bg).connect(this.master!);
    br.start();
    this.breathGain = bg;
    this.breathFilter = bf;
  }

  /** Per-frame World-driven sound: drone per biome, Core heartbeat, Wyrm breath. Read-only. */
  private follow(w: World): void {
    const c = this.ctx;
    if (!c || !this.droneGain) return;
    const t = c.currentTime;
    this.listenerX = w.player.x;
    const running = w.tick > 0 && !w.over;
    const layer = Math.max(1, Math.min(6, w.layer));
    if (layer !== this.droneLayer) {
      this.droneLayer = layer;
      const f = DRONE[layer];
      this.droneOsc[0].frequency.setTargetAtTime(f, t, 1.2);
      this.droneOsc[1].frequency.setTargetAtTime(f * (layer === 6 ? 1.414 : 1.5), t, 1.2); // the Core: a tritone
      this.airFilter?.frequency.setTargetAtTime(layer === 6 ? 620 : layer === 3 ? 260 : 380, t, 1);
    }
    this.droneGain.gain.setTargetAtTime(running ? (layer === 6 ? 0.13 : 0.09) : 0.03, t, 0.6);
    // the Wyrm breathes on you
    const hz = w.hazard;
    const breath = hz && hz.wyrmActive && !w.over ? Math.min(1, 0.25 + hz.breathPerSec * 25) : 0;
    this.breathGain?.gain.setTargetAtTime(breath * 0.22, t, 0.3);
    this.breathFilter?.frequency.setTargetAtTime(400 + breath * 900, t, 0.3);
    // Core heartbeat: lub at the start of each beat, dub 0.2 s later (renderer pumps the vignette on the same clock)
    if (w.tick !== this.lastTick) {
      const ph = w.layer >= 6 && !w.over ? coreBeatPhase(w.tick) : -1;
      const prevPh = this.lastBeat;
      if (ph >= 0 && prevPh >= 0) {
        const depth = Math.min(1, Math.max(0, (w.tick / 60 - 300) / 420));
        if (ph < prevPh) this.thump(0.16 + 0.22 * depth, 62);
        else if (prevPh < 0.2 && ph >= 0.2) this.thump(0.1 + 0.16 * depth, 52);
      }
      this.lastBeat = ph;
      this.lastTick = w.tick;
    }
  }

  private thump(peak: number, f: number): void {
    if (!this.ok('thump', 120, true)) return;
    this.tone(f, 0.24, 'sine', peak, { slideTo: f * 0.55, attack: 0.004 });
    this.noiseBurst(0.08, peak * 0.25, 'lowpass', 300, 80);
  }

  // --- named sounds --------------------------------------------------------------------------------

  /** A hit, coloured by the spell's keyword. */
  hit(crit: boolean, kw = '', x = this.listenerX): void {
    const pan = this.panOf(x);
    if (crit) {
      if (!this.ok('crit', 70)) return;
      const f = 1500 + Math.random() * 600;
      this.tone(f, 0.09, 'triangle', 0.07, { slideTo: f * 1.3, pan, kind: 'crit' });
      this.noiseBurst(0.05, 0.14, 'highpass', 3000, 1800, { pan, kind: 'crit' });
      this.tone(220, 0.08, 'square', 0.05, { slideTo: 80, pan, kind: 'crit' });
      return;
    }
    if (!this.ok('hit', 36)) return;
    const j = this.jit(120);
    switch (kw) {
      case 'fire':
        this.noiseBurst(0.09, 0.11, 'bandpass', 1400, 380, { q: 0.9, pan, kind: 'hit' });
        this.tone(150, 0.08, 'sine', 0.06, { slideTo: 70, detune: j, pan, kind: 'hit' });
        break;
      case 'poison':
        this.tone(520 + Math.random() * 120, 0.08, 'sine', 0.05, { slideTo: 240, detune: j, pan, kind: 'hit' });
        this.noiseBurst(0.04, 0.04, 'lowpass', 900, 300, { pan, kind: 'hit' });
        break;
      case 'storm':
        this.tone(1900, 0.05, 'square', 0.025, { slideTo: 500, detune: j, pan, kind: 'hit' });
        this.noiseBurst(0.05, 0.08, 'highpass', 4000, 2000, { pan, kind: 'hit' });
        break;
      case 'shadow':
        this.tone(320, 0.1, 'triangle', 0.05, { slideTo: 140, detune: j, pan, kind: 'hit' });
        this.noiseBurst(0.08, 0.05, 'lowpass', 700, 200, { pan, kind: 'hit' });
        break;
      default: {
        const v = (this.hitVar++ % 7) * 14;
        this.noiseBurst(0.045, 0.08, 'bandpass', 2600 + v * 10, 900, { q: 1.4, pan, kind: 'hit' });
        this.tone(190 + v, 0.06, 'square', 0.03, { slideTo: 90, detune: j, pan, kind: 'hit' });
      }
    }
  }

  /** Kill pop: small critters squeak high, big ones thud. size = radius in m. */
  killPop(big: boolean, size = 0.45, x = this.listenerX): void {
    if (!this.ok('kill', big ? 0 : 26, big)) return;
    const pan = this.panOf(x);
    if (big) {
      this.tone(150, 0.24, 'sine', 0.26, { slideTo: 55, pan, send: 0.25 });
      this.noiseBurst(0.3, 0.2, 'lowpass', 1800, 200, { pan });
      this.tone(620, 0.12, 'triangle', 0.06, { slideTo: 1240, delay: 0.03, pan });
      return;
    }
    const f = Math.max(240, 820 - size * 700) * (0.9 + Math.random() * 0.25);
    this.tone(f, 0.07, 'sine', 0.085, { slideTo: f * 2.4, detune: this.jit(60), pan, kind: 'kill' });
    this.noiseBurst(0.03, 0.04, 'bandpass', 3200, 1800, { q: 2, pan, kind: 'kill' });
  }

  gem(tier: number, x = this.listenerX): void {
    const now = performance.now();
    if (now - this.comboAt > 650) this.combo = 0;
    this.comboAt = now;
    if (!this.ok('gem', 34)) return;
    // climbs one pentatonic step per pickup in a combo, then sparkles between the top two notes
    const n = this.combo < PENTA.length ? this.combo : PENTA.length - 2 + (this.combo & 1);
    this.combo++;
    const pan = this.panOf(x) * 0.5;
    const f = PENTA[n] * (tier >= 3 ? 0.5 : 1);
    this.tone(f, 0.11, 'triangle', 0.07 + tier * 0.015, { pan, kind: 'gem' });
    this.tone(f * 2, 0.07, 'sine', 0.025, { delay: 0.02, pan, kind: 'gem' });
    // every 8th pickup in a combo: a little shimmer chord
    if (this.combo % 8 === 0) [1, 1.25, 1.5].forEach((m, i) => this.tone(f * m, 0.25, 'sine', 0.03, { delay: 0.04 + i * 0.03, send: 0.4 }));
  }

  levelUp(): void {
    if (!this.ok('lvl', 200, true)) return;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      this.tone(f, 0.5, 'sine', 0.12, { delay: i * 0.06, attack: 0.01, send: 0.35 });
      this.tone(f * 2.01, 0.35, 'triangle', 0.03, { delay: i * 0.06 });
    });
  }

  /** Fusion part 1: rising whoosh while the reel spins (ducks everything else). */
  fusionWhoosh(sec = 1.4): void {
    if (!this.ok('fwhoosh', 300, true)) return;
    this.duck(0.25, sec);
    this.noiseBurst(sec, 0.24, 'bandpass', 300, 5200, { q: 2.5, attack: sec * 0.8, send: 0.3 });
    this.tone(110, sec, 'sawtooth', 0.05, { slideTo: 880, attack: sec * 0.8 });
    this.tone(55, sec, 'sine', 0.12, { slideTo: 110, attack: sec * 0.6 });
    // reel ticks, accelerating then slowing like a slot reel
    for (let i = 0; i < 14; i++) this.tone(1800 - i * 40, 0.03, 'square', 0.03, { delay: (i / 14) * sec * (0.4 + (i / 14) * 0.6) });
  }

  /** Fusion part 2: the boom when the reel lands. */
  fusionBoom(): void {
    if (!this.ok('fboom', 300, true)) return;
    this.tone(90, 1.0, 'sine', 0.5, { slideTo: 26, attack: 0.004 });
    this.noiseBurst(0.8, 0.38, 'lowpass', 6000, 120, { attack: 0.002, send: 0.5 });
    [523.25, 659.25, 783.99, 1046.5, 1567.98].forEach((f, i) => this.tone(f, 1.1, 'triangle', 0.06, { delay: 0.05 + i * 0.03, send: 0.6 }));
    this.tone(2093, 0.6, 'sine', 0.04, { delay: 0.2, send: 0.6 });
  }

  /** A boss bursting out of the floor; `pitch` tilts each boss's voice (Anvil King lowest). */
  bossRoar(pitch = 1, x = this.listenerX): void {
    if (!this.ok('roar', 800, true)) return;
    const c = this.ctx;
    if (!c || !this.sfx) return;
    const t = c.currentTime;
    const pan = this.panOf(x) * 0.6;
    // sub thump as it cracks the floor, then the growl
    this.tone(70 * pitch, 0.5, 'sine', 0.4, { slideTo: 30, attack: 0.003 });
    this.noiseBurst(0.6, 0.25, 'lowpass', 1200, 90, { send: 0.3 });
    for (let k = 0; k < 2; k++) {
      const o = c.createOscillator();
      const lfo = c.createOscillator();
      const lg = c.createGain();
      const bp = c.createBiquadFilter();
      const g = c.createGain();
      o.type = 'sawtooth';
      const f0 = (110 + k * 7) * pitch;
      o.frequency.setValueAtTime(f0 * 0.8, t + 0.15);
      o.frequency.linearRampToValueAtTime(f0, t + 0.45);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.45, t + 1.5);
      lfo.frequency.value = 13 + k * 4;
      lg.gain.value = 14 * pitch;
      lfo.connect(lg).connect(o.frequency);
      // a formant sweep makes it a throat, not a buzz
      bp.type = 'bandpass';
      bp.Q.value = 3;
      bp.frequency.setValueAtTime(500, t + 0.15);
      bp.frequency.linearRampToValueAtTime(1100, t + 0.5);
      bp.frequency.exponentialRampToValueAtTime(280, t + 1.5);
      this.env(g, t + 0.15, 0.3, 0.1, 1.5);
      o.connect(bp).connect(g);
      this.out(g, { pan, send: 0.45 });
      o.start(t + 0.15);
      lfo.start(t + 0.15);
      o.stop(t + 1.7);
      lfo.stop(t + 1.7);
      this.track(o);
    }
    this.noiseBurst(1.2, 0.14, 'bandpass', 900, 200, { delay: 0.15, q: 1.5, attack: 0.1, pan });
  }

  /** The maw cracks open: a long rumble swelling toward the head's arrival. */
  mawRumble(): void {
    if (!this.ok('maw', 2000, true)) return;
    this.noiseBurst(8, 0.3, 'lowpass', 70, 260, { attack: 6, send: 0.2 });
    this.tone(38, 8, 'sine', 0.3, { slideTo: 52, attack: 6 });
    this.tone(30, 1.2, 'sine', 0.4, { slideTo: 20, attack: 0.01 });
    this.noiseBurst(1.0, 0.3, 'lowpass', 2500, 100, { send: 0.4 });
  }

  /** The Wyrm's head breaks through: the biggest voice in the game. */
  wyrmRoar(): void {
    if (!this.ok('wyrm', 2000, true)) return;
    const c = this.ctx;
    if (!c || !this.sfx) return;
    const t = c.currentTime;
    this.tone(48, 1.6, 'sine', 0.55, { slideTo: 22, attack: 0.004 });
    this.noiseBurst(1.6, 0.4, 'lowpass', 3000, 90, { send: 0.5 });
    for (let k = 0; k < 3; k++) {
      const o = c.createOscillator();
      const bp = c.createBiquadFilter();
      const g = c.createGain();
      o.type = 'sawtooth';
      const f0 = 62 + k * 3.3;
      o.frequency.setValueAtTime(f0 * 1.3, t + 0.1);
      o.frequency.exponentialRampToValueAtTime(f0, t + 0.8);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.6, t + 2.6);
      bp.type = 'bandpass';
      bp.Q.value = 2.5;
      bp.frequency.setValueAtTime(300, t);
      bp.frequency.linearRampToValueAtTime(900, t + 0.7);
      bp.frequency.exponentialRampToValueAtTime(200, t + 2.6);
      this.env(g, t + 0.1, 0.32, 0.25, 2.6);
      o.connect(bp).connect(g);
      this.out(g, { send: 0.6, pan: (k - 1) * 0.4 });
      o.start(t + 0.1);
      o.stop(t + 2.8);
      this.track(o);
    }
  }

  /** Stagger: a metal-on-stone clang and a pained snort. */
  stagger(): void {
    if (!this.ok('stagger', 250, true)) return;
    [1, 2.76, 5.4, 8.93].forEach((m, i) => this.tone(220 * m, 0.7 - i * 0.12, 'sine', 0.09 / (i + 1), { attack: 0.002, send: 0.4 }));
    this.noiseBurst(0.12, 0.2, 'highpass', 5000, 2500);
    this.noiseBurst(0.5, 0.14, 'bandpass', 600, 200, { delay: 0.08, q: 2 });
  }

  warn(gold = false): void {
    if (!this.ok('warn', 140)) return;
    if (gold) {
      this.tone(988, 0.12, 'triangle', 0.06, { kind: 'warn' });
      this.tone(1319, 0.14, 'triangle', 0.06, { delay: 0.08, kind: 'warn', send: 0.3 });
    } else {
      this.tone(660, 0.07, 'square', 0.035, { kind: 'warn' });
      this.tone(880, 0.09, 'square', 0.035, { delay: 0.075, kind: 'warn' });
    }
  }

  formation(): void {
    if (!this.ok('formation', 800, true)) return;
    [1175, 988, 831, 659].forEach((f, i) => this.tone(f, 0.3, 'triangle', 0.05, { delay: i * 0.07, send: 0.5 }));
    this.noiseBurst(0.6, 0.06, 'bandpass', 2000, 600, { q: 3, attack: 0.2 });
  }

  dash(): void {
    if (!this.ok('dash', 80)) return;
    this.noiseBurst(0.22, 0.16, 'bandpass', 600, 3200, { q: 1.8 });
    this.tone(220, 0.15, 'sine', 0.05, { slideTo: 520 });
  }

  /** Dashed clean through a red floor: a bright whiff. */
  dodge(): void {
    if (!this.ok('dodge', 120)) return;
    this.tone(1320, 0.12, 'sine', 0.05, { slideTo: 1980 });
    this.tone(1760, 0.16, 'sine', 0.04, { delay: 0.05, send: 0.3 });
  }

  hurt(): void {
    if (!this.ok('hurt', 110)) return;
    this.tone(150, 0.14, 'triangle', 0.14, { slideTo: 60, kind: 'hurt' });
    this.noiseBurst(0.08, 0.08, 'lowpass', 1200, 300, { kind: 'hurt' });
  }

  layerGong(core = false): void {
    if (!this.ok('gong', 500, true)) return;
    const base = core ? 98 : 131;
    [1, 2.01, 2.76, 4.07].forEach((m, i) => this.tone(base * m, 1.8 - i * 0.3, 'sine', 0.1 / (i + 1), { attack: 0.004, send: 0.5 }));
    if (core) {
      this.tone(41, 2.5, 'sine', 0.3, { slideTo: 30, attack: 0.01 });
      this.noiseBurst(2, 0.2, 'lowpass', 400, 60, { send: 0.3 });
    }
  }

  chest(): void {
    if (!this.ok('chest', 200, true)) return;
    [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, 0.25, 'triangle', 0.07, { delay: i * 0.05, send: 0.4 }));
  }

  death(): void {
    if (!this.ok('death', 500, true)) return;
    [392, 311.13, 261.63, 196].forEach((f, i) => this.tone(f, 0.55, 'triangle', 0.12, { delay: i * 0.16, slideTo: f * 0.96, send: 0.5 }));
    this.tone(70, 1.2, 'sine', 0.3, { slideTo: 30, delay: 0.1 });
  }

  /** Results: one coin tick while the points count up (pitch climbs with progress 0..1). */
  tally(progress: number): void {
    if (!this.ok('tally', 45, true)) return;
    const f = 900 + progress * 900;
    this.tone(f, 0.05, 'square', 0.025, { slideTo: f * 1.02 });
    this.tone(f * 2, 0.08, 'sine', 0.03, { send: 0.2 });
  }

  /** Results: a new best of the day (bright brass-ish arpeggio + shimmer). */
  fanfare(): void {
    if (!this.ok('fanfare', 1500, true)) return;
    const notes = [392, 523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => {
      this.tone(f, i === notes.length - 1 ? 1.2 : 0.22, 'sawtooth', 0.045, { delay: i * 0.11, attack: 0.01, send: 0.4 });
      this.tone(f, i === notes.length - 1 ? 1.3 : 0.25, 'triangle', 0.09, { delay: i * 0.11, attack: 0.01, send: 0.4 });
    });
    [1567.98, 2093, 2637].forEach((f, i) => this.tone(f, 0.9, 'sine', 0.035, { delay: 0.55 + i * 0.07, send: 0.7 }));
    this.noiseBurst(0.9, 0.05, 'highpass', 6000, 9000, { delay: 0.5, send: 0.6 });
  }

  /** Results: the time lands (soft thump + chime). */
  stamp(): void {
    if (!this.ok('stamp', 300, true)) return;
    this.tone(120, 0.3, 'sine', 0.3, { slideTo: 50, attack: 0.003 });
    this.tone(1318.5, 0.5, 'triangle', 0.05, { delay: 0.02, send: 0.5 });
  }

  click(): void {
    if (!this.ok('click', 30, true)) return;
    this.tone(1400, 0.035, 'triangle', 0.05, { slideTo: 900 });
  }

  private kwOfSrc(w: World | undefined, src: number): string {
    if (!w) return '';
    if (src === SRC.FUSION) return 'storm';
    if (src < 0 || src >= 6) return '';
    const si = w.build.slotSpell[src];
    const sp = si >= 0 ? SPELLS[si] : undefined;
    return sp ? sp.keywords[0] : '';
  }

  /** Drain-side hook: call once per frame with the sim's events (read-only), and the World if available. */
  onEvents(ev: EventQueue, w?: World): void {
    if (!this.ctx || this._muted) return;
    if (w) this.follow(w);
    for (let i = 0; i < ev.n; i++) {
      switch (ev.kind[i]) {
        case EV.HIT:
          if (ev.c[i] === 0 || ev.c[i] === 1) this.hit(ev.c[i] === 1, this.kwOfSrc(w, ev.b[i]), ev.x[i]);
          break;
        case EV.KILL: {
          const d = ENEMIES[ev.b[i]];
          this.killPop(ev.v[i] > 8, d ? d.radius : 0.45, ev.x[i]);
          break;
        }
        case EV.GEM_PICKUP:
          this.gem(ev.b[i], ev.x[i]);
          break;
        case EV.LEVEL_UP:
          this.levelUp();
          break;
        case EV.PLAYER_HURT:
          this.hurt();
          break;
        case EV.BOSS_SPAWN:
          this.bossRoar(1.15 - ev.b[i] * 0.09, ev.x[i]);
          break;
        case EV.BOSS_KILL:
          this.killPop(true);
          this.levelUp();
          break;
        case EV.TELEGRAPH:
          if (ev.c[i] !== TG_COLOR.VIOLET) this.warn(ev.c[i] === TG_COLOR.GOLD);
          break;
        case EV.BURST_HIT:
          if (ev.b[i] === 1) this.dodge();
          break;
        case EV.DASH:
          this.dash();
          break;
        case EV.LAYER_CHANGE:
          this.layerGong(false);
          break;
        case EV.CORE_ENTER:
          this.layerGong(true);
          break;
        case EV.WYRMFALL:
          if (ev.a[i] === 0) this.mawRumble();
          else this.wyrmRoar();
          break;
        case EV.STAGGER:
          this.stagger();
          break;
        case EV.FORMATION:
          this.formation();
          break;
        case EV.CHEST:
          this.chest();
          break;
        case EV.DEATH:
          this.death();
          break;
        // EV.FUSION is voiced by the UI reveal (fusionWhoosh / fusionBoom) so it lines up with the reel.
      }
    }
  }
}
