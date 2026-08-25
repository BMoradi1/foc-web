#!/usr/bin/env bash
# Full asset + data pipeline: map file and Warcraft III archives -> public/
#
# Map-agnostic: the .w3x in the working directory is found by tools/mapfile.py
# (override with FOC_MAP). Nothing below names a hero, ability or unit id.
set -euo pipefail
PY=${PY:-.venv/bin/python}

echo "== 1. unpack the map (MPQ, protected)"
$PY tools/names.py
$PY tools/extract_final.py

echo "== 2. map object data"
$PY tools/objdata.py extracted/war3map.w3u extracted/war3map.w3t \
                     extracted/war3map.w3a extracted/war3map.w3h extracted/war3map.w3q
$PY tools/terrain.py
$PY tools/jass_fmt.py

echo "== 3. Warcraft III archives (patch > expansion > base)"
$PY tools/gamedata.py
$PY tools/slk.py
$PY tools/unittypes.py
$PY tools/extract_blizzard.py
$PY tools/unittypes.py          # rerun: TFT tables are now present
$PY tools/abilities.py
$PY tools/itemtypes.py           # items: Blizzard base + the map's overrides
$PY tools/gameplay.py           # MiscGame.txt + the map's own war3mapMisc.txt
$PY tools/soundsets.py          # per-unit sound sets

echo "== 4. convert assets"
$PY tools/convert_textures.py
$PY tools/mdx2gltf.py
$PY tools/extract_audio.py
$PY tools/bake_ground.py
$PY tools/cliffs.py             # a cliff mesh for every layer transition

echo "== 5. compile game data"
$PY tools/compile_game.py

echo "== 6. probe the map's own triggers"
# which target each spell needs; derived by casting every hero ability once,
# so it must run after compile_game.py has produced data/game.json
node tools/spell_targets.mjs

echo "== 7. stage into public/"
$PY tools/stage.py

echo "== 8. verify"
$PY tools/cliff_test.py | tail -3
node tools/boot_test.mjs
node tools/audit.mjs | tail -8
