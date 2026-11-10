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

/** aInst layout: x = phase, y = flash (0..1), z = bend amplitude, w = extra glow. */
export function toyMaterial(freq: number, opts: { rim?: number; transparent?: boolean } = {}): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  if (opts.transparent) {
    m.transparent = true;
    m.depthWrite = false;
  }
  const uFreq = { value: freq };
  const uRimK = { value: opts.rim ?? 1 };
  m.onBeforeCompile = (s) => {
    s.uniforms.uTime = uTime;
    s.uniforms.uFreq = uFreq;
    s.uniforms.uRim = uRim;
    s.uniforms.uRimK = uRimK;
    s.vertexShader = s.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec2 aKeep;
attribute vec3 aBend;
attribute vec4 aInst;
uniform float uTime;
uniform float uFreq;
varying vec2 vKeep;
varying vec2 vFx;`,
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
transformed += aBend * (sin(uTime * uFreq + aInst.x) * aInst.z);`,
      );
    s.fragmentShader = s.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uRim;
uniform float uRimK;
varying vec2 vKeep;
varying vec2 vFx;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.97, 0.92), vFx.x * 0.45);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  float nv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
  float rim = pow(1.0 - nv, 2.5);
  totalEmissiveRadiance += uRim * (rim * uRimK) * (1.0 - vKeep.y);
  totalEmissiveRadiance += diffuseColor.rgb * (vKeep.y + vFx.y);
  totalEmissiveRadiance += vec3(1.0, 0.85, 0.7) * vFx.x * 0.3;
}`,
      );
  };
  m.customProgramCacheKey = () => 'toy' + (opts.transparent ? 't' : '');
  return m;
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
    a = exp(-pow((d - rr) * 10.0, 2.0)) * 0.55 + (1.0 - smoothstep(0.0, rr, d)) * 0.05;
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
    a = (a * 0.6 * (1.0 - smoothstep(0.7, 1.0, d)) + edge * 0.55) * fade;
    // rank (vB.w 0..1): denser, hotter; rank 5 adds a turning ring of runes inside the rim
    float rk = vB.w;
    a *= 1.0 + 0.55 * rk;
    if (rk > 0.99) {
      float ang = atan(p.y, p.x);
      float dash = step(0.45, fract(ang * 2.546 + uTime * 0.35 * (vA.z > 0.5 ? 1.0 : -1.0)));
      float band = smoothstep(0.035, 0.0, abs(d - 0.86));
      a += band * dash * 0.9 * fade;
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
  // rim only, drawn over critters and walls; fades out once resolved
  if (after >= 0.0 && !maw) discard;
  float rim = 1.0 - smoothstep(0.0, 0.09, sd);
  a = rim * (maw ? 0.55 : 0.5 + 0.35 * prog);
  if (a < 0.01) discard;
  gl_FragColor = vec4(mix(col, vec3(1.0), 0.25), a);
  #include <colorspace_fragment>
  return;
#endif
  if (maw) {
    float pulse = 0.5 + 0.5 * sin(uTime * 4.0 - depth * 6.0);
    a = 0.18 + edge * 0.9 + pulse * 0.25 * depth;
  } else if (after < 0.0) {
    // fill grows from the middle outward: inner = 0 at the middle, 1 at the rim
    float inner = 1.0 - depth;
    float filled = step(inner, prog);
    float front = 1.0 - smoothstep(0.0, 0.05, abs(inner - prog)) ;
    float stripes = 0.5 + 0.5 * sin((p.x + p.y) * 5.0 - uTime * 6.0);
    float rim = 1.0 - smoothstep(0.0, 0.22, sd);
    a = 0.3 + prog * 0.12 + stripes * 0.06 + rim * 0.95 + filled * (0.3 + prog * 0.2) + front * 0.4;
    col = mix(col, vec3(1.0, 0.8, 0.75), rim * 0.35 + front * 0.3);
  } else {
    // just resolved: flash, then either fade or keep a pulsing linger puddle
    float flash = 1.0 - smoothstep(0.0, 0.25, after);
    float lingerK = mod(vB.w, 2.0) > 0.5 ? 1.0 : 0.0;
    float pulse = 0.5 + 0.5 * sin(uTime * 7.0 + depth * 8.0);
    a = flash * 0.9 + lingerK * (0.3 + 0.2 * pulse + edge * 0.6);
    col = mix(col, vec3(1.0), flash * 0.6);
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
  float inner = (1.0 - smoothstep(0.0, 1.0, d)) * 0.15;
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
  g = mix(g, g * vec3(1.05, 0.62, 0.55), uPump * r);
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
