import { World, id2int } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import fs from 'node:fs';
const GAME = JSON.parse(fs.readFileSync('data/game.json', 'utf8'));

const world = new World();
const eng = new JassEngine(world);
eng.load();
eng.boot();
const tick = (secs) => { for (let i = 0; i < Math.round(secs * 30); i++) { eng.update(1000 / 30); world.step(); } };

function buy(heroId, slot) {
  const u = world.sellUnit(world.tavernFor(heroId), eng.players[slot], heroId);
  const hero = GAME.heroes.find((h) => h.id === heroId);
  for (const aid of hero.learnable) { world.addAbility(u, id2int(aid)); world.setAbilityLevel(u, id2int(aid), 4); }
  u.mana = u.maxMana = 20000;
  return u;
}
const A = buy('H004', 0);      // Saber   team 1
const B = buy('E00T', 5);      // Goku    team 2
console.log(`${A.name} (team ${A.team}) vs ${B.name} (team ${B.team})`);

const board = () => {
  const lb = eng.leaderboards.find((b) => b.rows.length);
  return lb ? `${lb.title}  [${lb.rows.map((r) => `${r.label}=${r.value}`).join(', ')}]` : '(no board)';
};
console.log('board at start:', board());

let deaths = 0;
const heroA = GAME.heroes.find((h) => h.id === 'H004');
for (let round = 1; round <= 6; round++) {
  // put them next to each other and let them fight with spells
  world.moveUnit(A, B.x + 150, B.y);
  A.order = { type: 'attack', targetId: B.id };
  B.order = { type: 'attack', targetId: A.id };
  for (const aid of heroA.learnable) {
    if (B.alive) world.castAbility(A, id2int(aid), B, B.x, B.y);
  }
  tick(3);
  if (!B.alive) {
    deaths++;
    world.reviveUnit(B, B.x + 400, B.y);
    B.mana = B.maxMana;
  }
  A.cooldowns.clear(); A.mana = A.maxMana; A.hp = A.maxHp;
}
console.log(`\nGoku died ${deaths} times to Saber's spells`);
console.log('board now:  ', board());
console.log(`units in world: ${world.units.size}`);
const creeps = [...world.units.values()].filter((u) => String((world.type(u.typeId) || {}).race).toLowerCase() === 'creeps');
console.log(`creeps alive: ${creeps.length}`);
console.log(`hero levels: ${A.name} lvl ${A.level} (xp ${Math.round(A.xp)}), gold ${Math.round(eng.players[0].gold)}`);
const errs = [...new Set(eng.errors.map((x) => x.split('\n')[0]))];
console.log(`\ndistinct runtime errors: ${errs.length}`);
for (const e of errs.slice(0, 10)) console.log('  !', e);
console.log('unimplemented natives called:', eng.unimplemented.size);
