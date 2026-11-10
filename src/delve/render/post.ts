/**
 * Post (RENDER): optional bloom (UnrealBloomPass, which runs its bright pass and blur chain at half
 * resolution) plus a cheap full-screen overlay for vignette, darkening (fusion reveal, layer descent),
 * hurt and Wyrm-breath edges, and white flashes, plus a per-biome colour grade (gradeMaterial).
 *
 * A quality governor watches frame time and steps down: bloom off, then pixel ratio 1.5 -> 1 -> 0.75.
 * It never steps back up on its own (no oscillation); `?quality=0..4` pins a level, `?bloom=0|1` pins bloom.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { gradeMaterial, overlayMaterial } from './materials';

/** Quality levels: 4 bloom + dpr<=2, 3 bloom + dpr<=1.5, 2 dpr<=1.5, 1 dpr 1, 0 dpr 0.75. */
const LEVELS = [
  { bloom: false, dpr: 0.75 },
  { bloom: false, dpr: 1 },
  { bloom: false, dpr: 1.5 },
  { bloom: true, dpr: 1.5 },
  { bloom: true, dpr: 2 },
];

export class Post {
  readonly overlay: THREE.ShaderMaterial;
  /** Per-biome colour grade (renderer sets uCentre / uEdge / uSpot / uPump). */
  readonly grade: THREE.ShaderMaterial;
  private readonly gradeScene = new THREE.Scene();
  private readonly overlayScene = new THREE.Scene();
  private readonly overlayCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private w = 1;
  private h = 1;
  level: number;
  private readonly pinned: boolean;
  private readonly bloomPin: boolean | null;
  private ema = 1 / 60;
  private slowFor = 0;
  /** Seconds since start (governor waits for shader warm-up). */
  private age = 0;

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly scene: THREE.Scene, private readonly camera: THREE.Camera) {
    this.overlay = overlayMaterial();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.overlay);
    quad.frustumCulled = false;
    this.overlayScene.add(quad);
    this.grade = gradeMaterial();
    const gq = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.grade);
    gq.frustumCulled = false;
    this.gradeScene.add(gq);
    const q = new URLSearchParams(location.search);
    const ql = q.get('quality');
    const b = q.get('bloom');
    this.bloomPin = b === '1' ? true : b === '0' ? false : null;
    this.pinned = ql !== null && ql !== '';
    const dpr = window.devicePixelRatio || 1;
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    this.level = this.pinned ? Math.max(0, Math.min(4, Number(ql) | 0)) : coarse ? 3 : dpr > 1.5 ? 4 : 3;
  }

  get bloomOn(): boolean {
    return this.bloomPin ?? LEVELS[this.level].bloom;
  }
  get dpr(): number {
    return Math.min(window.devicePixelRatio || 1, LEVELS[this.level].dpr);
  }

  setSize(w: number, h: number): void {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.apply();
  }

  private apply(): void {
    const dpr = this.dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.w, this.h, false);
    this.overlay.uniforms.uAspect.value = this.w / this.h;
    this.grade.uniforms.uAspect.value = this.w / this.h;
    if (this.bloomOn) {
      if (!this.composer) {
        const rt = new THREE.WebGLRenderTarget(this.w * dpr, this.h * dpr, { type: THREE.HalfFloatType, samples: 0 });
        this.composer = new EffectComposer(this.renderer, rt);
        this.composer.addPass(new RenderPass(this.scene, this.camera));
        this.bloom = new UnrealBloomPass(new THREE.Vector2(this.w / 2, this.h / 2), 0.55, 0.45, 1.0);
        this.composer.addPass(this.bloom);
        this.composer.addPass(new OutputPass());
      }
      this.composer.setPixelRatio(dpr);
      this.composer.setSize(this.w, this.h);
    } else if (this.composer) {
      this.composer.dispose();
      this.bloom?.dispose();
      this.composer = null;
      this.bloom = null;
    }
  }

  /** Feed the wall-clock frame time; may step quality down. */
  govern(dt: number): void {
    this.age += dt;
    if (dt <= 0) return;
    this.ema += (Math.min(dt, 0.25) - this.ema) * 0.05;
    if (this.pinned || this.age < 2.5) return;
    const budget = this.level >= 3 ? 1 / 50 : 1 / 45;
    if (this.ema > budget) this.slowFor += dt;
    else this.slowFor = Math.max(0, this.slowFor - dt * 0.5);
    if (this.slowFor > 2 && this.level > 0) {
      this.level--;
      // skip the "bloom at 1.5" level when coming down from 4: drop bloom first
      if (this.level === 3 && this.bloomPin === null) this.level = 2;
      this.slowFor = 0;
      this.ema = 1 / 60;
      this.apply();
    }
  }

  get frameMs(): number {
    return this.ema * 1000;
  }

  render(): void {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    const ac0 = this.renderer.autoClear;
    if (this.level > 0) {
      // colour grade: one trivial full-screen pass (skipped on the lowest quality level)
      this.renderer.autoClear = false;
      this.renderer.render(this.gradeScene, this.overlayCam);
      this.renderer.autoClear = ac0;
    }
    const u = this.overlay.uniforms;
    if (u.uVignette.value > 0.001 || u.uDark.value > 0.001 || u.uHurt.value > 0.001 || u.uBreath.value > 0.001 || u.uFlash.value > 0.001) {
      const ac = this.renderer.autoClear;
      this.renderer.autoClear = false;
      this.renderer.render(this.overlayScene, this.overlayCam);
      this.renderer.autoClear = ac;
    }
  }
}
