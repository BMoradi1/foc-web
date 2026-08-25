# FOC Web — *Fight of Characters 7.7a* in the browser



**NOTE: This is an incomplete implementation. Most features work, but they don't all work well. This is an 18 year old community map. Please keep that in mind**
 
A browser port of the Warcraft III community map **Fight of Characters**, running on an
authoritative Node server with a Three.js top-down 3D client.

**🤖I handled direction, architecture choices such as the 1:1 trigger mapping, designing verification audits, review and QA. Everything else in this repository is LLM-generated including the code, the tooling, execution of the audits and this README. Written with Claude Code and Codex under an agentic workflow.** 🤖

# Screenshots
## In-Game
<img width="1283" height="973" alt="image" src="https://github.com/user-attachments/assets/f771653d-2b7c-4628-8a8d-5edb1b424419" />

<img width="1485" height="981" alt="Screenshot_20260825_015529" src="https://github.com/user-attachments/assets/0997b900-60ac-46a5-b092-3766ed0449d8" />
<img width="1513" height="984" alt="image" src="https://github.com/user-attachments/assets/2459ecd9-f3a7-423b-a919-cbf6718cba96" />
<img width="1281" height="972" alt="image" src="https://github.com/user-attachments/assets/715ba281-deaf-49f9-8a34-30993efe484e" />



## Character Selector
<img width="1272" height="968" alt="image" src="https://github.com/user-attachments/assets/54ba62ae-13b4-4f6f-9056-e3130feda02f" />





Currently built against `fight_of_characters 7.7b E.w3x` — but the pipeline is
**map-agnostic**: no hero, ability, unit or region id is hardcoded anywhere. Point it at a
different FOC map and rebuild (see [Switching maps](#switching-maps)).

Every asset and every number in this project is **extracted from the original `.w3x` and the
retail Warcraft III archives** — nothing is hand-drawn or invented. The game logic is not
reimplemented: the map's own JASS script runs in a JASS virtual machine on the server.

```
<map>.w3x + War3*.mpq  ──►  tools/ (extraction + conversion)  ──►  public/ (runtime assets)
                                                                    │
                                       server/ (authoritative sim) ─┴─ client/ (Three.js)
```

## What is in this repository

**Source only.** The pipeline, the server, the client — about a megabyte of code.

It does **not** contain, and cannot legally redistribute, any of the following:

- **Warcraft III's archives** (`war3.mpq`, `War3x.mpq`, `War3Patch.mpq`, `War3xlocal.mpq`) —
  Blizzard's property. Bring your own retail install.
- **The map** (`fight_of_characters 7.7b E.w3x`) — its author's work.
- **Anything derived from either**: the extracted scripts and object data, the converted models,
  textures and sounds, the compiled tables. All of it is regenerated from your own copies by the
  build, which is why `assets/`, `data/`, `public/`, `extracted/` and `war3_extracted/` are
  ignored rather than committed. Together they are roughly 1.4 GB.

So this repository is the *machinery*: point it at your own copy of the game and the map, run the
build, and it produces a playable port. Nothing here is useful without them.

## Quick start

```bash
npm install
npm start                      # http://localhost:8080   (PORT=8081 npm start to change)
```

Open the page in two or more tabs, pick a character, hit **Ready**. The match starts when
every player in a team slot is ready.

Rebuild everything from the map file:

```bash
python3 -m venv .venv && .venv/bin/pip install numpy pillow
bash tools/pipeline.sh
```

The retail archives (`War3Patch.mpq`, `War3x.mpq`, `war3.mpq`, and the `*local` ones if you
have them) go next to the `.w3x`. They are read in Warcraft III's own priority order by
`tools/gamedata.py`.

## Controls

| Input | Action |
|---|---|
| Left click | Move |
| Right click | Attack unit / attack-move to point |
| `Q W E R D F` | Cast ability 1–6 |
| Click the green `+` | Spend a skill point (right-click an icon also works) |
| `S` | Stop · `B` Shop · `Space` centre on hero · `Tab` scoreboard |
| Middle-drag | Pan camera · wheel zooms · double-click re-follows hero |

## What comes out of the map

| | |
|---|---|
| Files recovered from the protected `.w3x` | **265**, including 155 imported assets |
| Heroes | **26**, with **130** abilities carrying real names, tooltips, cooldowns, mana and damage |
| Unit types | **997** (the map's on top of Warcraft III's), **968** with a converted model |
| Abilities | **1 046**, with the art and missile data Warcraft III draws for them |
| Items | **332** resolved types (Blizzard's on top of the map's), **47** sold in shops |
| Missiles | **375** unit types with a weapon missile: art, speed, arc and homing |
| Models | **998** MDX → glTF 2.0 `.glb` |
| Textures | **1 583** BLP/TGA → PNG |
| Sounds | **6 192** Storm-compressed clips → Ogg, plus the map's 60 imported MP3s |
| Terrain | 97 × 65 vertices, Cityscape tileset, 9 ground textures, real per-cell tile indices |
| Cliffs | **502** layer transitions → **498** Blizzard cliff meshes (54 distinct) + 4 ramp cells |
| Pathing | 384 × 256 walkability grid straight from `war3map.wpm` (59 % walkable) |
| Layout | Team bases, 5 shops, spawn points and camera bounds, all read from the map's own script |

The map is **protected**: its `(listfile)` was replaced with a stub, `war3map.j` was renamed,
and every file is MPQ-encrypted. `tools/mpq.py` handles this end to end:

1. **Header** — the `headerSize` field is corrupted by the protector; the hash/block table
   offsets are intact and self-consistent, so the header is parsed with a fixed 32-byte size.
2. **Encryption** — every file is encrypted with a key derived from its *filename*, which the
   protector deleted. Where the name cannot be mined out of the map data, the key is recovered
   by known-plaintext attack on the encrypted sector-offset table (`crack_key`): the first
   offset is always `(numSectors+1) × 4`, which pins the low byte of the key and yields the rest.
3. **Filenames** — since the file key *is* `hash(plainName)`, candidate strings mined from the
   decrypted contents are hashed and matched back against the cracked keys.

MPQ resolves names by hash, so a file can be readable even when nothing lists it. The extractor
probes the archives directly for anything the script references, which is how assets missing from
every listfile (spell effects, `TerrainArt\Water.slk`) still get pulled.

## Architecture

`war3map.j` is thousands of functions and hundreds of triggers. Porting that by hand silently
loses things, so instead the script runs verbatim:

```
server/jass/parse.js    JASS lexer + parser -> AST
server/jass/vm.js       generator-based interpreter (JASS threads can sleep)
server/jass/engine.js   handles, trigger/timer scheduler, event dispatch, 1102 natives
server/jass/boot.js     loads common.j + Blizzard.j + tft_supplement.j + war3map.j
server/world.js         engine-level simulation (movement, pathing, auto-attack, damage)
server/abilities.js     the base Warcraft III abilities, driven by the map's own data
```

The split follows Warcraft III itself. Anything the *engine* does — unit movement, acquisition
and leashing, auto-attack, damage and armour, base ability behaviour — lives in `world.js` and
`abilities.js`. Anything the *map* does — creep waves, duels, scoring, every spell's bespoke
effects — is the map's own script, executed as written.

At boot the VM runs `config()` and `main()` as Warcraft III would: **278 triggers, 28 timers,
128 units created, 0 errors**.

### How a spell works, end to end

FOC spells are re-skinned Blizzard abilities plus a trigger for the trimmings:

1. the engine checks level, mana and cooldown from `data/abilities.json` (the map's `w3a`
   values layered on Blizzard's `AbilityData.slk`);
2. the engine runs the base behaviour of the ability the custom one derives from;
3. the engine fires `EVENT_PLAYER_UNIT_SPELL_EFFECT`, and the map's trigger adds its sound,
   effects, animations and any dummy-unit chain.

Dummy units are how most FOC spells deliver their payload: a trigger spawns a unit carrying one
ability and orders it to cast. Ordering a dummy runs that ability through the same engine path.

Of the 130 hero abilities, 117 can be cast and 13 are genuinely passive. `tools/spell_audit.mjs`
casts every one of them at a punching bag and watches for the three things a spell can do to the
world: **114 of the 117 change it** (92 damage, 16 summon, 1 debuff, 5 caster-only). Of the three
that do not, two are abilities this map deliberately neuters — `war3map.w3a` zeroes their data and
sets the duration to 0.01, because the real effect is in the map's trigger — leaving Mana Shield
as the only base behaviour still missing.

That audit is worth having because the map's trigger plays a spell's sound, animation and effects
whether or not the payload lands. A spell with no engine behaviour still *looks* like it fired,
so "the effects played" is not evidence that anything happened.

### Reading the map's ability overrides

A map overrides an ability field by the four-character *metadata* id the World Editor uses, and
`Units\AbilityMetaData.slk` is the table mapping those to `AbilityData.slk` columns. The
indirection matters because the interesting fields are shared between abilities rather than named
after them: every summon in the game — Serpent Ward, Feral Spirit, Locust Swarm, Inferno — keeps
what it summons in `Hwe1`, `Ulsu`, `Uin4` or `Osf1`, all of which write the same `UnitID` column.
Guessing field names from the ability's own code instead (`ANsg` → `Nsg1`) finds nothing for
exactly those, so the summoned unit and count never reach the runtime and the spell casts with no
effect. Reading the metadata table resolves all 204 field ids this map touches.

Whether an ability is passive comes from the same place: Warcraft III gives everything castable an
order string in `Units\*AbilityFunc.txt`, and gives passives none. `targets` cannot stand in for
it — it is empty for instant abilities exactly as it is for passives, the same trap Targeting
below describes. Reading an empty `targets` as "passive" marks most of a FOC roster passive and
makes the engine skip the very ability a trigger spawned its dummy to deliver.

### The art a spell draws by itself

The same file holds every ability's art, and Warcraft III draws it without the map asking:
`Casterart` on whoever cast, `Targetart` on what was hit, `Areaeffectart` over the ground.
`Targetart` alone covers 321 abilities — it is the summoning puff, the strike flash, the buff
glow. FOC's triggers add their own effects on top, which is why some spells looked right already,
but anything relying on the ability's own art was silent: the art is not in `AbilityData.slk`, and
the map only names art it overrides, which for this map is almost always just the icon. Reading
Blizzard's art with the map's overrides layered on takes hero abilities carrying a resolved effect
model from **13 to 77**, and pulls another 151 effect models out of the archives.

Unlike a script's `AddSpecialEffect`, which lives until `DestroyEffect`, this art is one-shot, so
the server stamps a `ttl` on it and the client drops it when that passes.

Two things kept spells silent even after that. The first is that Warcraft III splits an ability
from the buff it applies — `ANms` is Mana Shield, `BNms` is the Mana Shield buff — and for anything
whose effect *persists*, the art hangs on the buff: `[ANms]` names only an icon, while
`Targetart=…ManaShieldCaster.mdl` sits in `[BNms]` next door. The map does not reuse Blizzard's
buffs either; it derives its own (`B002` from `BNms`) and puts its overrides there, so
`war3map.w3h` has to be read as well — with the same rule as units and items, the two tables
independent. Buffs ship no `MetaData.slk` in the archives, so their field ids (`ftat` target art,
`fsat` special, `feat` effect, `faea` area, `fmat` missile, `flig` lightning) are written out in
`tools/abilities.py`; the neighbouring `ftac` is a target *attachment count*, and a map that sets
it will hand you `"1"` as a model path if you let it. The second is that `emitAbilityArt` drew
four of the five art slots and never `Effectart`, which 103 abilities carry.

Together those take abilities carrying resolved art from **605 to 732**, and the hero spells that
tell the client to draw nothing at all from **33 to 2** — and both of those two are correct: Wind
Walk's visual is the unit turning transparent, and Locust Swarm's is the locusts it summons.
Neither has an effect model in Blizzard's data.

### Particles

About eighty of Warcraft III's effect models contain no geometry whatsoever. Death and Decay,
Cloud of Fog, Flame Strike's burn, most of the blood and frost: they are made of nothing but
`ParticleEmitter2` nodes. glTF has no concept of an emitter, so stripping them converted those
models to a valid and completely empty scene — the spell played its animation and nothing
appeared.

`tools/mdx.py` parses the `PRE2` chunk (speed, latitude, gravity, lifespan, emission rate, the
three-segment colour/alpha/scale ramps, the sprite-sheet grid and the blend mode),
`tools/mdx2gltf.py` carries each emitter across as node `extras`, and `client/js/particles.js`
rebuilds it: point sprites drawn from the atlas cell, walked through the three segments over the
particle's life, additive or blended as the filter mode says. Emitted particles stay in the
effect's own space rather than following the bone that made them, which is how Warcraft III
behaves for everything but a model-space emitter.

### Team colour, and the layer underneath

Warcraft III materials are stacked, and its usual way of team-colouring a unit is an *underlay*:
layer 0 is a flat `TeamColor` swatch and the character's real skin is blended over it, so the
colour shows only through the skin's transparent parts. Taking layer 0 — the first one in the
file, and the obvious one to take — therefore renders the team colour *instead of* the character.

It is not a rare shape. **412 of this map's 1151 models** are built that way, which is how Byakuya
Kuchiki, who wears a white haori, arrived as a solid red silhouette. `pick_layer` in
`tools/mdx2gltf.py` now takes the topmost real texture when layer 0 is replaceable, and leaves
layer 0 alone otherwise — a material whose layer 0 is a real skin has an *overlay* above it, a
glow or a shimmer, and taking the top layer there would throw the character away in exactly the
same fashion. Of the 470 multi-layer materials, 434 change and 36 stand. A skin lifted off an
opaque underlay has nothing left beneath it, so a blended layer becomes alpha-tested rather than
letting the world show through the character.

The colour itself is the *player's*, not the team's, and the map reassigns it — `SetPlayerColor`
is called ten times and used to be a no-op. It is now stored on the player, carried in the
snapshot, and the client swaps the material's texture for the matching
`ReplaceableTextures/TeamColor/TeamColor{NN}.png`, which is what Warcraft III does. The previous
code tried to *tint* instead, and detected what to tint by sniffing `image.currentSrc` — a
property `GLTFLoader`'s `ImageBitmap` does not have, so the tint never applied to anything. The
converter's baked default is colour 00, which is red; that is why every unit of every team was
red rather than merely the wrong colour.

### The clock in the corner

There is no day/night cycle in this map — `SetTimeOfDay` is never called — so the only clock a
player gets is Warcraft III's **timer dialog**, and this map runs its duel countdown through one:

```jass
call CreateTimerDialogBJ(udg_timer01, "|c00ffff00Duel in")
call StartTimerBJ(udg_timer01, false, GetRandomReal(290., 310.))
```

The natives used to be accepted and thrown away (`TimerDialogSetTitle` was not implemented at
all). They are now real objects, the remaining time rides the snapshot, and the client draws it
top-right where the game puts it. The title arrives with Warcraft III's own colour markup,
`|cAARRGGBB … |r`, which is honoured rather than stripped — the map chose yellow, so it reads
yellow.

### Creep waves, and one falsy zero

The map runs three creep waves as periodic triggers, and they **escalate rather than stack**:

| beat | roster | bodies |
|---|---|---|
| 30 s | gnolls, nagas, spiders | 42 |
| 60 s | bandits, priests, grunts, footmen, knights, wizards | 68 |
| 90 s | bloodfiends, tauren, necromancers, ghosts, doom guards | — |

```jass
call BO(300.)                       // five minutes in
call DisableTrigger(udg_trigger43)  // 30s wave off
call EnableTrigger(udg_trigger45)   // 60s wave on
call BO(900.)                       // fifteen minutes later
call DisableTrigger(udg_trigger45)
call EnableTrigger(udg_trigger46)   // 90s wave on
```

Nothing here schedules creeps; the map's own triggers do, and the 30-second wave was already exact
— ten waves in five minutes, each at 30.0 s, each 42 bodies, matching the roster count. The
handover never happened, though, and the cause was one character in this port:

```js
TimerGetElapsed: (t) => (t ? (eng.now - (t.started || eng.now)) / 1000 : 0)
```

The map starts its stopwatch during init, so `started` is **0** — falsy — and `started || eng.now`
falls through to now, reporting zero elapsed *forever*. `BO` is the map's own polled wait: it
subtracts elapsed from its target and loops until the remainder reaches zero, so with a stopwatch
frozen at zero it never converges. `?? ` instead of `||` fixes it, and the handover then lands
between 299 s and 310 s exactly as scripted.

The blast radius is the part worth remembering: **`BO()` is called at 193 sites**. It is the map's
universal wait, behind every staged sequence in the game, and all of them were hanging on a
timestamp that happened to be zero.

`tools/spawn_test.mjs` watches the waves land and checks the beat and the body count.

### Dummy units, and a leak that is the map's own

Warcraft III maps cast most of their bespoke spells through **dummy units**: an invisible helper is
created, ordered to cast, and discarded. They are invisible because they carry Locust and name a
model that does not exist — and this map writes that name four different ways in Korean (`없다`,
`없음`, `업다`, `읎지여`), so matching the spelling is a losing game. What settles it is that the
unit is Locust *and* names no model that was ever converted.

The client used to draw a stand-in mesh for any unresolvable model — deliberately, so missing art
is visible rather than silently absent — which for a dummy is exactly wrong: it walks the
battlefield as a grey capsule. **27 of this map's unit types would have shown that way.** Byakuya's
Senka is where it was noticed.

The dummy it creates is never removed:

```jass
call CreateNUnitsAtLoc(1,'h005', owner, loc, bj_UNIT_FACING)
set udg_unit05 = bj_lastCreatedUnit
call IssueImmediateOrderById(udg_unit05, 852127)
```

No `RemoveUnit`, no `UnitApplyTimedLife` on that path, though the map calls both elsewhere — so it
leaks one unit per cast in the original game too, invisibly. Measured here: twenty casts, twenty
dummies, none removed.

They are left in the simulation, because a trigger that counts units of a type would notice if they
disappeared and the map's behaviour is the thing being reproduced. What changed is only that
`snapshot()` no longer sends them: the client has nothing to draw for a dummy, so transmitting one
is pure cost. Twenty casts took the wire from 62 entities to 42, every one of the remainder a real
creep.

### Shadows

Warcraft III does not shadow-map anything. It lays a flat textured quad on the ground beneath each
unit — `ReplaceableTextures\Shadows\Shadow.blp`, a soft dark blob — and the unit's own data names
the image and gives its size and offset (`ushu`, `ushw`, `ushh`, `ushx`, `ushy` in `unitUI.slk`).
**767 of this map's 997 unit types carry one.**

That is why turning `shadowMap` on would not have produced them, and why it stays off: a decal is
both faithful and far cheaper than a shadow pass. The data was already sitting in
`data/blz_units.json`; `tools/unittypes.py` simply never copied it through, so nothing downstream
could draw it. It now travels unit table → `unitmodels.json` → the view, and `attachShadow` builds
the quad.

Verified by toggling only the shadow mesh in one frame: **11 710 of 76 800 pixels change**. It is
deliberately subtle — the texture peaks at alpha 191 and the material sits at 0.55, which together
cap the darkness at about 40%, roughly where Warcraft III's own shadows land.

### Ribbons

A ribbon is a trail. The emitter is a point on the skeleton — a sword tip, a hand, the leading edge
of a wave — and Warcraft III leaves a strip of texture behind it as the animation drags it through
space. There are **326 of them across 128 models** here, and 7 of the 26 heroes carry one: Ichigo,
Akiha, Byakuya, Renji, Kisame, Eneru and Rob Lucci — exactly the blade users. Without them a sword
slash is an arm moving through empty air.

`tools/mdx.py` reads the `RIBB` chunk (`heightAbove`/`heightBelow`, colour, alpha, lifespan,
emission rate, the sprite-sheet grid, and the material it draws with), `tools/mdx2gltf.py` carries
each emitter across as node extras, and `client/js/ribbons.js` rebuilds it: every frame the
emitter's world position gives one new pair of edge points, offset along the bone's *own* up axis
so the strip twists with the blade, and the last `lifespan` seconds of those pairs are stitched
into an indexed triangle strip. A ribbon names a *material* rather than a texture, so it resolves
through the same `pick_layer` rule that picks a mesh's surface — the team-colour underlay fix
applies to trails for free.

Two things worth knowing, because both make a ribbon look broken when it is not:

- **Warcraft III does not fade a ribbon along its length.** The strip carries the emitter's alpha
  end to end and the *texture* provides the softness — which is why these are blur and glow
  images. Tapering on top of that halves an effect that is already faint and puts the oldest
  segment at exactly zero. Removing the taper took Ichigo's trail from 0 visible pixels to 83 and
  Byakuya's from 177 to 334.
- **A ribbon only exists while its bone is moving**, so it cannot be measured from a still pose,
  and it is a faint *additive* wash over already-lit ground, so it cannot be measured by counting
  bright pixels either — it never pushes anything over a brightness threshold.
  `tools/ribbon_shot.mjs` plays the attack animation and then renders the same frame twice, once
  with the ribbon meshes hidden, counting the pixels that *changed*.

### Changing form

Metamorphosis (`AEme`) and Chemical Rage (`ANcr`) genuinely replace the unit: the ability's `unit`
field names the alternate form, and Warcraft III swaps it back when the buff ends. That is why
they carry no effect art — the new body *is* the effect. Approximating it with a damage buff left
nine heroes' whole transformation as a number going up quietly.

`World.morph` swaps the type-derived fields and `unmorph` puts them back. The hero keeps its
identity across the change — same level, experience, skills and inventory — and life and mana
carry as *fractions*, so entering a form with a larger pool does not heal you for the privilege
and leaving one does not kill you. On the client a unit's view is built once from the model its
type names, so `main.js` rebuilds it when the type underneath it changes.

An order string is also not proof that an ability can be cast. Warcraft III gives its passive
skills one — Attribute Bonus answers to `attributemodskill` — because the skill tree needs
something to name. What separates them is the icon: passive art lives under
`ReplaceableTextures\PassiveButtons`, and nothing castable does. Reading the order alone meant the
engine "cast" a permanent stat bonus, found a number in its data and threw it at the target as
damage, and no hero ever received the stats. They are now applied in `recalc`, next to the item
bonuses, from the same three data slots the stat tomes use.

### Missiles

A ranged attack resolves when the missile arrives, not when it is loosed, and the weapon's own
`Missilespeed` decides how long that takes. The damage still belongs to the unit that was aimed at
— an arrow does not miss because its target walked — but a target that dies first is simply never
hit, and that gap is the whole point of giving missiles travel time. `EVENT_PLAYER_UNIT_ATTACKED`
still fires on the swing, as the game does; damage, cleave, lifesteal and the impact sound wait for
the arrival.

Spells travel the same way. An ability names its own missile in `Units\*AbilityFunc.txt`, so
nothing needs a list of which spells fly: if the ability carries `Missileart` and a
`Missilespeed`, its payload is handed to a missile and runs when that lands. **50 of the roster's
119 castable abilities** travel; the other 69 have no missile in their data and resolve where they
are cast, which is what a caster-centred stomp or a self-buff should do. A spell aimed at the
ground still lands there even if whoever was standing on it dies first — only a homing shot is
spent when its target dies.

Only the *engine* payload waits. The map's own trigger fires at cast time, because that is when it
fires in the real game, so a spell's sound, animation and dummy-unit chain are unaffected.

Like the ability art, none of this is in a `.slk`: `Missileart`, `Missilespeed`, `Missilearc` and
`MissileHoming` live in `Units\*UnitFunc.txt` and `Units\*AbilityFunc.txt`. Reading only the map's
own overrides found missile art for 9 of this map's 301 ranged unit types; reading Warcraft III's
finds 299.

### Translation

The map is Korean. `data/translations.ko-en.json` is a LLM-written overlay keyed by the exact
original strings, and it is the only part of this project that is not derived from the map — which
is why it is a separate file rather than something the extractor produces. `tools/compile_game.py`
applies it as `nameEn` / `tipEn` / `descEn` / `titleEn` beside the untouched originals, so the map's
own text always survives and the client can show either.

Descriptions are translated a line at a time, which suits how they are written: a sentence of prose
followed by `◎` stat lines that are almost entirely formulaic (117 of them are just a cooldown). A
line with no entry keeps its Korean rather than being guessed at. Tooltips are rebuilt from their
parts instead of string-substituted, because the name in a tooltip is usually a shortened form of
the ability's own name — "잠영사수" for "소환술-잠영사수" — and the hotkey and level tag are each
optional, with this map spelling the level tag "레벨l" as often as "레벨".

Technique names use the established English or romanised name from the series the map draws on
where one exists, since that is what a reader of the source would recognise: `소환술-잠영사수`
becomes "Summoning Jutsu: Hidden Shadow Snake Hands", not a literal gloss.

### Items, and what a hero carries

An item inherits exactly the way a unit does, and the shop is where that bites. Almost every entry
in this map's shop is a stock Blizzard item with one field changed: "Strength +2" is a Tome of
Strength with a new price, and the map overrides `igol` and nothing else. The ability that actually
grants the strength, `AIsm`, is named only by the Blizzard base -- so reading the item's own
overrides alone leaves it with no abilities, no icon and no model, which is to say doing nothing
when bought. `tools/itemtypes.py` resolves the chain (`ItemData.slk` + `ItemFunc.txt` +
`ItemStrings.txt`, then the map's `war3map.w3t` on top), and the runtime knows all **332** item
types rather than only the 47 a shop happens to sell.

A **powerup** is spent the moment it is picked up. Warcraft III does not carry a tome: the bonus
becomes part of the hero and the item is gone. Seven of this map's shop items are powerups, so
holding them instead would fill a six-slot inventory with things that should never have taken a
slot -- and would make a 19 000-gold permanent stat purchase something you could drop by accident.

Which bonus an item ability grants is keyed by the Blizzard ability it derives from, using
`AbilityData.slk`'s own `comments` column rather than a guess at the name. That is what settles
cases like `AIs1`: it is StrengthBonus (+1), not the attack-speed item its id suggests, and reading
it as one granted the wrong stat entirely.

### Items in the world

An item system that only exists inside inventories is half a system, and this was the half that
was missing. The server had always tracked ground items — `dropItem` cleared the owner and set the
coordinates correctly — but `snapshot()` sent only units, so a dropped item was invisible, and no
command existed to ask for one back. From the player's seat it simply vanished.

Ground items now ride the snapshot alongside units, and the client draws them from their own
`file` model (all 332 item types have one) with a slow bob and spin, so a small model on busy
ground is still findable. Right-clicking one is Warcraft III's smart order: the hero **walks to it**
and takes it on arrival rather than teleporting it into a slot, bounded by MiscData's
`FollowItemRange` of 1000. A *powerup* needs no order at all — walking over it is enough, which is
what makes a rune a rune — while an ordinary item lies there until someone is sent for it. Two
items dropped on one spot would be one item as far as anyone clicking is concerned, so a drop
spirals out to the first free spot.

Selling back uses the `pawnItemRate` gameplay constant (0.75 here) and fires `PAWN_ITEM`, which was
the last of the seventeen event kinds this map registers that had never fired — not because it was
unimplemented but because nothing in the audit ever sold anything. `tools/audit.mjs` now picks an
item off the ground and sells one, and reports **17/17**.

Two engine gaps surfaced while testing this and are worth naming, because both made the shop
unusable rather than merely imperfect:

- **The client was never sent the item table.** The lobby payload carried `shops`, and a recipe
  result is in no shop's stock list, so the client had no name or model for most of what it might
  find lying about. It now gets every item type.
- **Bounty was paid on the blow rather than on the death.** `awardKill` was called from the damage
  path only, so anything the map's own triggers killed with `KillUnit` — and this map kills plenty
  that way — was worth nothing. It now runs from `killUnit`, so every death pays once however it
  happened.

### Enumerating units by type

`GroupEnumUnitsOfType` matches on the unit type's *name*, and Blizzard.j's `GetUnitsOfTypeIdAll`
reaches it by round-tripping a type id through `UnitId2String`. Returning every unit instead turns
that helper into a map-wide sweep — and FOC uses it to clear a spell's dummy units, so a single
cast of InuYasha's 금강창파 `RemoveUnit`ed all 130 units on the map, shops and boss included. Both
natives are implemented against the unit type's own name so the round trip closes.

`tools/audit.mjs` is what surfaced it. The audit drives a scenario through every mechanic and
reports which registered trigger events actually fire (**17 of 17**). Everything it needs — heroes, an item,
the boss — comes from the map's own compiled data, so pointing the pipeline at another map does not
send it looking for ids that no longer exist.

### Where the numbers come from

Gameplay constants are layered exactly as the game layers them: `Units\MiscGame.txt` from the
archives, then **the map's own `war3mapMisc.txt` on top**. This map overrides 16 of them,
including `MaxHeroLevel=50`, `DefenseArmor=0.02` and every hero stat bonus — reading only the
Blizzard tables gets all of them wrong.

Warcraft III derives life from strength, mana from intelligence and armour from agility for every
hero, but **attack damage from that hero's own primary attribute**. This map leans on that: it sets
a base template granting +15 to every attribute per level and then overrides each hero on top, so a
hero who never overrides the strength gain still carries +15 strength a level. Reading damage off
strength rather than the primary attribute therefore does not misprice heroes slightly -- it
roughly doubles some of them. `tools/hero_audit.mjs` prints every hero's attributes and what the
engine derives from them at levels 1, 25 and 50, and flags the heroes whose largest gain is not
their primary attribute.

A map's `war3map.w3u` carries two independent tables, and they must stay independent. The
"original" table edits the standard Warcraft III units; a custom unit inherits the **default**
values of its base, not the author's edits to that base. Chaining them hands a hero whatever was
done to the standard unit it was built from — and this map edits `Ulic`, `Obla`, `Oshd` and `Hmkg`
into 700-damage, 7500-life templates for its own use elsewhere, which gave exactly the five heroes
derived from them 210–760 base damage at level 1 while the other twenty-one sat on Blizzard's 0.
Reading the tables independently puts the whole roster on 60 damage at level 1, bar the boss and
the one hero who sets his own.

Field ids have to come from `Units\\UnitMetaData.slk` rather than a guess, for units exactly as for
abilities. `ucbs` is the cast backswing and `ucol` the collision radius; reading the first as the
second gave 25 of the 26 heroes a collision of `0.1` — the map's backswing value — and dropped the
real overrides on 127 units. `ua1z` is `Missilespeed`, not the attack's target list, and `umh1` is
`MissileHoming`, not a damage upgrade.

Experience follows the documented `f(x) = A*f(x-1) + B*x + C` tables. Skill unlocks come from
each ability's own `reqLevel` / `levelSkip`, not a fixed every-other-level rule, so an ultimate
can legitimately want hero level 30.

### Targeting

Warcraft III's ability tables carry no "unit target vs point target vs instant" column —
`targs1` is populated for instant and point abilities alike. `tools/spell_targets.mjs` derives it
from the map's own triggers instead: cast every hero ability once and record which accessor its
trigger reaches for. `GetSpellTargetUnit` means it wants a unit, `GetSpellTargetLoc/X/Y` a point,
neither means it fires where it stands. Result: **84 point, 20 unit, 11 instant**.

## Client

`client/js/render.js` builds terrain from the real heightmap, resolves a model for each unit type
the script can spawn, and drives per-entity `AnimationMixer`s.

* **Geoset visibility** is evaluated per sequence the way the engine does — tracks are scoped to
  the playing sequence, and a sequence with no keys falls back to the object's static alpha.
  Sampling the raw track instead carries the previous sequence's trailing value forward, which
  made walking creeps invisible.
* **Node transforms are scoped the same way**, and for the same reason. MDX packs every sequence
  onto one timeline — a spider's Stand is frames 10000–11667, its Death 23333–24500, its Decay
  Flesh 33333–93333 — and Warcraft III plays each in isolation. Interpolating across the whole key
  list instead means a track with no keys inside the playing sequence blends between the key
  *before* it and the key *after* it: an idle spider slid a little further toward its death pose
  every frame of the Stand loop, tipping over and sinking into the ground, then snapping upright
  when the loop restarted. Keys outside the sequence now take no part, and a track with none
  inside falls back to rest. Tracks driven by a global sequence are exempt — those run on their own
  clock, independent of whichever sequence is playing.
* **Every channel a model animates is emitted in every one of its sequences**, pinned to rest where
  a clip does not move it. glTF nodes are shared between animations, so a node the playing clip
  leaves alone otherwise keeps whatever the last clip put there — and `Decay Flesh`, being last in
  the file, was baking a settled corpse into every other pose.
* **Ground** is baked from the real tileset art with Warcraft III's 4-bit corner-mask blending:
  each cell stacks its corner textures in tileset order, the lowest filling the cell and each
  higher one composited through the blend mask for the corners it occupies. 31 % of cells blend.
* **Cliffs** are Blizzard's own meshes, not geometry this project invents. Warcraft III drops the
  ground wherever a cell's four corners disagree on layer height and stamps a prefabricated model
  carrying the low surface, the wall and the high surface in one piece — so interpolating terrain
  across that cell is exactly what turns a step into a ramp. `tools/cliffs.py` reads the four
  corner layers as the four-letter code the meshes are named by (counter-clockwise from the
  south-west, `A` the cell's own base and each later letter a layer up), picks the variation from
  the `.w3e` details byte, and bakes all 498 into one triangle soup; the client drops those cells
  from the ground mesh and draws the result in a single call. Ramps are not cliffs: a cell with
  all four corners ramp-flagged keeps its sloping ground, which is what makes it walkable, and the
  map's own pathing grid agrees — exactly those 4 cells are walkable and the other 498 are not.
  `tools/cliff_test.py` holds the result against the terrain it has to meet: wherever a cliff
  vertex lands on a terrain grid point its height must equal that vertex's ground height, which a
  transposed corner order or an off-by-one placement breaks immediately (currently 0 mismatches
  across 3 984 such vertices). `tools/cliffview.html` with `tools/cliff_shot.mjs` renders the
  terrain and the cliff mesh on their own, so a bad cliff shows without the rest of the game in
  the way.
  `CliffTypes.slk` names the wall texture unqualified, but every tileset bar Lordaeron Summer
  ships its own recolour as `<tileset>_<texFile>.blp`; taking the bare name gave this Cityscape
  map grassy Lordaeron cliff tops.
* **Water** comes from the `.w3e` water flag plus `TerrainArt\Water.slk` for the tileset's surface
  offset, frame count and animation rate, with alpha ramping by depth so it fades at the shore.
* **Spell visuals** — `SetUnitAnimation`, `AddSpecialEffect`, `SetUnitVertexColor` and friends all
  render; effects carry stable ids so `DestroyEffect` drops the right instance.

## Tooling notes

`tools/mdx.py` is a complete MDX v800 reader (geosets, materials, bones, helpers, attachments,
collision shapes, particle/ribbon nodes, and all animation tracks with hermite/bezier tangents).
`tools/mdx2gltf.py` converts MDX's pivot-relative node transforms into glTF's TRS model by folding
the pivot into the inverse-bind matrix:

```
world(A_i) = world(A_parent) . T(loc_i + pivot_i - pivot_parent) . R_i . S_i
inverseBind_i = T(-pivot_i)
```

### Auditing the spells

`tools/spell_check.mjs` reads every hero ability's tooltip as a promise and holds the engine to
it. The map writes its descriptions to a house style — a line of prose, then `◎` lines carrying
the numbers — so an expectation can be parsed from the text and set against a real cast: damage
dealt, summons made, buffs applied, whether the caster moved or changed form, what the cooldown
charged. `tools/spell_render.mjs` answers the other half, replaying the effects each cast emitted
into the renderer on its own (`tools/fxview.html`) and counting how many pixels of the frame
change. `tools/spell_sheet.py` renders both as one page.

It is a heuristic and reads as a worklist, not a verdict — but the harness has to be honest about
its own failures, and three of them were instructive:

- The bench first stood at (12000, 12000), which is off the edge of a map that runs ±6144 × ±4096.
  Damage is only arithmetic and looked fine; everything that moves a unit resolves against the
  pathing grid, so every blink reported `blocked` and eleven working spells read as broken.
- Counting summons by the `summonedBy` tag missed every summon the map's own triggers build;
  counting by owner swept in creep waves across the whole map; counting by proximity still caught
  the invisible dummy units Warcraft III carries spell effects on, and reported Gum-Gum Storm as
  summoning 169 things. The dummies are marked with Locust (`Aloc`), which is the engine's own way
  of saying "this is not really a unit".
- The render bench reads frames back off the GPU, and a lost swiftshader context reads back solid
  black — which is indistinguishable from "every spell is invisible", and duly reported all 119
  casts as drawing nothing. It now proves the empty frame has ground in it before any result is
  allowed to count, and refuses to write results otherwise.

Two more traps are worth naming because they cost real time. A WebGL canvas screenshots *blank*
unless `preserveDrawingBuffer` is set — the buffer is cleared once the frame is composited — so
`tools/shot.mjs` counts what is in the scene rather than trusting a picture of it, which is what
`window.FOC` exists for. And a headless browser launched with a persistent `--user-data-dir` will
serve the copy of a tool page it cached before your last edit; `setCacheEnabled(false)` does not
clear what is already in there, so `tools/model_shot.mjs` takes a fresh profile each run. Both of
these look exactly like "the thing you just fixed does not work".

### Two players in one room

`tools/duo_test.mjs` seats two browser clients on opposite teams in the same room and asserts they
can actually see each other. Until it existed, every browser test in this repo opened a single
page and `audit.mjs` drove the world with no client at all — so the multiplayer half of a
multiplayer map had never been watched working, which is a poor thing to be unsure of. It checks
that both reach the game as distinct heroes, that each appears in the other's snapshot, that they
land on opposing teams wearing *different* player colours, that movement and chat cross between
them, and that an item one drops appears on the other's ground.

Two details it forced. Gold has to be earned — this map has no starting purse — so the test fights
until it can afford the cheapest item that is **not** a powerup; a powerup is spent the moment it
is bought and never occupies a slot, so buying the cheapest thing on the shelf leaves nothing to
drop. And it waits on the client's own `phase`, not on a CSS class: the HUD un-hides on its own
schedule and is not what "the game started" means.

It passes 11/11, and found no defect in the game — the two failures on the first run were both in
the test (snapshot entities are keyed `i`, not `id`).

`tools/verify_glb.py` re-reads the exported `.glb`, applies the skin and renders it with a
software rasterizer. Treat it as a rough look, not a verdict: it draws models that are known to be
correct in the browser as mangled, so a bad picture from it proves nothing on its own. What does
hold up is comparing numbers — skin the `.glb` at t=0 of a sequence and check its bounding box
against the `extent` the MDX declares for that same sequence, which is authored data and sits in
the sidecar `.json`. That is what caught the sequence-scoping bug: a spider's Stand should span
`-0.7 … 73.5` vertically and was giving `-73.8 … 20.3`.

Warcraft III compresses sound with Storm's **Huffman + ADPCM** codec (sector mask `0x41`),
implemented in `tools/storm_codec.py` — ported from StormLib's algorithm with Blizzard's
weight/step tables extracted mechanically rather than transcribed. Without it no game audio
decodes at all.

Sound resolves in both directions: the script's own `PlaySoundBJ` family plays the exact clip it
names, positioned and attenuated from the listener, while unit sound sets are played by the
engine from `unitUI.slk` / `UnitAckSounds.slk` / `UnitCombatSounds.slk` as the game does.

## Switching maps

The pipeline finds the `.w3x` itself (`tools/mapfile.py`: `$FOC_MAP`, else the only map in the
directory, else the newest). Drop the new map in and run:

```bash
FOC_MAP="my map.w3x" bash tools/pipeline.sh
npm start
```

Everything downstream — heroes, abilities, items, shops, terrain, spawns, teams, win conditions,
gameplay constants — is derived from the map at build time. `tools/stage.py` rebuilds
`public/assets/{models,textures,sounds}` from scratch each run, so the previous map's files are
never served, and what can actually spawn comes from the map-derived tables rather than from
whatever happens to be on disk.

What still needs a look after a swap: heroes whose model path is empty in the map data, and any
ability the map drives through a mechanism the probe in `spell_targets.mjs` cannot see.

## Status

**Working** — extraction and asset conversion; the JASS VM running the map's real script; creep
waves with acquisition ranges and guard leashing; hero picking; spells (engine behaviour plus the
map's own triggers) with animations, effects and tinting; XP, levelling and skill unlocks; items
and shops; duels; respawn; the map's multiboard; fountains; waygates; sound; minimap; blended
terrain, animated water and stepped cliffs; ranged attacks and spells with real missile travel
time; particle emitters, without which around eighty of Warcraft III's effect models are empty;
ribbon trails behind the blades of the seven heroes that carry them; omni lights on spell effects;
the ground shadow every unit carries;
heroes that change form, keeping their level, skills and inventory across it;
a six-slot inventory with items that grant what their data says, items that lie in the world and
are walked to and picked up, powerups taken on contact, and selling back at the map's own rate;
two players in one room, on opposing teams, in their own colours, seeing each other's moves, chat
and dropped items.

**Approximated or missing** — the wedges Warcraft III sets where a ramp meets a cliff
(`CliffTrans`) are drawn as ordinary cliff walls, which affects the 20 cells flanking the two base
ramps; Mana Shield is the one hero-ability base with no engine behaviour left; lights and the older
`ParticleEmitter1` is parsed, exported and spawns its pieces but has never been confirmed to put a
pixel on screen; neither a particle emitter's nor a ribbon's own animation tracks (a rate or alpha
that varies over the effect) are applied yet; no fog of war; no
day/night cycle; there is no attack backswing, so a swing still resolves the moment it starts even
though the missile it throws now takes time to arrive; pathing is A* over the map's real walkability grid rather than Warcraft III's flow-field
movement; a handful of
cosmetic natives (camera shake, terrain deformation, cinematic filters) are no-ops.

**Translation** — this map's text is Korean. It is now also carried in English by a hand
translation overlay, `data/translations.ko-en.json`, which is kept deliberately outside the
extraction: it covers every hero title, ability name and tooltip line the roster uses (25 titles,
128 names, 378 description lines, nothing left over), and `tools/compile_game.py` emits the
English *alongside* the map's own strings rather than in place of them. The client ships both and
the `EN` / `한` button in the lobby chooses which to show, remembered per browser. Anything the
overlay has no entry for falls through to the original, so the map's text is never lost and never
guessed at — see [Translation](#translation) for how it is applied.
