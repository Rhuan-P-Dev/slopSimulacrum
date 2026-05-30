# 🎮 Action System

## 1. Overview

The Action System executes game actions on entities through a registry-based, consequence-driven pipeline: validate requirements, resolve which components satisfy each requirement, and execute success or failure consequences.

**Architecture**:
- An action controller orchestrates execution
- A capability controller provides pre-computed component capabilities
- A consequence dispatcher resolves targets and dispatches to handlers
- Delegated utilities handle range validation, component resolution, and requirement resolution

Room-related actions interact with rooms via a room lookup service. Spatial movement applies delta-translation consequences. See [movement_system.md](./movement_system.md).

---

## 2. Action Registry Structure

Each action definition in the registry specifies a targeting type, range, an array of trait-based requirements, an array of success consequences, and an optional array of failure consequences.

### Mandatory Target Field

Every consequence must declare a target field indicating whether it applies to the source component, the selected target, or the entity as a whole. The dispatcher resolves this to a concrete target ID before dispatching.

---

## 3. Component Binding Resolution

When executing an action, the source component is resolved through a priority chain: explicit attacker component, explicit target component, spatial targeting auto-resolution, self-target auto-resolution, and finally entity-wide fallback.

---

## 4. Consequences

### Success Consequences
Dispatched through the consequence handler system. Supported types include spatial translation, stat updates, component stat delta changes, component damage, logging, and event triggering.

### Failure Consequences
Executed via the same dispatcher with lower priority. Same structure as success consequences.

### Multi-Attacker Actions
Some actions process multiple attacker components separately, each dealing damage based on its own stats.

---

### Range Expressions

The `range` field in action definitions supports **expression syntax** using the same `PlaceholderResolver` mechanism as consequences:

```json
{
  "dropItem": {
    "range": ":Physical.strength*2"
  }
}
```

Supported patterns:
- `:Trait.stat` — resolves to the stat value (e.g., `:Physical.strength` → `25`)
- `:Trait.stat*N` — scales the stat value (e.g., `:Physical.strength*2` → `50`)
- `-:Trait.stat` — negates the stat value (e.g., `-:Physical.mass` → `-20`)
- Literal numbers — passed through unchanged (e.g., `10` → `10`)

Resolution flow:
1. `ActionController.executeAction()` passes the raw range value to `RangeValidator.checkGrabRange()`
2. `RangeValidator._resolveRequirementValues()` gathers all `"trait.stat"` → `value` pairs from the source entity's components
3. `resolvePlaceholders()` resolves the expression to a number
4. The resolved number is passed to `RangeChecker.checkGrabRange()` for distance validation

This design ensures range, consequences, and failureConsequences all share a single expression resolution mechanism.

---

## 5. Public API Methods

Methods for executing actions, checking requirements, retrieving actions for an entity, getting all capabilities, resolving dynamic values in consequences, and previewing action data with synergy. Cache management is delegated to the capability controller.

---

## 6. Built-in Consequence Handlers

See [consequence_handler_architecture.md](./consequence_handler_architecture.md) for handler details.

| Handler | Responsibility |
|---------|---------------|
| Spatial | Delta movement and spatial translation |
| Stat | Direct stat and stat delta updates |
| Damage | Component health reduction |
| Log | Server-side logging |
| Event | Event triggering |

---

## 7. Placeholder Resolution

Numeric placeholders embedded in consequence parameters are resolved at execution time using stat references, negated references, and scaled references. Placeholders can be embedded within strings alongside literal text.