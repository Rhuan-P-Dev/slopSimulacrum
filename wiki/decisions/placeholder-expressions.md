# Decision: a placeholder carries `*N` and `/N`, and a stat never receives a value that is not a finite number

Date: 2026-11-06 (recorded in the commit that implements this)

## Context

A hand-authored fire-punch mod turned one of a droid's body parts into `null` in the panel.
Nothing in the log said why, and no `broken`/`componentBroke` event had fired.

The mod wrote its damage value the way a person writes arithmetic:

```json
{ "type": "damageComponent", "params": { "channel": "impact", "value": ":Physical.strength/2" } }
```

The placeholder grammar of `src/utils/PlaceholderResolver.js` was `^(-)?(:Trait.stat)(\*(-?\d+))?$` —
a leading sign and a multiplier whose operand had to be an **integer**. The regex is anchored
and exact, and an unrecognised string does **not** fail: it falls through to the template
branch, where each embedded placeholder is substituted and the rest of the text is kept
verbatim. `":Physical.strength/2"` with a strength of 1 therefore became the **string**
`"1/2"`.

From there every layer did its job on the wrong type. `_handleChannelDamage` multiplied that
string by the material's damage-against (`"1/2" * 1` is `NaN`), and the product was written
into `Physical.existence`. A `NaN` in a stat is not a bad frame; it is permanent and silent:

- `NaN + x` is `NaN`, so no later write can repair it (only a rebuild of the world from the
  packages can),
- the part never satisfies `existence > 0` again, so it stays a valid target yet is never
  destroyable,
- the damage listener tests a strict decrease and `NaN < 0` is `false`, so nothing fires and
  nothing is logged — which is why the panel rendered the part as `null` while the event
  record showed a peaceful afternoon.

The same poison was reachable without any typo: `":Physical.armor"` — a stat the actor does
not have — is left as its own text by design (the resolver does not invent a `0`), and any
consumer that then does arithmetic on it produces the identical `NaN`.

## Decision

**1. The grammar takes a divisor and a fractional operand: `*N` and `/N`, `N` a plain decimal
number, optionally signed.** `:Physical.strength*0.5` and `:Physical.strength/2` are both
`half the stat`. Halving is something world data legitimately wants to say; leaving it
unsayable is what produced the bug, because the failure mode of an unsupported expression is
a silent type change rather than an error.

One grammar feeds both the exact match and the embedded one (`PLACEHOLDER_ARITHMETIC` in
`PlaceholderResolver.js`), so an expression cannot mean one thing as a whole param and
another inside a log template.

**2. The resolver never returns a non-finite number.** A suffix it cannot compute — a divisor
of zero, a product that overflows past `Infinity` — leaves the **original text** in place and
warns. `":Physical.strength/0"` resolves to `":Physical.strength/0"`, never to `Infinity`.

**3. A stat write refuses a value that is not a finite number, in every store.**
`ComponentController.updateComponentStatDelta` (the choke point for damage, stat effects and
their removal, organ contributions, holding cost and corrosion ticks) and
`EquippedItemStatsController.updateStatDelta` return `false` and warn; the absolute setters
refuse a *numeric* non-finite value (`updateComponentStat` still accepts strings and objects
— a semantic SET takes any value by contract, and this guard is not a licence to police it).

**4. The damage consequence refuses a value that is not a finite number at its own entry**, on
both the channel path and the legacy stat-delta path, with a message naming the value
(`damageComponent: value must be a resolved number (got ":Physical.strength")`). The handler
already refused this on the shotgun branch — a non-number is never a shot either — the hole
was that only the shotgun did.

Three layers because the bad value has three independent ways of arriving: an unsupported
expression (now supported, so this one is closed at the grammar), an **unresolved** placeholder
(the resolver's own contract is to leave it as text, so a consumer must refuse it), and a
literal in a data file that only looks like a number (`"50/2"` is text and stays text). Each
layer catches what the one above it is *allowed* to pass.

## Two grammars, deliberately still two

`shared/RangeResolver.js` is a real expression parser — `+ - * / ( )`, decimals, `:Trait.stat`
— and it has been for a while, but only for **range**: it takes a `statMap` and a `fallback`,
and both the server check and the client's range indicator speak it. The consequence and
action **param** path never got that parser; `PlaceholderResolver` substitutes placeholders in
a string, because its job is a log line as much as a number.

This change widens the param grammar to the arithmetic world data actually writes (`sign`,
`*N`, `/N`, decimal operands) rather than merging the two modules. A merge is a different
decision and a bigger one: the resolvers disagree on what failure means (a range falls back to
a number, a placeholder stays as text so the author can see it), they read their operands from
different places (a stat map versus the resolved target's stats, inventory and needs), and the
param path has to keep resolving inside templates. If somebody wants one language everywhere,
that is the argument to have — and `test/unit/PlaceholderResolver.expressions.test.js` is the
contract to move, not to delete.

A third reader needs the shape: `EffectDefinitionRules` refuses an effect parameter that is
still an unresolved placeholder. It **builds** that pattern from the exported fragments
(`PLACEHOLDER_TOKEN`, `PLACEHOLDER_ARITHMETIC`) instead of typing its own. The first version
typed its own and went blind the day this grammar grew — it knew `*N` but not `/N` nor
decimals, so a `:NoSuch.stat/2` the resolver left as text walked past the guard into an
operation, where a string is a **name**: the effect applied cleanly and did nothing. Anyone
who needs to recognise a placeholder borrows these fragments; a copy is the bug.

## Why not the alternatives

- **Coerce at the write (`Number(value)` / `parseFloat`)** — rejected. `parseFloat("1/2")` is
  `1`, so the liberal reader silently deals a *full* hit where the author wrote half, and
  `Number("abc")` is `NaN`, which is exactly the state being guarded against. Coercion converts
  a loud data error into a quiet gameplay error, and quiet is what made this bug two days of
  reading code instead of one warning line.
- **Validate every action's params at boot** — rejected as the *only* answer (a boot pass may
  well come on top). A placeholder resolves against the *runtime* context, so `":Physical.armor"`
  is fine on one actor and poison on another; no static check can see that. And runtime
  authored content (`/system/write`, the agent-body designer, `/mods/apply`) reaches the world
  after boot.
- **Let `NaN` stand and repair it at read time** — rejected. The write is the last moment the
  bad value is still connected to the action that caused it; after that the world has no idea
  the number was ever wrong.

## Consequences

- Mod authors can write `*N`, `/N`, decimals and signs in a param that takes a stat; the
  operand is a decimal number, not an integer, and `/0` is not a value.
- An action whose damage value does not resolve **fails** that consequence step (`success:
  false`, a message naming the value) instead of harming the target. A partial action result is
  the correct shape: the failure is reported per consequence, as every other failed step is.
- The refusal shape is the existing "no such stat" shape (`false` + warn), so no caller had to
  change to accommodate it.
- Not covered, stated plainly: a `NaN` **seeded from data** cannot happen (JSON cannot express
  `NaN`, so a bad literal fails the parse, not the world); the raw `StatsController.setStats`
  bulk write stays unguarded because it is the seeding path and a guard there would reject
  whole definitions rather than one bad value.
- Two contract tests that pin "the shipped set is exactly this" (`actionProse`,
  `worldStateController` action shape, `modServiceIntegration` package set) count any package
  present under `data/mods/`, including a locally authored one. That is the local-data tax of a
  data-only mod system, not a defect of this change.

## Pinned by

- `test/unit/PlaceholderResolver.expressions.test.js` — the grammar: sign, integer and
  fractional multipliers, divisors, `/0` refused, unknown stat left as text, no non-finite
  number for any expression, one dialect in templates and in whole params.
- `test/unit/componentController.statGuard.test.js` and
  `test/unit/equippedItemStats.statGuard.test.js` — both stores refuse NaN, `Infinity`,
  `undefined` and a text delta; both still apply a finite one, and the damage listener still
  fires on a real weakening.
- `test/contract/effectsLive.contract.test.js` — "refuses a parameter still wearing any shape
  the grammar knows": the effect-definition guard agrees with this grammar for every shape
  (it fails against a hand-copied pattern), and a `rounds` override outside whole numbers
  `0`..`MAX_EFFECT_DURATION_ROUNDS` is refused rather than silently re-dated.
- `test/contract/damageValuePoison.contract.test.js` — the reported bug, end to end through the
  composed world and the real dispatcher: an unresolved placeholder in a damage value moves
  nothing and leaves the part alive *and still destroyable*; `"50/2"` is refused the same way;
  and `:Physical.strength/2` costs the target exactly half of what `:Physical.strength` costs.
