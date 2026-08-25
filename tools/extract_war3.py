"""Extract the Blizzard base assets that the FOCS map references from war3.mpq."""
import os, re, sys, json, collections
sys.path.insert(0, os.path.dirname(__file__))
from mpq import MPQ

OUT = 'war3_extracted'
m = MPQ('war3.mpq')
lf = open(os.path.join(OUT, 'listfile.txt'), encoding='latin-1').read().replace('\r\n', '\n')
LIST = [l.strip() for l in lf.split('\n') if l.strip()]
BY_LOWER = {p.lower().replace('/', '\\'): p for p in LIST}

def resolve(path):
    """Match a referenced art path against the archive, tolerating mdl/mdx + tga/blp."""
    p = path.strip().replace('/', '\\').lstrip('\\').lower()
    if p in BY_LOWER: return BY_LOWER[p]
    root, ext = os.path.splitext(p)
    for alt in ('.mdx', '.mdl', '.blp', '.tga'):
        if root + alt in BY_LOWER: return BY_LOWER[root + alt]
    return None

def want_refs():
    refs = collections.Counter()
    for f in ['war3map.w3u', 'war3map.w3t', 'war3map.w3a', 'war3map.w3h', 'war3map.w3q']:
        d = json.load(open('data/%s.json' % f))
        for tbl in ('base', 'custom'):
            for o in d[tbl]:
                for k, v in o['mods'].items():
                    if isinstance(v, str):
                        for mt in re.finditer(r'[^",;]*\.(mdl|mdx|blp|tga)', v, re.I):
                            refs[mt.group(0).strip()] += 1
    # art referenced by the script too (special effects, missiles)
    js = open('extracted/war3map.j', encoding='latin-1').read()
    for mt in re.finditer(r'"([^"]*\.(?:mdl|mdx|blp|tga))"', js, re.I):
        refs[mt.group(1)] += 1
    return refs

saved, missing = {}, collections.Counter()
def grab(archive_path, why=''):
    if archive_path in saved: return saved[archive_path]
    data = m.read(archive_path)
    if data is None: return None
    out = os.path.join(OUT, archive_path.replace('\\', os.sep))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, 'wb').write(data)
    saved[archive_path] = out
    return out

TEXPATH = re.compile(rb'[A-Za-z0-9_\-\\/ .()]{4,250}\.(?:blp|tga)', re.I)
def grab_model(archive_path):
    """Pull a model plus every texture its TEXS chunk names."""
    out = grab(archive_path)
    if not out or not out.lower().endswith('.mdx'): return out
    data = open(out, 'rb').read()
    for mt in TEXPATH.finditer(data):
        t = resolve(mt.group(0).decode('latin-1'))
        if t: grab(t)
    return out

refs = want_refs()
print('art references to resolve: %d' % len(refs))
for p in refs:
    a = resolve(p)
    if a: grab_model(a)
    else: missing[p] += refs[p]

# always take the whole tileset for this map + the standard UI/teamcolour sets
extra = 0
for p in LIST:
    pl = p.lower()
    if (pl.startswith('terrainart\\dalaran') or pl.startswith('terrainart\\cliff')
            or pl.startswith('replaceabletextures\\teamcolor')
            or pl.startswith('replaceabletextures\\teamglow')
            or pl.startswith('replaceabletextures\\selectionscaling')
            or 'shadow' in pl and pl.startswith('replaceabletextures')):
        if grab(p): extra += 1
print('extracted %d files (%d tileset/UI extras)' % (len(saved), extra))
print('still missing: %d distinct (%d references)' % (len(missing), sum(missing.values())))
json.dump({'saved': sorted(saved), 'missing': dict(missing.most_common())},
          open('data/war3_assets.json', 'w'), indent=1)
byext = collections.Counter(os.path.splitext(p)[1].lower() for p in saved)
print('by type:', dict(byext))
