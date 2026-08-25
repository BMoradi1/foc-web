import { World, id2int } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import fs from 'node:fs';
const GAME = JSON.parse(fs.readFileSync('data/game.json', 'utf8'));
const w = new World(); const e = new JassEngine(w);
e.load(); e.boot();
const tick = (s) => { for (let i = 0; i < Math.round(s * 30); i++) { e.update(1000 / 30); w.step(); } };
tick(2);
const A = w.sellUnit(w.tavernFor('H004'), e.players[0], 'H004');   // Saber
const B = w.sellUnit(w.tavernFor('E00T'), e.players[5], 'E00T');   // Goku
const hero = GAME.heroes.find((h) => h.id === 'H004');
for (const a of hero.learnable) { w.addAbility(A, id2int(a)); w.setAbilityLevel(A, id2int(a), 3); }
A.mana = A.maxMana = 9999; B.hp = B.maxHp = 999999;
w.moveUnit(A, B.x + 120, B.y);
e.clientEvents.length = 0;
const heard = [];
for (const a of hero.learnable) {
  w.castAbility(A, id2int(a), B, B.x, B.y);
  tick(1.5);
  const snd = e.flushClientEvents().filter((x) => x.t === 'sound');
  heard.push([a, hero.abilities.find((z) => z.id === a)?.name, snd.map((s) => s.path)]);
  A.cooldowns.clear(); A.mana = A.maxMana;
}
console.log('sounds the map plays per spell (Saber):');
for (const [id, name, paths] of heard)
  console.log(`  ${id}  ${String(name).padEnd(20)} -> ${paths.join(', ') || '(none)'}`);

// how many distinct sounds over a longer fight, and are the files present?
e.clientEvents.length = 0;
A.order = { type: 'attack', targetId: B.id }; B.order = { type: 'attack', targetId: A.id };
tick(30);
const all = e.flushClientEvents().filter((x) => x.t === 'sound');
const uniq = [...new Set(all.map((s) => s.path))];
console.log(`\n${all.length} sound events over 30s, ${uniq.length} distinct files`);
let present = 0, absent = [];
for (const p of uniq) {
  const local = p.includes('/') ? null : `public/assets/sounds/${p}`;
  if (local && fs.existsSync(local)) present++; else absent.push(p);
}
console.log(`  served from the map: ${present}`);
console.log(`  need War3local.mpq : ${absent.length}  ${absent.slice(0, 4).join(', ')}`);
