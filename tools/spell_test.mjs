import { World, id2int, int2id } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import fs from 'node:fs';
const GAME = JSON.parse(fs.readFileSync('data/game.json', 'utf8'));

const world = new World();
const eng = new JassEngine(world);
eng.load();
eng.boot();
const tick = (secs) => { for (let i = 0; i < secs * 30; i++) { eng.update(1000 / 30); world.step(); } };
tick(2);

// buy two heroes from the taverns the map defines, on opposing teams
function buy(heroId, slot) {
  const ph = eng.players[slot];
  const tav = world.tavernFor(heroId);
  const u = world.sellUnit(tav, ph, heroId);
  return u;
}
const A = buy('H004', 0);          // Saber, team 1
const B = buy('E00T', 5);          // Goku, team 2
console.log('bought:', A && A.name, '(team', A.team, ') vs', B && B.name, '(team', B.team, ')');
console.log('tavern for Saber:', world.tavernFor('H004')?.name);

// learn and cast every one of Saber's real spells
const hero = GAME.heroes.find((h) => h.id === 'H004');
console.log('Saber learnable:', hero.learnable.join(', '));
for (const aid of hero.learnable) {
  world.addAbility(A, id2int(aid));
  world.setAbilityLevel(A, id2int(aid), 3);
}
world.moveUnit(A, B.x + 200, B.y);
A.mana = A.maxMana = 5000;
tick(0.5);

const before = { hp: B.hp, units: world.units.size, errs: eng.errors.length };
const results = [];
for (const aid of hero.learnable) {
  const r = world.castAbility(A, id2int(aid), B, B.x, B.y);
  const ab = hero.abilities.find((a) => a.id === aid);
  tick(1.5);
  results.push([aid, ab?.name, r.ok ? 'cast' : r.reason, Math.round(B.hp)]);
  A.cooldowns.clear(); A.mana = A.maxMana;
}
console.log('\nspell            name                        result   target hp');
for (const [id, nm, res, hp] of results)
  console.log(`  ${id.padEnd(6)} ${String(nm).padEnd(28)} ${res.padEnd(8)} ${hp}`);
console.log(`\ntarget hp ${Math.round(before.hp)} -> ${Math.round(B.hp)}   units ${before.units} -> ${world.units.size}`);
const newErrs = eng.errors.slice(before.errs);
console.log('errors during casting:', newErrs.length);
for (const e of [...new Set(newErrs.map((x) => x.split('\n')[0]))].slice(0, 8)) console.log('  !', e);

// game-mode chat commands
console.log('\n--- chat triggers registered:');
const chatEvs = [];
for (const tr of eng.triggers) for (const ev of tr.events) if (ev.kind === 'chat') chatEvs.push(ev.chat);
console.log(' ', chatEvs.join(' | ') || '(none)');
if (chatEvs.length) {
  const errs0 = eng.errors.length;
  world.chat(eng.players[0], chatEvs[0]);
  tick(1);
  console.log(`  fired "${chatEvs[0]}" -> ${eng.errors.length - errs0} errors, ${world.units.size} units`);
}
const lb = eng.leaderboards.find((b) => b.rows.length);
console.log('\nmap leaderboard:', lb ? `"${lb.title}" with ${lb.rows.length} rows` : 'none created yet');
