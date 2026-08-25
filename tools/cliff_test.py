"""Check the baked cliff mesh against the terrain it has to meet.

The cliff mesh and the ground mesh are built from the same w3e data by different
paths, so they only line up if the corner order, the cell the model is placed
over and its base height are all right.  Wherever a cliff vertex lands exactly
on a terrain grid point, its height must equal that vertex's ground height --
otherwise the wall would float above the ground or sink into it.  A corner
order that is transposed, or a placement off by one cell, breaks this
immediately.
"""
import json, sys
import numpy as np

t = json.load(open('data/terrain.json'))
W, H, TS = t['width'], t['height'], t['tileSize']
OX, OY = t['offsetX'], t['offsetY']
hs = np.array(t['heights'], np.int16).astype(np.float32)
lay = np.array(t['layer'], np.uint8).astype(np.float32)
Z = (hs - 8192.0) / 4.0 + (lay - 2.0) * 128.0          # as tools/stage.py stages it

spec = json.load(open('data/cliffs.json'))
V = np.fromfile('data/cliffs.bin', '<f4').reshape(-1, spec['stride'])
print('cliff mesh: %d vertices, %d triangles' % (len(V), len(V) // 3))

# client space is (x, up, -y); go back to Warcraft III world coords
wx, up, wy = V[:, 0], V[:, 1], -V[:, 2]
fi = (wx - OX) / TS
fj = (wy - OY) / TS
on = (np.abs(fi - np.round(fi)) < 1e-3) & (np.abs(fj - np.round(fj)) < 1e-3)
i = np.round(fi[on]).astype(int)
j = np.round(fj[on]).astype(int)
inside = (i >= 0) & (i < W) & (j >= 0) & (j < H)
i, j, zc = i[inside], j[inside], up[on][inside]
zg = Z[j * W + i]
d = np.abs(zc - zg)
print('vertices landing on a terrain grid point: %d of %d (%.1f%%)'
      % (len(d), len(V), 100.0 * len(d) / len(V)))
tol = 0.5
bad = d > tol
print('height mismatch > %.1f: %d (%.2f%%)   max %.2f  mean %.4f'
      % (tol, int(bad.sum()), 100.0 * bad.mean(), float(d.max()), float(d.mean())))

# every cell the mesh covers must be one the ground mesh left out, and vice versa
cells = set(spec['cells'])
cw = W - 1
covered = set()
for a in range(0, len(V), 3):
    tri = V[a:a + 3]
    cx = (tri[:, 0].mean() - OX) / TS
    cy = (-tri[:, 2].mean() - OY) / TS
    covered.add((int(np.floor(cy + 1e-6)) * cw) + int(np.floor(cx + 1e-6)))
print('cells declared: %d, cells the triangles actually cover: %d, difference: %d'
      % (len(cells), len(covered), len(cells ^ covered)))

# a cliff cell must be one whose corners differ in layer, and not a ramp
lay2 = lay.reshape(H, W)
wrong = 0
for c in sorted(cells):
    cj, ci = divmod(c, cw)
    corners = {lay2[cj, ci], lay2[cj + 1, ci], lay2[cj, ci + 1], lay2[cj + 1, ci + 1]}
    if len(corners) == 1:
        wrong += 1
print('cliff cells whose corners are all the same layer (should be 0): %d' % wrong)

ok = (not bad.any()) and not (cells ^ covered) and wrong == 0
print('\n%s' % ('PASS' if ok else 'FAIL'))
sys.exit(0 if ok else 1)
