import * as THREE from 'three';
import { buildEmitters } from './particles.js';
import { buildRibbons } from './ribbons.js';
import { LightPool, buildLights, stepLights } from './lights.js';
import { buildSprays } from './sprays.js';
import { SplatField, buildEvents, stepEvents } from './splats.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { Ent } from '/shared/const.js';

const TEAM_COLOR = [0x4f8fe0, 0xe05050, 0x9a9a9a];

// Every way this map writes "there is no model here". Four spellings of the
// same Korean word appear across its dummy unit types.
const NO_MODEL = new Set(['없다', '없음', '업다', '읎지여', 'none', '_', '-']);

// See pickClip: whether a building's working animation counts as one of its
// idle variants. The map's data does not settle it, so it is one constant.
const STAND_WORK_IDLES = true;

// The logical states the rest of the client asks for, as Warcraft III token
// sets. Anything not listed is tokenised as written, so an ability's own
// Animnames ("spell,slam") passes straight through.
const TAGS = {
  stand: ['stand'],
  walk: ['walk'],
  attack: ['attack'],
  death: ['death'],
  spell: ['spell'],
};

/** Attach-point tokens: punctuation and the trailing "Ref" carry no meaning. */
function attachTokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')
    .split(' ').filter((t) => t && t !== 'ref');
}

/**
 * Split a sequence name into Warcraft III animation tokens.
 *
 * "Stand Ready Attack" -> [stand, ready, attack]. The trailing "- 2" that marks
 * a variant is not a token; it is which of several sequences sharing a name
 * this is, and treating it as one would stop "Stand - 2" matching a request for
 * "stand". Commas separate tokens too, which is how the object data writes them.
 */
function tokensOf(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s*-\s*\d+\s*$/, '')
    .split(/[\s,]+/)
    .filter(Boolean);
}

/**
 * Warcraft III's variant weighting. `rarity` marks a sequence as the unusual
 * one -- the idle where the footman shifts his grip. The common variants are
 * rarity 0 and are what plays nearly all the time; a rare one surfaces
 * occasionally, which is the whole point of having it.
 */
function weightedByRarity(pool, meta) {
  const rarityOf = (clip) => {
    const s = meta?.sequences?.find((x) => x.name.toLowerCase() === clip);
    return s?.rarity || 0;
  };
  const common = pool.filter((n) => rarityOf(n) === 0);
  const rare = pool.filter((n) => rarityOf(n) > 0);
  const use = (rare.length && Math.random() < 0.1) ? rare : (common.length ? common : pool);
  return use[(Math.random() * use.length) | 0];
}

/** Map WC3 world coords -> three.js coords. */
export const toX = (x) => x;
export const toZ = (y) => -y;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = false;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0c12);
    this.scene.fog = new THREE.Fog(0x0b1018, 4200, 9000);

    this.camera = new THREE.PerspectiveCamera(48, 1, 10, 12000);
    this.camTarget = new THREE.Vector3(0, 0, 0);
    this.camDist = 2600;
    this.camPitch = 1.02;          // radians from horizontal
    this.camYaw = 0;
    this.effects = new Map();      // live AddSpecialEffect instances, by id
    this.fxTextures = new Map();   // particle sprite sheets, shared across emitters
    this.groundItems = new Map();  // items lying in the world, by id
    this.lightPool = new LightPool(this.scene);   // fixed size: see lights.js
    this.missiles = new Map();     // shots in flight, by id
    this.splatField = null;        // ground splats, see splats.js

    this.scene.add(new THREE.HemisphereLight(0xa9c2e8, 0x2a2620, 1.15));
    const sun = new THREE.DirectionalLight(0xfff0d8, 1.15);
    sun.position.set(-800, 1600, 900);
    this.scene.add(sun);

    this.loader = new GLTFLoader();
    this.loader.setResourcePath('/assets/');   // glTF image URIs are asset-root relative
    this.modelCache = new Map();      // name -> {gltf, meta}
    this.pending = new Map();
    this.views = new Map();           // entId -> view
    this.clock = new THREE.Clock();
    this.selectionRing = null;
    this.terrain = null;
    this.floaters = [];

    addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------- world build
  /**
   * The ground surface, built straight in world space over the w3e vertex grid.
   *
   * Cells carrying a cliff are left out: Warcraft III drops the ground there and
   * stamps a cliff model that supplies the surface on both levels itself, so
   * filling the cell with interpolated ground is exactly what turns a step into
   * a ramp.  `cliffs.cells` is the list tools/cliffs.py drew a model for; ramp
   * cells are not in it and keep their sloping ground, as the game does.
   */
  async buildTerrain(terr, heights, cliffs = null) {
    const { width: W, height: H, tileSize: TS, offsetX, offsetY } = terr;
    const skip = new Set(cliffs && cliffs.cells ? cliffs.cells : []);
    const pos = new Float32Array(W * H * 3);
    const uv = new Float32Array(W * H * 2);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const v = j * W + i;                       // w3e vertex, row 0 = south
        pos[v * 3] = offsetX + i * TS;
        pos[v * 3 + 1] = heights[v] || 0;
        pos[v * 3 + 2] = -(offsetY + j * TS);
        // _ground.png is baked north-first, and the loader flips it: v=1 north
        uv[v * 2] = i / (W - 1);
        uv[v * 2 + 1] = j / (H - 1);
      }
    }
    const idx = [];
    for (let j = 0; j < H - 1; j++) {
      for (let i = 0; i < W - 1; i++) {
        if (skip.has(j * (W - 1) + i)) continue;
        const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const tex = await new THREE.TextureLoader().loadAsync('/assets/textures/_ground.png');
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    const mat = new THREE.MeshLambertMaterial({ map: tex });
    const mesh = new THREE.Mesh(geo, mat);
    this.scene.add(mesh);
    this.terrain = mesh;
    this.terrInfo = terr;
    this.heights = heights;
    if (cliffs) await this.buildCliffs(cliffs);
    await this.buildWater(terr);
    // splats lie on the terrain, so the field can only exist once it does
    this.splatField = new SplatField(this.scene, () => this.splatTable,
      (x, y) => this.heightAt(x, y), (uri) => this.fxTexture(uri));
    return mesh;
  }

  /**
   * The cliffs, as one baked mesh per cliff texture.
   *
   * tools/cliffs.py has already placed every cell's model and merged them into
   * world-space triangles, so there is nothing to instance here: the buffer is
   * interleaved position/normal/uv and goes straight to the GPU.  UVs come from
   * the .mdx unchanged, which is the glTF convention, so the texture must not
   * be flipped.
   */
  async buildCliffs(spec) {
    if (!spec || !spec.groups || !spec.groups.length || !spec.data) return null;
    const stride = spec.stride || 8;
    const data = spec.data;
    const loader = new THREE.TextureLoader();
    const group = new THREE.Group();
    for (const g of spec.groups) {
      const view = data.subarray(g.start * stride, (g.start + g.count) * stride);
      const inter = new THREE.InterleavedBuffer(view, stride);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.InterleavedBufferAttribute(inter, 3, 0));
      geo.setAttribute('normal', new THREE.InterleavedBufferAttribute(inter, 3, 3));
      geo.setAttribute('uv', new THREE.InterleavedBufferAttribute(inter, 2, 6));
      geo.computeBoundingSphere();
      let tex = null;
      try {
        tex = await loader.loadAsync('/assets/' + g.texture);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.flipY = false;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      } catch { tex = null; }
      const mat = new THREE.MeshLambertMaterial(tex ? { map: tex } : { color: 0x6b6b73 });
      group.add(new THREE.Mesh(geo, mat));
    }
    this.scene.add(group);
    this.cliffs = group;
    return group;
  }


  /**
   * Warcraft III stores water as a per-vertex flag plus an absolute level; the
   * staged data turns that into the tiles that show water and the height of
   * their surface.  In this map that is the moat ringing each base -- a trench
   * cut 256 below the bank and filled to ground level.
   */
  async buildWater(terr) {
    const spec = terr.water;
    if (!spec || !spec.cells || !spec.cells.length) return null;
    const { tileSize: TS, offsetX: OX, offsetY: OY, width: W } = terr;
    const cw = W - 1;
    // TerrainArt\Water.slk gives the surface offset for this tileset (-89.6 for
    // most of them); the level stored per vertex is the brim, and the drawn
    // surface sits that far below it.
    const DROP = spec.height ?? -89.6;
    // Warcraft III fades water out toward the shore instead of ending it on a
    // hard line -- that ramp, not a shader, is most of why a flat sheet reads
    // wrong.  Alpha comes from how deep the water is over each corner.
    const FADE = 140;                       // depth over which it reaches full body
    const MAX_A = 0.78;
    const n = spec.cells.length;
    const pos = new Float32Array(n * 4 * 3);
    const uv = new Float32Array(n * 4 * 2);
    const col = new Float32Array(n * 4 * 4);
    const idx = new Uint32Array(n * 6);
    const gh = (i, j) => (this.heights ? (this.heights[j * W + i] || 0) : 0);
    spec.cells.forEach((c, k) => {
      const i = c % cw, j = Math.floor(c / cw);
      const z = (spec.z[k] ?? 0) + DROP;
      const x0 = OX + i * TS, x1 = x0 + TS;
      const y0 = OY + j * TS, y1 = y0 + TS;
      const v = k * 4;
      const set = (o, x, y, ci, cj) => {
        pos[(v + o) * 3] = toX(x); pos[(v + o) * 3 + 1] = z; pos[(v + o) * 3 + 2] = toZ(y);
        const depth = z - gh(ci, cj);
        const a = Math.max(0, Math.min(1, depth / FADE)) * MAX_A;
        col.set([1, 1, 1, a], (v + o) * 4);
      };
      set(0, x0, y0, i, j); set(1, x1, y0, i + 1, j);
      set(2, x0, y1, i, j + 1); set(3, x1, y1, i + 1, j + 1);
      uv.set([0, 0, 1, 0, 0, 1, 1, 1], v * 2);
      idx.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], k * 6);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();

    // Warcraft III's water sequence is Water00..Water44 (WaterBlobs/WaterWake are
    // separate effects, not frames); stop at the first one that is not staged.
    const loader = new THREE.TextureLoader();
    const frames = [];
    const nFrames = spec.numTex || 45;
    for (let f = 0; f < nFrames; f++) {
      const name = String(f).padStart(2, '0');
      try {
        const tx = await loader.loadAsync(`/assets/textures/Textures/Water${name}.png`);
        tx.colorSpace = THREE.SRGBColorSpace;
        tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
        frames.push(tx);
      } catch { break; }
    }
    const mat = new THREE.MeshLambertMaterial({
      map: frames[0] || null,
      color: frames.length ? 0xffffff : 0x2f6f9e,
      vertexColors: true,                   // carries the shoreline alpha ramp
      transparent: true,
      depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 1;                 // draw over the trench floor
    this.scene.add(mesh);
    this.water = { mesh, mat, frames, t: 0, fps: spec.texRate || 15 };
    return mesh;
  }

  tickWater(dt) {
    const w = this.water;
    if (!w || w.frames.length < 2) return;
    w.t += dt;
    const f = Math.floor(w.t * w.fps) % w.frames.length;
    if (w.mat.map !== w.frames[f]) { w.mat.map = w.frames[f]; w.mat.needsUpdate = true; }
  }

  heightAt(wx, wy) {
    const t = this.terrInfo;
    if (!t || !this.heights) return 0;
    const fx = (wx - t.offsetX) / t.tileSize, fy = (wy - t.offsetY) / t.tileSize;
    const i = Math.max(0, Math.min(t.width - 1, Math.round(fx)));
    const j = Math.max(0, Math.min(t.height - 1, Math.round(fy)));
    return this.heights[j * t.width + i] || 0;
  }

  async addDoodads(list, meta = {}) {
    // Doodads with no visible model (pathing/LOS blockers) are invisible in the
    // real game; their effect is in the pathing map, which the server already uses.
    const visible = (list || []).filter((d) => (meta[d.id] || {}).visible !== false);
    if (!visible.length) return;
    const byType = new Map();
    for (const d of visible) {
      if (!byType.has(d.id)) byType.set(d.id, []);
      byType.get(d.id).push(d);
    }
    const group = new THREE.Group();
    for (const [id, items] of byType) {
      const info = meta[id] || {};
      // a doodad type can ship several numbered variations; `variation` picks one
      const protos = new Map();
      const protoFor = async (variation) => {
        const name = (info.v && info.v[variation]) || info.m;
        if (!name) return null;
        if (protos.has(name)) return protos.get(name);
        let scene = null;
        try { scene = (await this.loadModel(name)).gltf.scene; } catch { scene = null; }
        protos.set(name, scene);
        return scene;
      };
      for (const d of items) {
        const proto = await protoFor(d.variation || 0);
        const h = this.heightAt(d.x, d.y);
        let obj;
        if (proto) {
          obj = skeletonClone(proto);
        } else {
          obj = new THREE.Mesh(new THREE.CylinderGeometry(30, 40, 200, 6),
            new THREE.MeshLambertMaterial({ color: 0x33384a }));
          obj.position.y = 100;
        }
        const holder = new THREE.Group();
        holder.add(obj);
        holder.position.set(toX(d.x), h + (d.z || 0), toZ(d.y));
        holder.rotation.y = d.rot || 0;
        const s = (info.s || 1);
        holder.scale.set((d.sx || 1) * s, (d.sz || 1) * s, (d.sy || 1) * s);
        group.add(holder);
      }
    }
    this.scene.add(group);
    this.doodads = group;
  }

  // ---------------------------------------------------------------- models
  async loadModel(name) {
    if (this.modelCache.has(name)) return this.modelCache.get(name);
    if (this.pending.has(name)) return this.pending.get(name);
    const p = (async () => {
      const [gltf, meta] = await Promise.all([
        this.loader.loadAsync(`/assets/models/${name}.glb`),
        fetch(`/assets/models/${name}.json`).then((r) => r.json()),
      ]);
      gltf.scene.traverse((o) => {
        if (o.isMesh) {
          o.frustumCulled = false;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const mm of mats) {
            if (mm.map) mm.map.colorSpace = THREE.SRGBColorSpace;
            mm.side = mm.side ?? THREE.FrontSide;
          }
        }
      });
      const rec = { gltf, meta };
      this.modelCache.set(name, rec);
      return rec;
    })();
    this.pending.set(name, p);
    return p;
  }

  async spawnView(ent) {
    if (this.views.has(ent.i)) return this.views.get(ent.i);
    const view = { id: ent.i, kind: ent.k, team: ent.t, root: new THREE.Group(),
                   mixer: null, actions: new Map(), meta: null, current: null,
                   prims: [], loading: true, x: ent.x, y: ent.y, facing: ent.f };
    this.views.set(ent.i, view);
    this.scene.add(view.root);
    view.root.position.set(toX(ent.x), this.heightAt(ent.x, ent.y), toZ(ent.y));

    const name = ent.model;
    view.isHero = !!ent.isHero;
    // A Locust unit is a dummy the map casts its spells through -- the player is
    // never meant to see or touch it. Its model is deliberately a name that does
    // not exist, and this map spells that four different ways in Korean
    // ("없다", "없음", "업다", "읎지여"), so matching the spellings is a losing
    // game: what settles it is that the unit is Locust and has no model. Give it
    // no stand-in mesh, or it walks the battlefield as a grey capsule -- the
    // "ghost orc" left behind by Byakuya's Senka.
    if (!name && ent.locust) { view.loading = false; return view; }
    if (!name) {
      // Blizzard base models are not inside the map file; use readable stand-ins.
      if (ent.k === Ent.SHOP || ent.isBuilding) {
        const body = new THREE.Mesh(new THREE.BoxGeometry(200, 210, 200),
          new THREE.MeshLambertMaterial({ color: 0x6d6a63 }));
        body.position.y = 105;
        const roof = new THREE.Mesh(new THREE.ConeGeometry(165, 130, 4),
          new THREE.MeshLambertMaterial({ color: 0x8a5a3c }));
        roof.position.y = 275; roof.rotation.y = Math.PI / 4;
        view.root.add(body, roof);
      } else {
        const r = Math.max(14, (ent.radius || 24) * 0.9);
        const g = new THREE.CapsuleGeometry(r, r * 2, 4, 10);
        const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial(
          { color: TEAM_COLOR[ent.t] ?? 0x888888 }));
        mesh.position.y = Math.max(14, (ent.radius || 24) * 0.9) * 2;
        view.root.add(mesh);
      }
      view.loading = false;
      return view;
    }
    const { gltf, meta } = await this.loadModel(name);
    const obj = skeletonClone(gltf.scene);
    obj.scale.setScalar(ent.scale || 1);
    view.root.add(obj);
    view.obj = obj;
    view.meta = meta;
    view.isBuilding = !!ent.isBuilding;      // decides the Stand Work question
    view.animProps = tokensOf(ent.an);       // Required Animation Names
    this.attachShadow(view, ent);
    this.attachSplat(view, ent);
    // Materials first, and prims with them. Emitters, ribbons and sprays add
    // their own meshes to this same object, so collecting prims afterwards
    // counts those too -- which slides the geoset index off the end and hands
    // an emitter's carefully built ShaderMaterial the blending rules meant for
    // a geoset. prims is indexed one-to-one against meta.geosets and must hold
    // nothing but the model's own geometry.
    view.prims = this.applyMaterials(obj, meta);
    view.emitters = this.attachEmitters(obj);
    view.ribbons = this.attachRibbons(obj);
    // Deliberately no lights on unit views: a unit lives for the whole game and
    // would hold its pool slot forever, so the first eight units with a torch
    // would leave nothing for any spell. Lights go to effects and missiles,
    // which come and go.
    this.attachSprays(obj, view);
    view.events = buildEvents(obj);      // blood, footprints, impacts
    // Team colour, the way Warcraft III does it: a material bound to a
    // ReplaceableTextures swatch wears the *owning player's* colour, so the
    // texture is swapped rather than the material tinted. The converter bakes
    // colour 00 (red) as the default, which is why every unit of every team used
    // to arrive red; `ent.c` is the colour the map actually gave that player.
    const colour = String(ent.c ?? ent.p ?? 0).padStart(2, '0');
    view.prims.forEach((mesh, i) => {
      const gi = meta.geosets?.[i];
      const mt = gi ? meta.materials?.[gi.material] : null;
      const kind = /ReplaceableTextures\/(TeamColor|TeamGlow)\//i.exec(mt?.texture || '');
      if (!kind) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mesh.material = mats.map((mm) => {
        const c = mm.clone();
        c.map = this.teamTexture(kind[1], colour) || c.map;
        if (c.emissiveMap) c.emissiveMap = c.map;
        return c;
      });
      if (mesh.material.length === 1) mesh.material = mesh.material[0];
    });
    if (gltf.animations.length) {
      view.mixer = new THREE.AnimationMixer(obj);
      for (const clip of gltf.animations) {
        const a = view.mixer.clipAction(clip);
        view.actions.set(clip.name.toLowerCase(), a);
      }
      // Warcraft III draws a fresh idle variant each time the animation comes
      // round; that is what makes a building's work animation surface every so
      // often rather than never or always.
      view.mixer.addEventListener('loop', (e) => {
        if (view.stateName !== 'stand' || e.action !== view.currentAction) return;
        this.play(view, 'stand', false, true);
      });
    }
    view.loading = false;
    this.play(view, 'stand');
    return view;
  }

  /**
   * Honour each geoset's MDX filter mode, and hand back the meshes in geoset
   * order so the geoset-visibility pass can index them.
   *
   * This lived inside buildView and so ran for *units only*. Warcraft III
   * effect art is glow art -- 540 of the 659 materials on this map's 312
   * ability-art models are additive or addalpha -- and every one of those
   * models arrives through spawnEffect or spawnMissile, which never ran this.
   * They drew with plain glTF alpha: a flat quad where a glow belongs.
   */
  applyMaterials(obj, meta) {
    const prims = [];
    obj.traverse((o) => { if (o.isMesh) prims.push(o); });
    prims.forEach((mesh, i) => {
      const gi = meta?.geosets?.[i];
      const mt = gi ? meta.materials?.[gi.material] : null;
      if (!mt) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mm of mats) {
        if (mt.filter === 'additive' || mt.filter === 'addalpha') {
          mm.blending = THREE.AdditiveBlending;
          mm.transparent = true; mm.depthWrite = false;
        } else if (mt.filter === 'modulate' || mt.filter === 'modulate2x') {
          mm.blending = THREE.MultiplyBlending;
          mm.transparent = true; mm.depthWrite = false;
        } else if (mt.filter === 'blend') {
          mm.transparent = true; mm.depthWrite = false;
        }
        if (mt.unshaded) { mm.emissiveIntensity = 1; }
        if (mt.twoSided) mm.side = THREE.DoubleSide;
        if (mt.noDepthTest) mm.depthTest = false;
        // priorityPlane is the model's own answer to "which of these overlapping
        // additive layers goes on top"; it was exported and never read, leaving
        // the order to whatever the scene graph happened to produce.
        if (mt.priority) mesh.renderOrder = mt.priority;
      }
    });
    return prims;
  }

  /**
   * Which sequence a thing is playing and how far into it, for the emitters
   * hanging off it. Anything with no animation returns null, and an emitter
   * given no context simply runs -- there is no sequence to scope it to.
   */
  animCtxOf(h) {
    const a = h && (h.currentAction || h.action);
    return a ? { seq: h.seqIndex ?? -1, t: a.time } : null;
  }

  /**
   * Resolve a Warcraft III attach point to a node inside the model.
   *
   * The script names them the way the World Editor does -- "origin", "chest",
   * "weapon", "overhead", "right foot" -- while the model calls them
   * "Origin Ref", "Chest Ref", "Foot Right Ref", "Head - Ref". Matching is by
   * whole token, so word order does not matter, "Ref" and punctuation are
   * noise, and `head` cannot accidentally match `OverHead Ref` the way a
   * substring test would.
   *
   * The map does this 59 times and every one of them used to land on the unit's
   * root: an overhead buff drawn at the feet, a weapon effect at the origin.
   */
  attachNode(obj, attach) {
    const want = attachTokens(attach);
    if (!want.length || !obj) return null;
    let best = null, bestExtra = Infinity;
    obj.traverse((o) => {
      if (!o.name) return;
      const t = attachTokens(o.name);
      if (!t.length || !want.every((w) => t.includes(w))) return;
      const extra = t.filter((x) => !want.includes(x)).length;
      if (extra < bestExtra) { bestExtra = extra; best = o; }
    });
    return best;
  }

  /** Where a clip sits in the model's sequence list, which is what `vis` is keyed by. */
  seqIndexOf(meta, clipName) {
    if (!meta?.sequences || !clipName) return -1;
    const want = String(clipName).toLowerCase();
    return meta.sequences.findIndex((s) => s.name.toLowerCase() === want);
  }

  /**
   * Choose an MDX sequence for a logical state, the way Warcraft III does.
   *
   * The engine names animations by *token set*, not by string. The map says so
   * itself: 257 of its abilities carry an Animnames field holding things like
   * "spell,slam", "attack,slam", "stand,channel" -- a request for {spell, slam}
   * that matches the sequence "Spell Slam". A sequence qualifies when its own
   * tokens contain every token asked for.
   *
   * Among the qualifying sequences the engine picks one at random, weighted by
   * `rarity` -- which is exactly what that field is for, and which was exported
   * in the sequence meta and read by nothing. This mattered more than it looks:
   * the old code returned the *first* exact name match and never varied, so 416
   * of the 588 models this map places had stand variants that were unreachable
   * for the whole game.
   */
  pickClip(view, state) {
    if (!view.actions.size) return null;
    const names = [...view.actions.keys()];
    const want = TAGS[state] || tokensOf(state);
    const cand = names
      .map((n) => ({ n, extra: tokensOf(n).filter((t) => !want.includes(t)) }))
      .filter(({ n }) => {
        const t = tokensOf(n);
        return want.every((w) => t.includes(w));
      });
    if (!cand.length) {
      const loose = names.find((n) => n.startsWith(want[0] || ''));
      if (loose) return loose;
      // Falling back to Stand is only ever right for a unit that is alive. A
      // model with no Decay Flesh asked to decay must hold the pose its death
      // clip left it in -- returning Stand there stands the corpse back up.
      return TAGS[state] ? (names.find((n) => n.startsWith('stand')) || names[0]) : null;
    }
    // Containment alone is too loose. A request for {stand} contains "Stand
    // Upgrade Third Attack Ready" as surely as it contains "Stand", and drawing
    // freely among them made the arcane tower flicker between its base and all
    // three upgraded appearances. Warcraft III keeps the extra tokens in check
    // with the unit's required-animation list; what a unit does *not* declare,
    // it does not play. So only an exact match qualifies --
    let pool = cand.filter((c) => !c.extra.length);
    // -- with one documented exception. "Stand Work" is a building's working
    // animation, and whether the engine admits it into the plain idle pool is
    // not decidable from this map's data: the rarity values disagree with each
    // other (the Barracks has Stand at 1 and Stand Work at 0). It is admitted
    // for buildings only, which is where the war mill's `work smoke` and the
    // ammo dump's fire live. Flip this one constant to change that judgement.
    if (STAND_WORK_IDLES && view.isBuilding && want.includes('stand')) {
      pool = pool.concat(cand.filter((c) => c.extra.length === 1 && c.extra[0] === 'work'));
    }
    if (pool.length) return weightedByRarity(pool.map((c) => c.n), view.meta);
    // Nothing matches exactly -- the arcane tower has no plain "Stand" at all,
    // only "Stand Upgrade Third Attack Ready" and four siblings. Which of those
    // it is comes from its Required Animation Names: the Scout Tower, Guard
    // Tower and Arcane Tower are one model, and only "upgrade,first" against
    // "upgrade,third" separates them. Rank by how much of that a sequence
    // satisfies, then by how little else it drags in, then by the model's own
    // order so the choice is stable rather than flickering between equals.
    const req = view.animProps || [];
    const score = (c) => {
      const wanted = c.extra.filter((t) => req.includes(t)).length;
      return [-wanted, c.extra.length, this.seqIndexOf(view.meta, c.n)];
    };
    let best = cand[0], bs = score(best);
    for (const c of cand.slice(1)) {
      const s2 = score(c);
      for (let i = 0; i < s2.length; i++) {
        if (s2[i] !== bs[i]) { if (s2[i] < bs[i]) { best = c; bs = s2; } break; }
      }
    }
    return best.n;
  }

  play(view, state, once = false, reroll = false) {
    if (!view.mixer) return;
    // Selection is a random draw among variants now, so re-entering a state the
    // unit is already in must not re-roll on every call -- only when the state
    // actually changes, or when the clip has come round and the engine would
    // draw again.
    if (!reroll && view.stateName === state && view.currentAction?.isRunning()) return;
    const clip = this.pickClip(view, state);
    if (!clip) return;
    if (view.current === clip) { view.stateName = state; return; }
    const next = view.actions.get(clip);
    if (!next) return;
    if (view.currentAction) view.currentAction.fadeOut(0.18);
    next.reset();
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = once;
    next.fadeIn(0.18).play();
    view.current = clip;
    view.currentAction = next;
    view.stateName = state;
    view.seqIndex = this.seqIndexOf(view.meta, clip);
    this.applyGeosetVisibility(view, clip);
  }

  /** MDX geoset animations decide which geosets show in each sequence. */
  applyGeosetVisibility(view, clipName) {
    const meta = view.meta;
    if (!meta?.sequences) return;
    const seq = meta.sequences.find((s) => s.name.toLowerCase() === clipName);
    const alpha = seq?.geosetAlpha;
    if (!alpha) return;
    view.prims.forEach((mesh, i) => {
      const a = alpha[i];
      if (a === undefined) return;
      mesh.visible = a > 0.05;
    });
    // some sequences fade a geoset in or out partway through (gore appearing
    // mid-death, flesh dissolving during Decay); those get ticked per frame
    view.alphaCurve = seq.geosetAlphaCurve || null;
  }

  /** Sample the in-sequence alpha curves against the clip's current time. */
  tickGeosetCurves(view) {
    const curves = view.alphaCurve;
    if (!curves || !view.currentAction) return;
    const t = view.currentAction.time;
    for (let i = 0; i < curves.length; i++) {
      const c = curves[i], mesh = view.prims[i];
      if (!c || !mesh) continue;
      let a;
      if (t <= c[0][0]) a = c[0][1];
      else if (t >= c[c.length - 1][0]) a = c[c.length - 1][1];
      else {
        let k = 0;
        while (k < c.length - 2 && c[k + 1][0] < t) k++;
        const [t0, a0] = c[k], [t1, a1] = c[k + 1];
        const span = t1 - t0;
        a = span <= 0 ? a0 : a0 + (a1 - a0) * ((t - t0) / span);
      }
      mesh.visible = a > 0.05;
    }
  }


  // ------------------------------------------------------------ spell visuals
  /**
   * models.json is keyed by the archive path ("units\creeps\gnoll\gnoll");
   * the converted files swap the separator for "~".
   */
  modelIndex() {
    if (!this._modelIndex) {
      this._modelIndex = fetch('/assets/models.json')
        .then((r) => r.json())
        .then((idx) => {
          const m = new Map(), byBase = new Map();
          for (const k of Object.keys(idx)) {
            const asset = k.replace(/\\/g, '~');
            const low = k.toLowerCase();
            m.set(low, asset);
            // map imports are keyed by bare name ("OrbitalRay") while the script
            // asks for "war3mapImported\OrbitalRay.mdl", so index the tail too
            byBase.set(low.split('\\').pop(), asset);
          }
          return { exact: m, byBase };
        })
        .catch(() => ({ exact: new Map(), byBase: new Map() }));
    }
    return this._modelIndex;
  }

  /** A model path as the map's script writes it -> converted asset name. */
  async resolveModel(path) {
    if (!path) return null;
    const idx = await this.modelIndex();
    const key = String(path)
      .replace(/\\\\/g, '\\')
      .replace(/\//g, '\\')
      .replace(/^\\+/, '')
      .replace(/\.(mdl|mdx)$/i, '')
      .toLowerCase();
    // the map's explicit "no model", which it spells several ways
    if (!key || key === 'none' || NO_MODEL.has(key.replace(/\.(mdl|mdx)$/i, ''))) return null;
    return idx.exact.get(key) || idx.byBase.get(key.split('\\').pop()) || null;
  }

  /** AddSpecialEffect / AddSpecialEffectTarget. */
  /**
   * Put back the particle emitters glTF cannot carry.
   *
   * The sprite sheet is shared: a hundred blood effects on screen are a hundred
   * emitters but one texture, and re-decoding it per effect is what turns a
   * spell into a stutter.
   */
  /** TeamColor07.png / TeamGlow07.png and the rest, loaded once and shared. */
  teamTexture(kind, colour) {
    const uri = `textures/ReplaceableTextures/${kind}/${kind}${colour}.png`;
    let t = this.fxTextures.get(uri);
    if (!t) {
      t = new THREE.TextureLoader().load('/assets/' + uri);
      t.colorSpace = THREE.SRGBColorSpace;
      t.flipY = false;                 // glTF UVs, like the texture it replaces
      this.fxTextures.set(uri, t);
    }
    return t;
  }

  /**
   * ParticleEmitter1 sprays -- the models a creep bursts into.
   *
   * Async, because each emitter names a model of its own to throw; the sprays
   * attach a moment after the unit does, which is harmless since they fire on
   * death rather than on spawn.
   */
  attachSprays(obj, owner) {
    buildSprays(obj, async (path) => {
      const name = await this.resolveModel(path);
      if (!name) return null;
      const rec = await this.loadModel(name);
      return skeletonClone(rec.gltf.scene);
    }).then((list) => { owner.sprays = list; }).catch(() => {});
  }

  /**
   * A unit's shadow.
   *
   * Warcraft III does not shadow-map anything: it lays a flat textured quad on
   * the ground beneath each unit, and the unit's own data names the image and
   * gives its size and offset -- 767 of this map's 997 unit types carry one.
   * That is why turning `shadowMap` on would not have produced them, and why it
   * stays off: this is both faithful and far cheaper than a shadow pass.
   */
  attachShadow(view, ent) {
    if (!ent.sh || view.shadow) return;
    const w = (ent.sw || 128), h = (ent.shh || 128);
    const tex = this.fxTextures.get('shadow:' + ent.sh) || (() => {
      const t = new THREE.TextureLoader().load(
        `/assets/textures/ReplaceableTextures/Shadows/${ent.sh}.png`);
      t.colorSpace = THREE.SRGBColorSpace;
      this.fxTextures.set('shadow:' + ent.sh, t);
      return t;
    })();
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.55,
                                    depthWrite: false, color: 0x000000 }));
    mesh.rotation.x = -Math.PI / 2;
    // shadowX/shadowY place the image's corner, not its centre
    mesh.position.set(w / 2 - (ent.sx || 0), 3, h / 2 - (ent.sy || 0));
    mesh.renderOrder = -1;
    view.root.add(mesh);
    view.shadow = mesh;
  }

  /**
   * The ground decal a building is stamped on.
   *
   * Warcraft III lays an "ubersplat" under every building -- scorched earth
   * beneath an orc hut, flagstones beneath a human one, the rune ring under an
   * altar. The unit names a row in Splats\UberSplatData.slk which gives the
   * texture and a scale; 961 of this map's unit types name one and 179 of those
   * references resolve to art. None of it drew, because that whole directory
   * was missing from the extraction.
   *
   * It sits a hair above the ground and below the unit's shadow, and does not
   * write depth, so terrain and shadow both read through it correctly.
   */
  attachSplat(view, ent) {
    const id = ent.us;
    if (!id || view.splat) return;
    const spec = this.splats?.[id];
    if (!spec) return;
    const key = 'splat:' + id;
    let tex = this.fxTextures.get(key);
    if (!tex) {
      tex = new THREE.TextureLoader().load('/assets/' + spec.t);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.fxTextures.set(key, tex);
    }
    const s = Math.max(16, spec.s || 100);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(s, s),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false,
                                    // BlendMode 1 is the additive glow used by
                                    // rune circles; 0 is ordinary alpha
                                    blending: spec.b === 1 ? THREE.AdditiveBlending
                                                           : THREE.NormalBlending }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 2;
    mesh.renderOrder = -2;              // under the shadow, over the ground
    view.root.add(mesh);
    view.splat = mesh;
  }

  /** Omni lights an effect carries, borrowed from the fixed pool. */
  attachLights(obj, owner) { return buildLights(obj, this.lightPool, owner); }

  /**
   * An event object has come round: do the thing it names.
   *
   * The node's own world position is where it happens -- a wound, a foot, the
   * point a body part is thrown from -- so a splat lands under the wound rather
   * than under the unit's origin.
   */
  fireEvent(e) {
    e.node.updateWorldMatrix(true, false);
    const p = new THREE.Vector3().setFromMatrixPosition(e.node.matrixWorld);
    const wx = p.x, wy = -p.z;         // back out of three.js coords
    // a handful of models spell the kind in lower case ('fptxFBL1')
    switch (String(e.d.kind).toUpperCase()) {
      // a splat and a footprint are the same thing from the same table; the
      // only difference is which cells of the sheet they use
      case 'SPL':
      case 'FPT':
        this.splatField?.add(e.d.id, wx, wy);
        break;
      case 'UBR': {
        // an ubersplat is a single image rather than a sheet, and holds before
        // it decays; the field draws it the same way once told so
        const u = this.splats?.[e.d.id];
        if (u) {
          this.splatField?.addSpec({ t: u.t, rows: 1, cols: 1, s: u.s, b: u.b,
                                     uv: [0, 0, 0, 0],
                                     life: (u.birth || 0) + (u.hold || 0),
                                     decay: u.decay || 2,
                                     c: [[255, 255, 255, 255], [255, 255, 255, 255],
                                         [255, 255, 255, 0]] }, wx, wy);
        }
        break;
      }
      case 'SPN': {
        const path = this.spawnTable?.[e.d.id];
        if (path) this.spawnEffect({ fx: 'spn' + (this.spawnSeq = (this.spawnSeq || 0) + 1),
                                     path, x: wx, y: wy, ttl: 4 }, false);
        break;
      }
      case 'SND': {
        // resolves to a sound *label*; turning that into a file needs the
        // UI\SoundInfo tables, which are not compiled yet
        const label = this.animSounds?.[e.d.id];
        if (label && this.onAnimSound) this.onAnimSound(label, wx, wy);
        break;
      }
    }
  }

  /** One texture per path, shared by every effect that names it. */
  fxTexture(uri) {
    let t = this.fxTextures.get(uri);
    if (!t) {
      t = new THREE.TextureLoader().load('/assets/' + uri);
      t.colorSpace = THREE.SRGBColorSpace;
      this.fxTextures.set(uri, t);
    }
    return t;
  }

  /** Trails dragged behind a bone; the same shared-texture rule as emitters. */
  attachRibbons(obj) {
    return buildRibbons(obj, (uri) => {
      let t = this.fxTextures.get(uri);
      if (!t) {
        t = new THREE.TextureLoader().load('/assets/' + uri);
        t.colorSpace = THREE.SRGBColorSpace;
        this.fxTextures.set(uri, t);
      }
      return t;
    });
  }

  attachEmitters(obj) {
    return buildEmitters(obj, (uri) => {
      let t = this.fxTextures.get(uri);
      if (!t) {
        t = new THREE.TextureLoader().load('/assets/' + uri);
        t.colorSpace = THREE.SRGBColorSpace;
        this.fxTextures.set(uri, t);
      }
      return t;
    });
  }

  async spawnEffect(ev, onUnit) {
    if (this.effects.has(ev.fx)) return;
    const name = await this.resolveModel(ev.path);
    if (!name) return;
    let rec;
    try { rec = await this.loadModel(name); } catch { return; }
    if (this.effects.has(ev.fx)) return;            // destroyed while loading
    const obj = skeletonClone(rec.gltf.scene);
    let parent = this.scene;
    if (onUnit) {
      const v = this.views.get(ev.id);
      if (!v) return;
      // hang it off the named attach point if the model has one; the root is
      // the fallback, and the map's "origine" typo is meant to find nothing
      parent = this.attachNode(v.obj, ev.attach) || v.root;
    } else {
      obj.position.set(toX(ev.x), this.heightAt(ev.x, ev.y), toZ(ev.y));
    }
    parent.add(obj);
    const fx = { obj, parent, mixer: null };
    if (rec.gltf.animations.length) {
      fx.mixer = new THREE.AnimationMixer(obj);
      const pick = (n) => rec.gltf.animations.find((a) => a.name.toLowerCase().startsWith(n));
      const birth = pick('birth'), stand = pick('stand');
      const clip = birth || stand || rec.gltf.animations[0];
      const act = fx.mixer.clipAction(clip);
      act.setLoop(birth ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
      act.clampWhenFinished = true;
      act.play();
      fx.currentAction = act;
      fx.current = clip.name.toLowerCase();
      fx.seqIndex = this.seqIndexOf(rec.meta, clip.name);
      // Warcraft III effects play Birth once, then settle into Stand.
      if (birth && stand) {
        fx.mixer.addEventListener('finished', () => {
          fx.currentAction = fx.mixer.clipAction(stand).reset().play();
          fx.current = stand.name.toLowerCase();
          fx.seqIndex = this.seqIndexOf(rec.meta, stand.name);
          this.applyGeosetVisibility(fx, fx.current);
        });
      } else if (birth) {
        // ...but a model with *only* a Birth has nothing to settle into, and the
        // effect is over when the animation is. Clamping the last frame instead
        // leaves the thing standing on the battlefield for the rest of the game:
        // Byakuya's Flash Step and Senka both play MirrorImageCaster, whose one
        // and only sequence is Birth, and it is a transparent orc.
        fx.mixer.addEventListener('finished', () => this.endEffect(ev.fx));
      }
    }
    fx.meta = rec.meta;
    fx.prims = this.applyMaterials(obj, rec.meta);
    // and the same per-sequence geoset switching units get: an effect model's
    // sequences hide and show parts of it just as a unit's do
    if (fx.current) this.applyGeosetVisibility(fx, fx.current);
    fx.emitters = this.attachEmitters(obj);
    fx.ribbons = this.attachRibbons(obj);
    fx.lights = this.attachLights(obj, fx);
    this.attachSprays(obj, fx);
    this.effects.set(ev.fx, fx);
    // The art an ability carries is one-shot: Warcraft III plays it and drops
    // it, with no DestroyEffect to match. A script's AddSpecialEffect has no
    // ttl and still lives until the script says otherwise.
    if (ev.ttl > 0) fx.expire = setTimeout(() => this.endEffect(ev.fx), ev.ttl);
    // a script that forgets DestroyEffect must not grow the scene without bound
    if (this.effects.size > 400) this.endEffect(this.effects.keys().next().value);
  }

  /**
   * A shot in flight.
   *
   * The server owns the outcome -- it decides when the missile lands and who it
   * damages -- so this only has to draw the thing travelling. It homes on the
   * target the way Warcraft III's do, and `Missilearc` bows the path upward by
   * that fraction of the distance covered.
   */
  async spawnMissile(ev) {
    if (this.missiles.has(ev.fx)) return;
    const name = await this.resolveModel(ev.path);
    if (!name) return;
    let rec;
    try { rec = await this.loadModel(name); } catch { return; }
    if (this.missiles.has(ev.fx)) return;          // it landed while loading
    const obj = skeletonClone(rec.gltf.scene);
    const z0 = this.heightAt(ev.x, ev.y) + 40;
    obj.position.set(toX(ev.x), z0, toZ(ev.y));
    this.scene.add(obj);
    const m = { obj, x: ev.x, y: ev.y, z0, tx: ev.tx, ty: ev.ty, id: ev.id,
                speed: Math.max(1, ev.speed || 900), arc: ev.arc || 0,
                travelled: 0, total: Math.max(1, Math.hypot(ev.tx - ev.x, ev.ty - ev.y)) };
    if (rec.gltf.animations.length) {
      m.mixer = new THREE.AnimationMixer(obj);
      const clip = rec.gltf.animations[0];
      m.currentAction = m.mixer.clipAction(clip).play();
      m.current = clip.name.toLowerCase();
      m.seqIndex = this.seqIndexOf(rec.meta, clip.name);
    }
    m.meta = rec.meta;
    m.prims = this.applyMaterials(obj, rec.meta);
    if (m.current) this.applyGeosetVisibility(m, m.current);
    m.emitters = this.attachEmitters(obj);
    m.ribbons = this.attachRibbons(obj);
    m.lights = this.attachLights(obj, m);
    this.missiles.set(ev.fx, m);
  }

  endMissile(fx) {
    const m = this.missiles.get(fx);
    this.missiles.delete(fx);
    if (!m) return;
    m.mixer?.stopAllAction();
    this.lightPool.release(m);         // hand the pool slot back
    this.scene.remove(m.obj);
  }

  stepMissiles(dt) {
    for (const [fx, m] of this.missiles) {
      m.mixer?.update(dt);
      const ctx = this.animCtxOf(m);
      for (const e of (m.emitters || [])) e.update(dt, ctx);
      for (const r of (m.ribbons || [])) r.update(dt, ctx);
      stepLights(m.lights || [], ctx);
      // follow the target while it lives, else keep to the point it was aimed at
      const v = m.id != null ? this.views.get(m.id) : null;
      const tx = v ? v.root.position.x : toX(m.tx);
      const tz = v ? v.root.position.z : toZ(m.ty);
      const px = toX(m.x), pz = toZ(m.y);
      const dx = tx - px, dz = tz - pz;
      const dist = Math.hypot(dx, dz);
      const move = m.speed * dt;
      if (dist <= move) { this.endMissile(fx); continue; }
      const nx = px + (dx / dist) * move, nz = pz + (dz / dist) * move;
      m.x = nx; m.y = -nz;
      m.travelled = Math.min(m.total, m.travelled + move);
      const k = m.total > 0 ? m.travelled / m.total : 1;
      const lift = m.arc > 0 ? m.arc * m.total * 4 * k * (1 - k) : 0;
      const ground = this.heightAt(m.x, m.y) + 40;
      m.obj.position.set(nx, ground + lift, nz);
      m.obj.rotation.y = Math.atan2(dx, dz);
    }
  }

  /** DestroyEffect. */
  endEffect(fx) {
    const e = this.effects.get(fx);
    this.effects.delete(fx);
    if (!e) return;
    if (e.expire) clearTimeout(e.expire);
    e.mixer?.stopAllAction();
    this.lightPool.release(e);
    e.parent?.remove(e.obj);
  }

  /**
   * SetUnitAnimation: the script names sequences loosely ("attack", "spell
   * slam"), so fall back to a prefix match the way the game does.
   */
  playUnitAnim(id, name) {
    const v = this.views.get(id);
    if (!v || !v.mixer || !v.actions.size) return;
    const want = String(name || '').toLowerCase().trim();
    if (!want) return;
    let clip = v.actions.has(want) ? want : null;
    if (!clip) {
      for (const k of v.actions.keys()) {
        if (k === want || k.startsWith(want + ' ') || k.startsWith(want)) { clip = k; break; }
      }
    }
    if (!clip) return;
    this.playClip(v, clip, !/^(stand|walk)/.test(clip));
  }

  /** SetUnitAnimationByIndex. */
  playUnitAnimIndex(id, i) {
    const v = this.views.get(id);
    if (!v || !v.actions.size) return;
    const names = [...v.actions.keys()];
    const clip = names[i];
    if (clip) this.playClip(v, clip, true);
  }

  playClip(view, clip, once) {
    const act = view.actions.get(clip);
    if (!act || view.current === clip) return;
    if (view.currentAction) view.currentAction.fadeOut(0.12);
    act.reset();
    act.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    act.clampWhenFinished = once;
    act.fadeIn(0.12).play();
    view.current = clip;
    view.currentAction = act;
    // The map drives 53 animations by name -- "attack", "birth", "spell",
    // "death". Without this the clip changes but the emitters stay scoped to
    // whatever sequence was playing before, so a script-triggered death plays
    // the standing unit's emitters and none of its own.
    view.seqIndex = this.seqIndexOf(view.meta, clip);
    this.applyGeosetVisibility(view, clip);
  }

  /** SetUnitVertexColor: materials are cloned per view, so this is per unit. */
  tintUnit(id, r, g, b, a) {
    const v = this.views.get(id);
    if (!v) return;
    const col = new THREE.Color((r ?? 255) / 255, (g ?? 255) / 255, (b ?? 255) / 255);
    const alpha = (a ?? 255) / 255;
    for (const mesh of v.prims) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mm of mats) {
        if (mm.color) mm.color.copy(col);
        if (alpha < 1) { mm.transparent = true; mm.opacity = alpha; }
        else if (mm.userData.__baseOpacity == null) { mm.opacity = 1; }
      }
    }
  }

  removeView(id) {
    const v = this.views.get(id);
    if (!v) return;
    for (const [fx, e] of this.effects) if (e.parent === v.root) this.endEffect(fx);
    this.lightPool.release(v);
    this.scene.remove(v.root);
    v.mixer?.stopAllAction();
    this.views.delete(id);
  }

  // ---------------------------------------------------------------- camera
  focus(x, y, snap = false) {
    const t = new THREE.Vector3(toX(x), this.heightAt(x, y), toZ(y));
    if (snap) this.camTarget.copy(t);
    else this.camTarget.lerp(t, 0.14);
  }
  panBy(dx, dz) {
    this.camTarget.x += dx; this.camTarget.z += dz;
  }
  clampCam(b) {
    if (!b) return;
    this.camTarget.x = Math.max(b.minX, Math.min(b.maxX, this.camTarget.x));
    this.camTarget.z = Math.max(-b.maxY, Math.min(-b.minY, this.camTarget.z));
  }
  /**
   * Camera shake, as CameraSetTargetNoise asks for it.
   *
   * `mag` is how far the camera is thrown, `vel` how fast it rattles. A shake
   * runs until the map cancels it with a magnitude of zero, so this holds the
   * request rather than decaying on its own -- the script decides when it stops,
   * and this map calls for one 91 times.
   */
  setShake(mag, vel, vert) {
    this.shake = mag > 0 ? { mag, vel: Math.max(0.1, vel || 1), vert: !!vert, t: 0 } : null;
  }

  updateCamera(dt = 0) {
    const d = this.camDist;
    const cp = Math.cos(this.camPitch), sp = Math.sin(this.camPitch);
    let ox = 0, oy = 0, oz = 0;
    const sh = this.shake;
    if (sh) {
      sh.t += dt;
      // two incommensurate frequencies per axis, so the rattle does not read as
      // a clean sine wave the eye can follow
      const w = sh.t * sh.vel;
      oy = Math.sin(w * 6.3) * sh.mag;
      if (!sh.vert) {
        ox = Math.sin(w * 4.7 + 1.3) * sh.mag;
        oz = Math.sin(w * 5.9 + 2.1) * sh.mag;
      }
    }
    this.camera.position.set(
      this.camTarget.x + Math.sin(this.camYaw) * cp * d + ox,
      this.camTarget.y + sp * d + oy,
      this.camTarget.z + Math.cos(this.camYaw) * cp * d + oz);
    this.camera.lookAt(this.camTarget);
  }

  /**
   * Items lying in the world.
   *
   * The server has always known about these; they simply were not on the wire,
   * so a dropped item existed at the right coordinates and nothing drew it. They
   * are not units -- no health, no team, no animation to speak of -- so they get
   * a much lighter view than spawnView builds, and they bob so a small model on
   * busy ground is still findable.
   */
  async syncItems(list, defs) {
    const seen = new Set();
    for (const e of (list || [])) {
      seen.add(e.i);
      let g = this.groundItems.get(e.i);
      if (!g) {
        g = { id: e.i, x: e.x, y: e.y, type: e.u, name: e.n, root: new THREE.Group(), loading: true };
        this.groundItems.set(e.i, g);
        this.scene.add(g.root);
        const def = defs && defs[e.u];
        const name = def && def.m ? await this.resolveModel(def.m) : null;
        // an item whose model did not convert still has to be clickable, so it
        // falls back to a marker rather than to nothing
        if (name) {
          try {
            const rec = await this.loadModel(name);
            const obj = skeletonClone(rec.gltf.scene);
            g.root.add(obj);
            if (rec.gltf.animations.length) {
              g.mixer = new THREE.AnimationMixer(obj);
              const clip = rec.gltf.animations[0];
              g.currentAction = g.mixer.clipAction(clip).play();
              g.seqIndex = this.seqIndexOf(rec.meta, clip.name);
            }
          } catch { /* fall through to the marker */ }
        }
        if (!g.root.children.length) {
          const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(26),
            new THREE.MeshLambertMaterial({ color: 0xd8b45a, emissive: 0x3a2f12 }));
          g.root.add(mesh);
        }
        g.loading = false;
      }
      g.x = e.x; g.y = e.y; g.name = e.n;
      g.root.position.set(toX(e.x), this.heightAt(e.x, e.y), toZ(e.y));
    }
    for (const [id, g] of [...this.groundItems]) {
      if (seen.has(id)) continue;
      g.mixer?.stopAllAction();
      this.scene.remove(g.root);
      this.groundItems.delete(id);
    }
  }

  stepItems(dt) {
    this.itemBob = (this.itemBob || 0) + dt;
    for (const g of this.groundItems.values()) {
      g.mixer?.update(dt);
      g.root.position.y = this.heightAt(g.x, g.y) + 10 + Math.sin(this.itemBob * 2 + g.id) * 5;
      g.root.rotation.y += dt * 0.9;
    }
  }

  /** The item under a screen position, if the click is close enough to one. */
  pickItem(nx, ny) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    let best = null, bd = Infinity;
    for (const g of this.groundItems.values()) {
      const c = new THREE.Sphere(g.root.position.clone().setY(g.root.position.y + 20), 55);
      const p = new THREE.Vector3();
      if (ray.ray.intersectSphere(c, p)) {
        const d = ray.ray.origin.distanceTo(p);
        if (d < bd) { bd = d; best = g; }
      }
    }
    return best;
  }

  /** Ground point under a screen position. */
  pickGround(nx, ny) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    // cliff faces are their own mesh, and the ground has a hole under each one,
    // so a click on a cliff would otherwise fall through to the y=0 plane
    const targets = [];
    if (this.terrain) targets.push(this.terrain);
    if (this.cliffs) targets.push(this.cliffs);
    if (targets.length) {
      const hit = ray.intersectObjects(targets, true);
      if (hit.length) return { x: hit[0].point.x, y: -hit[0].point.z };
    }
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const p = new THREE.Vector3();
    if (ray.ray.intersectPlane(plane, p)) return { x: p.x, y: -p.z };
    return null;
  }

  pickEntity(nx, ny) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    let best = null, bd = Infinity;
    for (const v of this.views.values()) {
      if (!v.root.visible) continue;
      const c = new THREE.Sphere(v.root.position.clone().setY(v.root.position.y + 70), 90);
      const p = new THREE.Vector3();
      if (ray.ray.intersectSphere(c, p)) {
        const d = ray.ray.origin.distanceTo(p);
        if (d < bd) { bd = d; best = v; }
      }
    }
    return best;
  }

  addFloater(text, wx, wy, color) {
    this.floaters.push({ text, x: wx, y: wy, t: 0, color });
  }

  render() {
    const dt = this.clock.getDelta();
    for (const v of this.views.values()) {
      v.mixer?.update(dt);
      const ctx = this.animCtxOf(v);
      for (const p of (v.emitters || [])) p.update(dt, ctx);
      for (const r of (v.ribbons || [])) r.update(dt, ctx);
      stepLights(v.lights || [], ctx);
      // Sprays used to be gated on a guess -- 'is this unit dying?' -- because
      // nothing carried the emitter's own switch across. Now it does.
      for (const sp of (v.sprays || [])) sp.update(dt, ctx);
      if (v.events?.length) stepEvents(v.events, ctx, (e) => this.fireEvent(e));
      if (v.alphaCurve) this.tickGeosetCurves(v);
    }
    for (const e of this.effects.values()) {
      e.mixer?.update(dt);
      const ctx = this.animCtxOf(e);
      for (const p of (e.emitters || [])) p.update(dt, ctx);
      for (const r of (e.ribbons || [])) r.update(dt, ctx);
      stepLights(e.lights || [], ctx);
      for (const sp of (e.sprays || [])) sp.update(dt, ctx);
      if (e.alphaCurve) this.tickGeosetCurves(e);
    }
    this.splatField?.update(dt);
    this.stepMissiles(dt);
    this.stepItems(dt);
    this.tickWater(dt);
    this.updateCamera(dt);
    this.renderer.render(this.scene, this.camera);
    return dt;
  }
}
