import { World, id2int } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
const world = new World(); const eng = new JassEngine(world);
eng.load();
let victories = [];
eng.boot();
// observe the map's victory call
const orig = eng.vm.natives.get('CustomVictoryBJ');
eng.vm.registerNative('CustomVictoryBJ', (p) => { victories.push(p && p.index); });
const tick = (s) => { for (let i = 0; i < s * 30; i++) { eng.update(1000 / 30); world.step(); } };
tick(1);
// seat team 1 one kill short of the map's 100-kill threshold
eng.players[0].score = { 7: 99 };
const A = world.sellUnit(world.tavernFor('H004'), eng.players[0], 'H004');
const B = world.sellUnit(world.tavernFor('E00T'), eng.players[5], 'E00T');
world.moveUnit(A, B.x + 100, B.y);
console.log('team 1 hero kills before:', world.score(eng.players[0], 7));
world.killUnit(B, A);
tick(7);                                    // trigger sleeps 5s before declaring
console.log('team 1 hero kills after :', world.score(eng.players[0], 7));
const lb = eng.leaderboards.find((b) => b.rows.length);
console.log('board:', lb ? lb.rows.map((r) => `${r.label.replace(/\|c........|\|r/g,'')}=${r.value}`).join(', ') : 'none');
console.log('CustomVictoryBJ called for players:', victories.length ? victories.join(', ') : 'NONE');
console.log('errors:', [...new Set(eng.errors.map(e=>e.split('\n')[0]))].slice(0,5));
