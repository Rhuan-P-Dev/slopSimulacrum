# Decision: the effects system — named operations with a duration, over a live body

Date: 2026-11-14 (recorded in the commits that implement it)

## Context

The world already moved bodies in three places, and none of them could say "for as long
as":

- **Consequence types** (`ConsequenceDispatcher`) are what a verb does at the moment it
  resolves. They fire once and are gone. `burning` existed as a *condition* — a stored
  marker that the damage rules tick — not as a thing with a duration, a source, or a
  stack.
- **World rules** (`WorldRulesController`) are laws that hold at all times. They are not
  applied to a target and they never stop.
- **The `EffectTracker`** carried transient per-component conditions with an expiry. It
  owned one shape (a condition on a component) and no vocabulary: nothing could say what
  an effect is, how long it lasts, or what it does per round.

The owner asked for a system that can apply **any** operation to an entity or its
components, at runtime, and for a designed agent body to be able to be born carrying
effects. What had to be decided before any code: where definitions live, what an effect
is allowed to name, who owns the live instances, what a duration means on a world that
runs in rounds, and what an effect's end undoes.

## Decision

### 1. A registry kind `effects`, and a CLOSED set of operations

`effects` (`shared/RegistryKinds.js`), shipped as the official package
`data/mods/core-effects/`. An effect is a named bundle: `target`, `durationRounds`,
`stacking`, `revert`, `operations` (at application) and `perRound`.

**The operations are named by id from a closed set** — `shared/EffectVocabulary.js` — and
that is the load-bearing choice. A definition cannot express code, an expression, or a
condition tree; it names an operation and passes literal parameters. `OP PARAMETERS ARE
LITERAL`: never a `:Physical.strength` placeholder, because a placeholder resolves against
the *acting* entity of an action in flight, and an effect applied by the operator console
has no such thing.

Each id runs the executor that **already exists** under
`src/controllers/consequences/`. A mutation keeps exactly one implementation, and a mod
stays a data-only package. `statDelta` adapts `updateStat`, `damageComponent` adapts
`DamageHandler`, and so on.

**The body's parts are deliberately absent from the set** (`addComponent`,
`removeComponent` are reserved, not implemented). An entity's component records are
produced only by `EntityController.createEntityFromBlueprint`, which runs at spawn — there
is no public mount to call — and the only destruction path is a private delegator of the
damage pipeline, which owns existence bookkeeping, content spill and the capability
re-evaluation. An operation reaching past either would leave the capability cache and the
removal cascade disagreeing with the body. Growing or destroying a part is its own change,
one that must first make a public mount path.

### 2. Two owners, and they are not the same module

- **`EffectsController`** is the definition owner: it reads `effects` from the live
  `RegistryStore`, validates each entry once, and caches the validated set against the
  store's version — the `WorldRulesController` idiom. It never throws: a malformed entry
  disables THAT entry with a warning, and an unknown operation id is a data fault, not a
  crash vector.
- **`EffectEngine`** is the live instance owner: which effects are running, on what, with
  what remaining rounds and what contributions to revert. It replaced the `EffectTracker`,
  which survives as a thin adapter over it so the persisted condition shape and every
  existing caller keep working.

The line between a typo and a bug is preserved from the world-rules layer: a definition
naming an operation the server does not know is a **data fault** (disabled, warned, id
named); an operation that passed validation and then reaches the engine with no adapter is
a **code fault** and throws, because that one is ours and hiding it costs a debugging
session.

### 3. The shape law is one module, because two authors write it

`src/controllers/effects/EffectDefinitionRules.js` holds the shape of one definition as
pure functions. `EffectsController` runs it over the file at boot and at every mod swap;
the agent-body design's effects stage runs the same function over what the model authored.
A design validated by a *copy* of the law is a design that drifts from the law — the stage
would accept what boot then refuses, and the author would learn about it at the swap.
(`CR T-1`, `CR T-2`.)

### 4. The round is the clock, and no clock means forever

An instance carries `appliedRound` and `expiresRound`. `TurnSystemController` advances the
effects at the round boundary, and `expireEffects` skips an instance whose
`expiresRound === null`.

**An effect applied while no round has been published has no expiry round and lasts until
removed.** That is not a fallback; it is what makes an inborn effect expressible —
`durationRounds: 0`, applied at spawn, ended by the body ending rather than by a timer.

### 5. Revert is by contribution, and it is honest about what it does not undo

Every applied operation records what it changed. On expiry or removal, the engine writes
the inverse **through the same choke point** it used to apply. Ops that cannot be undone
soundly are **record-only on expiry**: undoing damage would be healing nobody asked for,
and un-dropping a chunk would move matter the room already has. Spatial moves revert only
when the captured origin still resolves — a per-instance decision, not a property of the
op. (`CR E-1` backwards in time: a revert says what it does not undo.)

### 6. Runtime: four ways in, one entry point

`EffectEngine.apply(effectId, target, { rounds, source })` is the single point, reached
through `facade.applyEffect` / `removeEffects` / `listActiveEffects`:

- the **live operator and the System LLM** — `apply_effect`, `remove_effect`,
  `list_effects`, `register_effect` in the frozen `OPERATIONS` map, run by `/system/execute`
  (an empty `remove_effect` selector is refused: a lever that big must be named on purpose);
- **any action, weapon or item in the data** — the `applyEffect` consequence type, so an
  inflicted burn and a console-applied burn are the same instance with the same expiry and
  the same revert (`src/controllers/consequences/ApplyEffectHandler.js`);
- an **inborn body effect** (below);
- the **model's own context** — `LlmContextController` reports, per part, the effects
  running on it with the rounds remaining, and whole-body effects separately. A model that
  cannot see its own effects cannot plan around them, and one round left is not worth the
  same plan as ten.

**`register_effect` is memory-only**, like `create_room` and `spawn_world_object`. Its
result names the durable path (`POST /mods/apply` after authoring an `effects` package)
rather than writing it. A runtime definition is superseded — dropped, not shadowing — the
moment a mod swap ships a packaged definition with the same id: an overlay entry nobody
maintains, shadowing content forever, is the bug that rule prevents.

### 7. A designed body is BORN with its effects, and this is the last stage

`STAGE_ORDER` is `concept, anatomy, organs, outfit, effects`. Effects come **last** because
an inborn effect is stated against the body that now exists — the parts it has, the stats
those parts actually carry, what it ends up wearing — and cannot be authored before it.

- **An inborn effect may use only the base operations** (`statSet`, `statDelta`,
  `addCondition`, `removeCondition`, `grantFlag`
  — `AgentBodyDesignRules.DESIGNABLE_EFFECT_OPERATIONS`, quoted to the model in the prompt
  so the prompt and the validator state one rule). The rest of the closed set stays what it
  was: what a verb or a world law does. A body born damaging things, moving itself or
  dropping matter acts on the world every round without ever choosing to, and those
  operations take their parameters from an action in flight, which an inborn effect has no
  idea about.
- **The stage is optional and says so.** Asked for "the effect of this character", a model
  will produce one for a character that needs none; the prompt names the empty answer as
  the ordinary one.
- **The save namespaces the id.** `saveDesign` writes the package's `effects` kind keyed
  `<packageSlug>_<authoredId>`, because the effect registry is global — two characters both
  authoring `slowFrame` would be one effect wearing two bodies.
- **The definition declares its body, not the blueprint.** The `blueprints` kind maps a key
  to its root components and has nowhere to carry such a claim, so the effect carries
  `appliesTo`. The save stamps it (the server knows the blueprint it is writing; the model
  does not get to claim a body), and `EffectsController.effectsDeclaredFor(blueprintKey)`
  is what reads it, from the validated set — so an entry a mod shipped malformed is never
  applied.
- **`InbornEffects.applyInbornEffects`** applies them in the spawn observer, after clothing
  and the loadout (it consumes no volume, so nothing races).
- **They are not persisted; they are re-applied at every spawn.** An inborn effect is a
  fact about a BODY, not about a run, and this matches the effect layer's existing
  save/load rule (a restart does not restore live effects). The world becomes self-healing:
  boot, recreate, or a card re-spawned after elimination, and the body arrives with what it
  was designed to carry, with no stored state to drift.
- **A refusal never costs a character.** Spawn is the one moment the world cannot fail
  half-way: an effect whose operations find no carrier is the body without that effect plus
  a warning naming it.

## Alternatives rejected

- **A script or expression per effect.** Rejected: it would make a data package an
  execution surface, and it would grow a second, parallel implementation of every mutation
  the consequence layer already owns.
- **Effects as a per-component condition flag** (extending `EffectTracker`). Rejected: it
  can carry a name and an expiry but not a bundle of operations, a stacking policy or a
  revert, and it would put the vocabulary in code rather than in the registry.
- **Persisting live effects across save/load.** Rejected for inborn effects (see above);
  for ordinary effects it stays what it was — a restart rebuilds the world from the
  packages, and an effect that outlived a reboot would be a state no data explains.
- **Letting the design write `core-effects`.** Rejected by the standing rule: a design
  writes exactly one new `body-*` package and never touches official data.

## Consequences

- A new kind has to ship its package: `test/contract/officialMods.contract.test.js` fails
  for a kind without a package and for a package without a kind.
- The four effect verbs and `applyEffect` are new surface for a mod author to get wrong, and
  each refusal is typed (`EFFECT_UNKNOWN`, `NO_TARGET_CARRIER`,
  `EFFECT_DEFINITION_INVALID`, ...) rather than a silent no-op, so a hit whose effect did
  not land never reports as a hit that did.
- Two new facade readers (`listActiveEffects`, `listInbornEffectIds`) and three writers
  (`applyEffect`, `removeEffects`, `registerEffectDefinition`) are pinned in
  `test/contract/worldStateController.contract.test.js`.
- The pipeline is five stages: an existing card's redesign costs one more LLM call than
  before, and the fifth is the cheapest (`LLM_DEFAULT_MAX_TOKENS * 3`) and legitimately
  empty most of the time.
