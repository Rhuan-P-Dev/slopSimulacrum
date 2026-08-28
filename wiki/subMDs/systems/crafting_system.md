# Crafting System

## 1. Overview

The crafting system lets an entity combine items on one of its components into new items, following recipes defined in `data/crafting.json`. The initial recipe fuses two knives into one T1 container weapon (see [T1 Weapon System](t1_weapon_system.md)).

Crafting is a **pure UI-panel concept**: it has no world entity, no range or spatial validation, no room requirement, and — decisively — it does not consume a turn. It is a sibling of the inventory system, not a member of the action pipeline.

## 2. Why Crafting Is Not an Action

Crafting was deliberately kept **outside** `data/actions.json`. The action pipeline is machinery for traits, stats, range, and synergy: an action declares trait-based requirements, a targeting type, an optional range expression, and declarative world-effect consequences (spatial deltas, stat deltas, damage, logs, events). Crafting fits none of those slots:

- **Its precondition is item possession, not a stat.** A recipe's requirement is "this component holds N items of type X". The action requirement schema has no notion of item possession; extending it would inject inventory concerns into a generic stat-validation system — exactly the coupling the action system is kept free of.
- **Its effect is item mutation, not a world consequence.** There is no consume/produce-item consequence type, because item mutation is owned by the inventory system. The established home for item operations is the inventory route/manager pair with facade wrappers and a broadcast, and crafting follows that precedent rather than creating a parallel consequence path.
- **Its component binding is dynamic, not resolvable.** The action pipeline resolves its source component through requirement/synergy priority chains; the crafting "component" is simply whichever component holds the items the player dragged — determined per request, with nothing to resolve against.
- **It would entangle the turn system.** Only registry actions can be queued for a round. Making crafting a registry action would have dragged it into the round machinery, contradicting its nature as an immediate UI operation.

The chosen shape is therefore the one the existing inventory operations already use: a dedicated state controller (the recipe registry), a dedicated route module, and a facade operation that orchestrates — with all item mutation delegated to the inventory system. See [Action System](../architecture/action_system.md) for the machinery being deliberately avoided.

## 3. Why the Crafting Controller Is Decoupled

The crafting controller is a **state controller**: the composition root constructs it from `data/crafting.json` and injects it into the `WorldStateController` facade. It has **no cross-controller dependencies** and **never touches entity or item state** — it owns the recipe registry and answers pure "do these items satisfy this recipe?" questions.

This decoupling exists because:

- **Item state has exactly one owner.** Every read and write of items goes through the inventory system, so crafting can never desynchronize or bypass it. The facade is the only place where recipe knowledge and item state meet.
- **The registry is excluded from the broadcast on purpose.** Recipes are static and immutable at runtime, so shipping them in every world-state update would bloat all clients for zero benefit (the same exclusion rule the per-room chat ring follows). Clients fetch the registry once through a dedicated endpoint instead.
- **Fail-fast data validation.** The controller receives the item registry at construction, so every recipe input/output type is cross-validated against it at boot: a broken data reference fails the server at startup, not a player mid-game.

## 4. Why Crafting Does Not Consume a Turn

The round/turn system exists to order **competitive, world-affecting** actions — movement and attacks — in deterministic initiative order. Crafting is a non-spatial, non-competitive manipulation of an entity's own inventory with no world effect; there is nothing for initiative to order.

- Crafting sits outside the action registry, so it cannot be queued for a round at all — it executes immediately, in any round phase, invisible to the turn HUD and to NPC planning.
- This places it in the same category as the existing immediate inventory operations (move, equip, unequip), which have always executed outside the round system.
- If a future design wants crafting to cost a round, the correct path is to register a real registry action at that point — not to special-case the turn system.

## 5. Why Crafting Is a UI-Panel Concept

Crafting has no spatial presence in the world: it is not a world object, so there is no range to validate, no room it belongs to, and nothing to render on the map.

- The only "spatial" fact crafting cares about is *which component holds the items* — a fact the inventory system already models, since every item is hosted on a component. Modeling crafting as a world entity would have invented a spatial concept the feature does not have, pulling in range validation, room visibility, and pick-up-style interaction for no gameplay gain.
- The UI placement mirrors the server placement: the crafting panel is a config-bar tab next to the inventory tab, the inventory's sibling in the UI exactly as it is the inventory's sibling on the server.

## 6. Why Recipes Are Data-Driven

Recipes live in `data/crafting.json` — a plain registry keyed by recipe ID, the same convention as the action and item-type registries.

- **New content is a data edit.** Adding a recipe means editing JSON only; the code is a generic interpreter of recipe definitions, so the feature grows without code changes.
- **Item types stay canonical.** A recipe references item types by their registry IDs and never duplicates item definitions — the item registry remains the single source of truth for names, volumes, and traits, and the client resolves display names from the inventory registry.
- **Static and read-only at runtime.** Recipes are validated once at boot and then immutable; the controller hands out defensive copies so no consumer can mutate the registry.

## 7. Why a Failed Craft Can Never Lose Items

Component capacity is a hard constraint on stored items (see [Inventory System](../data/inventory_system.md)). If the server consumed the inputs first and only then discovered the outputs would not fit, the player's inputs would be destroyed — an item-loss, data-corruption-class bug.

The design therefore settles the capacity question **before** anything is consumed: the server confirms that the component's free capacity plus the space the consumed inputs will free can hold the outputs, and only then performs the mutation. Because the server carries this out in a single pass, the consume→add sequence cannot fail on capacity once it has started — a failed craft leaves the inventory exactly as it was, and a successful one leaves it in the only state the pre-check allowed. Input items are consumed as atomic units: an item that currently contains nested items is rejected (`INVALID_ITEM`) rather than having its contents destroyed.

## 8. Why Outputs Return to the Same Component

Crafting is per-component: the component that supplied the inputs receives the outputs.

- **Player intent is preserved.** The player chose to craft with one component's inventory; the result belonging back to that component is the unambiguous completion of that choice — no placement decision, no cross-component move.
- **No extra placement concept.** Keeping inputs and outputs on the same component keeps the whole operation inside the inventory system's per-component model, which already defines what "fits" means.

## 9. The Client-Side Model

### 9.1 Why the Panel Auto-Executes on Satisfaction

The player's intent is expressed by dropping item cards onto a recipe card. The moment every required input is present, crafting is the only sensible completion of that intent — an extra "execute" click would add friction with no decision attached. Satisfaction is unambiguous (the card shows exactly what is still missing), so the craft fires the moment the last required item lands.

### 9.2 Why the Pending Pool Is Client-Local

Dropped items are staged in a client-local **pending pool** before any server request is made. The pool exists because:

- **A drop is a proposal, not a commitment.** A dropped item is only *proposed* as an input; on the server it stays untouched in the inventory until the recipe is complete.
- **It must survive rejection.** If the server refuses a craft (full component, stale reference, concurrent change), the pool is preserved so the player can retry or adjust — a failed craft costs nothing, mirroring the server's item-loss guarantee.
- **An item can only be proposed once.** An item instance can physically be consumed by a single craft, so the pool tracks each item exactly once across all recipe cards.
- **It is reconciled against reality.** On every world-state broadcast, pool entries whose items no longer exist (consumed or moved by another client or an NPC) are pruned, so the pool never references phantom instances.

### 9.3 Why the Broadcast — Not the Response — Is Authoritative

Like every other mutation in the project, the panel treats the craft response only as an immediate confirmation flash; the authoritative inventory update arrives through the world-state broadcast (see [Client Action Execution](../frontend/client_action_execution.md)). This keeps a single synchronization path for all inventory changes, and the panel can never drift from the server, even if a response is lost or stale.

## 10. Related Documentation

- [Inventory System](../data/inventory_system.md) — crafting is a consumer of the inventory system: all item consumption/production flows through it, never around it
- [Action System](../architecture/action_system.md) — the pipeline crafting deliberately sits beside, not inside
- [T1 Weapon System](t1_weapon_system.md) — the output of the initial recipe (two knives fused into one T1)
- [Unique ID System](unique_id_system.md) — typed IDs (ent-/comp-/item-) used by crafting requests for unambiguous resolution
- [Client Architecture](../frontend/client_architecture.md) — the crafting panel as a config-bar overlay (see also [Overlay Manager](../frontend/overlay_manager.md))
