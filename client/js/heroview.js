// The hero turning on the spot in the character-select detail pane.
//
// The grid's 26 cards are baked PNGs (tools/hero_portraits.mjs): a portrait does
// not move, and 26 animated models in one menu is a great deal of WebGL for no
// gain. The detail pane is the one place a player is looking at a single hero,
// so that is the one place worth spending a live model on.
//
// It drives a second Renderer rather than a hand-rolled scene, because a hero is
// not just a glTF file: team colour is substituted into the skin, unshaded
// layers are unlit, filter modes decide blending, and the stand animation is
// chosen from the map's own token sets. All of that lives in Renderer and none
// of it is worth reimplementing differently here -- a preview that lights a
// model differently from the game is worse than no preview.
import * as THREE from 'three';
import { Renderer } from './render.js';

// how much of the frame the model should fill, and how fast it turns
const FILL = 0.84;
const TURN = 0.5;                    // radians a second

export class HeroPreview {
  constructor(canvas, size = 280) {
    this.canvas = canvas;
    this.size = size;
    this.r = new Renderer(canvas);
    // Renderer sizes itself to the window and re-does it on every resize event,
    // which for a panel-sized canvas means a preview the size of the screen.
    // Replacing the instance's own method also disarms that listener, since it
    // is what the listener calls.
    this.r.resize = () => {
      this.r.renderer.setSize(this.size, this.size, false);
      this.r.camera.aspect = 1;
      this.r.camera.updateProjectionMatrix();
    };
    this.r.resize();
    this.r.scene.background = new THREE.Color(0x0b0e15);
    // the same key and fill the baked portraits use, so the two agree
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(-2, 3, 4);
    this.r.scene.add(key);
    this.r.scene.add(new THREE.AmbientLight(0xffffff, 0.9));

    this.view = null;
    this.id = null;
    this.spin = 0;
    this.token = 0;                  // guards against a slow load landing late
  }

  /** Show one hero. Safe to call repeatedly, including while another is loading. */
  async show(hero, meta) {
    if (!hero || hero.id === this.id) return;
    this.id = hero.id;
    const mine = ++this.token;
    for (const [k] of [...this.r.views]) this.r.removeView(k);
    this.view = null;

    const m = meta || {};
    const model = m.m || hero.model;
    if (!model) return;
    const ent = { i: 1, k: 1, t: 0, p: 0, c: 0, x: 0, y: 0, f: 2.2,
                  model, scale: m.s ?? hero.scale ?? 1, isHero: true, radius: 32,
                  name: model, sh: null, us: m.us, an: m.an, isBuilding: !!m.b };
    await this.r.spawnView(ent);
    if (mine !== this.token) return;              // a newer pick overtook this one
    const v = this.r.views.get(ent.i);
    if (!v) return;
    this.view = v;
    this.r.play(v, 'stand');
    for (let i = 0; i < 30; i++) v.mixer?.update(1 / 30);   // settle into the pose
    this.fit();
  }

  /**
   * Frame the model by looking at it, not by asking it how big it is.
   *
   * The MDX extent is the obvious source and cannot be trusted: Ichigo's claims
   * 835 units against a body of 184, Byakuya's a radius of 234 around geometry
   * collapsed to a speck. Rendering small, measuring what is actually covered
   * and moving the camera settles in three passes and cannot be lied to. It runs
   * once per hero, not per frame.
   */
  fit() {
    const r = this.r;
    r.camPitch = 0.10; r.camYaw = 0;
    r.camTarget.set(0, 90, 0);
    r.camDist = 400;
    const N = 64;
    const rt = new THREE.WebGLRenderTarget(N, N);
    const buf = new Uint8Array(N * N * 4);
    // What the background actually comes out as, taken with the model hidden.
    // Sampling a corner instead is a trap: Ichigo's ground glow reaches the edge
    // of the frame, so the corner is glow and every pixel then counts as model.
    this.view.root.visible = false;
    r.updateCamera();
    r.renderer.setRenderTarget(rt);
    r.renderer.render(r.scene, r.camera);
    r.renderer.readRenderTargetPixels(rt, 0, 0, N, N, buf);
    r.renderer.setRenderTarget(null);
    const bg0 = buf[0], bg1 = buf[1], bg2 = buf[2];
    this.view.root.visible = true;
    for (let pass = 0; pass < 3; pass++) {
      r.updateCamera();
      r.renderer.setRenderTarget(rt);
      r.renderer.render(r.scene, r.camera);
      r.renderer.readRenderTargetPixels(rt, 0, 0, N, N, buf);
      r.renderer.setRenderTarget(null);
      let y0 = N, y1 = -1, x0 = N, x1 = -1;
      for (let i = 0; i < buf.length; i += 4) {
        if (Math.abs(buf[i] - bg0) + Math.abs(buf[i + 1] - bg1)
          + Math.abs(buf[i + 2] - bg2) <= 18) continue;
        const px = (i / 4) % N, py = Math.floor((i / 4) / N);
        if (px < x0) x0 = px; if (px > x1) x1 = px;
        if (py < y0) y0 = py; if (py > y1) y1 = py;
      }
      if (x1 < 0) break;
      const fov = r.camera.fov * Math.PI / 180;
      const visible = 2 * r.camDist * Math.tan(fov / 2);
      r.camTarget.y += (((y0 + y1) / 2) / N - 0.5) * visible;
      r.camDist = Math.max(40, r.camDist
        * (Math.max((y1 - y0 + 1) / N, (x1 - x0 + 1) / N) / FILL));
    }
    rt.dispose();
    r.updateCamera();
  }

  step(dt) {
    const v = this.view;
    if (!v) return;
    this.spin += dt * TURN;
    v.root.rotation.y = this.spin;
    v.mixer?.update(dt);
    this.r.renderer.render(this.r.scene, this.r.camera);
  }

  /** Drop the model but keep the context, since the pane is shown again. */
  clear() {
    for (const [k] of [...this.r.views]) this.r.removeView(k);
    this.view = null; this.id = null; this.token++;
  }
}
