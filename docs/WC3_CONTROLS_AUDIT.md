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

## Remaining work, in priority order

1. **Order queues and smart orders:** Shift-queued orders, follow on allied right-click, explicit friendly attack behavior, and queued spell/item actions. Shift+ability currently uses the old learning behavior.
2. **Subgroups and hotkeys:** Tab/Shift+Tab subgroup cycling (Tab currently shows the scoreboard), non-hero spell cards, inventory numpad hotkeys, and complete hero/group selection conventions.
3. **Camera and minimap:** minimap orders and camera navigation, alert history/Space behavior, and removal of the default hero-follow camera behavior in favor of WCIII camera controls.
4. **Targeting feedback:** keep invalid casts aimed until canceled or successfully issued, show errors at the cursor/console, and improve target-validity previews.
5. **Group presentation:** unit portraits/health in the group panel, WCIII subgroup highlighting, formation placement, and exact selection prioritization where units/buildings share a drag box. Current group buttons use names.

## Verification

`tools/selection_test.mjs` checks the selection limit, group lifecycle, malformed/unauthorized network orders, and orders while the hero is dead. `tools/selection_ui_test.mjs` exercises the real client mouse/keyboard handlers and console using a live match with deterministic selection fixtures. Existing viewport, HUD, morph and movement-order tests cover adjacent behavior.
