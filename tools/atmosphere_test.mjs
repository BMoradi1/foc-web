// The stub natives that a player would have noticed: music, fog, and three
// that are not cosmetic at all.
//
// A native the engine has never heard of is reported -- boot_test prints that
// list and it is empty.  A native that EXISTS with an empty body is not: it
// takes the call, returns, and nothing says a word.  tools/stub_audit.mjs ranks
// them; this asserts the ones taken off that list.
//
//   node tools/atmosphere_test.mjs        (no server needed)
import fs from 'node:fs';
import path from 'node:path';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0; const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fails.push(name); console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
};

const world = new World();
const eng = new JassEngine(world);
// The natives push onto the engine's own client-event queue, which the room
// drains once a tick; config() and main() run inside boot(), so the events are
// already there before the first tick.
const seen = [];
const realEmit = eng.emit.bind(eng);
eng.emit = (e) => { seen.push(e); return realEmit(e); };
eng.load(); eng.boot();
const STEP = 1000 / 30;
for (let i = 0; i < 60; i++) { eng.update(STEP); world.step(); }

// ------------------------------------------------------------------- music
console.log('\n-- SetMapMusic("Music") plays the standard playlist');
{
  const GP = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/gameplay.json'), 'utf8'));
  check('the playlist is compiled out of UI\\WorldEditData.txt', (GP.music || []).length > 20,
        `${(GP.music || []).length} tracks`);
  const ev = seen.filter((e) => e.t === 'music');
  check('booting the map asks for music at all', ev.length > 0, `${ev.length} events`);
  const play = ev.find((e) => e.list && e.list.length);
  check('the label "Music" resolves to a list, not to one file',
        play && play.list.length > 1, play ? `${play.list.length}` : 'none');
  check('and the map asked for it at random, which is what it wrote',
        play && play.random === true, play ? String(play.random) : '-');
  // every track has to be a file the archives actually supplied
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/sounds.json'), 'utf8'));
  const served = new Set(Object.values(idx));
  const bad = (play ? play.list : []).filter((f) => !served.has(f));
  check('every track named is one the conversion produced', bad.length === 0, bad.slice(0, 3).join(','));
  // and the files are on disk, non-empty
  let missing = 0, empty = 0;
  for (const f of (play ? play.list : []).slice(0, 8)) {
    const p = path.join(ROOT, 'public/assets', f);
    const q = path.join(ROOT, 'assets', f);
    const hit = fs.existsSync(p) ? p : fs.existsSync(q) ? q : null;
    if (!hit) { missing++; continue; }
    if (fs.statSync(hit).size < 1024) empty++;
  }
  check('the tracks are on disk and are not empty', missing === 0 && empty === 0,
        `${missing} missing, ${empty} empty`);
}

// --------------------------------------------------------------------- fog
console.log('\n-- SetTerrainFogEx gives the renderer the map\'s own fog');
{
  const fog = seen.filter((e) => e.t === 'fog');
  check('the map sets its fog during init', fog.length > 0, `${fog.length} events`);
  const f = fog[0];
  // the script asks for SetTerrainFogEx(0, 3000., 5000., .5, .0, .0, .0)
  check('it is the map\'s own 3000 to 5000, not the renderer\'s 4200 to 9000',
        f && f.start === 3000 && f.end === 5000, f ? `${f.start}..${f.end}` : '-');
  check('and its own black, not the renderer\'s 0x0b1018',
        f && f.color && f.color.every((c) => c === 0), f ? JSON.stringify(f.color) : '-');
}

// ------------------------------------------- three that are not cosmetic
console.log('\n-- and three the audit called "not cosmetic, worth a look"');
{
  const P = (n) => world.jass.players[n];
  const hero = [...world.units.values()].find((u) => u.isHero);
  const type = hero ? hero.typeKey : null;
  const u = type ? world.createUnit(P(0), type, 100, 100, 0) : null;
  if (!u) check('a hero could be built', false);
  else {
    world.setHeroLevel(u, 5);
    const before = u.level, sp = u.skillPoints;
    const ok = world.stripHeroLevel(u, 2);
    check('UnitStripHeroLevel takes the levels back off', ok && u.level === before - 2,
          `${before} -> ${u.level}`);
    check('and the skill points with them', u.skillPoints === Math.max(0, sp - 2),
          `${sp} -> ${u.skillPoints}`);
    check('it never drops below level 1', (world.stripHeroLevel(u, 99), u.level === 1),
          String(u.level));
    // SetUnitPathing(u, false) takes a unit out of collision
    u.pathingOff = true;
    const other = world.createUnit(P(0), type, 100, 100, 0);
    if (other) {
      u.x = 0; u.y = 0; other.x = 1; other.y = 0;
      world.separate([u, other]);
      check('SetUnitPathing(false) leaves a unit where it stands',
            u.x === 0 && u.y === 0, `${u.x},${u.y}`);
      other.alive = false;
    }
    u.pathingOff = false;
    u.alive = false;
  }
  // SetPlayerHandicapXP scales what a hero gains
  const h2 = type ? world.createUnit(P(0), type, 300, 300, 0) : null;
  if (h2) {
    h2.xp = 0; h2.level = 1;
    world.addXp(h2, 100);
    const full = h2.xp;
    world.setHandicapXP(world.jass.players[0], 0.5);
    h2.xp = 0;
    world.addXp(h2, 100);
    check('SetPlayerHandicapXP halves what the hero gains', Math.abs(h2.xp - full * 0.5) < 1e-6,
          `${full} -> ${h2.xp}`);
    world.setHandicapXP(world.jass.players[0], 1);
    h2.alive = false;
  }
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
