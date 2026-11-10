/**
 * The cave diorama (RENDER): floor with procedural detail and glowing veins, a ring of rock walls and
 * stalagmites, and per-biome props laid out deterministically from the day seed + layer.
 *
 * Biomes: lamp (rails, lantern posts, timber), fungal (glowing mushrooms, moss), flooded (puddles, pipes, gears),
 * crystal = fungal layout recoloured pink with crystal clusters, forge = flooded layout recoloured red with lava,
 * core = dark crystals and lava. Props stay outside the 4 m start circle and are sparse in the middle so they
 * never hide a telegraph (they are low; telegraphs draw on top anyway).
 */
import * as THREE from 'three';
import { layerDef } from '../content/layers';
import { addInst, poolMaterial, toyMaterial, uRim, uRimCritter } from './materials';
import {
  crystalGeo, floorQuad, gearGeo, lampPostGeo, mushroomGeo, pipeGeo, railGeo, rockGeo, stalagmiteGeo, timberGeo,
} from './geo';
import { TAU, rng32, writeHex, writeTRS } from './util';

/** Visual look per layer (1..6). Extends LayerDef.palette with renderer-only colours. */
export interface Look {
  floor: number;
  wall: number;
  fog: number;
  light: number;
  accent: number;
  vein: number; // floor vein glow colour
  veinK: number; // vein glow strength
  prop: number; // main prop tint (mushroom caps, crystals, puddles)
  prop2: number; // secondary prop tint
  ambient: number; // hemisphere sky colour
  ambientK: number;
  mote: number; // ambient particle colour
  moteKind: number; // 0 dust, 1 spores, 2 bubbles/drips, 3 sparkles, 4 embers
  rim?: number; // rim-light colour (default accent)
}

export function lookFor(layer: number): Look {
  const p = layerDef(layer).palette;
  const base = { floor: p.floor, wall: p.wall, fog: p.fog, light: p.light, accent: p.accent };
  switch (layerDef(layer).biome) {
    case 'lamp':
      return { ...base, vein: 0xff9a3a, veinK: 0.16, prop: 0xffb347, prop2: 0xffd27a, ambient: 0x7a5a40, ambientK: 0.5, mote: 0xffc890, moteKind: 0 };
    case 'fungal':
      return { ...base, vein: 0x40ffd0, veinK: 0.3, prop: 0x5af0d8, prop2: 0xb26bff, ambient: 0x5a6aa0, ambientK: 0.8, mote: 0x7affe0, moteKind: 1 };
    case 'flooded':
      return { ...base, vein: 0x3fa9ff, veinK: 0.26, prop: 0x2a7ad0, prop2: 0x8cc8ff, ambient: 0x4a6a90, ambientK: 0.8, mote: 0x9ad8ff, moteKind: 2 };
    case 'crystal':
      return { ...base, vein: 0xff7ad9, veinK: 0.3, prop: 0xff8ae0, prop2: 0xb0a0ff, ambient: 0x6a4a7a, ambientK: 0.55, mote: 0xffc0f0, moteKind: 3 };
    case 'forge':
      return { ...base, vein: 0xff4a1a, veinK: 0.5, prop: 0xff5a20, prop2: 0xffa040, ambient: 0x6a3a2a, ambientK: 0.5, mote: 0xff8a3a, moteKind: 4 };
    default:
      // Core veins are violet, not red: red on the floor is reserved for "move" (QA)
      return { ...base, vein: 0x9a4aff, veinK: 0.3, prop: 0x8a3aff, prop2: 0xff9a40, ambient: 0x4a3a5a, ambientK: 0.5, mote: 0xffa060, moteKind: 4, rim: 0xb070ff };
  }
}

/** Grey floor detail texture (stones, cracks) and a vein mask; drawn once on canvases. */
function floorTextures(seed: number): { map: THREE.CanvasTexture; vein: THREE.CanvasTexture } {
  const S = 512;
  const r = rng32(seed ^ 0x51f00d);
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#9a9a9a';
  g.fillRect(0, 0, S, S);
  // flagstones / pebbles
  for (let i = 0; i < 260; i++) {
    const x = r() * S, y = r() * S, rad = 6 + r() * 34;
    const v = 120 + Math.floor(r() * 70);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.beginPath();
    g.ellipse(x, y, rad, rad * (0.6 + r() * 0.4), r() * TAU, 0, TAU);
    g.fill();
    // wrap so the texture tiles
    for (const [dx, dy] of [[S, 0], [-S, 0], [0, S], [0, -S]]) {
      g.beginPath();
      g.ellipse(x + dx, y + dy, rad, rad * 0.8, 0, 0, TAU);
      g.fill();
    }
  }
  // dark speckle
  for (let i = 0; i < 2500; i++) {
    const v = Math.floor(r() * 90);
    g.fillStyle = `rgba(${v},${v},${v},0.35)`;
    g.fillRect(r() * S, r() * S, 2, 2);
  }
  // cracks
  g.strokeStyle = 'rgba(40,40,40,0.8)';
  g.lineWidth = 2;
  for (let i = 0; i < 30; i++) {
    let x = r() * S, y = r() * S;
    g.beginPath();
    g.moveTo(x, y);
    for (let k = 0; k < 6; k++) {
      x += (r() - 0.5) * 50;
      y += (r() - 0.5) * 50;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  const map = new THREE.CanvasTexture(c);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;

  const c2 = document.createElement('canvas');
  c2.width = c2.height = S;
  const g2 = c2.getContext('2d')!;
  g2.fillStyle = '#000';
  g2.fillRect(0, 0, S, S);
  g2.lineCap = 'round';
  for (let i = 0; i < 9; i++) {
    let x = r() * S, y = r() * S;
    let a = r() * TAU;
    for (let k = 0; k < 10; k++) {
      const nx = x + Math.cos(a) * 18, ny = y + Math.sin(a) * 18;
      g2.strokeStyle = 'rgba(255,255,255,0.10)';
      g2.lineWidth = 6;
      g2.beginPath();
      g2.moveTo(x, y);
      g2.lineTo(nx, ny);
      g2.stroke();
      g2.strokeStyle = 'rgba(255,255,255,0.75)';
      g2.lineWidth = 1.2;
      g2.stroke();
      x = nx;
      y = ny;
      a += (r() - 0.5) * 1.2;
    }
  }
  // glowing moss / pebbles
  for (let i = 0; i < 26; i++) {
    const x = r() * S, y = r() * S;
    const gr = g2.createRadialGradient(x, y, 0, x, y, 2 + r() * 4);
    gr.addColorStop(0, 'rgba(255,255,255,0.6)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g2.fillStyle = gr;
    g2.fillRect(x - 10, y - 10, 20, 20);
  }
  const vein = new THREE.CanvasTexture(c2);
  vein.wrapS = vein.wrapT = THREE.RepeatWrapping;
  return { map, vein };
}

interface PropSet {
  mesh: THREE.InstancedMesh;
  inst: THREE.InstancedBufferAttribute;
  /** Which tint each instance takes: 0 = prop, 1 = prop2, 2 = wall, 3 = neutral. */
  tint: Uint8Array;
}

type PropKind = 'rock' | 'crystal' | 'mushroom' | 'rail' | 'lamp' | 'timber' | 'puddle' | 'pipe' | 'gear';

/**
 * Camera-side cutaway: the follow camera looks north, so tall walls and props on the SOUTH rim (sim y < 0) hide the
 * delver, enemies and red floor when the player walks to the bottom edge (QA). Height multiplier for something at sim
 * (x, y): 1 on the far side, down to 0.28 straight south at the rim.
 */
function camFlat(x: number, y: number, arenaR: number): number {
  const rad = Math.sqrt(x * x + y * y) || 1;
  const south = y < 0 ? -y / rad : 0;
  const edge = Math.min(1, Math.max(0, (rad - (arenaR - 7)) / 7));
  return 1 - 0.72 * south * south * edge;
}

export class CaveEnv {
  readonly group = new THREE.Group();
  readonly floorMat: THREE.MeshLambertMaterial;
  readonly hemi: THREE.HemisphereLight;
  private readonly walls: PropSet;
  private readonly stalag: PropSet;
  private readonly props: Record<PropKind, PropSet>;
  private readonly propMat: THREE.MeshLambertMaterial;
  private readonly outer: THREE.Mesh;
  private daySeed = -1;
  private biomeKey = '';
  look: Look = lookFor(1);

  constructor(scene: THREE.Scene, arenaR: number) {
    const tex = floorTextures(1);
    this.floorMat = new THREE.MeshLambertMaterial({
      color: 0x3a2a1c,
      map: tex.map,
      emissive: 0xff9a3a,
      emissiveMap: tex.vein,
      emissiveIntensity: 0.35,
    });
    tex.map.repeat.set(7, 7);
    tex.vein.repeat.set(5, 5);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(arenaR + 6, 96), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.renderOrder = -10;
    this.group.add(floor);
    // the dark beyond the walls
    this.outer = new THREE.Mesh(new THREE.RingGeometry(arenaR + 5.5, 140, 64), new THREE.MeshBasicMaterial({ color: 0x050307 }));
    this.outer.rotation.x = -Math.PI / 2;
    this.outer.position.y = 0.6;
    this.group.add(this.outer);

    this.hemi = new THREE.HemisphereLight(0x7a5a40, 0x100808, 0.5);
    scene.add(this.hemi);

    // walls and props sink on the camera side of the delver (shader cutaway around uFocus), the far side stays tall
    const wallMat = toyMaterial(0, { rim: 0.18, cutaway: true });
    this.walls = this.makeSet(rockGeo(), wallMat, 170);
    this.stalag = this.makeSet(stalagmiteGeo(), wallMat, 70);
    this.propMat = toyMaterial(0, { rim: 0.5, cutaway: true });
    const pm = this.propMat;
    this.props = {
      rock: this.makeSet(rockGeo(), pm, 60),
      crystal: this.makeSet(crystalGeo(), pm, 60),
      mushroom: this.makeSet(mushroomGeo(), pm, 90),
      rail: this.makeSet(railGeo(), pm, 40),
      lamp: this.makeSet(lampPostGeo(), pm, 14),
      timber: this.makeSet(timberGeo(), pm, 10),
      puddle: this.makeSet(floorQuad(), poolMaterial(), 24),
      pipe: this.makeSet(pipeGeo(), pm, 14),
      gear: this.makeSet(gearGeo(), pm, 10),
    };
    this.props.puddle.mesh.renderOrder = -4;
    this.layoutWalls(arenaR, 1);
    scene.add(this.group);
  }

  private makeSet(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number): PropSet {
    const inst = addInst(geo, cap);
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    mesh.count = 0;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    return { mesh, inst, tint: new Uint8Array(cap) };
  }

  /** Rock wall ring and stalagmites, seeded by the day. */
  private layoutWalls(arenaR: number, seed: number): void {
    const r = rng32(seed ^ 0xa11);
    const ws = this.walls;
    const e = ws.mesh.instanceMatrix.array as Float32Array;
    let n = 0;
    for (let ring = 0; ring < 3; ring++) {
      const count = [64, 56, 46][ring];
      for (let i = 0; i < count && n < ws.mesh.instanceMatrix.count; i++) {
        const a = (i + r() * 0.6) / count * TAU;
        const rad = arenaR + 1.2 + ring * 1.6 + r() * 0.8;
        const s = 1.1 + r() * 1.0 + ring * 0.4;
        const fl = camFlat(Math.cos(a) * rad, Math.sin(a) * rad, arenaR);
        writeTRS(e, n, Math.cos(a) * rad, -0.3 + ring * 0.3 * fl, -Math.sin(a) * rad, r() * TAU, r() * 0.5 * fl, r() * 0.5 * fl, s, s * (0.55 + ring * 0.35 + r() * 0.4) * fl, s);
        ws.tint[n] = 2;
        n++;
      }
    }
    ws.mesh.count = n;
    ws.mesh.instanceMatrix.needsUpdate = true;
    const st = this.stalag;
    const es = st.mesh.instanceMatrix.array as Float32Array;
    n = 0;
    for (let i = 0; i < 60; i++) {
      const a = r() * TAU;
      const rad = arenaR + 1.5 + r() * 6;
      const s = 0.8 + r() * 1.3;
      const fl = camFlat(Math.cos(a) * rad, Math.sin(a) * rad, arenaR);
      writeTRS(es, n, Math.cos(a) * rad, 0, -Math.sin(a) * rad, r() * TAU, 0, (r() - 0.5) * 0.2, s, s * (0.8 + r() * 0.9) * fl, s);
      st.tint[n] = 2;
      n++;
    }
    // a few lone stalagmites inside the arena edge for depth
    for (let i = 0; i < 8; i++) {
      const a = r() * TAU;
      const rad = arenaR - 1.5 - r() * 2;
      const s = 0.5 + r() * 0.5;
      const fl = camFlat(Math.cos(a) * rad, Math.sin(a) * rad, arenaR);
      writeTRS(es, n, Math.cos(a) * rad, 0, -Math.sin(a) * rad, r() * TAU, 0, 0, s, s * (0.8 + r() * 0.7) * fl, s);
      st.tint[n] = 2;
      n++;
    }
    st.mesh.count = n;
    st.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Lay out props for a layer. Deterministic from (daySeed, layer). */
  layout(daySeed: number, layer: number, arenaR: number): void {
    const biome = layerDef(layer).biome;
    const key = daySeed + ':' + biome + ':' + layer;
    if (key === this.biomeKey) return;
    const newDay = daySeed !== this.daySeed;
    this.biomeKey = key;
    if (newDay) {
      this.daySeed = daySeed;
      this.layoutWalls(arenaR, daySeed);
      const tex = floorTextures(daySeed);
      const old = this.floorMat.map;
      const oldV = this.floorMat.emissiveMap;
      tex.map.repeat.set(7, 7);
      tex.vein.repeat.set(5, 5);
      this.floorMat.map = tex.map;
      this.floorMat.emissiveMap = tex.vein;
      this.floorMat.needsUpdate = true;
      old?.dispose();
      oldV?.dispose();
    }
    for (const k of Object.keys(this.props) as PropKind[]) this.props[k].mesh.count = 0;
    const r = rng32((daySeed ^ Math.imul(layer, 0x9e3779b9)) >>> 0);
    // polar sampler: radius biased outward, never inside the start circle
    const place = (minR: number, maxR: number): [number, number] => {
      const rad = minR + (maxR - minR) * Math.sqrt(r());
      const a = r() * TAU;
      return [Math.cos(a) * rad, Math.sin(a) * rad];
    };
    const put = (kind: PropKind, x: number, y: number, yaw: number, s: number, sy: number, tint: number, yOff = 0, tilt = 0): void => {
      const p = this.props[kind];
      const n = p.mesh.count;
      if (n >= p.tint.length) return;
      const fl = kind === 'puddle' || kind === 'rail' ? 1 : camFlat(x, y, arenaR);
      writeTRS(p.mesh.instanceMatrix.array as Float32Array, n, x, yOff, -y, yaw, tilt * fl, 0, s, s * sy * fl, s);
      p.tint[n] = tint;
      p.mesh.count = n + 1;
    };
    const R = arenaR;
    // scattered pebbles everywhere
    for (let i = 0; i < 40; i++) {
      const [x, y] = place(4, R - 0.5);
      const s = 0.12 + r() * 0.3;
      put('rock', x, y, r() * TAU, s, 0.6 + r() * 0.6, 2, -0.05);
    }
    for (let i = 0; i < 14; i++) {
      const [x, y] = place(R - 4, R + 0.5);
      put('rock', x, y, r() * TAU, 0.6 + r() * 0.7, 0.7 + r() * 0.5, 2, -0.1);
    }
    if (biome === 'lamp') {
      // two rail lines crossing the cave, broken in places
      for (let line = 0; line < 2; line++) {
        const a = r() * Math.PI;
        const off = (r() - 0.5) * 10;
        const dx = Math.cos(a), dy = Math.sin(a);
        const nx = -dy, ny = dx;
        for (let t = -R; t <= R; t += 2.02) {
          const x = dx * t + nx * off, y = dy * t + ny * off;
          if (x * x + y * y > (R - 1) * (R - 1) || r() < 0.12) continue;
          put('rail', x, y, a, 1, 1, 3, 0, 0);
        }
      }
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * TAU + r() * 0.3;
        const rad = R - 1.2 - r() * 2.5;
        put('lamp', Math.cos(a) * rad, Math.sin(a) * rad, -a + Math.PI, 1, 1, 1);
      }
      for (let i = 0; i < 7; i++) {
        const a = r() * TAU;
        const rad = R - 0.6;
        put('timber', Math.cos(a) * rad, Math.sin(a) * rad, -a + Math.PI / 2, 1, 1, 3);
      }
      for (let i = 0; i < 10; i++) {
        const [x, y] = place(R - 6, R - 0.5);
        put('crystal', x, y, r() * TAU, 0.35 + r() * 0.3, 1, 0);
      }
    } else if (biome === 'fungal' || biome === 'crystal') {
      const isCrystal = biome === 'crystal';
      // clusters of glowing mushrooms (or crystals) around the walls and in a few islands
      const clusters = 16;
      for (let c = 0; c < clusters; c++) {
        const [cx, cy] = c < 11 ? place(R - 5, R - 0.5) : place(8, R - 6);
        const nIn = 3 + Math.floor(r() * 4);
        for (let k = 0; k < nIn; k++) {
          const x = cx + (r() - 0.5) * 2.4, y = cy + (r() - 0.5) * 2.4;
          const s = (c < 11 ? 0.8 : 0.5) + r() * 0.9;
          if (isCrystal && r() < 0.7) put('crystal', x, y, r() * TAU, s * 0.8, 1 + r() * 0.5, r() < 0.5 ? 0 : 1);
          else put('mushroom', x, y, r() * TAU, s, 0.8 + r() * 0.6, r() < 0.65 ? 0 : 1, 0, (r() - 0.5) * 0.3);
        }
      }
      for (let i = 0; i < 26; i++) {
        const [x, y] = place(5, R - 1);
        put('mushroom', x, y, r() * TAU, 0.25 + r() * 0.25, 1, r() < 0.5 ? 0 : 1);
      }
    } else {
      // flooded / forge / core: puddles (water or lava), pipes, gears, crystals in the core
      const isCore = biome === 'core';
      for (let i = 0; i < 16; i++) {
        const [x, y] = place(6, R - 2);
        put('puddle', x, y, r() * TAU, 1.0 + r() * 1.8, 1, i % 3 === 0 ? 1 : 0, 0.02);
      }
      if (!isCore) {
        for (let i = 0; i < 10; i++) {
          const a = r() * TAU;
          const rad = R - 0.8 - r() * 1.5;
          put('pipe', Math.cos(a) * rad, Math.sin(a) * rad, -a + Math.PI / 2, 1, 1, 3);
        }
        for (let i = 0; i < 8; i++) {
          const [x, y] = place(R - 7, R - 1);
          put('gear', x, y, r() * TAU, 0.5 + r() * 0.6, 1, 2, 0, (r() - 0.5) * 0.5);
        }
      }
      for (let i = 0; i < (isCore ? 30 : 8); i++) {
        const [x, y] = place(isCore ? 8 : R - 5, R - 0.5);
        put('crystal', x, y, r() * TAU, 0.5 + r() * 0.8, 1 + r() * 0.6, r() < 0.5 ? 0 : 1);
      }
    }
    for (const k of Object.keys(this.props) as PropKind[]) {
      const p = this.props[k];
      p.mesh.instanceMatrix.needsUpdate = true;
      p.mesh.visible = p.mesh.count > 0;
    }
    this.retint();
  }

  /** Apply a look (palette) to floor, fog, light-independent tints. */
  apply(look: Look, scene: THREE.Scene): void {
    this.look = look;
    this.floorMat.color.setHex(look.floor).multiplyScalar(2.2);
    this.floorMat.emissive.setHex(look.vein);
    this.floorMat.emissiveIntensity = look.veinK;
    this.hemi.color.setHex(look.ambient);
    this.hemi.groundColor.setHex(look.fog);
    this.hemi.intensity = look.ambientK * 0.75;
    (this.outer.material as THREE.MeshBasicMaterial).color.setHex(look.fog).multiplyScalar(0.6);
    if (scene.fog instanceof THREE.Fog) scene.fog.color.setHex(look.fog);
    if (scene.background instanceof THREE.Color) scene.background.setHex(look.fog);
    uRim.value.setHex(look.rim ?? look.accent).multiplyScalar(0.55);
    // critters get a greyer, dimmer rim so their own colours survive (cream shrooms read cream, not lavender, in the Core)
    uRimCritter.value.setHex(look.rim ?? look.accent).lerp(new THREE.Color(0x9a9090), 0.55).multiplyScalar(0.42);
    this.retint();
  }

  private retint(): void {
    const L = this.look;
    const tints = [L.prop, L.prop2, L.wall, 0xffffff];
    const k = [1, 1, 0.65, 1];
    const sets = [this.walls, this.stalag, ...Object.values(this.props)];
    for (const s of sets) {
      const a = s.mesh.instanceColor!.array as Float32Array;
      for (let i = 0; i < s.mesh.count; i++) writeHex(a, i, tints[s.tint[i]], k[s.tint[i]]);
      s.mesh.instanceColor!.needsUpdate = true;
    }
    // puddles in the forge / core are lava: brighter
    const isLava = L.moteKind === 4;
    const pud = this.props.puddle;
    const pa = pud.inst.array as Float32Array;
    const pc = pud.mesh.instanceColor!.array as Float32Array;
    for (let i = 0; i < pud.mesh.count; i++) {
      // water is dark and glassy (caustics); lava is a dark crust with hot cracks
      pa[i * 4] = isLava ? 1 : 0;
      pa[i * 4 + 1] = (i * 0.618) % 1;
      if (isLava) writeHex(pc, i, i % 3 === 0 ? 0xff7a18 : 0xff4a10, 1);
    }
    pud.mesh.instanceColor!.needsUpdate = true;
    pud.inst.needsUpdate = true;
  }

  /** Lantern posts and crystals twinkle a little (per-instance glow). */
  update(t: number): void {
    const lp = this.props.lamp;
    const a = lp.inst.array as Float32Array;
    for (let i = 0; i < lp.mesh.count; i++) a[i * 4 + 3] = 0.25 * Math.sin(t * (7 + i) + i * 3.1) * Math.sin(t * 2.3 + i);
    lp.inst.needsUpdate = true;
    const cr = this.props.crystal;
    const c = cr.inst.array as Float32Array;
    for (let i = 0; i < cr.mesh.count; i++) c[i * 4 + 3] = 0.3 * Math.max(0, Math.sin(t * 1.3 + i * 1.7));
    cr.inst.needsUpdate = true;
  }
}
