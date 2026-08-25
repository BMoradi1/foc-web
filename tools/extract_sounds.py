"""Extract every sound the map's script plays, from the map and the game archives."""
import os, re, sys, json, collections
sys.path.insert(0, os.path.dirname(__file__))
from gamedata import GameData

OUT = 'war3_extracted'
gd = GameData()
LIST = gd.listfile()

def resolve(p):
    q = str(p).strip().replace('\\\\', '\\').replace('/', '\\').lstrip('\\').lower()
    if q in LIST: return LIST[q]
    root, ext = os.path.splitext(q)
    for alt in ('.wav', '.mp3', '.flac'):
        if root + alt in LIST: return LIST[root + alt]
    return None

src = open('extracted/war3map.j', encoding='latin-1').read()
paths = collections.Counter(re.findall(r'CreateSound\("([^"]+)"', src))
got, missing, sources = 0, [], collections.Counter()
for p in paths:
    if 'war3mapImported' in p:      # already unpacked from the .w3x
        continue
    ap = resolve(p)
    if not ap: missing.append(p); continue
    d, srcarc = gd.read(ap)
    if d is None: missing.append(p); continue
    out = os.path.join(OUT, ap.replace('\\', os.sep))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, 'wb').write(d)
    sources[srcarc] += 1
    got += 1
print('script sound files: %d total, %d imported by the map' % (
    len(paths), sum(1 for p in paths if 'war3mapImported' in p)))
print('extracted from archives: %d  %s' % (got, dict(sources)))
if missing:
    print('unresolved: %d' % len(missing))
    for p in missing[:8]: print('   ', p)
