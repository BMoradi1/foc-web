// What a unit CARRIES: its weapons, its command card and its burn.
//
// Three findings share one root -- the port read the hero definition or the
// item list where Warcraft III reads the unit itself.
//
//   1. WEAPONS   UnitWeapons.slk's `weapsOn` (the map's own `uaen`) says how
//                many of a unit type's weapons are turned on.  The extractor
//                dropped it, so 103 of this map's unit types -- every spell
//                dummy it builds -- inherited their base's damage and stood
//                around auto-attacking with it.  93 of them carry a real
//                damage figure and so were actually swinging.
//   2. CARD      The command card is built from the unit, not from the hero, so
//                an alternate form's own abilities reach it the moment the form
//                does.  Six of this map's sixteen forms grant an ability with
//                an order string and none of them could ever be cast.
//   3. BURN      AIcf (Cloak of Flames) reached the game only through carried
//                ITEMS.  Eneru's Thunder God form holds it as a unit ability --
//                500 damage a second in a 200 radius -- and burned nobody.
//
//   node tools/carried_test.mjs        (no server needed)
import fs from 'node:fs';
import path from 'node:path';
import { ABILS, isPassive, entry as abilEntry, carriedImmolation, execute } from '../server/abilities.js';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import { Room, GAME } from '../server/room.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const TYPES = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/unittypes.json'), 'utf8'));
const fails = [];
let pass = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fails.push(name); console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
};

// ============================================================ 1. the weapons
console.log('\n-- weapons: a unit type the map disarmed does not swing');
{
  const off = Object.entries(TYPES).filter(([, t]) => !Number(t.attacksEnabled ?? 1));
  const armed = off.filter(([, t]) => (t.dmgBase || 0) > 0);
  check('the unit table carries weapsOn / uaen at all', off.length > 0,
        `${off.length} of ${Object.keys(TYPES).length} types have it at 0`);
  check('and the map turns it off on the dummies it builds', armed.length >= 90,
        `${armed.length} disarmed types still carry a damage figure`);
  // No hero anyone can play loses an attack to this.  The one unit type in the
  // table that is both flagged isHero and disarmed is 'Huth' -- the map rebased
  // Blizzard's Uther row into 창고, a MagicVault building with 0 damage, and
  // only the inherited STR primary still says "hero".
  const roster = new Set(GAME.heroes.map((h) => h.id));
  check('no hero anyone can play is disarmed by it',
        !off.some(([k]) => roster.has(k)),
        off.filter(([k]) => roster.has(k)).map(([k]) => k).join(','));
  // 적화포's ten dummies are the reported case: hp 2, hpReg -1, 7+1d2 damage at
  // 600 range, and the map sets uaen 0 on them.
  check('nchp -- Renji\'s 적화포 dummy -- is one of them',
        Number(TYPES.nchp.attacksEnabled) === 0 && TYPES.nchp.dmgBase > 0,
        `uaen=${TYPES.nchp.attacksEnabled} dmg=${TYPES.nchp.dmgBase}`);
  // The other half of the same report: the map gives its dummies a life span
  // through a negative life regeneration rather than a timer.
  const bleed = Object.entries(TYPES).filter(([, t]) => (t.hpReg || 0) < 0);
  check('the map writes a negative life regen on its dummies', bleed.length >= 100,
        `${bleed.length} unit types bleed by design`);
  check('and nchp is written to last about two seconds',
        TYPES.nchp.hpReg < 0 && TYPES.nchp.hp <= 10,
        `${TYPES.nchp.hp} life at ${TYPES.nchp.hpReg}/s`);
}

const world = new World();
const eng = new JassEngine(world);
eng.load(); eng.boot();
const STEP = 1000 / 30;
for (let i = 0; i < 30; i++) { eng.update(STEP); world.step(); }
const P = (n) => world.jass.players[n];

console.log('\n-- and it does not swing in the simulation either');
{
  const victim = world.createUnit(P(0), 'hpea', 0, 0, 0);
  const dummy = world.createUnit(P(6), 'nchp', 0, 0, 0);
  if (!victim || !dummy) { check('the pair could be built', false); }
  else {
    victim.x = 0; victim.y = 0; victim.hp = victim.maxHp = 100000; victim.armor = 0;
    dummy.x = 60; dummy.y = 0;
    check('the dummy reaches the simulation with its weapon off',
          !dummy.attacksEnabled, `attacksEnabled=${dummy.attacksEnabled}`);
    const hp0 = victim.hp;
    world.binTick = -1; world.rebuildBins();
    for (let i = 0; i < 30 * 10; i++) { eng.update(STEP); world.step(); }
    check('ten seconds beside an enemy costs that enemy nothing',
          victim.hp === hp0, `${Math.round(hp0 - victim.hp)} damage dealt`);
    check('and it never acquires one either', dummy.order.type !== 'attack',
          `order=${dummy.order.type}`);
    // The same dummy is written to bleed out: 2 life against -1 a second is the
    // map giving it a two-second life span without a timer.  Nothing killed it,
    // so it used to sit on negative life for the rest of the match.
    check('and after ten seconds of -1 life a second it is dead',
          !dummy.alive, `hp=${Math.round(dummy.hp)} alive=${dummy.alive}`);
    victim.alive = false;
  }
}

// =========================================================== 2. the card
console.log('\n-- the command card is built from the unit, not from the hero');
{
  // Every alternate form this map's metamorphosis abilities name, and the
  // abilities each grants that carry an order string.
  const forms = new Map();
  for (const [aid, ab] of Object.entries(ABILS)) {
    if (!['AEme', 'AHmt', 'ACmt', 'ANcr'].includes(ab.base)) continue;
    for (const l of ab.levels || []) if (l.unit) forms.set(l.unit, aid);
  }
  const granting = [...forms].filter(([f]) =>
    ((TYPES[f] || {}).abilities || []).some((a) => ABILS[a] && !isPassive(ABILS[a])));
  check('the map has forms that grant an active ability', granting.length >= 5,
        `${granting.length} of ${forms.size} forms`);

  const card = (heroId, u) => Room.prototype.cardSlots.call(Object.create(Room.prototype),
                                                            { heroId }, u);
  // Luffy's Gear form (H01P) carries 기간트 피스톨, a 1000-damage AHtb the hero
  // definition never describes because it belongs to the form.
  const luffy = GAME.heroes.find((h) => (h.castable || []).includes('A04X'));
  check('Luffy is on the roster with his static five', luffy && luffy.castable.length === 5,
        luffy ? luffy.castable.join(',') : 'not found');
  if (luffy) {
    const u = world.createUnit(P(0), luffy.id, 500, 500, 0);
    if (!u) check('Luffy could be built', false);
    else {
      const before = card(luffy.id, u);
      check('unmorphed, his card is the list the map gives him',
            !before.includes('A04Y'), before.join(','));
      const morphed = world.morph(u, 'H01P', 30);
      check('the Gear form is a unit type he can become', morphed);
      const after = card(luffy.id, u);
      check('morphed, 기간트 피스톨 has a slot', after.includes('A04Y'), after.join(','));
      check('and every slot he already had kept its index',
            before.every((a, i) => after[i] === a), `${before.join(',')} -> ${after.join(',')}`);
      // the slot has to resolve back to the ability, or the cast goes nowhere
      const slot = after.indexOf('A04Y');
      const back = Room.prototype.slotAbility.call(Object.create(Room.prototype),
                                                   { heroId: luffy.id }, u, slot);
      check('the slot resolves back to A04Y for the cast path',
            back === (('A04Y'.charCodeAt(0) << 24) | ('A04Y'.charCodeAt(1) << 16)
                      | ('A04Y'.charCodeAt(2) << 8) | 'A04Y'.charCodeAt(3)), String(back));
      world.unmorph(u);
      check('and it goes away again with the form', !card(luffy.id, u).includes('A04Y'));
      u.alive = false;
    }
  }
  // Majin Buu's 기폭팔 is the other half: a base ability with an order string
  // that no trigger names, so it never reached `castable` at all.
  const buu = GAME.heroes.find((h) => (h.abilityIds || []).includes('A00Z'));
  check('A00Z is a castable ability the map never triggers on',
        !!ABILS.A00Z && !isPassive(ABILS.A00Z) && ABILS.A00Z.order === 'thunderclap');
  if (buu) {
    check('and it is missing from the static castable list',
          !(buu.castable || []).includes('A00Z'), (buu.castable || []).join(','));
    const u = world.createUnit(P(0), buu.id, 800, 800, 0);
    if (u) {
      check('but the unit holds it, so the card offers it', card(buu.id, u).includes('A00Z'),
            card(buu.id, u).join(','));
      u.alive = false;
    }
  }
  // nothing passive may creep onto the card
  {
    const u = world.createUnit(P(0), (luffy || GAME.heroes[0]).id, 1200, 1200, 0);
    if (u) {
      const slots = card((luffy || GAME.heroes[0]).id, u);
      const bad = slots.filter((a) => ABILS[a] && isPassive(ABILS[a]));
      check('no passive reaches the card', bad.length === 0, bad.join(','));
      check('and the inventory ability never does', !slots.includes('AInv'), slots.join(','));
      u.alive = false;
    }
  }
}

// =========================================================== 3. the burn
console.log('\n-- Cloak of Flames burns when a unit carries it as an ability');
{
  const L = (ABILS.A020.levels || [])[0];
  check('A020 carries 500 damage per 1.0s in a 200 radius',
        L.data1 === 500 && (L.duration === 1 || L.heroDuration === 1) && L.area === 200,
        `${L.data1} / ${L.duration} / ${L.area}`);
  check('and it is still read as passive -- it has no order string',
        isPassive(ABILS.A020) && !ABILS.A020.order);
  const eneru = GAME.heroes.find((h) => (h.castable || []).includes('A01Y'));
  check('Eneru is on the roster', !!eneru, eneru ? eneru.id : 'not found');
  if (eneru) {
    const u = world.createUnit(P(0), eneru.id, -800, -800, 0);
    if (u) {
      check('unmorphed he carries no burn', !u.immolation, JSON.stringify(u.immolation));
      world.morph(u, 'O003', 30);
      const imm = u.immolation;
      check('the Thunder God form burns at the ability\'s own rate',
            imm && Math.abs(imm.dps - 500) < 1 && imm.area === 200,
            imm ? `${imm.dps} dps in ${imm.area}` : 'no burn');
      check('carriedImmolation reads it off the unit', !!carriedImmolation(world, u));
      // and it really costs a nearby enemy life
      const victim = world.createUnit(P(6), 'hpea', -800, -800, 0);
      if (victim) {
        victim.x = u.x + 100; victim.y = u.y; victim.hp = victim.maxHp = 100000; victim.armor = 0;
        world.binTick = -1; world.rebuildBins();
        const hp0 = victim.hp;
        for (let i = 0; i < 30; i++) { eng.update(STEP); world.step(); }
        check('a unit standing beside the form loses life to it', victim.hp < hp0,
              `${Math.round(hp0 - victim.hp)} in a second`);
        victim.alive = false;
      }
      world.unmorph(u);
      check('and the burn ends with the form', !u.immolation, JSON.stringify(u.immolation));
      u.alive = false;
    }
  }
}

// ======================================================= 4. bash and the form
//
// Two more the sweep queue turned up, both of them a field nothing read.
console.log('\n-- Bash is a proc on attack, not a rage buff on the caster');
{
  const { attackProcs } = await import('../server/abilities.js');
  // Sandaime Hokage's five 강타 ranks are the only carriers on this map.
  const ranks = ['A019', 'A018', 'A017', 'A016', 'A01A'];
  for (const id of ranks) {
    const L = (ABILS[id].levels || [])[0];
    check(`${id} carries a bash chance, a x${L.data2} multiplier and a ${L.duration}s stun`,
          L.data1 > 0 && L.data2 === 3 && L.duration > 0,
          `${L.data1}% x${L.data2} for ${L.duration}s`);
  }
  check('all five are passive, so no cast path was ever going to reach them',
        ranks.every((id) => isPassive(ABILS[id])));
  const u = world.createUnit(P(0), (GAME.heroes[0] || {}).id, -2000, -2000, 0);
  if (u) {
    for (const id of ranks) u.abilities.set(
      (id.charCodeAt(0) << 24) | (id.charCodeAt(1) << 16) | (id.charCodeAt(2) << 8) | id.charCodeAt(3), 1);
    const p = attackProcs(world, u);
    // the strongest rank is A01A: 40% for a 3 second stun
    check('attackProcs reads the strongest rank off the unit',
          p.bash && p.bash.chance === 40 && p.bash.mult === 3 && p.bash.stun === 3,
          JSON.stringify(p.bash));
    check('and it is not spent as a rage buff on the caster',
          !(u.buffs || []).some((b) => b.kind === 'rage'), JSON.stringify(u.buffs));
    u.alive = false;
  }
  // a unit carrying none of them gets no bash at all
  const plain = world.createUnit(P(0), (GAME.heroes[1] || GAME.heroes[0]).id, -2400, -2400, 0);
  if (plain) {
    check('a hero without Bash has none', !attackProcs(world, plain).bash);
    plain.alive = false;
  }
}

console.log('\n-- Eme5 is life the alternate form carries');
for (const [id, form, who] of [['A040', 'O004', 'InuYasha 요괴화'], ['A01Y', 'O003', 'Eneru 뇌신']]) {
  const L = (ABILS[id].levels || [])[0];
  check(`${id} (${who}) carries a 3000 life bonus in Eme5`, L.data5 === 3000, String(L.data5));
  const hero = GAME.heroes.find((h) => (h.castable || []).includes(id));
  if (!hero) { check(`${id}'s hero is on the roster`, false); continue; }
  const u = world.createUnit(P(0), hero.id, -3000, -3000, 0);
  if (u) {
    const before = u.maxHp;
    execute(world, u, ABILS[id], 1, {});
    check(`${id} takes the form`, u.morphed && u.typeKey === form, `${u.typeKey}`);
    check(`${id} adds the 3000 the map wrote on top of the form's own life`,
          u.maxHp >= before + 3000 || u.maxHp - (world.type(form).hp || 0) >= 3000,
          `${Math.round(before)} -> ${Math.round(u.maxHp)}`);
    const inForm = u.maxHp;
    world.unmorph(u);
    check(`${id} gives the bonus back with the form`, u.maxHp < inForm,
          `${Math.round(inForm)} -> ${Math.round(u.maxHp)}`);
    u.alive = false;
  }
}

// ============================ 5. two constants of ours the map had a field for
console.log('\n-- Thunder Clap slows by its own Htc3, not by a constant');
{
  const L = (ABILS.A01P.levels || [])[0];            // 뇌격, Eneru
  check('A01P carries a 0.4 movement and 0.4 attack reduction',
        L.data3 === 0.4 && L.data4 === 0.4, `${L.data3} / ${L.data4}`);
  const caster = world.createUnit(P(0), (GAME.heroes[0] || {}).id, 4000, 4000, 0);
  const victim = world.createUnit(P(6), 'hpea', 4000, 4000, 0);
  if (caster && victim) {
    caster.x = 4000; caster.y = 4000; victim.x = 4100; victim.y = 4000;
    victim.hp = victim.maxHp = 1e9; victim.hpReg = 0;
    world.binTick = -1; world.rebuildBins();
    execute(world, caster, ABILS.A01P, 1, { x: caster.x, y: caster.y });
    const b = (victim.buffs || []).find((x) => x.kind === 'slow');
    check('the slow it leaves is the map\'s 0.4, not our 0.25',
          b && Math.abs(b.pct - 0.4) < 1e-9, b ? String(b.pct) : 'no slow');
    check('and it carries the attack-speed half of the same pair',
          b && Math.abs(b.atkPct - 0.4) < 1e-9, b ? String(b.atkPct) : '-');
    // War Stomp declares neither field, so it must not pick one up
    const wsL = (ABILS.A044.levels || [])[0];
    check('War Stomp declares no reduction field at all',
          wsL.data3 === undefined || wsL.data3 === 0, String(wsL.data3));
    caster.alive = false; victim.alive = false;
  }
}

console.log('\n-- a mirror image is the hero\'s own life, with two multipliers');
{
  const L = (ABILS.A02N.levels || [])[0];            // 그림자 분신, Sandaime
  check('A02N carries Omi2 = 1 dealt and Omi3 = 1.5 taken',
        L.data2 === 1 && L.data3 === 1.5, `${L.data2} / ${L.data3}`);
  const hero = GAME.heroes.find((h) => (h.castable || []).includes('A02N'))
            || GAME.heroes[0];
  const u = world.createUnit(P(0), hero.id, 5000, 5000, 0);
  if (u) {
    const before = [...world.units.values()].filter((x) => x.isImage).length;
    execute(world, u, ABILS.A02N, 1, { x: u.x, y: u.y });
    const imgs = [...world.units.values()].filter((x) => x.isImage && x.alive);
    check('it makes the Omi1 number of images', imgs.length - before === Math.round(L.data1),
          `${imgs.length - before} of ${L.data1}`);
    const img = imgs[imgs.length - 1];
    if (img) {
      // the 0.2 life factor was ours and appears in no field
      check('an image keeps the hero\'s own life rather than a fifth of it',
            img.maxHp > u.maxHp * 0.5, `${Math.round(img.maxHp)} vs the hero's ${Math.round(u.maxHp)}`);
      check('and it takes the Omi3 multiplier on damage',
            Math.abs((img.damageTakenMul || 0) - 1.5) < 1e-9, String(img.damageTakenMul));
      const hp0 = img.hp;
      world.damage(null, img, 100, { raw: true });
      check('so 100 raw damage costs it 150', Math.abs((hp0 - img.hp) - 150) < 1,
            String(Math.round(hp0 - img.hp)));
      for (const x of imgs) x.alive = false;
    }
    u.alive = false;
  }
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
