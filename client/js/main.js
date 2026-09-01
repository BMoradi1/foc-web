import * as THREE from 'three';
import { Net } from './net.js';
import { Renderer, toX, toZ } from './render.js';
import { UI, Lang } from './ui.js';
import { HeroPreview } from './heroview.js';
import { Overlay } from './overlay.js';
import { buildConsole, buildTopBar, placeIn } from './console.js';
import { Audio } from './audio.js';
import { Msg, Phase, Ent, DEST_ID } from '/shared/const.js';

const net = new Net();
const ui = new UI(net);
const view = new Renderer(document.getElementById('view'));
const overlay = new Overlay(document.getElementById('overlay'));
const audio = new Audio();
// The hero turning in the character-select pane. Built lazily on the first pick
// so a player who never opens the lobby never pays for a second WebGL context.
let heroPreview = null;
// the top strip's resource readouts, built once the console layout arrives
let topBar = null;
let consoleSlots = null;
// The engine's own floating text -- bounty, miss, crit -- is made here rather
// than by the map's script, so it needs ids of its own that cannot collide with
// the engine's numeric text tag handles.
let bountySeq = 0;

/**
 * One of the engine's own text tags, over a point in the world.
 *
 * Shown only to the player the event names, which for all three of these is the
 * player who acted: it is feedback on your own kill, your own swing. The height
 * is the default text tag size of 10 through Blizzard.j's TextTagSize2Height --
 * MiscData.txt carries every other figure but not a size.
 */
function combatText(ev, text) {
  if (ev.player !== S.slot || !text) return;
  const t = ev.tag || {};
  overlay.tags.set({ tt: `fx:${bountySeq++}`, s: text,
                     x: ev.x, y: ev.y, z: 60, h: 10 * 0.023 / 10,
                     c: t.color, vx: t.vx, vy: t.vy,
                     life: t.life, fade: t.fade,
                     age: 0, perm: false, vis: true });
}
ui.onHeroShown = (h) => {
  const cv = document.getElementById('heroSpin');
  if (!cv) return;
  if (!heroPreview) heroPreview = new HeroPreview(cv, 280);
  heroPreview.show(h, (S.unitModels || {})[h.id]).catch(() => {});
};
ui.onLobbyClosed = () => { if (heroPreview) heroPreview.clear(); };

const S = {
  you: null, phase: Phase.LOBBY, game: null, heroes: [], hero: null,
  ents: new Map(),           // id -> latest server state
  prev: new Map(),           // id -> previous state (for interpolation)
  lastSnap: 0, snapDt: 1 / 15,
  selected: null, bounds: null, ready: false, showScore: false,
  castPending: null, itemPending: null, minimapImg: null, debug: false,
  hoverId: null, altHeld: false,
  unitModels: null,          // also feeds the lobby's rotating hero preview
};

// ------------------------------------------------------------------ networking
net.on(Msg.WELCOME, (m) => {
  S.you = m.you; net.you = m.you;
  S.game = m.game; S.heroes = m.heroes; S.bounds = m.game.bounds;
  // The server decides whether the debugging keys exist at all; the client only
  // binds what it was told about, so nothing here can reach a deployed build.
  S.debug = !!m.debug;
  ui.setBuild(m.build, S.debug, m.game?.meta?.name);
  if (S.debug) {
    const hint = document.getElementById('hint');
    if (hint) hint.textContent += ' \u00b7 L max level';
  }
  ui.setLoading('loading terrain…', 0.35);
  boot(m).then(() => {
    ui.hideLoading();
    // The room does not wait for anyone's download, so the match can start
    // while the terrain is still loading. This continuation used to put the
    // lobby back up over a running game and nothing took it down again: the
    // server sends STATE when the phase changes, and it already had.
    if (S.phase === Phase.PLAYING) { ui.startGame(); refitConsole(); }
    else ui.showLobby(m.game, m.heroes);
  }).catch((err) => {
    // One 404 on terrain.json or heights.bin used to leave the player watching
    // "loading terrain..." with nothing said and nothing to do.
    console.error('boot failed', err);
    ui.setLoading(`could not load the map: ${err && err.message || err}`, 1);
  });
});

net.on(Msg.STATE, (m) => {
  const was = S.phase;
  S.phase = m.phase;
  // the map's own slot for this client, which is what server-side events name
  S.slot = m.players.find((x) => x.id === S.you)?.slot ?? null;
  ui.renderTeams(m.players, S.you, m.phase);
  ui.updateScore(m.board, m.killsToWin);
  // a gate broken before this client joined, or before it reconnected: the
  // events only carry a change, so the state carries what has already happened
  if (m.dests && S.dests) {
    for (const d of m.dests) {
      const g = S.dests.get(d.d);
      if (!g) continue;
      g.hp = d.hp; g.max = d.max;
      if (d.dead && !g.dead) { g.dead = true; view.setDoodadDead(d.d); }
    }
  }
  if (m.phase === Phase.PLAYING) ui.startGame();
  if (m.phase === Phase.LOBBY && S.game) ui.showLobby(S.game, S.heroes);
  // Second matches in one room are real now that the room lifecycle is fixed,
  // so the state a match leaves behind has to be cleared on the way out of it:
  // the server drops everyone's ready flag in reset() and the client has to
  // agree, and a half-aimed spell must not survive into the lobby.
  if (m.phase !== was) {
    S.castPending = null; S.itemPending = null;
    canvas.style.cursor = 'default';
    // The console's two canvases can only be measured once the HUD is on
    // screen: the fit at load time runs while #hud is still hidden, where
    // every box is zero and fitMinimap declines to size a canvas from it.
    if (m.phase === Phase.PLAYING) refitConsole();
    if (m.phase === Phase.LOBBY) {
      S.ready = false;
      // the map's permanent labels belong to the world that just ended; the
      // next match makes its own, and the server replays them on the way in
      overlay.tags.clear();
      document.getElementById('btnReady').textContent = 'Ready';
    }
  }
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
    // the models the unit's buffs hang on it; a no-op unless the set changed
    if (e.b || old?.b) view.syncBuffArt(e.i, e.b, S.buffArt);
  }
  for (const id of [...S.ents.keys()]) {
    if (seen.has(id)) continue;
    S.ents.delete(id); S.prev.delete(id); view.removeView(id);
  }
  view.syncItems(m.s.items, S.game?.items);
  // (static views use negative ids and are never tracked in S.ents, so they persist)
  if (m.s.board) ui.updateScore(m.s.board, 100);
  ui.updateClock(m.s.clock);
});

net.on('hero', (m) => {
  const changed = S.hero?.unitId !== m.h.unitId;
  S.hero = m.h;
  // before the card is drawn: the labels read the keys this assigns
  KEY_SLOT = resolveHotkeys(m.h.abilities);
  if (topBar) {
    // Warcraft III shows all three whatever the map uses. This one spends gold
    // and lumber and never touches food, so supply reads what the engine
    // reports for it, which is nothing -- the same as the game would show.
    topBar.res.get('gold')?.replaceChildren(String(m.h.gold ?? 0));
    topBar.res.get('lumber')?.replaceChildren(String(m.h.lumber ?? 0));
    topBar.res.get('supply')?.replaceChildren('0');
  }
  ui.updateHero(m.h);
  // The console is built during boot, before any hero exists, so the portrait
  // has to be asked for again once there is one -- and again when the unit type
  // underneath it changes, which a metamorphosis does.
  if (changed) showUnitPortrait();
});

net.on(Msg.EVENT, (m) => {
  for (const ev of m.ev) handleEvent(ev);
});

net.on(Msg.CHATMSG, (m) => ui.log(`<b>${escapeHtml(m.from)}:</b> ${escapeHtml(m.text)}`));
net.on(Msg.ERROR, (m) => ui.log(m.m, 'kill'));
net.on('closed', () => {
  ui.log('disconnected from server', 'kill');
  ui.showDisconnected();
});

/**
 * "Our hero has fallen!"
 *
 * Warcraft III says this itself when a hero dies -- no map script is involved,
 * which is why nothing in war3map.j mentions it and it had never been ported.
 * UISounds.slk carries a row per race for your own hero and another for an
 * ally's, and the voice is the *listening* player's race rather than the dead
 * hero's, because it is your own advisor speaking. Which is also why the
 * decision is made here and not on the server: every client hears a different
 * answer, and some hear nothing.
 *
 * There is deliberately no enemy row in the table. Warcraft III is silent when
 * the other side loses a hero, and so is this.
 */
function heroDownWarning(e) {
  if (!e || e.k !== 1) return;                     // k=1 is a hero
  const table = S.uiSounds;
  if (!table) return;
  const mine = S.hero?.id;
  const myTeam = mine != null ? S.ents.get(mine)?.t : null;
  const prefix = e.i === mine ? 'HeroDies'
               : (myTeam != null && e.t === myTeam) ? 'AllyHeroDies'
               : null;
  if (!prefix) return;
  // matched against the table's own row names rather than a list of races
  // written out here, so the data stays the thing that decides
  const want = (prefix + (S.hero?.race || '')).toLowerCase();
  const key = Object.keys(table).find((k) => k.toLowerCase() === want);
  // HeroDiesGeneric is the only fallback Warcraft III ships; a race with no row
  // of its own gets it.
  const row = table[key] || table.HeroDiesGeneric;
  if (!row?.files?.length) return;
  // bare path: audio.load prefixes /assets/ itself, as it does for every sound
  // the map's own script plays
  audio.playUI(row.files[Math.floor(Math.random() * row.files.length)],
               row.vol ?? 1, row.flags);
}

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
                  sh: t.sh, sw: t.sw, shh: t.shh, sx: t.sx, sy: t.sy, us: t.us, an: t.an,
                  // the selection circle's own scale and height off the ground
                  ss: t.ss, sz: t.sz };
  return {};
}

function handleEvent(ev) {
  switch (ev.t) {
    case 'death': {
      const v = view.views.get(ev.id);
      if (v) view.play(v, 'death', true);
      const e = S.ents.get(ev.id);
      ui.log(`${escapeHtml(e?.name || 'a unit')} was slain`, 'kill');
      heroDownWarning(e);
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
    case 'terrainDeform': view.deformTerrain(ev); break;
    // floating text: sent once, finished, and aged out by the overlay
    case 'texttag': overlay.tags.set(ev); break;
    case 'texttagEnd': overlay.tags.remove(ev.tt); break;
    // The engine's own bounty text: the gold a kill just paid, floated over the
    // body. Warcraft III shows it to the killing player alone, so it is dropped
    // unless this client did the killing.
    //
    // Nothing here is chosen. The colour, drift, lifetime and fade all ride in
    // on the event from UI/MiscData.txt's BountyText block; the height is the
    // one figure that file does not carry, and it is the default text tag size
    // of 10 put through Blizzard.j's own TextTagSize2Height.
    case 'bounty': combatText(ev, `+${ev.gold}`); break;
    // The engine's own combat text. The server already found the miss and the
    // crit -- both were emitted and dropped on the floor here -- so all that
    // was missing is the number. Their colour, drift, lifetime and fade come
    // from UI/MiscData.txt and the word "miss" from GlobalStrings.fdf, so
    // nothing about how they look is chosen here.
    case 'miss': combatText(ev, ev.tag?.text || 'miss'); break;
    case 'crit': combatText(ev, String(ev.n)); break;
    // the engine draws these itself rather than playing a model
    case 'lightning': view.spawnBolt(ev); break;
    case 'aoe': spawnRing(new THREE.Vector3(toX(ev.x), view.heightAt(ev.x, ev.y) + 6, toZ(ev.y)), 0xff8844, ev.r); break;
    case 'blinkIn': case 'blinkOut':
      spawnRing(new THREE.Vector3(toX(ev.x), view.heightAt(ev.x, ev.y) + 6, toZ(ev.y)), 0xaa66ff, 110); break;
    case 'boss': ui.log('BOSS MULDER HAS FALLEN', 'kill'); break;
    // the script's DisplayText often embeds GetPlayerName -- player-typed
    case 'text': if (ev.s) ui.log(escapeHtml(String(ev.s).replace(/\|c........|\|r/g, '')), 'lvl'); break;
    case 'teleport': { const v = view.views.get(ev.id);
      if (v) spawnRing(new THREE.Vector3(toX(ev.x), view.heightAt(ev.x, ev.y) + 6, toZ(ev.y)), 0x66ddff, 130);
      break; }
    case 'gameover': ui.gameOver(ev.winner, ev.board); break;
    case 'dmg': if (ev.id === S.hero?.id && ev.amt > 0) flash(); break;
    case 'destDmg': {
      const g = S.dests?.get(ev.d);
      if (g) { g.hp = ev.hp; g.max = ev.max; }
      // the doors shudder: the gate models carry their own Stand Hit clip
      if (g && !g.dead) view.playDoodadClip(ev.d, 'stand hit');
      break;
    }
    case 'destDead': {
      const g = S.dests?.get(ev.d);
      if (g) { g.dead = true; g.hp = 0; }
      // the wreckage is already in the model, hidden until now by the stand
      // sequence's geoset-alpha track; the death clip is what drops it
      view.setDoodadDead(ev.d);
      view.playDoodadClip(ev.d, 'death', { hold: true });
      if (g && S.destPick?.has(ev.d)) ui.log('a gate has been broken open', 'kill');
      break;
    }
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
  const [terr, heightsBuf, doodads, dests, unitModels, ubersplats,
         splatTable, spawnTable, animSounds, boltTable, uiSounds, buffArt] = await Promise.all([
    fetch('/data/terrain.json').then((r) => r.json()),
    fetch('/data/heights.bin').then((r) => r.arrayBuffer()),
    fetch('/data/doodads.json').then((r) => r.json()),
    // the destructables among them: which can be clicked, and what they cost
    // to break. Static, so it is read here rather than sent per match; only
    // what has actually been damaged comes over the wire.
    fetch('/data/destructables.json').then((r) => r.json()).catch(() => []),
    fetch('/data/unitmodels.json').then((r) => r.json()),
    // the ground decals buildings are stamped on
    fetch('/data/ubersplats.json').then((r) => r.json()).catch(() => ({})),
    // the event-object tables: splats and footprints, thrown models, sounds
    fetch('/data/splats.json').then((r) => r.json()).catch(() => ({})),
    fetch('/data/spawns.json').then((r) => r.json()).catch(() => ({})),
    fetch('/data/animsounds.json').then((r) => r.json()).catch(() => ({})),
    fetch('/data/lightning.json').then((r) => r.json()).catch(() => ({})),
    // Warcraft III's own warnings, off UISounds.slk -- the hero-death line
    fetch('/data/uisounds.json').then((r) => r.json()).catch(() => ({})),
    // the model a buff hangs on a unit, and the point it hangs from
    fetch('/data/buffart.json').then((r) => r.json()).catch(() => ({})),
  ]);
  S.uiSounds = uiSounds;
  S.buffArt = buffArt;
  // Warcraft III's console frame, from its own ConsoleUI.fdf, with our panels
  // moved into the openings the art leaves for them.
  fetch('/data/console.json').then((r) => r.json()).then((spec) => {
    const slots = buildConsole(spec, document.getElementById('console'));
    consoleSlots = slots;          // the tooling measures the card from these
    // How much of the screen the frame eats, taken from the pieces themselves
    // rather than written down here: the tallest BOTTOM-anchored tile is the
    // console's height (0.2933 for this layout). The camera needs it to aim at
    // the middle of what the player can see instead of the middle of the window.
    view.setConsoleFraction(Math.max(0, ...(spec.console || [])
      .filter((p) => String(p.a || '').startsWith('BOTTOM'))
      .map((p) => p.h || 0)));
    // The top strip's contents: the resource readout and the menu buttons.
    // Quests and Menu are drawn from the layout's own disabled art -- the
    // engine's QuestSetTitle/QuestSetDescription are no-ops, so there is no
    // quest text to show, and a button that silently does nothing is worse
    // than one the game itself would grey out.
    topBar = buildTopBar(spec, document.getElementById('uitop'), {
      enabled: (k) => k === 'allies' || k === 'chat',
      onButton: (k) => {
        if (k === 'allies') { S.showScore = !S.showScore; ui.toggleScore(S.showScore); }
        else if (k === 'chat') ui.log('Chat: type in the box below the log', 'lvl');
      },
    });
    placeIn(document.getElementById('minimap'), slots.minimap);
    placeIn(document.getElementById('portrait'), slots.info);
    placeIn(document.getElementById('unitPortrait'), slots.portrait);
    // The card is four across and three down, which is twelve: the six
    // abilities fill it the way Warcraft III fills one, row by row, and the six
    // inventory slots take the rest.
    ui.cardCells = slots.cells;
    ui.invCells = slots.inv;
    ui.placeCard();
    // The minimap is sized by the art now, so its drawing buffer has to follow
    // or a 200x300 map is squashed into a landscape opening. This is the fit
    // for art that arrives mid-match; the first one happens when the HUD is
    // shown, since nothing here has a size while it is hidden.
    ui.fitMinimap();
    showUnitPortrait();
    // the console says what the controls are; the crib sheet was for before it
    const hint = document.getElementById('hint');
    if (hint && slots.cells.length) hint.style.display = 'none';
  }).catch(() => {});
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
  view.boltTable = boltTable;
  /**
   * A sound event fired: a foot landed, a blade bit, a body hit the ground.
   *
   * The table gives several takes for a sound that repeats -- a footstep has
   * four -- so one is drawn each time rather than the same clip looping, and
   * the pitch wanders by the variance the sound itself declares. Volume and the
   * three distances are the game's own numbers, which is what keeps a crowded
   * fight legible without inventing a limit.
   */
  view.onAnimSound = (rec, x, y) => {
    if (!rec || !rec.f || !rec.f.length) return;
    const file = rec.f[(Math.random() * rec.f.length) | 0];
    const pitch = (rec.pitch || 1) + (Math.random() * 2 - 1) * (rec.pitchVar || 0);
    audio.playWorld(file, x, y, rec.vol ?? 1, Math.max(0.1, pitch), listener(),
                    { min: rec.min, max: rec.max, cutoff: rec.cutoff });
  };
  ui.setLoading('building arena…', 0.6);
  await view.buildTerrain(terr, new Float32Array(heightsBuf), cliffs);
  // only DestructableData's selectable flag may be clicked: that is the six
  // gates, and not the walls, the trees or the pathing blockers
  S.dests = new Map();
  S.destPick = new Set();
  for (const d of dests || []) {
    S.dests.set(d.d, { type: d.id, x: d.x, y: d.y, hp: d.hp, max: d.hp, dead: false });
    if (d.sel) S.destPick.add(d.d);
  }
  // the same six get an animation mixer, so a struck gate can shudder
  await view.addDoodads(doodads, doodadMeta, S.destPick);
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

// Where the fixed Q/W/E/R/D/F row used to be.
//
// The map assigns each ability its own key in war3map.w3a ('ahky') and 109 of
// the 130 hero abilities declare one -- including T, B, V and C, which that row
// could not produce, while D and F are declared by no ability at all. So on most
// heroes the letter printed on the button and the key that actually cast were
// different keys.
//
// Resolved once, here, and written back onto the ability as `key`: the command
// card labels from the same field the keydown handler binds, so the two cannot
// drift apart again. Nothing is invented -- a slot the map leaves blank (16 of
// them, 3 innate) falls back to its position, and only to a letter no declared
// hotkey on that hero has already taken. Three heroes need that guard.
const POS_KEYS = ['q', 'w', 'e', 'r', 'd', 'f'];

function resolveHotkeys(abilities) {
  const taken = new Set();
  for (const a of abilities || []) {
    const k = String(a.hotkey || '').trim().toLowerCase();
    a.key = k && !taken.has(k) ? k : '';
    if (a.key) taken.add(a.key);
  }
  (abilities || []).forEach((a, i) => {
    if (a.key) return;
    const pref = [POS_KEYS[i], ...POS_KEYS].find((k) => k && !taken.has(k));
    if (pref) { a.key = pref; taken.add(pref); }
  });
  const map = {};
  (abilities || []).forEach((a, i) => { if (a.key) map[a.key] = i; });
  return map;
}

let KEY_SLOT = {};

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
  if (S.phase !== Phase.PLAYING) return;
  const nx = (e.clientX / innerWidth) * 2 - 1;
  const ny = -(e.clientY / innerHeight) * 2 + 1;
  if (e.button === 0) {
    // an item aimed at a unit: the Monster Ball is thrown at a creep
    if (S.itemPending != null) {
      const t = view.pickEntity(nx, ny);
      if (t && t.id !== S.hero?.id) {
        net.send({ t: 'useItem', slot: S.itemPending, targetId: t.id });
        S.itemPending = null;
        canvas.style.cursor = 'default';
      }
      return;                                    // stay armed until something is hit
    }
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
    // Warcraft III selects a shop by clicking it, and the bottom bar becomes
    // the shop. Clicking anywhere else hands the console back to the hero.
    const picked = view.pickEntity(nx, ny);
    const shop = shopFor(picked);
    if (shop) {
      ui.selectShop(S.ents.get(picked.id) || picked, shop);
      showUnitPortrait();
      return;
    }
    if (ui.shopSel) { ui.clearShop(); showUnitPortrait(); }
    const g = view.pickGround(nx, ny);
    if (g) { net.send({ t: Msg.MOVE, x: g.x, y: g.y }); markMove(g); }
  } else if (e.button === 2) {
    // Warcraft III's smart order: an item under the cursor beats anything else,
    // and the hero walks to it rather than teleporting it into a slot
    const gi = view.pickItem(nx, ny);
    if (gi) { net.send({ t: 'pickup', itemId: gi.id }); markMove({ x: gi.x, y: gi.y }); return; }
    const t = view.pickEntity(nx, ny);
    const me = S.ents.get(S.hero?.id);
    const te = t ? S.ents.get(t.id) : null;
    // Right-clicking a shop walks to it, as Warcraft III does -- you approach a
    // shop to trade with it. It used to send an attack, because this compared
    // TEAMS and a shop sits on player 15's team 2 while the heroes are on 0 and
    // 1. The server refused the order (world.hostile is false for neutral
    // passive, so nothing was ever damaged) but the hero still ran at the
    // building as though it meant to swing.
    if (te && te.p === NEUTRAL_PASSIVE) {
      net.send({ t: Msg.MOVE, x: te.x, y: te.y });
      markMove({ x: te.x, y: te.y });
      return;
    }
    if (t && t.id !== S.hero?.id && te?.t !== me?.t) {
      net.send({ t: Msg.ATTACK, targetId: t.id });
    } else if (pickGate(nx, ny) != null) {
      const di = pickGate(nx, ny);
      net.send({ t: Msg.ATTACK, targetId: DEST_ID + di });
      const g = S.dests.get(di);
      if (g) markMove(g);
    } else {
      const g = view.pickGround(nx, ny);
      if (g) { net.send({ t: Msg.MOVE, x: g.x, y: g.y, attack: true }); markMove(g); }
    }
  }
});
/** A gate under the cursor, if it is still standing. */
function pickGate(nx, ny) {
  if (!S.destPick || !S.destPick.size) return null;
  const i = view.pickDoodad(nx, ny, S.destPick);
  if (i == null) return null;
  return S.dests.get(i)?.dead ? null : i;
}

/**
 * The shops are the buildings inside each base -- five per side, mirrored:
 * n000 스텟 상점, n001 아이템 상점, n00H and n00N 전용템 상점, n013.
 * data/game.json keys its shop list by that unit type, so an entity is a shop
 * when its type id is one of them.
 */
const SHOP_BY_TYPE = new Map();
function shopFor(ent) {
  if (!ent) return null;
  if (!SHOP_BY_TYPE.size) for (const sh of (S.game?.shops || [])) SHOP_BY_TYPE.set(sh.id, sh);
  const e = S.ents.get(ent.id) || ent;
  return SHOP_BY_TYPE.get(e.u) || null;
}

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
  } else if (e.key === '\\') { const n = view.setSkinning(!!view.skinless);
    ui.log(`skinning ${view.skinless ? 'OFF (bind pose)' : 'on'} \u2014 ${n} skeletons`, 'lvl'); }
  else if (k === '[') { view.frozen = !view.frozen;
    ui.log(`animation ${view.frozen ? 'frozen' : 'running'}`, 'lvl'); }
  else if (k === ']') { view.noUnits = !view.noUnits;
    if (!view.noUnits) for (const v of view.views.values()) v.root.visible = true;
    ui.log(`units ${view.noUnits ? 'hidden' : 'shown'}`, 'lvl'); }
  else if (k === '`') { overlay.stats.on = !overlay.stats.on;
    ui.log(`frame stats ${overlay.stats.on ? 'on' : 'off'}`, 'lvl'); }
  else if (k === 'l' && S.debug) net.send({ t: 'debugLevel' });
  else if (k === 's') net.send({ t: Msg.STOP });
  else if (k === 'escape') {
    S.castPending = null; S.itemPending = null; canvas.style.cursor = 'default';
    if (ui.shopSel) { ui.clearShop(); showUnitPortrait(); }
  }
  else if (k === ' ') { const me = S.ents.get(S.hero?.id); if (me) view.focus(me.x, me.y, true); }
  else if (e.key === 'Tab') { e.preventDefault(); S.showScore = true; ui.toggleScore(true); }
});
addEventListener('keyup', (e) => {
  if (e.key === 'Tab') { S.showScore = false; ui.toggleScore(false); }
  if (e.key === 'Alt') S.altHeld = false;
});
// Warcraft III shows every visible unit's bar for as long as ALT is held
addEventListener('keydown', (e) => { if (e.key === 'Alt') S.altHeld = true; });
addEventListener('blur', () => { S.altHeld = false; });
ui.onCastSlot = (slot) => {
  const a = S.hero?.abilities?.[slot];
  if (!a || a.lvl < 1) return;
  S.castPending = slot; canvas.style.cursor = 'crosshair';
};

/**
 * What the cursor is over, and what a unit is to you.
 *
 * Warcraft III circles the unit under the pointer as well as the one you have
 * selected, and colours both by relationship rather than by the owner's colour:
 * green yours, yellow an ally, red an enemy.
 */
let mouseNX = 0, mouseNY = 0;
addEventListener('mousemove', (e) => {
  mouseNX = (e.clientX / innerWidth) * 2 - 1;
  mouseNY = -(e.clientY / innerHeight) * 2 + 1;
});
// Warcraft III's fixed neutral slots. Player 15 is Neutral Passive -- the
// shops, the taverns and the pick-area props -- and server/world.js refuses to
// make it hostile to anything. The client has to agree, or it paints a shop as
// an enemy and offers to attack it.
const NEUTRAL_PASSIVE = 15;

function relationTo(e) {
  if (!e) return null;
  if (e.i === S.hero?.id) return 'own';
  const me = S.ents.get(S.hero?.id);
  if (e.p != null && me && e.p === me.p) return 'own';
  if (e.p === NEUTRAL_PASSIVE) return 'neutral';
  if (e.t == null || !me || me.t == null) return 'neutral';
  return e.t === me.t ? 'ally' : 'enemy';
}

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
// What the frame costs outside the renderer. Four clock reads, always on, for
// the same reason the renderer keeps its own: a slow frame says nothing about
// which part of it is slow.
const framePerf = { interp: 0, ui: 0 };
function frame() {
  const dt = view.render();
  const tRender = performance.now();
  stepRings(dt);
  // the lobby's hero turns only while the lobby is up
  if (S.phase === Phase.LOBBY && heroPreview) heroPreview.step(dt);
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
  const tInterp = performance.now();
  const me = S.ents.get(S.hero?.id);
  if (me && followHero) view.focus(me.x, me.y);
  if (S.bounds) view.clampCam(S.bounds);
  if (S.phase === Phase.PLAYING) drawUnitUI();
  if (S.phase === Phase.PLAYING && unitPortrait) unitPortrait.step(dt);
  if (S.phase === Phase.PLAYING && S.bounds)
    ui.drawMinimap(S.bounds, [...S.ents.values()], S.hero?.id, S.minimapImg);
  if (flashT > 0) { flashT -= dt; document.body.style.boxShadow = `inset 0 0 200px rgba(200,30,30,${flashT * 1.4})`; }
  else document.body.style.boxShadow = '';
  const k = 0.1;
  framePerf.interp += (tInterp - tRender - framePerf.interp) * k;
  framePerf.ui += (performance.now() - tInterp - framePerf.ui) * k;
  if (view.perf) { view.perf.interp = framePerf.interp; view.perf.ui = framePerf.ui; }
  requestAnimationFrame(frame);
}

/**
 * The layer Warcraft III draws over the world: a circle under the unit you are
 * pointing at and under your own hero, and a health bar over each of them --
 * over everything, while ALT is held.
 */
/**
 * The console's own portrait: the hero, animated, in the arch.
 *
 * Built lazily and only once -- it owns a WebGL context, so rebuilding it per
 * hero would leak one every time. It does not turn: Warcraft III's console
 * portrait faces the player and idles, and only the lobby's spins.
 */
let unitPortrait = null;
function showUnitPortrait() {
  const cv = document.getElementById('unitPortrait');
  // While a shop is selected the arch shows the shop's building, as the game
  // does; S.unitModels carries every unit type's model, shops included.
  const sel = ui.shopSel;
  const h = sel ? { id: sel.shop.id, name: sel.shop.name }
          : (S.heroes?.find((x) => x.id === S.hero?.unitId)
             || S.heroes?.find((x) => x.id === ui.selected));
  if (!cv || !h) return;
  const box = cv.getBoundingClientRect();
  const size = { w: Math.max(48, Math.round(box.width) || 128),
                 h: Math.max(48, Math.round(box.height) || 128) };
  if (!unitPortrait) unitPortrait = new HeroPreview(cv, size, { spin: false, fill: 0.9, head: true });
  unitPortrait.show(h, (S.unitModels || {})[h.id]).catch(() => {});
}

const barsShown = new Set();
function drawUnitUI() {
  const hover = view.pickEntity(mouseNX, mouseNY);
  const hoverId = hover ? hover.id : null;
  if (hoverId !== S.hoverId) {
    if (S.hoverId != null && S.hoverId !== S.hero?.id) view.markSelected(S.hoverId, null);
    S.hoverId = hoverId ?? null;
  }
  // your own hero keeps its circle whatever the pointer is doing
  if (S.hero?.id != null) view.markSelected(S.hero.id, 'own', S.ents.get(S.hero.id));
  if (S.hoverId != null && S.hoverId !== S.hero?.id) {
    const e = S.ents.get(S.hoverId);
    view.markSelected(S.hoverId, relationTo(e), e);
  }
  barsShown.clear();
  if (S.altHeld) for (const id of S.ents.keys()) barsShown.add(id);
  else {
    if (S.hero?.id != null) barsShown.add(S.hero.id);
    if (S.hoverId != null) barsShown.add(S.hoverId);
  }
  overlay.draw(view, S.ents, barsShown);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const savedName = localStorage.getItem('focs.name') || `Player${Math.floor(Math.random() * 900 + 100)}`;
document.getElementById('pname').value = savedName;
document.getElementById('pname').onchange = (e) => localStorage.setItem('focs.name', e.target.value);
addEventListener('pointerdown', () => audio.init(), { once: true });
addEventListener('keydown', () => audio.init(), { once: true });
/**
 * The two canvases the console owns are sized in pixels once, when the art
 * first lands. Everything else in the frame is laid out in percentages and
 * rescales itself, so after a window resize those two -- and only those two --
 * are drawing at the old size into a box that is now a different shape.
 *
 * Coalesced onto a frame: a drag emits resize continuously, and reallocating
 * a drawing buffer per event is the expensive half of this.
 */
let refitQueued = false;
function refitConsole() {
  if (refitQueued) return;
  refitQueued = true;
  requestAnimationFrame(() => {
    refitQueued = false;
    ui.fitMinimap();
    const cv = document.getElementById('unitPortrait');
    if (unitPortrait && cv) {
      const box = cv.getBoundingClientRect();
      unitPortrait.setSize(Math.max(48, Math.round(box.width)),
                           Math.max(48, Math.round(box.height)));
    }
  });
}
addEventListener('resize', refitConsole);

// A handle for the tooling. A WebGL canvas screenshots blank unless
// preserveDrawingBuffer is set, so the only honest way for tools/shot.mjs to
// tell "the scene built" from "the scene is empty" is to count what is in it.
/** An item that is aimed rather than simply used arms the cursor. */
ui.onAimItem = (slot, it) => {
  S.castPending = null;
  S.itemPending = slot;
  canvas.style.cursor = 'crosshair';
  ui.log(`${escapeHtml(it.name || 'item')}: pick a target`, 'lvl');
};

window.FOC = { view, S, ui, net, overlay, audio, refitConsole, shopFor,
               showUnitPortrait, relationTo,
               get consoleSlots() { return consoleSlots; },
               get heroPreview() { return heroPreview; },
               get unitPortrait() { return unitPortrait; } };

ui.setLoading('connecting…', 0.1);
net.connect(savedName);
frame();
