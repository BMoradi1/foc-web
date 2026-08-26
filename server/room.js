// Lobby + match lifecycle. The map's own JASS script owns the game rules;
// this layer only relays player intent into it and streams state out.
import { World, TYPES, int2id, id2int } from './world.js';
import { JassEngine } from './jass/engine.js';
import { Phase, Msg, TICK_HZ, SNAP_HZ } from '../shared/const.js';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
export const GAME = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/game.json'), 'utf8'));
const HERO_BY_ID = new Map(GAME.heroes.map((h) => [h.id, h]));
// icons for whatever a hero can end up carrying
const ITEM_ICON = new Map(GAME.shops.flatMap((s) => s.items)
  .filter((i) => i.icon).map((i) => [i.id, i.icon]));

// playable slots and their teams, as the map's config() assigns them
const TEAMS = (GAME.meta.teams || []).filter((t) => t.id < 2);
const PLAYER_SLOTS = TEAMS.flatMap((t) => t.players).sort((a, b) => a - b);
function teamOfSlot(slot) {
  const t = TEAMS.find((x) => x.players.includes(slot));
  return t ? t.id : 0;
}

let nextPlayer = 1;

/**
 * How many ranks of an ability a hero of this level may hold.
 *
 * Warcraft III gates the skill tree on the ability's own fields: 'reqLevel'
 * unlocks rank 1 and 'levelSkip' is how many hero levels each further rank
 * costs.  This map uses them heavily -- InuYasha's ultimate wants level 30 and
 * five levels per rank -- so the old fixed "every other level, ultimate at 6"
 * rule locked most of the roster out of its own spells.
 */
/**
 * What each spell needs pointed at it, derived by casting every hero ability
 * once and recording which target accessor its trigger reads (tools/spell_targets.mjs).
 * The ability tables carry no such column, so this is the only faithful source.
 */
const SPELL_TARGETS = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../data/spell_targets.json', import.meta.url), 'utf8')); }
  catch { return {}; }
})();

export function learnCap(ab, heroLevel) {
  if (!ab) return 0;
  const maxLvl = ab.maxLvl || (ab.levels || []).length || 1;
  const req = ab.reqLevel || 0;
  const skip = ab.levelSkip || 0;
  if (heroLevel < req) return 0;
  if (skip <= 0) return maxLvl;                 // no spacing: all ranks at once
  return Math.max(0, Math.min(maxLvl, Math.floor((heroLevel - req) / skip) + 1));
}

export class Room {
  constructor(id = 'arena') {
    this.id = id;
    this.players = new Map();
    this.phase = Phase.LOBBY;
    this.world = null;
    this.eng = null;
    this.loop = null;
    this.snapAcc = 0;
    this.bootReport = null;
  }

  get list() {
    return [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, team: p.team, heroId: p.heroId,
      ready: p.ready, connected: !!p.ws, entId: p.entId ?? null,
      kills: p.kills, deaths: p.deaths, slot: p.slot,
    }));
  }

  join(ws, name) {
    // team membership comes from the map's own config() (SetPlayerTeam)
    // Alternate sides rather than filling slot 0 upwards. The map's slots are
    // 0-3 for one team and 4-7 for the other, so filling in numeric order puts
    // the first four arrivals all on Team 1 -- and this map will not start a
    // duel unless somebody from each side is playing, so a two-person game got
    // sent to the stands to watch an empty ring.
    const used = new Set([...this.players.values()].map((p) => p.slot));
    const free = (t) => (TEAMS.find((x) => x.id === t)?.players || [])
      .find((sl) => !used.has(sl));
    const counts = [0, 1].map((t) => [...this.players.values()]
      .filter((p) => teamOfSlot(p.slot) === t).length);
    const want = counts[0] <= counts[1] ? 0 : 1;
    let chosen = free(want) ?? free(1 - want);
    let slot = 0;
    if (chosen == null) {
      while (used.has(PLAYER_SLOTS[slot]) && slot < PLAYER_SLOTS.length) slot++;
      chosen = PLAYER_SLOTS[slot];
    }
    const p = { id: nextPlayer++, ws, name: (name || 'Player').slice(0, 18),
                slot: chosen ?? slot, team: teamOfSlot(chosen ?? slot),
                heroId: null, ready: false, entId: null, kills: 0, deaths: 0 };
    this.players.set(p.id, p);
    this.send(ws, {
      t: Msg.WELCOME, you: p.id, phase: this.phase,
      game: { meta: GAME.meta, bounds: GAME.bounds, shops: GAME.shops, spawns: GAME.spawns,
              // every item type, so the client can draw whatever it finds lying
              // in the world -- a recipe result is in no shop's stock list
              items: GAME.items, sfx: GAME.sfx },
      heroes: GAME.heroes.map(heroSummary),
    });
    this.broadcastState();
    return p;
  }

  leave(p) {
    if (!p) return;
    p.ws = null;
    if (this.eng && this.phase === Phase.PLAYING) {
      const ph = this.eng.players[p.slot];
      const key = this.eng.eventId('EVENT_PLAYER_LEAVE');
      if (key != null) this.eng.fire(key, { player: ph });
    }
    if (this.phase === Phase.LOBBY) this.players.delete(p.id);
    this.broadcastState();
    if (![...this.players.values()].some((x) => x.ws)) this.reset();
  }

  reset() {
    if (this.loop) clearInterval(this.loop);
    this.loop = null; this.world = null; this.eng = null; this.phase = Phase.LOBBY;
    for (const p of this.players.values()) { p.heroId = null; p.ready = false; p.entId = null; }
  }

  handle(p, m) {
    switch (m.t) {
      case Msg.JOIN_TEAM:
        if (this.phase === Phase.LOBBY && (m.team === 0 || m.team === 1)) {
          const want = TEAMS.find((t) => t.id === m.team);
          if (want && want.players.length) {
            const taken = new Set([...this.players.values()].filter((x) => x !== p).map((x) => x.slot));
            const free = want.players.find((s) => !taken.has(s));
            if (free != null) { p.team = m.team; p.slot = free; }
          }
          this.broadcastState();
        }
        break;
      case Msg.PICK_HERO:
        if (!HERO_BY_ID.has(m.heroId)) break;
        p.heroId = m.heroId;
        if (this.world && this.phase === Phase.PLAYING) this.buyHero(p);
        this.broadcastState();
        break;
      case Msg.READY: {
        p.ready = !!m.ready;
        if (this.phase === Phase.PLAYING) { this.buyHero(p); break; }
        this.broadcastState();
        const active = [...this.players.values()].filter((x) => x.ws);
        if (this.phase === Phase.LOBBY && active.length > 0 && active.every((x) => x.ready && x.heroId))
          this.start();
        break;
      }
      case Msg.CHAT: {
        const text = String(m.text || '').slice(0, 200);
        this.broadcast({ t: Msg.CHATMSG, from: p.name, team: p.team, text });
        // chat also reaches the map's own command triggers (game modes)
        if (this.world) this.world.chat(this.eng.players[p.slot], text);
        break;
      }
      case Msg.PING: this.send(p.ws, { t: Msg.PONG, c: m.c }); break;
      default: this.command(p, m);
    }
  }

  command(p, m) {
    if (!this.world || this.phase !== Phase.PLAYING) return;
    const u = this.world.units.get(p.entId);
    if (!u || !u.alive) return;
    const W = this.world;
    switch (m.t) {
      case Msg.MOVE:   W.order(u, { type: m.attack ? 'attack' : 'move', x: m.x, y: m.y }); break;
      case Msg.STOP:   W.order(u, { type: 'stop' }); break;
      case Msg.ATTACK: {
        const t = W.units.get(m.targetId);
        if (t) W.order(u, { type: 'attack', target: t });
        break;
      }
      case Msg.CAST: {
        const abilId = this.slotAbility(p, u, m.slot);
        if (!abilId) return;
        const target = m.targetId ? W.units.get(m.targetId) : null;
        const r = W.castAbility(u, abilId, target, m.x, m.y);
        if (!r.ok) this.send(p.ws, { t: Msg.ERROR, m: r.reason });
        break;
      }
      case Msg.LEARN: {
        const abilId = this.slotAbility(p, u, m.slot, true);
        if (!abilId || u.skillPoints < 1) return;
        const cur = W.abilityLevel(u, abilId);
        const hero = HERO_BY_ID.get(p.heroId);
        const ab = hero && hero.abilities.find((a) => a.id === int2id(abilId));
        const cap = learnCap(ab, u.level);
        if (cur >= cap) return;
        W.learnSkill(u, abilId);
        u.skillPoints--;
        this.sendHero(p);
        break;
      }
      case Msg.BUY: this.buyItem(p, u, m.itemId); break;
      case 'useItem': {
        const it = (u.items || [])[m.slot];
        if (it) { this.world.useItem(u, it); this.sendHero(p); }
        break;
      }
      case 'dropItem': {
        const it = (u.items || [])[m.slot];
        if (it) { this.world.dropItem(u, it); this.sendHero(p); }
        break;
      }
      case 'pickup': {
        // right-clicking an item on the ground: the hero walks to it and takes
        // it on arrival, exactly as an ordered pickup does in Warcraft III
        const it = this.world.items.get(m.itemId);
        if (it) this.world.orderPickup(u, it);
        break;
      }
      case 'pawnItem': {
        const it = (u.items || [])[m.slot];
        if (it) { this.world.pawnItem(u, it); this.sendHero(p); }
        break;
      }
    }
  }

  /** Hotkey slot -> the hero's learnable ability id (as the map defines them). */
  slotAbility(p, u, slot, forLearn = false) {
    const hero = HERO_BY_ID.get(p.heroId);
    if (!hero) return null;
    const list = hero.castable || hero.learnable || [];
    const id = list[slot];
    // an innate ability cannot be spent skill points on
    if (forLearn && (hero.innate || []).includes(id)) return null;
    return id ? id2int(id) : null;
  }

  buyHero(p) {
    if (p.entId && this.world.units.get(p.entId)) return;
    const heroId = p.heroId || GAME.heroes[0].id;
    const tavern = this.world.tavernFor(heroId);
    const ph = this.eng.players[p.slot];
    const u = this.world.sellUnit(tavern, ph, heroId);
    if (!u) return;
    p.entId = u.id;
    // the map grants hero spells via its own trigger; make sure the slots exist
    const hero = HERO_BY_ID.get(heroId);
    for (const a of (hero?.learnable || [])) this.world.addAbility(u, id2int(a)) && this.world.setAbilityLevel(u, id2int(a), 0);
    this.sendHero(p);
  }

  buyItem(p, u, itemId) {
    for (const s of GAME.shops) {
      const it = s.items.find((i) => i.id === itemId);
      if (!it) continue;
      const ph = this.eng.players[p.slot];
      if (ph.gold < (it.gold || 0)) { this.send(p.ws, { t: Msg.ERROR, m: 'Not enough gold' }); return; }
      ph.gold -= it.gold || 0;
      const shop = this.world.shopFor(itemId);
      const item = this.world.sellItem(shop, u, itemId);
      if (!item) { ph.gold += it.gold || 0; this.send(p.ws, { t: Msg.ERROR, m: 'Inventory full' }); return; }
      item.name = it.name;
      this.sendHero(p);
      return;
    }
  }

  start() {
    this.world = new World();
    this.eng = new JassEngine(this.world);
    this.eng.load();
    // Seat everyone *before* the script runs. Warcraft III's config() and the
    // map's init read the slot states, and this map gates its duel on which of
    // players 0-7 are PLAYING; booting first meant the script saw an empty
    // lobby and then found players in it afterwards.
    for (const p of this.players.values()) {
      const ph = this.eng.players[p.slot];
      // MAP_CONTROL_USER is 0; 1 is MAP_CONTROL_COMPUTER. Telling the map its
      // humans are computers makes every filter that looks for a real player
      // reject them -- which is how a two-person duel ended with both players
      // sitting in the stands and nobody in the ring.
      ph.name = p.name; ph.controller = 0; ph.slotState = 1;
    }
    const t0 = Date.now();
    this.bootReport = this.eng.boot();
    console.log(`[${this.id}] map script booted in ${Date.now() - t0}ms: ` +
      `${this.eng.triggers.length} triggers, ${this.eng.timers.length} timers, ` +
      `${this.world.units.size} units, ${this.bootReport.errors.length} errors`);
    this.phase = Phase.PLAYING;
    for (const p of this.players.values()) if (p.ws) this.buyHero(p);
    this.broadcastState();
    this.loop = setInterval(() => this.stepLoop(), 1000 / TICK_HZ);
  }

  stepLoop() {
    const dt = 1000 / TICK_HZ;
    try {
      this.eng.update(dt);
      const events = this.world.step();
      const scriptEvents = this.eng.flushClientEvents();
      for (const ev of events) {
        if (ev.t === 'death') {
          const u = this.world.units.get(ev.id);
          const k = this.world.units.get(ev.killer);
          for (const p of this.players.values()) {
            if (p.entId === ev.id) p.deaths++;
            if (k && p.entId === k.id) p.kills++;
          }
        }
      }
      const all = events.concat(scriptEvents);
      // the map declares the winner itself
      const vic = scriptEvents.find((e) => e.t === 'victory');
      if (vic != null && this.phase === Phase.PLAYING) {
        this.phase = Phase.ENDED;
        const team = vic.player < 5 ? 0 : vic.player < 10 ? 1 : null;
        this.broadcast({ t: Msg.EVENT, ev: [{ t: 'gameover', winner: team,
                         board: this.scriptBoard() }] });
        this.broadcastState();
        clearInterval(this.loop); this.loop = null;
        setTimeout(() => { this.reset(); this.broadcastState(); }, 20000);
        return;
      }
      if (all.length) this.broadcast({ t: Msg.EVENT, ev: all.slice(0, 200) });
    } catch (e) {
      console.error('sim error:', e.message);
    }
    if (++this.snapAcc >= TICK_HZ / SNAP_HZ) {
      this.snapAcc = 0;
      const snap = this.world.snapshot();
      snap.board = this.scriptBoard();
      this.broadcast({ t: Msg.SNAPSHOT, s: snap });
      for (const p of this.players.values()) if (p.ws && p.entId) this.sendHero(p);
    }
  }

  sendHero(p) {
    const u = this.world?.units.get(p.entId);
    if (!u || !p.ws) return;
    const hero = HERO_BY_ID.get(p.heroId) || {};
    const ph = this.eng.players[p.slot];
    const slots = hero.castable || hero.learnable || [];
    const abilities = slots.map((aid, i) => {
      const key = id2int(aid);
      const ab = (hero.abilities || []).find((a) => a.id === aid) || {};
      const lvl = this.world.abilityLevel(u, key);
      const isInnate = (hero.innate || []).includes(aid);
      const cd = (u.cooldowns && u.cooldowns.get(key)) || 0;
      return { slot: i, id: aid, lvl, name: ab.name || aid, icon: ab.icon,
               desc: ab.desc || ab.tip, archetype: ab.archetype,
               nameEn: ab.nameEn, descEn: ab.descEn || ab.tipEn,
               maxLvl: ab.maxLvl || (ab.levels || []).length || 1,
               reqLevel: ab.reqLevel || 0, levelSkip: ab.levelSkip || 0,
               innate: isInnate,
               targetMode: SPELL_TARGETS[aid] || 'point',
               // innate abilities are granted with the unit, never learned
               cap: isInnate ? Math.max(lvl, 1) : learnCap(ab, u.level),
               cdLeft: Math.max(0, (cd - this.world.now) / 1000),
               info: (ab.levels || [])[Math.max(0, lvl - 1)] || {} };
    });
    this.send(p.ws, { t: 'hero', h: {
      id: u.id, unitId: u.typeKey, name: u.properName || u.name, title: hero.title || '',
      titleEn: hero.titleEn || '',
      model: hero.model, level: u.level, xp: Math.round(u.xp),
      skillPoints: u.skillPoints,
      xpNeed: Math.round(this.world.xpForLevel(u.level)),
      maxLevel: this.world.maxHeroLevel,
      hp: Math.round(u.hp), maxHp: Math.round(u.maxHp),
      mana: Math.round(u.mana), maxMana: Math.round(u.maxMana),
      str: Math.round(u.strTotal ?? u.str), agi: Math.round(u.agiTotal ?? u.agi),
      int: Math.round(u.intTotal ?? u.intel),
      dmg: Math.round(u.dmg ?? u.dmgBase), armor: +(u.armorTotal ?? u.armor).toFixed(1),
      moveSpeed: Math.round(u.moveSpeed), gold: Math.round(ph.gold),
      kills: p.kills, deaths: p.deaths, alive: u.alive,
      respawnIn: 0,
      // the inventory the client draws: six slots, as Warcraft III gives a hero
      items: (u.items || []).map((i, n) => ({
        slot: n, id: i.typeKey || int2id(i.typeId),
        name: i.name || int2id(i.typeId),
        icon: (ITEM_ICON.get(i.typeKey || int2id(i.typeId)) || null),
        charges: i.charges || 0,
      })),
      abilities,
    } });
  }

  /**
   * The map keeps its own scoreboard — a multiboard grid in some maps, a
   * leaderboard in others. Surface whichever it built, verbatim.
   */
  scriptBoard() {
    const mb = this.eng?.scoreboard?.();
    if (mb) {
      const strip = (x) => String(x).replace(/\|c[0-9a-fA-F]{8}|\|r/g, '').trim();
      const grid = mb.rows.map((r) => r.map(strip));
      // team totals: the row labelled for each side carries its kill count
      const teamRows = grid.filter((r) => /team/i.test(r[0]));
      return { kind: 'multiboard', title: strip(mb.title), cols: mb.cols, rows: grid,
               teams: teamRows.map((r) => ({ label: r[0], value: r[1] })) };
    }
    const lb = (this.eng?.leaderboards || []).find((b) => b.rows.length);
    if (!lb) return null;
    return { kind: 'leaderboard', title: lb.title,
             rows: lb.rows.map((r) => ({ label: r.label, value: r.value, p: r.p })) };
  }

  broadcastState() {
    this.broadcast({ t: Msg.STATE, phase: this.phase, players: this.list,
                     board: this.scriptBoard(), killsToWin: GAME.meta.killsToWin,
                     winner: null });
  }
  send(ws, o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  broadcast(o) {
    const s = JSON.stringify(o);
    for (const p of this.players.values()) if (p.ws && p.ws.readyState === 1) p.ws.send(s);
  }
}

function heroSummary(h) {
  return { id: h.id, name: h.name, title: h.title, titleEn: h.titleEn,
           model: h.model, icon: h.icon,
           tavern: h.tavern, custom: h.custom, scale: h.scale, voices: h.voices || [],
           hp: h.hp, mana: h.mana, dmg: h.dmgBase, armor: h.armor,
           moveSpeed: h.moveSpeed, atkRange: h.atkRange,
           str: h.str_, agi: h.agi, int: h.int_,
           abilities: (h.learnable || []).map((id) => {
             const a = (h.abilities || []).find((x) => x.id === id);
             // both languages travel together; the client picks one
             return a ? { id: a.id, name: a.name, nameEn: a.nameEn,
                          icon: a.icon, desc: a.desc || a.tip,
                          descEn: a.descEn || a.tipEn,
                          archetype: a.archetype, levels: (a.levels || []).length || 1 } : null;
           }).filter(Boolean) };
}
