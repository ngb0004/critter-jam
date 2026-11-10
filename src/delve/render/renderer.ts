/**
 * Delve Daily renderer (RENDER): a glowing toy-diorama cave.
 *
 * Contract: read-only access to World; events come in through onEvents() (copied, then handled in render()
 * against the world being drawn); the World is never mutated. Coordinates: sim (x, y) -> three (x, h, -y),
 * so screen up = sim +y.
 *
 * Pieces: env.ts (floor, walls, biome props, palettes), actors.ts (critters, bosses, the Wyrm, the delver,
 * pickups, projectiles, zones, telegraph decals), fx.ts (particles, glows, rings, lightning, damage numbers),
 * post.ts (bloom + overlay + quality governor), debug.ts (?debug FPS readout and stress rig).
 *
 * Smoothness: the sim runs at 60 Hz; this renderer mirrors the host's fixed-step accumulator to get the
 * fraction of a tick since the last step and interpolates every pooled position between the last two ticks,
 * so 120 Hz displays move smoothly.
 */
import * as THREE from 'three';
import { DT } from '../core/constants';
import { EV, type EventQueue } from '../core/events';
import { EF, SRC } from '../core/types';
import type { World } from '../core/world';
import { BOSSES } from '../content/bosses';
import { ENEMIES } from '../content/enemies';
import { SPELLS } from '../content/spells';
import { Actors, rankK } from './actors';
import { CaveEnv, lookFor, type Look } from './env';
import { Beams, DamageNumbers, Flashes, Particles, Rings, SpriteBatch } from './fx';
import { uTime } from './materials';
import { Post } from './post';
import { DEBUG, DebugHud, StressRig } from './debug';
import { FX_COLORS, TAU, clamp01, coreHeartbeat, damp, mixHex } from './util';

/**
 * Colour grade per layer (index = layer, 6 = the Core): [centre gain, edge gain] as rgb multipliers.
 * Warm lantern pool in the middle, each biome's own tint in the shadows around it.
 */
const GRADES: ReadonlyArray<readonly [readonly [number, number, number], readonly [number, number, number]]> = [
  [[1, 1, 1], [1, 1, 1]],
  [[1.08, 1.01, 0.88], [0.86, 0.76, 0.98]], // 1 Lamp Tunnels: amber pool, violet-brown shadows
  [[0.94, 1.07, 1.05], [0.8, 0.96, 1.12]], // 2 Fungal Hollow: teal pool and shadows
  [[0.92, 1.0, 1.1], [0.74, 0.9, 1.16]], // 3 Flooded Works: cold blue
  [[1.07, 0.97, 1.07], [0.98, 0.76, 1.08]], // 4 Crystal Vault: pink-violet
  [[1.1, 0.99, 0.86], [1.04, 0.7, 0.62]], // 5 Ember Forge: red-orange
  [[1.06, 0.97, 0.92], [0.92, 0.72, 1.02]], // 6 the Core: violet edges (red is reserved for "move")
];

export interface RenderOptions {
  reducedMotion: boolean;
  damageNumbers: boolean;
  /** Screen shake (default on; always off with reducedMotion). */
  screenShake?: boolean;
}

/** Copy of one frame's events (the host clears the queue right after onEvents). */
class EventCopy {
  n = 0;
  readonly kind = new Uint8Array(8192);
  readonly a = new Int32Array(8192);
  readonly b = new Int32Array(8192);
  readonly c = new Int32Array(8192);
  readonly x = new Float32Array(8192);
  readonly y = new Float32Array(8192);
  readonly v = new Float32Array(8192);
  append(q: EventQueue): void {
    for (let i = 0; i < q.n && this.n < 8192; i++) {
      const j = this.n++;
      this.kind[j] = q.kind[i];
      this.a[j] = q.a[i];
      this.b[j] = q.b[i];
      this.c[j] = q.c[i];
      this.x[j] = q.x[i];
      this.y[j] = q.y[i];
      this.v[j] = q.v[i];
    }
  }
}

export class DelveRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.5, 220);
  opts: RenderOptions = { reducedMotion: false, damageNumbers: true };
  /** True while the fusion moment owns the screen (UI may sync its reel to it). */
  fusionActive = false;
  /** Debug only (screenshots): presentation slow-motion factor applied to the frame dt. */
  timeScale = 1;

  private readonly env: CaveEnv;
  private readonly actors: Actors;
  private readonly particles = new Particles(5000);
  private readonly glows = new SpriteBatch(1800, 0);
  private readonly stars = new SpriteBatch(600, 1);
  private readonly flashes = new Flashes(256);
  private readonly rings = new Rings(96);
  private readonly beams = new Beams(320);
  private readonly numbers = new DamageNumbers(96);
  private readonly post: Post;
  private readonly lantern: THREE.PointLight;
  private readonly fxLight: THREE.PointLight;
  private readonly key: THREE.DirectionalLight;
  private readonly ev = new EventCopy();

  private world: World | null = null;
  private lastTick = -1;
  private acc = 0;
  private time = 0;
  private shownLayer = -1;
  private look: Look = lookFor(1);
  private trans = -1; // layer transition timer (s), -1 = none
  private transTo = 1;
  private shake = 0;
  private hurt = 0;
  private flash = 0;
  private fusionT = -1;
  private fusionRelease = -1;
  private fxLightK = 0;
  private fxLightCol = 0xffffff;
  private deathT = -1;
  // boss intro: camera push toward the boss, lights dip, slam when it lands
  private bossT = -1;
  private bossX = 0;
  private bossY = 0;
  private bossCol = 0xff4a3a;
  private bossLanded = false;
  // the Wyrmfall: seconds since the maw opened (-1 none), and since the head broke through
  private mawT = -1;
  private headT = -1;
  // the fusion moment: colours of the result, inward spiral timer
  private fusionCol = 0xfff0c0;
  private fusionSpawn = 0;
  // gem pickup combo (sparkle colour climbs with it)
  private gemCombo = 0;
  private gemAt = -1;
  private heart = 0;
  // camera
  private camX = 0;
  private camZ = 0;
  private lookX = 0;
  private lookY = 0;
  private camDist = 24;
  /** 0..1 eased Wyrm framing (pull back + bias toward the maw). */
  private wyrmFrame = 0;
  private wyrmNear = 0;
  private wyrmNearS = 0;
  private aspect = 1;
  private punch = 0;
  private interpPX = 0;
  private interpPY = 0;
  private prevPX = 0;
  private prevPY = 0;
  private curPX = 0;
  private curPY = 0;
  // debug
  private readonly hud: DebugHud | null = null;
  private override: (() => World) | null = null;
  private stressW: World | null = null;
  private cpuMs = 0;
  private readonly tmpV = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.info.autoReset = false; // count every pass of a frame (composer + overlay)
    this.scene.background = new THREE.Color(0x0b0810);
    this.scene.fog = new THREE.Fog(0x0b0810, 30, 62);

    this.env = new CaveEnv(this.scene, 26);
    this.key = new THREE.DirectionalLight(0xb0a0ff, 0.35);
    this.key.position.set(-8, 14, 6);
    this.scene.add(this.key);
    this.lantern = new THREE.PointLight(0xffc27a, 11, 19, 1);
    this.scene.add(this.lantern);
    this.fxLight = new THREE.PointLight(0xffffff, 0, 22, 1);
    this.scene.add(this.fxLight);

    this.actors = new Actors(this.scene);
    this.scene.add(this.particles.points, this.glows.mesh, this.stars.mesh, this.rings.mesh, this.beams.mesh, this.numbers.mesh);
    this.post = new Post(this.renderer, this.scene, this.camera);

    if (DEBUG) {
      this.hud = new DebugHud();
      const g = window as unknown as Record<string, unknown>;
      g.__delveStress = (on = true): void => {
        const rig = on ? new StressRig() : null;
        this.stressW = rig ? rig.w : null;
        this.override = rig ? () => (this.stressW = rig.update()) : null;
      };
      // draw a test-built world instead of the live one (the provider steps its own world)
      g.__delveShow = (fn: (() => World) | null): void => {
        this.override = fn;
        this.stressW = null;
      };
      g.__delveRender = this;
    }
  }

  resize(w: number, h: number): void {
    this.aspect = w / Math.max(1, h);
    const portrait = this.aspect < 1;
    this.camera.fov = portrait ? 50 : 38;
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
    // keep ~16 m of width on a phone and ~18 m of height on desktop
    const tanH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.camDist = portrait ? Math.min(32, Math.max(19, 6.8 / (tanH * this.aspect))) : 21;
    this.post.setSize(w, h);
    this.particles.mat.uniforms.uScale.value = h * this.post.dpr * 0.6;
  }

  /** Feed the events produced since the last frame (before World.events.clear()). */
  onEvents(ev: EventQueue): void {
    if (!this.override) this.ev.append(ev);
  }

  /** Numbers for perf checks. */
  stats(): Record<string, number | boolean> {
    const info = this.renderer.info;
    const w = this.stressW ?? this.world;
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      points: info.render.points,
      frameMs: +this.post.frameMs.toFixed(2),
      cpuMs: +this.cpuMs.toFixed(2),
      bloom: this.post.bloomOn,
      level: this.post.level,
      dpr: this.post.dpr,
      enemies: w?.en.count ?? 0,
      projectiles: w?.pr.count ?? 0,
      gems: w?.gm.count ?? 0,
      geometries: info.memory.geometries,
      programs: info.programs?.length ?? 0,
    };
  }

  render(liveWorld: World, dt: number): void {
    this.renderer.info.reset();
    dt *= this.timeScale;
    let w = liveWorld;
    if (this.override) {
      w = this.override();
      this.ev.append(w.events);
      w.events.clear();
    }
    const t0 = performance.now();
    this.time += dt;
    uTime.value = this.time;
    if (w !== this.world) this.newWorld(w);

    // tick interpolation: mirror the host's accumulator
    const ticks = w.tick - this.lastTick;
    this.acc += dt;
    if (ticks > 0) {
      this.acc -= ticks * DT;
      this.prevPX = ticks === 1 ? this.curPX : w.player.x;
      this.prevPY = ticks === 1 ? this.curPY : w.player.y;
      this.curPX = w.player.x;
      this.curPY = w.player.y;
      this.actors.snap(w);
      this.lastTick = w.tick;
    }
    if (this.acc < 0) this.acc = 0;
    if (this.acc > DT) this.acc = DT;
    const paused = w.offer.open || w.over;
    const alpha = paused ? 1 : this.acc / DT;
    this.interpPX = this.prevPX + (this.curPX - this.prevPX) * alpha;
    this.interpPY = this.prevPY + (this.curPY - this.prevPY) * alpha;

    this.updateLayer(w, dt);
    // density follows the quality governor: the lowest levels emit fewer particles
    const fxs = this.post.level >= 2 ? 1 : this.post.level === 1 ? 0.7 : 0.45;
    this.particles.scale = fxs;
    this.actors.fxScale = fxs;
    this.handleEvents(w);
    this.moments(w, dt);
    // damage numbers refill at ~36/s (max 10 banked): a late-game crowd reads as numbers, not soup
    this.numbers.budget = this.opts.damageNumbers ? Math.min(10, Math.max(0, this.numbers.budget) + dt * 36) : 0;

    this.glows.begin();
    this.stars.begin();
    this.actors.update({
      w, alpha, dt, t: this.time, px: this.interpPX, py: this.interpPY,
      particles: this.particles, glows: this.glows, stars: this.stars, reducedMotion: this.opts.reducedMotion,
    });
    if (this.actors.impacts > 0 && this.actors.impactNear < 7) this.addShake(0.22);
    this.ambient(w, dt);
    this.flashes.update(dt, this.glows);
    this.glows.end();
    this.stars.end();
    this.particles.update(dt);
    this.rings.update(dt);
    this.beams.update(dt);
    this.numbers.update(dt);
    this.env.update(this.time);

    this.updateLights(w, dt);
    this.updateCamera(w, dt);
    this.updateOverlay(w, dt);
    this.post.govern(dt);
    this.cpuMs += (performance.now() - t0 - this.cpuMs) * 0.1;
    this.post.render();
    if (this.hud) {
      this.hud.frame(dt, () => {
        const s = this.stats();
        return `${s.calls} calls  ${(Number(s.triangles) / 1000).toFixed(0)}k tris  cpu ${s.cpuMs} ms\nQ${s.level} bloom ${s.bloom ? 'on' : 'off'} dpr ${s.dpr}\nen ${s.enemies} pr ${s.projectiles} gm ${s.gems}`;
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  private newWorld(w: World): void {
    this.world = w;
    this.bossT = this.mawT = this.headT = -1;
    this.gemCombo = 0;
    this.heart = 0;
    this.lastTick = w.tick;
    this.acc = 0;
    this.curPX = this.prevPX = this.interpPX = w.player.x;
    this.curPY = this.prevPY = this.interpPY = w.player.y;
    this.camX = w.player.x;
    this.camZ = -w.player.y;
    this.lookX = this.lookY = 0;
    this.wyrmFrame = 0;
    this.actors.reset();
    this.actors.snap(w);
    this.particles.clear();
    this.rings.clear();
    this.beams.clear();
    this.numbers.clear();
    this.flashes.clear();
    this.trans = -1;
    this.fusionT = -1;
    this.fusionRelease = -1;
    this.deathT = -1;
    this.fusionActive = false;
    this.shake = this.hurt = this.flash = 0;
    this.applyLayer(w, w.layer);
  }

  private applyLayer(w: World, layer: number): void {
    this.shownLayer = layer;
    this.look = lookFor(layer);
    this.env.layout(w.cfg.daySeed, layer, w.arenaR);
    this.env.apply(this.look, this.scene);
    // the lantern pool takes the biome's key colour (QA: every layer read amber near the delver)
    const lk = layer <= 1 ? 0.45 : 0.72;
    this.lantern.color.setHex(mixHex(0xffc27a, this.look.light, lk));
    const g = GRADES[Math.max(1, Math.min(6, layer))];
    const gu = this.post.grade.uniforms;
    (gu.uCentre.value as THREE.Color).setRGB(g[0][0], g[0][1], g[0][2]);
    (gu.uEdge.value as THREE.Color).setRGB(g[1][0], g[1][1], g[1][2]);
    this.actors.setLightColor(mixHex(0xffb060, this.look.light, lk));
    this.key.color.setHex(mixHex(0x9080c0, this.look.accent, 0.4));
  }

  private updateLayer(w: World, dt: number): void {
    if (w.layer !== this.shownLayer && this.trans < 0) {
      this.trans = 0;
      this.transTo = w.layer;
    }
    if (this.trans >= 0) {
      const T = 1.4;
      const before = this.trans;
      this.trans += dt;
      if (before < T / 2 && this.trans >= T / 2) this.applyLayer(w, this.transTo);
      if (this.trans >= T) this.trans = -1;
    }
  }

  // -------------------------------------------------------------------------------------------
  private spellOfSrc(w: World, src: number): number {
    if (src >= 0 && src < 6) return w.build.slotSpell[src];
    return -1;
  }

  private colorOfSrc(w: World, src: number): number {
    if (src === SRC.FUSION) return 0xfff0c0;
    if (src === SRC.STATUS) return 0xb0ff80;
    if (src === SRC.ALLY) return FX_COLORS.shadow;
    const si = this.spellOfSrc(w, src);
    return si >= 0 ? FX_COLORS[SPELLS[si].fx] ?? 0xffffff : 0xffffff;
  }

  private get shakeOn(): boolean {
    return !this.opts.reducedMotion && this.opts.screenShake !== false;
  }

  private addShake(k: number): void {
    if (!this.shakeOn) return;
    this.shake = Math.min(1, this.shake + k);
  }

  private handleEvents(w: World): void {
    const E = this.ev;
    const P = this.particles;
    let sparks = 28;
    let splashes = 6;
    let casts = 12;
    const px = this.interpPX, py = this.interpPY;
    for (let i = 0; i < E.n; i++) {
      const k = E.kind[i];
      const x = E.x[i], y = E.y[i], v = E.v[i];
      switch (k) {
        case EV.HIT: {
          const c = E.c[i];
          const src = E.b[i];
          const col = this.colorOfSrc(w, src);
          if (c === 3) {
            const a = E.a[i];
            if (a >= 0 && a < w.en.cap) {
              const rk = rankK(w, src);
              this.beams.bolt(x, y, w.en.x[a], w.en.y[a], 0.9, col === 0xffffff ? FX_COLORS.storm : col, 1.4 + 0.6 * rk, 0.2 + 0.08 * rk, 0.32 * (1 + 0.8 * rk), rk >= 1 ? 7 : 5);
              this.flashes.add(w.en.x[a], 0.9, w.en.y[a], 1.6 * (1 + 0.5 * rk), 0.6, 0.18, col, 1.2 + 0.5 * rk);
            }
          } else if (c === 4) {
            if (src === SRC.FUSION) this.fusionWave(x, y, v);
            else {
              const si = this.spellOfSrc(w, src);
              const sky = si >= 0 && SPELLS[si].id === 'thunderclap';
              if (splashes-- <= 0) break;
              // rank scales the burst: rank 5 adds a white shock ring, a hotter core and a fountain of embers
              const rk = src === SRC.RELIC ? 0 : rankK(w, src);
              this.rings.add(x, y, 0.3, Math.max(0.6, v) * (1 + 0.12 * rk), 0.38 + 0.12 * rk, col, 1.0 + 0.7 * rk, 0.3 + 0.12 * rk);
              // splash glow kept small and dim: dozens overlap in the Core and bloom turned them into white soup
              this.flashes.add(x, 0.5, y, v * 0.9 * (1 + 0.25 * rk), v * 0.45, 0.18 + 0.06 * rk, col, 0.28 + 0.22 * rk);
              if (sparks > 0) {
                sparks -= 6;
                P.burst(x, 0.4, y, 10 + Math.round(12 * rk), (3 + v) * (1 + 0.3 * rk), 3 + 3 * rk, col, 1.6 + 0.6 * rk, 0.4 + 0.15 * rk, 0.45 + 0.2 * rk, col === FX_COLORS.fire ? 2 : -6);
              }
              if (rk >= 1) {
                this.rings.add(x, y, 0.2, Math.max(0.6, v) * 0.75, 0.22, 0xffffff, 1.3, 0.18);
                this.flashes.add(x, 0.9, y, v * 0.6, 0.2, 0.12, 0xffffff, 0.5);
              }
              if (sky) {
                for (let s = 0; s < 8; s++) this.flashes.add(x + (Math.random() - 0.5) * 0.5, s * 1.2, y + (Math.random() - 0.5) * 0.5, 1.2, 0.4, 0.25, 0xd0f0ff, 1.6);
                this.addShake(0.08);
              }
            }
          } else {
            const crit = c === 1;
            const dot = c === 2;
            if (!dot && sparks > 0) {
              sparks--;
              this.flashes.add(x, 0.8, y, crit ? 1.4 : 0.8, 0.3, 0.12, crit ? 0xfff0a0 : col, crit ? 1.1 : 0.55);
              if (sparks % 2 === 0) P.burst(x, 0.8, y, crit ? 6 : 2, 4, 2, col, 1.4, 0.22, 0.25, -8);
            }
            if (this.opts.damageNumbers && v >= 1 && (!dot || Math.random() < 0.35)) {
              const hex = crit ? 0xffd23a : dot ? mixHex(col, 0xffffff, 0.5) : 0xffffff;
              // bigger hits read bigger (log scale), crits pop with a '!'
              const big = Math.min(0.45, Math.max(0, Math.log10(Math.max(1, v)) - 1) * 0.22);
              this.numbers.add(x, 1.4, y, v, hex, (crit ? 0.95 : dot ? 0.42 : 0.58) * (1 + big), crit ? 0.9 : dot ? 0.55 : 0.7, crit ? 1 : 0);
            }
          }
          break;
        }
        case EV.KILL: {
          const fl = E.c[i];
          const boss = (fl & EF.BOSS) !== 0;
          const def = E.b[i];
          const col = boss ? BOSSES[def]?.color ?? 0xffffff : ENEMIES[def]?.color ?? 0xffffff;
          if (boss) {
            P.burst(x, 1, y, 90, 10, 9, col, 2, 0.8, 1.2);
            P.burst(x, 1, y, 40, 6, 12, 0xffe0a0, 2, 0.5, 1.0);
            this.rings.add(x, y, 0.5, 9, 0.9, col, 1.6, 0.2);
            this.rings.add(x, y, 0.5, 5, 0.6, 0xffffff, 1.2, 0.3);
            this.flashCol(0xfff0d0, this.opts.reducedMotion ? 0.15 : 0.45);
            this.addShake(0.8);
            this.pulseLight(col, 3);
          } else if (!(fl & EF.WYRM)) {
            const big = (fl & (EF.ELITE | EF.CLUMP)) !== 0;
            // kill pop: the critter balloons white and bursts into bouncing chunks + a puff
            this.actors.pop(w, E.a[i], def, fl, x, y);
            P.burst(x, 0.6, y, big ? 26 : 7, big ? 6 : 4.5, 6, col, 1.2, big ? 0.5 : 0.34, 0.6, -16);
            if (sparks-- > 0) {
              this.flashes.add(x, 0.6, y, big ? 2.8 : 1.5, 0.3, 0.16, mixHex(col, 0xffffff, 0.45), 0.7);
              this.flashes.add(x, 0.9, y, 0.9, 0.1, 0.1, 0xffffff, 0.9);
            }
            if (big) {
              this.rings.add(x, y, 0.3, 3, 0.4, col, 1.2);
              this.addShake(0.2);
            }
          }
          break;
        }
        case EV.GEM_PICKUP: {
          const tier = E.b[i];
          if (tier === 4) {
            P.burst(px, 0.6, py, 40, 6, 10, 0xffd27a, 2, 0.5, 1.0);
            this.rings.add(px, py, 0.5, 5, 0.6, 0xffc94a, 1.5);
            this.pulseLight(0xffc94a, 2);
          } else if (tier === 5) {
            for (let s = 0; s < 10; s++) P.emit(px + (Math.random() - 0.5), 0.3, py + (Math.random() - 0.5), 0, 2 + Math.random() * 2, 0, 0xff6a8a, 1.6, 0.35, 0.7, 0, 0.5);
          } else {
            // combo: pickups within 0.6 s climb (the audio arpeggio climbs with the same rule)
            this.gemCombo = this.time - this.gemAt < 0.6 ? this.gemCombo + 1 : 0;
            this.gemAt = this.time;
            const heat = Math.min(1, this.gemCombo / 14);
            this.actors.gemHeat = Math.max(this.actors.gemHeat, heat);
            this.actors.gemPulse = Math.min(1.5, this.actors.gemPulse + 0.25 + tier * 0.1);
            if (sparks > 0) {
              sparks--;
              const gc = heat < 0.5 ? mixHex(0xffd27a, 0xfff6e0, heat * 2) : mixHex(0xfff6e0, 0x9af0ff, (heat - 0.5) * 2);
              this.flashes.add(this.actors.lanternX, this.actors.lanternH, this.actors.lanternY, 1.0 + heat * 0.6, 0.2, 0.14, gc, 0.9);
              P.emit(this.actors.lanternX, this.actors.lanternH, this.actors.lanternY, (Math.random() - 0.5) * 1.5, 2 + Math.random() * 2, (Math.random() - 0.5) * 1.5, gc, 1.5, 0.22, 0.45, -3, 1);
            }
          }
          break;
        }
        case EV.LEVEL_UP:
          this.rings.add(px, py, 0.4, 4, 0.7, 0xffd27a, 1.6, 0.35);
          for (let s = 0; s < 30; s++) {
            const a = Math.random() * TAU;
            P.emit(px + Math.cos(a) * 0.8, 0.2, py + Math.sin(a) * 0.8, Math.cos(a) * 0.5, 3 + Math.random() * 4, Math.sin(a) * 0.5, s % 3 ? 0xffd27a : 0xffffff, 1.8, 0.4, 0.9, -1, 0.5);
          }
          this.pulseLight(0xffd27a, 1.5);
          break;
        case EV.FUSION: {
          this.fusionT = 0;
          this.fusionRelease = -1;
          this.fusionActive = true;
          const sp = SPELLS[E.a[i]];
          this.fusionCol = sp ? FX_COLORS[sp.fx] ?? 0xfff0c0 : 0xfff0c0;
          this.pulseLight(this.fusionCol, 1.5);
          // the delver lifts the lantern: a column of light and a ring snapping inward
          this.rings.add(px, py, 7, 0.4, 0.5, this.fusionCol, 1.6, 0.2);
          break;
        }
        case EV.BOSS_SPAWN: {
          const bd = BOSSES[E.b[i]];
          this.bossCol = bd ? bd.color : 0xff4a3a;
          this.bossT = 0;
          this.bossX = x;
          this.bossY = y;
          this.bossLanded = false;
          // the floor cracks open: a warning ring, dust, a rumble
          this.rings.add(x, y, 0.5, 6, 1.0, 0xff4a3a, 1.4, 0.15);
          this.rings.add(x, y, 8, 1, 0.8, this.bossCol, 1.2, 0.12);
          P.burst(x, 0.3, y, 50, 6, 7, 0x9a8070, 1.1, 0.7, 1.2);
          this.addShake(0.55);
          this.pulseLight(this.bossCol, 2);
          break;
        }
        case EV.BOSS_KILL:
          this.flashes.add(x, 1.5, y, 10, 2, 0.6, 0xfff0d0, 1.4);
          break;
        case EV.BURST_HIT:
          if (E.b[i] === 1) {
            this.rings.add(px, py, 0.3, 2, 0.35, 0x7fe0ff, 1.5, 0.3);
            for (let s = 0; s < 6; s++) this.flashes.add(px + (Math.random() - 0.5) * 1.5, 0.8 + Math.random(), py + (Math.random() - 0.5) * 1.5, 0.6, 0.2, 0.3, 0xbff4ff, 1.4);
          } else {
            P.burst(px, 0.8, py, 16, 5, 4, 0xff3a3a, 1.6, 0.4, 0.5);
          }
          break;
        case EV.PLAYER_HURT: {
          const frac = v / Math.max(1, w.player.maxHp);
          this.hurt = Math.min(1, this.hurt + 0.25 + frac * 4);
          if (frac > 0.04) this.addShake(0.15 + frac * 2);
          break;
        }
        case EV.HEAL:
          for (let s = 0; s < 3; s++) P.emit(px + (Math.random() - 0.5) * 0.8, 0.4, py + (Math.random() - 0.5) * 0.8, 0, 1.8, 0, 0x7aff9a, 1.3, 0.3, 0.8, 0, 0.5);
          break;
        case EV.DASH: {
          const a = (E.a[i] / 64) * TAU;
          const ex = x + Math.cos(a) * 3, ey = y + Math.sin(a) * 3;
          for (let s = -1; s <= 1; s++) {
            const ox = -Math.sin(a) * s * 0.25, oy = Math.cos(a) * s * 0.25;
            this.beams.add(x + ox, y + oy, ex + ox, ey + oy, 0.5 + Math.abs(s) * 0.2, 0.35, 0.3, 0x9ac8ff, 0.8);
          }
          this.rings.add(x, y, 0.2, 1.4, 0.3, 0x9ac8ff, 1, 0.3);
          break;
        }
        case EV.CORE_ENTER:
          this.addShake(0.5);
          this.rings.add(px, py, 1, 22, 1.6, 0xff6a20, 1.2, 0.08);
          this.rings.add(px, py, 1, 14, 1.1, 0xffd0a0, 1.4, 0.12);
          P.burst(px, 0.2, py, 90, 9, 8, 0xff6a20, 1.8, 0.4, 1.4, -2);
          this.flashCol(0xff5a1a, this.opts.reducedMotion ? 0.12 : 0.35);
          break;
        case EV.WYRMFALL:
          if (E.a[i] === 0) {
            // the maw cracks open: the ground groans, the light drains toward it
            this.mawT = 0;
            this.addShake(0.6);
            this.rings.add(x, y, 1, 8, 1.4, 0xff6a20, 1.6, 0.15);
            P.burst(x, 0.3, y, 80, 8, 10, 0x9a7a6a, 1.2, 0.8, 1.5);
            this.pulseLight(0xff6a20, 3);
          } else {
            // the head breaks through: white-orange flash, a huge shock ring, rock spray
            this.headT = 0;
            this.addShake(1);
            this.punch = this.opts.reducedMotion ? 0 : 1;
            this.flashCol(0xffa040, this.opts.reducedMotion ? 0.15 : 0.5);
            this.rings.add(x, y, 1, 16, 1.6, 0xff6a20, 2, 0.1);
            this.rings.add(x, y, 1, 9, 1.0, 0xffe0a0, 1.6, 0.2);
            P.burst(x, 0.3, y, 140, 12, 14, 0x9a7a6a, 1.2, 0.9, 1.8);
            P.burst(x, 0.5, y, 80, 9, 12, 0xff7a2a, 2, 0.5, 1.4, -6);
            this.pulseLight(0xff6a20, 5);
          }
          break;
        case EV.STAGGER:
          this.actors.onStagger();
          this.rings.add(x, y, 0.5, 4, 0.5, 0xffe040, 1.6, 0.3);
          this.flashes.add(this.actors.wyrmMouthX, this.actors.wyrmMouthH, this.actors.wyrmMouthY, 5, 1, 0.35, 0xffffff, 1.4);
          this.addShake(0.3);
          break;
        case EV.FORMATION:
          for (let s = 0; s < 40; s++) {
            const a = Math.random() * TAU, r = Math.random() * 10;
            P.emit(x + Math.cos(a) * r, 0.2, y + Math.sin(a) * r, 0, 2 + Math.random() * 2, 0, 0xb070ff, 1.5, 0.4, 0.9, 0, 0.5);
          }
          break;
        case EV.CAST: {
          if (casts-- <= 0) break;
          const si = E.b[i];
          const col = si >= 0 && si < SPELLS.length ? FX_COLORS[SPELLS[si].fx] ?? 0xffffff : 0xffffff;
          const rk = rankK(w, E.a[i]);
          this.flashes.add(x, 0.8, y, 1.1 * (1 + 0.5 * rk), 0.3, 0.12 + 0.04 * rk, col, 0.8 + 0.4 * rk);
          if (rk >= 1) this.flashes.add(this.actors.lanternX, this.actors.lanternH, this.actors.lanternY, 1.4, 0.3, 0.12, mixHex(col, 0xffffff, 0.5), 0.6);
          break;
        }
        case EV.DEATH:
          this.deathT = 0;
          P.burst(px, 0.8, py, 70, 7, 8, 0x8fb8ff, 1.8, 0.6, 1.3);
          P.burst(px, 0.8, py, 30, 4, 6, 0xffc070, 2, 0.5, 1.0);
          this.rings.add(px, py, 0.4, 6, 1, 0xffc070, 1.4);
          this.addShake(0.7);
          break;
        case EV.CHEST:
          if (E.a[i] === 0) {
            this.rings.add(x, y, 0.4, 3, 0.8, 0xffc94a, 1.5);
            for (let s = 0; s < 8; s++) this.flashes.add(x, s * 0.9, y, 1.6, 0.5, 0.6, 0xffd27a, 1.2);
          }
          break;
      }
    }
    E.n = 0;
  }

  private flashCol(hex: number, k: number): void {
    if (k > this.flash) (this.post.overlay.uniforms.uFlashCol.value as THREE.Color).setHex(hex);
    this.flash = Math.max(this.flash, k);
  }

  private pulseLight(hex: number, k: number): void {
    this.fxLightCol = hex;
    this.fxLightK = Math.max(this.fxLightK, k);
  }

  /** The fusion shockwave: the biggest moment in a run. */
  private fusionWave(x: number, y: number, r: number): void {
    const R = Math.max(4, r);
    const fc = this.fusionCol;
    // three shock fronts (white, the fusion's colour, gold), a hot core and a slower outer halo
    this.rings.add(x, y, 0.5, R * 1.35, 1.2, 0xffffff, 3, 0.1);
    this.rings.add(x, y, 0.5, R * 1.1, 0.9, fc, 2.6, 0.35);
    this.rings.add(x, y, 0.3, R * 0.7, 0.6, 0xffd27a, 2.2, 0.5);
    this.rings.add(x, y, 0.5, R * 2.2, 2.0, fc, 1.2, 0.06);
    this.flashes.add(x, 1, y, R * 1.6, R * 0.5, 0.6, mixHex(fc, 0xffffff, 0.5), 1.4);
    // light rays fan out across the floor
    for (let s = 0; s < 18; s++) {
      const a = (s / 18) * TAU + Math.random() * 0.2;
      const L = R * (1.1 + Math.random() * 0.6);
      this.beams.add(x, y, x + Math.cos(a) * L, y + Math.sin(a) * L, 0.3, 0.5 + Math.random() * 0.5, 0.55, s % 2 ? fc : 0xffffff, 1.2);
    }
    const P = this.particles;
    for (let s = 0; s < 160; s++) {
      const a = (s / 160) * TAU;
      const sp = 9 + Math.random() * 8;
      P.emit(x, 0.5, y, Math.cos(a) * sp, 1 + Math.random() * 3, Math.sin(a) * sp, s % 3 === 0 ? fc : s % 2 ? 0xffd27a : 0xfff4e0, 2.4, 0.6, 0.9, -4, 1.6);
    }
    P.burst(x, 1, y, 70, 3, 16, mixHex(fc, 0xffe0a0, 0.5), 2.2, 0.55, 1.5, -6);
    // every critter on screen flashes white with the hit
    this.actors.globalFlash = 1;
    this.flashCol(mixHex(fc, 0xffffff, 0.55), this.opts.reducedMotion ? 0.2 : 0.7);
    this.punch = this.opts.reducedMotion ? 0 : 1;
    this.addShake(1);
    this.pulseLight(fc, 6);
    if (this.fusionT < 0) this.fusionT = 0.3;
    this.fusionRelease = 0;
  }

  // -------------------------------------------------------------------------------------------
  /** Timed set pieces that outlive one event: boss intros, the fusion charge-up, the Wyrm's arrival. */
  private moments(w: World, dt: number): void {
    const P = this.particles;
    const px = this.interpPX, py = this.interpPY;
    // boss intro: it bursts out of the floor ~1 s after the spawn event
    if (this.bossT >= 0) {
      this.bossT += dt;
      if (!this.bossLanded && this.bossT >= 0.95) {
        this.bossLanded = true;
        const bx = this.bossX, by = this.bossY;
        this.rings.add(bx, by, 0.5, 7, 0.7, 0xffffff, 1.6, 0.12);
        this.rings.add(bx, by, 0.5, 11, 1.1, this.bossCol, 1.6, 0.2);
        P.burst(bx, 0.3, by, 70, 9, 9, 0x9a8070, 1.2, 0.8, 1.3);
        P.burst(bx, 0.6, by, 40, 6, 8, this.bossCol, 2, 0.45, 0.9, -8);
        this.addShake(0.75);
        this.flashCol(this.bossCol, this.opts.reducedMotion ? 0.08 : 0.22);
        this.pulseLight(this.bossCol, 4);
      }
      if (this.bossT > 2.6) this.bossT = -1;
    }
    // fusion charge-up while the reel spins: light spirals in, rings snap inward, a pillar of light rises
    if (this.fusionT >= 0 && this.fusionRelease < 0) {
      const fc = this.fusionCol;
      const k = clamp01(this.fusionT / 1.4);
      this.fusionSpawn += dt * (60 + 140 * k) * this.particles.scale;
      while (this.fusionSpawn >= 1) {
        this.fusionSpawn -= 1;
        const a = Math.random() * TAU, r = 3.5 + Math.random() * 4;
        const sx = px + Math.cos(a) * r, sy = py + Math.sin(a) * r;
        const tx = -Math.sin(a), ty = Math.cos(a);
        const life = 0.45 + Math.random() * 0.2;
        const sp = r / life;
        P.emit(sx, 0.3 + Math.random() * 2.2, sy, -Math.cos(a) * sp + tx * 3, 0.5, -Math.sin(a) * sp + ty * 3, Math.random() < 0.4 ? 0xffffff : fc, 1.8 + k, 0.3 + 0.2 * k, life, 0, 0);
      }
      const beat = Math.floor(this.fusionT / 0.32);
      if (beat !== Math.floor((this.fusionT - dt) / 0.32)) this.rings.add(px, py, 6 - k * 2, 0.5, 0.32, fc, 1.2 + k, 0.25);
      for (let s = 0; s < 6; s++) this.glows.add(px, 0.5 + s * 1.3, py, (1.6 - s * 0.18) * (0.6 + 0.6 * k), s % 2 ? fc : 0xffffff, (0.18 + 0.25 * k) * (1 - s * 0.12));
      this.glows.add(this.actors.lanternX, this.actors.lanternH, this.actors.lanternY, 1.5 + 2 * k, 0xffffff, 0.6 + 0.6 * k);
    }
    // the Wyrmfall: the maw opens at 11:52 and the head breaks through at 12:00
    const hz = w.hazard;
    if (this.mawT >= 0) {
      this.mawT += dt;
      if (!hz.mawOpen && !hz.wyrmActive) this.mawT = -1;
    } else if (hz.mawOpen && !hz.wyrmActive) this.mawT = 0; // joined mid-way (e.g. a new world)
    if (this.headT >= 0) this.headT += dt;
    if (!hz.wyrmActive) this.headT = -1;
    // the Core's heartbeat (sim time, so it holds still while paused and the audio thump can follow it)
    this.heart = w.layer >= 6 && !w.over ? coreHeartbeat(w.tick) : 0;
  }

  // -------------------------------------------------------------------------------------------
  private ambient(w: World, dt: number): void {
    const L = this.look;
    const core = w.layer >= 6;
    const coreMin = core ? Math.max(0, w.tick / 3600 - 5) : 0;
    const rate = (core ? 34 + Math.min(40, coreMin * 6) : L.moteKind === 4 ? 26 : 14) * dt * this.particles.scale;
    const P = this.particles;
    for (let s = 0; s < rate || Math.random() < rate - s; s++) {
      if (s > 8) break;
      const x = this.camX + (Math.random() - 0.5) * 34;
      const y = -this.camZ + (Math.random() - 0.5) * 26;
      switch (L.moteKind) {
        case 0:
          P.emit(x, 0.5 + Math.random() * 4, y, (Math.random() - 0.5) * 0.3, 0.1, (Math.random() - 0.5) * 0.3, L.mote, 0.35, 0.18, 4, 0, 0);
          break;
        case 1:
          P.emit(x, 0.2 + Math.random() * 2, y, (Math.random() - 0.5) * 0.4, 0.4, (Math.random() - 0.5) * 0.4, Math.random() < 0.5 ? L.mote : L.prop2, 0.9, 0.2, 4, 0, 0);
          break;
        case 2:
          P.emit(x, 6 + Math.random() * 3, y, 0, -6, 0, L.mote, 0.5, 0.12, 1.2, -6, 0);
          break;
        case 3:
          P.emit(x, 0.3 + Math.random() * 3, y, 0, 0.15, 0, Math.random() < 0.5 ? L.mote : 0xffffff, 1.2, 0.16, 1.6, 0, 0);
          break;
        default:
          P.emit(x, 0.1, y, (Math.random() - 0.5) * 0.6, 1.5 + Math.random() * 2, (Math.random() - 0.5) * 0.6, Math.random() < 0.6 ? 0xff6a20 : 0xffb040, 1.4, 0.16, 2.6, 0.3, 0);
      }
    }
    // the Wyrm maw rumbles before the head breaks through
    const hz = w.hazard;
    if (hz && hz.mawOpen && !hz.wyrmActive) {
      if (Math.random() < 0.6) {
        const a = Math.random() * TAU, r = Math.random() * hz.mawR;
        P.emit(hz.mawX + Math.cos(a) * r, 0.1, hz.mawY + Math.sin(a) * r, 0, 2 + Math.random() * 3, 0, Math.random() < 0.5 ? 0xff6a20 : 0x9a7a6a, 1.5, 0.45, 1, -2, 0);
      }
      if (this.shakeOn) this.shake = Math.max(this.shake, 0.12 + 0.2 * clamp01(this.mawT / 8));
      // grit rains from the ceiling around the delver, harder as the head nears
      if (Math.random() < 0.3 + 0.5 * clamp01(this.mawT / 8)) {
        const gx = this.interpPX + (Math.random() - 0.5) * 18, gy = this.interpPY + (Math.random() - 0.5) * 14;
        P.emit(gx, 9 + Math.random() * 3, gy, 0, -3, 0, 0x8a7060, 0.9, 0.28, 1.6, -14, 0);
      }
    }
    // Core heat: sparks spit up from the floor in short jets as the pressure climbs
    if (core && Math.random() < dt * (1.5 + coreMin * 0.6) * this.particles.scale) {
      const jx = this.camX + (Math.random() - 0.5) * 26, jy = -this.camZ + (Math.random() - 0.5) * 18;
      for (let s = 0; s < 10; s++) P.emit(jx, 0.05, jy, (Math.random() - 0.5) * 1.2, 4 + Math.random() * 4, (Math.random() - 0.5) * 1.2, Math.random() < 0.5 ? 0xff7a2a : 0xffc060, 1.8, 0.22, 0.9, -6, 0.5);
    }
  }

  private updateLights(w: World, dt: number): void {
    const L = this.lantern;
    const flick = 1 + Math.sin(this.time * 11.3) * 0.04 + Math.sin(this.time * 23.7) * 0.03;
    const core = w.layer >= 6;
    const dark = w.over ? clamp01(1 - (this.deathT < 0 ? 0 : this.deathT)) : 1;
    L.intensity = (core ? 10 : 12) * flick * dark;
    L.distance = core ? 16 : 19;
    L.position.set(this.actors.lanternX, this.actors.lanternH + 2.6, -this.actors.lanternY);
    this.fxLightK = Math.max(0, this.fxLightK - dt * 3);
    let k = this.fxLightK * 8;
    let col = this.fxLightCol;
    let fx = this.interpPX, fy = this.interpPY, fh = 3;
    if (this.actors.wyrmVisible) {
      const b = Math.min(1.5, 0.3 + w.hazard.breathPerSec * 20);
      if (k < b * 6) {
        // breath glow spills onto the arena floor in front of the maw (not onto the skull)
        k = b * 6;
        col = 0xff5a1a;
        fx = this.actors.wyrmMouthX + (this.interpPX - this.actors.wyrmMouthX) * 0.3;
        fy = this.actors.wyrmMouthY + (this.interpPY - this.actors.wyrmMouthY) * 0.3;
        fh = 1.2;
      }
    }
    this.fxLight.intensity = k;
    this.fxLight.color.setHex(col);
    this.fxLight.position.set(fx, fh, -fy);
    if (this.deathT >= 0) this.deathT += dt;
  }

  private updateCamera(w: World, dt: number): void {
    const p = w.player;
    const ahead = this.opts.reducedMotion ? 0.18 : 0.32;
    this.lookX += (p.vx * ahead - this.lookX) * damp(2.5, dt);
    this.lookY += (p.vy * ahead - this.lookY) * damp(2.5, dt);
    let tx = this.interpPX + this.lookX;
    let ty = this.interpPY + this.lookY;
    // the Wyrm (and the open maw before it): ease the camera back and toward it so the head and the delver
    // share the frame. The farther apart they are, the more it pulls back; a maw on the near (screen-bottom)
    // side needs a stronger bias because the near half of the frustum covers less floor.
    const hz = w.hazard;
    const wyrmOn = this.actors.wyrmVisible || (hz.mawOpen && this.mawT >= 0);
    this.wyrmFrame += ((wyrmOn ? 1 : 0) - this.wyrmFrame) * damp(this.actors.wyrmVisible ? 1.6 : 0.8, dt);
    let wyrmPull = 0;
    this.wyrmNear = 0;
    if (this.wyrmFrame > 0.001) {
      const mx = this.actors.wyrmVisible ? this.actors.wyrmMouthX : hz.mawX;
      const my = this.actors.wyrmVisible ? this.actors.wyrmMouthY : hz.mawY;
      const dx = mx - tx, dy = my - ty;
      const sep = Math.sqrt(dx * dx + dy * dy);
      const near = clamp01(-dy / 12); // maw below the delver on screen
      // QA: keep the delver in the central part of the frame (it got lost at the screen edge in the crowd), so the
      // lean toward the maw is capped at ~3 m and the pull-back at +26%; the HUD arrow points at an off-screen ring
      const b = (0.2 + 0.06 * near) * clamp01(sep / 6) * this.wyrmFrame;
      let ox = dx * b, oy = dy * b;
      const ol = Math.sqrt(ox * ox + oy * oy);
      if (ol > 3) {
        ox *= 3 / ol;
        oy *= 3 / ol;
      }
      tx += ox;
      ty += oy;
      wyrmPull = this.wyrmFrame * Math.min(0.26, 0.1 + 0.22 * clamp01((sep - 6) / 16) + 0.06 * near);
      // head on the camera side: tip the camera toward top-down so the skull does not hide the delver
      if (this.actors.wyrmVisible) this.wyrmNear = this.wyrmFrame * clamp01(sep > 0.5 ? (-dy / sep - 0.1) / 0.6 : 0);
    }
    // boss intro: lean toward the boss as it bursts out, then settle back on the delver
    let bossPush = 0;
    if (this.bossT >= 0) {
      const t = this.bossT;
      bossPush = t < 0.35 ? easeInOut(t / 0.35) : t < 1.6 ? 1 : 1 - easeInOut((t - 1.6) / 1.0);
      const near = clamp01((ty - this.bossY) / 10); // a boss on the near (screen-bottom) side needs more lean
      const b = (this.opts.reducedMotion ? 0.25 : 0.38 + 0.17 * near) * clamp01(bossPush);
      tx += (this.bossX - tx) * b;
      ty += (this.bossY - ty) * b;
    }
    const k = damp(7, dt);
    this.camX += (tx - this.camX) * k;
    this.camZ += (-ty - this.camZ) * k;
    // shake: trauma squared, smooth noise; disabled with reduced motion
    let sx = 0, sz = 0, sy = 0;
    if (this.shake > 0 && this.shakeOn) {
      const tr = this.shake * this.shake;
      const t = this.time * 38;
      sx = (Math.sin(t * 1.13) + Math.sin(t * 2.71) * 0.5) * tr * 0.45;
      sz = (Math.sin(t * 1.37 + 1) + Math.sin(t * 3.11) * 0.5) * tr * 0.45;
      sy = Math.sin(t * 1.9 + 2) * tr * 0.3;
    }
    this.shake = Math.max(0, this.shake - dt * 1.8);
    this.punch = Math.max(0, this.punch - dt * 2.5);
    const fusionZoom = this.fusionT >= 0 && !this.opts.reducedMotion ? clamp01(this.fusionT / 0.6) * (this.fusionRelease >= 0 ? clamp01(1 - this.fusionRelease / 0.4) : 1) * 0.14 : 0;
    const bossZoom = this.opts.reducedMotion ? 0 : clamp01(bossPush) * 0.12;
    const heartZoom = this.opts.reducedMotion ? 0 : this.heart * 0.012;
    const dist = this.camDist * (1 + wyrmPull) * (1 - fusionZoom - bossZoom - heartZoom + this.punch * 0.06) * (this.trans >= 0 ? 1 + Math.sin((this.trans / 1.4) * Math.PI) * 0.1 : 1);
    this.wyrmNearS += (this.wyrmNear - this.wyrmNearS) * damp(2, dt);
    const pitch = THREE.MathUtils.degToRad(52 + 20 * this.wyrmNearS);
    const H = Math.sin(pitch) * dist;
    const D = Math.cos(pitch) * dist;
    this.camera.position.set(this.camX + sx, H + sy, this.camZ + D + sz);
    this.camera.lookAt(this.camX + sx * 0.5, 0, this.camZ + sz * 0.5 - 0.6);
  }

  private updateOverlay(w: World, dt: number): void {
    const u = this.post.overlay.uniforms;
    const core = w.layer >= 6;
    // the Core squeezes in on every heartbeat
    // (QA: a strong red-ish Core edge competed with "red = move"; keep it lighter)
    u.uVignette.value = (core ? 0.62 : 0.58) + this.heart * 0.08;
    this.post.grade.uniforms.uPump.value = core ? 0.25 + this.heart * 0.75 : 0;
    // layer descent: the lantern gutters out and back
    let dark = 0;
    // boss intro: the cave dims around the delver until the boss lands
    if (this.bossT >= 0 && this.bossT < 1.4) dark = Math.max(dark, Math.sin(clamp01(this.bossT / 1.4) * Math.PI) * 0.32);
    // the maw is open: the light drains out of the cave toward the head's arrival
    if (this.mawT >= 0) dark = Math.max(dark, clamp01(this.mawT / 7) * (w.hazard.wyrmActive ? 0.14 : 0.32) * (0.85 + 0.15 * Math.sin(this.time * 6)));
    if (this.headT >= 0) dark = Math.max(dark, 0.38 * (1 - clamp01(this.headT / 1.5)));
    if (this.trans >= 0) dark = Math.sin((this.trans / 1.4) * Math.PI) * 0.92;
    // fusion moment: darken around the delver, hold, then release after the shockwave
    if (this.fusionT >= 0) {
      // ramp in, hold while the UI reel spins (the sim is held too), release after the shockwave
      this.fusionT += dt;
      if (this.fusionRelease < 0 && this.fusionT > 4) this.fusionRelease = 0;
      let d = clamp01(this.fusionT / 0.25);
      if (this.fusionRelease >= 0) {
        this.fusionRelease += dt;
        // snap the lights back fast so the shockwave reads at full brightness
        d = Math.min(d, 1 - this.fusionRelease / 0.35);
      }
      dark = Math.max(dark, clamp01(d) * 0.78);
      if (this.fusionRelease > 0.9) {
        this.fusionT = -1;
        this.fusionRelease = -1;
        this.fusionActive = false;
      }
    }
    if (this.deathT >= 0) dark = Math.max(dark, clamp01(this.deathT / 2.5) * 0.6);
    u.uDark.value = dark;
    // spotlight follows the delver in screen space
    const v = this.tmpV.set(this.interpPX, 0.8, -this.interpPY).project(this.camera);
    (u.uSpot.value as THREE.Vector2).set(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5);
    (this.post.grade.uniforms.uSpot.value as THREE.Vector2).set(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5);
    this.hurt = Math.max(0, this.hurt - dt * 2.2);
    u.uHurt.value = this.hurt * (this.opts.reducedMotion ? 0.5 : 1);
    this.flash = Math.max(0, this.flash - dt * 2.5);
    u.uFlash.value = this.flash;
    const hz = w.hazard;
    u.uBreath.value = hz && hz.wyrmActive ? Math.min(0.6, 0.15 + hz.breathPerSec * 12) : this.mawT >= 0 ? clamp01(this.mawT / 8) * 0.3 * (0.5 + 0.5 * Math.sin(this.time * 3)) : 0;
  }
}

function easeInOut(t: number): number {
  const u = clamp01(t);
  return u * u * (3 - 2 * u);
}
