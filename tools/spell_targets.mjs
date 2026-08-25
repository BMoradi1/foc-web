/**
 * Which target does each hero ability actually need?
 *
 * Warcraft III's ability tables carry no "unit target vs point target vs
 * instant" column -- 'targs1' is populated for instant and point abilities
 * alike -- so the honest source is the map's own trigger.  Cast every hero
 * ability once and record which target accessor its trigger reaches for:
 * GetSpellTargetUnit means it wants a unit, GetSpellTargetLoc/X/Y means a
 * point, neither means it fires where it stands.
 */
process.chdir(new URL('..', import.meta.url).pathname);
import fs from 'node:fs';
const { World, id2int } = await import('../server/world.js');
const { JassEngine } = await import('../server/jass/engine.js');

const GAME = JSON.parse(fs.readFileSync('data/game.json', 'utf8'));
const w = new World(), e = new JassEngine(w);
e.load();

let touched = { unit: false, point: false };
for (const n of ['GetSpellTargetUnit']) {
  const f = e.vm.natives.get(n);
  e.vm.natives.set(n, function (...a) { touched.unit = true; return f.apply(this, a); });
}
for (const n of ['GetSpellTargetLoc', 'GetSpellTargetX', 'GetSpellTargetY']) {
  const f = e.vm.natives.get(n);
  if (f) e.vm.natives.set(n, function (...a) { touched.point = true; return f.apply(this, a); });
}
e.boot();
const tick = (s) => { for (let i = 0; i < Math.round(s * 30); i++) { e.update(1000 / 30); w.step(); } };
tick(2);

const modes = {};
for (const h of GAME.heroes) {
  const ids = (h.learnable && h.learnable.length) ? h.learnable
            : (h.abilities || []).map((a) => a.id);
  if (!ids.length) continue;
  let A;
  try { A = w.sellUnit(w.tavernFor(h.id), e.players[0], h.id); } catch { continue; }
  if (!A) continue;
  A.controlled = true; A.invulnerable = true; A.mana = A.maxMana = 999999;
  for (const aid of ids) {
    const k = id2int(aid);
    w.addAbility(A, k); w.setAbilityLevel(A, k, 1);
    // a live enemy in range, so a unit-target trigger has something to read
    const T = w.createUnit(e.players[6], 'hfoo', A.x + 120, A.y, 0);
    if (T) { T.maxHp = T.hp = 1e7; }
    touched = { unit: false, point: false };
    if (A.cooldowns) A.cooldowns.clear();
    A.mana = A.maxMana;
    try { w.castAbility(A, k, T, T ? T.x : A.x, T ? T.y : A.y); } catch {}
    tick(2.5);                                   // let waits inside the trigger resume
    const mode = touched.unit ? 'unit' : touched.point ? 'point' : 'none';
    // a spell may read both; the unit is the stricter requirement
    modes[aid] = mode;
    if (T) T.alive = false;
  }
  A.alive = false;
}
fs.writeFileSync('data/spell_targets.json', JSON.stringify(modes, null, 1));
const c = {};
for (const v of Object.values(modes)) c[v] = (c[v] || 0) + 1;
console.log('hero abilities probed: ' + Object.keys(modes).length);
console.log('target modes: ' + JSON.stringify(c));
