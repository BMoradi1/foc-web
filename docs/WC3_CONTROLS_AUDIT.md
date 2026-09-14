# Warcraft III controls and UI parity

Reference: Blizzard's [Special Commands](https://classic.battle.net/war3/basics/specialcommands.shtml) and [Unit Commands](https://classic.battle.net/war3/basics/unitcommands.shtml).

## Implemented: selection and basic command ownership

- Left-click selects a unit; empty ground clears the selection. Enemy and allied units can be inspected but cannot be commanded.
- Drag a box to select owned living units, up to 12. Shift-click adds/removes a unit; Shift-drag adds units. Ctrl-click or double-click selects owned units of that type on screen.
- Ctrl+0–9 saves a group. A number recalls it; pressing that number twice quickly centers on its surviving owned members. Groups reset between matches.
- Move, stop, hold position, attack, attack-move and patrol use the selected owned units. Non-hero units get a basic command card. The server independently checks ownership, life, visibility and Locust status, deduplicates IDs and bounds the selection to 12. An empty/invalid selection never falls back to the hero.
- Accepted player orders remove creep guard behavior from the commanded unit. Selected owned units can receive commands even while the player's hero is dead.
- Selection circles and ordinary health bars follow the selected units; Alt still shows all bars. The group panel lists selected units and allows selecting/removing a member.
- F1 selects the hero; pressing it while that hero alone is selected centers the camera. A global double-click no longer enables hero following.
- Hero abilities and items remain associated with the hero card. This batch does not introduce non-hero ability cards or subgroup spell dispatch.

## Implemented: queued basic orders and follow

- Hold Shift while issuing a movement, attack, patrol, stop or hold order to queue it for each selected unit (up to 35 pending orders). The current action remains intact. Normal orders and death clear the queue, dead queued targets are skipped, and the selected unit's pending count appears in the console.
- Right-clicking a friendly or neutral mobile unit follows its current position. Followers wait nearby, resume when the leader moves, and do not acquire unrelated enemies. They join the leader's attack if already in weapon range. A dead or removed leader releases the follow order.
- Queued movement and follow route updates use the automatic pathfinding budget. Stop/new orders cancel stale scheduled routes. Movement queued during a cast starts after the cast finishes, ahead of resuming its previous attack.

## Implemented: subgroup cycling and inventory keys

- Tab and Shift+Tab cycle selected unit types without changing the group receiving basic orders. Hero types lead the cycle. The active type is highlighted and drives the portrait/card; clicking another type in the group panel activates it, then clicking an active type's member selects that unit alone.
- Numpad 7/8, 4/5 and 1/2 activate inventory slots 1–6 through the same handler as mouse clicks. Physical key codes keep this working with Num Lock off, repeated keydown events do not repeatedly spend items, and targeted items arm the cursor. Hero inventory keys are inactive when another subgroup is active.
- The scoreboard is accessible from F10 → Scoreboard and closes with Escape or its Close button. Tab is reserved for subgroups.

## Remaining work, in priority order

1. **Order queues and smart orders:** explicit friendly attack behavior, queued spell/item actions, and graphical waypoint previews. Shift+ability currently uses the old learning behavior.
2. **Subgroups and hotkeys:** non-hero spell cards, full spellcaster/level/inventory-based subgroup ordering and splitting, the configurable subgroup-order modifier, and remaining hero/group selection conventions.
3. **Camera and minimap:** minimap orders and camera navigation, alert history/Space behavior, and removal of the default hero-follow camera behavior in favor of WCIII camera controls.
4. **Targeting feedback:** keep invalid casts aimed until canceled or successfully issued, show errors at the cursor/console, and improve target-validity previews.
5. **Group presentation:** unit portraits/health in the group panel, formation placement, and exact selection prioritization where units/buildings share a drag box. Current group buttons use names.

## Verification

`tools/selection_test.mjs` checks the selection limit, group lifecycle, malformed/unauthorized network orders, and orders while the hero is dead. `tools/selection_ui_test.mjs` exercises the real client mouse/keyboard handlers and console using a live match with deterministic selection fixtures. Existing viewport, HUD, morph and movement-order tests cover adjacent behavior. `tools/order_queue_test.mjs` covers queue progression, capacity, death/Stop cancellation, follow and ownership; browser input checks cover Shift-clicks on the world and command card. The pathfinding load regression runs alongside these checks.
