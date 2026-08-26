/**
 * Warcraft III ParticleEmitter2, rebuilt on the client.
 *
 * glTF has no concept of a particle emitter, so tools/mdx2gltf.py carries each
 * one across as node extras and this puts it back. It matters more than it
 * sounds: around eighty of the game's effect models -- Death and Decay, Cloud of
 * Fog, Flame Strike's burn, most of the blood and frost -- contain no geometry
 * whatsoever. Strip the emitters and they convert to a valid, entirely empty
 * scene, which is exactly how a spell ends up doing its animation while nothing
 * appears.
 *
 * Emitted particles do not follow the bone they came from; they are placed in
 * the effect's own space and left there, which is how Warcraft III behaves for
 * everything but a model-space emitter.
 */
import * as THREE from 'three';

const VERT = `
attribute float psize;
attribute float palpha;
attribute vec3 pcolor;
attribute vec2 pcell;
varying float vAlpha;
varying vec3 vColor;
varying vec2 vCell;
void main() {
  vAlpha = palpha; vColor = pcolor; vCell = pcell;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = psize * (300.0 / max(1.0, -mv.z));
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = `
uniform sampler2D map;
uniform vec2 grid;
varying float vAlpha;
varying vec3 vColor;
varying vec2 vCell;
void main() {
  if (vAlpha <= 0.0) discard;
  vec2 uv = (vCell + gl_PointCoord) / grid;
  uv.y = 1.0 - uv.y;                       // glTF images are top-down
  vec4 t = texture2D(map, uv);
  gl_FragColor = vec4(t.rgb * vColor, t.a * vAlpha);
  if (gl_FragColor.a < 0.01) discard;
}`;

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * An emitter's on/off switch for the sequence being played.
 *
 * Warcraft III scopes animation tracks to the playing sequence, and an
 * emitter's visibility track is mostly a list of the sequences it is *off*
 * for -- across this map's models, 8594 of 10381 keyed (emitter, sequence)
 * pairs hold zero for the whole sequence. Emitting regardless, which is what
 * this did, is why a standing Huntress trailed riding dust and idle units
 * smoked and bled: the converter carries `vis` across per sequence, and
 * `ctx` is which one is playing and how far into it.
 *
 * No context means no animation to scope to, so the emitter simply runs.
 */
export function visAt(vis, ctx) {
  return sampleSeq(vis, ctx, 1);
}

/**
 * Sample a per-sequence track at the moment `ctx` describes.
 *
 * Each entry is either a constant for that whole sequence or a list of
 * [seconds-from-sequence-start, value] pairs. Without a context there is no
 * sequence to look up, so the caller's default stands.
 */
export function sampleSeq(track, ctx, dflt) {
  if (!track || !ctx || ctx.seq == null || ctx.seq < 0) return dflt;
  const e = track[ctx.seq];
  if (e === undefined) return dflt;
  if (typeof e === 'number') return e;
  const t = ctx.t || 0;
  if (t <= e[0][0]) return e[0][1];
  const last = e[e.length - 1];
  if (t >= last[0]) return last[1];
  for (let i = 0; i < e.length - 1; i++) {
    if (t >= e[i][0] && t <= e[i + 1][0]) {
      const span = e[i + 1][0] - e[i][0];
      return span <= 0 ? e[i + 1][1]
        : lerp(e[i][1], e[i + 1][1], (t - e[i][0]) / span);
    }
  }
  return last[1];
}

/** The largest rate a per-sequence track ever asks for, for sizing buffers. */
function peakOf(track, floor) {
  let peak = floor || 0;
  for (const e of track || []) {
    if (Array.isArray(e)) { for (const [, v] of e) peak = Math.max(peak, v); }
    else peak = Math.max(peak, e || 0);
  }
  return peak;
}

/** Colour, alpha and size are given at three moments; walk between them. */
function segment(e, t) {
  const half = t < 0.5;
  const u = half ? t * 2 : (t - 0.5) * 2;
  const i = half ? 0 : 1, j = half ? 1 : 2;
  const c0 = e.color[i], c1 = e.color[j];
  return {
    r: lerp(c0[0], c1[0], u), g: lerp(c0[1], c1[1], u), b: lerp(c0[2], c1[2], u),
    a: lerp(e.alpha[i], e.alpha[j], u),
    s: lerp(e.scale[i], e.scale[j], u),
  };
}

class Emitter {
  constructor(def, origin, texture) {
    this.d = def;
    this.origin = origin;
    // Size the pool from the loudest rate the emitter ever reaches, not the
    // static one: for an explosion the static rate is 0 and the real one --
    // up to 500 a second -- lives in the animated track.
    this.peakRate = peakOf(def.rateSeq, def.rate || 0);
    const cap = Math.max(8, Math.ceil(this.peakRate * Math.max(0.1, def.lifespan)) + 8);
    this.cap = Math.min(cap, 600);          // a runaway emitter must not stall the frame
    this.n = 0;
    this.age = new Float32Array(this.cap);
    this.life = new Float32Array(this.cap);
    this.vel = new Float32Array(this.cap * 3);
    const pos = new Float32Array(this.cap * 3);
    const col = new Float32Array(this.cap * 3);
    const alp = new Float32Array(this.cap);
    const siz = new Float32Array(this.cap);
    const cell = new Float32Array(this.cap * 2);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('pcolor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('palpha', new THREE.BufferAttribute(alp, 1));
    geo.setAttribute('psize', new THREE.BufferAttribute(siz, 1));
    geo.setAttribute('pcell', new THREE.BufferAttribute(cell, 2));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);   // never cull
    const additive = def.filter === 1 || def.filter === 3 || def.filter === 4;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: texture }, grid: { value: new THREE.Vector2(def.cols, def.rows) } },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.geo = geo;
    this.emitAcc = 0;
    this.wasOn = false;      // whether the track had it switched on last frame
  }

  spawn() {
    const d = this.d, i = this.n < this.cap ? this.n++ : (Math.random() * this.cap) | 0;
    const lat = (d.latitude || 0) * Math.PI / 180;
    // a cone about straight up, `latitude` degrees wide
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.random() * lat;
    const sp = (d.speed || 0) * (1 + (Math.random() * 2 - 1) * (d.variation || 0) / Math.max(1, Math.abs(d.speed || 1)));
    const sx = Math.sin(phi) * Math.cos(theta), sy = Math.cos(phi), sz = Math.sin(phi) * Math.sin(theta);
    this.vel[i * 3] = sx * sp;
    this.vel[i * 3 + 1] = sy * sp;
    this.vel[i * 3 + 2] = sz * sp;
    const pos = this.geo.attributes.position.array;
    // emitters have an extent: width across, length along
    pos[i * 3]     = this.origin.x + (Math.random() - 0.5) * (d.width || 0);
    pos[i * 3 + 1] = this.origin.y;
    pos[i * 3 + 2] = this.origin.z + (Math.random() - 0.5) * (d.length || 0);
    const cells = Math.max(1, d.rows * d.cols);
    const c = (Math.random() * cells) | 0;
    const cell = this.geo.attributes.pcell.array;
    cell[i * 2] = c % d.cols;
    cell[i * 2 + 1] = (c / d.cols) | 0;
    this.age[i] = 0;
    this.life[i] = Math.max(0.05, d.lifespan);
  }

  update(dt, ctx) {
    const d = this.d;
    const on = visAt(d.vis, ctx) > 0.01;
    // The rate is usually animated; the static number beside it is 0 for every
    // emitter that spikes, which is most explosions. Whatever it works out to,
    // a rate of zero emits nothing -- there is no floor to fall back to.
    const rate = sampleSeq(d.rateSeq, ctx, d.rate || 0);
    if (!on) {
      this.emitAcc = 0;
    } else if (rate > 0) {
      this.emitAcc += rate * dt;
      // Squirt throws its batch in a single frame instead of spreading it over
      // the second; that is the whole of what the flag means.
      let budget = d.squirt ? Math.min(this.emitAcc | 0, 60)
                            : Math.min(this.emitAcc | 0, 40);
      if (d.squirt) this.emitAcc = budget ? 0 : this.emitAcc;
      else this.emitAcc -= budget;
      while (budget-- > 0) this.spawn();
    }
    this.wasOn = on;
    const pos = this.geo.attributes.position.array;
    const col = this.geo.attributes.pcolor.array;
    const alp = this.geo.attributes.palpha.array;
    const siz = this.geo.attributes.psize.array;
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      if (t >= 1) { alp[i] = 0; continue; }
      this.vel[i * 3 + 1] -= (d.gravity || 0) * dt;
      pos[i * 3]     += this.vel[i * 3] * dt;
      pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const s = segment(d, t);
      col[i * 3] = s.r; col[i * 3 + 1] = s.g; col[i * 3 + 2] = s.b;
      alp[i] = s.a;
      siz[i] = s.s;
    }
    this.geo.setDrawRange(0, this.n);
    for (const a of ['position', 'pcolor', 'palpha', 'psize', 'pcell'])
      this.geo.attributes[a].needsUpdate = true;
  }

  dispose() { this.geo.dispose(); this.mat.dispose(); }
}

/**
 * Rebuild every emitter in a loaded model, parented to `root` so the whole
 * effect can be moved and removed as one thing.
 */
export function buildEmitters(root, loadTexture) {
  const out = [];
  root.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  root.traverse((o) => {
    const def = o.userData && o.userData.w3particle;
    if (!def || !def.texture) return;
    const origin = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).applyMatrix4(inv);
    const tex = loadTexture(def.texture);
    if (!tex) return;
    const e = new Emitter(def, origin, tex);
    root.add(e.points);
    out.push(e);
  });
  return out;
}
