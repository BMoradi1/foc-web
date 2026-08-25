// Grid pathing over the map's own war3map.wpm walkability data.
import { PATH_CELL } from '../shared/const.js';

export class Grid {
  constructor(walk, w, h, originX, originY) {
    this.walk = walk; this.w = w; this.h = h;
    this.originX = originX; this.originY = originY;
  }
  toCell(x, y) {
    return [Math.floor((x - this.originX) / PATH_CELL),
            Math.floor((y - this.originY) / PATH_CELL)];
  }
  toWorld(cx, cy) {
    return [this.originX + (cx + 0.5) * PATH_CELL,
            this.originY + (cy + 0.5) * PATH_CELL];
  }
  inside(cx, cy) { return cx >= 0 && cy >= 0 && cx < this.w && cy < this.h; }
  walkable(cx, cy) { return this.inside(cx, cy) && this.walk[cy * this.w + cx] === 1; }
  walkableAt(x, y) { const [cx, cy] = this.toCell(x, y); return this.walkable(cx, cy); }

  /** Nearest walkable cell to a world point (bounded spiral search). */
  nearestWalkable(x, y, maxR = 24) {
    let [cx, cy] = this.toCell(x, y);
    if (this.walkable(cx, cy)) return [cx, cy];
    for (let r = 1; r <= maxR; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (this.walkable(cx + dx, cy + dy)) return [cx + dx, cy + dy];
      }
    }
    return null;
  }

  /** A* returning a list of world-space waypoints, or null. */
  path(sx, sy, tx, ty, limit = 20000) {
    const s = this.nearestWalkable(sx, sy), t = this.nearestWalkable(tx, ty);
    if (!s || !t) return null;
    const [s0, s1] = s, [t0, t1] = t;
    if (s0 === t0 && s1 === t1) return [this.toWorld(t0, t1)];
    const W = this.w, N = W * this.h;
    const start = s1 * W + s0, goal = t1 * W + t0;
    const g = new Float32Array(N).fill(Infinity);
    const f = new Float32Array(N).fill(Infinity);
    const from = new Int32Array(N).fill(-1);
    const open = [start];
    const inOpen = new Uint8Array(N);
    const closed = new Uint8Array(N);
    const hx = (i) => { const x = i % W, y = (i - x) / W;
      const dx = Math.abs(x - t0), dy = Math.abs(y - t1);
      return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy); };
    g[start] = 0; f[start] = hx(start); inOpen[start] = 1;
    let expanded = 0;
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (f[open[i]] < f[open[bi]]) bi = i;
      const cur = open.splice(bi, 1)[0];
      inOpen[cur] = 0;
      if (cur === goal) return this._trace(from, cur);
      closed[cur] = 1;
      if (++expanded > limit) break;
      const cx = cur % W, cy = (cur - cx) / W;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy;
        if (!this.walkable(nx, ny)) continue;
        if (dx && dy && (!this.walkable(cx + dx, cy) || !this.walkable(cx, cy + dy))) continue;
        const ni = ny * W + nx;
        if (closed[ni]) continue;
        const ng = g[cur] + (dx && dy ? Math.SQRT2 : 1);
        if (ng < g[ni]) {
          g[ni] = ng; from[ni] = cur; f[ni] = ng + hx(ni);
          if (!inOpen[ni]) { open.push(ni); inOpen[ni] = 1; }
        }
      }
    }
    return null;
  }
  _trace(from, cur) {
    const cells = [];
    while (cur !== -1) { cells.push(cur); cur = from[cur]; }
    cells.reverse();
    // string-pull: drop waypoints that are collinear / directly reachable
    const W = this.w;
    const pts = cells.map((i) => { const x = i % W; return this.toWorld(x, (i - x) / W); });
    const out = [pts[0]];
    let anchor = 0;
    for (let i = 2; i < pts.length; i++) {
      if (!this.clearLine(pts[anchor][0], pts[anchor][1], pts[i][0], pts[i][1])) {
        out.push(pts[i - 1]); anchor = i - 1;
      }
    }
    out.push(pts[pts.length - 1]);
    return out.slice(1);
  }
  clearLine(x0, y0, x1, y1) {
    const d = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.ceil(d / (PATH_CELL * 0.5));
    for (let i = 0; i <= steps; i++) {
      const t = steps ? i / steps : 0;
      if (!this.walkableAt(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
    }
    return true;
  }
}
