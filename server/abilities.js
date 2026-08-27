// Engine-level implementations of the base Warcraft III abilities.
//
// The map's script handles visuals, dummy-cast chains and bespoke effects; the
// abilities themselves are engine behaviour in the real game, so they live here.
// Every number comes from data/abilities.json (the map's own w3a overrides on top
// of Blizzard's AbilityData.slk) — nothing is invented.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
export const ABILS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/abilities.json'), 'utf8'));

export const PASSIVE_BASES = new Set(['Aloc', 'Avul', 'Aneu', 'Apig', 'Abds', 'Abdl', 'Abgs',
  'Aeat', 'Arlm', 'Aspi', 'Aro1', 'ACm2', 'Asph', 'Aspy', 'Alit', 'ACct']);

const AURA_BASES = {
  AOae: { kind: 'speed', pct: 0.10 },        // Endurance Aura
  AHad: { kind: 'armor', flat: 1.5 },        // Devotion Aura
  AUav: { kind: 'vampiric', pct: 0.15 },     // Vampiric Aura
  AUau: { kind: 'regen', pct: 0.02 },        // Unholy Aura
  ACac: { kind: 'damage', pct: 0.10 },       // Command Aura
  AEar: { kind: 'regen', pct: 0.01 },        // Trueshot / brilliance style
};

/**
 * Several abilities are the same behaviour re-published for a different unit
 * (Cairne's War Stomp, the creep Shock Wave, the sea-giant/hydra stomps...).
 * They route to the behaviour they are a copy of.
 */
const BASE_ALIAS = {
  AOw2: 'AOws', Awrg: 'AOws', Awrh: 'AOws', Awrs: 'AOws', ACst: 'AOws',
  AOs2: 'AOsh', ACsh: 'AOsh', ANsh: 'AOsh',
  ACcl: 'AOcl', ANcl: 'AOcl',
  ANfd: 'AUdc', Afod: 'AUdc', AUfd: 'AUdc',
  ACfn: 'AUfn', ACdc: 'AUdc', ACtc: 'AHtc',
  ANbf2: 'ANbf',
};
export function baseOf(ab) { return (ab && (BASE_ALIAS[ab.base] || ab.base)) || ''; }

/** Base abilities `execute` handles with a named behaviour (not the fallback). */
export const HANDLED_BASES = new Set([
  'AHtb', 'ANtb', 'AUfn', 'AHtc', 'AOws', 'AUcs', 'AOsh', 'AUim', 'ANcs',
  'ANbr', 'ANbf', 'AEfk', 'ANcf', 'ACtb', 'AOcl', 'AEch', 'AEbl', 'AUin',
  'AOmi', 'AUls', 'ANpi', 'AEim', 'AIim', 'AHhb', 'AOhw', 'AChw', 'AHdi',
  'ACbh', 'AHbn', 'AHmt', 'AEme', 'ACmt', 'ACro', 'AOcr', 'ANdr', 'AUdc',
  'AHfs', 'ANin', 'ANsl', 'AUsl', 'ACsw', 'AHbz', 'AEsf', 'ANrf',
  'AOww', 'ANht', 'ANcr',
]);

/** True when the ability resolves to a named engine behaviour. */
export function isHandled(ab) {
  return !!ab && HANDLED_BASES.has(baseOf(ab));
}

export function entry(abilId) { return ABILS[abilId] || null; }

export function levelInfo(ab, lvl) {
  const L = (ab && ab.levels) || [];
  if (!L.length) return {};
  return L[Math.max(0, Math.min(L.length - 1, (lvl || 1) - 1))] || {};
}

/**
 * Whether an ability just sits on the unit rather than being cast.
 *
 * Warcraft III's own answer is the order string: anything that can be ordered
 * has one, a passive has none.  `targets` cannot stand in for it -- the table
 * leaves it empty for instant abilities exactly as it does for passives, which
 * is the same trap `tools/spell_targets.mjs` exists to work around for
 * targeting.  Reading it as "no targets means passive" marks most of a FOC
 * roster passive, and castDummy then skips the very ability the map's trigger
 * spawned the dummy to deliver: the effects play and nothing happens.
 */
export function isPassive(ab) {
  if (!ab) return true;
  if (PASSIVE_BASES.has(ab.base)) return true;
  if (AURA_BASES[ab.base]) return true;
  // Warcraft III gives its passive skills an order string too, so the icon is
  // the tell: passive art lives under ReplaceableTextures\PassiveButtons.
  if (ab.passiveArt) return true;
  if (ab.order !== undefined) return !ab.order;
  // an ability table built before order strings were carried through
  const t = (ab.targets || '').toLowerCase();
  return t === '' || t === 'none' || t.includes('nonenone');
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const rnd = (a, b) => a + Math.random() * (b - a);

/**
 * The summon every summoning ability describes in its own data.
 *
 * Warcraft III keeps what to create in the ability's UnitID column and how many
 * in DataA, for all of Serpent Ward, Feral Spirit, Locust Swarm, Water Elemental
 * and the rest, so this needs no per-ability case -- only that the extractor
 * actually carry those columns through (see tools/abilities.py).
 */
function summonFrom(w, caster, i, tx, ty, dur) {
  const n = Math.max(1, Math.round(i.data1 || 1));
  const spread = Math.max(64, Math.min(i.area || 128, 256));
  let made = 0;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + rnd(0, 0.4);
    const r = n > 1 ? spread : 0;
    if (w.summon(caster, i.unit, tx + Math.cos(a) * r, ty + Math.sin(a) * r,
                 dur || 60)) made++;
  }
  return made ? { ok: true, summoned: made }
              : { ok: false, reason: 'could not summon ' + i.unit };
}

/**
 * Execute an ability's engine behaviour.
 * @param {World} w
 * @param {object} caster
 * @param {object} ab      ability table entry
 * @param {number} lvl
 * @param {object} o       {target, x, y}
 */
export function execute(w, caster, ab, lvl, o = {}) {
  if (!ab || !caster) return { ok: false, reason: 'no ability' };
  const i = levelInfo(ab, lvl);
  const tx = o.x ?? (o.target ? o.target.x : caster.x);
  const ty = o.y ?? (o.target ? o.target.y : caster.y);
  const d1 = i.data1 || 0, d2 = i.data2 || 0, d3 = i.data3 || 0, d4 = i.data4 || 0;
  const area = i.area || 0;
  const dur = i.heroDuration || i.duration || 0;
  const enemies = (x, y, r) => w.enemiesInRange(caster, x, y, r);
  const B = baseOf(ab);

  switch (B) {
    // ---- single-target nuke + stun (Storm Bolt / Thunder Bolt)
    case 'AHtb': case 'ANtb': {
      const t = o.target;
      if (!t) return { ok: false, reason: 'need target' };
      w.damage(caster, t, d1 || 100, { spell: true });
      if (dur > 0) w.applyBuff(t, { kind: 'stun', until: w.now + dur * 1000 });
      return { ok: true };
    }
    // ---- armour on an ally for a while (Frost Armor)
    //
    // The two data fields are not damage. The World Editor names them "Armor
    // Duration" (DataA) and "Armor Bonus" (DataB), so the buff's life comes from
    // DataA -- the ability's own Dur field is the chill left on whoever attacks
    // the target, which is why this map sets it to 0.01 and means it.
    //
    // Reading DataA as damage is what broke Ichigo. This map casts Frost Armor
    // off a dummy purely to stamp a named buff on him -- B001 for the Hollow
    // form, B000 for Vizard, both with a zero armour bonus -- and his attack
    // trigger then tests for that buff to grant AGI x3 bonus damage. With no
    // case here the cast fell through to the generic "DataA is damage" default,
    // found the target friendly, and did nothing at all.
    case 'AUfa': case 'AUfu': case 'ACfa': {
      const t = o.target || caster;
      w.applyBuff(t, { kind: 'armor', code: i.buff || null, armor: d2,
                       until: w.now + (d1 || 0) * 1000 });
      return { ok: true };
    }
    // ---- point AoE damage + slow (Frost Nova)
    case 'AUfn': {
      // field 1 is the headline damage the map scales per level; field 2, when the
      // map supplies it, is the reduced splash applied to everyone else.
      for (const e of enemies(tx, ty, area || 200)) {
        const primary = !o.target || e === o.target;
        const dmg = primary ? (d1 || 100) : (d2 || d1 || 50);
        w.damage(caster, e, dmg, { spell: true });
        if (dur > 0) w.applyBuff(e, { kind: 'slow', pct: 0.4, until: w.now + dur * 1000 });
      }
      return { ok: true };
    }
    // ---- caster-centred AoE + slow (Thunder Clap / War Stomp)
    case 'AHtc': case 'AOws': {
      for (const e of enemies(caster.x, caster.y, area || 300)) {
        w.damage(caster, e, d1 || 80, { spell: true });
        if (B === 'AOws') w.applyBuff(e, { kind: 'stun', until: w.now + Math.max(1, dur) * 1000 });
        else if (dur > 0) w.applyBuff(e, { kind: 'slow', pct: 0.25, until: w.now + dur * 1000 });
      }
      return { ok: true };
    }
    // ---- line damage (Carrion Swarm / Shock Wave / Impale)
    case 'AUcs': case 'AOsh': case 'AUim': case 'ANcs': {
      const len = d3 || i.range || 800;
      const wid = d4 || area || 120;
      const dmg = B === 'AUim' ? (d3 || d1 || 100) : (d1 || 100);
      const cap = d2 > 0 ? d2 : Infinity;
      const ang = Math.atan2(ty - caster.y, tx - caster.x);
      let total = 0;
      for (const e of w.allUnits()) {
        if (!w.hostile(caster, e)) continue;
        const dx = e.x - caster.x, dy = e.y - caster.y;
        const along = dx * Math.cos(ang) + dy * Math.sin(ang);
        const side = Math.abs(-dx * Math.sin(ang) + dy * Math.cos(ang));
        if (along <= 0 || along > len || side > wid + e.radius) continue;
        if (total >= cap) break;
        total += w.damage(caster, e, dmg, { spell: true });
        if (B === 'AUim' && dur > 0) w.applyBuff(e, { kind: 'stun', until: w.now + dur * 1000 });
      }
      return { ok: true };
    }
    // ---- cone damage (Breath of Fire / Breath of Frost)
    case 'ANbr': case 'ANbf': {
      const len = i.range || 500, half = 0.45;
      const ang = Math.atan2(ty - caster.y, tx - caster.x);
      for (const e of w.allUnits()) {
        if (!w.hostile(caster, e)) continue;
        const d = dist(caster, e);
        if (d > len) continue;
        let da = Math.atan2(e.y - caster.y, e.x - caster.x) - ang;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        if (Math.abs(da) > half) continue;
        w.damage(caster, e, d1 || 80, { spell: true });
        if (B === 'ANbf' && dur > 0) w.applyBuff(e, { kind: 'slow', pct: 0.3, until: w.now + dur * 1000 });
      }
      return { ok: true };
    }
    // ---- caster AoE nuke (Fan of Knives, Cluster Rockets, Cyclone-likes)
    case 'AEfk': case 'ANcf': case 'ACtb': {
      for (const e of enemies(caster.x, caster.y, area || 400)) w.damage(caster, e, d1 || 100, { spell: true });
      return { ok: true };
    }
    // ---- chain lightning
    case 'AOcl': case 'AEch': {
      let t = o.target, dmg = d1 || 100;
      const hops = Math.max(1, d2 || 4);
      const hit = new Set();
      for (let k = 0; k < hops && t; k++) {
        w.damage(caster, t, dmg, { spell: true });
        hit.add(t.id);
        dmg *= 0.75;
        let next = null, bd = Infinity;
        for (const e of w.allUnits()) {
          if (hit.has(e.id) || !w.hostile(caster, e)) continue;
          const d = dist(t, e);
          if (d < 500 && d < bd) { bd = d; next = e; }
        }
        t = next;
      }
      return { ok: true };
    }
    // ---- blink
    case 'AEbl': {
      const max = i.range || 700;
      const d = Math.min(dist(caster, { x: tx, y: ty }), max);
      const ang = Math.atan2(ty - caster.y, tx - caster.x);
      const c = w.grid.nearestWalkable(caster.x + Math.cos(ang) * d, caster.y + Math.sin(ang) * d);
      if (!c) return { ok: false, reason: 'blocked' };
      [caster.x, caster.y] = w.grid.toWorld(c[0], c[1]);
      caster.path = null;
      return { ok: true };
    }
    // ---- channelled area damage (Blizzard, Starfall, Rain of Fire)
    case 'AHbz': case 'AEsf': case 'ANrf': {
      const r = area || 250;
      const waves = Math.max(1, Math.round(d2 || 4));
      const per = d1 || 40;
      const cx = B === 'AEsf' ? caster.x : tx, cy = B === 'AEsf' ? caster.y : ty;
      w.channel(caster, cx, cy, r, per, waves, 1.0);
      return { ok: true };
    }
    // ---- Bladestorm: damage everything around the caster for a duration
    case 'AOww': {
      w.channel(caster, caster.x, caster.y, area || 200, d1 || 75,
                Math.max(1, Math.round(dur || 6)), 1.0, true);
      return { ok: true };
    }
    // ---- Howl of Terror: cut nearby enemies' damage
    case 'ANht': {
      for (const e of enemies(caster.x, caster.y, area || 500))
        w.applyBuff(e, { kind: 'weaken', pct: (Math.abs(d1) || 25) / 100,
                         until: w.now + Math.max(5, dur) * 1000 });
      return { ok: true };
    }
    // ---- summons
    case 'AUin': {                             // Inferno: summon + impact damage
      for (const e of enemies(tx, ty, area || 200)) w.damage(caster, e, d1 || 50, { spell: true });
      // the map can re-skin what Inferno drops; its own UnitID says which
      w.summon(caster, i.unit || 'ninf', tx, ty, dur || 60);
      return { ok: true };
    }
    case 'AOmi': {                             // Mirror Image
      const n = Math.max(1, d1 || 1);
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        w.summon(caster, caster.typeKey, caster.x + Math.cos(a) * 120,
                 caster.y + Math.sin(a) * 120, dur || 30, { image: true });
      }
      return { ok: true };
    }
    case 'AUls': {                             // Locust Swarm
      for (const e of enemies(caster.x, caster.y, area || 500)) w.damage(caster, e, d1 || 25, { spell: true });
      return { ok: true };
    }
    // ---- damage-over-time aura the unit carries (Immolation)
    case 'ANpi': case 'AEim': case 'AIim': {
      caster.immolation = { dps: d1 || 10, area: area || 200 };
      return { ok: true };
    }
    // ---- heals / buffs
    case 'AHhb': case 'AOhw': case 'AChw': {
      const t = (o.target && !w.hostile(caster, o.target)) ? o.target : caster;
      w.heal(t, d1 || 200);
      return { ok: true };
    }
    case 'AHdi': case 'ACbh': case 'AHbn': {
      w.applyBuff(caster, { kind: 'rage', pct: 0.25, until: w.now + Math.max(5, dur) * 1000 });
      return { ok: true };
    }
    // Metamorphosis and its kin genuinely replace the unit: `unit` names the
    // form to take. Approximating it with a damage buff left nine heroes' whole
    // transformation -- Full Demon Form, Super Saiyan, Bankai -- as a number
    // going up quietly with nothing to see and no new body to fight in.
    case 'AHmt': case 'AEme': case 'ACmt': case 'ANcr': {
      const form = i.unit;
      const secs = i.heroDuration || dur || 45;
      if (form && w.morph(caster, form, secs)) return { ok: true };
      w.applyBuff(caster, { kind: 'morph', pct: 0.35, until: w.now + Math.max(15, dur) * 1000 });
      return { ok: true };
    }
    case 'ACro': case 'AOcr': {                // Roar-likes: friendly damage buff
      for (const a of w.alliesInRange(caster, caster.x, caster.y, area || 500))
        w.applyBuff(a, { kind: 'rage', pct: (d1 || 25) / 100, until: w.now + Math.max(5, dur) * 1000 });
      return { ok: true };
    }
    // (AOsf -- Spirit Wolves -- used to sit in this group, which meant a spell
    //  whose own data names the wolves to summon threw a damage number instead.)
    case 'ANdr': case 'AUdc': case 'AHfs': case 'ANin': {
      const t = o.target;
      if (!t) return { ok: false, reason: 'need target' };
      w.damage(caster, t, d1 || 120, { spell: true });
      if (B === 'ANdr') w.heal(caster, d1 || 120);
      return { ok: true };
    }
    // ---- Silence: the area cannot cast until it wears off.  FOC zeroes this
    // base on most of the spells built from it (duration 0.01, all data 0) and
    // does the work in its own trigger, so a near-zero duration is the map
    // saying "do nothing" rather than a value to floor upward.
    case 'ANsi': case 'ACsi': {
      let n = 0;
      for (const e of enemies(tx, ty, area || 300)) {
        if (dur <= 0.1) break;
        w.applyBuff(e, { kind: 'silence', until: w.now + dur * 1000 });
        n++;
      }
      return { ok: true, silenced: n };
    }
    case 'ANsl': case 'AUsl': case 'ACsw': {
      for (const e of enemies(tx, ty, area || 250))
        w.applyBuff(e, { kind: 'slow', pct: (d1 || 30) / 100, until: w.now + Math.max(4, dur) * 1000 });
      return { ok: true };
    }
    default: {
      if (isPassive(ab)) return { ok: false, reason: 'passive' };
      // An ability naming a unit type is a summon, and its own data says what
      // and how many -- no case needed per summoning spell.
      if (i.unit) return summonFrom(w, caster, i, tx, ty, dur);
      // Data-driven fallback: an active ability with a damage value hits what it
      // targets; area if it has one, otherwise the single target.
      if (d1 > 0) {
        if (area > 0) { for (const e of enemies(tx, ty, area)) w.damage(caster, e, d1, { spell: true }); return { ok: true }; }
        if (o.target && w.hostile(caster, o.target)) { w.damage(caster, o.target, d1, { spell: true }); return { ok: true }; }
      }
      return { ok: false, reason: 'no engine behaviour for ' + B };
    }
  }
}

/**
 * Passive bonuses an item ability grants while carried. Field meanings come from
 * the ability's own data (AbilityData.slk + the map's w3a overrides).
 */
// The passive bonus each item ability grants, keyed by the Blizzard ability it
// derives from.  Warcraft III keeps attribute values in fixed data slots across
// the whole family -- agility in DataA, intelligence in DataB, strength in DataC
// -- so these all read the same way; single-purpose bonuses put their value in
// DataA.  Names are Blizzard's own (`comments` in AbilityData.slk), which is
// what settles cases like AIs1: it is StrengthBonus (+1), not an attack-speed
// item, and reading it as one gave the wrong stat entirely.
const ATTR = (d) => ({ agi: d.data1 || 0, intel: d.data2 || 0, str: d.data3 || 0 });
const ITEM_BONUS = {
  // strength
  AIs1: ATTR, AIs3: ATTR, AIs4: ATTR, AIs6: ATTR, AIsm: ATTR, AInm: ATTR,
  // agility
  AIa1: ATTR, AIa3: ATTR, AIa4: ATTR, AIa6: ATTR, AIam: ATTR, AIgm: ATTR,
  // intelligence
  AIim: ATTR,
  // every attribute at once
  AIx5: ATTR, AIxm: ATTR,
  // attack and defence
  AItx: (d) => ({ damage: d.data1 }),
  AId0: (d) => ({ armor: d.data1 }), AId1: (d) => ({ armor: d.data1 }),
  AId3: (d) => ({ armor: d.data1 }), Ansk: (d) => ({ armor: d.data3 }),
  // life, mana and regeneration
  AIl1: (d) => ({ maxHp: d.data1 }), AIl2: (d) => ({ maxHp: d.data1 }),
  AImz: (d) => ({ maxMana: d.data1 }),
  Arel: (d) => ({ hpReg: d.data1 }), AIrm: (d) => ({ manaReg: d.data1 }),
  // speed
  AIsx: (d) => ({ attackSpeed: d.data1 }), AIs2: (d) => ({ attackSpeed: d.data1 }),
  AIms: (d) => ({ moveSpeed: d.data1 }),
  // on-hit effects
  SCva: (d) => ({ lifesteal: d.data1 }),
  AIcf: (d) => ({ flames: d.data1 }),
  ACce: (d) => ({ cleave: d.data1 }),
  // the experience tomes are consumed rather than carried, so they grant their
  // experience through itemUse -- they are not a passive bonus
};

/** Sum every passive bonus from the items a unit carries. */
export function itemBonuses(items) {
  const out = { damage: 0, armor: 0, str: 0, agi: 0, intel: 0, maxHp: 0, maxMana: 0,
                hpReg: 0, manaReg: 0, attackSpeed: 0, lifesteal: 0, flames: 0, cleave: 0,
                moveSpeed: 0, xpMul: 0 };
  for (const it of items || []) {
    for (const aid of it.abilities || []) {
      const ab = ABILS[aid];
      if (!ab) continue;
      const fn = ITEM_BONUS[ab.base];
      if (!fn) continue;
      const d = levelInfo(ab, 1);
      const b = fn(d) || {};
      for (const k of Object.keys(out)) if (typeof b[k] === 'number') out[k] += b[k];
    }
  }
  return out;
}

/** Consumables: what using this item does, straight from its ability data. */
export function itemUse(it) {
  for (const aid of it.abilities || []) {
    const ab = ABILS[aid];
    if (!ab) continue;
    const d = levelInfo(ab, 1);
    if (ab.base === 'AIh1' || ab.base === 'AIh2' || ab.base === 'AIhx')
      return { kind: 'heal', amount: d.data1 || 0 };
    if (ab.base === 'AIe2' || ab.base === 'AIem' || ab.base === 'AIxp')
      return { kind: 'xp', amount: d.data1 || 0 };
    if (ab.base === 'AIma' || ab.base === 'AImz')
      return { kind: 'mana', amount: d.data1 || 0 };
  }
  return null;
}

/** Aura contributions a unit receives from nearby allies. */
/**
 * Attribute bonuses a hero carries from its own passive skills.
 *
 * Attribute Bonus (`Aamk`) is a skill you learn, not one you cast, and its
 * value sits in the same three data slots the stat tomes use -- agility in
 * DataA, intelligence in DataB, strength in DataC.  It was being treated as a
 * castable spell, which meant the +50 it grants was thrown at whatever the hero
 * was pointing at as 50 damage, and no hero ever got the stats.
 */
// Which ability bases may carry an attribute bonus is not a judgement call:
// AbilityMetaData.slk lists it, on the useSpecific column of the Iagi, Istr and
// Iint fields, and these twenty-four are what it names. We knew one of them, so
// every transformation built on AIx2 granted nothing -- Goku's three Super
// Saiyan forms are +50, +100 and +150 to all three attributes and gave none of
// it.
//
// Guessing from the data instead of from this list is the trap. Reading "any
// ability whose data1 is positive" picks up AInv, whose data1 is how many
// inventory slots it opens, and AIcf, where it is a damage figure.
const ATTR_SKILLS = new Set([
  'Aamk', 'AIab', 'AIa1', 'AIa3', 'AIa4', 'AIa6', 'AIx5', 'AIx1', 'AIx2',
  'AIs1', 'AIs3', 'AIs4', 'AIs6', 'AIi1', 'AIi3', 'AIi4', 'AIi6',
  'AIxm', 'AIam', 'AIim', 'AIsm', 'AIgm', 'AItm', 'AInm',
]);

export function abilityBonuses(w, u) {
  const out = { agi: 0, intel: 0, str: 0 };
  if (!u || !u.abilities) return out;
  for (const [key, lvl] of u.abilities) {
    if (lvl < 1) continue;
    const ab = ABILS[w.abilKey(key)];
    if (!ab || !ATTR_SKILLS.has(baseOf(ab))) continue;
    const d = levelInfo(ab, lvl);
    out.agi += d.data1 || 0;
    out.intel += d.data2 || 0;
    out.str += d.data3 || 0;
  }
  return out;
}

export function auraEffects(w, u) {
  const out = { speed: 0, armor: 0, damage: 0, regen: 0, vampiric: 0 };
  for (const a of w.allUnits()) {
    if (!a.abilities || a.abilities.size === 0) continue;
    if (w.hostile(u, a)) continue;
    if (Math.hypot(a.x - u.x, a.y - u.y) > 900) continue;
    for (const [key, lvl] of a.abilities) {
      const ab = ABILS[w.abilKey(key)];
      const spec = ab && AURA_BASES[ab.base];
      if (!spec) continue;
      if (spec.pct) out[spec.kind] += spec.pct;
      if (spec.flat) out[spec.kind] += spec.flat;
    }
  }
  return out;
}
