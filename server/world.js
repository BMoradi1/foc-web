// Engine-level simulation. Everything Warcraft III's engine does natively lives
// here (movement, pathing, auto-attack, damage, regen, death); everything the
// map's triggers do lives in its own script, run by server/jass.
import fs from 'node:fs';
import path from 'node:path';
import { Grid } from './pathing.js';
import { Handle } from './jass/vm.js';
import { ABILS, entry as abilEntry, execute as abilExecute, levelInfo, isPassive,
         auraEffects, itemBonuses, itemUse, abilityBonuses } from './abilities.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

export const TERR = readJSON('public/data/terrain.json');
export const TYPES = readJSON('data/unittypes.json');
const WALK = new Uint8Array(fs.readFileSync(path.join(ROOT, 'public/data/walk.bin')));
// Warcraft III plays unit sound sets from the engine, not from map triggers.
// Every item type, not just the ones a shop happens to sell: an item dropped,
// created by the script or carried over from another map still needs to know
// what it grants.  The shop entries are laid on top for the map's own naming.
const ITEMS = (() => {
  const m = {};
  try {
    for (const [id, v] of Object.entries(readJSON('data/itemtypes.json'))) {
      m[id] = { id, name: v.name || '', abilities: v.abilities || [],
                charges: v.uses || 0, gold: v.gold || 0, level: v.level || 1,
                powerup: !!v.powerup };
    }
  } catch { /* no item table built yet */ }
  try {
    const g = readJSON('data/game.json');
    for (const s of g.shops) for (const i of s.items) m[i.id] = Object.assign({}, m[i.id], i);
  } catch { /* no shops */ }
  return m;
})();
const SOUNDSETS = (() => {
  try { return readJSON('data/soundsets.json'); } catch { return {}; }
})();
const HEIGHTS = new Float32Array(fs.readFileSync(path.join(ROOT, 'public/data/heights.bin')).buffer);

const DEG = Math.PI / 180;
const ART_TTL = 2200;            // how long an ability's own one-shot art lives
const NEUTRAL_HOSTILE = 12;      // creeps
const NEUTRAL_PASSIVE = 15;      // shops, taverns, picker props
const trunc = (v) => (v < 0 ? Math.ceil(v) : Math.floor(v)) | 0;

/** 4-char object id <-> integer, matching JASS 'abcd' literals. */
export function id2int(s) {
  if (typeof s === 'number') return s;
  let v = 0;
  const t = String(s).padEnd(4, ' ').slice(0, 4);
  for (let i = 0; i < 4; i++) v = (v * 256 + t.charCodeAt(i)) | 0;
  return v;
}
export function int2id(v) {
  if (typeof v === 'string') return v;
  let s = '';
  for (let i = 3; i >= 0; i--) s += String.fromCharCode((v >>> (i * 8)) & 0xff);
  return s;
}

const TYPE_BY_INT = new Map();
for (const k of Object.keys(TYPES)) TYPE_BY_INT.set(id2int(k), TYPES[k]);

// unitstate / playerstate ids from common.j
const US_LIFE = 0, US_MAX_LIFE = 1, US_MANA = 2, US_MAX_MANA = 3;
const PS_GOLD = 1, PS_LUMBER = 2;

const GP = (() => {
  try { return readJSON('data/gameplay.json'); } catch { return null; }
})();
const DEF_ARMOR = GP ? GP.defenseArmor : 0.06;
// Creep leashing, straight from MiscGame.txt.  A unit that strays 'GuardDistance'
// from where it spawned starts thinking about heading back; if it chases for
// 'GuardReturnTime' without being attacked it turns around, and past
// 'MaxGuardDistance' it goes home no matter who is hitting it.
const GUARD_DIST = GP ? GP.guardDistance : 600;
const MAX_GUARD_DIST = GP ? GP.maxGuardDistance : 1000;
const GUARD_RETURN_MS = (GP ? GP.guardReturnTime : 5) * 1000;
const CALL_FOR_HELP = GP ? GP.callForHelp : 600;
const CREEP_CALL_FOR_HELP = GP ? GP.creepCallForHelp : 600;
// Experience tables, built from the MiscGame.txt recurrences.  needHeroXP[L-1]
// is what it costs to leave level L; grant*XP[L-1] is what killing a level-L
// unit is worth.  This map raises MaxHeroLevel to 50 in war3mapMisc.txt.
const XP_NEED = (GP && GP.needHeroXP) || null;
const XP_GRANT_HERO = (GP && GP.grantHeroXP) || null;
const XP_GRANT_NORMAL = (GP && GP.grantNormalXP) || null;
const MAX_HERO_LEVEL = GP ? GP.maxHeroLevel : 10;
const HERO_EXP_RANGE = GP ? GP.heroExpRange : 1200;
const HERO_FACTOR_XP = (GP && GP.heroFactorXP) || [100];
const SUMMONED_KILL_FACTOR = GP ? GP.summonedKillFactor : 0.5;
const BUILDING_KILLS_XP = GP ? !!GP.buildingKillsGiveExp : false;
const DMG_TABLE = GP ? GP.damageBonus : {};

export function armorFactor(armor) {
  return armor >= 0 ? 1 - (DEF_ARMOR * armor) / (1 + DEF_ARMOR * armor)
                    : 2 - Math.pow(1 - DEF_ARMOR, -armor);
}

/** Warcraft III's attack-type vs armour-type multiplier (Custom_V1 MiscGame.txt). */
export function typeBonus(attackType, armorType) {
  const row = DMG_TABLE[String(attackType || 'normal').toLowerCase()];
  if (!row) return 1;
  const v = row[String(armorType || 'none').toLowerCase()];
  return typeof v === 'number' ? v : 1;
}

// Everything a change of unit type replaces, and therefore everything that has
// to be put back when the form runs out.
// Units\MiscData.txt: how far a unit will chase an item it was ordered to take
// before it gives up on it.
const FOLLOW_ITEM_RANGE = 1000;
// Warcraft III has no "pickup range" constant -- the unit walks onto the item
// and takes it on contact, so the test is its own footprint. MiscData gives the
// item's shadow as 120x120, which is the size the game itself treats one as.
const ITEM_REACH = 60;

const MORPH_FIELDS = ['typeId', 'typeKey', 'model', 'icon', 'armor', 'armorType',
  'atkType', 'dmgBase', 'dmgDice', 'dmgSides', 'atkCd', 'atkRange', 'missile',
  'missileSpeed', 'missileArc', 'missileHoming', 'baseMoveSpeed', 'radius',
  'renderScale', 'hpReg', 'manaReg', 'str', 'strLvl', 'agi', 'agiLvl',
  'intel', 'intLvl'];

export class World {
  constructor() {
    this.grid = new Grid(WALK, TERR.pathWidth, TERR.pathHeight, TERR.offsetX, TERR.offsetY);
    this.units = new Map();
    this.items = new Map();
    this.nextId = 1;
    this.now = 0;
    this.dt = 1 / 30;
    this.tick = 0;
    this.jass = null;
    this.startLocs = [];
    this.alliances = new Map();
    this.playerCount = 12;
    this.clientEvents = [];
    this.fxSeq = 0;                // ids for engine-drawn ability art
    this.missiles = [];            // shots in flight, resolved on impact
    this.regionWatch = [];
  }

  // ------------------------------------------------------------------ terrain
  bounds() {
    const w = (TERR.width - 1) * TERR.tileSize, h = (TERR.height - 1) * TERR.tileSize;
    return { minx: TERR.offsetX, miny: TERR.offsetY, maxx: TERR.offsetX + w, maxy: TERR.offsetY + h };
  }
  terrainZ(x, y) {
    const fx = (x - TERR.offsetX) / TERR.tileSize, fy = (y - TERR.offsetY) / TERR.tileSize;
    const i = Math.max(0, Math.min(TERR.width - 1, Math.round(fx)));
    const j = Math.max(0, Math.min(TERR.height - 1, Math.round(fy)));
    return HEIGHTS[j * TERR.width + i] || 0;
  }
  walkable(x, y) { return this.grid.walkableAt(x, y); }
  setStartLoc(i, x, y) { this.startLocs[trunc(i)] = [x, y]; this._bases = null; }
  startLoc(i) { return this.startLocs[trunc(i)] || [0, 0]; }

  /**
   * Team bases. Maps that pick heroes in-world put every player slot on one
   * shared pick point and give each team its own extra start location; the
   * pick area is walled off, so heroes belong at the base instead.
   */
  teamBase(team) {
    if (!this._bases) {
      const locs = this.startLocs.filter(Boolean);
      const key = (l) => l[0] + ',' + l[1];
      const counts = new Map();
      for (const l of locs) counts.set(key(l), (counts.get(key(l)) || 0) + 1);
      const shared = [...counts].sort((a, b) => b[1] - a[1])[0];
      const distinct = shared && shared[1] > 1
        ? locs.filter((l) => key(l) !== shared[0]) : [];
      const uniq = [];
      for (const l of distinct) if (!uniq.some((u) => key(u) === key(l))) uniq.push(l);
      this._bases = uniq.length >= 2 ? uniq : locs;
    }
    return this._bases[team] || this._bases[0] || [0, 0];
  }

  // ------------------------------------------------------------- unit types
  type(id) {
    if (typeof id === 'number') return TYPE_BY_INT.get(id) || null;
    return TYPES[id] || TYPE_BY_INT.get(id2int(id)) || null;
  }
  typeName(id) { const t = this.type(id); return t ? (t.properName || t.name || int2id(id)) : ''; }
  isHeroType(id) { const t = this.type(id); return !!(t && t.isHero); }

  randomCreep(level) {
    const lv = trunc(level);
    const pool = [];
    for (const [i, t] of TYPE_BY_INT) {
      if (String(t.race).toLowerCase() !== 'creeps') continue;
      if (t.level !== lv) continue;
      if (t.isBuilding) continue;
      pool.push(i);
    }
    if (!pool.length) return 0;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // ------------------------------------------------------------------- units
  createUnit(playerHandle, typeIdRaw, x, y, facingDeg) {
    const t = this.type(typeIdRaw);
    const typeId = typeof typeIdRaw === 'number' ? typeIdRaw : id2int(typeIdRaw);
    const pidx = playerHandle ? playerHandle.index : 12;
    const radius = t ? Math.max(8, t.collision) : 24;
    const [ux, uy] = this.freeSpotNear(x, y, radius);
    const maxHp = t ? Math.max(1, t.hp) : 100;
    const maxMana = t ? t.mana : 0;
    const u = new Handle('unit', {
      id: this.nextId++, typeId, typeKey: int2id(typeId), playerIndex: pidx,
      team: playerHandle ? playerHandle.team : 2,
      name: t ? (t.properName || t.name) : int2id(typeId),
      properName: t ? t.properName : null,
      model: t ? t.model : '', icon: t ? t.icon : '',
      x: ux, y: uy, facing: (facingDeg || 0) * DEG,
      alive: true, hidden: false, paused: false, invulnerable: false,
      hp: maxHp, maxHp, mana: t ? (t.manaStart || maxMana) : 0, maxMana,
      hpReg: t ? t.hpReg : 0, manaReg: t ? t.manaReg : 0.01,
      armor: t ? t.armor : 0,
      armorType: t ? (t.armorType || 'none') : 'none',
      atkType: t ? (t.atkType || 'normal') : 'normal',
      dmgBase: t ? t.dmgBase : 0, dmgDice: t ? t.dmgDice : 1, dmgSides: t ? t.dmgSides : 1,
      atkCd: t ? Math.max(0.2, t.atkCd) : 1.5, atkRange: t ? t.atkRange : 90, atkTimer: 0,
      // the weapon's missile, if it throws one (Units\*UnitFunc.txt)
      missile: t ? t.missile : null, missileSpeed: t ? t.missileSpeed : 0,
      missileArc: t ? t.missileArc : 0, missileHoming: t ? t.missileHoming : 0,
      moveSpeed: t ? t.moveSpeed : 270, baseMoveSpeed: t ? t.moveSpeed : 270,
      radius: t ? Math.max(8, t.collision) : 24,
      renderScale: t ? t.scale || 1 : 1,
      // A unit type's 'level' is its data level (bounty, XP granted).  Warcraft
      // III heroes always enter the world at level 1 regardless of it -- this
      // map stamps every hero type level 5, which was handing them four free
      // levels and unlocking abilities their level should not reach yet.
      level: t && t.isHero ? 1 : (t ? t.level : 1),
      xp: 0, skillPoints: t && t.isHero ? 1 : 0,
      isHero: !!(t && t.isHero), isBuilding: !!(t && t.isBuilding),
      str: t ? t.str_ : 0, strLvl: t ? t.strLvl : 0,
      agi: t ? t.agi : 0, agiLvl: t ? t.agiLvl : 0,
      intel: t ? t.int_ : 0, intLvl: t ? t.intLvl : 0,
      abilities: new Map(), items: [], buffs: [],
      order: { type: 'idle' }, path: null, userData: 0,
      // where this unit stands guard, and how far it looks for a fight
      homeX: x, homeY: y, returning: false, strayedAt: 0, lastAttackedAt: 0,
      acquisitionRange: t ? t.acquisitionRange || 500 : 500,
      flyHeight: 0, expireAt: 0, bounty: t ? t.bountyPlus : 0,
      kills: 0, deaths: 0, sellUnits: t ? t.sellUnits || [] : [],
      sellItems: t ? t.sellItems || [] : [],
      // hero-shaped units owned by neutral-passive are the map's in-world hero
      // picker; the web lobby replaces it, so they are not sent to clients
      pickerProp: !!(t && t.isHero) && pidx === NEUTRAL_PASSIVE,
    });
    if (u.pickerProp) { u.paused = true; u.invulnerable = true; }
    for (const a of (t ? t.abilities : [])) u.abilities.set(id2int(a), 1);
    if (t && t.isHero) {
      this.recalc(u);
      u.hp = u.maxHp; u.mana = u.maxMana;
    }
    this.units.set(u.id, u);
    this.emit({ t: 'spawn', id: u.id });
    return u;
  }

  /**
   * A walkable spot near (x,y) that is not already occupied. Warcraft III spreads
   * units created at the same point instead of stacking them.
   */
  freeSpotNear(x, y, radius) {
    const clear = (px, py) => {
      if (!this.grid.walkableAt(px, py)) return false;
      for (const o of this.units.values()) {
        if (!o.alive || o.isBuilding || o.hidden) continue;
        const need = radius + o.radius;
        if ((o.x - px) ** 2 + (o.y - py) ** 2 < need * need * 0.64) return false;
      }
      return true;
    };
    const c0 = this.grid.nearestWalkable(x, y);
    const [bx, by] = c0 ? this.grid.toWorld(c0[0], c0[1]) : [x, y];
    if (clear(bx, by)) return [bx, by];
    const step = Math.max(24, radius * 1.8);
    for (let ring = 1; ring <= 8; ring++) {
      const n = ring * 6;
      const start = Math.random() * Math.PI * 2;
      for (let k = 0; k < n; k++) {
        const a = start + (k / n) * Math.PI * 2;
        const px = bx + Math.cos(a) * step * ring;
        const py = by + Math.sin(a) * step * ring;
        if (clear(px, py)) return [px, py];
      }
    }
    return [bx, by];
  }

  removeUnit(u) { if (!u) return; u.alive = false; u.removed = true; this.units.delete(u.id); }

  /** One of a unit's sound-set clips, as the engine would pick it. */
  unitSound(u, event) {
    const set = SOUNDSETS[u && u.typeKey] || SOUNDSETS[u && u.origin];
    const s = set && set[event];
    if (!s || !s.files.length) return null;
    return { path: s.files[Math.floor(Math.random() * s.files.length)],
             vol: s.vol ?? 1, pitch: s.pitch ?? 1 };
  }

  killUnit(u, killer) {
    if (!u || !u.alive) return;
    u.alive = false; u.hp = 0; u.path = null; u.order = { type: 'idle' };
    // Bounty and experience are paid for the death, not for the blow: Warcraft
    // III pays them however the unit died, and this map kills plenty of things
    // from its own triggers. Awarding only on the damage path left every
    // script-driven kill worth nothing.
    this.awardKill(u, killer);
    const ds = this.unitSound(u, 'death');
    if (ds) this.emit({ t: 'sound', path: ds.path, x: u.x, y: u.y, vol: ds.vol, pitch: ds.pitch });
    const kp = this.playerOf(killer);
    if (kp && killer !== u && this.hostile(killer, u)) {
      this.addScore(kp, 1);                       // PLAYER_SCORE_UNITS_KILLED
      if (u.isHero) this.addScore(kp, 7);         // PLAYER_SCORE_HEROES_KILLED
    }
    this.emit({ t: 'death', id: u.id, killer: killer && killer.id });
    const dctx = { unit: u, killer, player: this.playerOf(u) };
    this.fireUnitEvent('EVENT_PLAYER_UNIT_DEATH', dctx);
    this.fireUnitEvent('EVENT_UNIT_DEATH', dctx);       // per-unit death registrations
  }

  reviveUnit(u, x, y) {
    if (!u) return;
    const c = this.grid.nearestWalkable(x, y);
    if (c) [u.x, u.y] = this.grid.toWorld(c[0], c[1]);
    u.alive = true; this.recalc(u); u.hp = u.maxHp; u.mana = u.maxMana;
    u.buffs = []; u.path = null; u.order = { type: 'idle' };
    this.emit({ t: 'revive', id: u.id });
  }

  moveUnit(u, x, y) {
    if (!u) return;
    u.x = x; u.y = y; u.path = null;
  }

  unitState(u, st) {
    if (!u) return 0;
    switch (st) {
      case US_LIFE: return u.alive ? u.hp : 0;
      case US_MAX_LIFE: return u.maxHp;
      case US_MANA: return u.mana;
      case US_MAX_MANA: return u.maxMana;
    }
    return 0;
  }
  setUnitState(u, st, v) {
    if (!u) return;
    switch (st) {
      case US_LIFE:
        if (v <= 0) { this.killUnit(u, null); return; }
        u.hp = Math.min(u.maxHp, v); return;
      case US_MAX_LIFE: u.maxHp = Math.max(1, v); return;
      case US_MANA: u.mana = Math.max(0, Math.min(u.maxMana, v)); return;
      case US_MAX_MANA: u.maxMana = Math.max(0, v); return;
    }
  }

  recalc(u) {
    if (!u || !u.isHero) return;
    const lv = Math.max(0, u.level - 1);
    const t = this.type(u.typeId) || {};
    u.strTotal = u.str + u.strLvl * lv;
    u.agiTotal = u.agi + u.agiLvl * lv;
    u.intTotal = u.intel + u.intLvl * lv;
    const HP_PER_STR = GP ? GP.strHitPointBonus : 19;
    const MANA_PER_INT = GP ? GP.intManaBonus : 15;
    const DEF_PER_AGI = GP ? GP.agiDefenseBonus : 0.14;
    const ATK_PER_STR = GP ? GP.strAttackBonus : 1;
    u.maxHp = Math.max(1, Math.round((t.hp || 100) + u.strTotal * HP_PER_STR));
    u.maxMana = Math.round((t.mana || 0) + u.intTotal * MANA_PER_INT);
    const ib = itemBonuses(u.items);
    const sb = abilityBonuses(this, u);          // passive skills like Attribute Bonus
    u.strTotal += ib.str + sb.str;
    u.agiTotal += ib.agi + sb.agi;
    u.intTotal += ib.intel + sb.intel;
    u.maxHp += Math.round(ib.maxHp + (ib.str + sb.str) * HP_PER_STR);
    u.maxMana += Math.round(ib.maxMana + (ib.intel + sb.intel) * MANA_PER_INT);
    u.armorTotal = (t.armor || 0) + u.agiTotal * DEF_PER_AGI + ib.armor;
    // Warcraft III derives life from strength, mana from intelligence and armour
    // from agility for every hero, but attack damage from the hero's *primary*
    // attribute alone.  Using strength for all of them hands an agility hero its
    // strength gain as damage -- on this map, whose base template grants +15
    // strength a level, that roughly doubled some heroes' damage.
    const prim = String(t.primary || 'STR').toUpperCase();
    const primTotal = prim === 'AGI' ? u.agiTotal : prim === 'INT' ? u.intTotal : u.strTotal;
    u.primaryAttr = prim;
    u.dmg = (t.dmgBase || 0) + primTotal * ATK_PER_STR + ib.damage;
    u.lifesteal = ib.lifesteal; u.cleave = ib.cleave;
    if (ib.flames) u.immolation = { dps: ib.flames, area: 200 };
    // attack speed: agility plus any item bonus, as Warcraft III stacks them
    const AS_PER_AGI = GP ? GP.agiAttackSpeedBonus : 0.02;
    u.attackSpeedMul = 1 + u.agiTotal * AS_PER_AGI + ib.attackSpeed;
    u.hpReg = (t.hpReg || 0) + ib.hpReg;
    // boots and the like add a flat move-speed bonus
    u.moveSpeed = u.baseMoveSpeed + (ib.moveSpeed || 0);
    u.xpMul = 1 + (ib.xpMul || 0) / 100;      // ExperienceMod items, as a percent
    for (const b of (u.buffs || [])) {
      if (b.kind === 'slow') u.moveSpeed *= 1 - b.pct;
      if (b.kind === 'rage' || b.kind === 'morph') { u.dmg *= 1 + b.pct; }
      if (b.kind === 'weaken') u.dmg *= 1 - b.pct;
    }
    u.hp = Math.min(u.hp, u.maxHp);
    u.mana = Math.min(u.mana, u.maxMana);
  }

  get maxHeroLevel() { return MAX_HERO_LEVEL; }

  /** What it costs to advance out of level `lv`. */
  xpForLevel(lv) {
    if (!XP_NEED || !XP_NEED.length) return 100 + lv * 120;
    return XP_NEED[Math.min(XP_NEED.length - 1, Math.max(0, trunc(lv) - 1))];
  }
  /**
   * Warcraft III pays experience to every enemy hero within HeroExpRange of the
   * dying unit -- not just to whoever landed the blow -- from the GrantHeroXP /
   * GrantNormalXP tables indexed by the victim's level.  Gold bounty is the
   * killer's alone.
   *
   * HeroFactorXP scales the award; the data file ships the list without a
   * comment, and it is applied here as the per-head factor when several heroes
   * share one kill, which is what its length (one entry per sharer) implies.
   */
  awardKill(victim, killer) {
    if (killer) {
      const p = this.playerOf(killer);
      if (p) p.gold += Math.round(victim.bounty || 10 + victim.level * 4);
    }
    if (!XP_GRANT_HERO || !XP_GRANT_NORMAL) return;
    if (victim.isBuilding && !BUILDING_KILLS_XP) return;
    const tbl = victim.isHero ? XP_GRANT_HERO : XP_GRANT_NORMAL;
    const lv = Math.max(1, trunc(victim.level) || 1);
    let base = tbl[Math.min(tbl.length - 1, lv - 1)];
    if (victim.summoned) base *= SUMMONED_KILL_FACTOR;
    const sharers = this.enumInRange(victim.x, victim.y, HERO_EXP_RANGE).filter(
      (h) => h.isHero && h.alive && !h.pickerProp && h !== victim &&
             !this.isAlly(this.playerOf(h), this.playerOf(victim)));
    if (!sharers.length) return;
    const f = HERO_FACTOR_XP[Math.min(HERO_FACTOR_XP.length - 1, sharers.length - 1)] / 100;
    for (const h of sharers) this.addXp(h, base * f);
  }

  addXp(u, amt) {
    if (!u || !u.isHero) return;
    // ExperienceMod items (tomes of retraining and the like) scale what is gained
    u.xp += amt * (u.xpMul || 1);
    this.checkLevel(u);
  }
  checkLevel(u) {
    while (u.level < MAX_HERO_LEVEL && u.xp >= this.xpForLevel(u.level)) {
      u.xp -= this.xpForLevel(u.level);
      this.setHeroLevel(u, u.level + 1);
    }
  }
  setHeroLevel(u, lv) {
    if (!u) return;
    u.level = Math.max(1, trunc(lv));
    u.skillPoints = (u.skillPoints || 0) + 1;
    this.recalc(u);
    u.hp = u.maxHp; u.mana = u.maxMana;
    this.emit({ t: 'levelup', id: u.id, lvl: u.level });
    this.fireUnitEvent('EVENT_PLAYER_HERO_LEVEL', { unit: u, player: this.playerOf(u) });
  }

  addAbility(u, abilId) {
    if (!u) return false;
    const k = typeof abilId === 'number' ? abilId : id2int(abilId);
    if (!u.abilities.has(k)) u.abilities.set(k, 1);
    return true;
  }
  removeAbility(u, abilId) {
    if (!u) return false;
    u.abilities.delete(typeof abilId === 'number' ? abilId : id2int(abilId));
    return true;
  }
  abilityLevel(u, abilId) {
    if (!u) return 0;
    return u.abilities.get(typeof abilId === 'number' ? abilId : id2int(abilId)) || 0;
  }
  setAbilityLevel(u, abilId, lv) {
    if (!u) return 0;
    const k = typeof abilId === 'number' ? abilId : id2int(abilId);
    const n = Math.max(0, trunc(lv));
    if (n === 0) u.abilities.delete(k); else u.abilities.set(k, n);
    return n;
  }
  resetCooldowns(u) { if (u) u.cooldowns = new Map(); return true; }

  /** Learning a skill is an event the map's triggers listen for. */
  learnSkill(u, abilId) {
    if (!u) return 0;
    const key = typeof abilId === 'number' ? abilId : id2int(abilId);
    const lvl = this.abilityLevel(u, key) + 1;
    this.setAbilityLevel(u, key, lvl);
    this.fireUnitEvent('EVENT_PLAYER_HERO_SKILL',
                       { unit: u, skillId: key, skillLevel: lvl, player: this.playerOf(u) });
    return lvl;
  }

  /** common.j unittype ids. */
  isUnitType(u, t) {
    if (!u) return false;
    switch (t) {
      case 0: return !!u.isHero;          // UNIT_TYPE_HERO
      case 1: return !u.alive;            // UNIT_TYPE_DEAD
      case 2: return !!u.isBuilding;      // UNIT_TYPE_STRUCTURE
      case 3: return (u.flyHeight || 0) > 0;   // FLYING
      case 4: return !(u.flyHeight > 0);       // GROUND
      case 7: return (u.atkRange || 0) <= 200; // MELEE_ATTACKER
      case 8: return (u.atkRange || 0) > 200;  // RANGED_ATTACKER
      case 10: return !!u.summonedBy;     // SUMMONED
      case 11: return this.stunned(u);    // STUNNED
      default: return false;
    }
  }

  // ----------------------------------------------------------------- combat
  damage(src, tgt, amount, opts = {}) {
    if (!tgt || !tgt.alive || tgt.invulnerable) return 0;
    let dmg = amount;
    if (!opts.raw) {
      // spells use the "spells" row; attacks use the attacker's own attack type
      const at = opts.spell ? 'spells' : (src ? src.atkType : 'normal');
      dmg *= typeBonus(at, tgt.armorType);
      dmg *= armorFactor(tgt.armorTotal ?? tgt.armor ?? 0);
    }
    tgt.hp -= dmg;
    tgt.lastAttackedAt = this.now;
    if (src) this.callForHelp(tgt, src);
    this.emit({ t: 'dmg', id: tgt.id, src: src && src.id, amt: Math.round(dmg) });
    const dmgCtx = { unit: tgt, damageSource: src, damage: dmg, player: this.playerOf(tgt) };
    this.fireUnitEvent('EVENT_PLAYER_UNIT_DAMAGED', dmgCtx);
    this.fireUnitEvent('EVENT_UNIT_DAMAGED', dmgCtx);     // per-unit damage registrations
    if (tgt.hp <= 0) this.killUnit(tgt, src);
    return dmg;
  }

  // ----------------------------------------------------------------- orders
  order(u, o) {
    if (!u || !u.alive || u.paused) return false;
    const numericOrder = typeof o.type === 'number' || /^-?\d+$/.test(String(o.type));
    if (numericOrder && this.castDummy(u, { target: o.target, x: o.x, y: o.y })) return true;
    const name = typeof o.type === 'string' ? o.type : String(o.type);
    if (/stop|halt/i.test(name)) { u.order = { type: 'idle' }; u.path = null; return true; }
    if (o.target) {
      u.order = { type: 'attack', targetId: o.target.id }; u.path = null;
      this.fireUnitEvent('EVENT_PLAYER_UNIT_ISSUED_TARGET_ORDER',
        { unit: u, orderTarget: o.target, orderId: o.type, player: this.playerOf(u) });
      return true;
    }
    if (o.x != null) {
      const attack = /attack/i.test(name);
      u.path = this.grid.path(u.x, u.y, o.x, o.y);
      u.order = { type: attack ? 'attackMove' : 'move', x: o.x, y: o.y };
      return true;
    }
    return true;
  }

  // ------------------------------------------------------------ enumeration
  allUnits() { return [...this.units.values()].filter((u) => u.alive && !u.hidden); }
  enumInRange(x, y, r) {
    const out = [];
    for (const u of this.units.values()) {
      if (!u.alive || u.hidden) continue;
      if (Math.hypot(u.x - x, u.y - y) <= r) out.push(u);
    }
    return out;
  }
  enumInRect(r) {
    if (!r) return [];
    return this.allUnits().filter((u) => u.x >= r.minx && u.x <= r.maxx && u.y >= r.miny && u.y <= r.maxy);
  }
  unitsOfPlayer(p) {
    const i = p ? p.index : -1;
    return this.allUnits().filter((u) => u.playerIndex === i);
  }
  playerOf(u) { return this.jass && u ? this.jass.players[u.playerIndex] : null; }

  // ------------------------------------------------------------------ items
  createItem(idRaw, x, y) {
    const key = typeof idRaw === 'number' ? int2id(idRaw) : idRaw;
    const def = ITEMS[key] || {};
    const it = new Handle('item', { id: this.nextId++,
                                    typeId: typeof idRaw === 'number' ? idRaw : id2int(idRaw),
                                    typeKey: key, x, y, charges: def.charges || 0,
                                    name: def.name || '', abilities: def.abilities || [],
                                    powerup: !!def.powerup });
    this.items.set(it.id, it);
    return it;
  }
  removeItem(it) {
    if (!it) return;
    // an item held by a unit must also leave that unit's inventory
    const owner = it.owner;
    if (owner && owner.items) {
      owner.items = owner.items.filter((x) => x !== it);
      this.recalc(owner);
    }
    it.owner = null;
    this.items.delete(it.id);
  }
  /**
   * A powerup is spent the instant it is picked up.
   *
   * Warcraft III does not carry a tome: the bonus becomes part of the hero and
   * the item is gone.  Holding them instead lets seven of this map's shop items
   * fill a six-slot inventory, and makes a 19000-gold permanent stat purchase
   * something you could drop by accident.
   */
  consumePowerup(u, it) {
    const b = itemBonuses([it]);
    u.str += b.str || 0;
    u.agi += b.agi || 0;
    u.intel += b.intel || 0;
    const eff = itemUse(it);
    if (eff) {
      if (eff.kind === 'xp') this.addXp(u, eff.amount);
      else if (eff.kind === 'heal') this.heal(u, eff.amount);
      else if (eff.kind === 'mana') u.mana = Math.min(u.maxMana, u.mana + eff.amount);
    }
    this.fireUnitEvent('EVENT_PLAYER_UNIT_PICKUP_ITEM',
                       { unit: u, item: it, player: this.playerOf(u) });
    this.items.delete(it.id);
    this.recalc(u);
    return true;
  }

  giveItem(u, it) {
    if (!u || !it) return false;
    if (it.powerup) return this.consumePowerup(u, it);
    if (u.items.length >= 6) return false;
    u.items.push(it); it.owner = u;
    this.recalc(u);
    this.fireUnitEvent('EVENT_PLAYER_UNIT_PICKUP_ITEM',
                       { unit: u, item: it, player: this.playerOf(u) });
    return true;
  }
  dropItem(u, it) {
    if (!u || !it) return false;
    const had = u.items.includes(it);
    u.items = u.items.filter((x) => x !== it);
    it.owner = null;
    // it lands where the carrier stood -- but two items on the same spot are one
    // item as far as anyone clicking can tell, so nudge off anything already there
    [it.x, it.y] = this.freeItemSpot(u.x, u.y);
    this.recalc(u);
    // the map listens for this the same way it listens for a pickup
    if (had) this.fireUnitEvent('EVENT_PLAYER_UNIT_DROP_ITEM',
                                { unit: u, item: it, player: this.playerOf(u) });
    return true;
  }

  /**
   * Sell an item back to a shop.
   *
   * Warcraft III refunds the item's gold cost scaled by the `pawnItemRate`
   * gameplay constant -- 0.75 here -- and fires PAWN_ITEM, which was the one
   * event kind of seventeen this map registers that never fired.
   */
  pawnItem(u, it) {
    if (!u || !it || !u.items.includes(it)) return false;
    const def = ITEMS[it.typeKey] || {};
    const rate = GP && GP.pawnItemRate != null ? GP.pawnItemRate : 0.75;
    const refund = Math.floor((def.gold || 0) * rate);
    const p = this.playerOf(u);
    if (p) p.gold = (p.gold || 0) + refund;
    u.items = u.items.filter((x) => x !== it);
    this.recalc(u);
    this.fireUnitEvent('EVENT_PLAYER_UNIT_PAWN_ITEM', { unit: u, item: it, player: p });
    this.removeItem(it);
    return refund;
  }

  /** A spot near (x, y) with no other item already lying on it. */
  freeItemSpot(x, y) {
    const taken = (px, py) => [...this.items.values()].some(
      (o) => !o.owner && !o.hidden && Math.hypot(o.x - px, o.y - py) < ITEM_REACH);
    if (!taken(x, y) && this.walkable(x, y)) return [x, y];
    for (let r = ITEM_REACH; r <= ITEM_REACH * 4; r += ITEM_REACH) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
        if (!taken(px, py) && this.walkable(px, py)) return [px, py];
      }
    }
    return [x, y];
  }

  /**
   * Order a unit to fetch an item, the way a right-click does in Warcraft III.
   *
   * The unit walks to it and takes it on arrival; it is not teleported into the
   * inventory. MiscData's FollowItemRange bounds how far it will go.
   */
  orderPickup(u, it) {
    if (!u || !u.alive || !it || it.owner || it.hidden) return false;
    if (Math.hypot(it.x - u.x, it.y - u.y) > FOLLOW_ITEM_RANGE) return false;
    if (this.reachesItem(u, it)) return this.takeItem(u, it);
    u.path = this.grid.path(u.x, u.y, it.x, it.y);
    u.order = { type: 'pickup', itemId: it.id, x: it.x, y: it.y };
    // Warcraft III issues this as a targeted order like any other
    this.fireUnitEvent('EVENT_PLAYER_UNIT_ISSUED_TARGET_ORDER',
      { unit: u, orderTargetItem: it, orderId: 'smart', player: this.playerOf(u) });
    return true;
  }

  reachesItem(u, it) {
    return Math.hypot(it.x - u.x, it.y - u.y) <= ITEM_REACH + (u.radius || 24);
  }

  /** Pick it up, and stop walking towards it either way. */
  takeItem(u, it) {
    if (!it || it.owner) return false;
    const got = this.giveItem(u, it);
    if (got) {
      u.path = null;
      if (u.order && u.order.type === 'pickup') u.order = { type: 'idle' };
    }
    return got;
  }

  /**
   * Items in the world, once per tick.
   *
   * Two things happen here, both Warcraft III's rules: a unit that was sent to
   * fetch an item takes it when it arrives, and a *powerup* is taken by anyone
   * who simply walks over it -- that is what makes a rune a rune. Ordinary
   * items sit there until someone is told to pick them up.
   */
  stepItems() {
    for (const u of this.units.values()) {
      if (!u.alive || !u.order || u.order.type !== 'pickup') continue;
      const it = this.items.get(u.order.itemId);
      if (!it || it.owner || it.hidden) { u.order = { type: 'idle' }; u.path = null; continue; }
      if (this.reachesItem(u, it)) this.takeItem(u, it);
      else if (!u.path) u.order = { type: 'idle' };      // could not get there
    }
    for (const it of [...this.items.values()]) {
      if (it.owner || it.hidden || !it.powerup) continue;
      for (const u of this.units.values()) {
        if (!u.alive || u.hidden || !u.isHero) continue;
        if (!this.reachesItem(u, it)) continue;
        this.giveItem(u, it);                            // consumes it
        break;
      }
    }
  }

  /** Use a carried item: its own ability data says what that does. */
  useItem(u, it) {
    if (!u || !it) return false;
    const eff = itemUse(it);
    if (eff) {
      if (eff.kind === 'heal') this.heal(u, eff.amount);
      else if (eff.kind === 'mana') u.mana = Math.min(u.maxMana, u.mana + eff.amount);
      else if (eff.kind === 'xp') this.addXp(u, eff.amount);
    }
    this.fireUnitEvent('EVENT_PLAYER_UNIT_USE_ITEM',
                       { unit: u, item: it, player: this.playerOf(u) });
    if (it.charges > 0 && --it.charges <= 0) this.dropItem(u, it);
    return true;
  }
  dropItemSlot(u, s) {
    if (!u || !u.items[s]) return false;
    return this.dropItem(u, u.items[s]);
  }

  // ---------------------------------------------------------------- players
  isAlly(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const key = `${a.index}:${b.index}`;
    if (this.alliances.has(key)) return this.alliances.get(key);
    return a.team === b.team;
  }
  setAlliance(a, b, on) {
    if (!a || !b) return;
    this.alliances.set(`${a.index}:${b.index}`, !!on);
  }
  /** WC3 player score categories (see the supplement's PLAYER_SCORE_* ids). */
  score(p, k) { return p && p.score ? (p.score[k] || 0) : 0; }
  addScore(p, k, n = 1) { if (p) { p.score = p.score || {}; p.score[k] = (p.score[k] || 0) + n; } }

  playerState(p, st) {
    if (!p) return 0;
    if (st === PS_GOLD) return Math.round(p.gold);
    if (st === PS_LUMBER) return Math.round(p.lumber);
    return 0;
  }
  setPlayerState(p, st, v) {
    if (!p) return;
    if (st === PS_GOLD) p.gold = v;
    else if (st === PS_LUMBER) p.lumber = v;
  }

  // ----------------------------------------------------- ability engine glue
  abilKey(k) { return typeof k === 'number' ? int2id(k) : k; }
  /**
   * Warcraft III's neutral-passive slot (15) never fights and is never fought;
   * neutral-aggressive (12) is hostile to every player. Picker props are inert.
   */
  hostile(a, b) {
    if (!a || !b || a === b) return false;
    if (a.pickerProp || b.pickerProp) return false;
    if (a.playerIndex === NEUTRAL_PASSIVE || b.playerIndex === NEUTRAL_PASSIVE) return false;
    if (a.playerIndex === NEUTRAL_HOSTILE || b.playerIndex === NEUTRAL_HOSTILE)
      return a.playerIndex !== b.playerIndex;
    return !this.isAlly(this.playerOf(a), this.playerOf(b));
  }
  enemiesInRange(caster, x, y, r) {
    return this.enumInRange(x, y, r).filter((e) => this.hostile(caster, e) && !e.isBuilding);
  }
  alliesInRange(caster, x, y, r) {
    return this.enumInRange(x, y, r).filter((e) => !this.hostile(caster, e));
  }
  heal(u, amt) {
    if (!u || !u.alive) return;
    u.hp = Math.min(u.maxHp, u.hp + amt);
    this.emit({ t: 'heal', id: u.id, amt: Math.round(amt) });
  }
  applyBuff(u, b) {
    if (!u || !u.alive) return;
    u.buffs = (u.buffs || []).filter((x) => x.kind !== b.kind);
    u.buffs.push(b);
    this.recalc(u);
  }
  stunned(u) { return (u.buffs || []).some((b) => b.kind === 'stun' && b.until > this.now); }
  silenced(u) { return (u.buffs || []).some((b) => b.kind === 'silence' && b.until > this.now); }
  /**
   * Metamorphosis: the hero becomes another unit type for a while.
   *
   * Warcraft III implements this by swapping the unit for the alternate form the
   * ability names in its `unit` field, then swapping it back when the buff runs
   * out -- it is a genuine change of unit type, which is why Metamorphosis
   * carries no effect art of its own: the new body *is* the effect.
   *
   * The hero keeps its identity across the change: same level, experience,
   * skills and inventory. Life and mana carry as fractions rather than values,
   * so entering a form with a larger pool does not heal you for the privilege,
   * and leaving one does not kill you.
   */
  morph(u, typeKey, seconds) {
    const t = this.type(typeKey);
    if (!u || !t) return false;
    const hpFrac = u.maxHp > 0 ? u.hp / u.maxHp : 1;
    const manaFrac = u.maxMana > 0 ? u.mana / u.maxMana : 0;
    if (!u.morphed) {
      const saved = {};
      for (const k of MORPH_FIELDS) saved[k] = u[k];
      u.morphed = { saved, until: 0 };
    }
    u.typeId = id2int(typeKey);
    u.typeKey = int2id(u.typeId);
    u.model = t.model || '';
    u.icon = t.icon || '';
    u.armor = t.armor || 0;
    u.armorType = t.armorType || 'none';
    u.atkType = t.atkType || 'normal';
    u.dmgBase = t.dmgBase || 0;
    u.dmgDice = t.dmgDice || 1;
    u.dmgSides = t.dmgSides || 1;
    u.atkCd = Math.max(0.2, t.atkCd || 1.5);
    u.atkRange = t.atkRange || 90;
    u.missile = t.missile || null;
    u.missileSpeed = t.missileSpeed || 0;
    u.missileArc = t.missileArc || 0;
    u.missileHoming = t.missileHoming || 0;
    u.baseMoveSpeed = t.moveSpeed || u.baseMoveSpeed;
    u.radius = Math.max(8, t.collision || u.radius);
    u.renderScale = t.scale || 1;
    u.hpReg = t.hpReg || 0;
    u.manaReg = t.manaReg || 0.01;
    if (t.str_ != null) { u.str = t.str_; u.strLvl = t.strLvl || 0; }
    if (t.agi != null) { u.agi = t.agi; u.agiLvl = t.agiLvl || 0; }
    if (t.int_ != null) { u.intel = t.int_; u.intLvl = t.intLvl || 0; }
    u.morphed.until = this.now + Math.max(1, seconds || 0) * 1000;
    this.recalc(u);
    if (!u.isHero) {
      u.maxHp = Math.max(1, t.hp || u.maxHp);
      u.maxMana = t.mana || u.maxMana;
    }
    u.hp = Math.max(1, Math.round(u.maxHp * hpFrac));
    u.mana = Math.round(u.maxMana * manaFrac);
    this.emit({ t: 'morph', id: u.id, u: u.typeKey });
    return true;
  }

  /** Back to the shape it started in, keeping whatever it earned meanwhile. */
  unmorph(u) {
    if (!u || !u.morphed) return false;
    const hpFrac = u.maxHp > 0 ? u.hp / u.maxHp : 1;
    const manaFrac = u.maxMana > 0 ? u.mana / u.maxMana : 0;
    for (const k of MORPH_FIELDS) u[k] = u.morphed.saved[k];
    u.morphed = null;
    this.recalc(u);
    u.hp = Math.max(1, Math.round(u.maxHp * hpFrac));
    u.mana = Math.round(u.maxMana * manaFrac);
    this.emit({ t: 'morph', id: u.id, u: u.typeKey });
    return true;
  }

  summon(owner, typeKey, x, y, seconds, opts = {}) {
    const p = this.playerOf(owner);
    const u = this.createUnit(p, typeKey, x, y, owner.facing / DEG);
    if (!u) return null;
    u.expireAt = this.now + Math.max(1, seconds) * 1000;
    u.summonedBy = owner.id;
    if (opts.image) { u.maxHp = Math.max(1, u.maxHp * 0.2); u.hp = u.maxHp; }
    return u;
  }

  /**
   * Fountains: units carrying Warcraft III's neutral-regen abilities restore a
   * fraction of max life/mana per second to everything in range, friend or foe.
   */
  stepFountains() {
    if (this._fountains === undefined || this.tick % 30 === 0) {
      this._fountains = [];
      for (const u of this.units.values()) {
        if (!u.alive || !u.abilities || !u.abilities.size) continue;
        for (const [key, lvl] of u.abilities) {
          const ab = abilEntry(int2id(key));
          if (!ab) continue;
          if (ab.base !== 'ACnr' && ab.base !== 'ANre') continue;
          const i = levelInfo(ab, lvl || 1);
          this._fountains.push({ u, mana: ab.base === 'ANre',
                                 rate: i.data1 || 0.01, area: i.area || 500 });
        }
      }
    }
    for (const fo of this._fountains) {
      if (!fo.u.alive) continue;
      for (const e of this.enumInRange(fo.u.x, fo.u.y, fo.area)) {
        if (!e.alive || e === fo.u || e.isBuilding) continue;
        if (fo.mana) {
          if (e.maxMana > 0) e.mana = Math.min(e.maxMana, e.mana + e.maxMana * fo.rate * this.dt);
        } else if (e.hp < e.maxHp) {
          e.hp = Math.min(e.maxHp, e.hp + e.maxHp * fo.rate * this.dt);
        }
      }
    }
  }

  /** Repeated area damage over time, as channelled spells do. */
  channel(caster, x, y, radius, perWave, waves, interval, followCaster = false) {
    this.channels = this.channels || [];
    this.channels.push({ caster, x, y, radius, perWave, left: waves,
                         nextAt: this.now, interval: interval * 1000, followCaster });
  }

  stepChannels() {
    if (!this.channels || !this.channels.length) return;
    for (const c of this.channels) {
      if (c.left <= 0) continue;
      if (this.now < c.nextAt) continue;
      c.nextAt = this.now + c.interval;
      c.left--;
      if (!c.caster.alive) { c.left = 0; continue; }
      const cx = c.followCaster ? c.caster.x : c.x;
      const cy = c.followCaster ? c.caster.y : c.y;
      for (const e of this.enemiesInRange(c.caster, cx, cy, c.radius))
        this.damage(c.caster, e, c.perWave, { spell: true });
      this.emit({ t: 'aoe', x: Math.round(cx), y: Math.round(cy), r: Math.round(c.radius) });
    }
    this.channels = this.channels.filter((c) => c.left > 0);
  }

  /** The engine-level behaviour of an ability the unit carries. */
  runAbility(u, key, o) {
    const ab = abilEntry(this.abilKey(key));
    if (!ab) return { ok: false, reason: 'unknown ability' };
    return abilExecute(this, u, ab, this.abilityLevel(u, key) || 1, o);
  }

  /** A dummy unit ordered to cast: run the one active ability it carries. */
  castDummy(u, o) {
    if (!u || !u.abilities) return false;
    for (const [key] of u.abilities) {
      const ab = abilEntry(int2id(key));
      if (!ab || isPassive(ab)) continue;
      this.runAbility(u, key, o);
      return true;
    }
    return false;
  }

  // ------------------------------------------------ player-driven interactions
  /** Buy a hero from a tavern exactly as the map expects (fires EVENT_PLAYER_UNIT_SELL). */
  sellUnit(seller, buyerPlayer, unitTypeId) {
    if (!this.jass) return null;
    // the map's pick area is a sealed pocket; the web lobby replaces it, so a
    // bought hero starts at its team's base like it would after being teleported
    const base = this.teamBase(buyerPlayer ? buyerPlayer.team : 0);
    const x = base[0];
    const y = base[1];
    const u = this.createUnit(buyerPlayer, unitTypeId, x + (Math.random() - 0.5) * 200,
                              y + (Math.random() - 0.5) * 200, 270);
    u.controlled = true;
    this.jass.fire('unitEvent:' + this.jass.eventId('EVENT_PLAYER_UNIT_SELL'),
                   { unit: u, sold: u, seller, buyer: seller, player: buyerPlayer });
    return u;
  }

  /** Buy an item from a shop, raising the map's own sell-item event. */
  sellItem(seller, buyerUnit, itemTypeId) {
    const it = this.createItem(itemTypeId, buyerUnit ? buyerUnit.x : 0, buyerUnit ? buyerUnit.y : 0);
    if (!this.giveItem(buyerUnit, it)) { this.removeItem(it); return null; }
    this.fireUnitEvent('EVENT_PLAYER_UNIT_SELL_ITEM',
      { unit: seller, buyer: buyerUnit, seller, soldItem: it, item: it,
        player: this.playerOf(buyerUnit) });
    return it;
  }

  /** Find the shop that stocks a given item type. */
  shopFor(itemKey) {
    for (const u of this.units.values()) if (u.sellItems && u.sellItems.includes(itemKey)) return u;
    return null;
  }

  /** Find the tavern that sells a given hero type. */
  tavernFor(typeKey) {
    for (const u of this.units.values()) {
      if (u.sellUnits && u.sellUnits.includes(typeKey)) return u;
    }
    return null;
  }

  /**
   * Cast an ability. Engine checks level/mana/cooldown, then hands off to the
   * map's own spell trigger via EVENT_PLAYER_UNIT_SPELL_EFFECT.
   */
  castAbility(u, abilId, targetUnit, tx, ty) {
    if (!u || !u.alive || !this.jass) return { ok: false, reason: 'dead' };
    const key = typeof abilId === 'number' ? abilId : id2int(abilId);
    const lvl = this.abilityLevel(u, key);
    if (lvl < 1) return { ok: false, reason: 'not learned' };
    if (this.silenced(u)) return { ok: false, reason: 'silenced' };
    u.cooldowns = u.cooldowns || new Map();
    if ((u.cooldowns.get(key) || 0) > this.now) return { ok: false, reason: 'cooldown' };
    const info = this.abilityInfo(key, lvl);
    if (u.mana < info.mana) return { ok: false, reason: 'mana' };
    u.mana -= info.mana;
    u.cooldowns.set(key, this.now + info.cooldown * 1000);
    u.facing = Math.atan2((ty ?? u.y) - u.y, (tx ?? u.x) - u.x);
    const abil = abilEntry(this.abilKey(key));
    // The ability names the animation it wants, as a Warcraft III token set:
    // "spell,slam", "attack,slam", "spell,throw", "stand,channel". 257 of this
    // map's abilities carry one and nothing had ever read it, so every cast
    // played whichever clip happened to be called "Spell".
    this.emit({ t: 'cast', id: u.id, ab: int2id(key), anim: abil?.art?.anim || null });
    // 1. the engine performs the base Warcraft III ability, and draws the art
    //    that ability carries.  An ability with a missile hands its payload to
    //    the missile instead, and resolves when that lands.
    if (!this.launchAbilityMissile(u, abil, key, { target: targetUnit, x: tx, y: ty })) {
      this.runAbility(u, key, { target: targetUnit, x: tx, y: ty });
    }
    this.emitAbilityArt(abil, u, targetUnit, tx ?? u.x, ty ?? u.y);
    // 2. the map's own trigger adds its bespoke effects on top
    const ctx = { unit: u, spellId: key, targetUnit: targetUnit || null,
                  targetX: tx ?? u.x, targetY: ty ?? u.y, player: this.playerOf(u) };
    for (const name of ['EVENT_PLAYER_UNIT_SPELL_CHANNEL', 'EVENT_PLAYER_UNIT_SPELL_CAST',
                        'EVENT_PLAYER_UNIT_SPELL_EFFECT', 'EVENT_PLAYER_UNIT_SPELL_FINISH',
                        'EVENT_PLAYER_UNIT_SPELL_ENDCAST']) {
      const key = this.jass.eventId(name);
      if (key != null) this.jass.fire(key, ctx);
    }
    return { ok: true };
  }

  abilityInfo(key, lvl) {
    const a = abilEntry(this.abilKey(key));
    if (!a) return { cooldown: 6, mana: 0 };
    const L = levelInfo(a, lvl);
    return { cooldown: L.cooldown || 0, mana: L.mana || 0,
             range: L.range || 0, area: L.area || 0, name: a.name };
  }

  /** Chat reaches the map's own mode/command triggers. */
  chat(playerHandle, text) {
    if (!this.jass) return;
    this.jass.fire('chat', { player: playerHandle, chat: text, chatMatched: text });
  }

  // ------------------------------------------------------------ JASS events
  fireUnitEvent(constName, ctx) {
    if (!this.jass) return;
    const key = this.jass.eventId(constName);
    if (key == null) return;
    this.jass.fire(key, ctx);
  }

  /**
   * The art Warcraft III plays for an ability itself.
   *
   * These are engine visuals, not script ones: the game draws Casterart on who
   * cast, Targetart on what was hit and Areaeffectart over the ground without
   * the map asking. FOC's triggers add their own effects on top, which is why
   * some spells look right already -- but anything relying on the ability's own
   * art was silent, because it lives in Units\*AbilityFunc.txt rather than in
   * AbilityData.slk and so never reached the runtime at all.
   *
   * They are one-shot, unlike a script's AddSpecialEffect, which lives until
   * DestroyEffect: the client drops them once `ttl` has passed.
   */
  emitAbilityArt(ab, caster, target, tx, ty) {
    const art = ab && ab.art;
    if (!art) return;
    const at = (path, unit, x, y) => {
      // an art field may list several models; Warcraft III draws the first
      const p = String(path || '').split(',')[0].trim();
      if (!p || p === '_' || p === '-') return;
      const fx = -(++this.fxSeq);          // negative: never collides with JASS ids
      if (unit) this.emit({ t: 'sfxUnit', fx, path: p, id: unit.id, ttl: ART_TTL });
      else this.emit({ t: 'sfx', fx, path: p, x, y, ttl: ART_TTL });
    };
    at(art.caster, caster);
    // a unit-target spell hangs its art on the unit; a point-target one drops
    // it where it landed
    if (target) at(art.target, target);
    else at(art.target, null, tx, ty);
    at(art.special, null, tx, ty);
    at(art.area, null, tx, ty);
    // Effectart is the fourth of Warcraft III's art slots and was being skipped:
    // it plays where the spell lands, and 103 abilities here carry one.
    if (target) at(art.effect, target);
    else at(art.effect, null, tx, ty);
  }

  emit(e) { this.clientEvents.push(e); }
  flushEvents() { const e = this.clientEvents; this.clientEvents = []; return e; }

  // -------------------------------------------------------------------- step
  step() {
    this.now += this.dt * 1000;
    this.tick++;
    this.stepMissiles();
    this.stepItems();
    const alive = [];
    for (const u of this.units.values()) {
      if (!u.alive) continue;
      if (u.expireAt && this.now > u.expireAt) { this.killUnit(u, null); continue; }
      u.buffs = u.buffs.filter((b) => !b.until || b.until > this.now);
      if (u.morphed && u.morphed.until && this.now > u.morphed.until) this.unmorph(u);
      if (u.isHero) {
        u.hp = Math.min(u.maxHp, u.hp + (u.hpReg || 0.5) * this.dt);
        u.mana = Math.min(u.maxMana, u.mana + u.maxMana * (u.manaReg || 0.01) * this.dt);
      } else if (u.hpReg) {
        u.hp = Math.min(u.maxHp, u.hp + u.hpReg * this.dt);
      }
      if (u.paused || this.stunned(u)) continue;
      if (u.immolation) {
        for (const e of this.enemiesInRange(u, u.x, u.y, u.immolation.area))
          this.damage(u, e, u.immolation.dps * this.dt, { spell: true });
      }
      alive.push(u);
      this.stepAI(u);
      this.stepMove(u);
      this.stepAttack(u);
    }
    this.stepChannels();
    this.stepFountains();
    this.separate(alive);
    this.checkUnitInRange(alive);
    this.checkWaygates(alive);
    this.checkRegions(alive);
    return this.flushEvents();
  }

  /**
   * Creeps and neutral-hostile units pick their own targets; players drive heroes.
   * Acquisition uses each unit type's own range (UnitWeapons.slk 'acquire'), and
   * straying is leashed to the spawn point by the MiscGame.txt guard constants.
   * A unit under a scripted order (attackMove, a waypoint march) is left alone --
   * the map's own orders outrank guard behaviour.
   */
  stepAI(u) {
    if (u.controlled || u.isBuilding || u.pickerProp) return;   // players drive their own heroes
    if (u.playerIndex === NEUTRAL_PASSIVE) return;              // shops and props never fight
    if (u.returning) { this.stepReturnHome(u); return; }
    if (u.order.type !== 'idle' && u.order.type !== 'attack') return;

    const fromHome = Math.hypot(u.x - u.homeX, u.y - u.homeY);
    if (u.order.type === 'attack' && fromHome > GUARD_DIST) {
      if (!u.strayedAt) u.strayedAt = this.now;
      const chasing = this.now - Math.max(u.strayedAt, u.lastAttackedAt);
      if (fromHome > MAX_GUARD_DIST || chasing >= GUARD_RETURN_MS) return this.sendHome(u);
    } else {
      u.strayedAt = 0;
      if (fromHome > MAX_GUARD_DIST) return this.sendHome(u);
    }

    // Acquisition range picks a *new* target; it does not drop the current one.
    // A unit keeps chasing what it acquired until the guard rules above turn it
    // around -- otherwise nothing would ever stray far enough to be leashed.
    if (u.order.type === 'attack') {
      const t = this.units.get(u.order.targetId);
      if (t && t.alive && !t.hidden) return;
      u.order = { type: 'idle' }; u.path = null;
    }

    let best = null, bd = Infinity;
    for (const o of this.enumInRange(u.x, u.y, u.acquisitionRange)) {
      if (!o.alive || o === u || o.hidden || o.isBuilding) continue;
      if (this.isAlly(this.playerOf(u), this.playerOf(o))) continue;
      // no point acquiring prey that already stands outside this unit's post
      if (Math.hypot(o.x - u.homeX, o.y - u.homeY) > MAX_GUARD_DIST) continue;
      const d = Math.hypot(o.x - u.x, o.y - u.y);
      if (d < bd) { bd = d; best = o; }
    }
    if (best) u.order = { type: 'attack', targetId: best.id };
  }

  /** Turn a strayed guard around; it ignores targets until it is back on post. */
  sendHome(u) {
    u.returning = true; u.strayedAt = 0;
    u.order = { type: 'move', x: u.homeX, y: u.homeY };
    u.path = this.grid.path(u.x, u.y, u.homeX, u.homeY);
  }

  stepReturnHome(u) {
    if (Math.hypot(u.x - u.homeX, u.y - u.homeY) <= 64) {
      u.returning = false; u.order = { type: 'idle' }; u.path = null; return;
    }
    if (u.path && u.path.length) return;
    u.path = this.grid.path(u.x, u.y, u.homeX, u.homeY);
    u.order = { type: 'move', x: u.homeX, y: u.homeY };
    if (!u.path || !u.path.length) { u.returning = false; u.order = { type: 'idle' }; }
  }

  /**
   * MiscGame.txt CallForHelp / CreepCallForHelp: when a unit is hit, idle
   * neighbours within range join the fight -- this is what makes a creep camp
   * aggro as a group instead of one at a time.
   */
  callForHelp(victim, attacker) {
    if (!attacker.alive || victim.controlled) return;
    const r = victim.playerIndex === NEUTRAL_HOSTILE ? CREEP_CALL_FOR_HELP : CALL_FOR_HELP;
    for (const o of this.enumInRange(victim.x, victim.y, r)) {
      if (o === victim || !o.alive || o.controlled || o.isBuilding || o.pickerProp) continue;
      if (o.playerIndex === NEUTRAL_PASSIVE || o.returning) continue;
      if (o.order.type !== 'idle') continue;
      if (!this.isAlly(this.playerOf(o), this.playerOf(victim))) continue;
      if (Math.hypot(attacker.x - o.homeX, attacker.y - o.homeY) > MAX_GUARD_DIST) continue;
      o.order = { type: 'attack', targetId: attacker.id };
    }
  }

  stepMove(u) {
    // A pursuer has to keep repathing at its target: crowding pushes units apart
    // once they close, and clinging to the waypoint from the original approach
    // left them drifting out of attack range without ever stepping back in.
    if (u.order.type === 'attack') {
      const t = this.units.get(u.order.targetId);
      if (t && t.alive) {
        if (Math.hypot(t.x - u.x, t.y - u.y) > u.atkRange + t.radius) {
          if (!u.path || !u.path.length || (u.repathAt ?? 0) < this.now) {
            u.path = this.grid.path(u.x, u.y, t.x, t.y);
            u.repathAt = this.now + 400;
          }
        } else {
          u.path = null;               // in range: hold position and fight
        }
      }
    }
    let tx = null, ty = null;
    if (u.path && u.path.length) [tx, ty] = u.path[0];
    if (tx == null) return;
    const dx = tx - u.x, dy = ty - u.y, d = Math.hypot(dx, dy);
    const stepLen = u.moveSpeed * this.dt;
    if (d <= stepLen) {
      u.x = tx; u.y = ty; u.path.shift();
      if (!u.path.length) { u.path = null; if (u.order.type === 'move') u.order = { type: 'idle' }; }
    } else {
      const nx = u.x + (dx / d) * stepLen, ny = u.y + (dy / d) * stepLen;
      if (this.walkable(nx, ny)) { u.x = nx; u.y = ny; } else u.path = null;
      u.facing = Math.atan2(dy, dx);
    }
  }

  /**
   * A shot in flight.
   *
   * Warcraft III resolves a ranged attack when the missile arrives, not when it
   * is loosed: `Missilespeed` from the weapon decides how long that takes. The
   * damage still belongs to the unit that was aimed at -- an arrow does not miss
   * because its target walked -- but a target that dies first is simply never
   * hit, and that gap is the whole point of giving missiles travel time.
   */
  launchMissile(src, target, opts = {}) {
    const speed = opts.speed || 0;
    // `target` is either a unit to home on or a fixed {x, y} to fly at.  A spell
    // aimed at the ground still has to land there even if whoever was standing
    // on it dies first, so a point shot carries no targetId and always impacts.
    const unit = target && target.id != null ? target : null;
    const dest = target ? { x: target.x, y: target.y } : null;
    if (!src || !dest || speed <= 0) return null;
    const m = {
      fx: ++this.fxSeq,
      srcId: src.id, targetId: unit ? unit.id : null,
      dx: dest.x, dy: dest.y,
      x: src.x, y: src.y,
      speed,
      arc: opts.arc || 0,
      art: opts.art || null,
      onHit: opts.onHit || null,
      // a shot that can never land must not sit in the list for ever
      deadline: this.now + Math.max(1500, (Math.hypot(dest.x - src.x, dest.y - src.y) / speed) * 3000),
    };
    this.missiles.push(m);
    if (m.art) {
      this.emit({ t: 'missile', fx: m.fx, path: m.art, x: src.x, y: src.y,
                  tx: dest.x, ty: dest.y, id: m.targetId, speed, arc: m.arc });
    }
    return m;
  }

  /**
   * Send an ability's payload as a missile, when the ability carries one.
   *
   * Warcraft III resolves a ranged spell when its missile arrives: the caster's
   * animation and the map's trigger fire at once, the damage waits. The ability
   * names the missile itself -- `Missileart`, `Missilespeed`, `Missilearc` in
   * Units\*AbilityFunc.txt -- so nothing here needs a list of which spells fly.
   *
   * Only the *engine* behaviour is deferred. The map's own trigger still runs at
   * cast time, because in the real game that is when it runs.
   *
   * Returns true when the payload has been handed to a missile.
   */
  launchAbilityMissile(caster, ab, key, o) {
    const art = ab && ab.art;
    const speed = art && Number(art.missileSpeed);
    if (!art || !art.missile || !(speed > 0)) return false;
    const target = o.target && o.target.alive ? o.target : null;
    const tx = o.x ?? (target ? target.x : caster.x);
    const ty = o.y ?? (target ? target.y : caster.y);
    // a spell that goes off where the caster stands has nothing to travel
    if (!target && Math.hypot(tx - caster.x, ty - caster.y) < 64) return false;
    const dest = target || { x: tx, y: ty };
    const m = this.launchMissile(caster, dest, {
      speed,
      arc: Number(art.missileArc) || 0,
      art: String(art.missile).split(',')[0].trim(),
      onHit: (src, hitUnit, hx, hy) => {
        if (!src) return;                    // the caster died in flight
        this.runAbility(src, key, { target: hitUnit || null, x: hx ?? tx, y: hy ?? ty });
      },
    });
    return !!m;
  }

  stepMissiles() {
    if (!this.missiles.length) return;
    const step = this.dt;
    const keep = [];
    for (const m of this.missiles) {
      const t = m.targetId != null ? this.units.get(m.targetId) : null;
      // a homing shot whose target died or left is spent, and damages nothing
      if (m.targetId != null && (!t || !t.alive)) {
        this.emit({ t: 'missileEnd', fx: m.fx });
        continue;
      }
      const aimX = t ? t.x : m.dx, aimY = t ? t.y : m.dy;
      const dx = aimX - m.x, dy = aimY - m.y;
      const dist = Math.hypot(dx, dy);
      const travel = m.speed * step;
      if (dist <= travel + ((t && t.radius) || 0) || this.now > m.deadline) {
        m.x = aimX; m.y = aimY;
        this.emit({ t: 'missileEnd', fx: m.fx });
        const src = this.units.get(m.srcId);
        if (m.onHit) m.onHit(src && src.alive ? src : null, t, aimX, aimY);
        continue;
      }
      m.x += (dx / dist) * travel;
      m.y += (dy / dist) * travel;
      keep.push(m);
    }
    this.missiles = keep;
  }

  stepAttack(u) {
    if (u.atkTimer > 0) u.atkTimer -= this.dt;
    if (u.order.type !== 'attack' && u.order.type !== 'attackMove') return;
    let t = this.units.get(u.order.targetId);
    if (!t || !t.alive) {
      let bd = Infinity; t = null;
      for (const o of this.units.values()) {
        if (!o.alive || o === u || o.hidden) continue;
        if (this.isAlly(this.playerOf(u), this.playerOf(o))) continue;
        const d = Math.hypot(o.x - u.x, o.y - u.y);
        if (d < u.atkRange + o.radius + 40 && d < bd) { bd = d; t = o; }
      }
      if (!t) return;
    }
    const d = Math.hypot(t.x - u.x, t.y - u.y);
    if (d > u.atkRange + t.radius) return;
    u.facing = Math.atan2(t.y - u.y, t.x - u.x);
    if (u.atkTimer > 0) return;
    u.atkTimer = u.atkCd / Math.max(0.2, u.attackSpeedMul || 1);
    const dice = Math.floor(Math.random() * Math.max(1, u.dmgSides)) + 1;
    const amount = (u.dmg ?? u.dmgBase) + (u.dmgDice > 0 ? dice : 0);
    this.emit({ t: 'attack', id: u.id, target: t.id });
    // Warcraft III fires ATTACKED when the swing starts; the damage waits for the
    // missile to arrive.
    this.fireUnitEvent('EVENT_PLAYER_UNIT_ATTACKED', {
      unit: t, attacker: u, player: this.playerOf(t) });
    const land = (src, victim) => {
      const hs = this.unitSound(u, 'hit');     // weapon impact, as the engine plays it
      if (hs) this.emit({ t: 'sound', path: hs.path, x: victim.x, y: victim.y,
                          vol: hs.vol * 0.7, pitch: hs.pitch });
      if (!src) return;                        // the shooter died mid-flight
      if (src.cleave) {
        for (const e of this.enemiesInRange(src, victim.x, victim.y, 150))
          if (e !== victim) this.damage(src, e, amount * src.cleave, {});
      }
      const dealt = this.damage(src, victim, amount, {});
      if (src.lifesteal && dealt > 0) this.heal(src, dealt * src.lifesteal);
    };
    if (u.missileSpeed > 0 && this.launchMissile(u, t, {
          speed: u.missileSpeed, arc: u.missileArc, art: u.missile, onHit: land })) return;
    land(u, t);                                // melee, or a weapon with no missile
  }

  separate(list) {
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.isBuilding) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.isBuilding) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const need = a.radius + b.radius;
        const d2 = dx * dx + dy * dy;
        if (d2 >= need * need) continue;
        let d = Math.sqrt(d2), ux, uy;
        if (d < 1e-3) {                        // exactly coincident: pick a direction
          const ang = (((a.id * 2654435761) ^ b.id) % 628) / 100;
          ux = Math.cos(ang); uy = Math.sin(ang); d = 0;
        } else { ux = dx / d; uy = dy / d; }
        const push = (need - d) / 2;
        const ax = a.x - ux * push, ay = a.y - uy * push;
        const bx = b.x + ux * push, by = b.y + uy * push;
        if (this.walkable(ax, ay)) { a.x = ax; a.y = ay; }
        if (this.walkable(bx, by)) { b.x = bx; b.y = by; }
      }
    }
  }

  /** "unit comes within range of X" registrations. */
  checkUnitInRange(list) {
    if (!this.jass) return;
    for (const tr of this.jass.triggers) {
      for (const ev of tr.events) {
        if (ev.kind !== 'unitInRange' || !ev.unit || !ev.unit.alive) continue;
        ev._in = ev._in || new Set();
        for (const u of list) {
          if (u === ev.unit) continue;
          const near = Math.hypot(u.x - ev.unit.x, u.y - ev.unit.y) <= (ev.range || 200);
          if (near && !ev._in.has(u.id)) {
            ev._in.add(u.id);
            this.jass.execTrigger(tr, { unit: u, player: this.playerOf(u) });
          } else if (!near) ev._in.delete(u.id);
        }
      }
    }
  }

  /** Units that walk onto an active waygate are moved to its destination. */
  checkWaygates(list) {
    const gates = [];
    for (const g of this.units.values()) if (g.alive && g.waygate && g.waygate.active) gates.push(g);
    if (!gates.length) return;
    for (const u of list) {
      if (u.isBuilding || u.waygate) continue;
      for (const g of gates) {
        if (Math.hypot(u.x - g.x, u.y - g.y) > (g.radius || 64) + u.radius) continue;
        if (u.lastGate === g.id && this.now - (u.lastGateAt || 0) < 2000) continue;
        const c = this.grid.nearestWalkable(g.waygate.x, g.waygate.y);
        if (!c) continue;
        [u.x, u.y] = this.grid.toWorld(c[0], c[1]);
        u.path = null; u.lastGate = g.id; u.lastGateAt = this.now;
        this.emit({ t: 'teleport', id: u.id, x: Math.round(u.x), y: Math.round(u.y) });
        break;
      }
    }
  }

  /** Enter/leave region events for triggers that registered rects. */
  checkRegions(list) {
    if (!this.jass) return;
    for (const tr of this.jass.triggers) {
      for (const ev of tr.events) {
        if (ev.kind !== 'enter' && ev.kind !== 'leave') continue;
        ev._in = ev._in || new Set();
        for (const u of list) {
          const inside = u.x >= ev.rect.minx && u.x <= ev.rect.maxx
                      && u.y >= ev.rect.miny && u.y <= ev.rect.maxy;
          const was = ev._in.has(u.id);
          if (inside && !was) {
            ev._in.add(u.id);
            if (ev.kind === 'enter') this.jass.execTrigger(tr, { unit: u, player: this.playerOf(u), x: u.x, y: u.y });
          } else if (!inside && was) {
            ev._in.delete(u.id);
            if (ev.kind === 'leave') this.jass.execTrigger(tr, { unit: u, player: this.playerOf(u), x: u.x, y: u.y });
          }
        }
      }
    }
  }

  /** Locust, and no model to draw: an invisible spell-carrier, not a unit. */
  isDummy(u) {
    if (this._dummyTypes === undefined) this._dummyTypes = new Map();
    let d = this._dummyTypes.get(u.typeKey);
    if (d === undefined) {
      const t = this.type(u.typeId) || {};
      const model = String(t.model || '').replace(/\.(mdl|mdx)$/i, '').trim();
      // the map spells "there is no model" several ways; what they share is that
      // none of them name anything that was ever converted
      const named = model && /[\x00-\x7f]/.test(model);
      d = (t.abilities || []).includes('Aloc') && !named;
      this._dummyTypes.set(u.typeKey, d);
    }
    return d;
  }

  /** The colour index whose TeamColor/TeamGlow textures this unit wears. */
  playerColorOf(u) {
    const p = this.jass && this.jass.players && this.jass.players[u.playerIndex];
    const c = p && p.color;
    return typeof c === 'number' ? c : (u.playerIndex ?? 0);
  }

  /** Compact wire snapshot for clients. */
  snapshot() {
    const ents = [];
    for (const u of this.units.values()) {
      if (u.hidden || u.removed || u.pickerProp) continue;
      // A Locust unit with no model is a dummy the map casts spells through.
      // Warcraft III never shows one, and this map leaks them -- Byakuya's Senka
      // creates one per cast and never removes it, as the original does too. They
      // stay in the simulation, because a trigger counting units of a type would
      // notice if they vanished; they simply stop being sent to a client that
      // has nothing to draw for them.
      if (this.isDummy(u)) continue;
      ents.push({ i: u.id, k: u.isHero ? 1 : u.isBuilding ? 3 : 2,
                  u: u.typeKey, x: Math.round(u.x), y: Math.round(u.y),
                  f: +u.facing.toFixed(2), t: u.team, p: u.playerIndex,
                  // Warcraft III's team colour is the *player's* colour, which
                  // the map may reassign, and it is what the model's replaceable
                  // textures are swapped for.
                  c: this.playerColorOf(u),
                  a: u.alive ? 1 : 0,
                  h: Math.round(u.hp), H: Math.round(u.maxHp),
                  m: Math.round(u.mana), M: Math.round(u.maxMana),
                  l: u.level, mv: u.path ? 1 : 0 });
    }
    // Items lying in the world. They were tracked server-side and never sent,
    // so a dropped item existed, was owned by nobody and sat at the right
    // coordinates -- and was invisible and unreachable from the client.
    const items = [];
    for (const it of this.items.values()) {
      if (it.owner || it.hidden) continue;
      items.push({ i: it.id, u: it.typeKey, x: Math.round(it.x), y: Math.round(it.y),
                   n: it.name || '', c: it.charges || 0 });
    }
    // Warcraft III's on-screen countdown, if the map is showing one. This map
    // runs the duel clock through it, which is how a player knows how long is
    // left -- there is no day/night cycle in this map to read it from.
    let clock = null;
    for (const d of (this.jass && this.jass.timerDialogs) || []) {
      if (!d.shown || !d.timer) continue;
      clock = { title: d.title || '',
                left: Math.max(0, Math.round((d.timer.nextAt - this.now) / 100) / 10) };
      break;
    }
    return { tick: this.tick, now: Math.round(this.now), ents, items, clock };
  }
}
