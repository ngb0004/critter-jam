/**
 * Dev-only tools (RENDER), active only with `?debug` in the URL:
 *  - a small FPS / frame-time / draw-call readout in the corner;
 *  - a render stress rig: `window.__delveStress(true)` makes the renderer draw a PRIVATE throwaway World
 *    kept at ~400 enemies, ~300 projectiles and ~500 gems (plus zones and telegraphs). The rig steps and
 *    tops up its own world; the live run is never touched (presentation still never writes the game World).
 *    `window.__delveStress(false)` returns to the live world. `window.__delveRender.stats()` returns numbers.
 */
import { seedForDay } from '../core/daily';
import { encodeInput } from '../core/input';
import { CH_PICK, EF, TG_COLOR, TG_SHAPE } from '../core/types';
import { createWorld, choose, step, type World } from '../core/world';
import { buildModifiers } from '../content/omens';
import { SPELLS } from '../content/spells';
import { spawnEnemy } from '../sim/enemies';
import { spawnProjectile } from '../sim/projectiles';
import { dropGem } from '../sim/xp';
import { spawnZone } from '../sim/zones';
import { addTelegraph } from '../sim/hazards';

export const DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');

export class DebugHud {
  readonly el: HTMLDivElement;
  private acc = 0;
  private frames = 0;
  private worst = 0;
  constructor() {
    this.el = document.createElement('div');
    this.el.style.cssText =
      'position:fixed;left:6px;bottom:6px;z-index:9999;font:11px/1.35 ui-monospace,monospace;color:#cfe;background:rgba(0,0,0,.55);padding:4px 6px;border-radius:4px;pointer-events:none;white-space:pre';
    document.body.appendChild(this.el);
  }
  frame(dt: number, text: () => string): void {
    this.acc += dt;
    this.frames++;
    this.worst = Math.max(this.worst, dt);
    if (this.acc >= 0.5) {
      this.el.textContent = `${(this.frames / this.acc).toFixed(0)} fps  worst ${(this.worst * 1000).toFixed(1)} ms\n${text()}`;
      this.acc = 0;
      this.frames = 0;
      this.worst = 0;
    }
  }
}

const SPELL_IDS = ['firebolt', 'rotNeedles', 'shivFan', 'shadeBolt', 'magmaOrbs', 'sunSpear'];

/** Builds and maintains a crowded private world for render perf checks. */
export class StressRig {
  w: World;
  private dir = 0;
  readonly target = { enemies: 400, projectiles: 300, gems: 500 };

  constructor() {
    this.w = this.fresh();
  }

  private fresh(): World {
    const seed = seedForDay(312);
    const w = createWorld(seed, 'ember', buildModifiers('', ''));
    w.player.maxHp = 1e9;
    w.player.hp = 1e9;
    return w;
  }

  update(): World {
    let w = this.w;
    if (w.over) w = this.w = this.fresh();
    // keep it alive and unpaused
    w.player.hp = w.player.maxHp;
    while (w.offer.open) if (!choose(w, CH_PICK)) break;
    this.dir = (this.dir + 0.004) % 1;
    const a = this.dir * Math.PI * 2;
    step(w, encodeInput(Math.cos(a), Math.sin(a), false));
    const px = w.player.x, py = w.player.y;
    // top up enemies in a ring around the player
    let guard = 0;
    while (w.en.count < this.target.enemies && guard++ < 60) {
      const t = Math.random() * Math.PI * 2;
      const r = 3 + Math.random() * 11;
      const def = [0, 1, 2, 3, 4, 7][Math.floor(Math.random() * 6)];
      const s = spawnEnemy(w, def, px + Math.cos(t) * r, py + Math.sin(t) * r, Math.random() < 0.05 ? EF.FORMATION : 0);
      if (s >= 0) {
        w.en.hp[s] = w.en.maxHp[s] = 1e7;
        if (Math.random() < 0.3) w.en.stStacks[s * 6 + Math.floor(Math.random() * 5)] = 1;
      }
    }
    guard = 0;
    while (w.pr.count < this.target.projectiles && guard++ < 60) {
      const id = SPELL_IDS[Math.floor(Math.random() * SPELL_IDS.length)];
      const si = SPELLS.findIndex((s) => s.id === id);
      const t = Math.random() * Math.PI * 2;
      spawnProjectile(w, si, 0, px, py, Math.cos(t) * 9, Math.sin(t) * 9, 0.2, 0, 90, 999, 0, 0);
    }
    guard = 0;
    while (w.gm.count < this.target.gems && guard++ < 80) {
      dropGem(w, px + (Math.random() - 0.5) * 30, py + (Math.random() - 0.5) * 30, 1 + Math.floor(Math.random() * 6));
    }
    if (w.zn.count < 10) {
      const si = SPELLS.findIndex((s) => s.id === 'bileFlask');
      spawnZone(w, si, 0, px + (Math.random() - 0.5) * 14, py + (Math.random() - 0.5) * 14, 2.2, 0, 240, 30, false);
    }
    if (w.tg.count < 6) {
      const t = Math.random() * Math.PI * 2;
      addTelegraph(w, TG_SHAPE.CIRCLE, TG_COLOR.RED, px + Math.cos(t) * 6, py + Math.sin(t) * 6, 2.5, 1.2, 0, 0, -1);
    }
    return w;
  }
}
