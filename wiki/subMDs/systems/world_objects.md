# World Objects (Static Props)

## 1. What They Are

World objects are **static props** that live in a room — the shipped example is
a wooden tree standing at the top-center of the Entrance Hall. A world object
declares a **blueprint** (the component composition it is built from), the
**room** it sits in, and a **room-relative position** (room center is `{0,0}`;
negative `y` is toward the top edge).

At boot each declared object is materialized as a **static entity** — a real
entity built from its blueprint, tagged `isStatic: true`. The tree's matter is
therefore real, validated data (its component is `100% wood`), not a render-only
color — and, because it is a real entity, it can be **targeted, damaged, broken,
and harvested** through the ordinary combat pipeline.

## 2. Why They Are Entities (the pivot)

This is the load-bearing decision, and it reversed the original design. A
"simple object" that is *only* rendered is easiest to keep in a separate,
non-entity store. But a prop that **can be hit** cannot live in a side store:
the combat pipeline resolves its target against the **entity map** (range
validation, the damage consequence, the broken-component cascade, material
drops). Making the prop a real entity means all of that works for free — a punch
finds the tree by spatial proximity and drains its component's existence, and as
that existence is drained the prop sheds material chunks; when the last component
reaches zero it breaks and the entity despawns.

The cost of being an entity is that entities are, by default, **actors**. That
is the problem the `isStatic` flag solves (§3).

## 3. The `isStatic` Flag and the Roster Exclusion

In this engine an entity is also an actor: the turn system derives its
initiative order and planning roster from *every* entity, and the two-phase
planning barrier only closes when every roster member has either signaled or
left the world (see `turn_system.md`).

A decorative prop never plans and never signals. If it entered the roster the
all-ready barrier could never reach "all ready" and the whole world would stall
in the planning phase. So `_computeActorOrder()` (`TurnSystemController`)
**excludes `isStatic` entities** from the actor order:

```
.filter(entity => entity && entity.id && entity.isStatic !== true)
```

Because the barrier roster is a snapshot of the actor order, an excluded prop is
never a planner, never in the barrier's pending set, and never awaited — the
world does not freeze. The same `isStatic` mark is what lets the client tell a
prop apart from a droid and draw it on its own layer.

This is the whole safety model in one flag: **a static entity is a real entity
(targetable, damageable, harvestable) but never a planner (so it can never
stall the turn system).**

## 4. Why Matter Comes From a Blueprint

A prop is built from a **blueprint** (`data/blueprints.json`), not from a raw
component or its own material list. The blueprint maps to one or more
components, and each component's composition is already validated at boot
(material fractions must sum to `1.0`) — the same Single Source of Truth rule
that governs every other piece of matter in the world. The tree's blueprint is
`"tree": ["tree"]`, and the `tree` component is `materials: [{ material: "wood",
fraction: 1.0 }]`, so "100% wood" is *enforced*, not asserted. Any future prop
reuses a blueprint instead of re-declaring matter.

## 5. Hittable, Breakable, Harvestable

Because a prop is a real entity, the standard combat consequences apply with no
special-casing:

- **Damage** — a `punch` (or any `damageComponent` action) targets the prop's
  component and drains its `Physical.existence` (the 0–1 matter store). The loss
  is **channel-aware**: the tree is wood, which has high impact resistance but
  low cut resistance, so a punch is less effective against it than a cut.
- **Break** — when the component's existence reaches `0`, the normal
  broken-component cascade fires: the component is removed and, if the entity is
  left with no components, the entity **despawns** (it is removed from the
  world; there is no respawn for a broken prop).
- **Drop** — the same per-hit `dropMaterialChunk` consequence that makes a droid
  component shed a piece (see `world_rules.md`) applies to a prop: on each
  **non-lethal** hit the prop sheds **material chunks** from its matter — wood
  yields `chunk_wood`, which lands on the ground as a dropped item. The final
  **killing** hit sheds nothing: the broken component's remaining matter is owned
  by the break cascade (the same double-counting guard droid components have),
  so the whole harvest comes from the non-lethal hits that got there.

This closes the loop that makes the tree more than decoration: **hit the tree →
wood chunks drop (on the non-lethal hits) → pick them up → craft with them.**
The prop's entire "100% wood" identity is what determines what it drops.

## 6. The Loadout Opt-Out

The spawn observer applies the declarative `data/world.json` `initialSpawns`
loadout to every non-NPC entity (the player's starting inventory). A prop must
never receive that loadout — a decorative tree is not a droid. `_applyInitialSpawns`
therefore opts out **both** `isNPC` and `isStatic` entities:

```
if (entity?.isNPC === true || entity?.isStatic === true) return { applied: 0, failed: 0 };
```

A static prop carries no `items` at all.

## 7. Persistence

Because a prop is a real entity, it is **serialized and restored like any other
entity** (the player droid, the NPCs) — its room, spatial position, and current
damage state all round-trip. There is no separate object store and no re-sync on
restore (that concern belonged to the old separate-store model). A prop that was
broken before a snapshot is simply absent from it — it despawned, and the
snapshot faithfully records that.

## 8. Declaration and Spawn

- `data/worldObjects.json` — the registry. Shape:
  `{ [key]: { name, blueprint, room, position?: { x, y } } }`. The key is a
  stable, cosmetic registry handle; the runtime identity is the spawned entity's
  id.
- `_spawnStaticProps()` (`WorldStateController`, run from `initializeWorld()`
  before the NPCs) loads the registry and, per entry, validates the blueprint
  is known and the room resolves, then `spawnEntity(blueprint, roomUid,
  { isStatic: true, name })` and sets the room-relative position. Malformed
  entries warn-skip (the same tolerance as the NPC spawner); a missing/empty
  file degrades to "no props".

## 9. Client Rendering

Static props are drawn on a dedicated **objects-layer** (behind the droids),
rendered by `UIManager._renderWorldObjects()`:

- `updateWorldView()` filters the room's `isStatic` entities and draws them as a
  simple trunk + canopy; `_renderEntities()` **skips** `isStatic` entities so a
  prop is never drawn as a droid marker.
- The canopy's size and color track the prop's component `Physical.existence`
  (read from `state.components.instances`): it shrinks and browns as the prop is
  hit, giving visible HP feedback without a separate panel.
- `updateWorldView()` runs on **every** world-state-update broadcast, so the
  objects-layer is re-drawn after each action — prop HP and break-then-despawn
  stay in sync with the server without any extra channel.
