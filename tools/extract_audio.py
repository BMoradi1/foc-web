"""Extract Warcraft III audio (Huffman+ADPCM) and encode it for the browser.

Decoding and encoding are both CPU-bound and independent per file, so they run
across a process pool.
"""
import os, sys, subprocess, json
from concurrent.futures import ProcessPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

OUT = 'war3_extracted'
WEB = 'assets/sounds'
_gd = None


def gd():
    global _gd
    if _gd is None:
        from gamedata import GameData
        _gd = GameData()
    return _gd


def one(ap):
    """Decode one archive path and encode it to ogg -> (key, webpath|None)."""
    rel = ap.replace('\\', '/')
    key = rel.lower()
    web = os.path.join(WEB, os.path.splitext(key)[0] + '.ogg')
    if os.path.exists(web) and os.path.getsize(web) > 0:
        return key, os.path.relpath(web, 'assets').replace(os.sep, '/')
    try:
        data, _src = gd().read(ap)
    except Exception:
        return key, None
    if not data:
        return key, None
    raw = os.path.join(OUT, ap.replace('\\', os.sep))
    os.makedirs(os.path.dirname(raw), exist_ok=True)
    with open(raw, 'wb') as f:
        f.write(data)
    os.makedirs(os.path.dirname(web), exist_ok=True)
    r = subprocess.run(['ffmpeg', '-v', 'quiet', '-y', '-i', raw,
                        '-c:a', 'libvorbis', '-q:a', '2', '-ar', '22050', web],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if r.returncode == 0 and os.path.exists(web) and os.path.getsize(web) > 0:
        return key, os.path.relpath(web, 'assets').replace(os.sep, '/')
    return key, None


def main():
    from gamedata import GameData
    listing = GameData().listfile()
    audio = sorted(orig for low, orig in listing.items()
                   if low.endswith(('.wav', '.mp3')))
    os.makedirs(WEB, exist_ok=True)
    print('audio paths to try: %d' % len(audio), flush=True)
    index, missing = {}, 0
    workers = max(2, min(14, (os.cpu_count() or 4) - 2))
    with ProcessPoolExecutor(max_workers=workers) as ex:
        for n, (key, web) in enumerate(ex.map(one, audio, chunksize=8), 1):
            if web:
                index[key] = web
            else:
                missing += 1
            if n % 500 == 0:
                print('  %d/%d  (%d ok, %d unavailable)'
                      % (n, len(audio), len(index), missing), flush=True)
    json.dump(index, open('assets/sounds.json', 'w'), indent=0)
    size = sum(os.path.getsize(os.path.join(r, f))
               for r, _, fs in os.walk(WEB) for f in fs)
    print('converted/available: %d, unavailable: %d' % (len(index), missing))
    print('web audio: %.1f MB' % (size / 1e6))


if __name__ == '__main__':
    main()
