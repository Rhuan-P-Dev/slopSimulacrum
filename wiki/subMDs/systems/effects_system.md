# Effects System

What an effect is, who owns which half, and every way one gets applied to a live body.
The decision and its rejected alternatives: [`wiki/decisions/effects-system.md`](../../decisions/effects-system.md).

## What it is

An **effect** is a named bundle of operations with a target, a duration in rounds, a
stacking policy and a revert policy. It is the missing middle between a consequence (what a
verb does once, now) and a world rule (what holds always): something applied *to a target*,
that *keeps doing* something, and that *stops*.

Data lives in the registry kind `effects` (`data/mods/core-effects/effects.json`), keyed by
effect id.

```jsonc
"burning": {
  "name": "Burning",
  "prose": { "phrase": "is burning" },
  "target": "entity",                 // "entity" | "component"
  "durationRounds": 3,                // 0 = until removed
  "stacking": "refresh",              // "refresh" | "capped" (needs maxStacks) | ...
  "revert": "auto",                   // "auto" | "none"
  "operations": [{ "op": "addCondition", "params": { "condition": "burning" } }],
  "perRound":   [{ "op": "damageRandomComponents", "params": { "channel": "heat", "value": 2, "count": 1 } }]
}
```

`target: "entity"` means *the parts this body has*, resolved at application — never an
invented part. An effect aimed at a stat lands on every component that actually carries it.

## The operation set is closed

An entry names operations **by id** from `shared/EffectVocabulary.js`. No code, no
expressions, no condition trees are expressible, and parameters are **literal** — a
placeholder like `:Physical.strength` resolves against the acting entity of an action in
flight, which an effect applied from the console does not have.

Each id is an **adapter over an executor that already exists** in
`src/controllers/consequences/`, so a mutation has exactly one implementation and a mod
stays a data-only package.

Growing or destroying a body part is **not in the set**: there is no public mount path
(components are produced at spawn from the blueprint) and the only destruction path is a
private delegator of the damage pipeline, which owns existence bookkeeping, content spill
and capability re-evaluation. Those ids stay reserved until a change makes a public mount
path first.

## Who owns what

| Module | Owns |
| --- | --- |
| `shared/EffectVocabulary.js` | the operation ids, targets, stacking and revert modes, and the caps |
| `src/controllers/effects/EffectDefinitionRules.js` | the shape law of one definition (pure, never throws) |
| `src/controllers/effects/EffectsController.js` | the definitions: reads `effects`, validates once, caches by store version, never throws |
| `src/controllers/effects/EffectEngine.js` | the live instances: what is running, on what, remaining rounds, contributions to revert |
| `src/controllers/effects/InbornEffects.js` | applying a body's declared effects at spawn |
| `src/controllers/consequences/ApplyEffectHandler.js` | the `applyEffect` consequence type — the bridge from a verb to the engine |
| `src/services/WorldOperatorService.js` | the operator verbs `apply_effect`, `remove_effect`, `list_effects`, `register_effect` |

The shape law is a module rather than a method because **two authors write it**: the boot
reader over the file, and the design pipeline's effects stage over what the model wrote.
One law, two readers (`CR T-1`).

## The round is the clock

An instance carries `appliedRound` and `expiresRound`; `TurnSystemController` advances
effects at the round boundary. An instance with `expiresRound === null` is **never** expired
— which is what an effect applied while no round has been published gets, and what makes an
inborn effect (`durationRounds: 0`, applied at spawn) mean "as long as this body stands".

## Revert

Every applied operation records what it changed; expiry or removal writes the inverse
through the same choke point. Ops whose inverse is not sound are **record-only on expiry** —
damage is not undone (that would be healing nobody asked for), dropped matter is not
un-dropped. Spatial moves revert only when the captured origin still resolves.

## How an effect gets applied

| Caller | Path |
| --- | --- |
| A verb, weapon, item or machine in the data | a consequence of type `applyEffect` naming an effect id (and optional `rounds`) |
| The live operator / System LLM | `apply_effect` / `remove_effect` / `list_effects` in `OPERATIONS`, run by `/system/execute` |
| A new effect defined for this session | `register_effect` — memory only; its answer names `POST /mods/apply` as the durable path |
| A designed body, every spawn | its blueprint's `appliesTo`-declared effects, applied by `InbornEffects` |

All of them reach one entry point: `EffectEngine.apply(effectId, { kind, id }, { rounds,
source })`, exposed on the facade as `applyEffect` / `removeEffects` / `listActiveEffects`.

A refusal is typed and reported (`EFFECT_UNKNOWN`, `NO_TARGET_CARRIER`,
`EFFECT_DEFINITION_INVALID`, ...). A hit whose effect did not land never reports as a hit
that did.

## What the model is told

`LlmContextController` reports, per component, the effects running on it with the rounds
remaining, and whole-body effects in `activeEffects`. One round left is not worth the same
plan as ten, so the number is in the context, not just the name.

## A designed body is born with its effects

The agent-body design pipeline is five stages: `concept, anatomy, organs, outfit,
**effects**`. The effects stage is last because an inborn effect is stated against the
finished body, and optional because most bodies have none — the prompt says so.

- Only the **base operations** are inborn-able (`statSet`, `statDelta`, `addCondition`,
  `removeCondition`, `grantFlag`). The rest act on the world without choosing to, and take
  parameters from an action in flight.
- The **save namespaces the id** `<packageSlug>_<authoredId>`: the effect registry is
  global, so two characters authoring `slowFrame` would otherwise share one effect.
- The definition carries **`appliesTo`**, stamped by the save — not authored by the model.
  `EffectsController.effectsDeclaredFor(blueprintKey)` reads it from the validated set.
- Effects are applied in the **spawn observer** and are **not persisted**: an inborn effect
  is a fact about a body, so boot, recreate or a re-spawned card all arrive with it, with
  no stored state to drift out of sync.
- A refusal never costs a character: an effect whose operations find no carrier means the
  body arrives without it and a warning names it.
