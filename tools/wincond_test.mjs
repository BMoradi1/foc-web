import { World, id2int } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';

function fresh() {
  const w = new World(); const e = new JassEngine(w);
  e.load();
  const vic = [], def = [];
  e.boot();
  const ov = e.vm.natives.get('CustomVictoryBJ'), od = e.vm.natives.get('CustomDefeatBJ');
  e.vm.registerNative('CustomVictoryBJ', (p) => { vic.push(p && p.index); return ov(p); });
  e.vm.registerNative('CustomDefeatBJ', (p, m) => { def.push(p && p.index); return od(p, m); });
  return { w, e, vic, def, tick: (s) => { for (let i = 0; i < Math.round(s * 30); i++) { e.update(1000 / 30); w.step(); } } };
}

// ---------- path 1: 100 team hero kills
{
  const { w, e, vic, def, tick } = fresh();
  tick(1);
  e.players[5].score = { 7: 99 };
  const A = w.sellUnit(w.tavernFor('H004'), e.players[0], 'H004');
  const B = w.sellUnit(w.tavernFor('E00T'), e.players[5], 'E00T');
  w.killUnit(A, B);                       // team 2's kill #100
  tick(7);
  console.log('PATH 1 — 100 hero kills');
  console.log('   victory:', vic.join(',') || 'none', '  defeat:', def.join(',') || 'none');
  const lb = e.leaderboards.find((b) => b.rows.length);
  console.log('   board:', lb.rows.map((r) => `${r.label.replace(/\|c........|\|r/g, '')}${r.value}`).join(' / '));
}

// ---------- path 2: Boss Mulder dies
{
  const { w, e, vic, def, tick } = fresh();
  tick(1);
  const A = w.sellUnit(w.tavernFor('H004'), e.players[2], 'H004');
  const boss = [...w.units.values()].find((u) => u.typeKey === 'N007');
  console.log('\nPATH 2 — Boss Mulder killed');
  console.log('   boss:', boss && boss.name, 'hp', boss && Math.round(boss.maxHp));
  w.killUnit(boss, A);                    // killed by a team-1 player
  tick(7);
  console.log('   victory:', vic.join(',') || 'none', '  defeat:', def.join(',') || 'none');
}

// ---------- duel mode
{
  const { w, e, tick } = fresh();
  tick(1);
  const A = w.sellUnit(w.tavernFor('H004'), e.players[0], 'H004');
  const B = w.sellUnit(w.tavernFor('E00T'), e.players[5], 'E00T');
  const before = { units: w.units.size, ax: Math.round(A.x), ay: Math.round(A.y), errs: e.errors.length };
  const texts = [];
  const ot = e.vm.natives.get('DisplayTimedTextToPlayer');
  e.vm.registerNative('DisplayTimedTextToPlayer', (p, x, y, d, s) => { if (s) texts.push(String(s)); return ot(p, x, y, d, s); });
  w.chat(e.players[0], '@duel');
  tick(6);
  console.log('\nDUEL MODE (@duel)');
  console.log('   units', before.units, '->', w.units.size, ' hero moved:', before.ax !== Math.round(A.x) || before.ay !== Math.round(A.y));
  console.log('   errors added:', e.errors.length - before.errs);
  console.log('   messages:', texts.slice(0, 4).map((t) => t.replace(/\|c........|\|r/g, '').slice(0, 60)));
}

// ---------- other modes
for (const cmd of ['@tome', '@nocool', '@fight', '@ar']) {
  const { w, e, tick } = fresh();
  tick(1);
  w.sellUnit(w.tavernFor('H004'), e.players[0], 'H004');
  const before = e.errors.length;
  w.chat(e.players[0], cmd);
  tick(4);
  console.log(`MODE ${cmd.padEnd(8)} -> ${e.errors.length - before} errors, ${w.units.size} units`);
}
