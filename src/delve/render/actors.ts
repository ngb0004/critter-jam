/**
 * Everything that moves (RENDER): critters (one InstancedMesh per EnemyDef.mesh), bosses (one mesh per
 * BossDef), the Wyrm's head, the delver and lantern, gems / chests / heal orbs, projectiles, summons,
 * player zones, telegraph decals, falling Wyrmfall rocks and blob shadows.
 *
 * Reads the World only. Positions are interpolated between the last two sim ticks (alpha in [0, 1]).
 */
import * as THREE from 'three';
import { EF, SRC, ST, TGF, TG_COLOR, TG_SHAPE } from '../core/types';
import { WORLD } from '../core/constants';
import type { World } from '../core/world';
import { BOSSES } from '../content/bosses';
import { ENEMIES } from '../content/enemies';
import { SPELLS } from '../content/spells';
import { addInst, telegraphMaterial, toyMaterial, zoneMaterial } from './materials';
import {
  batGeo, beetleGeo, bossGeos, boulderGeo, chestGeo, clumpGeo, delverGeo, eliteGeo, floorQuad, gemGeo, golemGeo,
  healGeo, lanternGeo, shroomGeo, slimeGeo, wyrmJawGeo, wyrmSegGeo, wyrmSkullGeo,
} from './geo';
import type { Particles, SpriteBatch } from './fx';
import { FX_COLORS, FX_ID, Interp, STATUS_COLORS, TAU, clamp01, damp, hash01, mixHex, writeHex, writeTRS } from './util';

const MESH_KINDS = ['bat', 'slime', 'beetle', 'shroom', 'golem', 'clump', 'elite'] as const;
type MeshKind = (typeof MESH_KINDS)[number];
/** Per mesh kind: scale relative to en.r, bend frequency, hover height (m). */
const KIND_INFO: Record<MeshKind, { scale: number; freq: number; hover: number }> = {
  bat: { scale: 1.55, freq: 17, hover: 0.95 },
  slime: { scale: 1.0, freq: 0, hover: 0 },
  beetle: { scale: 1.05, freq: 15, hover: 0 },
  shroom: { scale: 1.0, freq: 8, hover: 0 },
  golem: { scale: 0.95, freq: 4, hover: 0 },
  clump: { scale: 1.0, freq: 5, hover: 0 },
  elite: { scale: 1.0, freq: 4, hover: 0 },
};

interface Batch {
  mesh: THREE.InstancedMesh;
  inst: THREE.InstancedBufferAttribute;
  n: number;
}

function batch(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, parent: THREE.Object3D): Batch {
  const inst = addInst(geo, cap);
  const mesh = new THREE.InstancedMesh(geo, mat, cap);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  parent.add(mesh);
  return { mesh, inst, n: 0 };
}

function flush(b: Batch): void {
  b.mesh.count = b.n;
  b.mesh.visible = b.n > 0;
  b.mesh.instanceMatrix.needsUpdate = true;
  b.mesh.instanceColor!.needsUpdate = true;
  b.inst.needsUpdate = true;
}

/** Set aInst for instance i. */
function inst(b: Batch, i: number, phase: number, flash: number, bend: number, glow: number): void {
  const a = b.inst.array as Float32Array;
  a[i * 4] = phase;
  a[i * 4 + 1] = flash;
  a[i * 4 + 2] = bend;
  a[i * 4 + 3] = glow;
}

/** Floor decal batch with aA/aB per-instance vec4s (zones, telegraphs, shadows). */
class Decals {
  readonly mesh: THREE.InstancedMesh;
  readonly a: Float32Array;
  readonly b: Float32Array;
  readonly e: Float32Array;
  readonly c: Float32Array;
  private readonly aAttr: THREE.InstancedBufferAttribute;
  private readonly bAttr: THREE.InstancedBufferAttribute;
  n = 0;
  constructor(cap: number, mat: THREE.Material, order: number, parent: THREE.Object3D) {
    const g = floorQuad();
    this.aAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.bAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aA', this.aAttr);
    g.setAttribute('aB', this.bAttr);
    this.mesh = new THREE.InstancedMesh(g, mat, cap);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
    this.mesh.count = 0;
    this.a = this.aAttr.array as Float32Array;
    this.b = this.bAttr.array as Float32Array;
    this.e = this.mesh.instanceMatrix.array as Float32Array;
    this.c = this.mesh.instanceColor.array as Float32Array;
    parent.add(this.mesh);
  }
  flush(): void {
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
    this.aAttr.needsUpdate = true;
    this.bAttr.needsUpdate = true;
  }
}

function shadowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
attribute vec4 aA;
varying vec2 vUv;
varying float vK;
void main() { vUv = uv; vK = aA.x; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
varying vec2 vUv;
varying float vK;
void main() {
  float d = length(vUv * 2.0 - 1.0);
  float a = (1.0 - smoothstep(0.35, 1.0, d)) * vK;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
  #include <colorspace_fragment>
}`,
    transparent: true,
    depthWrite: false,
  });
}

/** Rank of the spell behind a source id as 0..1 (rank 1 -> 0, rank 5 -> 1); fusions count as rank 5. */
export function rankK(w: World, src: number): number {
  if (src === SRC.FUSION) return 1;
  if (src < 0 || src >= 6) return 0;
  const r = w.build.slotRank[src];
  return r <= 1 ? 0 : r >= 5 ? 1 : (r - 1) / 4;
}

/** Kill pops: the critter balloons flat and white for a few frames where it died. */
const POP_N = 128;
const POP_S = 8; // kind, x, y, yaw, r, hex, life, big
const POP_LIFE = 0.13;

/** Cheap "is this telegraph owned by a boss and winding up" lookup, rebuilt per frame. */
const ownerProg = new Float32Array(512);

export interface ActorFrame {
  w: World;
  alpha: number;
  dt: number;
  t: number; // presentation seconds
  px: number; // interpolated player position
  py: number;
  particles: Particles;
  glows: SpriteBatch;
  stars: SpriteBatch;
  reducedMotion: boolean;
}

export class Actors {
  readonly group = new THREE.Group();
  private readonly critters: Record<MeshKind, Batch>;
  private readonly kindOf: number[]; // ENEMIES idx -> MESH_KINDS idx
  private readonly bosses: Batch[];
  private readonly bossMat: THREE.MeshLambertMaterial;
  private readonly skull: Batch;
  private readonly jaw: Batch;
  private readonly neck: Batch;
  readonly delver: Batch;
  private readonly lantern: Batch;
  private readonly gems: Batch;
  private readonly chests: Batch;
  private readonly hearts: Batch;
  private readonly orbs: Batch;
  private readonly shards: Batch;
  private readonly boulders: Batch;
  private readonly zones: Decals;
  private readonly tgs: Decals;
  /** Rim-only copy of the telegraph decals, drawn without depth test so warnings show through critters and walls. */
  private readonly tgOver: THREE.InstancedMesh;
  private readonly shadows: Decals;
  private readonly floorGlow: THREE.Mesh;
  /** Non-drainable ground ring under the delver, drawn over everything (QA: lost in the Wyrmfall crowd). */
  private readonly youRing: THREE.Mesh;

  readonly enI = new Interp(512);
  readonly prI = new Interp(512);
  readonly gmI = new Interp(768);
  readonly alI = new Interp(32);
  private readonly yaw = new Float32Array(512);
  private readonly prYaw = new Float32Array(512);
  private readonly tgImpactUid = new Int32Array(96).fill(-1);

  // player presentation state
  private pYaw = Math.PI;
  private walk = 0;
  private sway = 0;
  private swayV = 0;
  private lastPvx = 0;
  private lastPvy = 0;
  lanternX = 0;
  lanternY = 0;
  lanternH = 1;
  // wyrm presentation
  private wyrmRecoil = 0;
  wyrmMouthX = 0;
  wyrmMouthY = 0;
  wyrmMouthH = 0;
  wyrmVisible = false;
  /** Telegraph impacts this frame (for camera shake / sound-free juice): count and nearest distance. */
  impacts = 0;
  impactNear = 99;
  /** 0..1 flash on every critter (the fusion shockwave); decays here. */
  globalFlash = 0;
  /** Lantern flare from gem pickups (0..1.5); decays here. */
  gemPulse = 0;
  /** Gem combo heat 0..1 (pickup trails go gold -> white -> cyan as a combo climbs). */
  gemHeat = 0;
  /** Presentation density 0.4..1 (the renderer lowers it with the quality level). */
  fxScale = 1;
  private readonly pops = new Float32Array(POP_N * POP_S);
  private popHead = 0;
  private readonly _m = new THREE.Matrix4();
  private readonly _m2 = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _e = new THREE.Euler();
  private readonly _v = new THREE.Vector3();
  private readonly _s = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    const g = this.group;
    const critterGeo: Record<MeshKind, () => THREE.BufferGeometry> = {
      bat: batGeo, slime: slimeGeo, beetle: beetleGeo, shroom: shroomGeo, golem: golemGeo, clump: clumpGeo, elite: eliteGeo,
    };
    this.critters = {} as Record<MeshKind, Batch>;
    for (const k of MESH_KINDS) {
      const cap = k === 'elite' ? 16 : k === 'clump' ? 128 : 512;
      this.critters[k] = batch(critterGeo[k](), toyMaterial(KIND_INFO[k].freq), cap, g);
    }
    this.kindOf = ENEMIES.map((d) => Math.max(0, MESH_KINDS.indexOf(d.mesh as MeshKind)));
    this.bossMat = toyMaterial(4, { rim: 1.3 });
    this.bosses = bossGeos().map((geo) => batch(geo, this.bossMat, 1, g));
    const wyrmMat = toyMaterial(0, { rim: 0.9 });
    this.skull = batch(wyrmSkullGeo(), wyrmMat, 1, g);
    this.jaw = batch(wyrmJawGeo(), wyrmMat, 1, g);
    this.neck = batch(wyrmSegGeo(), wyrmMat, 8, g);
    this.delver = batch(delverGeo(), toyMaterial(12, { rim: 1.2 }), 1, g);
    this.lantern = batch(lanternGeo(), toyMaterial(0), 1, g);
    const pickMat = toyMaterial(0, { rim: 0.4 });
    this.gems = batch(gemGeo(), pickMat, 768, g);
    this.chests = batch(chestGeo(), pickMat, 16, g);
    this.hearts = batch(healGeo(), pickMat, 32, g);
    this.orbs = batch(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicMaterial({ toneMapped: false }), 560, g);
    const shardGeo = new THREE.OctahedronGeometry(1, 0);
    shardGeo.scale(0.22, 0.16, 1);
    this.shards = batch(shardGeo, new THREE.MeshBasicMaterial({ toneMapped: false }), 512, g);
    this.orbs.mesh.renderOrder = 6;
    this.boulders = batch(boulderGeo(), toyMaterial(0, { rim: 0.8 }), 96, g);
    this.zones = new Decals(128, zoneMaterial(), 1, g);
    this.tgs = new Decals(96, telegraphMaterial(), 3, g);
    this.tgOver = new THREE.InstancedMesh(this.tgs.mesh.geometry, telegraphMaterial(true), 96);
    this.tgOver.instanceMatrix = this.tgs.mesh.instanceMatrix;
    this.tgOver.instanceColor = this.tgs.mesh.instanceColor;
    this.tgOver.frustumCulled = false;
    this.tgOver.renderOrder = 40;
    this.tgOver.count = 0;
    g.add(this.tgOver);
    this.shadows = new Decals(620, shadowMaterial(), 0, g);
    // warm pool of lantern light on the floor (reads even when real lighting is cheap)
    this.floorGlow = new THREE.Mesh(
      floorQuad(),
      new THREE.ShaderMaterial({
        uniforms: { uCol: { value: new THREE.Color(0xffc27a) }, uK: { value: 0.12 } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform vec3 uCol; uniform float uK; varying vec2 vUv; void main(){ float d = length(vUv*2.0-1.0); float a = pow(max(0.0, 1.0 - d), 1.8) * uK; gl_FragColor = vec4(uCol * a, 1.0);\n#include <colorspace_fragment>\n}',
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.floorGlow.renderOrder = -5;
    this.floorGlow.scale.set(7.5, 1, 7.5);
    this.floorGlow.position.y = 0.02;
    g.add(this.floorGlow);
    const rg = new THREE.RingGeometry(0.62, 0.76, 40);
    rg.rotateX(-Math.PI / 2);
    this.youRing = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: 0xfff1c8, transparent: true, opacity: 0.5, depthTest: false, depthWrite: false, toneMapped: false }));
    this.youRing.renderOrder = 41;
    this.youRing.position.y = 0.05;
    g.add(this.youRing);
    scene.add(g);
  }

  setLightColor(hex: number): void {
    ((this.floorGlow.material as THREE.ShaderMaterial).uniforms.uCol.value as THREE.Color).setHex(hex);
  }

  /** New sim tick(s): snapshot pools for interpolation. */
  snap(w: World): void {
    this.enI.snap(w.en.alive, w.en.uid, w.en.x, w.en.y, w.en.hi);
    this.prI.snap(w.pr.alive, w.pr.uid, w.pr.x, w.pr.y, w.pr.hi);
    this.gmI.snap(w.gm.alive, w.gm.uid, w.gm.x, w.gm.y, w.gm.hi);
    this.alI.snap(w.al.alive, w.al.uid, w.al.x, w.al.y, w.al.hi);
  }

  reset(): void {
    this.pops.fill(0);
    this.globalFlash = this.gemPulse = this.gemHeat = 0;
    this.enI.clear();
    this.prI.clear();
    this.gmI.clear();
    this.alI.clear();
    this.tgImpactUid.fill(-1);
  }

  /** A trash kill (from EV.KILL): pop the critter's mesh where it died. */
  pop(w: World, slot: number, def: number, flags: number, x: number, y: number): void {
    if (flags & (EF.BOSS | EF.WYRM)) return;
    const d = ENEMIES[def];
    if (!d) return;
    const o = this.popHead * POP_S;
    this.popHead = (this.popHead + 1) % POP_N;
    const P = this.pops;
    P[o] = this.kindOf[def] ?? 0;
    P[o + 1] = x;
    P[o + 2] = y;
    P[o + 3] = slot >= 0 && slot < 512 ? this.yaw[slot] : 0;
    P[o + 4] = slot >= 0 && slot < w.en.cap && w.en.r[slot] > 0 ? w.en.r[slot] : d.radius;
    P[o + 5] = d.color;
    P[o + 6] = POP_LIFE;
    P[o + 7] = flags & (EF.CLUMP | EF.ELITE) ? 1 : 0;
  }

  private drawPops(dt: number): void {
    const P = this.pops;
    for (let i = 0; i < POP_N; i++) {
      const o = i * POP_S;
      if (P[o + 6] <= 0) continue;
      P[o + 6] -= dt;
      if (P[o + 6] <= 0) continue;
      const kind = MESH_KINDS[P[o]] ?? 'slime';
      const b = this.critters[kind];
      if (b.n >= b.mesh.instanceMatrix.count) continue;
      const p = 1 - P[o + 6] / POP_LIFE;
      const s = P[o + 4] * KIND_INFO[kind].scale * (P[o + 7] ? 1.3 : 1);
      const sxz = s * (1 + 0.6 * p);
      const sy = s * Math.max(0.05, 1 - 0.85 * p * p);
      writeTRS(b.mesh.instanceMatrix.array as Float32Array, b.n, P[o + 1], KIND_INFO[kind].hover * (1 - p), -P[o + 2], P[o + 3], 0, 0, sxz, sy, sxz);
      writeHex(b.mesh.instanceColor!.array as Float32Array, b.n, mixHex(P[o + 5], 0xffffff, 0.6), 1);
      inst(b, b.n, 0, 1, 0, 0.6 * (1 - p));
      b.n++;
    }
  }

  private shadow(x: number, y: number, r: number, k: number): void {
    const s = this.shadows;
    if (s.n >= 620) return;
    writeTRS(s.e, s.n, x, 0.012, -y, 0, 0, 0, r, 1, r);
    s.a[s.n * 4] = k;
    s.n++;
  }

  update(f: ActorFrame): void {
    this.gemPulse = Math.max(0, this.gemPulse - f.dt * 3);
    this.gemHeat = Math.max(0, this.gemHeat - f.dt * 0.6);
    this.shadows.n = 0;
    this.impacts = 0;
    this.impactNear = 99;
    this.updatePlayer(f);
    this.updateTelegraphs(f);
    this.updateEnemies(f);
    this.updatePickups(f);
    this.updateProjectiles(f);
    this.updateZones(f);
    this.shadows.flush();
  }

  // -------------------------------------------------------------------------------------------
  private updatePlayer(f: ActorFrame): void {
    const { w, dt, t } = f;
    const p = w.player;
    const x = f.px, y = f.py;
    const spd = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    const sp = clamp01(spd / WORLD.playerSpeed);
    // facing: the sim's 64-way facing, smoothed
    const fa = (p.facing / 64) * TAU;
    const target = Math.atan2(Math.cos(fa), -Math.sin(fa)) ;
    let dy = target - this.pYaw;
    while (dy > Math.PI) dy -= TAU;
    while (dy < -Math.PI) dy += TAU;
    this.pYaw += dy * damp(14, dt);
    this.walk += dt * (4 + sp * 10);
    const dashing = p.dashTicks > 0;
    const bob = Math.abs(Math.sin(this.walk)) * 0.09 * sp;
    const pitch = dashing ? 0.45 : 0.14 * sp;
    const stretch = dashing ? 1.25 : 1;
    const dead = w.over;
    const hurt = p.hurtFlash > 0 ? ((p.hurtFlash >> 1) & 1 ? 0.55 : 0.15) : 0;
    const e = this.delver.mesh.instanceMatrix.array as Float32Array;
    const S = 1.25;
    writeTRS(e, 0, x, bob, -y, this.pYaw, pitch, Math.sin(this.walk) * 0.05 * sp, S / Math.sqrt(stretch), dead ? 0.0001 : S, S * stretch);
    this.delver.n = dead ? 0 : 1;
    inst(this.delver, 0, 0, hurt, sp, 0);
    writeHex(this.delver.mesh.instanceColor!.array as Float32Array, 0, hurt > 0.5 ? 0xff9090 : 0xffffff, 1);
    flush(this.delver);

    // lantern sways like a pendulum against acceleration
    const ax = (p.vx - this.lastPvx) / Math.max(dt, 1e-3);
    const ay = (p.vy - this.lastPvy) / Math.max(dt, 1e-3);
    this.lastPvx = p.vx;
    this.lastPvy = p.vy;
    // project acceleration onto the delver's forward axis (three yaw -> sim dir)
    const fwdX = Math.sin(this.pYaw), fwdY = -Math.cos(this.pYaw);
    const accF = ax * fwdX + ay * fwdY;
    this.swayV += (-this.sway * 60 - accF * 0.02 - this.swayV * 5) * dt;
    this.sway += this.swayV * dt;
    this.sway = Math.max(-0.7, Math.min(0.7, this.sway));
    this._m.compose(this._v.set(x, bob, -y), this._q.setFromEuler(this._e.set(pitch, this.pYaw, 0, 'YXZ')), this._s.set(S, S, S));
    this._m2.compose(this._v.set(0.36, 0.62, 0.24), this._q.setFromEuler(this._e.set(this.sway, 0, Math.sin(t * 2.1) * 0.06)), this._s.set(1.15, 1.15, 1.15));
    this._m.multiply(this._m2);
    this._m.toArray(this.lantern.mesh.instanceMatrix.array as Float32Array, 0);
    this.lantern.n = dead ? 0 : 1;
    inst(this.lantern, 0, 0, 0, 0, 0.3 + 0.15 * Math.sin(t * 13) * Math.sin(t * 7.3));
    writeHex(this.lantern.mesh.instanceColor!.array as Float32Array, 0, 0xffffff, 1);
    flush(this.lantern);
    this._v.set(0, -0.19, 0).applyMatrix4(this._m);
    this.lanternX = this._v.x;
    this.lanternY = -this._v.z;
    this.lanternH = this._v.y;
    this.floorGlow.position.x = x;
    this.floorGlow.position.z = -y;
    this.youRing.position.x = x;
    this.youRing.position.z = -y;
    this.youRing.visible = !dead;
    // brighter in the Core / Wyrmfall, where the crowd is thickest
    (this.youRing.material as THREE.MeshBasicMaterial).opacity = w.layer >= 6 ? 0.8 : 0.45;
    if (!dead) {
      this.shadow(x, y, 0.6, 0.5);
      const gp = Math.min(1.5, this.gemPulse);
      f.glows.add(this.lanternX, this.lanternH, this.lanternY, 0.75 * (1 + 0.35 * gp), 0xffc070, 0.9 + 0.4 * gp);
      f.glows.add(this.lanternX, this.lanternH, this.lanternY, 2.2 * (1 + 0.25 * gp), 0xff9a40, 0.14 + 0.1 * gp);
    }
    if (dashing && !f.reducedMotion) {
      f.particles.emit(x + (Math.random() - 0.5) * 0.4, 0.4 + Math.random() * 0.6, y + (Math.random() - 0.5) * 0.4, -p.vx * 0.1, 0.3, -p.vy * 0.1, 0x8fb8ff, 1.2, 0.5, 0.35, 0, 1);
    }
  }

  // -------------------------------------------------------------------------------------------
  private updateTelegraphs(f: ActorFrame): void {
    const { w, alpha } = f;
    const tg = w.tg;
    const d = this.tgs;
    d.n = 0;
    const B = this.boulders;
    B.n = 0;
    const tick = w.tick + alpha;
    ownerProg.fill(0);
    for (let i = 0; i < tg.hi; i++) {
      if (!tg.alive[i]) continue;
      const span = Math.max(1, tg.impact[i] - tg.start[i]);
      const prog = clamp01((tick - tg.start[i]) / span);
      const shape = tg.shape[i];
      const fl = tg.flags[i];
      const n = d.n++;
      const hY = 0.025 + (i % 8) * 0.002;
      let hx = tg.r[i], hy = tg.r[i], param = 0;
      let cx = tg.x[i], cy = tg.y[i], yaw = 0;
      if (shape === TG_SHAPE.LANE) {
        const dx = tg.x2[i] - tg.x[i], dy = tg.y2[i] - tg.y[i];
        const len = Math.sqrt(dx * dx + dy * dy) || 0.01;
        cx = (tg.x[i] + tg.x2[i]) / 2;
        cy = (tg.y[i] + tg.y2[i]) / 2;
        yaw = Math.atan2(dy, dx);
        hx = len / 2;
        hy = tg.r[i];
      } else if (shape === TG_SHAPE.CONE) {
        yaw = Math.atan2(tg.y2[i] - tg.y[i], tg.x2[i] - tg.x[i]);
        param = tg.arc[i];
      } else if (shape === TG_SHAPE.RING) {
        param = tg.arc[i];
      }
      writeTRS(d.e, n, cx, hY, -cy, yaw, 0, 0, hx, 1, hy);
      const col = tg.color[i] === TG_COLOR.VIOLET ? 0xb070ff : tg.color[i] === TG_COLOR.GOLD ? 0xffc94a : 0xff2a2a;
      writeHex(d.c, n, col, 1);
      const after = tg.resolved[i] ? Math.max(0, (tick - tg.impact[i]) / 60) : -1;
      d.a[n * 4] = shape;
      d.a[n * 4 + 1] = prog;
      d.a[n * 4 + 2] = tg.color[i];
      d.a[n * 4 + 3] = after;
      d.b[n * 4] = hx;
      d.b[n * 4 + 1] = hy;
      d.b[n * 4 + 2] = param;
      d.b[n * 4 + 3] = (fl & TGF.LINGER_HURTS ? 1 : 0) + (fl & TGF.MAW ? 2 : 0);
      // Wyrmfall rocks drop onto their telegraphs
      if (fl & TGF.TRUE_DAMAGE && !(fl & TGF.MAW) && !tg.resolved[i] && prog > 0.3) {
        const q = (prog - 0.3) / 0.7;
        const h = 18 * (1 - q * q);
        const s = Math.max(0.5, tg.r[i] * 0.55);
        writeTRS(B.mesh.instanceMatrix.array as Float32Array, B.n, tg.x[i], h + s * 0.5, -tg.y[i], q * 4 + i, q * 3, 0, s, s, s);
        writeHex(B.mesh.instanceColor!.array as Float32Array, B.n, 0x8a6a5a, 1.2);
        inst(B, B.n, 0, 0, 0, 0.2);
        B.n++;
        if (Math.random() < 0.3) f.particles.emit(tg.x[i], h + s, tg.y[i], 0, 2, 0, 0xff7a2a, 1, 0.4, 0.4, 0, 0);
      }
      // impact juice, once per telegraph
      if (tg.resolved[i] && this.tgImpactUid[i] !== tg.uid[i] && !(fl & TGF.MAW)) {
        this.tgImpactUid[i] = tg.uid[i];
        if (tg.dmgPct[i] > 0) {
          this.impacts++;
          const ddx = tg.x[i] - f.px, ddy = tg.y[i] - f.py;
          this.impactNear = Math.min(this.impactNear, Math.sqrt(ddx * ddx + ddy * ddy) - tg.r[i]);
          const n2 = Math.min(28, 8 + Math.floor(tg.r[i] * 4));
          const dust = fl & TGF.TRUE_DAMAGE ? 0xc09070 : 0xff5a3a;
          if (shape === TG_SHAPE.LANE) {
            for (let k = 0; k < 6; k++) {
              const u = k / 5;
              f.particles.burst(tg.x[i] + (tg.x2[i] - tg.x[i]) * u, 0.2, tg.y[i] + (tg.y2[i] - tg.y[i]) * u, 4, 3, 3, dust, 1, 0.45, 0.6);
            }
          } else {
            f.particles.burst(tg.x[i], 0.2, tg.y[i], n2, 2 + tg.r[i] * 1.5, 4, dust, 1.1, 0.5, 0.7);
          }
        }
      }
      if (!tg.resolved[i] && tg.owner[i] >= 0 && tg.owner[i] < 512) ownerProg[tg.owner[i]] = Math.max(ownerProg[tg.owner[i]], prog);
    }
    d.flush();
    this.tgOver.count = d.n;
    this.tgOver.visible = d.n > 0;
    flush(B);
  }

  // -------------------------------------------------------------------------------------------
  private updateEnemies(f: ActorFrame): void {
    const { w, alpha, t, dt } = f;
    const en = w.en;
    for (const k of MESH_KINDS) this.critters[k].n = 0;
    for (const b of this.bosses) b.n = 0;
    this.wyrmVisible = false;
    let statusBudget = 70;
    const yawK = damp(10, dt);
    for (let i = 0; i < en.hi; i++) {
      if (!en.alive[i]) continue;
      const fl = en.flags[i];
      const x = this.enI.x(i, alpha), y = this.enI.y(i, alpha);
      const r = en.r[i];
      const age = (w.tick - en.spawnTick[i]) / 60 + alpha / 60;
      const fr = en.flash[i] / 6;
      const flash = Math.max(fr > 0 ? Math.min(1, fr * fr * 1.5) : 0, this.globalFlash);
      // facing: toward the critter's own motion (knockback does not turn it around), else toward the player
      let vx = en.vx[i], vy = en.vy[i];
      const mv = clamp01(Math.sqrt(vx * vx + vy * vy) / 3);
      if (vx * vx + vy * vy < 0.04) {
        vx = f.px - x;
        vy = f.py - y;
      }
      const target = Math.atan2(vx, -vy);
      let dyaw = target - this.yaw[i];
      while (dyaw > Math.PI) dyaw -= TAU;
      while (dyaw < -Math.PI) dyaw += TAU;
      this.yaw[i] = age < 0.05 ? target : this.yaw[i] + dyaw * yawK;
      const phase = hash01(en.uid[i]) * TAU;
      if (fl & EF.WYRM) {
        this.drawWyrm(f, i, x, y, r, age, flash);
        continue;
      }
      if (fl & EF.BOSS) {
        this.drawBoss(f, i, x, y, r, age, flash, phase);
        continue;
      }
      const kind = MESH_KINDS[this.kindOf[en.def[i]] ?? 0];
      const info = KIND_INFO[kind];
      const b = this.critters[kind];
      if (b.n >= b.mesh.instanceMatrix.count) continue;
      const spawnK = age < 0.3 ? easeBack(age / 0.3) : 1;
      let s = r * info.scale * spawnK;
      let sx = s, sy = s, sz = s, pitch = 0, roll = 0, h = info.hover;
      const ph = t + phase;
      switch (kind) {
        case 'bat':
          // flutter, with a swoop that dips the nose as it dives in
          h += Math.sin(ph * 5) * 0.14 - 0.12 * mv * Math.max(0, Math.sin(ph * 1.3));
          pitch = 0.3 + 0.2 * mv * Math.max(0, Math.sin(ph * 1.3));
          roll = Math.sin(ph * 2.3) * 0.25;
          break;
        case 'slime': {
          // hops: stretch in the air, squash on landing; idles with a wobble
          const hop = (ph * 0.42 + phase) % 1;
          const air = Math.sin(hop * Math.PI);
          const land = hop < 0.14 ? 1 - hop / 0.14 : 0;
          const q = Math.sin(ph * 7) * (1 - mv) * 0.15 + mv * (air * 0.2 - land * 0.32);
          sy *= 1 + q;
          sx *= 1 - q * 0.5;
          sz *= 1 - q * 0.5;
          h = air * (0.08 + 0.32 * mv);
          pitch = mv * (air - 0.5) * 0.25;
          break;
        }
        case 'beetle':
          roll = Math.sin(ph * 15) * (0.04 + 0.06 * mv);
          h = Math.abs(Math.sin(ph * 15)) * 0.03 * mv;
          pitch = -0.06 * mv;
          break;
        case 'shroom':
          // a waddle: the cap rocks side to side, a bob per step
          roll = Math.sin(ph * 5) * (0.08 + 0.14 * mv);
          h = Math.abs(Math.sin(ph * 5)) * (0.04 + 0.08 * mv);
          sy *= 1 + 0.05 * Math.sin(ph * 10);
          break;
        case 'golem':
        case 'elite':
          // heavy lumbering stomp
          roll = Math.sin(ph * 2.6) * (0.04 + 0.1 * mv);
          h = Math.abs(Math.sin(ph * 2.6)) * (0.04 + 0.1 * mv);
          pitch = 0.08 * mv;
          break;
        case 'clump':
          sy *= 1 + 0.06 * Math.sin(ph * 5);
          if (en.aux1[i] > 0) s *= 1 + Math.min(0.6, en.aux1[i] * 0.02);
          break;
      }
      if (fl & EF.CLUMP && kind !== 'clump') {
        sx *= 1.3; sy *= 1.3; sz *= 1.3;
      }
      // hit: squash down and bulge out; knockback leans the body away from the blow
      if (flash > 0) {
        sy *= 1 - 0.3 * flash;
        sx *= 1 + 0.22 * flash;
        sz *= 1 + 0.22 * flash;
      }
      const kx = en.kx[i], ky = en.ky[i];
      const kn2 = kx * kx + ky * ky;
      if (kn2 > 0.25) {
        const fy0 = Math.sin(this.yaw[i]), fy1 = -Math.cos(this.yaw[i]);
        const kf = kx * fy0 + ky * fy1; // + pushed forward
        const ks = kx * -fy1 + ky * fy0;
        pitch += Math.max(-0.5, Math.min(0.5, kf * 0.07));
        roll += Math.max(-0.5, Math.min(0.5, -ks * 0.07));
        if (kn2 > 16 && h < 0.2 && Math.random() < 0.2 * this.fxScale) f.particles.emit(x, 0.08, y, -kx * 0.15, 0.6, -ky * 0.15, 0x9a8a7a, 0.7, 0.35, 0.35, 0, 2);
      }
      // windup pose for slamming trash (golems / elites)
      const wp = ownerProg[i];
      if (wp > 0) {
        sy *= 1 - 0.2 * wp;
        sx *= 1 + 0.1 * wp;
        sz *= 1 + 0.1 * wp;
        roll += Math.sin(t * 60) * 0.04 * wp;
      }
      writeTRS(b.mesh.instanceMatrix.array as Float32Array, b.n, x, h, -y, this.yaw[i], pitch, roll, sx, sy, sz);
      // tint: def colour, status colour, formation violet
      let col = ENEMIES[en.def[i]].color;
      let glow = 0;
      const so = i * 6;
      let stK = -1;
      if (en.stStacks[so + ST.BURN] > 0) stK = ST.BURN;
      else if (en.stStacks[so + ST.POISON] > 0) stK = ST.POISON;
      else if (en.stStacks[so + ST.SHADOW] > 0) stK = ST.SHADOW;
      else if (en.stStacks[so + ST.CHILL] > 0) stK = ST.CHILL;
      else if (en.stStacks[so + ST.SHOCK] > 0) stK = ST.SHOCK;
      if (stK >= 0) {
        col = mixHex(col, STATUS_COLORS[stK], 0.4);
        glow = 0.12;
        if (statusBudget > 0 && Math.random() < 0.12) {
          statusBudget--;
          const sc = STATUS_COLORS[stK];
          const hh = h + r * (0.6 + Math.random() * 0.8);
          if (stK === ST.BURN) f.particles.emit(x + (Math.random() - 0.5) * r, hh, y + (Math.random() - 0.5) * r, 0, 1.8, 0, sc, 1.6, 0.35, 0.5, 0.5, 0.5);
          else if (stK === ST.POISON) f.particles.emit(x + (Math.random() - 0.5) * r, hh, y + (Math.random() - 0.5) * r, 0, 0.9, 0, sc, 1.2, 0.3, 0.6, 0, 0.5);
          else if (stK === ST.SHADOW) f.particles.emit(x, hh, y, (Math.random() - 0.5), 1.2, (Math.random() - 0.5), sc, 1.3, 0.45, 0.6, 0, 1);
          else f.particles.emit(x + (Math.random() - 0.5) * r * 2, hh, y + (Math.random() - 0.5) * r * 2, 0, 0.3, 0, sc, 1.6, 0.22, 0.3, 0, 0);
        }
      }
      if (fl & EF.FORMATION) {
        col = mixHex(col, 0xb070ff, 0.45);
        glow += 0.25;
      }
      if (fl & EF.ELITE) glow += 0.15;
      writeHex(b.mesh.instanceColor!.array as Float32Array, b.n, col, 1);
      inst(b, b.n, phase, flash, 1, glow);
      b.n++;
      this.shadow(x, y, r * (kind === 'bat' ? 0.9 : 1.25), kind === 'bat' ? 0.3 : 0.45);
    }
    this.drawPops(dt);
    this.globalFlash = Math.max(0, this.globalFlash - dt * 2.2);
    for (const k of MESH_KINDS) flush(this.critters[k]);
    for (const b of this.bosses) flush(b);
    if (!this.wyrmVisible) {
      this.skull.n = this.jaw.n = this.neck.n = 0;
      flush(this.skull);
      flush(this.jaw);
      flush(this.neck);
    }
    this.wyrmRecoil = Math.max(0, this.wyrmRecoil - dt * 2.5);
  }

  private drawBoss(f: ActorFrame, i: number, x: number, y: number, r: number, age: number, flash: number, phase: number): void {
    const { w, t, alpha } = f;
    const en = w.en;
    const def = en.def[i];
    const b = this.bosses[def];
    if (!b) return;
    const bs = w.boss;
    const mode = bs.mode[def] ?? 0;
    // emerge from the floor over the first second
    const rise = age < 1 ? easeOut(age) : 1;
    let h = -r * 2.2 * (1 - rise);
    let sx = r, sy = r, sz = r, pitch = 0, roll = 0;
    let yaw = this.yaw[i];
    let glow = 0;
    const wp = ownerProg[i];
    if (wp > 0) {
      // telegraph-aware windup: crouch, widen, tremble, glow hotter as the fill closes
      sy *= 1 - 0.2 * wp;
      sx *= 1 + 0.12 * wp;
      sz *= 1 + 0.12 * wp;
      roll = Math.sin(t * 55) * 0.05 * wp;
      glow = 0.5 * wp * wp;
    }
    if (mode === 3) {
      // leap: an arc over LEAP_TICKS (12)
      const left = (bs.modeEnd[def] - (w.tick + alpha)) / 12;
      const p = clamp01(1 - left);
      h += 4 * 3 * p * (1 - p);
      pitch = -0.3 + 0.6 * p;
    } else if (mode === 2) {
      pitch = 0.35;
      sz *= 1.15;
      sy *= 0.92;
    } else if (mode === 1) {
      glow = Math.max(glow, 0.25 + 0.15 * Math.sin(t * 20));
    }
    if (def === 3) {
      // Prism Warden floats and spins
      h += 0.5 + Math.sin(t * 2) * 0.2;
      yaw = t * 0.6;
    } else {
      h += Math.abs(Math.sin(t * 3 + phase)) * 0.05 * r;
    }
    const s = 1 + flash * 0.1;
    writeTRS(b.mesh.instanceMatrix.array as Float32Array, 0, x, h, -y, yaw, pitch, roll, sx * s, sy * s, sz * s);
    writeHex(b.mesh.instanceColor!.array as Float32Array, 0, mixHex(BOSSES[def].color, 0x2a2026, 0.35), 1);
    inst(b, 0, phase, flash * 0.4, mode === 0 ? 0.5 : 1.2, glow);
    b.n = 1;
    this.shadow(x, y, r * 1.5, 0.55);
    if (age < 1.1 && Math.random() < 0.6) f.particles.burst(x, 0.1, y, 2, 3, 3, 0x9a8070, 1, 0.5, 0.8);
    if (def === 4 && Math.random() < 0.3) f.particles.emit(x + (Math.random() - 0.5) * r, h + r * 2.2, y + (Math.random() - 0.5) * r, 0, 2.2, 0, 0xff7a2a, 1.5, 0.35, 0.8, 0, 0);
    if (def === 1 && Math.random() < 0.25) f.particles.emit(x + (Math.random() - 0.5) * r * 2, h + r * 2.4, y + (Math.random() - 0.5) * r * 2, 0, 0.5, 0, 0xc8ff7a, 1.2, 0.3, 1.4, -0.2, 0);
  }

  onStagger(): void {
    this.wyrmRecoil = 1;
  }

  private drawWyrm(f: ActorFrame, _i: number, x: number, y: number, r: number, age: number, flash: number): void {
    const { w, t } = f;
    this.wyrmVisible = true;
    const S = r * 0.75;
    // rise out of the rock over 2.5 s
    const rise = easeOut(clamp01(age / 2.5));
    const rec = this.wyrmRecoil;
    // face the player (it is hunting you), with a slow menacing sway
    const yaw = Math.atan2(f.px - x, -(f.py - y)) + Math.sin(t * 0.7) * 0.15;
    const fx = Math.sin(yaw), fy = -Math.cos(yaw); // sim-space forward
    const back = 1.2 * rec;
    const hx = x - fx * back, hy = y - fy * back;
    const h = -6 + (6 + 2.2) * rise + Math.sin(t * 1.3) * 0.25 + rec * 0.8;
    const pitch = -0.15 - rec * 0.5 + Math.sin(t * 0.9) * 0.05;
    const breath = w.hazard.breathPerSec;
    const open = 0.18 + 0.22 * (0.5 + 0.5 * Math.sin(t * 2.2)) + Math.min(0.35, breath * 8) + rec * 0.3;
    const glowK = Math.min(1.5, 0.3 + breath * 20);
    this._m.compose(this._v.set(hx, h, -hy), this._q.setFromEuler(this._e.set(pitch, yaw, 0, 'YXZ')), this._s.set(S, S, S));
    this._m.toArray(this.skull.mesh.instanceMatrix.array as Float32Array, 0);
    this._m2.makeRotationX(open);
    this._m2.setPosition(0, 0.15, -0.3);
    this._m2.premultiply(this._m);
    this._m2.toArray(this.jaw.mesh.instanceMatrix.array as Float32Array, 0);
    const col = 0x24141e;
    writeHex(this.skull.mesh.instanceColor!.array as Float32Array, 0, col, 1);
    writeHex(this.jaw.mesh.instanceColor!.array as Float32Array, 0, col, 1);
    inst(this.skull, 0, 0, rec * 0.8 + flash * 0.1, 0, glowK * 0.15);
    inst(this.jaw, 0, 0, rec * 0.8 + flash * 0.1, 0, glowK * 0.15);
    this.skull.n = this.jaw.n = 1;
    // neck plates curve back out of the arena and down into the rock
    const out = Math.sqrt(x * x + y * y) || 1;
    const ox = x / out, oy = y / out;
    const N = this.neck;
    N.n = 0;
    for (let k = 1; k <= 6; k++) {
      const u = k / 6;
      const sx = hx + ox * (u * 4.5 * S) - fx * u * 0.6 * S;
      const sy = hy + oy * (u * 4.5 * S) - fy * u * 0.6 * S;
      const sh = h - 0.6 * S - u * u * 5 * S + Math.sin(t * 1.3 - k * 0.6) * 0.2;
      const ss = S * (0.95 - u * 0.15);
      writeTRS(N.mesh.instanceMatrix.array as Float32Array, N.n, sx, sh, -sy, yaw + Math.sin(t + k) * 0.1, -0.4, 0, ss, ss, ss);
      writeHex(N.mesh.instanceColor!.array as Float32Array, N.n, col, 1);
      inst(N, N.n, 0, rec * 0.5, 0, glowK * 0.08);
      N.n++;
    }
    flush(this.skull);
    flush(this.jaw);
    flush(N);
    // mouth position for the glow / breath
    this._v.set(0, 0.25, 1.7).applyMatrix4(this._m);
    this.wyrmMouthX = this._v.x;
    this.wyrmMouthY = -this._v.z;
    this.wyrmMouthH = this._v.y;
    f.glows.add(this.wyrmMouthX, this.wyrmMouthH, this.wyrmMouthY, 2.5 + glowK * 2, 0xff6a20, 0.6 + glowK * 0.6);
    this._v.set(0.55, 0.8, 0.95).applyMatrix4(this._m);
    f.glows.add(this._v.x, this._v.y, -this._v.z, 0.9, 0xffe040, 1.2);
    this._v.set(-0.55, 0.8, 0.95).applyMatrix4(this._m);
    f.glows.add(this._v.x, this._v.y, -this._v.z, 0.9, 0xffe040, 1.2);
    // breath: embers pour from the maw toward the player, more as the clock climbs
    const rate = 0.4 + Math.min(4, breath * 120);
    for (let k = 0; k < rate; k++) {
      if (Math.random() > rate - k) break;
      const dx = f.px - this.wyrmMouthX, dy = f.py - this.wyrmMouthY;
      const L = Math.sqrt(dx * dx + dy * dy) || 1;
      const sp = 6 + Math.random() * 6;
      f.particles.emit(this.wyrmMouthX, this.wyrmMouthH, this.wyrmMouthY, (dx / L) * sp + (Math.random() - 0.5) * 3, 1 + Math.random() * 2, (dy / L) * sp + (Math.random() - 0.5) * 3, Math.random() < 0.5 ? 0xff5a1a : 0xffb040, 1.8, 0.7, 0.9, -3, 0.6);
    }
    if (age < 3) for (let k = 0; k < 3; k++) f.particles.burst(x + (Math.random() - 0.5) * 3, 0.2, y + (Math.random() - 0.5) * 3, 1, 4, 6, 0x9a7a6a, 1, 0.7, 1.2);
  }

  // -------------------------------------------------------------------------------------------
  private updatePickups(f: ActorFrame): void {
    const { w, alpha, t } = f;
    const gm = w.gm;
    const G = this.gems, C = this.chests, H = this.hearts;
    G.n = C.n = H.n = 0;
    const ge = G.mesh.instanceMatrix.array as Float32Array;
    const gc = G.mesh.instanceColor!.array as Float32Array;
    const TIER_S = [0.85, 1.1, 1.45, 1.9];
    const TIER_C = [0xffb21a, 0xffc22e, 0xffd04a, 0xffe07a];
    for (let i = 0; i < gm.hi; i++) {
      if (!gm.alive[i]) continue;
      const x = this.gmI.x(i, alpha), y = this.gmI.y(i, alpha);
      const tier = gm.tier[i];
      const ph = hash01(gm.uid[i]);
      const age = (w.tick - gm.born[i] + alpha) / 60;
      const flying = gm.state[i] === 1;
      if (tier === 4) {
        const s = 1.1 * (age < 0.4 ? easeBack(age / 0.4) : 1);
        writeTRS(C.mesh.instanceMatrix.array as Float32Array, C.n, x, Math.abs(Math.sin(t * 2)) * 0.15, -y, t * 0.6, 0, 0, s, s, s);
        writeHex(C.mesh.instanceColor!.array as Float32Array, C.n, 0xffffff, 1);
        inst(C, C.n, 0, 0, 0, 0.1 + 0.1 * Math.sin(t * 4));
        C.n++;
        f.glows.add(x, 0.6, y, 2.6, 0xffc94a, 0.55 + 0.2 * Math.sin(t * 4));
        if (Math.random() < 0.25) f.particles.emit(x + (Math.random() - 0.5), 0.2, y + (Math.random() - 0.5), 0, 2.5, 0, 0xffd27a, 1.5, 0.3, 0.8, 0, 0);
        this.shadow(x, y, 0.7, 0.4);
        continue;
      }
      if (tier === 5) {
        if (H.n >= 32) continue;
        const s = 1.2 + Math.sin(t * 6 + ph * 6) * 0.08;
        writeTRS(H.mesh.instanceMatrix.array as Float32Array, H.n, x, 0.45 + Math.sin(t * 3 + ph * 6) * 0.08, -y, Math.sin(t * 2) * 0.5, 0, 0, s, s, s);
        writeHex(H.mesh.instanceColor!.array as Float32Array, H.n, 0xffffff, 1);
        inst(H, H.n, 0, 0, 0, 0);
        H.n++;
        f.glows.add(x, 0.45, y, 1.4, 0xff4a7a, 0.6);
        this.shadow(x, y, 0.3, 0.35);
        continue;
      }
      const tt = Math.min(3, tier);
      const s = TIER_S[tt] * (age < 0.25 ? easeBack(age / 0.25) : 1);
      let h = flying ? 0.55 : 0.3 + Math.sin(t * 3 + ph * TAU) * 0.07;
      // fountain: sliding gems arc up out of the burst; plain drops hop once
      const sliding = gm.vx[i] * gm.vx[i] + gm.vy[i] * gm.vy[i] > 0.01;
      if (!flying && age < 0.6) {
        const T = sliding ? 0.6 : 0.3;
        if (age < T) h += Math.sin((age / T) * Math.PI) * (sliding ? 1.3 + ph * 0.6 : 0.35);
      }
      writeTRS(ge, G.n, x, h, -y, t * 2.2 + ph * TAU, 0, 0.25, s, s, s);
      writeHex(gc, G.n, TIER_C[tt], 1);
      inst(G, G.n, 0, 0, 0, 0.1 * Math.max(0, Math.sin(t * 5 + ph * 30)));
      G.n++;
      // glint: a 4-point sparkle every couple of seconds, staggered per gem
      const cyc = (t * 0.55 + ph) % 1;
      if (cyc < 0.09) f.stars.add(x, h + 0.12, y, (0.5 + tt * 0.25) * Math.sin((cyc / 0.09) * Math.PI), 0xfff4c0, 1.4);
      f.glows.add(x, h, y, 0.7 + tt * 0.3, 0xffa020, tt >= 2 ? 0.4 : 0.22);
      if (flying) {
        // pickup trail: a sparkle stream toward the lantern, gold -> white -> cyan as the combo climbs
        const heat = this.gemHeat;
        const tc = heat < 0.5 ? mixHex(0xffd27a, 0xfff6e0, heat * 2) : mixHex(0xfff6e0, 0x9af0ff, (heat - 0.5) * 2);
        if (Math.random() < 0.6 * this.fxScale) f.particles.emit(x, h, y, 0, 0.2, 0, tc, 1.4, 0.2 + tt * 0.04, 0.25, 0, 0);
        if (((i + (t * 30) | 0) & 3) === 0) f.stars.add(x, h, y, 0.35 + tt * 0.08, tc, 1.1);
      } else if (sliding && age < 0.6 && Math.random() < 0.35 * this.fxScale) {
        f.particles.emit(x, h, y, 0, 0, 0, 0xffd27a, 1.1, 0.16, 0.3, 0, 0);
      }
      if (age < 0.05) f.stars.add(x, h, y, 0.9, 0xffffff, 1);
    }
    flush(G);
    flush(C);
    flush(H);
  }

  // -------------------------------------------------------------------------------------------
  private updateProjectiles(f: ActorFrame): void {
    const { w, alpha, t, dt } = f;
    const pr = w.pr;
    const O = this.orbs, S = this.shards;
    O.n = S.n = 0;
    const oe = O.mesh.instanceMatrix.array as Float32Array, oc = O.mesh.instanceColor!.array as Float32Array;
    const se = S.mesh.instanceMatrix.array as Float32Array, sc = S.mesh.instanceColor!.array as Float32Array;
    let trail = Math.round(140 * this.fxScale);
    let mighty = 40; // rank-5 sparkle cores per frame
    // dense volleys: dim each glow so overlapping additive light does not white out the screen
    const dens = Math.min(1, Math.sqrt(90 / Math.max(1, pr.count)));
    for (let i = 0; i < pr.hi; i++) {
      if (!pr.alive[i]) continue;
      const def = SPELLS[pr.spell[i]];
      if (!def) continue;
      const fx = def.fx;
      const col = FX_COLORS[fx] ?? 0xffffff;
      const x = this.prI.x(i, alpha), y = this.prI.y(i, alpha);
      const h = 0.75 + (pr.kind[i] === 2 ? Math.sin(t * 6 + i) * 0.1 : 0);
      // rank scaling: rank 1 is a spark, rank 5 a blazing comet with a white-hot core and a thick trail
      const rk = rankK(w, pr.slot[i]);
      const grow = 1 + 0.5 * rk;
      const isShard = fx === 'blade' || fx === 'steel' || (def.behavior === 'projectile' && fx === 'poison') || def.id === 'sunSpear';
      const vx = pr.vx[i], vy = pr.vy[i];
      const yawT = Math.atan2(vx, -vy);
      if (vx * vx + vy * vy > 0.01) this.prYaw[i] = yawT;
      if (isShard) {
        const L = def.id === 'sunSpear' ? 1.2 : fx === 'poison' ? 0.5 : 0.42;
        const spin = fx === 'steel' ? t * 14 : 0;
        writeTRS(se, S.n, x, h, -y, this.prYaw[i] + spin, 0, fx === 'blade' ? t * 20 : 0, L * 0.9 * grow, L * 0.9 * grow, L * grow);
        writeHex(sc, S.n, mixHex(col, 0xffffff, 0.25 * rk), (fx === 'steel' || fx === 'blade' ? 0.85 : 1.15) * (1 + 0.3 * rk));
        S.n++;
        f.glows.add(x, h, y, (0.9 + (def.id === 'sunSpear' ? 1.2 : 0)) * (1 + 0.6 * rk), col, 0.35 * dens * (1 + 0.6 * rk));
      } else if (O.n < 560) {
        const big = fx === 'fire' && pr.kind[i] === 2 ? 1.6 : fx === 'fire' ? 1.25 : 1;
        const rad = Math.min(0.2, Math.max(0.1, pr.r[i] * 0.4)) * big * grow * (1 + Math.sin(t * 30 + i) * 0.08);
        writeTRS(oe, O.n, x, h, -y, 0, 0, 0, rad, rad, rad);
        writeHex(oc, O.n, mixHex(col, 0xffffff, 0.2 + 0.35 * rk), 1.25 + 0.5 * rk);
        O.n++;
        f.glows.add(x, h, y, rad * 6 * (1 + 0.3 * rk), col, (fx === 'shadow' || fx === 'nightshade' ? 0.5 : 0.3) * dens * (1 + 0.5 * rk));
      }
      if (rk >= 1 && mighty > 0) {
        // rank 5: a twinkling white-hot star at the core
        mighty--;
        f.stars.add(x, h, y, 0.7 + 0.25 * Math.sin(t * 25 + i * 1.7), 0xffffff, 0.9 * dens + 0.3);
      }
      if (trail > 0 && Math.random() < 0.55 * dens * (1 + rk)) {
        trail--;
        const k = (fx === 'fire' || fx === 'fever' ? 1.8 : 1.3) * (1 + 0.3 * rk);
        const up = fx === 'fire' ? 1.2 : fx === 'poison' ? -1.5 : 0.3;
        f.particles.emit(x + (Math.random() - 0.5) * 0.15 * grow, h, y + (Math.random() - 0.5) * 0.15 * grow, -vx * 0.05, up, -vy * 0.05, Math.random() < 0.3 + 0.2 * rk ? 0xffffff : col, k, (fx === 'fire' ? 0.4 : 0.26) * (1 + 0.5 * rk), 0.28 + 0.15 * rk, 0, 1);
      }
    }
    // summons (gloom wisps)
    const al = w.al;
    for (let i = 0; i < al.hi; i++) {
      if (!al.alive[i]) continue;
      const def = SPELLS[al.spell[i]];
      const col = FX_COLORS[def?.fx ?? 'shadow'] ?? 0xb070ff;
      const x = this.alI.x(i, alpha), y = this.alI.y(i, alpha);
      const h = 1.0 + Math.sin(t * 4 + i) * 0.2;
      if (O.n < 560) {
        writeTRS(oe, O.n, x, h, -y, 0, 0, 0, 0.22, 0.22, 0.22);
        writeHex(oc, O.n, 0x2a1040, 1);
        O.n++;
      }
      f.glows.add(x, h, y, 1.6, col, 0.9);
      f.stars.add(x + 0.12, h + 0.08, y, 0.35, 0xfff0ff, 1.2);
      if (Math.random() < dt * 30) f.particles.emit(x, h, y, 0, 0.4, 0, col, 1.4, 0.35, 0.45, 0, 1);
      this.shadow(x, y, 0.3, 0.25);
    }
    flush(O);
    flush(S);
  }

  // -------------------------------------------------------------------------------------------
  private updateZones(f: ActorFrame): void {
    const { w, alpha } = f;
    const zn = w.zn;
    const d = this.zones;
    d.n = 0;
    for (let i = 0; i < zn.hi; i++) {
      if (!zn.alive[i]) continue;
      const def = SPELLS[zn.spell[i]];
      const fx = def?.fx ?? 'fire';
      const aura = def?.behavior === 'aura' || zn.dmg[i] === 0;
      const x = zn.follow[i] ? f.px : zn.x[i];
      const y = zn.follow[i] ? f.py : zn.y[i];
      const n = d.n++;
      const r = zn.r[i];
      writeTRS(d.e, n, x, 0.035 + (i % 6) * 0.002, -y, 0, 0, 0, r, 1, r);
      writeHex(d.c, n, FX_COLORS[fx] ?? 0xffffff, aura ? 0.9 : 0.75);
      const lifeFrac = zn.maxLife[i] > 0 ? clamp01((zn.life[i] - alpha) / zn.maxLife[i]) : 0;
      d.a[n * 4] = FX_ID[fx] ?? 2;
      d.a[n * 4 + 1] = lifeFrac;
      d.a[n * 4 + 2] = hash01(zn.uid[i]);
      d.a[n * 4 + 3] = aura ? 1 : 0;
      d.b[n * 4] = r;
      d.b[n * 4 + 1] = (zn.maxLife[i] - zn.life[i] + alpha) / 60;
      d.b[n * 4 + 2] = zn.follow[i];
      d.b[n * 4 + 3] = rankK(w, zn.slot[i]);
      if (!aura && Math.random() < 0.05 * r) {
        const a = Math.random() * TAU, rr = Math.sqrt(Math.random()) * r;
        f.particles.emit(x + Math.cos(a) * rr, 0.1, y + Math.sin(a) * rr, 0, fx === 'fire' ? 2 : 0.8, 0, FX_COLORS[fx] ?? 0xffffff, 1.4, 0.3, 0.6, 0, 0.5);
      }
    }
    d.flush();
  }
}

function easeOut(t: number): number {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
}
function easeBack(t: number): number {
  const c = 1.9;
  const u = clamp01(t) - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
}
