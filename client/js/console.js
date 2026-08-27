// Warcraft III's console, drawn from the game's own layout.
//
// public/data/console.json is ConsoleUI.fdf joined to UI\war3skins.txt by
// tools/uiframe.py, with the coordinates already divided out of Warcraft III's
// 0.8 x 0.6 screen box, so everything here is a plain fraction of the viewport.
//
// Two details carry the whole thing.
//
// Each piece is pinned by a *corner* rather than laid out in a row. That is how
// one layout fits any aspect ratio: the left pieces hug the left edge, the right
// pieces hug the right, and a wider screen opens a gap in the middle instead of
// stretching the art. Warcraft III's y axis points up, so a downward offset
// arrives negative and has to be flipped for CSS.
//
// Each piece shows a sub-rectangle of its texture, not the whole file. Four
// 512-pixel tiles cover the entire console because the top strip and the bottom
// strip are different bands of the same image. Given a UV window of width `uw`
// starting at `l`, the background must be 1/uw the size of the element and
// offset by l/(1-uw) as a percentage -- the standard CSS identity, which is
// exact rather than approximate.
const CORNER = {
  TOPLEFT: (s, p) => { s.left = pct(p.dx); s.top = pct(-p.dy); },
  TOPRIGHT: (s, p) => { s.right = pct(-p.dx); s.top = pct(-p.dy); },
  BOTTOMLEFT: (s, p) => { s.left = pct(p.dx); s.bottom = pct(p.dy); },
  BOTTOMRIGHT: (s, p) => { s.right = pct(-p.dx); s.bottom = pct(p.dy); },
};
const pct = (v) => `${(v * 100).toFixed(4)}%`;

/** Where a UV window has to sit as a CSS background-position percentage. */
function bgPos(start, span) {
  return span >= 1 ? '0%' : `${(start / (1 - span)) * 100}%`;
}

/**
 * Where a piece's opening sits, as CSS against the same corner the piece uses.
 *
 * A slot is given as fractions of its piece measured from the piece's top-left,
 * so a bottom-anchored piece has to have its vertical flipped back.
 */
function slotStyle(p, s) {
  const st = { width: pct(s.w * p.w), height: pct(s.h * p.h) };
  const top = p.a.startsWith('TOP');
  if (p.a.endsWith('LEFT')) st.left = pct(p.dx + s.x * p.w);
  else st.right = pct(-p.dx + (1 - s.x - s.w) * p.w);
  if (top) st.top = pct(-p.dy + s.y * p.h);
  else st.bottom = pct(p.dy + (1 - s.y - s.h) * p.h);
  return st;
}

/** Put an existing panel into a slot, keeping it where the console expects it. */
export function placeIn(el, style) {
  if (!el || !style) return;
  el.style.position = 'absolute';
  for (const k of ['left', 'right', 'top', 'bottom']) el.style[k] = 'auto';
  Object.assign(el.style, style);
}

/**
 * The portrait arch, which the console's own seam cuts in half.
 *
 * Warcraft III's left tile ends partway through the arch and the middle tile
 * carries the rest, so measuring openings tile by tile finds two slivers and
 * never the arch. Whichever opening runs off the left tile's right edge and
 * whichever runs off the middle tile's left edge are the same hole, and joining
 * them across the seam gives it back.
 */
function seamArch(left, mid) {
  if (!left || !mid) return null;
  const a = (left.slots || []).find((s) => s.x + s.w > 0.98 && s.h > 0.2);
  const b = (mid.slots || []).find((s) => s.x < 0.02 && s.h > 0.2);
  if (!a || !b) return null;
  const x0 = left.dx + a.x * left.w;
  const x1 = mid.dx + (b.x + b.w) * mid.w;
  // the taller half decides the vertical, since the shorter one is the clipped
  const src = a.h * left.h >= b.h * mid.h ? [a, left] : [b, mid];
  const [sl, pc] = src;
  return {
    left: pct(x0),
    width: pct(x1 - x0),
    bottom: pct(pc.dy + (1 - sl.y - sl.h) * pc.h),
    height: pct(sl.h * pc.h),
  };
}

export function buildConsole(spec, host) {
  host.innerHTML = '';
  const bottom = (t) => (spec.console || []).find(
    (p) => p.a.startsWith('BOTTOM') && p.t.includes(t));
  for (const p of spec.console || []) {
    const place = CORNER[p.a];
    if (!place) continue;
    const d = document.createElement('div');
    d.className = 'cpiece';
    const [l, r, t, b] = p.uv;
    const uw = Math.max(1e-6, r - l), uh = Math.max(1e-6, b - t);
    const s = d.style;
    s.backgroundImage = `url(/assets/${p.t})`;
    s.backgroundSize = `${(100 / uw).toFixed(3)}% ${(100 / uh).toFixed(3)}%`;
    s.backgroundPosition = `${bgPos(l, uw)} ${bgPos(t, uh)}`;
    s.width = pct(p.w);
    s.height = pct(p.h);
    place(s, p);

    // Two layers of black behind the art, because one is never right.
    //
    // A rectangle over the whole piece fills the gaps between the battlements
    // along the top, which reads as a black bar hanging over the world. A
    // silhouette of the art alone leaves the world showing through every hole
    // and seam below it -- the minimap's window, the arches, the command card.
    //
    // So the silhouette carries the skyline, exactly, including the notches;
    // and a solid rectangle starting at the first row that is opaque nearly all
    // the way across carries everything under it. tools/uiframe.py measures
    // that row off the art, and it lands between 12% and 21% down each tile.
    if (p.solid != null && p.a.startsWith('BOTTOM')) {
      const fill = document.createElement('div');
      fill.className = 'cbed';
      Object.assign(fill.style, { width: s.width, left: s.left, right: s.right });
      fill.style.position = 'absolute';
      fill.style.bottom = pct(p.dy);
      fill.style.height = pct((1 - p.solid) * p.h);
      host.appendChild(fill);
    }
    const shade = d.cloneNode(false);
    shade.className = 'cpiece cshade';
    host.appendChild(shade);

    host.appendChild(d);
  }
  // The openings the game leaves in its own art: the minimap on the left, the
  // info panel under the arch, the inventory and the command card on the right.
  const map = bottom('Tile01'), info = bottom('Tile02'), card = bottom('Tile03');
  const out = {
    minimap: map && map.slot ? slotStyle(map, map.slot) : null,
    info: info && info.slot ? slotStyle(info, info.slot) : null,
    // the unit portrait's arch, which belongs to neither tile on its own
    portrait: seamArch(map, info),
    // row-major, which is the order Warcraft III fills a command card in
    cells: card ? (card.cells || []).map((c) => slotStyle(card, c)) : [],
    inv: card ? (card.inv || []).map((c) => slotStyle(card, c)) : [],
  };
  return out;
}
