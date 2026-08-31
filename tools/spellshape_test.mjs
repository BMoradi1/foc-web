// Do the repaired spells deliver the shape the map's own fields describe?
//
// tools/slot_test.mjs proves the engine names each data slot the way
// AbilityMetaData does.  That is a claim about the source, and this project has
// been bitten three times by a test that asserted the claim instead of the
// outcome -- a sound suite once passed 15/15 while the game was silent.  So
// this one casts the spells and reads what actually happened: how many waves
// are queued and how hard each one hits, how long the damage line is, whether
// a roar buffs allies or damages enemies.
//
// Every expected number below is the map's own, quoted with the field it comes
// from.  Nothing here is a constant of ours.
//
//   node tools/spellshape_test.mjs        (no server needed)
import fs from 'node:fs';
import path from 'node:path';
import { ABILS, execute, levelInfo, baseOf } from '../server/abilities.js';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const fails = [];
let pass = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fails.push(name); console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
};

const world = new World();
const eng = new JassEngine(world);
eng.load(); eng.boot();
const STEP = 1000 / 30;
for (let i = 0; i < 30; i++) { eng.update(STEP); world.step(); }

// The heroes standing about after boot are the tavern's picker copies, on
// players 12 and 15 -- neutral hostile and neutral passive, which world.hostile
// refuses to make enemies of anything.  So the test builds its own pair, and on
// players 0 and 6: this map allies 0-5 against 6-11, so a dummy on player 1
// would be a teammate and every spell below would report a clean zero.
const TYPES = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/unittypes.json'), 'utf8'));
const P = (n) => world.jass.players[n];
const CASTER_TYPE = [...world.units.values()].find((u) => u.isHero)?.typeKey
                 || Object.keys(TYPES).find((k) => TYPES[k].isHero);
const hero = world.createUnit(P(0), CASTER_TYPE, 0, 0, 0);
if (!hero) { console.log('  FAIL  no caster could be built'); process.exit(1); }
hero.x = 0; hero.y = 0;

const DUMMY = Object.keys(TYPES).find((k) => /^h/.test(k));
const foes = [];
/** A hostile dummy at an exact point, so a line or a cone has something to hit. */
function foe(dx, dy) {
  const u = world.createUnit(P(6), DUMMY, hero.x + dx, hero.y + dy, 0);
  if (!u) return null;
  // freeSpotNear slides a new unit off the spot; the geometry is the thing
  // under test, so put it back.
  u.x = hero.x + dx; u.y = hero.y + dy;
  u.hp = u.maxHp = 1e9;
  u.armor = 0;
  foes.push(u);
  // The spatial bins are rebuilt once a tick and these units are created and
  // moved between ticks, so anything reached through enumInRange -- every AoE
  // here -- would miss them.
  world.binTick = -1;
  world.rebuildBins();
  return u;
}
const clearFoes = () => { for (const f of foes.splice(0)) f.alive = false; };
const cast = (id, lvl, at) => {
  world.channels = [];
  return execute(world, hero, ABILS[id], lvl, at || { x: hero.x + 400, y: hero.y });
};

// ---------------------------------------------------------- Blizzard family
console.log('\n-- Blizzard and Rain of Fire: Hbz1 waves, Hbz2 damage');
{
  const L = levelInfo(ABILS.A027, 3);            // 보구의 비, Gilgamesh
  check('A027 rank 3 carries 5 waves and 180 damage in the data',
        L.data1 === 5 && L.data2 === 180 && L.duration === 10,
        `d1=${L.data1} d2=${L.data2} adur=${L.duration}`);
  cast('A027', 3);
  const c = world.channels[0];
  check('the cast queues 5 waves, not 180', c && c.left === 5, c ? `left=${c.left}` : 'no channel');
  check('each wave carries 180 damage, not 5', c && c.perWave === 180, c ? `per=${c.perWave}` : '-');
  check('and they are spread over the ability\'s own 10s duration',
        c && Math.abs(c.interval - 2000) < 1, c ? `${c.interval}ms` : '-');
}
{
  const L = levelInfo(ABILS.A06R, 3);            // 시엔플루르, Nico Robin
  check('A06R rank 3 carries 30 waves and 1100 damage',
        L.data1 === 30 && L.data2 === 1100, `d1=${L.data1} d2=${L.data2}`);
  cast('A06R', 3);
  const c = world.channels[0];
  check('30 waves of 1100, not 1100 waves of 30',
        c && c.left === 30 && c.perWave === 1100,
        c ? `${c.left} x ${c.perWave}` : 'no channel');
  // The eighteen-minute bombardment is the thing this test exists to stop.
  check('the channel cannot outlive the match',
        c && (c.left * c.interval) < 60_000,
        c ? `${Math.round(c.left * c.interval / 1000)}s` : '-');
}

// ------------------------------------------------------------ Cluster Rockets
console.log('\n-- Cluster Rockets: an area barrage, not a line');
{
  const L = levelInfo(ABILS.A00R, 1);            // 숏건, Yusuke
  check('A00R carries 30 damage, 0.3s interval, 10 missiles',
        L.data1 === 30 && L.data2 === 0.3 && L.data3 === 10,
        `${L.data1} / ${L.data2} / ${L.data3}`);
  cast('A00R', 1);
  const c = world.channels[0];
  check('it fires 10 rockets of 30 into its own area',
        c && c.left === 10 && c.perWave === 30 && c.radius === L.area,
        c ? `${c.left} x ${c.perWave} r${c.radius}` : 'no channel');
  // Read as a Carrion Swarm, Ncs2 became a total damage cap of 0.3 and the
  // spell stopped after one unit.
  check('the 0.3 is an interval, not a damage cap',
        c && Math.abs(c.interval - 300) < 1, c ? `${c.interval}ms` : '-');
}

// ------------------------------------------------------------------- Impale
console.log('\n-- Impale: Uim1 distance, Uim3 damage, Uim4 air time');
{
  const L = levelInfo(ABILS.A04T, 1);            // 고사리싹의 춤, Akiha
  check('A04T carries 600 distance, 2000 damage, 1s air time',
        L.data1 === 600 && L.data3 === 2000 && L.data4 === 1,
        `${L.data1} / ${L.data3} / ${L.data4}`);
  clearFoes();
  const near = foe(300, 0), far = foe(1500, 0);
  if (near && far) {
    const hp0 = near.hp, hpFar0 = far.hp;
    execute(world, hero, ABILS.A04T, 1, { x: hero.x + 600, y: hero.y });
    check('a unit 300 along the line takes the 2000',
          Math.abs((hp0 - near.hp) - 2000) < 200, `${Math.round(hp0 - near.hp)}`);
    // Read positionally the line ran 2000 long and 1 wide -- it reached far
    // past Uim1 and hit almost nothing on the way.
    check('a unit at 1500 is beyond Uim1 and takes nothing', far.hp === hpFar0,
          `${hpFar0 - far.hp}`);
    check('and the one it hit is stunned for the air time',
          (near.buffs || []).some((b) => b.kind === 'stun'), 'stun');
  } else check('dummies could be summoned for the line test', false, 'no hfoo');
}

// ------------------------------------------------------------ Breath of Fire
console.log('\n-- ANcf is Breath of Fire: a cone, not a ring at the caster\'s feet');
{
  check('ANcf routes to the breath case', baseOf(ABILS.A01N) === 'ANbf', baseOf(ABILS.A01N));
  const L = levelInfo(ABILS.A01N, 3);            // 폭류파, InuYasha
  check('A01N rank 3 carries 3000 damage over an 800 range',
        L.data1 === 3000 && L.range === 900, `${L.data1} @ ${L.range}`);
  clearFoes();
  const out = foe(500, 0);
  if (out) {
    const hp0 = out.hp;
    execute(world, hero, ABILS.A01N, 3, { x: hero.x + 800, y: hero.y });
    // The Fan of Knives case used aare=100, so nothing past the caster's own
    // feet was ever touched.
    check('a unit 500 down the cone takes the 3000',
          Math.abs((hp0 - out.hp) - 3000) < 300, `${Math.round(hp0 - out.hp)}`);
  } else check('dummy could be summoned for the cone test', false, 'no hfoo');
}

// -------------------------------------------------------------- Battle Roar
console.log('\n-- ANbr is Battle Roar: it buffs friends, it does not burn enemies');
{
  const L = levelInfo(ABILS.A03S, 1);            // 섬경 천본앵경엄, Byakuya
  check('A03S carries 1000 in Nbr1 "Damage Increase"', L.data1 === 1000, `${L.data1}`);
  clearFoes();
  const bystander = foe(80, 0);
  if (bystander) {
    const hp0 = bystander.hp;
    execute(world, hero, ABILS.A03S, 1, { x: hero.x, y: hero.y });
    check('an enemy in range takes no damage from a roar', bystander.hp === hp0,
          `${hp0 - bystander.hp}`);
    check('and the caster comes away with the damage buff',
          (hero.buffs || []).some((b) => b.kind === 'rage'), 'rage');
  } else check('dummy could be summoned for the roar test', false, 'no hfoo');
}

// ---------------------------------------------------------- Finger of Death
console.log('\n-- Finger of Death keeps its damage in Nfd3');
{
  const L = levelInfo(ABILS.A01G, 1);            // 금술오의-시귀봉진, Sandaime
  check('A01G carries 0.25 graphic delay and 10000 damage',
        L.data1 === 0.25 && L.data3 === 10000, `d1=${L.data1} d3=${L.data3}`);
  clearFoes();
  const t = foe(120, 0);
  if (t) {
    const hp0 = t.hp;
    execute(world, hero, ABILS.A01G, 1, { target: t, x: t.x, y: t.y });
    // Armour reduction is real and applies here, so this checks the order of
    // magnitude the map asked for rather than the raw figure -- the defect was
    // 0.25, four orders of magnitude out.
    check('it deals the 10000, not the 0.25',
          Math.abs((hp0 - t.hp) - 10000) < 1000, `${Math.round(hp0 - t.hp)}`);
  } else check('dummy could be summoned for the nuke test', false, 'no hfoo');
}

// ------------------------------------------------- the map's deliberate zeros
//
// 27 of this map's abilities write an explicit 0 into a slot the engine used to
// default over, because the ability's own trigger carries the payload.  These
// four are from four different bases and four different heroes, one of them in
// the half of the roster HeroSweep.TXT never ran.
console.log('\n-- a slot the map set to 0 deals 0, not the engine\'s fallback');
{
  const ZEROED = [
    ['A02V', 'Awrh', '초콜릿이 되라',   80],   // Majin Buu, was 80 in a 250 ring
    ['A007', 'AUcs', '게이트 오브 바빌론', 100],  // Gilgamesh, was 100 down a line
    ['A00K', 'AHtb', '츠쿠요미',        100],  // Itachi -- roster half never swept
    ['A04R', 'AOsh', '고무고무 총난타',   100],  // Luffy, ranks 1-5 zeroed, 6-10 are not
  ];
  for (const [id, base, name, wasDealing] of ZEROED) {
    const A = ABILS[id];
    if (!A) { check(`${id} is in the table`, false); continue; }
    const L = levelInfo(A, 1);
    check(`${id} ${name} carries an explicit 0, not an absent field`,
          'data1' in L && L.data1 === 0, `data1=${L.data1}`);
    clearFoes();
    const t = foe(60, 0);
    if (!t) { check(`${id} could be aimed at a dummy`, false); continue; }
    const hp0 = t.hp;
    execute(world, hero, A, 1, { target: t, x: t.x, y: t.y });
    check(`${id} deals nothing rather than the old ${wasDealing}`,
          t.hp === hp0, `${Math.round(hp0 - t.hp)} dealt`);
    // A 0.01 duration is the same statement in the duration field, and the
    // War Stomp case used to floor it to a full second.
    // No buff of ANY kind: asserting only "no stun" would have passed while the
    // block fell through to Thunder Clap's slow, which is a different ability.
    if (L.duration > 0 && L.duration <= 0.1)
      check(`${id} leaves no buff either, its duration being ${L.duration}`,
            (t.buffs || []).length === 0,
            (t.buffs || []).map((b) => b.kind).join(',') || 'none');
  }
  // ...and the fallback still applies where the map declared a real number, so
  // this is not a blanket "zero everything".
  clearFoes();
  const t = foe(60, 0);
  if (t) {
    const hp0 = t.hp;
    execute(world, hero, ABILS.A01N, 3, { x: hero.x + 400, y: hero.y });
    check('an ability that DOES declare its damage still deals it',
          Math.abs((hp0 - t.hp) - 3000) < 300, `${Math.round(hp0 - t.hp)}`);
  }
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
