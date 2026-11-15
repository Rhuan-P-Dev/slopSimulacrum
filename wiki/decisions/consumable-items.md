# Decision: consumable items — food is a block on the item, and one generic `eat` action

Date: 2026-11-14 (recorded in the commit that implements this)

## Context

The ask: a **consumable items** feature, two new items (an apple, a golden apple), and
every client entity spawns carrying 2 apples and 1 golden apple.

What already existed, and what it decided for us:

- **Coal is fuel, not food.** `consumeFuelGenerateStat`
  (`src/controllers/core/InternalComponentController.js`) burns a carried `coal` item on
  the internal-component cadence and charges `Physical.energy` — the ceiling is the
  entity attribute's own `max`, never a number on the item. This is the one existing way
  a body is refueled, so a meal has to charge through the same law or the world grows a
  second, competing way to fill the same pool.
- **Whole-entity attributes** (`data/mods/core-entity-attributes/entityAttributes.json`,
  read by `src/utils/EntityAttributeData.js`) are keyed `"Group.stat"` and owned by the
  entity, not by a component. `EntityEnergyController.processEnergyTurn` drains every
  declared meter each round and, at 0, eliminates the entity (spill + despawn).
- **The `Physical.energy` meter belonged to one blueprint only: `m1Droid`** — the coal
  burner. `DEFAULT_PLAYER_BLUEPRINT` (`shared/Defaults.js`) is `maleDroid`, which declared
  `Pleasure.pleasure` and no energy at all. An apple that charges `Physical.energy` would
  have spawned into every client's inventory and refused, forever, to do anything.
- **Actions are data** (`data/mods/core-actions/actions.json`): `targetingType`,
  `requirements`, `consequences[]`, `failureConsequences[]`, and a `prose.verbPhrase` for
  the round's narration. Consequence types are registered in
  `src/controllers/consequences/consequenceHandlers.js`.

## Decision

### 1. The mechanic is a `consume` block on the item definition

```json
"apple": { "consume": { "targetStat": "Physical.energy", "energyGain": 15 } }
```

Not a new registry kind. The item is the thing the actor chose, the action is generic, and
the number is a balance lever a mod can move with no code and no new package — a kind
would buy nothing because there is no second registry to join (`CR NAME-3`). One item
declaration, one reader: **`src/services/ConsumableRules.js`** exposes `parseConsumeBlock`
(THROWS on a malformed block, for the edge) and `resolveConsumable` (returns `null` for
absent **or** malformed, for the hot path) over one implementation. `targetStat` is
validated against the closed vocabulary (`shared/StatVocabulary.js`) and against a closed
set of chargeable meters — `Physical.energy` and `Pleasure.pleasure`, the two meters a
body runs down and refills. A component stat, an existence repair, a skill: a different
mechanic, refused at the rule rather than invented later.

### 2. `eat` is one action; `eatItem` is its consequence

`data/mods/core-actions/actions.json` gains `eat` (`self_target`, no requirements, params
`:itemId` / `:itemType`), handled by `src/controllers/consequences/EatConsequenceHandler.js`
and registered under the type `eatItem`. It accepts an instance id (the id the inventory
listing shows) or a type ("any one of these"), and searches the inventory through the
facade's `getEntityItems` — the same surface the coal burner searches, so food inside a
container is reachable exactly as fuel is.

**The order is the rule, in this sequence and no other:**

1. resolve the item, ask the definition whether it is food — refuse if not;
2. read the meter's declaration — refuse if the body has no such meter;
3. **a full meter refuses BEFORE the item is spent** — a golden apple eaten at full energy
   is a golden apple thrown away, so the world says "Already at full Physical.energy
   (100/100)" and keeps the item;
4. spend the item;
5. charge only on a spent item, clamped at the attribute's own `max` — never at a number
   carried by the food.

There is deliberately no rollback of a removal: re-adding food would re-derive its
footprint from *current* data, which is the wrong way to undo a step
(`wiki/decisions/mod-system.md`), so the charge happens only after a removal that succeeded.
Every refusal is an answer, not an exception (`CR ERR-3`): `{ success: false, message }`
naming the rule that said no. The charge writes with `broadcast = false` because
`POST /execute-action` broadcasts the settled world on success
(`src/routes/actionRoutes.js`) — a second emit per bite would be noise.

### 3. The humanoid droids were given an energy meter — and with it, hunger

The operator chose this over "give the apples some other host": `maleDroid` and
`femaleDroid` now declare `Physical.energy` `{ value: 100, max: 100, drainPerTurn: 1 }`,
the same shape the M1's battery has. **`drainPerTurn: 1` was the explicit answer to a
question, not an inference** — which means the human droids joined the energy-life loop:
they lose 1 per round and are eliminated at 0. The client avatar can now starve. Its
spawn loadout (below) buys roughly 90 extra rounds at the chosen balance; food is
load-bearing, on purpose. Coal stays the M1's business: no burner was added to any body,
so eating is the only refill a humanoid has.

### 4. Balance, stated once where it can be compared

Coal is the reference the world already had (1 coal = 10 energy, drained 1 per turn,
capped at 100). Against it: **apple 15, golden apple 60** (operator's choice). The ceiling
is never in the item — `setEntityAttributeDelta` enforces the attribute's `max` on every
write, so a golden apple at 90 charges 10 and says so. Both apples are `fruitFlesh`
(new in `core-materials`), volume 1, and the golden one carries a `visual` block (gold
HSL) rather than a new material, because gold here is a look, not a substance.

### 5. What a meal *is* to the client is a reading, written down

`executeAction` answers `success: true` once the action was **valid**; what the world did
with it rides in `results`, one entry per consequence. A refused meal is therefore a 200
with `success: true` on top and a **failed `eatItem` entry underneath**. Any caller that
reads the top-level flag toasts "you ate" over an item that was never spent — the loudest
lie this feature could ship with, and invisible to the gate unless the reading exists
somewhere testable. So it does: **`shared/ConsumableOutcome.js`** (`readEatOutcome`,
`EAT_CONSEQUENCE_TYPE`), pure, used by `ActionExecutor.eatItem`, pinned against a hand-
written response in `test/unit/ConsumableOutcome.test.js` **and** against a real action
result in `test/contract/consumables.contract.test.js`. The reading has **three** answers,
not two — see §9.

### 6. The client asks the data, never its own list

`InventoryManager` renders an **Eat** button (`.equip-btn.eat`, green) for an item only
when the fetched item registry says that item has a `consume` block; `App.js` wires
`setEatHandler` to `ActionExecutor.eatItem` on the same delegate pattern as place/retrieve.
A refusal or a schedule repaints nothing optimistically and toasts in the neutral voice (a
queued or refused eat changed no state); a meal repaints from server truth. The client never
names an item type — the toast resolves the item's **display name** from the same registry
the button came from, so it reads "eat Apple", never "eat item-3f9a2c".

### 7. The bad definition is quarantined, not shipped as a dead button

`CompositionClassifier` step 2d runs every `inventoryItems` definition that carries
`consume` through `parseConsumeBlock` and quarantines the definition on a malformed block
— the same treatment a bad `visual` block gets in 2b. The classifier and the consequence
read the block through the SAME module, so a plan, a mod and a running world cannot
disagree about what counts as food.

### 8. The LLM is told how to name its dinner

The agent tool schema's `itemType` description now says it is used by `eat` as well as
`placeMachine`, and that the Inventory line shows types and counts (so an agent can say
`{"itemType":"apple"}` without ever having seen an instance id). The action's own
`description` in the registry carries the mechanics and the refusal rule, which is the
text the agent reads.

### 9. A queued eat is a third answer, and it is not an error

Reported from play: pressing **Eat** produced a message that "looks like an error but is
not". It was the reading, not the world. The client runs in **Turn** mode by default, and
`ActionManager` adds `queueForRound: true` in that mode, so the route's queue gate answers
an **ack** — `{ success: true, queued: true, queueId, queue }`
(`src/routes/actionRoutes.js`) — and **no consequence has run**: the bite happens at the
round's resolution, when `TurnSystemController` replays the entry through the same pipeline.
That ack carries no `results` at all, so the two-state reading fell into its "no consequence
ran" branch and toasted *"The world ran the eat action without eating anything"* over a
request the world had just accepted.

Decided: the reader returns **`{ success, queued, message, refused }`**, and the ack is read
before anything else, because it is the one answer that carries no consequences *by design*
(not because a mod rewired the action). Its `message` is `null` — the ack says nothing about
a meal, and the schedule line is composed where the item's display name lives:
**"Your action to eat Apple will run when the round resolves."** The panel now has three
voices, and red is reserved for the one case that is actually a failure (the request never
reached the world):

| The world said | Toast | Style |
| --- | --- | --- |
| the round took the plan | "Your action to eat X will run when the round resolves." | `info` (neutral) |
| the meal happened | the handler's own sentence | `success` |
| no (full meter, not food, not carried, planning window closed) | the handler's / queue's own sentence | `info` (neutral) |
| nothing usable (transport, no active droid) | "Eating X did not happen." | `error` (red) |

The wording is *will run when the round resolves*, not *scheduled for the next round*: the
queue is **per round** — `TurnSystemController.queueAction` fills the round currently in
`planning` (which is why `QUEUE_FULL` is a real answer) and resolution happens at that same
round's close, so there is no "next" round involved. And the schedule line promises only that
the plan was **taken**: an entry that fails at resolution (actor gone, requirement no longer
met) is, in the turn system's own words, "discarded with a log line and the round continues"
— no player-facing notice. That is the queue's existing contract, not this change's; naming it
here because a toast about a schedule can, in that corner, never be followed by a meal.

Two things fell out of this. `.inventory-toast.info` **had no CSS rule at all** — the class
was applied and unstyled, a bare box, which is half of why the line read as broken; it is
styled now. And a **refusal was painted red** (`"Already at full Physical.energy"` on a 200
answer): a rule of the world explained to the player as a fault on their side. The world's
own wording is left alone — it is the world's voice, pinned in the handler tests — only its
colour changed.

## Consequences

- Every entity in the world (the loadout is `core-world/world.json` `initialSpawns`, not a
  client-only list) spawns with 2 apples and 1 golden apple. `Pleasure.pleasure` remains
  the only other meter a consumable may charge; nothing in the shipped data does.
- The humanoids are mortal by the energy rule (3 above). `test/contract/pleasureAttribute.contract.test.js`
  was written against "the humanoids declare no energy attribute" and now pins the two
  meters as independent, with only energy deciding life.
- A blueprint without the declared meter can still be handed food (the loadout is not
  per-blueprint): it gets "There is no Physical.energy to charge, so the Apple stays
  uneaten." and keeps the item. That is a designed refusal, not a bug — pinned in the
  contract test with a `smallBallDroid`.
- Nothing else consumes items today, so `eat` is the only spend path with this ordering.
  A future `drink` should be a new action over the same `consume` reader, not a second
  block on the item.

## Alternatives rejected

- **A `consumables` registry kind.** No second registry to join; the item is the choice
  and the number is a balance lever (`CR NAME-3`).
- **Charging component-level energy.** The M1's component energy belongs to organs and
  their own lifecycle; food refuels the body, which is the whole-entity pool.
- **Reusing the coal-burner cadence for food.** Eating is a decision with an actor and a
  reason, not a timer; and a silent cadence would eat the player's apples overnight.
- **Eating at full energy anyway (waste the item).** Chosen against: the world would
  destroy property for no effect, and the actor's action was legal.
- **A `hunger` stat / need system.** Not asked for, and the drain the meters already
  have is the mechanic the apples answer to.

## Verification

- `test/unit/ConsumableRules.test.js` — the block's shape, the closed target vocabulary,
  throw-vs-null on malformed data.
- `test/unit/EatConsequenceHandler.test.js` — spend/charge order, refusal-before-spend, the
  clamp at the attribute's `max`, `broadcast: false`, every refusal message.
- `test/unit/ConsumableOutcome.test.js` — the reading of an action result (the shape trap)
  and the round-queue ack: scheduled, not a meal, not a refusal; a queue that *refused* the
  enqueue stays a refusal.
- `test/unit/InventoryManager.client.test.js` — the Eat button follows the definition and
  the panel's behaviour on scheduled / meal / refusal / never-reached-the-world / unwired
  handler / thrown handler, and which of them is red.
- `test/contract/consumables.contract.test.js` — the real world: charge and spend through
  `actionController.executeAction`, coal is not food, no-meter and not-food refusals, the
  shape pin where server and client meet, and the **Turn-mode** path through the real
  `TurnSystemController`: the ack reads as scheduled, nothing is spent while the plan is
  only queued, and the resolution spends the apple it promised (40 +15 apple −1 round
  drain = 54 — a round that never resolved, or refused, would read 39).
- `test/contract/playerInitialSpawns.contract.test.js` — 2 apples + 1 golden apple in every
  client spawn, no entry skipped for lack of a slot, item count 18 → 21.
- `test/unit/CompositionClassifier.test.js` — a bad `consume` block quarantines the item.
- `npm run check` (lint + language guard + tests) green. The Turn-mode ack was first
  reproduced by hand (the shape, read through the shipped reader, before the fix) and is
  now pinned inside the suite against the real turn system, which is the stronger place
  for it.
- Not verified: a real browser click on the Eat button. The client half is unit-tested
  against stubbed handlers, and no live socket session was driven — driving one over HTTP
  is not enough, because a world created with `POST /world/create` and no card files in
  `data/cards/` contains only the static world objects: the entity that would carry the
  apples comes from a card spawn or a socket incarnation, and `socket.io-client` is not a
  dependency of this repo (nor is it being added for a test).
