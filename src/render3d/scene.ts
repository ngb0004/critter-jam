import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { BLOCKED, CAP, EMPTY, JamState, LevelDef, MoveEvent, WILD, reachable, visibleRowMask } from '../game/jam';
import { blob, colored, easeInOut, hash, popScale, shaded, tint, toyMaterial } from './toy';

/**
 * The diorama. A grid of pieces, a track at the back where the current
 * collector waits with the queue behind it, and a tray between them. Draws a
 * JamState and plays the choreography for the events each tap produces.
 * The sim is the truth; animation only ever catches up to it.
 *
 * Two skins share the code: "gems" (gems, mine carts on rails, a stone
 * floor; the default) and "critters" (animals, buses, grass).
 */

export type SkinName = 'gems' | 'critters';

/** Piece colours: bright and far apart so groups read at a glance. */
export const COLORS = [0xff4d6d, 0x3d9bff, 0x3ed66a, 0xffc93c, 0xb56cff, 0xff8a3d, 0x2fd6d0, 0xff6fc1];

interface Skin {
  name: SkinName;
  title: string;
  tagline: string;
  sky: number;
  /** Pieces slide (gems) or walk with a bob (critters). */
  motion: 'slide' | 'walk';
  seatY: number;
}

export const SKINS: Record<SkinName, Skin> = {
  gems: { name: 'gems', title: 'Gem Jam', tagline: 'Tap a gem. Fill the cart.', sky: 0x1e2a44, motion: 'slide', seatY: 0.78 },
  critters: { name: 'critters', title: 'Critter Jam', tagline: 'Tap a critter. Fill the bus.', sky: 0xa9ddff, motion: 'walk', seatY: 0.95 },
};

const ROAD_Z = 0;
const BENCH_Z = 1.45;
const GRID_Z0 = 2.9;
const CELL = 1;
const SEAT_X = [-0.55, 0, 0.55];
/** Seconds per tile when a piece leaves the yard, and for the hop onto its seat. */
const STEP = 0.14;
const HOP = 0.3;

interface Actor {
  id: number;
  color: number;
  pos: THREE.Vector3;
  from: THREE.Vector3;
  to: THREE.Vector3;
  /** Waypoints still to travel after the current segment. */
  path: THREE.Vector3[];
  t0: number;
  t1: number;
  /** Seconds per waypoint for the current trip. */
  segDur: number;
  /** Arc height for the final hop. */
  arc: number;
  state: 'yard' | 'moving' | 'bench' | 'aboard' | 'gone';
  cell: number;
  benchSlot: number;
  seat: number;
  vehicle: number;
  facing: number;
  phase: number;
  scale: number;
}

interface Vehicle {
  idx: number;
  color: number;
  group: THREE.Group;
  lid: THREE.Object3D | null;
  x: number;
  targetX: number;
  t0: number;
  t1: number;
  gone: boolean;
  /** 0 open, 1 closed. */
  lidT: number;
}

export class JamScene {
  readonly canvas: HTMLCanvasElement;
  readonly skin: Skin;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(42, 0.5, 0.5, 200);
  private uTime = { value: 0 };
  private toy = toyMaterial(this.uTime, { rim: 0.3 });
  private gemMat = new THREE.MeshPhongMaterial({ vertexColors: true, flatShading: true, shininess: 110, specular: 0xffffff });
  private world: THREE.Group | null = null;
  private body!: THREE.InstancedMesh;
  private detail!: THREE.InstancedMesh;
  private rings!: THREE.InstancedMesh;
  /** Gold halos under magnet pieces. */
  private halos!: THREE.InstancedMesh;
  private actors: Actor[] = [];
  private vehicles: Vehicle[] = [];
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
  private nextId = 100_000;
  private hiddenMask: boolean[] = [];
  private reach: Uint8Array = new Uint8Array(0);
  private state: JamState | null = null;
  /** Called when an event's animation actually starts, for sound/UI timing. */
  onCue: ((e: MoveEvent) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, skin: SkinName = 'gems') {
    this.canvas = canvas;
    this.skin = SKINS[skin];
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const gems = this.skin.name === 'gems';
    const sun = new THREE.DirectionalLight(gems ? 0xfff4e0 : 0xfff0d8, gems ? 2.6 : 2.3);
    sun.position.set(-6, 14, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 14, bottom: -14, near: 1, far: 60 });
    sun.shadow.radius = 4;
    sun.shadow.blurSamples = 8;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun, new THREE.HemisphereLight(gems ? 0x9fb6e8 : 0xd8ecff, gems ? 0x4a3a30 : 0x8ab86a, gems ? 1.0 : 1.25));
    if (gems) {
      // A warm lantern glow from the front so gem facets catch light from two sides.
      const lamp = new THREE.PointLight(0xffc98a, 40, 30, 2);
      lamp.position.set(2, 5, 9);
      this.scene.add(lamp);
    }
    this.scene.background = new THREE.Color(this.skin.sky);
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

  /** Builds the picture from the live state: pieces in the yard, on the tray, and aboard the current collector. */
  load(s: JamState): void {
    const def = s.def;
    this.def = def;
    if (this.world) {
      this.scene.remove(this.world);
      this.world.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    }
    const g = new THREE.Group();
    this.world = g;
    this.scene.add(g);
    this.actors = [];
    this.vehicles = [];
    this.puffs = [];
    this.cursor = 0;

    this.buildGround(def, g);
    this.buildVehicles(s, g);
    this.buildBench(def, g);

    const geos = this.skin.name === 'gems' ? gemGeometry() : critterGeometry();
    const n = def.cols * def.rows + def.benchSlots + CAP;
    const mat = this.skin.name === 'gems' ? this.gemMat : this.toy;
    this.body = new THREE.InstancedMesh(geos.body, mat, n);
    this.detail = new THREE.InstancedMesh(geos.detail, this.skin.name === 'gems' ? new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55 }) : this.toy, n);
    for (const m of [this.body, this.detail]) {
      m.castShadow = true;
      m.frustumCulled = false;
      g.add(m);
    }
    this.rings = new THREE.InstancedMesh(
      new THREE.RingGeometry(0.36, 0.46, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }),
      def.cols * def.rows,
    );
    this.rings.count = 0;
    this.rings.frustumCulled = false;
    g.add(this.rings);
    this.halos = new THREE.InstancedMesh(
      new THREE.RingGeometry(0.3, 0.5, 6).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffd36a, transparent: true, opacity: 0.8, depthWrite: false }),
      16,
    );
    this.halos.count = 0;
    this.halos.frustumCulled = false;
    g.add(this.halos);

    const mk = (id: number, color: number, p: THREE.Vector3): Actor => ({
      id, color, pos: p.clone(), from: p.clone(), to: p.clone(), path: [], t0: 0, t1: 0, segDur: STEP, arc: 0,
      state: 'yard', cell: -1, benchSlot: -1, seat: -1, vehicle: -1, facing: 0, phase: hash(id, 3) * 6, scale: 0.92 + hash(id, 9) * 0.16,
    });
    for (let i = 0; i < def.cols * def.rows; i++) {
      const c = s.cells[i];
      if (c < 0) continue;
      const a = mk(i, c, this.cellPos(i));
      a.cell = i;
      this.actors.push(a);
    }
    s.bench.forEach((c, slot) => {
      const a = mk(this.nextId++, c, this.benchPos(slot, def.benchSlots));
      a.state = 'bench';
      a.benchSlot = slot;
      this.actors.push(a);
    });
    const cur = this.vehicles.find((v) => !v.gone);
    if (cur) {
      for (let seat = 0; seat < s.fill; seat++) {
        const a = mk(this.nextId++, cur.color, new THREE.Vector3(cur.x + SEAT_X[seat], this.skin.seatY, ROAD_Z + 0.1));
        a.state = 'aboard';
        a.vehicle = cur.idx;
        a.seat = seat;
        this.actors.push(a);
      }
    }

    this.puffMesh = new THREE.InstancedMesh(
      this.skin.name === 'gems' ? new THREE.OctahedronGeometry(1, 0) : blob(1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }),
      120,
    );
    this.puffMesh.count = 0;
    this.puffMesh.frustumCulled = false;
    g.add(this.puffMesh);
    this.highlight = new THREE.Mesh(new THREE.RingGeometry(0.44, 0.54, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }));
    this.highlight.visible = false;
    g.add(this.highlight);
    this.frameCamera(def);
    this.sync(s);
  }

  private cellPos(cell: number): THREE.Vector3 {
    const { cols } = this.def!;
    const x = cell % cols;
    const r = (cell - x) / cols;
    return new THREE.Vector3((x - (cols - 1) / 2) * CELL, 0, GRID_Z0 + r * CELL);
  }

  private benchPos(slot: number, slots: number): THREE.Vector3 {
    return new THREE.Vector3((slot - (slots - 1) / 2) * 0.78, 0.26, BENCH_Z);
  }

  private frameCamera(def: LevelDef): void {
    // Fit the yard plus the track into a portrait view, looking down from the front.
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
    const gems = this.skin.name === 'gems';
    const parts: THREE.BufferGeometry[] = [];
    const { cols, rows } = def;
    const W = cols * CELL + 3;
    const D = GRID_Z0 + rows * CELL + 2.5;
    // Island slab.
    const slab = new RoundedBoxGeometry(W + 2, 1.4, D + 1.5, 3, 0.5);
    slab.translate(0, -0.72, D / 2 - 0.6);
    parts.push(gems ? shaded(slab, 0x5b5570, 0x2b2638, -1.4, 0) : shaded(slab, 0x7fcf4a, 0x8a6a45, -1.4, 0));
    // Yard tiles: a soft checker so the grid reads.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const p = this.cellPos(i);
        if (def.cells[i] === BLOCKED) {
          if (gems || hash(c, r, def.id) >= 0.5) {
            const s = blob(0.42, 2, 0.3, i);
            s.scale(1.15, 0.75, 1);
            s.translate(p.x, 0.25, p.z);
            parts.push(gems ? shaded(s, 0x8a8398, 0x3d3748, -0.1, 0.6) : shaded(s, 0xd8c9ab, 0x9c8a6e, -0.1, 0.5));
          } else {
            const b = blob(0.42, 2, 0.15, i);
            b.scale(1, 0.85, 1);
            b.translate(p.x, 0.32, p.z);
            parts.push(shaded(b, 0x6fcf4a, 0x2f8a35, 0, 0.7));
          }
          continue;
        }
        const tile = new RoundedBoxGeometry(CELL - 0.08, 0.12, CELL - 0.08, 2, 0.04);
        tile.translate(p.x, -0.04, p.z);
        const light = (c + r) % 2 === 0;
        parts.push(colored(tile, gems ? (light ? 0x6b6584 : 0x615b7a) : light ? 0x9ddc5f : 0x92d456));
      }
    }
    if (gems) {
      // Rails.
      for (const z of [ROAD_Z - 0.38, ROAD_Z + 0.38]) {
        const rail = new RoundedBoxGeometry(W + 6, 0.08, 0.1, 1, 0.03);
        rail.translate(0, 0.08, z);
        parts.push(colored(rail, 0xb9b4c4));
      }
      for (let x = -W / 2 - 3; x < W / 2 + 3; x += 0.7) {
        const tie = new RoundedBoxGeometry(0.28, 0.08, 1.1, 1, 0.03);
        tie.translate(x, 0.02, ROAD_Z);
        parts.push(colored(tie, 0x6b4a32));
      }
      const bed = new RoundedBoxGeometry(W + 6, 0.1, 1.7, 2, 0.04);
      bed.translate(0, -0.05, ROAD_Z);
      parts.push(colored(bed, 0x4a4458));
      // Tray strip.
      const strip = new RoundedBoxGeometry(cols * CELL + 1.2, 0.1, 1.0, 2, 0.04);
      strip.translate(0, -0.02, BENCH_Z);
      parts.push(colored(strip, 0x3a3448));
      // Wooden mine supports at the back and sides, and a few glowing crystals.
      for (let k = 0; k < 5; k++) {
        const x = (k / 4 - 0.5) * (W + 1);
        parts.push(...support(x, 0, D + 0.4, 3.2 + hash(k, 1, def.id) * 0.6));
      }
      for (const side of [-1, 1]) for (let k = 0; k < 3; k++) parts.push(...support(side * (W / 2 + 0.7), 0, GRID_Z0 + 1 + k * (rows / 3) * CELL, 2.6 + hash(k, side + 5, def.id) * 0.5));
      for (let k = 0; k < 9; k++) {
        const side = k % 2 ? -1 : 1;
        const x = side * (W / 2 + 0.2 + hash(k, 7, def.id) * 1.2);
        const z = GRID_Z0 - 0.5 + hash(k, 8, def.id) * (rows * CELL + 2);
        parts.push(crystal(x, -0.1, z, 0.25 + hash(k, 9, def.id) * 0.3, COLORS[k % COLORS.length], k));
      }
    } else {
      const road = new RoundedBoxGeometry(W + 6, 0.12, 1.6, 2, 0.05);
      road.translate(0, -0.03, ROAD_Z);
      parts.push(colored(road, 0x6d6a75));
      for (let x = -W / 2 - 3; x < W / 2 + 3; x += 0.9) {
        const dash = new THREE.BoxGeometry(0.45, 0.02, 0.08);
        dash.translate(x, 0.04, ROAD_Z);
        parts.push(colored(dash, 0xfff3c4));
      }
      const strip = new RoundedBoxGeometry(cols * CELL + 1.2, 0.1, 1.0, 2, 0.04);
      strip.translate(0, -0.02, BENCH_Z);
      parts.push(colored(strip, 0xe8d9b5));
      for (let k = 0; k < 7; k++) {
        const x = (hash(k, 1, def.id) - 0.5) * (W + 2);
        const z = D + 0.6 + hash(k, 2, def.id) * 1.2;
        parts.push(...tree(x, 0, z, 0.9 + hash(k, 3, def.id) * 0.5, k));
      }
      for (const side of [-1, 1]) for (let k = 0; k < 3; k++) parts.push(...tree(side * (W / 2 + 0.6), 0, GRID_Z0 + 1 + k * (rows / 3) * CELL, 0.7 + hash(k, side + 5, def.id) * 0.4, k + 20 + side));
    }
    const mesh = new THREE.Mesh(mergeGeometries(parts), this.toy);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    g.add(mesh);
  }

  private buildBench(def: LevelDef, g: THREE.Group): void {
    const gems = this.skin.name === 'gems';
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < def.benchSlots; i++) {
      const p = this.benchPos(i, def.benchSlots);
      if (gems) {
        const dish = new THREE.CylinderGeometry(0.34, 0.28, 0.14, 20);
        dish.translate(p.x, 0.12, p.z);
        parts.push(shaded(dish, 0xf0c060, 0x9a6a20, 0.05, 0.2));
        const hole = new THREE.CylinderGeometry(0.24, 0.24, 0.04, 20);
        hole.translate(p.x, 0.19, p.z);
        parts.push(colored(hole, 0x4a3a1c));
      } else {
        const seat = new RoundedBoxGeometry(0.62, 0.12, 0.62, 2, 0.05);
        seat.translate(p.x, 0.2, p.z);
        parts.push(shaded(seat, 0xd98a52, 0x9a5a30, 0.1, 0.3));
        for (const [dx, dz] of [[-0.22, -0.22], [0.22, -0.22], [-0.22, 0.22], [0.22, 0.22]]) {
          const leg = new THREE.CylinderGeometry(0.04, 0.04, 0.2, 8);
          leg.translate(p.x + dx, 0.1, p.z + dz);
          parts.push(colored(leg, 0x7a4a28));
        }
      }
    }
    const m = new THREE.Mesh(mergeGeometries(parts), this.toy);
    m.castShadow = true;
    g.add(m);
  }

  private buildVehicles(s: JamState, g: THREE.Group): void {
    const def = s.def;
    let k = 0;
    def.vehicles.forEach((color, idx) => {
      const gone = idx < s.vehicleIdx;
      const { group, lid } = this.skin.name === 'gems' ? cartModel(COLORS[color], this.toy) : busModel(COLORS[color], this.toy);
      const x = gone ? -14 : k === 0 ? 0 : 4.2 + (k - 1) * 3.4;
      group.position.set(x, 0, ROAD_Z);
      group.visible = !gone && k < 4;
      g.add(group);
      this.vehicles.push({ idx, color, group, lid, x, targetX: x, t0: 0, t1: 0, gone, lidT: 0 });
      if (!gone) k++;
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
          const a = this.yardActor(e.cell);
          const v = this.vehicles.find((v) => !v.gone && v.color === a.color && this.seatCount(v) < CAP) ?? this.vehicles.find((v) => !v.gone)!;
          const path = this.exitPath(a.cell, s);
          this.boardSeat(a, v);
          this.travel(a, path, at);
          this.cursor = at + 0.1;
          break;
        }
        case 'pull': {
          // Magnet: straight out of the yard and onto the seat, in one big arc.
          const a = this.yardActor(e.cell);
          const v = this.vehicles.find((v) => !v.gone && this.seatCount(v) < CAP) ?? this.vehicles.find((v) => !v.gone)!;
          this.boardSeat(a, v);
          this.travel(a, [], at, 1.6);
          this.cursor = at + 0.12;
          break;
        }
        case 'bench': {
          const a = this.yardActor(e.cell);
          const path = this.exitPath(a.cell, s);
          a.state = 'bench';
          a.benchSlot = this.freeBenchSlot();
          a.cell = -1;
          path.push(this.benchPos(a.benchSlot, s.def.benchSlots));
          this.travel(a, path, at);
          this.cursor = at + 0.1;
          break;
        }
        case 'benchBoard': {
          let n = e.n;
          const v = this.vehicles.find((v) => !v.gone && v.color === e.color && this.seatCount(v) < CAP);
          for (const a of this.actors) {
            if (n === 0) break;
            if (a.state === 'bench' && a.color === e.color) {
              a.benchSlot = -1;
              if (v) this.boardSeat(a, v);
              this.travel(a, [], at + 0.1);
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
            v.t0 = at + HOP + 0.25;
            v.t1 = v.t0 + 0.7;
            v.targetX = -14;
            for (const a of this.actors) if (a.state === 'aboard' && a.vehicle === v.idx) a.state = 'gone';
          }
          this.cursor = at + 0.35;
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
          this.cursor = at + 0.45;
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
    this.sync(s);
  }

  private yardActor(cell: number): Actor {
    return this.actors.find((a) => a.cell === cell && a.state === 'yard')!;
  }

  private seatCount(v: Vehicle): number {
    let n = 0;
    for (const a of this.actors) if ((a.state === 'aboard' || a.state === 'gone') && a.vehicle === v.idx) n++;
    return n;
  }

  private boardSeat(a: Actor, v: Vehicle): void {
    const seat = Math.min(CAP - 1, this.seatCount(v));
    a.state = 'aboard';
    a.vehicle = v.idx;
    a.seat = seat;
    a.cell = -1;
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
        this.startTrip(a, [this.benchPos(i, slots)], at, 0.25, 0);
      }
    });
  }

  /** Waypoints from a yard cell out past the front row, through empty cells. */
  private exitPath(cell: number, s: JamState): THREE.Vector3[] {
    const { cols, rows } = s.def;
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
    pts.shift(); // the piece's own cell
    const last = pts.length ? pts[pts.length - 1] : this.cellPos(cell);
    pts.push(new THREE.Vector3(last.x, 0, GRID_Z0 - 0.8));
    return pts;
  }

  /** Leave the yard along `path`, then hop to wherever the actor's state says it belongs. */
  private travel(a: Actor, path: THREE.Vector3[], at: number, arc = 0.9): void {
    const steps = path.slice();
    let dest: THREE.Vector3 | null = null;
    if (a.state === 'aboard') {
      const v = this.vehicles[a.vehicle];
      dest = new THREE.Vector3((v ? v.targetX : 0) + SEAT_X[a.seat], this.skin.seatY, ROAD_Z + 0.1);
    }
    if (dest) steps.push(dest);
    const walkCount = Math.max(0, steps.length - (dest ? 1 : 0));
    this.startTrip(a, steps, at, STEP * Math.max(1, walkCount) + (dest ? HOP * (arc > 1 ? 1.5 : 1) : 0), dest ? arc : 0.5);
    a.state = a.state === 'yard' ? 'moving' : a.state;
  }

  private startTrip(a: Actor, path: THREE.Vector3[], at: number, duration: number, arc: number): void {
    a.from.copy(a.pos);
    a.path = path.slice();
    a.to.copy(a.path.shift() ?? a.pos);
    a.t0 = at;
    a.segDur = duration / Math.max(1, path.length);
    a.t1 = at + a.segDur;
    a.arc = arc;
  }

  private sync(s: JamState): void {
    this.hiddenMask = visibleRowMask(s);
    this.reach = reachable(s);
    this.state = s;
  }

  // ---------------------------------------------------------------- frame

  render(t: number): void {
    this.now = t;
    this.uTime.value = t;
    if (!this.def) return;
    const dt = 1 / 60;
    const gems = this.skin.name === 'gems';
    this.bump = Math.max(0, this.bump - dt * 6);
    this.camera.position.x = Math.sin(t * 60) * this.bump * 0.08;

    for (const v of this.vehicles) {
      if (v.gone && v.lidT < 1 && t >= v.t0 - 0.25) v.lidT = Math.min(1, v.lidT + dt * 4);
      if (v.lid) v.lid.rotation.x = -easeInOut(v.lidT) * 1.9;
      if (v.x !== v.targetX && t >= v.t0) {
        v.x = THREE.MathUtils.lerp(v.x, v.targetX, 0.12);
        if (Math.abs(v.x - v.targetX) < 0.003) v.x = v.targetX;
        v.group.position.x = v.x;
        v.group.position.y = Math.abs(Math.sin(t * 30)) * 0.02;
      } else v.group.position.y = 0;
    }

    const cols = this.def.cols;
    const specials = this.def.specials ?? {};
    let n = 0;
    let nr = 0;
    let nh = 0;
    for (const a of this.actors) {
      if (a.state === 'gone') continue;
      const travelling = a.path.length > 0 || !a.pos.equals(a.to);
      let lift = 0;
      if (travelling && t >= a.t0) {
        const k = THREE.MathUtils.clamp((t - a.t0) / Math.max(1e-6, a.t1 - a.t0), 0, 1);
        const last = a.path.length === 0;
        a.pos.lerpVectors(a.from, a.to, last ? easeInOut(k) : k);
        if (last && a.arc > 0) lift = Math.sin(k * Math.PI) * a.arc;
        const dir = a.to.clone().sub(a.from);
        if (dir.lengthSq() > 1e-4) a.facing = Math.atan2(dir.x, dir.z);
        if (k >= 1) {
          if (a.path.length) {
            a.from.copy(a.to);
            a.to.copy(a.path.shift()!);
            a.t0 = t;
            a.t1 = t + (a.path.length === 0 && a.arc > 0 ? HOP : a.segDur);
          } else if (a.state === 'moving') a.state = 'bench';
        }
      }
      if (a.state === 'aboard' && !travelling) {
        const v = this.vehicles[a.vehicle];
        if (v) a.pos.set(v.x + SEAT_X[a.seat], this.skin.seatY, ROAD_Z + 0.1);
      }
      const moving = travelling && t >= a.t0;
      const row = a.cell >= 0 ? Math.floor(a.cell / cols) : 0;
      const hidden = a.state === 'yard' && !this.hiddenMask[row];
      const ready = a.state === 'yard' && this.reach[a.cell] === 1 && !hidden;
      const idle = Math.sin(t * 3 + a.phase) * 0.02;
      let bob: number;
      let squash: number;
      let spin = 0;
      if (gems) {
        // Gems float a touch and turn slowly; ready ones hover higher and catch the light.
        bob = 0.12 + (ready ? 0.1 + Math.sin(t * 4 + a.phase) * 0.04 : idle);
        squash = 1;
        spin = t * (ready ? 1.4 : 0.35) + a.phase;
        if (moving) spin = t * 6 + a.phase;
      } else {
        bob = moving ? Math.abs(Math.sin(t * 22 + a.phase)) * 0.09 : idle + (ready ? Math.abs(Math.sin(t * 5 + a.phase)) * 0.05 : 0);
        squash = moving ? 1 + Math.sin(t * 22 + a.phase) * 0.06 : 1 + idle * 2;
      }
      const prism = a.color === WILD;
      const magnet = a.cell >= 0 && specials[a.cell] === 'magnet';
      if (prism) spin = t * 2.2 + a.phase;
      const face = gems ? spin : a.state === 'yard' && !moving ? 0 : a.facing;
      this.tmp.position.set(a.pos.x, a.pos.y + bob + lift, a.pos.z);
      this.tmp.rotation.set(0, face, moving && !gems ? Math.sin(t * 22 + a.phase) * 0.05 : 0);
      const big = prism ? 1.15 : 1;
      this.tmp.scale.set((a.scale * big) / Math.sqrt(squash), a.scale * big * squash, (a.scale * big) / Math.sqrt(squash));
      this.tmp.updateMatrix();
      this.body.setMatrixAt(n, this.tmp.matrix);
      if (hidden) this.col.set(gems ? 0xa8a2b8 : 0x9aa0a8);
      else if (prism) this.col.setHSL((t * 0.3 + a.phase * 0.1) % 1, 0.55, 0.84); // a prism: pale, shimmering through every hue
      else this.col.set(COLORS[a.color]);
      this.body.setColorAt(n, this.col);
      if (hidden) this.tmp.scale.setScalar(0.0001);
      this.tmp.updateMatrix();
      this.detail.setMatrixAt(n, this.tmp.matrix);
      if (gems) this.detail.setColorAt(n, this.col.set(0xffffff));
      n++;
      if (prism && !hidden && Math.random() < 0.08) this.burst(a.pos.x, a.pos.z, 0xffffff, 1);
      if (magnet && !hidden) {
        this.tmp.position.set(a.pos.x, 0.09, a.pos.z);
        this.tmp.rotation.set(0, t * 1.5, 0);
        this.tmp.scale.setScalar(1 + Math.sin(t * 6) * 0.08);
        this.tmp.updateMatrix();
        this.halos.setMatrixAt(nh++, this.tmp.matrix);
      }
      if (ready) {
        this.tmp.position.set(a.pos.x, 0.07, a.pos.z);
        this.tmp.rotation.set(0, 0, 0);
        this.tmp.scale.setScalar(1 + Math.sin(t * 5 + a.phase) * 0.05);
        this.tmp.updateMatrix();
        this.rings.setMatrixAt(nr++, this.tmp.matrix);
      }
    }
    this.body.count = this.detail.count = n;
    this.body.instanceMatrix.needsUpdate = true;
    this.detail.instanceMatrix.needsUpdate = true;
    if (this.body.instanceColor) this.body.instanceColor.needsUpdate = true;
    if (this.detail.instanceColor) this.detail.instanceColor.needsUpdate = true;
    this.rings.count = nr;
    this.rings.instanceMatrix.needsUpdate = true;
    this.halos.count = nh;
    this.halos.instanceMatrix.needsUpdate = true;

    if (this.highlightCell >= 0 && this.state && this.state.cells[this.highlightCell] >= 0) {
      const p = this.cellPos(this.highlightCell);
      this.highlight.position.set(p.x, 0.06, p.z);
      this.highlight.visible = true;
      (this.highlight.material as THREE.MeshBasicMaterial).opacity = 0.6 + Math.sin(t * 8) * 0.3;
    } else this.highlight.visible = false;

    this.puffs = this.puffs.filter((p) => t - p.t0 < p.life);
    this.puffs.forEach((p, i) => {
      const q = (t - p.t0) / p.life;
      p.p.addScaledVector(p.v, dt);
      p.v.y -= 3 * dt;
      this.tmp.position.copy(p.p);
      this.tmp.rotation.set(t * 5, t * 7, 0);
      this.tmp.scale.setScalar(Math.max(0.001, p.size * popScale(Math.min(1, q * 3)) * (1 - q)));
      this.tmp.updateMatrix();
      this.puffMesh.setMatrixAt(i, this.tmp.matrix);
    });
    this.puffMesh.count = this.puffs.length;
    this.puffMesh.instanceMatrix.needsUpdate = true;

    this.renderer.render(this.scene, this.camera);
  }

  /** Sparkle where a piece lands. */
  burst(x: number, z: number, color: number, n = 8): void {
    for (let i = 0; i < n && this.puffs.length < 120; i++) {
      const a = Math.random() * Math.PI * 2;
      this.puffs.push({
        p: new THREE.Vector3(x, this.skin.seatY + 0.2, z),
        v: new THREE.Vector3(Math.cos(a) * 1.8, 2 + Math.random() * 1.5, Math.sin(a) * 1.8),
        t0: this.now,
        life: 0.45 + Math.random() * 0.3,
        size: 0.07 + Math.random() * 0.08,
        color,
      });
    }
  }

  /** World position of the current collector, for effects. */
  vehicleSpot(): { x: number; z: number } {
    const v = this.vehicles.find((v) => !v.gone);
    return { x: v ? v.x : 0, z: ROAD_Z };
  }
}

// ----------------------------------------------------------------- models

/** A faceted gem standing on its point, with a bright top facet as its detail layer. */
function gemGeometry(): { body: THREE.BufferGeometry; detail: THREE.BufferGeometry } {
  const crown = new THREE.CylinderGeometry(0.34, 0.42, 0.22, 8, 1);
  crown.translate(0, 0.46, 0);
  const pavilion = new THREE.CylinderGeometry(0.42, 0.04, 0.34, 8, 1);
  pavilion.translate(0, 0.18, 0);
  const table = new THREE.CylinderGeometry(0.2, 0.34, 0.1, 8, 1);
  table.translate(0, 0.62, 0);
  const body = mergeGeometries([colored(crown, 0xffffff), colored(pavilion, 0xffffff), colored(table, 0xffffff)]);
  body.computeVertexNormals();
  const glint = new THREE.CylinderGeometry(0.17, 0.17, 0.02, 8, 1);
  glint.translate(0, 0.675, 0);
  const sparkle = new THREE.OctahedronGeometry(0.06, 0);
  sparkle.translate(0.14, 0.72, 0.14);
  const detail = mergeGeometries([colored(glint, 0xffffff), colored(sparkle, 0xffffff)]);
  return { body, detail };
}

/** A round little critter facing +z: body, head, ears, and a separate face. */
function critterGeometry(): { body: THREE.BufferGeometry; detail: THREE.BufferGeometry } {
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
  return { body: mergeGeometries(furParts), detail: mergeGeometries(faceParts) };
}

/** A wooden mine cart with a coloured band and a lid that closes when it's full. */
function cartModel(color: number, mat: THREE.Material): { group: THREE.Group; lid: THREE.Object3D } {
  const g = new THREE.Group();
  const parts: THREE.BufferGeometry[] = [];
  const tub = new RoundedBoxGeometry(2.0, 0.7, 1.0, 3, 0.12);
  tub.translate(0, 0.5, 0);
  parts.push(shaded(tub, 0x9a6b40, 0x5a3a20, 0.15, 0.85));
  const band = new RoundedBoxGeometry(2.08, 0.2, 1.08, 2, 0.06);
  band.translate(0, 0.72, 0);
  parts.push(shaded(band, tint(color, 0xffffff, 0.2), tint(color, 0x000000, 0.2), 0.62, 0.82));
  const inner = new RoundedBoxGeometry(1.8, 0.1, 0.8, 1, 0.03);
  inner.translate(0, 0.72, 0);
  parts.push(colored(inner, 0x3a2a1c));
  for (const x of [-0.95, 0.95]) {
    const strap = new RoundedBoxGeometry(0.1, 0.78, 1.06, 1, 0.03);
    strap.translate(x, 0.5, 0);
    parts.push(colored(strap, 0x5c5866));
  }
  for (const z of [-0.5, 0.5]) {
    for (const x of [-0.6, 0.6]) {
      const wheel = new THREE.CylinderGeometry(0.19, 0.19, 0.12, 14);
      wheel.rotateX(Math.PI / 2);
      wheel.translate(x, 0.19, z);
      parts.push(colored(wheel, 0x3a3640));
      const hub = new THREE.CylinderGeometry(0.07, 0.07, 0.14, 8);
      hub.rotateX(Math.PI / 2);
      hub.translate(x, 0.19, z);
      parts.push(colored(hub, 0xd8d4e0));
    }
  }
  const m = new THREE.Mesh(mergeGeometries(parts), mat);
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  // Lid hinged at the back edge.
  const lid = new THREE.Group();
  lid.position.set(0, 0.84, -0.5);
  const lidGeo = new RoundedBoxGeometry(2.0, 0.1, 1.0, 2, 0.04);
  lidGeo.translate(0, 0, 0.5);
  const lidMesh = new THREE.Mesh(shaded(lidGeo, tint(color, 0xffffff, 0.35), tint(color, 0x000000, 0.1), -0.05, 0.05), mat);
  lidMesh.castShadow = true;
  lid.add(lidMesh);
  lid.rotation.x = -1.9; // open
  g.add(lid);
  return { group: g, lid };
}

/** A rounded toy bus in the given colour, facing -x (it drives off to the left). */
function busModel(color: number, mat: THREE.Material): { group: THREE.Group; lid: THREE.Object3D | null } {
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
  return { group: g, lid: null };
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

/** A wooden mine support: two posts and a beam. */
function support(x: number, y: number, z: number, h: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (const dx of [-0.7, 0.7]) {
    const post = new RoundedBoxGeometry(0.26, h, 0.26, 1, 0.06);
    post.translate(x + dx, y + h / 2, z);
    out.push(shaded(post, 0x8a5e3a, 0x4a3020, y, y + h));
  }
  const beam = new RoundedBoxGeometry(1.9, 0.3, 0.34, 1, 0.06);
  beam.translate(x, y + h - 0.1, z);
  out.push(shaded(beam, 0x9a6a44, 0x5a3a22, y + h - 0.3, y + h + 0.1));
  return out;
}

/** A cluster of glowing crystals growing out of the floor. */
function crystal(x: number, y: number, z: number, r: number, color: number, seed: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) {
    const h = r * (1.6 + hash(seed, k, 1) * 1.4);
    const c = new THREE.ConeGeometry(r * (0.35 + hash(seed, k, 2) * 0.2), h, 6);
    c.rotateX((hash(seed, k, 3) - 0.5) * 0.6);
    c.rotateZ((hash(seed, k, 4) - 0.5) * 0.6);
    c.translate(x + (hash(seed, k, 5) - 0.5) * r, y + h / 2, z + (hash(seed, k, 6) - 0.5) * r);
    parts.push(shaded(c, tint(color, 0xffffff, 0.55), tint(color, 0x000000, 0.1), y, y + h));
  }
  return mergeGeometries(parts);
}
