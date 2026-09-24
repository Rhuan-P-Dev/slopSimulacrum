# BUG-140: Action Log Messages Leak Raw Placeholders, Omit the Acting Entity, and Never Name the Firing Action

- **Severity**: LOW
- **Status**: ✅ Fixed
- **Fixed In**: `—`
- **Related Files**: `src/controllers/consequences/ConsequenceDispatcher.js`, `src/controllers/consequences/LogConsequenceHandler.js`, `data/actions.json`, `public/js/EventLogPanel.js`, `test/unit/ConsequenceDispatcher.logMessage.test.js`, `test/unit/EventLogPanel.client.test.js`

## Symptoms

- Action log lines leaked **raw placeholder tokens** to the output instead of concrete values. A damage action logged with `:stat`, `:actionName`, or `:damageValue` left those literal tokens in the line.
- The message **never identified the acting entity** — neither a display name nor an entity ID.
- The line **never named which action fired**. Because each damage action (punch, cut, shoot, shotgun) was authored with its *own* prose template, the only way a reader told them apart was the prose itself; a punch and a shoot looked structurally identical except for a hand-typed verb that could drift out of date.
- The **damage figure was not derivable** from the data shape. Damage actions store their magnitude in different places: a stat value (`:Physical.strength`), the consumed item's volume (the declared `value` is `0`), or a per-pellet value × a component count. So no single generic sentence could read "how much" without help.
- The same raw text reached **both** destinations that consume a logged consequence: the server-side log and the in-memory event ring buffer that feeds the LLM context — so the LLM saw the same unresolved string.

## Root Cause

Three separate gaps, each on a different layer:

1. **No resolution of the top-level message.** The data-driven `log` consequence stores its `message`/`level` on the **top level** of the consequence object, not inside a `params` block. The dispatcher's placeholder-resolution pass only ever resolved the `params` field, so a top-level message was handed to the `LogConsequenceHandler` completely untouched. That handler is deliberately a thin sink — it writes the given string to the log and forwards it to the event ring buffer — because resolution is the dispatcher's job, the component that owns the context (requirement values, action params, fulfilling components).

2. **No resolution context for the fields a self-explanatory line needs.** Even once the top-level message was routed through the resolver, the context only carried the acting entity ID and the requirement stats. It had no `:entityName`, `:actionName`, `:damageValue`, or `:damageChannel`, so a shared template could not name the actor, the action, or the damage.

3. **Per-action prose hid the action and the damage.** `data/actions.json` gave each damage action its own hard-typed sentence, so the action name was embedded in prose (and could drift), and the damage magnitude lived in a different place per action type (stat value / item volume / per-pellet × count), which no generic template could read directly.

## Fix

The log line is now self-explanatory at the *data* layer, resolved once in the dispatcher, and rendered verbatim everywhere downstream:

- **One shared generic template.** Every damage action in `data/actions.json` (punch, cut, shoot, shotgun) now uses the same sentence: `:entityName (:entityId) performed :actionName dealing :damageValue :damageChannel damage`. There is no per-action prose to drift, and the action name is now a resolved field, not hand-typed text.
- **The dispatcher owns the resolution context.** `ConsequenceDispatcher._resolveLogMessage` runs the top-level `message` of a `log` consequence through the same `PlaceholderResolver` already used for damage values, with a context carrying `:entityName`, `:entityId`, `:actionName`, `:damageValue`, and `:damageChannel`. `_getEntityName` follows the same display convention as the LLM context (`LlmContextController`): an entity with a name uses it (NPCs), a bare droid renders as `Droid`. This runs on both dispatch paths that share the consequence loop (single-attacker and multi-attacker) and on the failure path.
- **The damage context is derived from the action's own definition.** A `_damageContext` helper inspects the action's damage consequence and resolves the *real* magnitude: the stat value for `damageComponent` (punch/cut), the consumed item's `volume` for `consumeItemAndDamage` (shoot — the declared value is `0`, so the item volume published by the consume handler is used), or the resolved per-pellet value × the component count for `damageRandomComponents` (shotgun). This is why a shotgun reports the total it actually applied (per-pellet × components), not the per-pellet figure. (Synergy note: the logged `:damageValue` is the **pre-synergy** base figure — synergy multipliers are applied separately by the damage handler at execution time and are intentionally not folded into the log, so under an active synergy bonus the logged number may be lower than the damage actually applied; see `_damageContext`).
- **Multi-attacker message resolution uses the full per-attacker stat context.** On the two-attacker path, the message's `:stat` / `:damageValue` placeholders resolve against that attacker's full stat map (a `messageStatContext` option into `_dispatchConsequences`), *not* the strength-only requirement values used for param resolution (which must stay strength-only for BUG-134's ammo semantics). Without this split, a non-strength multi-attacker action (e.g. a two-handed shotgun keyed on `Manipulation.fine_controls`) would have logged `0` damage. A regression test pins that case.
- **Both output channels stay in sync.** The server console log prefix is `[Action:<actionName> target:<targetId>]` (was `[Action:<targetId>]`) and the event carries the `action` field, so the client event panel renders the resolved message verbatim — the action name is already in the sentence, so no separate badge is needed (the verbatim, badge-less rendering is a pre-existing property of the lineage at `HEAD`; this change set only adds clarifying comments to the client, so no badge-removal code delta appears in the diff).

Because the message resolves through the same resolver as damage, a template that references a value the context does not have degrades to the unchanged token rather than crashing or mangling the line — the change is strictly additive and safe for out-of-scope values and for non-damage actions (which simply carry no damage placeholders).

## Prevention

Treat every data-driven free text with `:Placeholder` tokens (log messages included) as requiring dispatcher-side resolution before hand-off, and keep that resolution in the dispatcher — the only component that owns the full context — with handlers remaining thin sinks. Author damage-action log lines from **one shared generic template** (entity, action name, damage value, damage channel) rather than per-action prose, so the action name is a resolved field that cannot drift and the sentence reads identically for every action a designer adds. Derive the damage magnitude from the action's own damage definition (stat value / consumed-item volume / per-pellet × count) instead of hard-coding a number, and keep the entity-name fallback (`entity.name || 'Droid'`) consistent with the LLM context. Also keep a data-authoring lint that enforces any action whose log uses the shared damage template also declares a channel-based damage consequence, so `:damageValue`/`:damageChannel` can never leak raw from a non-channel (or missing) damage action. Because the message now lives on the consequence's top level, do not reintroduce per-action message string-replace branches in the multi-attacker builder (the old `params.message` `:Physical.strength` replace was removed as dead — the message is resolved per-attacker by `_resolveLogMessage` from the full stat context instead). Pin the resolved line in a dispatcher regression test covering the generic placeholders, a named entity, the item-volume case (shoot), the count-multiplier case (shotgun), a non-damage action, and the multi-attacker and failure paths — including a non-strength multi-attacker action (two-handed shotgun) to guard the stat-context split between message and param resolution.

## References

- Related wiki: `wiki/subMDs/controllers/consequence_handler_architecture.md`
- Related controller: `ConsequenceDispatcher`
- Related controller: `LogConsequenceHandler`
- Related data: `data/actions.json` (damage-action `consequences` log messages)
