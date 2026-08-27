// The flat layer between the world and the interface: health bars over units.
//
// Warcraft III draws these in world space but as plain rectangles, not
// geometry, and a canvas is the honest way to do the same. The alternative -- a
// DOM node per unit -- means projecting and restyling a hundred elements every
// frame for something that is four fillRects.
//
// What is shown follows the game rather than a MOBA: a bar over the unit you
// are hovering, over your own hero, and over everything while ALT is held.
// Warcraft III shows exactly those three.
const BAR_W = 42;                  // pixels at the reference camera distance
const BAR_H = 5;
const GAP = 1;                     // between the health bar and the mana bar

// Green while healthy, amber as it falls, red when it is nearly gone. The
// thresholds are Warcraft III's familiar ones; the game draws these itself
// rather than shipping art for them, so there is no file to read them from.
function healthColor(frac) {
  if (frac > 0.6) return '#39c839';
  if (frac > 0.3) return '#e0c020';
  return '#d03030';
}

export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * @param view   the Renderer, for its camera and views
   * @param ents   the entity map, for hp/mana
   * @param show   which ids to draw a bar for
   */
  draw(view, ents, show) {
    const ctx = this.ctx;
    this.clear();
    if (!show || !show.size) return;
    const w = innerWidth, h = innerHeight;
    // bars shrink with distance the way the unit does, within reason
    const scale = Math.max(0.55, Math.min(1.35, 1400 / (view.camDist || 1400)));
    const bw = BAR_W * scale, bh = Math.max(3, BAR_H * scale);
    for (const id of show) {
      const e = ents.get(id);
      const v = view.views.get(id);
      if (!e || !v || !v.root.visible) continue;
      const maxHp = e.H || 0;
      if (!maxHp) continue;
      // above the head, measured from the model rather than assumed
      const top = view.barAnchor(v);
      const p = top.project(view.camera);
      if (p.z > 1) continue;                       // behind the camera
      const sx = Math.round((p.x * 0.5 + 0.5) * w - bw / 2);
      const sy = Math.round((-p.y * 0.5 + 0.5) * h);
      if (sx < -bw || sx > w || sy < -20 || sy > h) continue;

      const hp = Math.max(0, Math.min(1, (e.h ?? maxHp) / maxHp));
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(sx - 1, sy - 1, bw + 2, bh + 2);
      ctx.fillStyle = '#101418';
      ctx.fillRect(sx, sy, bw, bh);
      ctx.fillStyle = healthColor(hp);
      ctx.fillRect(sx, sy, Math.round(bw * hp), bh);

      const maxMana = e.M || 0;
      if (maxMana > 0) {
        const mp = Math.max(0, Math.min(1, (e.m ?? 0) / maxMana));
        const my = sy + bh + GAP;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(sx - 1, my - 1, bw + 2, bh + 2);
        ctx.fillStyle = '#101418';
        ctx.fillRect(sx, my, bw, bh);
        ctx.fillStyle = '#3f7fd0';
        ctx.fillRect(sx, my, Math.round(bw * mp), bh);
      }
    }
  }
}
