/**
 * Shared materials and shaders (RENDER).
 *
 *  - toyMaterial: instanced Lambert with vertex colours, a per-vertex "keep own colour / glow" mask (aKeep),
 *    per-vertex bend vectors (aBend) animated in the vertex shader (wing flaps, leg steps), a rim light
 *    that reads in the dark, and per-instance flash/glow (aInst). Critters, bosses, the delver, props, gems.
 *  - glowMaterial: camera-facing additive billboards (soft glow or 4-point sparkle).
 *  - particleMaterial: additive Points with per-particle size and colour (alpha folded into colour).
 *  - zoneMaterial / telegraphMaterial / ringMaterial / beamMaterial: flat floor decals with analytic shapes.
 *  - digitMaterial: billboarded damage-number digits from a canvas atlas.
 *  - overlayMaterial: full-screen vignette, darkening (fusion, layer change), hurt and breath edges.
 */
import * as THREE from 'three';

/** Shared clock for every animated shader (seconds, presentation time). */
export const uTime = { value: 0 };
/** Shared rim-light colour (the layer accent). */
export const uRim = { value: new THREE.Color(0x553366) };

/** Rim colour for critters: the layer accent, desaturated so cream / teal critters keep their own colour (QA: lavender shrooms). */
export const uRimCritter = { value: new THREE.Color(0x553366) };
/**
 * Readability anchors, set by the renderer once per frame (world space, three.js axes):
 *  - uAnchor: the delver's chest; `onTop` materials squeeze their depth into a band in front of everything else,
 *    keeping their own depth order around this point (the delver is never buried under the crowd).
 *  - uFocus: the delver's floor position (x, z); `cutaway` materials flatten instances on the camera side of it.
 *  - uNear: (x, z, strength, radius); `nearDim` materials darken and desaturate within `radius` of the delver.
 */
export const uAnchor = { value: new THREE.Vector3() };
export const uFocus = { value: new THREE.Vector2() };
export const uNear = { value: new THREE.Vector4(0, 0, 0, 3) };

export interface ToyOpts {
  rim?: number;
  transparent?: boolean;
  /** Use the critter rim colour (uRimCritter) instead of the layer accent. */
  critterRim?: boolean;
  /** Darken + desaturate near the delver (critters), so the delver's silhouette pops out of the blob. */
  nearDim?: boolean;
  /** Camera-side cutaway: flatten instances between the camera and the delver (walls, stalagmites, edge props). */
  cutaway?: boolean;
  /** Depth band in front of the scene (NDC z); used for the delver (-0.985) and its outline hull (-0.955). */
  onTop?: number;
}

/** GLSL: squeeze depth into a near band, keeping metric depth order around uAnchor. */
const ON_TOP_GLSL = (band: number): string => /* glsl */ `
{
  vec4 _av = viewMatrix * vec4(uAnchor, 1.0);
  float _dz = _av.z - mvPosition.z; // metres behind the anchor
  gl_Position.z = clamp(${band.toFixed(4)} + _dz * 0.004, -0.999, 0.999) * gl_Position.w;
}`;

/** aInst layout: x = phase, y = flash (0..1), z = bend amplitude, w = extra glow. */
export function toyMaterial(freq: number, opts: ToyOpts = {}): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  if (opts.transparent) {
    m.transparent = true;
    m.depthWrite = false;
  }
  const uFreq = { value: freq };
  const uRimK = { value: opts.rim ?? 1 };
  const onTop = opts.onTop !== undefined;
  m.onBeforeCompile = (s) => {
    s.uniforms.uTime = uTime;
    s.uniforms.uFreq = uFreq;
    s.uniforms.uRim = opts.critterRim ? uRimCritter : uRim;
    s.uniforms.uRimK = uRimK;
    s.uniforms.uAnchor = uAnchor;
    s.uniforms.uFocus = uFocus;
    s.uniforms.uNear = uNear;
    s.vertexShader = s.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec2 aKeep;
attribute vec3 aBend;
attribute vec4 aInst;
uniform float uTime;
uniform float uFreq;
uniform vec3 uAnchor;
uniform vec2 uFocus;
varying vec2 vKeep;
varying vec2 vFx;
${opts.nearDim ? 'varying vec2 vWXZ;' : ''}`,
      )
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
#ifdef USE_COLOR
vColor.rgb = mix(vColor.rgb, color.rgb, aKeep.x);
#endif
vKeep = aKeep;
vFx = aInst.yw;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
transformed += aBend * (sin(uTime * uFreq + aInst.x) * aInst.z);
${opts.cutaway ? `
#ifdef USE_INSTANCING
{
  // walls on the camera side of the delver (and level with it) sink to a low rim; the far side stays tall
  vec3 _io = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec2 _d = _io.xz - uFocus;
  // keep tall only what is clearly up-screen of the delver (the far side); sides and the camera side sink
  float _near = 1.0 - smoothstep(10.0, 17.0, length(_d));
  float _far = smoothstep(2.0, 7.0, -_d.y - 0.6 * abs(_d.x));
  transformed.y *= 1.0 - 0.78 * _near * (1.0 - _far);
}
#endif` : ''}`,
      );
    if (opts.nearDim) {
      s.vertexShader = s.vertexShader.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
{
  vec4 _wp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  _wp = instanceMatrix * _wp;
  #endif
  vWXZ = (modelMatrix * _wp).xz;
}`,
      );
    }
    if (onTop) s.vertexShader = s.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>' + ON_TOP_GLSL(opts.onTop!));
    s.fragmentShader = s.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uRim;
uniform float uRimK;
uniform vec4 uNear;
varying vec2 vKeep;
varying vec2 vFx;
${opts.nearDim ? 'varying vec2 vWXZ;' : ''}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float _dim = 0.0;
${opts.nearDim ? `
{
  // close to the delver: darker and greyer, so the delver (bright, outlined) reads against the crowd
  float _d = length(vWXZ - uNear.xy);
  _dim = (1.0 - smoothstep(uNear.w * 0.45, uNear.w, _d)) * uNear.z;
  float _l = dot(diffuseColor.rgb, vec3(0.3, 0.5, 0.2));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(_l) * 0.55, _dim);
}` : ''}
// hit flash (whitening); muted next to the delver so constant hits do not turn the crowd around it white
float _fl = vFx.x * (1.0 - _dim * 1.1);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.97, 0.92), _fl * 0.45);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  float nv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
  float rim = pow(1.0 - nv, 2.5);
  totalEmissiveRadiance += uRim * (rim * uRimK) * (1.0 - vKeep.y) * (1.0 - _dim * 0.7);
  totalEmissiveRadiance += diffuseColor.rgb * (vKeep.y + vFx.y) * (1.0 - _dim * 0.6);
  totalEmissiveRadiance += vec3(1.0, 0.85, 0.7) * max(_fl, 0.0) * 0.3;
  ${onTop ? 'totalEmissiveRadiance += diffuseColor.rgb * 0.38; // self-lit: the delver never sinks into the dark' : ''}
}`,
      );
  };
  const key = 'toy' + (opts.transparent ? 't' : '') + (opts.critterRim ? 'c' : '') + (opts.nearDim ? 'n' : '') + (opts.cutaway ? 'w' : '') + (onTop ? 'o' + opts.onTop : '');
  m.customProgramCacheKey = () => key;
  return m;
}

/** Put a built-in material (MeshBasic) into an on-top depth band (see uAnchor), e.g. the delver's ground ring. */
export function onTopBasic<M extends THREE.Material>(m: M, band: number): M {
  m.onBeforeCompile = (s) => {
    s.uniforms.uAnchor = uAnchor;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uAnchor;')
      .replace('#include <project_vertex>', '#include <project_vertex>' + ON_TOP_GLSL(band));
  };
  m.customProgramCacheKey = () => 'ontop' + band;
  return m;
}

/**
 * Outline hull for the delver: the same geometry pushed outward and drawn back faces only in a flat colour, in a depth
 * band just behind the delver's own band (so it shows as a bright rim around the silhouette, over every critter).
 */
export function hullMaterial(band: number, grow: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uAnchor, uCol: { value: new THREE.Color(0xfff1c8) }, uGrow: { value: grow }, uA: { value: 1 } },
    vertexShader: /* glsl */ `
uniform vec3 uAnchor;
uniform float uGrow;
void main() {
  vec3 dir = normalize(position - vec3(0.0, 0.62, 0.0) + vec3(0.0001));
  vec3 p = position + (normalize(normal) * 0.5 + dir * 0.7) * uGrow;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  ${ON_TOP_GLSL(band)}
}`,
    fragmentShader: /* glsl */ `
uniform vec3 uCol;
uniform float uA;
void main() {
  gl_FragColor = vec4(uCol, uA);
  #include <colorspace_fragment>
}`,
    side: THREE.BackSide,
    toneMapped: false,
  });
}

/** Give an instanced geometry its per-instance aInst attribute. */
export function addInst(g: THREE.BufferGeometry, cap: number): THREE.InstancedBufferAttribute {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
  a.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('aInst', a);
  return a;
}

const billboardVS = /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
void main() {
  vUv = uv;
  #ifdef USE_INSTANCING_COLOR
  vCol = instanceColor;
  #else
  vCol = vec3(1.0);
  #endif
  vec4 c = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float s = length(instanceMatrix[0].xyz);
  c.xy += position.xy * s;
  gl_Position = projectionMatrix * c;
}`;

/** Camera-facing additive glow. shape 0 = soft disc, 1 = 4-point sparkle. */
export function glowMaterial(shape: 0 | 1): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: billboardVS,
    fragmentShader: /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float d = length(p);
  float a;
  ${shape === 0
    ? 'a = pow(max(0.0, 1.0 - d), 2.2) + 0.6 * pow(max(0.0, 1.0 - d * 2.2), 3.0);'
    : 'a = max(0.0, 1.0 - abs(p.x) * 9.0 - abs(p.y) * 1.1) + max(0.0, 1.0 - abs(p.y) * 9.0 - abs(p.x) * 1.1); a += pow(max(0.0, 1.0 - d * 2.5), 2.0); a = min(a, 1.5) * (1.0 - smoothstep(0.85, 1.0, d));'}
  gl_FragColor = vec4(vCol * a, 1.0);
  #include <colorspace_fragment>
}`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
}

/** Additive point sprites. Attributes: position, color (vec3, pre-multiplied by alpha), size (metres). */
export function particleMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 400 } },
    vertexShader: /* glsl */ `
attribute float size;
attribute vec3 color;
uniform float uScale;
varying vec3 vCol;
void main() {
  vCol = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = max(1.0, size * uScale / -mv.z);
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: /* glsl */ `
varying vec3 vCol;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d = dot(p, p);
  float a = max(0.0, 1.0 - d);
  a *= a;
  gl_FragColor = vec4(vCol * a, 1.0);
  #include <colorspace_fragment>
}`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
}

const flatVS = /* glsl */ `
attribute vec4 aA;
attribute vec4 aB;
varying vec2 vUv;
varying vec3 vCol;
varying vec4 vA;
varying vec4 vB;
void main() {
  vUv = uv;
  vA = aA;
  vB = aB;
  #ifdef USE_INSTANCING_COLOR
  vCol = instanceColor;
  #else
  vCol = vec3(1.0);
  #endif
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;

const noiseGLSL = /* glsl */ `
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}`;

/**
 * Player zones and aura pulses on the floor. aA = (fx id, life left 0..1, seed, kind 0 zone / 1 aura pulse),
 * aB = (radius m, age s, follow, rank 0..1 (rank 1 -> 5)). Colour = instanceColor.
 */
export function zoneMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime },
    vertexShader: flatVS,
    fragmentShader: /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying vec3 vCol;
varying vec4 vA;
varying vec4 vB;
${noiseGLSL}
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float d = length(p);
  if (d > 1.0) discard;
  float life = vA.y;
  float fx = vA.x;
  float t = uTime + vA.z * 10.0;
  float a = 0.0;
  if (vA.w > 0.5) {
    // aura pulse: a bright ring sweeping outward
    float prog = 1.0 - life;
    float rr = mix(0.25, 1.0, sqrt(prog));
    a = exp(-pow((d - rr) * 10.0, 2.0)) * 0.45 + (1.0 - smoothstep(0.0, rr, d)) * 0.03;
    a *= (1.0 - prog * prog) * (1.0 + 0.6 * vB.w);
  } else {
    float fade = smoothstep(0.0, 0.25, life) * smoothstep(0.0, 0.08, vB.y + 0.04);
    float edge = smoothstep(0.82, 0.97, d) * (1.0 - smoothstep(0.97, 1.0, d));
    vec2 q = p * vB.x;
    float n;
    if (fx < 0.5) { // fire: licking flames
      n = vnoise(q * 1.6 + vec2(0.0, -t * 2.2)) * 0.6 + vnoise(q * 3.3 + vec2(t, -t * 3.0)) * 0.4;
      a = smoothstep(0.35, 0.9, n) * 1.2 + 0.25;
    } else if (fx < 1.5 || (fx > 6.5)) { // poison / fever: bubbling
      vec2 c = q * 1.4;
      vec2 ci = floor(c); vec2 cf = fract(c) - 0.5;
      float ph = fract(h21(ci) + t * 0.45);
      float bub = smoothstep(0.08, 0.0, abs(length(cf) - ph * 0.42)) * (1.0 - ph);
      n = vnoise(q * 0.9 + t * 0.3);
      a = 0.35 + n * 0.35 + bub * 1.4;
    } else { // generic: swirling haze
      n = vnoise(q * 1.2 + vec2(t * 0.7, t * 0.4));
      a = 0.25 + n * 0.5;
    }
    // v0.2 review: friendly ground must never read as a hazard. Hazards are a solid wash with a SOLID rim; player zones
    // are a faint haze with a DASHED rim (about 0.4x the old interior fill), so red floor under a pool stays readable.
    float angZ = atan(p.y, p.x);
    float dashes = max(8.0, floor(vB.x * 5.0));
    float dashZ = step(0.42, fract(angZ * dashes / 6.2832 + t * 0.05));
    float rk = vB.w;
    a = (a * 0.24 * (1.0 + 0.25 * rk) * (1.0 - smoothstep(0.7, 1.0, d)) + edge * 0.6 * dashZ) * fade;
    // rank (vB.w 0..1): a little denser; rank 5 adds a turning ring of runes inside the rim
    if (rk > 0.99) {
      float ang = atan(p.y, p.x);
      float dash = step(0.45, fract(ang * 2.546 + uTime * 0.35 * (vA.z > 0.5 ? 1.0 : -1.0)));
      float band = smoothstep(0.035, 0.0, abs(d - 0.86));
      a += band * dash * 0.55 * fade;
    }
  }
  gl_FragColor = vec4(vCol * a, a);
  #include <colorspace_fragment>
}`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
}

/**
 * Hostile telegraphs. aA = (shape, fill progress 0..1, colour 0 red/1 violet/2 gold, after-impact seconds or -1),
 * aB = (half extent x m, half extent y m, param (ring inner r / cone half-angle), flags: 1 linger-hurts, 2 maw).
 * The whole danger area is tinted and rimmed from frame 0; a solid fill grows from the middle OUTWARD and reaches the rim at
 * the moment of impact (so the centre, where bursts aim, is the most obviously dangerous spot). RING telegraphs (the inside is
 * safe) draw a dashed pale inner edge and a cool safe tint, so "donut" only ever means "safe inside".
 * `overlay` = a rim-only copy drawn without depth test, so warnings stay visible through critters and walls.
 */
export function telegraphMaterial(overlay = false): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime },
    defines: overlay ? { TG_OVERLAY: 1 } : {},
    vertexShader: flatVS,
    fragmentShader: /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying vec3 vCol;
varying vec4 vA;
varying vec4 vB;
void main() {
  vec2 p = (vUv * 2.0 - 1.0) * vB.xy;
  float shape = vA.x;
  float prog = vA.y;
  float after = vA.w;
  bool maw = vB.w > 1.5;
  float sd; float depth; // signed distance inside (m), normalised depth 0 edge .. 1 middle
  if (shape < 0.5) { // circle
    float d = length(p);
    sd = vB.x - d; depth = sd / vB.x;
  } else if (shape < 1.5) { // lane
    sd = min(vB.y - abs(p.y), vB.x - abs(p.x)); depth = (vB.y - abs(p.y)) / vB.y;
  } else if (shape < 2.5) { // cone, apex at the quad centre, pointing +x
    float d = length(p);
    float ang = abs(atan(p.y, p.x));
    sd = min(vB.x - d, d * sin(clamp(vB.z - ang, -1.5, 1.5)));
    depth = (vB.x - d) / vB.x;
  } else { // ring (annulus): the inside is SAFE
    float d = length(p);
    float half_ = (vB.x - vB.z) * 0.5;
    sd = min(d - vB.z, vB.x - d); depth = sd / max(0.01, half_);
    if (!maw && after < 0.0 && d < vB.z && d > vB.z - 0.6) {
      // safe side: dashed pale inner edge + cool tint fading inward
      float ang = atan(p.y, p.x);
      float dash = step(0.0, sin(ang * max(6.0, floor(vB.z * 3.0)) + uTime * 2.0));
      float line = 1.0 - smoothstep(0.0, 0.1, vB.z - d);
#ifdef TG_OVERLAY
      gl_FragColor = vec4(0.7, 1.0, 0.95, line * dash * 0.55);
#else
      float tint = (1.0 - smoothstep(0.0, 0.6, vB.z - d)) * 0.16;
      gl_FragColor = vec4(mix(vec3(0.45, 1.0, 0.9), vec3(0.9, 1.0, 1.0), line), clamp(tint + line * dash * 0.85, 0.0, 1.0));
#endif
      #include <colorspace_fragment>
      return;
    }
  }
  if (sd < 0.0) discard;
  float edge = 1.0 - smoothstep(0.0, 0.14, sd);
  float a;
  vec3 col = vCol;
#ifdef TG_OVERLAY
  // drawn over critters and walls: the rim, a light wash of the area and the filling front, so a warning under a
  // crowd still reads as a red AREA; the impact flash also shows through
  float rimO = 1.0 - smoothstep(0.0, 0.11, sd);
  if (maw) {
    a = rimO * 0.55;
  } else if (after < 0.0) {
    float innerO = 1.0 - depth;
    float frontO = 1.0 - smoothstep(0.0, 0.035, abs(innerO - prog));
    a = rimO * (0.6 + 0.35 * prog) + 0.13 + 0.1 * prog + frontO * 0.35;
    col = mix(col, vec3(1.0, 0.9, 0.85), frontO * 0.6);
  } else {
    float fl = 1.0 - smoothstep(0.05, 0.3, after);
    a = fl * 0.75;
    col = mix(col, vec3(1.0, 0.95, 0.85), fl);
  }
  if (a < 0.01) discard;
  gl_FragColor = vec4(mix(col, vec3(1.0), 0.2 * rimO), clamp(a, 0.0, 1.0));
  #include <colorspace_fragment>
  return;
#endif
  if (maw) {
    float pulse = 0.5 + 0.5 * sin(uTime * 4.0 - depth * 6.0);
    a = 0.18 + edge * 0.9 + pulse * 0.25 * depth;
  } else if (after < 0.0) {
    // danger from frame 0: the WHOLE area is a solid red wash with a thick bright rim. A brighter fill grows from the
    // middle outward behind a white-hot front that reaches the rim at impact; the last 20% throbs.
    float inner = 1.0 - depth; // 0 at the middle, 1 at the rim
    float filled = step(inner, prog);
    float front = 1.0 - smoothstep(0.0, 0.045, abs(inner - prog));
    float stripes = 0.5 + 0.5 * sin((p.x + p.y) * 5.0 - uTime * 6.0);
    float rim = 1.0 - smoothstep(0.0, 0.26, sd);
    float urgent = smoothstep(0.8, 1.0, prog) * (0.5 + 0.5 * sin(uTime * 28.0));
    a = 0.44 + prog * 0.12 + stripes * 0.05 + rim * 0.9 + filled * (0.18 + prog * 0.14) + front * 0.45 + urgent * 0.15;
    col = mix(col * 0.82, col, filled);
    col = mix(col, vec3(1.0, 0.82, 0.76), rim * 0.4 + front * 0.55 + urgent * 0.2);
  } else {
    // impact: a white-hot flash over the whole area, a red afterglow, then fade or a pulsing linger puddle
    float flash = 1.0 - smoothstep(0.06, 0.32, after);
    float glowA = 1.0 - smoothstep(0.08, 0.35, after); // v0.2: shorter afterglow (lingering rings read as new hazards)
    float lingerK = mod(vB.w, 2.0) > 0.5 ? 1.0 : 0.0;
    float pulse = 0.5 + 0.5 * sin(uTime * 7.0 + depth * 8.0);
    a = flash * 0.95 + glowA * 0.35 * (1.0 - lingerK) + lingerK * (0.3 + 0.2 * pulse + edge * 0.6);
    col = mix(col, vec3(1.0, 0.96, 0.88), flash * 0.85);
  }
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  #include <colorspace_fragment>
}`,
    transparent: true,
    depthWrite: false,
    depthTest: !overlay,
  });
}

/** Expanding shock rings. aA = (progress 0..1, thickness 0..1, intensity, 0). */
export function ringMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: flatVS,
    fragmentShader: /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
varying vec4 vA;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float d = length(p);
  if (d > 1.0) discard;
  float th = max(0.02, vA.y);
  float r = smoothstep(1.0 - th, 1.0 - th * 0.35, d) * (1.0 - smoothstep(0.96, 1.0, d));
  float inner = (1.0 - smoothstep(0.0, 1.0, d)) * 0.07; // v0.2: half the disc fill (filled discs read as hazards)
  float a = (r + inner) * (1.0 - vA.x) * vA.z;
  gl_FragColor = vec4(vCol * a, 1.0);
  #include <colorspace_fragment>
}`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
}

/** Lightning / streak segments (flat quads): bright core across v. aA = (alpha, 0, 0, 0). */
export function beamMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: flatVS,
    fragmentShader: /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
varying vec4 vA;
void main() {
  float v = abs(vUv.y * 2.0 - 1.0);
  float core = 1.0 - smoothstep(0.0, 0.25, v);
  float glow = pow(1.0 - v, 2.0);
  float ends = smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.92, vUv.x);
  float a = (core * 1.6 + glow * 0.6) * vA.x * ends;
  gl_FragColor = vec4(mix(vCol, vec3(1.0), core * 0.6) * a, 1.0);
  #include <colorspace_fragment>
}`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
}

/** Damage-number digits. aA = (digit 0..10, alpha, x offset in glyph widths, wobble rad). Atlas: 11 cells across. */
export function digitMaterial(atlas: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uAtlas: { value: atlas } },
    vertexShader: /* glsl */ `
attribute vec4 aA;
varying vec2 vUv;
varying vec3 vCol;
varying float vAlpha;
void main() {
  vUv = vec2((uv.x + aA.x) / 11.0, uv.y);
  vAlpha = aA.y;
  #ifdef USE_INSTANCING_COLOR
  vCol = instanceColor;
  #else
  vCol = vec3(1.0);
  #endif
  vec4 c = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float s = length(instanceMatrix[0].xyz);
  // tight kerning (the atlas cells are wider than the glyphs); aA.w = crit wobble (radians)
  vec2 q = position.xy + vec2(aA.z * 0.47, 0.0);
  float cw = cos(aA.w), sw = sin(aA.w);
  c.xy += vec2(q.x * cw - q.y * sw, q.x * sw + q.y * cw) * s;
  gl_Position = projectionMatrix * c;
}`,
    fragmentShader: /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vUv;
varying vec3 vCol;
varying float vAlpha;
void main() {
  vec4 t = texture2D(uAtlas, vUv);
  // r = fill, g = outline
  vec3 col = mix(vec3(0.08, 0.03, 0.05), vCol, t.r);
  float a = max(t.r, t.g) * vAlpha;
  if (a < 0.02) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
  });
}

/**
 * Per-biome colour grade (drawn over the finished frame, before the overlay). A cheap "gain" grade with no
 * render-target read: the blend is dst * 2 * src, so an output of 0.5 leaves a pixel unchanged and every channel
 * above / below 0.5 lifts / cuts that channel. Centre and edge gains split-tone the lantern's pool of light
 * against the cave around it; uPump (Core heartbeat) squeezes the edges darker and redder.
 */
export function gradeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uAspect: { value: 1 },
      uCentre: { value: new THREE.Color(1, 1, 1) },
      uEdge: { value: new THREE.Color(1, 1, 1) },
      uSpot: { value: new THREE.Vector2(0.5, 0.5) },
      uPump: { value: 0 },
    },
    vertexShader: /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
uniform float uAspect, uPump;
uniform vec3 uCentre, uEdge;
uniform vec2 uSpot;
varying vec2 vUv;
void main() {
  vec2 s = (vUv - mix(vec2(0.5), uSpot, 0.6)) * vec2(uAspect, 1.0);
  float r = smoothstep(0.12, 0.85, length(s));
  vec3 g = mix(uCentre, uEdge, r);
  g = mix(g, g * vec3(0.84, 0.72, 0.9), uPump * r); // heartbeat squeeze: darker, violet (red is reserved for "move")
  gl_FragColor = vec4(clamp(g * 0.5, 0.0, 1.0), 1.0);
}`,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.SrcColorFactor,
    toneMapped: false,
  });
}

/** Full-screen post overlay (drawn last with an ortho camera). */
export function overlayMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uAspect: { value: 1 },
      uVignette: { value: 0.55 },
      uDark: { value: 0 },
      uSpot: { value: new THREE.Vector2(0.5, 0.5) },
      uHurt: { value: 0 },
      uBreath: { value: 0 },
      uFlash: { value: 0 },
      uTint: { value: new THREE.Color(0x000000) },
      uFlashCol: { value: new THREE.Color(1.0, 0.96, 0.85) },
      uTime,
    },
    vertexShader: /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
uniform float uAspect, uVignette, uDark, uHurt, uBreath, uFlash, uTime;
uniform vec2 uSpot;
uniform vec3 uTint;
uniform vec3 uFlashCol;
varying vec2 vUv;
void main() {
  vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
  float r = length(q);
  float vig = smoothstep(0.35, 1.05, r) * uVignette;
  vec2 s = (vUv - uSpot) * vec2(uAspect, 1.0);
  float spot = smoothstep(0.08, 0.32, length(s));
  float dark = uDark * mix(0.35, 1.0, spot);
  float edge = smoothstep(0.3, 0.95, r);
  float a = clamp(vig + dark, 0.0, 0.97);
  vec3 col = vec3(0.0);
  float hurt = uHurt * edge;
  float br = uBreath * edge * (0.75 + 0.25 * sin(uTime * 5.0));
  col = mix(col, vec3(0.9, 0.05, 0.08), clamp(hurt, 0.0, 1.0));
  col = mix(col, vec3(1.0, 0.35, 0.05), clamp(br, 0.0, 1.0));
  a = max(a, max(hurt * 0.6, br * 0.55));
  col = mix(col, uFlashCol, uFlash);
  a = max(a, uFlash);
  gl_FragColor = vec4(col, a);
}`,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
}

/** Water / lava pools on the floor. aInst = (lava 0/1, seed, 0, 0); colour = instanceColor. */
export function poolMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime },
    vertexShader: /* glsl */ `
attribute vec4 aInst;
varying vec2 vUv;
varying vec3 vCol;
varying vec4 vI;
void main() {
  vUv = uv;
  vI = aInst;
  #ifdef USE_INSTANCING_COLOR
  vCol = instanceColor;
  #else
  vCol = vec3(1.0);
  #endif
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`,
    fragmentShader: /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying vec3 vCol;
varying vec4 vI;
${noiseGLSL}
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float ang = atan(p.y, p.x);
  float d = length(p);
  float edgeR = 0.8 + 0.1 * sin(ang * 3.0 + vI.y * 20.0) + 0.06 * sin(ang * 7.0 + vI.y * 9.0);
  if (d > edgeR) discard;
  float e = d / edgeR;
  vec3 col;
  float a;
  if (vI.x > 0.5) {
    float n = vnoise(p * 3.0 + vec2(uTime * 0.12, vI.y * 10.0));
    float n2 = vnoise(p * 6.0 - uTime * 0.25 + vI.y * 3.0);
    float crack = 1.0 - smoothstep(0.0, 0.06, abs(n - 0.5));
    float glow = crack * 1.2 + smoothstep(0.7, 1.0, e) * 0.9 + (1.0 - e) * 0.35 * n2;
    col = mix(vec3(0.07, 0.025, 0.02), vCol * (1.3 + 0.8 * n2), clamp(glow, 0.0, 1.4));
    a = 1.0 - smoothstep(0.92, 1.0, e);
  } else {
    float c1 = vnoise(p * 5.0 + vec2(uTime * 0.35, -uTime * 0.25) + vI.y * 7.0);
    float c2 = vnoise(p * 4.2 - vec2(uTime * 0.25, uTime * 0.3));
    float caust = pow(c1 * c2, 1.5);
    col = vCol * 0.22 + vec3(0.55, 0.85, 1.0) * caust * 0.9 + vCol * smoothstep(0.82, 1.0, e) * 0.5;
    a = 0.9 * (1.0 - smoothstep(0.9, 1.0, e));
  }
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`,
    transparent: true,
    depthWrite: false,
  });
}
