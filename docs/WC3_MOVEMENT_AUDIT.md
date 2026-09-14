# WCIII movement and targeting audit — 2026-09-14

Status update, 2026-09-14: findings 2 (body blocking) and 4 (attack-move) are
fixed for the reproduced cases. Movement now checks the swept path against live
bodies, including paused/stunned units, and replans around occupied cells rather
than pushing blockers. Closed surrounds hold and movement resumes when a gap
opens. Attack-move acquires enemies, preserves its destination, and resumes it
after combat; Patrol keeps its return route. The original observations below
are historical, and their code line numbers refer to the audit baseline.

`tools/movement_orders_test.mjs` covers these changes with 27 checks. All 11
targeted suites passed: movement_orders, gameplay_parity, pathblock, casttime,
carried, proc, spellshape, numorder, match, victory, wincond. The existing 92
shared-gameplay checks still pass. Source and local runtime copies are synced.

Follow-up: finding 6's reproduced unit-target casting bugs are fixed. The
compiler now retains stock and per-level target lists (644 populated abilities,
previously 196), including explicit empty overrides. Required unit-target spell
cases validate relationships, target categories, life/invulnerability and
organic/mechanical restrictions before ordering and during casting. Invalid
orders preserve the current order, mana and cooldown. Direct script damage is
unchanged. Point/area spell filtering and cursor feedback remain separate work;
this does not certify every ability's special targeting rules.

Finding 5's flight metadata is restored: movement type, initial height, target
classification and unit classifications survive extraction, creation and morphs.
IsUnitType(FLYING) uses movement type, so lifting a ground unit no longer turns
it into a flying unit. Weapon target selection now preserves both weapons and their enable mask,
range, damage/dice, attack type, damage point, backswing and missile settings.
Acquisition, pursuit and attack release use the eligible weapon. Ineligible
explicit attack orders are refused; changing target category before release
cancels that windup. Ground-only units skip flying targets, while a Gargoyle
uses its melee air weapon and ranged ground weapon independently. The
[Blizzard Gargoyle reference](https://classic.battle.net/war3/undead/units/gargoyle.shtml)
confirms these distinct weapons; map data supplies the actual values.

`tools/weapon_targets_test.mjs` adds 41 checks, including enable masks, attack
orders, pursuit range, projectile damage type and morph restoration. The existing
92 gameplay checks and 27 movement checks still pass. Special weapon behavior such as artillery splash and secondary impact sounds
are not completed by the weapon change.

`tools/spell_target_rules_test.mjs` adds 44 regression checks. Existing target,
cast-time, passive, alias, combat, movement and match suites pass.

Movement follow-up: finding 3's reproduced missing-clearance case is fixed
using the port's circular footprint. Planning, A* edge validation, path smoothing
and movement all check swept disk clearance against blocked cells and map bounds.
A 64-unit-wide hero cannot route through a 32-unit opening. Existing routes are
validated before each movement step, including fast and final-waypoint movement.
This is not a claim about retail collision-size quantization.

Flight movement now has its own staged bitmap: WPM's 0x04 restriction and the
green channel of destructable pathing textures. Destruction releases owned flight
cells while preserving terrain restrictions, overlapping blockers and death
footprints. Ground bodies and air bodies occupy separate movement layers.
Spawn placement, movement orders, pursuit, cast approach and return routes select
the unit's movement layer; visual height alone does not change it. The format
flag is also documented in the [w3z editor constants](https://github.com/LeoYawoo/w3z-editor/blob/master/War3TypesAndConstants.h).

`tools/terrain_clearance_test.mjs` adds 23 checks using synthetic corridors,
production flight data, and real World movement/destruction. All 14 targeted
suites pass, including the previous movement, combat, targeting and match tests.

Turning follow-up: authored turn rate is now retained on runtime units and
morphs. SetUnitTurnSpeed/GetUnitTurnSpeed write/read it. Ordered movement,
attack start and ranged cast approach share an angular budget per simulation
tick, turn by the shortest angle, and wait for facing before proceeding. Paused
and stunned units cannot turn. Existing explicit SetUnitFacing behavior remains
independent of ordered turning.

The rate conversion is radians per 0.03 game seconds, based on
[first-hand WCIII turning measurements](https://www.hiveworkshop.com/threads/unit-turning-mechanics.300224/).
This port scales it to its 30 Hz simulation. It currently requires full facing
alignment; exact retail facing tolerance, sub-frame timing, visual orientation
interpolation, and timed facing natives remain unverified. These are explicit
limits of this implementation, not a certification of exact retail turning.

`tools/turn_rate_test.mjs` adds 29 checks covering native rate changes, reversal
delays, shared budgets, angle wrapping, attack/cast startup and morph restoration.
The cast-time and proc fixtures face their targets to isolate those rules from
turning; their original timing and damage assertions remain intact. All 15
targeted suites pass.

Exact retail turning/footprint/avoidance behavior and the remaining spell/weapon
special cases above remain open. Collision still uses the port's circular
footprints; these fixes do not claim exact retail collision geometry, friendly
yielding, or unit-size clearance against terrain.

Six findings were reproduced after the previous gameplay fixes. Run
`node tools/movement_parity_probe.mjs` to repeat the observations.

The diagnostic uses production unit/ability definitions, World methods, and
registered natives, with an artificial open grid to isolate the rules. The
narrow corridor is also synthetic. No retail comparison was run. Exit zero means
the diagnostic completed, not that WCIII parity passed. Exact turn timing,
collision geometry and local avoidance need retail measurements before a full
movement implementation can be called equivalent.

## 1. Turn rate is discarded; facing snaps instantly

**Observed:** reversing a moving hero rotates him 180 degrees and moves him
8.333 units west in the first movement step. Calling `SetUnitTurnSpeed` with 0.1
or 0.9 produces identical results. The runtime unit has no turn-rate field.

**Evidence:** `tools/unittypes.py:30` extracts turn rate and `:91` maps the map's
`umvr` override. H00N carries 0.6. `World.createUnit` never copies it, movement
assigns `atan2` directly (`server/world.js:2371`), and attacks and casts also
assign facing directly (`:2518`, `:1953`). The native is empty
(`server/jass/engine.js:688`). Blizzard's WorldEditStrings labels `umvr` as Turn
Rate. Community [turning test maps](https://www.hiveworkshop.com/threads/make-units-spin.135074/)
also demonstrate non-instant turning.

**Impact:** changing direction, starting attacks behind the hero and facing a
spell target all bypass turning. This affects chasing and escape timing.

**Fix boundary:** preserve and use turn rate for movement, attack and cast
approach. Measure WCIII's rate-to-time conversion and facing tolerance rather
than treating 0.6 as an invented number of degrees per second. Keep native
instant-facing operations separate from normal ordered turning.

## 2. Unit collision cannot preserve a body block

**Observed:** a mover travels from x=80 to x=400 directly through a paused or
stunned blocker at x=160. Their centers get within 3.33 units even though their
combined runtime radius is 63. With the blocker on Hold instead, the mover pushes
it from x=160 to x=401.5 over two seconds.

**Evidence:** `World.step` skips paused/stunned units before adding them to the
list passed to `separate`. Movement checks terrain only. `separate`
(`server/world.js:2593`) resolves overlap afterward by displacing both units
equally, without respecting Hold or differentiating friendly and hostile bodies.
The fixture uses opposing players, normal pathing and no spells that disable it.

**Reference:** Blizzard explicitly recommends
[blocking Siege Engines with units](https://classic.battle.net/war3/human/units/siegeengine.shtml).
Its [Hold Position description](https://classic.battle.net/war3/basics/unitcommands.shtml)
depends on units retaining their assigned position.

**Fix boundary:** include incapacitated bodies in occupancy, distinguish units
that may act from units that still block, and resolve legal movement before
committing it. Pushing every overlapping unit is not a substitute for blocking.
Exact friendly yielding and collision geometry remain retail comparison work.

## 3. Terrain routes have no unit-size clearance

**Observed:** A* returns a straight route down a corridor one 32-unit cell wide
for coordinates occupied by a hero whose configured collision radius is 32.
There is no way to pass that size into the pathfinder.

**Evidence:** `server/pathing.js` accepts only start/end coordinates and an
expansion limit. `walkable`, A* and `clearLine` check the center's cells only.
`World.stepMove` also checks only the next center point against terrain, not the
unit's footprint. Blizzard's `ucol` field is Collision Size; the production
runtime itself uses it as a radius for unit overlap.

**Impact:** the engine cannot distinguish routes passable by smaller units from
ones obstructed for larger units. The synthetic example establishes the missing
clearance handling; this audit does not count affected corridors on the real map
or establish WCIII's exact collision-size quantization.

**Fix boundary:** path planning, line-of-sight smoothing and movement validation
must agree about footprint clearance. Merely increasing separation distance
between units will not fix terrain routing.

## 4. Attack-move does not acquire enemies along its route

**Observed:** a hero attack-moves past a reachable enemy about 288 units away
initially, within his 500 acquisition range, but outside weapon range. Over four
seconds he attacks zero times and never acquires the target. The identical
fixture under Patrol acquires it and attacks four times.

**Evidence:** controlled heroes acquire only from idle in `stepAI`. The neutral
AI also excludes attackMove. `stepMove` has pursuit logic for attack and patrol,
but none for attackMove. `stepAttack` can opportunistically hit enemies already
within weapon range, which can mask the missing acquisition/chase behavior.

**Reference:** [Blizzard's commands guide](https://classic.battle.net/war3/basics/unitcommands.shtml)
describes attack-move as engaging enemies encountered on the way and patrol as
attack-move between two points.

**Fix boundary:** preserve the destination while acquiring and pursuing eligible
enemies, then resume the route. Reuse target rules across idle, attack-move and
patrol so these orders do not disagree about valid enemies.

## 5. Flight classification and weapon target eligibility are missing

**Observed:** the stock Gargoyle type spawns with flyHeight=0. Even after the
probe sets its height to 240, a Footman can damage it with a normal weapon
attack. With damage dice disabled to make the probe deterministic, it deals
9.434 damage rather than zero.

**Evidence:** `data/blz_units.json` gives `ugar` movetp=fly and moveHeight=240,
and `hfoo` targs1=`ground,structure,debris,item,ward`. Those inherited fields are
not transferred into the runtime movement/targeting model. `createUnit` always
sets flyHeight=0, even for compiled types with an explicit flyHeight override.
Weapon range and horizontal distance are checked, but allowed air/ground targets
are not. `IsUnitType(FLYING)` incorrectly depends only on visual flight height.

**Reference:** Blizzard lists [Footman Air Attack: None](https://classic.battle.net/war3/human/units/footman.shtml).
The local unit data supplies the map-specific definitions used here.

**Fix boundary:** carry movement type and weapon target flags through extraction;
distinguish actual flying units from grounded units lifted by a spell. Flight
height alone is not a safe eligibility predicate. Preserve weapon 1/2 distinctions
when restoring units with different ground and air weapons.

## 6. Spell target filters are not enforced

**Observed:** Byakuya's A011 declares `air,organic,enemies,ground`, yet casting it
on an allied Footman succeeds and applies 30 damage. A hidden target also takes
30. An invulnerable target is accepted and puts the ability on cooldown, although
the damage resolver correctly prevents HP loss. A011 costs zero mana in this
map, so the probe does not claim a mana loss.

**Evidence:** `server/room.js:308` forwards the selected target to `castAbility`.
The latter checks alive state and whether a unit target is required, but does
not enforce the compiled target flags or hidden/invulnerable eligibility.
`data/abilities.json` supplies A011's enemy-only flags. This is the actual map
ability, not an inferred restriction from its appearance or translated name.

**Fix boundary:** validate target eligibility before initiating a cast and before
resource commitment where appropriate. Reuse it for cursor feedback and the
authoritative server. Keep deliberate JASS damage calls distinct: scripts may
intentionally damage allies without casting an enemy-only ability.

## Behaviors that passed

Patrol acquired the reachable enemy in the fixture and resumed its original
destination after that target died. Invulnerability prevented actual HP damage.
Those behaviors should be preserved, not reported as missing. This does not
certify patrol's entire targeting policy or invulnerability's casting rules.

## Priority

Body blocking and attack-move first, then target eligibility and flight metadata.
Turning and terrain clearance should follow with a small retail reference map
to establish timing and footprint rules, rather than inventing equivalents.
