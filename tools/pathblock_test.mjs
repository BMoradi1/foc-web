// Do the map's walls and gates actually stop anything?
//
// war3map.wpm is the *terrain's* pathing, and the World Editor bakes ordinary
// doodads into it -- the city low walls read 202, no-walk, straight from the
// file. Destructables are not baked in, because Warcraft III stamps their
// footprint at runtime and lifts it again when they die. So the 58 stone walls,
// all six gates and the trees read 64 or 72 -- walkable -- and were walked
// straight through.
//
// The footprint is a TGA named per type in pathTex, one pixel per 32-unit
// pathing cell, flags in the colour channels: red unwalkable, green unflyable,
// blue unbuildable. StoneWall1Path is a 10x2 bar, Gate2Path a 22x22 diagonal.
//
// Two things are asserted, and the second matters as much as the first: the
// walls block, and the map is still connected. Stamping too much would seal a
// base or a lane and there would be no game.
//
//   node tools/pathblock_test.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const terr = read('data/terrain.json');
const pathing = read('data/pathing.json');
const doodads = read('public/data/doodads.json');
const game = read('data/game.json');
const W = pathing.width, H = pathing.height;
const walk = new Uint8Array(fs.readFileSync(path.join(ROOT, 'public/data/walk.bin')));
const raw = pathing.cells;                    // the terrain's own pathing, unstamped
const OX = terr.offsetX, OY = terr.offsetY, PC = 32;

const cellOf = (x, y) => [Math.floor((x - OX) / PC), Math.floor((y - OY) / PC)];
const walkable = (x, y) => {
  const [cx, cy] = cellOf(x, y);
  return cx >= 0 && cy >= 0 && cx < W && cy < H ? walk[cy * W + cx] === 1 : null;
};
const rawWalkable = (x, y) => {
  const [cx, cy] = cellOf(x, y);
  return cx >= 0 && cy >= 0 && cx < W && cy < H ? (raw[cy * W + cx] & 0x02) === 0 : null;
};

check('walk.bin matches the pathing grid', walk.length === W * H, `${walk.length} vs ${W * H}`);

// ---- the walls and every gate must block
const GATES = ['YTcx', 'LTe4', 'DTg6', 'LTg2', 'ATg4'];
const WALLS = ['LTw0', 'LTw1', 'LTw2', 'LTw3'];
const centresOf = (ids) => doodads.filter((d) => ids.includes(d.id));

const gates = centresOf(GATES);
check('all six gates are placed', gates.length === 6, `${gates.length}`);
check('every gate blocks', gates.every((d) => walkable(d.x, d.y) === false),
      gates.map((d) => `${d.id}:${walkable(d.x, d.y) === false ? 'blocked' : 'OPEN'}`).join(' '));

const walls = centresOf(WALLS);
check('the stone walls are placed', walls.length > 40, `${walls.length}`);
check('every stone wall blocks', walls.every((d) => walkable(d.x, d.y) === false),
      `${walls.filter((d) => walkable(d.x, d.y) === false).length}/${walls.length}`);

// the terrain alone did NOT block them -- this is what the stamping added
const wasOpen = [...gates, ...walls].filter((d) => rawWalkable(d.x, d.y) === true);
check('the map file alone left them walkable', wasOpen.length > 0,
      `${wasOpen.length} of ${gates.length + walls.length} were open in war3map.wpm`);

// ---- and the map is still one connected space
const start = game.spawns.find((s) => typeof s.x === 'number');
const [sx0, sy0] = cellOf(start.x, start.y);
function flood(grid) {
  const seen = new Uint8Array(W * H);
  let sx = sx0, sy = sy0;
  if (!grid(sx, sy)) {
    outer: for (let r = 1; r < 24; r++)
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (grid(sx + dx, sy + dy)) { sx += dx; sy += dy; break outer; }
      }
  }
  const q = [[sx, sy]]; seen[sy * W + sx] = 1;
  let n = 1;
  while (q.length) {
    const [cx, cy] = q.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (seen[ny * W + nx] || !grid(nx, ny)) continue;
      seen[ny * W + nx] = 1; n++; q.push([nx, ny]);
    }
  }
  return { seen, n };
}
const idx = (cx, cy) => (cx >= 0 && cy >= 0 && cx < W && cy < H);
const after = flood((cx, cy) => idx(cx, cy) && walk[cy * W + cx] === 1);
const before = flood((cx, cy) => idx(cx, cy) && (raw[cy * W + cx] & 0x02) === 0);

check('the map is still one connected space', after.n > before.n * 0.9,
      `${after.n} reachable of ${before.n} before (${(100 * after.n / before.n).toFixed(1)}%)`);

// Nothing may be *orphaned*: the reachable area can only shrink by the cells the
// stamping actually blocked. If it shrinks by more, a footprint has sealed a
// region off -- a base, a lane, a shop -- and that is how this breaks a game
// rather than fixing one. (game.spawns is the map's neutral units, taverns and
// hero-picker props included, and several of those were never walkable, so
// asking whether each is reachable measures the wrong thing.)
let blocked = 0;
for (let i = 0; i < W * H; i++) if ((raw[i] & 0x02) === 0 && walk[i] !== 1) blocked++;
const lost = before.n - after.n;
check('nothing was sealed off beyond the footprints themselves', lost <= blocked,
      `lost ${lost} reachable cells against ${blocked} blocked`);

const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} checks passed`);
process.exit(bad ? 1 : 0);
