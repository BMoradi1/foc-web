"""Unified unit-type table: Blizzard SLK base + war3map.w3u base overrides + custom units."""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wts import resolve_deep

def num(v, d=0.0):
    if isinstance(v, (int, float)): return float(v)
    if isinstance(v, str):
        s = v.strip()
        try: return float(s)
        except ValueError: return d
    return d

blz = json.load(open('data/blz_units.json'))
w3u = json.load(open('data/war3map.w3u.json'))

def from_blz(rec):
    prim = str(rec.get('Primary', '_')).strip()
    return dict(
        primary=prim,
        name=rec.get('_name') or '', icon=rec.get('_icon') or '',
        model=((str(rec.get('file')) + '.mdl') if rec.get('file') and rec.get('file') != '-' else (rec.get('_model') or '')),
        hp=num(rec.get('HP'), 100), mana=num(rec.get('manaN'), 0),
        manaStart=num(rec.get('mana0'), 0),
        hpReg=num(rec.get('regenHP'), 0), manaReg=num(rec.get('regenMana'), 0.01),
        armor=num(rec.get('def'), 0), armorType=str(rec.get('defType', 'none') or 'none'),
        dmgBase=num(rec.get('dmgplus1'), 0), dmgDice=num(rec.get('dice1'), 1),
        dmgSides=num(rec.get('sides1'), 1), atkCd=num(rec.get('cool1'), 1.5),
        atkRange=num(rec.get('rangeN1'), 90), atkType=str(rec.get('atkType1', 'normal')),
        moveSpeed=num(rec.get('spd'), 270), turnRate=num(rec.get('turnRate'), 0.6),
        collision=num(rec.get('collision'), 24), scale=num(rec.get('modelScale'), 1) or 1,
        level=int(num(rec.get('level'), 1)), race=str(rec.get('race', '')),
        isHero=prim in ('STR', 'AGI', 'INT'),
        str_=num(rec.get('STR'), 0), strLvl=num(rec.get('STRplus'), 0),
        agi=num(rec.get('AGI'), 0), agiLvl=num(rec.get('AGIplus'), 0),
        int_=num(rec.get('INT'), 0), intLvl=num(rec.get('INTplus'), 0),
        abilities=[a for a in str(rec.get('abilList', '')).split(',') if a and a != '_'],
        heroAbilities=[a for a in str(rec.get('heroAbilList', '')).split(',') if a and a != '_'],
        bountyDice=num(rec.get('bountydice'), 0), bountySides=num(rec.get('bountysides'), 0),
        bountyPlus=num(rec.get('bountyplus'), 0),
        isBuilding=int(num(rec.get('isbldg'), 0)),
        weaponType=str(rec.get('weapType1', '') or ''),
        # Warcraft III does not shadow-map a unit: it lays a flat textured quad
        # on the ground beneath it, sized and offset by the unit's own data.
        # `ReplaceableTextures\Shadows\Shadow.blp` is that texture, and 623 of
        # the 837 stock units name one.
        shadow=str(rec.get('unitShadow') or rec.get('buildingShadow') or '').strip(),
        shadowW=num(rec.get('shadowW'), 0), shadowH=num(rec.get('shadowH'), 0),
        shadowX=num(rec.get('shadowX'), 0), shadowY=num(rec.get('shadowY'), 0),
        # The ground decal a building is stamped on -- scorched earth under an
        # orc hut, flagstones under a human one. It names a row in
        # Splats\\UberSplatData.slk, which nothing read because that directory
        # was never extracted.
        uberSplat=str(rec.get('uberSplat') or '').strip(),
        # How long the death animation runs before the corpse starts to decay.
        deathTime=num(rec.get('death'), 3),
        soundSet=str(rec.get('unitSound', '') or ''),
        food=num(rec.get('fused'), 0), sight=num(rec.get('sight'), 1400),
        # UnitWeapons.slk 'acquire' -- how far a unit looks for a target on its
        # own.  Warcraft III uses this per unit type, not one global leash.
        acquisitionRange=num(rec.get('acquire'), 500),
    )

W3U_MAP = {                       # w3u modification id -> normalized field
 'unam': 'name', 'upro': 'properName', 'unsf': 'suffix', 'umdl': 'model', 'uico': 'icon',
 'uhpm': 'hp', 'umpm': 'mana', 'umpi': 'manaStart', 'uhpr': 'hpReg', 'umpr': 'manaReg',
 'udef': 'armor', 'udty': 'armorType', 'ua1b': 'dmgBase', 'ua1d': 'dmgDice',
 'ua1s': 'dmgSides', 'ua1c': 'atkCd', 'ua1r': 'atkRange', 'ua1t': 'atkType',
 'umvs': 'moveSpeed', 'umvr': 'turnRate', 'ucol': 'collision', 'usca': 'scale',
 'ushu': 'shadow', 'ushb': 'shadow', 'ushw': 'shadowW', 'ushh': 'shadowH',
 'ushx': 'shadowX', 'ushy': 'shadowY', 'uubs': 'uberSplat', 'udtm': 'deathTime',
 # ucbs/ucpt are the cast backswing and cast point, not the collision radius:
 # reading ucbs as collision gave every hero the map's 0.1s backswing as its
 # size, and dropped the real ucol overrides entirely
 'ucbs': 'castBackswing', 'ucpt': 'castPoint',
 'ulev': 'level', 'urac': 'race', 'upra': 'primary', 'ustr': 'str_', 'ustp': 'strLvl',
 'uagi': 'agi', 'uagp': 'agiLvl', 'uint': 'int_', 'uinp': 'intLvl',
 'ubdi': 'bountyDice', 'ubsi': 'bountySides', 'ubba': 'bountyPlus',
 'ubdg': 'isBuilding', 'usid': 'sight', 'uacq': 'acquisitionRange', 'ufoo': 'food', 'umvh': 'flyHeight',
 'ua1m': 'missile', 'ua1z': 'missileSpeed', 'uma1': 'missileArc',
 'usnd': 'soundSet', 'utip': 'tip', 'utub': 'ubertip',
 'usei': 'sellItems', 'useu': 'sellUnits', 'ua1g': 'atkTargetsAllowed', 'ua1w': 'weaponType', 'uabi': 'abilities',
 'ua1h': 'splashArea',
 'uhab': 'heroAbilities', 'umh1': 'missileHoming',
}

def unit_func():
    """Units\\*UnitFunc.txt -> {unitId: {field: value}}.

    A unit's missile art, speed, arc and homing flag live here and in no .slk, so
    reading only the tables leaves every ranged unit in the game with no missile
    at all -- 301 of them on this map, against the 9 the map happens to override
    itself.
    """
    import glob
    out = {}
    for path in glob.glob('war3_extracted/Units/*UnitFunc.txt'):
        cur = None
        for line in open(path, encoding='latin-1', errors='replace'):
            line = line.strip()
            m = re.match(r'^\[([^\]]+)\]$', line)
            if m:
                cur = m.group(1)
                continue
            if not cur or '=' not in line:
                continue
            k, _, v = line.partition('=')
            k, v = k.strip().lower(), v.strip().strip('"')
            if v and v not in ('_', '-'):
                out.setdefault(cur, {}).setdefault(k, v)
    return out


FUNC = unit_func()
# the first weapon's missile, as Warcraft III names it in the func files
FUNC_MAP = {'missileart': 'missile', 'missilespeed': 'missileSpeed',
            'missilearc': 'missileArc', 'missilehoming': 'missileHoming',
            # Warcraft III's "Required Animation Names": the tokens a unit is
            # allowed to use beyond the animation being asked for. This is how
            # one model serves several units -- the Scout Tower, Guard Tower and
            # Arcane Tower are all HumanTower.mdl, and only "upgrade,first" vs
            # "upgrade,third" tells them apart. Without it every one of them
            # draws as the plain scout tower.
            'animprops': 'animProps'}


def func_defaults(uid):
    src = FUNC.get(uid) or {}
    out = {}
    for k, field in FUNC_MAP.items():
        v = src.get(k)
        if v is None:
            continue
        # missile art is a path and animProps a token list; the rest are numbers
        out[field] = v if field in ('missile', 'animProps') else num(v, 0)
    return out


types = {}
for uid, rec in blz.items():
    types[uid] = from_blz(rec)
    types[uid].update(func_defaults(uid))
    types[uid]['id'] = uid
    types[uid]['origin'] = uid

def apply_mods(t, mods):
    for k, v in mods.items():
        f = W3U_MAP.get(k)
        if not f: continue
        if f in ('abilities', 'heroAbilities', 'sellItems', 'sellUnits'):
            t[f] = [x.strip() for x in str(v).split(',') if x.strip() and x.strip() != '_']
        elif f in ('name', 'properName', 'suffix', 'model', 'icon', 'race', 'armorType', 'primary',
                   'atkType', 'missile', 'soundSet', 'tip', 'ubertip', 'weaponType', 'uberSplat',
                   'animProps',
                   'atkTargetsAllowed'):
            t[f] = v
        else:
            t[f] = num(v, t.get(f, 0)) if not isinstance(v, str) else num(v, t.get(f, 0))
    return t

# Warcraft III keeps the two w3u tables independent.  The "original" table edits
# the standard units; a custom unit inherits the *default* values of its base, not
# the author's edits to that base.  Chaining them hands a hero whatever was done
# to the standard unit it was built from -- and this map edits Ulic, Obla, Oshd
# and Hmkg into 700-damage, 7500-life templates for its own use elsewhere, which
# gave exactly the five heroes derived from them 150-760 base damage while the
# other twenty-one sat on Blizzard's 0.
defaults = {uid: dict(t) for uid, t in types.items()}

for o in w3u['base']:                       # overrides to Blizzard unit types
    t = types.setdefault(o['id'], dict(from_blz({}), id=o['id'], origin=o['id']))
    apply_mods(t, o['mods'])
for o in w3u['custom']:                     # new unit types derived from a base
    src = defaults.get(o['origin']) or types.get(o['origin'])
    t = dict(src) if src else dict(from_blz({}))
    t['id'] = o['id']; t['origin'] = o['origin']
    apply_mods(t, o['mods'])
    if t.get('heroAbilities'): t['isHero'] = True
    types[o['id']] = t

os.makedirs('data', exist_ok=True)
# The editor stores authored text in war3map.wts and leaves a TRIGSTR_ pointer
# in the object data; resolve them here so nothing downstream shows the pointer.
types = resolve_deep(types)
json.dump(types, open('data/unittypes.json', 'w'))
heroes = [t for t in types.values() if t.get('isHero')]
creeps = [t for t in types.values() if str(t.get('race','')).lower() == 'creeps']
print('unit types: %d  (heroes %d, creep-race %d)' % (len(types), len(heroes), len(creeps)))
import collections
lv = collections.Counter(t['level'] for t in creeps)
print('creeps by level:', dict(sorted(lv.items())))
FIELDS = ('name', 'hp', 'mana', 'level', 'acquisitionRange', 'model')
custom = [t for t in heroes if t['id'] != t.get('origin') or t['id'] not in blz]
if custom:
    print('sample custom hero:', {k: custom[0].get(k) for k in FIELDS})
if creeps:
    print('sample creep:', {k: creeps[0].get(k) for k in FIELDS})
acq = collections.Counter(t.get('acquisitionRange') for t in types.values())
print('acquisition ranges:', dict(sorted(acq.most_common(5))))
