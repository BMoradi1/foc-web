import os, re, sys, struct
sys.path.insert(0, os.path.dirname(__file__))
from mpq import MPQ, hash_string, HASH_TABLE_OFFSET, HASH_NAME_A, HASH_NAME_B

MAP = sys.argv[1] if len(sys.argv) > 1 else 'FOCS_Translated_v2.0.w3x'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'extracted'
m = MPQ(MAP)

STD = """(listfile) (attributes) (signature) (user data)
war3map.w3e war3map.w3i war3map.wpm war3map.doo war3mapUnits.doo war3map.w3r
war3map.w3c war3map.w3s war3map.w3u war3map.w3t war3map.w3b war3map.w3d
war3map.w3a war3map.w3h war3map.w3q war3map.wts war3map.shd war3map.mmp
war3map.j war3map.imp war3mapMap.blp war3mapMap.b00 war3mapMap.tga
war3mapPreview.tga war3mapPreview.blp war3map.wct war3map.wtg war3map.w3o
Scripts\\war3map.j Scripts\\common.j Scripts\\blizzard.j
conversation.json war3mapMisc.txt war3mapSkin.txt war3mapExtra.txt
""".split()

found, blocks_seen = {}, {}

def try_name(n):
    if n in found: return True
    bi = m.find(n)
    if bi is None: return False
    try:
        d = m.read_block(bi, n)
    except Exception as e:
        d = None
    if d is None: return False
    found[n] = d
    blocks_seen[bi] = n
    return True

for n in STD: try_name(n)

# ---- mine path-like strings from everything we can already read, iteratively
PATH_RE = re.compile(rb'[A-Za-z0-9_\-\.\\/ \(\)]{3,190}\.(mdx|mdl|blp|tga|jpg|jpeg|dds|wav|mp3|txt|slk|toc|fdf|j|ai|w3u|mmp|shd)', re.I)

def mine(data):
    out = set()
    for mt in PATH_RE.finditer(data):
        s = mt.group(0).decode('latin-1').strip().replace('/', '\\')
        s = s.lstrip('\\')
        if len(s) < 5: continue
        out.add(s)
        # also try last path component under common import dirs
        base = s.split('\\')[-1]
        out.add('war3mapImported\\' + base)
        out.add(base)
    return out

pending = set()
for d in list(found.values()):
    pending |= mine(d)

rounds = 0
while pending and rounds < 8:
    rounds += 1
    nxt = set()
    for n in sorted(pending):
        if try_name(n):
            nxt |= mine(found[n])
    pending = nxt - set(found)

# ---- report
total_blocks = len(m.block_table)
used = set()
for e in m.hash_table:
    if e[4] != 0xFFFFFFFF and e[3] != 0xFFFF:
        used.add(e[4])
print('archive blocks: %d, hash entries in use: %d, named: %d' % (
      total_blocks, len(used), len(found)))
unknown = sorted(used - set(blocks_seen))
print('unnamed blocks: %d' % len(unknown))

os.makedirs(OUT, exist_ok=True)
for n, d in found.items():
    p = os.path.join(OUT, n.replace('\\', os.sep))
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'wb').write(d)

# dump unnamed blocks raw for signature sniffing
os.makedirs(os.path.join(OUT, '_unknown'), exist_ok=True)
import json
meta = []
for bi in unknown:
    pos, cs, fs, fl = m.block_table[bi]
    meta.append(dict(block=bi, pos=pos, csize=cs, fsize=fs, flags='0x%08X' % fl))
json.dump(meta, open(os.path.join(OUT, '_unknown', 'blocks.json'), 'w'), indent=1)
print('wrote %d files to %s/' % (len(found), OUT))
for n in sorted(found):
    print('  %8d  %s' % (len(found[n]), n))
