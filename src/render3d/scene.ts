import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { BLOCKED, CAP, EMPTY, JamState, LevelDef, MoveEvent, reachable, visibleRowMask } from '../game/jam';
import { blob, colored, easeInOut, hash, popScale, shaded, tint, toyMaterial } from './toy';

/**
 * The diorama: a grassy yard of critters, a road at the back with the current
 * vehicle and the queue, and a bench between them. Draws a JamState and plays
 * the choreography for the events each tap produces. The sim is the truth;
 * animation only ever catches up to it.
 */

/** Critter colour palette, bright and far apart so groups read at a glance. */
export const COLORS = [0xff5a5a, 0x4fa3ff, 0x58d35a, 0xffcf3d, 0xb86bff, 0xff8a3d, 0x3fd6d0, 0xff6fc1];

const ROAD_Z = 0;
const BENCH_Z = 1.45;
const GRID_Z0 = 2.9;
const CELL = 1;
const SEAT_X = [-0.55, 0, 0.55];

interface Actor {
  id: number;
  color: number;
  pos: THREE.Vector3;
  from: THREE.Vector3;
  to: THREE.Vector3;
  /** Waypoints still to walk after the current segment. */
  path: THREE.Vector3[];
  t0: number;
  t1: number;
  state: 'yard' | 'walking' | 'bench' | 'aboard' | 'gone';
  cell: number;
  benchSlot: number;
  seat: number;
  vehicle: number;
  facing: number;
  hop: number;
  scale: number;
  /** Seconds per waypoint for the current walk. */
  segDur: number;
}

interface Vehicle {
  idx: number;
  color: number;
  group: THREE.Group;
  x: number;
  targetX: number;
  t0: number;
  t1: number;
  gone: boolean;
}

export class JamScene {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(42, 0.5, 0.5, 200);
  private uTime = { value: 0 };
  private toy = toyMaterial(this.uTime, { rim: 0.3 });
  private world: THREE.Group | null = null;
  private fur!: THREE.InstancedMesh;
  private face!: THREE.InstancedMesh;
  private actors: Actor[] = [];
  private vehicles: Vehicle[] = [];
  private benchMesh!: THREE.Group;
  private pickPlane = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshBasicMaterial({ visible: false }));
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private def: LevelDef | null = null;
  private tmp = new THREE.Object3D();
  private col = new THREE.Color();
  private puffs: { p: THREE.Vector3; v: THREE.Vector3; t0: number; life: number; size: number; color: number }[] = [];
  private puffMesh!: THREE.InstancedMesh;
  private highlightCell = -1;
  private highlight!: THREE.Mesh;
  private w = 1;
  private h = 1;
  private now = 0;
  /** Choreography cursor: when the next event may start. */
  private cursor = 0;
  private bump = 0;
  /** Called when an event's animation actually starts, for sound/UI timing. */
  onCue: ((e: MoveEvent) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const sun = new THREE.DirectionalLight(0xfff0d8, 2.3);
    sun.position.set(-6, 14, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 14, bottom: -14, near: 1, far: 60 });
    sun.shadow.radius = 4;
    sun.shadow.blurSamples = 8;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun, new THREE.HemisphereLight(0xd8ecff, 0x8ab86a, 1.25));
    this.scene.background = new THREE.Color(0xa9ddff);
    this.pickPlane.rotation.x = -Math.PI / 2;
    this.scene.add(this.pickPlane);
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.w = cssW;
    this.h = cssH;
    this.renderer.setPixelRatio(Math.min(dpr, 2));
    this.renderer.setSize(cssW, cssH, false);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.camera.aspect = cssW / cssH;
    this.camera.updateProjectionMatrix();
    if (this.def) this.frameCamera(this.def);
  }

  /** The yard cell under a screen point, or -1. */
  pick(px: number, py: number): number {
    if (!this.def) return -1;
    this.ndc.set((px / this.w) * 2 - 1, -(py / this.h) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.pickPlane, false)[0];
    if (!hit) return -1;
    const { cols, rows } = this.def;
    const cx = Math.round(hit.point.x / CELL + (cols - 1) / 2);
    const r = Math.round((hit.point.z - GRID_Z0) / CELL);
    if (cx < 0 || cx >= cols || r < 0 || r >= rows) return -1;
    return r * cols + cx;
  }

  setHighlight(cell: number): void {
    this.highlightCell = cell;
  }

  /** A little shake when a tap is refused. */
  nudge(): void {
    this.bump = 1;
  }

  // ---------------------------------------------------------------- build

  load(s: JamState): void {
    const def = s.def;
    this.def = def;
    if (this.world) this.scene.remove(this.world);
    const g = new THREE.Group();
    this.world = g;
    this.scene.add(g);
    this.actors = [];
    this.vehicles = [];
    this.puffs = [];
    this.cursor = 0;

    this.buildGround(def, g);
    this.buildVehicles(def, g);
    this.buildBench(def, g);

    // Critters: tinted fur plus an untinted face, instanced.
    const { fur, face } = critterGeometry();
    const n = def.cols * def.rows;
    this.fur = new THREE.InstancedMesh(fur, this.toy, n);
    this.face = new THREE.InstancedMesh(face, this.toy, n);
    for (const m of [this.fur, this.face]) {
      m.castShadow = true;
      m.frustumCulled = false;
      g.add(m);
    }
    for (let i = 0; i < n; i++) {
      const c = def.cells[i];
      if (c < 0) continue;
      const p = this.cellPos(i);
      this.actors.push({
        id: i, color: c, pos: p.clone(), from: p.clone(), to: p.clone(), path: [], t0: 0, t1: 0,
        state: 'yard', cell: i, benchSlot: -1, seat: -1, vehicle: -1, facing: 0, hop: hash(i, 3) * 6, scale: 0.92 + hash(i, 9) * 0.16, segDur: 0.1,
      });
    }
    this.puffMesh = new THREE.InstancedMesh(blob(1, 1), new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthWrite: false }), 120);
    this.puffMesh.count = 0;
    this.puffMesh.frustumCulled = false;
    g.add(this.puffMesh);
    this.highlight = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.52, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }));
    this.highlight.visible = false;
    g.add(this.highlight);
    this.frameCamera(def);
    this.syncHidden(s);
  }

  private cellPos(cell: number): THREE.Vector3 {
    const { cols } = this.def!;
    const x = cell % cols;
    const r = (cell - x) / cols;
    return new THREE.Vector3((x - (cols - 1) / 2) * CELL, 0, GRID_Z0 + r * CELL);
  }

  private benchPos(slot: number, slots: number): THREE.Vector3 {
    return new THREE.Vector3((slot - (slots - 1) / 2) * 0.78, 0.28, BENCH_Z);
  }

  private frameCamera(def: LevelDef): void {
    // Fit the yard plus the road into a portrait view, looking down from the front.
    const depth = GRID_Z0 + def.rows * CELL + 1;
    const width = Math.max(def.cols * CELL + 1.5, 6.5);
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const pitch = THREE.MathUtils.degToRad(56);
    const distW = width / 2 / Math.tan(hfov / 2);
    const distD = (depth * 0.56) / Math.tan(vfov / 2);
    const dist = Math.max(distW, distD) * 1.02;
    const cz = depth * 0.47;
    this.camera.position.set(0, Math.sin(pitch) * dist, cz + Math.cos(pitch) * dist);
    this.camera.lookAt(0, 0, cz);
    this.camera.updateProjectionMatrix();
  }

  private buildGround(def: LevelDef, g: THREE.Group): void {
    const parts: THREE.BufferGeometry[] = [];
    const { cols, rows } = def;
    const W = cols * CELL + 3;
    const D = GRID_Z0 + rows * CELL + 2.5;
    // Island slab.
    const slab = new RoundedBoxGeometry(W + 2, 1.4, D + 1.5, 3, 0.5);
    slab.translate(0, -0.72, D / 2 - 0.6);
    parts.push(shaded(slab, 0x7fcf4a, 0x8a6a45, -1.4, 0));
    // Yard tiles: a soft checker so the grid reads.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const p = this.cellPos(i);
        if (def.cells[i] === BLOCKED) {
          // Scenery: a bush or a rock.
          if (hash(c, r, def.id) < 0.5) {
            const b = blob(0.42, 2, 0.15, i);
            b.scale(1, 0.85, 1);
            b.translate(p.x, 0.32, p.z);
            parts.push(shaded(b, 0x6fcf4a, 0x2f8a35, 0, 0.7));
            const b2 = blob(0.3, 2, 0.15, i + 7);
            b2.translate(p.x + 0.25, 0.42, p.z - 0.15);
            parts.push(shaded(b2, 0x8ae05a, 0x3f9a3a, 0.1, 0.75));
          } else {
            const s = blob(0.4, 2, 0.3, i);
            s.scale(1.15, 0.7, 1);
            s.translate(p.x, 0.22, p.z);
            parts.push(shaded(s, 0xd8c9ab, 0x9c8a6e, -0.1, 0.5));
          }
          continue;
        }
        const tile = new RoundedBoxGeometry(CELL - 0.08, 0.12, CELL - 0.08, 2, 0.04);
        tile.translate(p.x, -0.04, p.z);
        const light = (c + r) % 2 === 0;
        parts.push(colored(tile, light ? 0x9ddc5f : 0x92d456));
      }
    }
    // Road.
    const road = new RoundedBoxGeometry(W + 6, 0.12, 1.6, 2, 0.05);
    road.translate(0, -0.03, ROAD_Z);
    parts.push(colored(road, 0x6d6a75));
    for (let x = -W / 2 - 3; x < W / 2 + 3; x += 0.9) {
      const dash = new THREE.BoxGeometry(0.45, 0.02, 0.08);
      dash.translate(x, 0.04, ROAD_Z);
      parts.push(colored(dash, 0xfff3c4));
    }
    // Kerb and bench strip.
    const strip = new RoundedBoxGeometry(cols * CELL + 1.2, 0.1, 1.0, 2, 0.04);
    strip.translate(0, -0.02, BENCH_Z);
    parts.push(colored(strip, 0xe8d9b5));
    // A few trees round the back and sides for depth.
    for (let k = 0; k < 7; k++) {
      const x = (hash(k, 1, def.id) - 0.5) * (W + 2);
      const z = D + 0.6 + hash(k, 2, def.id) * 1.2;
      parts.push(...tree(x, 0, z, 0.9 + hash(k, 3, def.id) * 0.5, k));
    }
    for (const side of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        const z = GRID_Z0 + 1 + k * (rows / 3) * CELL;
        parts.push(...tree(side * (W / 2 + 0.6), 0, z, 0.7 + hash(k, side + 5, def.id) * 0.4, k + 20 + side));
      }
    }
    const mesh = new THREE.Mesh(mergeGeometries(parts), this.toy);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    g.add(mesh);
  }

  private buildBench(def: LevelDef, g: THREE.Group): void {
    this.benchMesh = new THREE.Group();
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < def.benchSlots; i++) {
      const p = this.benchPos(i, def.benchSlots);
      const seat = new RoundedBoxGeometry(0.62, 0.12, 0.62, 2, 0.05);
      seat.translate(p.x, 0.2, p.z);
      parts.push(shaded(seat, 0xd98a52, 0x9a5a30, 0.1, 0.3));
      for (const [dx, dz] of [[-0.22, -0.22], [0.22, -0.22], [-0.22, 0.22], [0.22, 0.22]]) {
        const leg = new THREE.CylinderGeometry(0.04, 0.04, 0.2, 8);
        leg.translate(p.x + dx, 0.1, p.z + dz);
        parts.push(colored(leg, 0x7a4a28));
      }
    }
    const m = new THREE.Mesh(mergeGeometries(parts), this.toy);
    m.castShadow = true;
    this.benchMesh.add(m);
    g.add(this.benchMesh);
  }

  private buildVehicles(def: LevelDef, g: THREE.Group): void {
    def.vehicles.forEach((color, idx) => {
      const group = vehicleModel(COLORS[color], this.toy);
      const x = idx === 0 ? 0 : 4.2 + (idx - 1) * 3.4;
      group.position.set(x, 0, ROAD_Z);
      group.visible = idx < 4;
      g.add(group);
      this.vehicles.push({ idx, color, group, x, targetX: x, t0: 0, t1: 0, gone: false });
    });
  }

  // ----------------------------------------------------------- choreography

  /** Schedule the animations for one tap's events. */
  play(s: JamState, events: MoveEvent[]): void {
    const now = this.now;
    if (this.cursor < now) this.cursor = now;
    for (const e of events) {
      const at = this.cursor;
      switch (e.type) {
        case 'board': {
          const a = this.actor(e.cell);
          const v = this.vehicles[s.vehicleIdx === 0 && s.fill === 0 ? 0 : this.currentVehicleFor(a)];
          this.walk(a, this.walkPath(a.cell, s), at, 0.09);
          this.boardSeat(a, v, s);
          this.cursor = at + 0.12;
          break;
        }
        case 'bench': {
          const a = this.actor(e.cell);
          this.walk(a, this.walkPath(a.cell, s), at, 0.09);
          a.state = 'bench';
          a.benchSlot = this.freeBenchSlot();
          a.path.push(this.benchPos(a.benchSlot, s.def.benchSlots));
          this.cursor = at + 0.12;
          break;
        }
        case 'benchBoard': {
          // The first n benched critters of this colour get up and board.
          let n = e.n;
          for (const a of this.actors) {
            if (n === 0) break;
            if (a.state === 'bench' && a.color === e.color) {
              const v = this.vehicles.find((v) => !v.gone && v.color === e.color && this.seatCount(v) < CAP);
              a.benchSlot = -1;
              this.startSegment(a, [a.pos.clone().add(new THREE.Vector3(0, 0, -0.6))], at + 0.1, 0.15);
              if (v) this.boardSeat(a, v, s);
              n--;
            }
          }
          this.compactBench(s.def.benchSlots, at + 0.2);
          this.cursor = at + 0.25;
          break;
        }
        case 'depart': {
          const v = this.vehicles.find((v) => !v.gone && v.color === e.color && this.seatCount(v) >= CAP) ?? this.vehicles.find((v) => !v.gone);
          if (v) {
            v.gone = true;
            v.t0 = at + 0.25;
            v.t1 = at + 0.95;
            v.targetX = -14;
            for (const a of this.actors) if (a.state === 'aboard' && a.vehicle === v.idx) a.state = 'gone';
          }
          this.cursor = at + 0.3;
          break;
        }
        case 'arrive': {
          let k = 0;
          for (const v of this.vehicles) {
            if (v.gone) continue;
            v.group.visible = k < 4;
            v.targetX = k === 0 ? 0 : 4.2 + (k - 1) * 3.4;
            v.t0 = at + 0.3;
            v.t1 = at + 0.9;
            k++;
          }
          this.cursor = at + 0.5;
          break;
        }
        case 'won':
        case 'lost':
          break;
      }
      const cue = e;
      const delay = Math.max(0, at - now);
      window.setTimeout(() => this.onCue?.(cue), delay * 1000);
    }
    this.syncHidden(s);
  }

  private actor(cell: number): Actor {
    return this.actors.find((a) => a.cell === cell && a.state === 'yard')!;
  }

  private currentVehicleFor(a: Actor): number {
    const v = this.vehicles.find((v) => !v.gone && v.color === a.color && this.seatCount(v) < CAP);
    return v ? v.idx : this.vehicles.findIndex((v) => !v.gone);
  }

  private seatCount(v: Vehicle): number {
    let n = 0;
    for (const a of this.actors) if ((a.state === 'aboard' || a.state === 'gone') && a.vehicle === v.idx) n++;
    return n;
  }

  private boardSeat(a: Actor, v: Vehicle, s: JamState): void {
    const seat = this.seatCount(v);
    a.state = 'aboard';
    a.vehicle = v.idx;
    a.seat = Math.min(CAP - 1, seat);
    a.cell = -1;
    void s;
    a.path.push(new THREE.Vector3(v.x + SEAT_X[a.seat], 0.95, ROAD_Z + 0.1));
  }

  private freeBenchSlot(): number {
    const used = new Set(this.actors.filter((a) => a.state === 'bench').map((a) => a.benchSlot));
    let i = 0;
    while (used.has(i)) i++;
    return i;
  }

  private compactBench(slots: number, at: number): void {
    const seated = this.actors.filter((a) => a.state === 'bench' && a.benchSlot >= 0).sort((x, y) => x.benchSlot - y.benchSlot);
    seated.forEach((a, i) => {
      if (a.benchSlot !== i) {
        a.benchSlot = i;
        this.startSegment(a, [this.benchPos(i, slots)], at, 0.25);
      }
    });
  }

  /** Waypoints from a yard cell out to the front, through empty cells. */
  private walkPath(cell: number, s: JamState): THREE.Vector3[] {
    const { cols, rows } = s.def;
    // BFS over empty cells from the front row to this cell, then read back the chain.
    const prev = new Int32Array(cols * rows).fill(-2);
    const q: number[] = [];
    for (let c = 0; c < cols; c++) {
      if (s.cells[c] === EMPTY || c === cell) {
        prev[c] = -1;
        q.push(c);
      }
    }
    while (q.length) {
      const i = q.shift()!;
      if (i === cell) break;
      const x = i % cols;
      const y = (i - x) / cols;
      for (const j of [x > 0 ? i - 1 : -1, x < cols - 1 ? i + 1 : -1, y > 0 ? i - cols : -1, y < rows - 1 ? i + cols : -1]) {
        if (j < 0 || prev[j] !== -2) continue;
        if (s.cells[j] === EMPTY || j === cell) {
          prev[j] = i;
          q.push(j);
        }
      }
    }
    const pts: THREE.Vector3[] = [];
    let i = cell;
    let guard = 0;
    while (i >= 0 && guard++ < 200) {
      pts.push(this.cellPos(i));
      i = prev[i];
    }
    pts.shift(); // the critter's own cell
    const last = pts.length ? pts[pts.length - 1] : this.cellPos(cell);
    pts.push(new THREE.Vector3(last.x, 0, GRID_Z0 - 0.8));
    return pts;
  }

  private walk(a: Actor, path: THREE.Vector3[], at: number, perCell: number): void {
    a.state = 'walking';
    this.startSegment(a, path, at, perCell * Math.max(1, path.length));
  }

  private startSegment(a: Actor, path: THREE.Vector3[], at: number, duration: number): void {
    a.from.copy(a.pos);
    a.path = path.slice();
    a.to.copy(a.path.shift() ?? a.pos);
    a.t0 = at;
    a.t1 = at + duration / Math.max(1, path.length);
    a.segDur = a.t1 - a.t0;
  }

  private syncHidden(s: JamState): void {
    this.hiddenMask = visibleRowMask(s);
    this.reach = reachable(s);
    this.state = s;
  }
  private hiddenMask: boolean[] = [];
  private reach: Uint8Array = new Uint8Array(0);
  private state: JamState | null = null;

  // ---------------------------------------------------------------- frame

  render(t: number): void {
    this.now = t;
    this.uTime.value = t;
    if (!this.def) return;
    const dt = 1 / 60;
    this.bump = Math.max(0, this.bump - dt * 6);
    this.camera.position.x = Math.sin(t * 60) * this.bump * 0.08;

    // Vehicles slide.
    for (const v of this.vehicles) {
      if (v.x !== v.targetX) {
        const k = v.t1 > v.t0 ? THREE.MathUtils.clamp((t - v.t0) / (v.t1 - v.t0), 0, 1) : 1;
        v.x = THREE.MathUtils.lerp(v.group.position.x, v.targetX, k >= 1 ? 1 : 0.12);
        if (Math.abs(v.x - v.targetX) < 0.002) v.x = v.targetX;
        v.group.position.x = v.x;
        // Wheels bob a touch while moving.
        v.group.position.y = Math.abs(Math.sin(t * 30)) * 0.02 * (v.x !== v.targetX ? 1 : 0);
      }
    }

    // Critters.
    const cols = this.def.cols;
    let n = 0;
    for (const a of this.actors) {
      if (a.state === 'gone') continue;
      // Advance along the path.
      if (t >= a.t0 && (a.state === 'walking' || a.path.length || !a.pos.equals(a.to))) {
        const k = a.t1 > a.t0 ? THREE.MathUtils.clamp((t - a.t0) / (a.t1 - a.t0), 0, 1) : 1;
        a.pos.lerpVectors(a.from, a.to, a.state === 'walking' ? k : easeInOut(k));
        const dir = a.to.clone().sub(a.from);
        if (dir.lengthSq() > 1e-4) a.facing = Math.atan2(dir.x, dir.z);
        if (k >= 1) {
          if (a.path.length) {
            a.from.copy(a.to);
            a.to.copy(a.path.shift()!);
            a.t0 = t;
            a.t1 = t + a.segDur;
          } else if (a.state === 'walking') a.state = 'bench';
        }
      }
      // Aboard a departing vehicle: ride along.
      if (a.state === 'aboard') {
        const v = this.vehicles[a.vehicle];
        if (v && !a.path.length && t >= a.t1) a.pos.set(v.x + SEAT_X[a.seat], 0.95, ROAD_Z + 0.1);
      }
      const moving = a.state === 'walking' || (a.path.length > 0 && t >= a.t0);
      const row = a.cell >= 0 ? Math.floor(a.cell / cols) : 0;
      const hidden = a.state === 'yard' && !this.hiddenMask[row];
      const idle = Math.sin(t * 3 + a.hop) * 0.02;
      const bob = moving ? Math.abs(Math.sin(t * 22 + a.hop)) * 0.09 : idle;
      const squash = moving ? 1 + Math.sin(t * 22 + a.hop) * 0.06 : 1 + idle * 2;
      // Waiting critters look at the player; walking ones face where they're going.
      const face = a.state === 'yard' && !moving ? 0 : a.facing;
      // Reachable critters in the yard stand a touch taller and glance at the road.
      const ready = a.state === 'yard' && this.reach[a.cell] === 1 && !hidden;
      this.tmp.position.set(a.pos.x, a.pos.y + bob, a.pos.z);
      this.tmp.rotation.set(0, face, moving ? Math.sin(t * 22 + a.hop) * 0.05 : 0);
      this.tmp.scale.set(a.scale / Math.sqrt(squash), a.scale * squash * (ready ? 1.04 : 1), a.scale / Math.sqrt(squash));
      this.tmp.updateMatrix();
      this.fur.setMatrixAt(n, this.tmp.matrix);
      this.fur.setColorAt(n, this.col.set(hidden ? 0x9aa0a8 : COLORS[a.color]));
      if (hidden) this.tmp.scale.setScalar(0.0001);
      this.tmp.updateMatrix();
      this.face.setMatrixAt(n, this.tmp.matrix);
      n++;
    }
    this.fur.count = this.face.count = n;
    this.fur.instanceMatrix.needsUpdate = true;
    this.face.instanceMatrix.needsUpdate = true;
    if (this.fur.instanceColor) this.fur.instanceColor.needsUpdate = true;

    // Tap highlight.
    if (this.highlightCell >= 0 && this.state && this.state.cells[this.highlightCell] >= 0) {
      const p = this.cellPos(this.highlightCell);
      this.highlight.position.set(p.x, 0.05, p.z);
      this.highlight.visible = true;
      (this.highlight.material as THREE.MeshBasicMaterial).opacity = 0.5 + Math.sin(t * 8) * 0.3;
    } else this.highlight.visible = false;

    // Dust puffs.
    this.puffs = this.puffs.filter((p) => t - p.t0 < p.life);
    this.puffs.forEach((p, i) => {
      const q = (t - p.t0) / p.life;
      p.p.addScaledVector(p.v, dt);
      this.tmp.position.copy(p.p);
      this.tmp.rotation.set(0, 0, 0);
      this.tmp.scale.setScalar(Math.max(0.001, p.size * popScale(Math.min(1, q * 3)) * (1 - q)));
      this.tmp.updateMatrix();
      this.puffMesh.setMatrixAt(i, this.tmp.matrix);
    });
    this.puffMesh.count = this.puffs.length;
    this.puffMesh.instanceMatrix.needsUpdate = true;

    this.renderer.render(this.scene, this.camera);
  }

  /** Sparkle where a critter boards. */
  burst(x: number, z: number, color: number, n = 6): void {
    for (let i = 0; i < n && this.puffs.length < 120; i++) {
      const a = Math.random() * Math.PI * 2;
      this.puffs.push({
        p: new THREE.Vector3(x, 0.5, z),
        v: new THREE.Vector3(Math.cos(a) * 1.5, 1.5 + Math.random(), Math.sin(a) * 1.5),
        t0: this.now,
        life: 0.4 + Math.random() * 0.3,
        size: 0.08 + Math.random() * 0.08,
        color,
      });
    }
  }

  /** World position of the current vehicle's seats, for effects. */
  vehicleSpot(): { x: number; z: number } {
    const v = this.vehicles.find((v) => !v.gone);
    return { x: v ? v.x : 0, z: ROAD_Z };
  }
}

// ----------------------------------------------------------------- models

/** A round little critter facing +z: body, head, ears, and a separate face. */
function critterGeometry(): { fur: THREE.BufferGeometry; face: THREE.BufferGeometry } {
  const white = 0xffffff;
  const furParts: THREE.BufferGeometry[] = [];
  const body = blob(0.3, 2);
  body.scale(1, 0.95, 0.95);
  body.translate(0, 0.32, 0);
  furParts.push(colored(body, white));
  const head = blob(0.26, 2);
  head.translate(0, 0.68, 0.05);
  furParts.push(colored(head, white));
  for (const s of [-1, 1]) {
    const ear = blob(0.1, 2);
    ear.scale(0.8, 1.3, 0.6);
    ear.rotateZ(-s * 0.35);
    ear.translate(s * 0.2, 0.92, 0);
    furParts.push(colored(ear, white));
    const paw = blob(0.09, 1);
    paw.translate(s * 0.17, 0.08, 0.14);
    furParts.push(colored(paw, white));
  }
  const tail = blob(0.09, 1);
  tail.translate(0, 0.3, -0.3);
  furParts.push(colored(tail, white));

  const faceParts: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    const eye = blob(0.065, 2);
    eye.translate(s * 0.1, 0.72, 0.26);
    faceParts.push(colored(eye, 0xffffff));
    const pupil = blob(0.038, 1);
    pupil.translate(s * 0.1, 0.72, 0.305);
    faceParts.push(colored(pupil, 0x1b1b22));
    const glint = blob(0.013, 1);
    glint.translate(s * 0.085, 0.745, 0.33);
    faceParts.push(colored(glint, 0xffffff));
    const inner = blob(0.05, 1);
    inner.scale(0.7, 1.1, 0.4);
    inner.translate(s * 0.2, 0.92, 0.06);
    faceParts.push(colored(inner, 0xffb6c1));
    const cheek = blob(0.04, 1);
    cheek.scale(1, 0.6, 0.4);
    cheek.translate(s * 0.19, 0.64, 0.24);
    faceParts.push(colored(cheek, 0xff9aa8));
  }
  const nose = blob(0.035, 1);
  nose.scale(1.3, 0.8, 0.8);
  nose.translate(0, 0.655, 0.3);
  faceParts.push(colored(nose, 0x3a2a2a));
  const belly = blob(0.18, 2);
  belly.scale(1, 1.1, 0.5);
  belly.translate(0, 0.3, 0.22);
  faceParts.push(colored(belly, 0xfff4ea));
  return { fur: mergeGeometries(furParts), face: mergeGeometries(faceParts) };
}

/** A rounded toy bus in the given colour, facing -x (it drives off to the left). */
function vehicleModel(color: number, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const parts: THREE.BufferGeometry[] = [];
  const body = new RoundedBoxGeometry(2.1, 0.8, 1.0, 3, 0.22);
  body.translate(0, 0.62, 0);
  parts.push(shaded(body, tint(color, 0xffffff, 0.15), tint(color, 0x000000, 0.25), 0.2, 1.05));
  const roof = new RoundedBoxGeometry(1.7, 0.16, 0.95, 2, 0.07);
  roof.translate(0, 1.05, 0);
  parts.push(shaded(roof, 0xffffff, 0xe6e6ea, 0.95, 1.15));
  for (const x of [-0.65, -0.05, 0.55]) {
    const win = new RoundedBoxGeometry(0.42, 0.3, 1.04, 2, 0.06);
    win.translate(x, 0.72, 0);
    parts.push(colored(win, 0xbfe9ff));
  }
  const front = new RoundedBoxGeometry(0.2, 0.3, 0.9, 2, 0.06);
  front.translate(-1.02, 0.75, 0);
  parts.push(colored(front, 0xbfe9ff));
  for (const z of [-0.42, 0.42]) {
    for (const x of [-0.62, 0.62]) {
      const wheel = new THREE.CylinderGeometry(0.2, 0.2, 0.16, 16);
      wheel.rotateX(Math.PI / 2);
      wheel.translate(x, 0.2, z);
      parts.push(colored(wheel, 0x2d2d33));
      const hub = new THREE.CylinderGeometry(0.09, 0.09, 0.18, 10);
      hub.rotateX(Math.PI / 2);
      hub.translate(x, 0.2, z);
      parts.push(colored(hub, 0xe8e8ee));
    }
  }
  for (const z of [-0.3, 0.3]) {
    const lamp = blob(0.07, 1);
    lamp.translate(-1.06, 0.5, z);
    parts.push(colored(lamp, 0xfff2b0));
  }
  const m = new THREE.Mesh(mergeGeometries(parts), mat);
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return g;
}

function tree(x: number, y: number, z: number, r: number, seed: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const h = 0.9 + r * 0.6;
  const trunk = new THREE.CylinderGeometry(0.1 + r * 0.05, 0.16 + r * 0.06, h, 10);
  trunk.translate(x, y + h / 2, z);
  out.push(shaded(trunk, 0xa06c3e, 0x7a4f2c, y, y + h));
  const cy = y + h + r * 0.5;
  for (const [dx, dy, dz, k] of [[0, 0, 0, 1], [0.5, -0.1, 0.2, 0.7], [-0.45, 0.05, -0.1, 0.65], [0.1, 0.5, -0.2, 0.6]]) {
    const b = blob(r * k, 2, 0.12, seed + k * 10);
    b.translate(x + dx * r, cy + dy * r, z + dz * r);
    out.push(shaded(b, 0x8fdc55, 0x2f8a35, cy - r, cy + r));
  }
  return out;
}
