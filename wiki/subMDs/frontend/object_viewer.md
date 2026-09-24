# Object Viewer (Object Inspection)

## 1. Overview

The Object Viewer is a floating panel that answers, for any single object in the
world, the question a player actually asks: **what is inside this object, what
are its stats, and what does it do every turn?** Open it by clicking a static
object (a prop) on the world map. The panel shows:

- **The object header** — name, room, position, static/actor status (the
  payload also carries the blueprint for programmatic consumers).
- **The components** — each component's type, live stat tree (existence,
  volume, and the full `Group.stat` values the material derivation produced),
  materials, and its internal components (organs) with their generated
  descriptions.
- **The stored items** — the concrete items currently in the object's
  component inventories (name, type, volume, description, host component);
  on multi-component objects the rows are clickable and move the item to
  a player-chosen component of the same object (§7).
- **The inventory summary** — used / capacity volume with a percentage bar:
  the same capacity the combat and crafting pipelines use.
- **The production lines** — for every `generateItem` organ the object hosts:
  what it produces, how much, how often ("1 knife every 1 turn"), how much is
  stored against the host's capacity, and whether it is currently active or
  halted (and why).

The knife generator is the canonical consumer: it stores knives in its
10-volume `generatorCore` and sheds them onto the floor when full, so its
panel reads exactly "Produces 1 Knife every 1 turn — N/10 stored".

## 2. Why on-demand per-object, not part of the broadcast

The world-state broadcast already carries everything this panel needs — the
entity graph, the component instances with their stats, the per-component item
lists, the dropped items. What it does not carry is a *derived, read-oriented
summary scoped to one object*, because no client needs it until a player asks
for it. Shipping per-object inspection payloads in every full-state update
would bloat every broadcast for a view that is only ever opened on click —
the same reason the knowledge codex and the crafting registry stay out of the
broadcast and are pulled on demand.

The cost model is also the right one for the read: one small HTTP GET per
panel open, answered by deriving a compact payload from state the server
already holds in memory. There is nothing to keep in sync (no client-side
cache of the payload), so nothing can desync — the next open is always
current, which is exactly the property an inspection tool needs.

## 3. Why the facade owns the derivation

The route (`GET /world-objects/:entityId`) injects only the world-state
facade — the facade-only-dependency rule the [knowledge route](knowledge_viewer.md)
and the [world routes](../systems/world_map.md) follow. The facade method
`getObjectInspectData(entityId)` composes the read from the sub-controllers it
already coordinates:

- `stateEntityController` — the entity's live shape (spatial, room, name,
  blueprint, `isStatic`, component list);
- `componentController` — each component's live stats, materials, capacity,
  existence, and brokenness;
- `internalComponentController` — the entity's organ instances and the
  organ-type registry (source of the organ descriptions and every
  `generateItem` production line);
- `inventoryManager` — the stored items per component and the used/capacity
  summary (the same instance the crafting and combat paths use, so the panel
  can never disagree with what those paths see);
- the item definitions — name/description/volume for each stored item.

An unknown id returns `null`, and the route maps that to `404 { error,
details }`; any other failure maps to `500 { error, details }`. The response
envelope is `{ object: <payload> }` so the client binds to one key.

## 4. Why the production lines come from the organ definitions

"Knives per turn" is not a stored number — it is the *definition* of the
`generateItem` overTime effect on the organ (`itemsPerInterval`,
`intervalTurns`) and the *runtime state* of the organ and its host (broken?
capacity?). The payload derives each production line from those same
definition fields the per-turn `processTurnEffects` overTime channel fires
from, so the number on the panel is the number the world actually runs —
there is no second rate source of truth.

Two invariants keep the line honest:

- **The active gate mirrors the effect's gate.** A production line is
  `active` only when neither the organ instance is flagged broken nor the
  host component is destroyed (existence ≤ 0) — the exact conjunction
  `processTurnEffects` checks before firing an overTime effect. A broken
  generator displays "Production halted" with the reason (organ vs host),
  never a rate it is not actually running.
- **The stored count is live.** `stored` is how many of the produced item
  type the entity currently holds (for the shipped generator — one host
  component, volume-1 knives — the count equals the stored volume); the
  line pairs it with the host's capacity, so the player sees the fill rate
  ("3/10") and, once full, that extras drop on the floor.

## 5. Why the organ description gained a `generateItem` clause

The organ descriptions shown in the panel are the *generated* descriptions
(`InternalComponentUtils.generateDescription`), which the world-state
broadcast already enriches onto every internal-component instance. Until now
the generator rendered no clause for `generateItem` — the knife generator's
description said nothing about knives. The generator now renders
"Every N turn(s), produces M item." using the effect's own fields (missing
`itemsPerInterval` defaults to 1, matching the handler's default), so the
panel, the broadcast, and any future consumer all read the same sentence
from one shared function.

## 6. The client: one generic panel, map-triggered, self-contained

The client mirrors the codex's architecture: a single overlay panel
(`ObjectViewer.js` + `object-viewer.css`) registered with the overlay manager,
opened by a world-map click on a prop (the map already filters static objects
from the NPC/actor layers). Clicking an NPC still opens the character
inspector — the two panels serve different entity kinds and never collide.

The panel fetches on every open (no cache — the payload is per-open and
small), and every failure class degrades inside the panel: a 404 or 500
renders a static error card (the server message goes to `ClientLogger`, not
the UI; reopening the panel is the retry — every open fetches fresh); a
malformed
payload (missing or non-object sections) degrades field-by-field to empty
defaults through `normalizeObjectPayload`, and a non-object payload at all
renders the fetch-failure card. The rendering helpers are pure functions of
the payload, which keeps the panel testable in the node environment exactly
like the other client controllers.

## 7. Moving a stored item (click an item, choose the receiving component)

The panel is read-first, but it performs exactly one convenience mutation:
every stored-item row on an object with at least one component is clickable.
The click opens a move picker inside the inventory section: one
row per component of the object, each showing its used/capacity volume. The
item's current host is listed but inert, and a bounded component without
enough free volume is listed but disabled — both as **advisory previews**
computed client-side from the payload (per-host item volumes and each
component's capacity are already in the payload, so no extra request is
needed). The server stays authoritative: the picker POSTs the *existing*
inventory move endpoint

    POST /inventory/:entityId/move/:itemId   body: { targetComponentId }

—the same route and facade path (`moveItemInEntity` →
`InventoryManager.moveItem`) the inventory UI uses, so the capacity check
runs once, on the server, with exactly the semantics the inventory system
documents. (The facade additionally rejects a target that is not one of
the entity's own components — the picker can never offer one, but a
hand-crafted request must not be able to strand an item under a host no
component view can reach.) A rejection (no entity/item, no space) returns 400 with its
message, which the picker shows inline and stays open on. A success closes
the picker; the broadcast the facade fires on the move is already the
panel's live-refresh trigger, so the item appears on its new host in the
next render.

No turn is consumed: like the crafting panel, the move is a UI convenience
on state the player already holds, not a world action (crafting design spec
§2.3; the inventory system's server-authoritative pattern). On a
single-component object the picker shows its one row (the current host,
inert) — the picker answers the same question for every item: "where could
this go?" — and on a single-component object the answer is "here, nowhere
else".

Both mutation routes also accept an optional `actorEntityId` — the entity
performing the mutation. When present, the facade range-gates the request:
the actor must be within `OBJECT_INTERACT_RANGE` (src/utils/Constants.js,
anchored to the pick-up reach in data/actions.json) of the object being
manipulated, measured as the Euclidean distance between the actor's
`spatial` and the object's `spatial`. An out-of-reach request is rejected
with a message the picker shows inline. The gate is lenient about missing
data — no actor (legacy callers of these routes) or missing spatial
coordinates passes through — but a known-but-far actor and an unknown actor
id are rejected, so a hand-crafted request cannot dodge the gate by omitting
who is acting. The client-side mirror is advisory: the inspect payload
carries the object's `spatial`, and App.js registers the player's active
droid with the viewer on open and on every world update, so when the
distance exceeds the same constant the inventory section renders read-only
under an "out of reach" banner instead of interactive rows (the same rule
is re-validated authoritatively on the POST). The take route in section 8 is
gated identically — the actor must be within reach of the object being
taken from (the source), not the destination. The same rule is also visible
on the map itself: hovering a prop marker on the spatial map draws the
droid's interaction-range circle (radius `OBJECT_INTERACT_RANGE`, the
lightweight dashed preview style of dropped-item hover) in green when the
object is within reach and red when it is not, and clears it when the mouse
leaves (App.js `_handleObjectHover` / `_handleObjectLeave`, wired through
`UIManager._renderWorldObjects`' hover callbacks) — so reach reads exactly
like item pickup reach before a click ever happens.

The picker state survives re-renders because the content root carries one
delegated click listener (the content HTML is rewritten on every refresh);
if a refresh makes the picked item vanish, the picker drops itself rather
than rendering for a ghost.

## 8. Taking a stored item to another entity (the take picker)

Section 7's move picker answers "where could this go *inside this object*?"
The take picker answers the complementary question: "which *other entity*
could hold it?" A stored-item row opens both pickers stacked in the inventory
section — the move picker (the object's own components) and, below it, the
take picker (one row per component of every other entity that can receive
items).

The take picker's rows come from a payload field, `takeOptions`, computed by
the facade in `getObjectInspectData`: one entry per **non-static** entity in
the world (the player's droid, NPCs) with at least one component, each
carrying its live used/capacity volumes. Static objects are excluded — the
player has no reason to deposit items into scenery — as is the inspected
entity itself. As with the move preview, the client treats this as advisory
only: a destination that cannot hold the item is listed but disabled (the
same client-side fit rule as the move picker), and the server re-validates
everything on the take POST.

The take posts to a dedicated cross-entity route:

    POST /inventory/:entityId/take/:itemId   body: { targetEntityId, targetComponentId }

→ `WorldStateController.takeItemFromEntity` → `InventoryManager.transferItem`.
That manager primitive is the single implementation of "an item changes
holder" the world shares: it verifies the item is actually on the source
entity, that the target component belongs to the target entity (a
hand-crafted request cannot strand an item under a host no component view
can reach), and that the target has room (the same capacity semantics as
section 7's move); it then moves the item's entire subtree — the item and
everything it hosts travel together, with internal host pointers riding
along on the container — removes the subtree from the source, re-hosts it
on the target, and lets the facade's broadcast re-render the panel (the item
appears on its new holder in the next refresh, and the source's inventory
section updates too). A rejection (no source entity or item, target component
not part of the target entity, no room) returns 400 with the manager's
message, and — like the move picker — the picker stays open on the result
line.

One deliberate asymmetry with section 7: `moveItem` never checks whether its
target entity is static, because an in-object move only ever runs between
the object's own components. The take path's static exclusion is enforced
upstream, where the world's topology is known — the `takeOptions` filter in
the payload. The manager stays dumb about scenery: it validates membership
and capacity, nothing more.

No turn is consumed, for exactly the same reason as section 7's move: taking
a stored item is a UI convenience over state the world already holds, not a
world action.

## 9. Related Documentation

- [World Objects (Static Props)](../systems/world_objects.md) — what the panel inspects: the static-entity contract, and the knife generator the production lines describe
- [Internal Components](../data/internal_components.md) — the organ registry and its `generateItem` overTime effect, the source of every production line
- [Inventory System](../data/inventory_system.md) — the volume capacity the inventory summary and production lines render, and the move/take endpoints sections 7–8's item rows reuse
- [Knowledge Viewer](knowledge_viewer.md) — the static-data codex; this panel is its instance-state counterpart (per-object, on-demand)
- [Overlay Manager](overlay_manager.md) — floating-window coordination the panel joins
- [CSS Architecture](css_architecture.md) — the one-file-per-panel rule the viewer stylesheet follows
- [Controller Relationship Map](../../map.md) — the facade the route depends on (and only depends on)
