"""Extract models for every unit type the map's script can actually spawn."""
import os, re, sys, json, collections
sys.path.insert(0, os.path.dirname(__file__))
from mpq import MPQ

OUT = 'war3_extracted'
m = MPQ('war3.mpq')
LIST = [l.strip() for l in open(os.path.join(OUT, 'listfile.txt'), encoding='latin-1')
        .read().replace('\r\n', '\n').split('\n') if l.strip()]
BY_LOWER = {p.lower().replace('/', '\\'): p for p in LIST}

def resolve(path):
    p = str(path).strip().replace('/', '\\').lstrip('\\').lower()
    if p in BY_LOWER: return BY_LOWER[p]
    root, ext = os.path.splitext(p)
    for alt in ('.mdx', '.mdl', '.blp', '.tga'):
        if root + alt in BY_LOWER: return BY_LOWER[root + alt]
    return None

saved = set()
def grab(ap):
    if ap in saved: return True
    d = m.read(ap)
    if d is None: return False
    out = os.path.join(OUT, ap.replace('\\', os.sep))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, 'wb').write(d)
    saved.add(ap)
    return True

TEX = re.compile(rb'[A-Za-z0-9_\-\\/ .()]{4,250}\.(?:blp|tga)', re.I)
def grab_model(ap):
    if not grab(ap): return False
    if not ap.lower().endswith('.mdx'): return True
    data = open(os.path.join(OUT, ap.replace('\\', os.sep)), 'rb').read()
    for mt in TEX.finditer(data):
        t = resolve(mt.group(0).decode('latin-1'))
        if t: grab(t)
    return True

types = json.load(open('data/unittypes.json'))
want, missing = 0, collections.Counter()
for uid, t in types.items():
    mp = t.get('model')
    if not mp or not str(mp).strip('-'): continue
    ap = resolve(mp)
    if ap:
        want += 1
        grab_model(ap)
    else:
        missing[str(mp)] += 1
print('unit models resolved: %d, files written: %d' % (want, len(saved)))
print('unresolved model paths: %d' % len(missing))
for p, c in missing.most_common(8): print('   ', p)
