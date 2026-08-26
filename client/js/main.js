import * as THREE from 'three';
import { Net } from './net.js';
import { Renderer, toX, toZ } from './render.js';
import { UI, Lang } from './ui.js';
import { Audio } from './audio.js';
import { Msg, Phase, Ent } from '/shared/const.js';

const net = new Net();
const ui = new UI(net);
const view = new Renderer(document.getElementById('view'));
const audio = new Audio();

const S = {
  you: null, phase: Phase.LOBBY, game: null, heroes: [], hero: null,
  ents: new Map(),           // id -> latest server state
  prev: new Map(),           // id -> previous state (for interpolation)
  lastSnap: 0, snapDt: 1 / 15,
  selected: null, bounds: null, ready: false, showScore: false,
  castPending: null, minimapImg: null,
};

// ------------------------------------------------------------------ networking
net.on(Msg.WELCOME, (m) => {
  S.you = m.you; net.you = m.you;
  S.game = m.game; S.heroes = m.heroes; S.bounds = m.game.bounds;
  ui.setLoading('loading terrain…', 0.35);
  boot(m).then(() => {
    ui.hideLoading();
    ui.showLobby(m.game, m.heroes);
  });
});

net.on(Msg.STATE, (m) => {
  S.phase = m.phase;
  ui.renderTeams(m.players, S.you, m.phase);
  ui.updateScore(m.board, m.killsToWin);
  if (m.phase === Phase.PLAYING) ui.startGame();
  if (m.phase === Phase.LOBBY && S.game) ui.showLobby(S.game, S.heroes);
});

net.on(Msg.SNAPSHOT, (m) => {
  const now = performance.now();
  S.snapDt = Math.max(1 / 60, Math.min(0.5, (now - S.lastSnap) / 1000)) || 1 / 15;
  S.lastSnap = now;
  const seen = new Set();
  for (const e of m.s.ents) {
    seen.add(e.i);
    const old = S.ents.get(e.i);
    S.prev.set(e.i, old ? { x: old.x, y: old.y, f: old.f } : { x: e.x, y: e.y, f: e.f });
    const meta = findMeta(e);
    S.ents.set(e.i, Object.assign({}, meta, e));
    // A unit can change type mid-game -- Metamorphosis swaps the hero for its
    // alternate form -- and the view is built once from the model that type
    // names, so it has to be rebuilt when the type underneath it changes.
    if (!view.views.has(e.i)) view.spawnView(S.ents.get(e.i));
    else if (old && old.u !== e.u) {
      view.removeView(e.i);
      view.spawnView(S.ents.get(e.i));
    }
  }
  for (const id of [...S.ents.keys()]) if (!seen.has(id)) { S.ents.delete(id); view.removeView(id); }
  view.syncItems(m.s.items, S.game?.items);
  // (static views use negative ids and are never tracked in S.ents, so they persist)
  if (m.s.board) ui.updateScore(m.s.board, 100);
  ui.updateClock(m.s.clock);
});

net.on('hero', (m) => { S.hero = m.h; ui.updateHero(m.h); });

net.on(Msg.EVENT, (m) => {
  for (const ev of m.ev) handleEvent(ev);
});

net.on(Msg.CHATMSG, (m) => ui.log(`<b>${m.from}:</b> ${escapeHtml(m.text)}`));
net.on(Msg.ERROR, (m) => ui.log(m.m, 'kill'));
net.on('closed', () => ui.log('disconnected from server', 'kill'));

/** Where the player is listening from: their hero, else the camera focus. */
function listener() {
  const me = S.ents.get(S.hero?.id);
  if (me) return { x: me.x, y: me.y };
  return { x: view.camTarget.x, y: -view.camTarget.z };
}

/** Every entity carries its unit-type id; look up the converted model for it. */
function findMeta(e) {
  const t = S.unitModels?.[e.u];
  if (t) return { model: t.m, scale: t.s, name: t.n, isHero: !!t.h, isBuilding: !!t.b,
                  radius: t.r, locust: !!t.l,
                  // the unit's own shadow image, size and offset
                  sh: t.sh, sw: t.sw, shh: t.shh, sx: t.sx, sy: t.sy, us: t.us };
  return {};
}

function handleEvent(ev) {
  switch (ev.t) {
    case 'death': {
      const v = view.views.get(ev.id);
      if (v) view.play(v, 'death', true);
      const e = S.ents.get(ev.id);
      ui.log(`${e?.name || 'a unit'} was slain`, 'kill');
      break;
    }
    case 'respawn': { const v = view.views.get(ev.id); if (v) view.play(v, 'stand'); break; }
    case 'levelup': {
      if (ev.id === S.hero?.id) ui.log(`Level ${ev.lvl}!`, 'lvl');
      const v = view.views.get(ev.id);
      if (v) spawnRing(v.root.position, 0xffdd66, 160);
      break;
    }
    case 'attack': {
      const v = view.views.get(ev.id);
      if (v) view.play(v, 'attack', true);
      break;
    }
    case 'cast': {
      const v = view.views.get(ev.id);
      // the ability's own Animnames if it has one, else the generic cast clip
      if (v) view.play(v, ev.anim || 'spell', true);
      if (ev.x != null) spawnRing(new THREE.Vector3(toX(ev.x), view.heightAt(ev.x, ev.y) + 6, toZ(ev.y)), 0x88ccff, 120);
      break;
    }
    case 'camShake': view.setShake(ev.mag, ev.vel, ev.vert); break;
    case 'aoe': spawnRing(new THREE.Vector3(toX(ev.x), view.heightAt(ev.x, ev.y) + 6, toZ(ev.y)), 0xff8844, ev.r); break;
    case 'blinkIn': case 'blinkOut':
      spawnRing(new THREE.Vector3(toX(ev.x), view.heightAt(ev.x, ev.y) + 6, toZ(ev.y)), 0xaa66ff, 110); break;
    case 'boss': ui.log('BOSS MULDER HAS FALLEN', 'kill'); break;
    case 'text': if (ev.s) ui.log(String(ev.s).replace(/\|c........|\|r/g, ''), 'lvl'); break;
    case 'teleport': { const v = view.views.get(ev.id);
      if (v) spawnRing(new THREE.Vector3(toX(ev.x), view.heightAt(ev.x, ev.y) + 6, toZ(ev.y)), 0x66ddff, 130);
      break; }
    case 'gameover': ui.gameOver(ev.winner, ev.board); break;
    case 'dmg': if (ev.id === S.hero?.id && ev.amt > 0) flash(); break;
    // the map's script drives its own spell visuals through these
    case 'anim':     view.playUnitAnim(ev.id, ev.name); break;
    case 'animIdx':  view.playUnitAnimIndex(ev.id, ev.i); break;
    case 'sfx':      view.spawnEffect(ev, false); break;
    case 'sfxUnit':  view.spawnEffect(ev, true); break;
    case 'sfxEnd':   view.endEffect(ev.fx); break;
    // a weapon's shot, in flight; the server decides when it lands
    case 'missile':    view.spawnMissile(ev); break;
    case 'missileEnd': view.endMissile(ev.fx); break;
    case 'tint':     view.tintUnit(ev.id, ev.r, ev.g, ev.b, ev.a); break;
    case 'sound': {
      // the map's own PlaySoundBJ / PlaySoundAtPointBJ / PlaySoundOnUnitBJ
      let x = ev.x, y = ev.y;
      if (ev.id != null) { const e2 = S.ents.get(ev.id); if (e2) { x = e2.x; y = e2.y; } }
      audio.playWorld(ev.path, x, y, ev.vol ?? 1, ev.pitch ?? 1, listener());
      break;
    }
  }
}

// ------------------------------------------------------------------- visuals
const rings = [];
function spawnRing(pos, color, radius) {
  const g = new THREE.RingGeometry(radius * 0.2, radius, 32);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55,
    side: THREE.DoubleSide, depthWrite: false });
  const mesh = new THREE.Mesh(g, m);
  mesh.position.copy(pos);
  view.scene.add(mesh);
  rings.push({ mesh, t: 0, life: 0.55, r: radius });
}
function stepRings(dt) {
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i];
    r.t += dt;
    const k = r.t / r.life;
    r.mesh.material.opacity = 0.55 * (1 - k);
    r.mesh.scale.setScalar(0.6 + k * 0.8);
    if (k >= 1) { view.scene.remove(r.mesh); r.mesh.geometry.dispose(); r.mesh.material.dispose(); rings.splice(i, 1); }
  }
}
let flashT = 0;
function flash() { flashT = 0.25; }

// ---------------------------------------------------------------------- boot
async function boot(m) {
  const [terr, heightsBuf, doodads, unitModels, ubersplats,
         splatTable, spawnTable, animSounds] = await Promise.all([
    fetch('/data/terrain.json').then((r) => r.json()),
    fetch('/data/heights.bin').then((r) => r.arrayBuffer()),
    fetch('/data/doodads.json').then((r) => r.json()),
    fetch('/data/unitmodels.json').then((r) => r.json()),
    // the ground decals buildings are stamped on
    fetch('/data/ubersplats.json').then((r) => r.json()).catch(() => ({})),
    // the event-object tables: splats and footprints, thrown models, sounds
    fetch('/data/splats.json').then((r) => r.json()).catch(() => ({})),
    fetch('/data/spawns.json').then((r) => r.json()).catch(() => ({})),
    fetch('/data/animsounds.json').then((r) => r.json()).catch(() => ({})),
  ]);
  const doodadMeta = await fetch('/data/doodadmeta.json').then((r) => r.json()).catch(() => ({}));
  // baked cliff mesh; a map with no cliffs simply has no cliffs.json
  const cliffs = await (async () => {
    try {
      const spec = await fetch('/data/cliffs.json').then((r) => (r.ok ? r.json() : null));
      if (!spec || !spec.groups || !spec.groups.length) return null;
      spec.data = new Float32Array(await fetch('/data/cliffs.bin').then((r) => r.arrayBuffer()));
      return spec;
    } catch { return null; }
  })();
  S.unitModels = unitModels;
  // the ground-decal table, keyed by the id a unit's uberSplat names
  view.splats = ubersplats;
  view.splatTable = splatTable;
  view.spawnTable = spawnTable;
  view.animSounds = animSounds;
  // Sound events resolve to a *label* ("TestFootstep", "MetalHeavyBashFlesh"),
  // and turning a label into a file needs the UI\SoundInfo tables, which are
  // not compiled yet. The visual half of the event system is wired; this hook
  // stays unset until that lookup exists, rather than calling into nothing.
  ui.setLoading('building arena…', 0.6);
  await view.buildTerrain(terr, new Float32Array(heightsBuf), cliffs);
  await view.addDoodads(doodads, doodadMeta);
  const img = new Image();
  img.src = '/assets/textures/war3mapMap.png';
  img.onload = () => { S.minimapImg = img; };
  // every unit, including taverns and shops, now comes from the map script
  ui.setLoading('ready', 1);
  const c = m.game.meta.startLoc.pick;
  view.focus(c[0], c[1], true);
}

// --------------------------------------------------------------------- input
const canvas = document.getElementById('view');
const KEY_SLOT = { q: 0, w: 1, e: 2, r: 3, d: 4, f: 5 };

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
  if (S.phase !== Phase.PLAYING) return;
  const nx = (e.clientX / innerWidth) * 2 - 1;
  const ny = -(e.clientY / innerHeight) * 2 + 1;
  if (e.button === 0) {
    if (S.castPending != null) {
      const g = view.pickGround(nx, ny);
      const t = view.pickEntity(nx, ny);
      const ab = S.hero?.abilities?.[S.castPending];
      const tid = t && t.id !== S.hero?.id ? t.id : undefined;
      if (ab?.targetMode === 'unit' && tid == null) {
        ui.log(`${ab.name} needs a target`, 'lvl');
        return;                                   // stay armed, let them click a unit
      }
      if (g) net.send({ t: Msg.CAST, slot: S.castPending, x: g.x, y: g.y, targetId: tid });
      S.castPending = null;
      canvas.style.cursor = 'default';
      return;
    }
    const g = view.pickGround(nx, ny);
    if (g) { net.send({ t: Msg.MOVE, x: g.x, y: g.y }); markMove(g); }
  } else if (e.button === 2) {
    // Warcraft III's smart order: an item under the cursor beats anything else,
    // and the hero walks to it rather than teleporting it into a slot
    const gi = view.pickItem(nx, ny);
    if (gi) { net.send({ t: 'pickup', itemId: gi.id }); markMove({ x: gi.x, y: gi.y }); return; }
    const t = view.pickEntity(nx, ny);
    const me = S.ents.get(S.hero?.id);
    if (t && t.id !== S.hero?.id && S.ents.get(t.id)?.t !== me?.t) {
      net.send({ t: Msg.ATTACK, targetId: t.id });
    } else {
      const g = view.pickGround(nx, ny);
      if (g) { net.send({ t: Msg.MOVE, x: g.x, y: g.y, attack: true }); markMove(g); }
    }
  }
});
function markMove(g) {
  spawnRing(new THREE.Vector3(toX(g.x), view.heightAt(g.x, g.y) + 4, toZ(g.y)), 0x66ff99, 70);
}

canvas.addEventListener('wheel', (e) => {
  view.camDist = Math.max(700, Math.min(4200, view.camDist * (1 + Math.sign(e.deltaY) * 0.1)));
}, { passive: true });

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (document.activeElement?.tagName === 'INPUT') return;
  if (S.phase !== Phase.PLAYING) return;
  if (k in KEY_SLOT) {
    const slot = KEY_SLOT[k];
    const a = S.hero?.abilities?.[slot];
    if (!a || a.lvl < 1) return;
    if (e.shiftKey) { net.send({ t: Msg.LEARN, slot }); return; }
    // What a spell needs pointed at it comes from the map's own trigger, not
    // from a guess about the ability's flavour: firing a unit-target spell with
    // no target made its blink read a null location and jump to the map centre.
    if (a.targetMode === 'none') net.send({ t: Msg.CAST, slot });
    else {
      S.castPending = slot;
      canvas.style.cursor = 'crosshair';
      if (a.targetMode === 'unit') ui.log(`${a.name}: click a target`, 'lvl');
    }
  } else if (k === 's') net.send({ t: Msg.STOP });
  else if (k === 'b') ui.showShop(S.game.shops, S.hero);
  else if (k === 'escape') { S.castPending = null; canvas.style.cursor = 'default'; }
  else if (k === ' ') { const me = S.ents.get(S.hero?.id); if (me) view.focus(me.x, me.y, true); }
  else if (e.key === 'Tab') { e.preventDefault(); S.showScore = true; ui.toggleScore(true); }
});
addEventListener('keyup', (e) => {
  if (e.key === 'Tab') { S.showScore = false; ui.toggleScore(false); }
});
ui.onCastSlot = (slot) => {
  const a = S.hero?.abilities?.[slot];
  if (!a || a.lvl < 1) return;
  S.castPending = slot; canvas.style.cursor = 'crosshair';
};

// edge / drag panning
let dragging = false, lastX = 0, lastY = 0, followHero = true;
canvas.addEventListener('mousedown', (e) => { if (e.button === 1) { dragging = true; lastX = e.clientX; lastY = e.clientY; } });
addEventListener('mouseup', () => { dragging = false; });
addEventListener('mousemove', (e) => {
  if (!dragging) return;
  followHero = false;
  const k = view.camDist / 900;
  view.panBy(-(e.clientX - lastX) * k, -(e.clientY - lastY) * k);
  lastX = e.clientX; lastY = e.clientY;
});
addEventListener('dblclick', () => { followHero = true; });

// lobby buttons
document.getElementById('btnTeam0').onclick = () => net.send({ t: Msg.JOIN_TEAM, team: 0 });
document.getElementById('btnTeam1').onclick = () => net.send({ t: Msg.JOIN_TEAM, team: 1 });
// Language toggle: both languages ship in game.json, so this only re-renders.
const btnLang = document.getElementById('btnLang');
function syncLang() {
  btnLang.textContent = Lang.en ? 'EN' : '\uD55C';
  // both languages are already in the hero data, so this is only a re-render
  if (S.game) ui.showLobby(S.game, S.heroes || S.game.heroes || []);
  if (S.hero) ui.renderAbilities(S.hero);
}
btnLang.onclick = () => { Lang.set(!Lang.en); syncLang(); };
syncLang();

document.getElementById('btnReady').onclick = () => {
  if (!ui.selected) { document.getElementById('lobbyMsg').textContent = 'pick a character first'; return; }
  S.ready = !S.ready;
  net.send({ t: Msg.READY, ready: S.ready });
  document.getElementById('btnReady').textContent = S.ready ? 'Not ready' : 'Ready';
};

// ------------------------------------------------------------------ main loop
function frame() {
  const dt = view.render();
  stepRings(dt);
  // interpolate entity views toward server state
  const alpha = Math.min(1, (performance.now() - S.lastSnap) / 1000 / S.snapDt);
  for (const [id, e] of S.ents) {
    const v = view.views.get(id);
    if (!v) continue;
    const p = S.prev.get(id) || e;
    const x = p.x + (e.x - p.x) * alpha;
    const y = p.y + (e.y - p.y) * alpha;
    v.root.position.set(toX(x), view.heightAt(x, y), toZ(y));
    let df = e.f - v.root.rotation.y;
    while (df > Math.PI) df -= Math.PI * 2;
    while (df < -Math.PI) df += Math.PI * 2;
    v.root.rotation.y += df * Math.min(1, dt * 12);
    // A corpse is not invisible. Warcraft III plays the death animation, decays
    // the flesh and leaves bones behind; hiding the unit the instant it died
    // meant a spider vanished mid-animation and nothing was ever left on the
    // ground. The server now keeps the body for its real decay time and removes
    // it when that runs out, which is what takes the view with it.
    v.root.visible = true;
    if (!v.loading && v.mixer) {
      const moving = Math.hypot(e.x - p.x, e.y - p.y) > 1.2;
      // A corpse ages through three sequences in order -- Death, then Decay
      // Flesh, then Decay Bone -- each starting when the one before it has run
      // out. A model missing one of them simply holds the pose it is in, which
      // pickClip returns null for rather than standing the body back up.
      const done = v.currentAction && !v.currentAction.isRunning();
      let want;
      if (e.a !== 0) want = moving ? 'walk' : 'stand';
      else if (v.stateName === 'death') want = done ? 'decay flesh' : 'death';
      else if (v.stateName === 'decay flesh') want = done ? 'decay bone' : 'decay flesh';
      else if (v.stateName === 'decay bone') want = 'decay bone';
      else want = 'death';
      // Death plays once and holds the final pose. Looping it makes a corpse
      // roll over, snap upright and roll again -- Warcraft III death sequences
      // carry the body a long way (a spider's spans 170 units vertically), so a
      // looped one reads as a live unit tipping over and righting itself.
      const once = want === 'death' || want.startsWith('decay');
      // A state is now a Warcraft III token set -- an ability asks for
      // "spell,slam" rather than "spell" -- so a one-shot cast or attack has to
      // be recognised by its tokens, not by string equality, or walking would
      // cut every such cast off on the next frame.
      const busy = /(^|,|\s)(attack|spell)(,|\s|$)/.test(v.stateName || '');
      if (!busy && v.stateName !== want) view.play(v, want, once);
      else if (busy && v.currentAction && !v.currentAction.isRunning()) view.play(v, want, once);
    }
  }
  const me = S.ents.get(S.hero?.id);
  if (me && followHero) view.focus(me.x, me.y);
  if (S.bounds) view.clampCam(S.bounds);
  if (S.phase === Phase.PLAYING && S.bounds)
    ui.drawMinimap(S.bounds, [...S.ents.values()], S.hero?.id, S.minimapImg);
  if (flashT > 0) { flashT -= dt; document.body.style.boxShadow = `inset 0 0 200px rgba(200,30,30,${flashT * 1.4})`; }
  else document.body.style.boxShadow = '';
  requestAnimationFrame(frame);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const savedName = localStorage.getItem('focs.name') || `Player${Math.floor(Math.random() * 900 + 100)}`;
document.getElementById('pname').value = savedName;
document.getElementById('pname').onchange = (e) => localStorage.setItem('focs.name', e.target.value);
addEventListener('pointerdown', () => audio.init(), { once: true });
addEventListener('keydown', () => audio.init(), { once: true });
// A handle for the tooling. A WebGL canvas screenshots blank unless
// preserveDrawingBuffer is set, so the only honest way for tools/shot.mjs to
// tell "the scene built" from "the scene is empty" is to count what is in it.
window.FOC = { view, S, ui, net };

ui.setLoading('connecting…', 0.1);
net.connect(savedName);
frame();
