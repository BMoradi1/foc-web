import os, re, sys, json, struct, collections
sys.path.insert(0, os.path.dirname(__file__))
from mpq import MPQ, hash_string, HASH_FILE_KEY, crack_key, FLAG_ENCRYPTED, FLAG_COMPRESS, FLAG_IMPLODE

MAP, OUT = 'FOCS_Translated_v2.0.w3x', 'extracted'
m = MPQ(MAP)

# 1. every block -> bytes, plus its file key
blocks, keys = {}, {}
used = sorted({e[4] for e in m.hash_table if e[4] != 0xFFFFFFFF and e[3] != 0xFFFF})
for bi in used:
    pos, cs, fs, fl = m.block_table[bi]
    if fl & FLAG_ENCRYPTED and fl & (FLAG_COMPRESS | FLAG_IMPLODE):
        nsec = (fs + m.sector_size - 1) // m.sector_size
        ntab = nsec + 1 + (1 if fl & 0x04000000 else 0)
        k = crack_key(m.raw[m.base + pos:m.base + pos + 8], m.sector_size, ntab)
        if k is not None:
            keys[bi] = (k + 1) & 0xFFFFFFFF
    d = m.read_block_cracked(bi)
    if d is not None:
        blocks[bi] = d

# 2. candidate plain-name pool from all content
PATH_RE = re.compile(rb'[A-Za-z0-9_\-\.\\/ \(\)\[\]!&\'#@+,~]{2,200}\.(mdx|mdl|blp|tga|jpg|dds|wav|mp3|txt|slk|toc|fdf|j|w3u|shd|mmp|doo|w3e|w3i|wts|w3t|w3a|w3b|w3d|w3h|w3q|w3c|w3r|w3s|wtg|wct|imp|w3o|w3v|json)', re.I)
cands = set()
for d in blocks.values():
    for mt in PATH_RE.finditer(d):
        s = mt.group(0).decode('latin-1').strip().replace('/', '\\')
        cands.add(s.split('\\')[-1])
# plus every standard internal name
cands |= set("""war3map.w3e war3map.w3i war3map.wpm war3map.doo war3mapUnits.doo
war3map.w3r war3map.w3c war3map.w3s war3map.w3u war3map.w3t war3map.w3b war3map.w3d
war3map.w3a war3map.w3h war3map.w3q war3map.wts war3map.shd war3map.mmp war3map.j
war3map.imp war3mapMap.blp war3mapMap.b00 war3mapPreview.tga war3map.wtg war3map.wct
war3mapMisc.txt war3mapSkin.txt war3mapExtra.txt war3mapUnits.doo war3map.w3o
(listfile) (attributes) (signature) conversation.json war3map.w3v""".split())

key2name = {}
for c in cands:
    key2name.setdefault(hash_string(c, HASH_FILE_KEY), c)

named = {}
for bi, k in keys.items():
    if k in key2name:
        named[bi] = key2name[k]

print('blocks: %d  cracked keys: %d  candidates: %d  matched names: %d'
      % (len(blocks), len(keys), len(cands), len(named)))

# 3. reconstruct directory prefix from full paths seen in content
fullpaths = {}
for d in blocks.values():
    for mt in PATH_RE.finditer(d):
        s = mt.group(0).decode('latin-1').strip().replace('/', '\\').lstrip('\\')
        if '\\' in s:
            fullpaths.setdefault(s.split('\\')[-1], s)

os.makedirs(OUT, exist_ok=True)
import shutil
sniff = collections.Counter()
manifest = []
for bi, d in sorted(blocks.items()):
    name = named.get(bi)
    if not name:
        h = d[:4]
        ext = ('.mdx' if h == b'MDLX' else '.blp' if h[:3] == b'BLP' else
               '.mp3' if h[:3] == b'ID3' or h[:2] == b'\xff\xfb' else
               '.tga' if len(d) > 18 and d[1] in (0, 1) and d[2] in (2, 10) else '.bin')
        name = 'unknown_%03d%s' % (bi, ext)
        sniff[ext] += 1
    path = fullpaths.get(name, name)
    if not path.lower().startswith(('war3map', 'scripts', 'unknown', '(')):
        path = 'war3mapImported\\' + path
    p = os.path.join(OUT, path.replace('\\', os.sep))
    os.makedirs(os.path.dirname(p) or '.', exist_ok=True)
    open(p, 'wb').write(d)
    manifest.append(dict(block=bi, name=path, size=len(d), named=bool(named.get(bi))))
json.dump(manifest, open(os.path.join(OUT, 'manifest.json'), 'w'), indent=1)
print('still unnamed:', dict(sniff))
