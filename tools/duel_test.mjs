import { World, id2int } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
const w = new World(); const e = new JassEngine(w);
e.load(); e.boot();
const msgs = [];
for (const n of ['DisplayTextToForce', 'DisplayTimedTextToForce', 'DisplayTextToPlayer', 'DisplayTimedTextToPlayer']) {
  const o = e.vm.natives.get(n);
  if (o) e.vm.registerNative(n, (...a) => { const s = a.find((x) => typeof x === 'string'); if (s) msgs.push(s); return o(...a); });
}
const tick = (s) => { for (let i = 0; i < Math.round(s * 30); i++) { e.update(1000 / 30); w.step(); } };
tick(2);
const A = w.sellUnit(w.tavernFor('H004'), e.players[0], 'H004');
const B = w.sellUnit(w.tavernFor('E00T'), e.players[5], 'E00T');
console.log('heroes placed. simulating 320s of game time…');
const t0 = Date.now();
const pos0 = { a: [Math.round(A.x), Math.round(A.y)], b: [Math.round(B.x), Math.round(B.y)] };
tick(320);
console.log(`simulated in ${((Date.now() - t0) / 1000).toFixed(1)}s wall clock`);
console.log('hero A moved:', pos0.a, '->', [Math.round(A.x), Math.round(A.y)]);
console.log('hero B moved:', pos0.b, '->', [Math.round(B.x), Math.round(B.y)]);
console.log('paused:', A.paused, B.paused);
const clean = [...new Set(msgs)].map((s) => s.replace(/\|c........|\|r/g, '').replace(/\n/g, ' ⏎ '));
console.log('\nmap messages seen:');
for (const m of clean.slice(0, 12)) console.log('   ' + m.slice(0, 110));
console.log('\nunits:', w.units.size, ' errors:', [...new Set(e.errors.map((x) => x.split('\n')[0]))].length);
