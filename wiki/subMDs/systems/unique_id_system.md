# Unique ID System

## 1. Design Rationale

The typed ID system was designed to solve a fundamental ambiguity in the original architecture: **how does the server determine whether an incoming ID refers to a component, an inventory item, or an equipped item?**

### The Problem

The original system used three different ID schemes:
- **Components**: Raw UUIDs (cryptographically strong but untyped)
- **Inventory items**: Sequential numbers with `item-` prefix (`item-1`, `item-2`)
- **Equipped items**: Synthetic strings (`equipped-${itemId}-${itemType}`)

This meant the server had to **guess** the type of an incoming ID, leading to:
- Complex fallback logic for matching equipped items
- Malformed ID bugs (e.g., `equipped-undefined-knife`)
- No way to distinguish a component ID from a raw UUID in other contexts
- Inconsistent tracking of equipped items across controllers

### The Solution

Every ID is now **self-describing** — the prefix alone tells the server what type the ID refers to. This eliminates all ambiguity and removes the need for type-guessing fallback logic.

### Why Type-Prefixed IDs Over Alternatives

| Approach | Pros | Cons |
|----------|------|------|
| **Type-prefixed IDs** (chosen) | O(1) type detection, no extra lookups, self-describing, simple validation | Slightly longer IDs |
| Separate type field in every message | Flexible | More data, no self-describing IDs |
| Context-dependent resolution | No ID changes needed | Fragile, hard to debug, error-prone |

The typed ID approach was chosen because it aligns with the **Single Source of Truth** rule: the ID itself is the authoritative source of its own type.

## 2. ID Format Specification

| Type | Prefix | Format | Scope | Example |
|------|--------|--------|-------|---------|
| Entity | `ent-` | `ent-${uuid}` | Per-entity | `ent-550e8400-e29b-41d4-a716-446655440000` |
| Component | `comp-` | `comp-${uuid}` | Per-entity | `comp-6ba7b810-9dad-11d1-80b4-00c04fd430c8` |
| Item (Inventory) | `item-` | `item-${uuid}` | Per-entity | `item-6ba7b811-9dad-11d1-80b4-00c04fd430c8` |
| Equipped Item | `eq-` | `eq-${uuid}` | Per-entity | `eq-6ba7b812-9dad-11d1-80b4-00c04fd430c8` |

## 3. Client-Server Resolution Flow

When the client sends a component reference in an action request:

1. The client includes typed IDs (e.g., `comp-abc123...`)
2. The server parses the ID prefix via `IdResolver.parseId()`
3. Based on the type, the server routes to the appropriate resolution logic:
   - `comp-`: Look up in `entity.components`
   - `item-`: Look up in `entity.items`
   - `eq-`: Look up in equipped items list
4. The resolved entity/component/item is used for action execution

## 4. Integration Points

### Capability Entries

Capability entries from the server include typed component IDs:

```javascript
{
  entityId: "ent-...",       // Typed entity ID
  componentId: "comp-...",   // Typed component ID
  componentType: "droidHand",
  componentIdentifier: "right",
  score: 95,
  _resolvedRole: "source",
  // For equipped item entries:
  _eqId: "eq-...",           // Typed equipped item ID
  _equippedItemType: "knife"
}
```

### Action Execution

Action execution routes validate typed IDs before processing:

- **Entity IDs**: Must be `ent-${uuid}` (or legacy UUID)
- **Component IDs**: Must be `comp-${uuid}` (or legacy UUID)
- **Equipped IDs**: Must be `eq-${uuid}`

### Selection Locking

The selection registry stores and validates typed component IDs. Only `comp-${uuid}` format IDs can be locked to actions.

## 5. Data-Driven Design

The typed ID system follows data-driven principles:
- ID generation is centralized in `idGenerator.js` — new types only need a new generator function
- ID parsing is centralized in `IdResolver.js` — new types only need a new prefix and parse rule
- No hardcoded type-checking logic exists in controllers — all validation goes through `IdResolver`

## 6. Why This Matters

Without typed IDs:
- The server has to try multiple lookup strategies until one succeeds
- Errors in ID construction lead to silent failures (e.g., `equipped-undefined-knife`)
- Adding new entity/item types requires updating every controller that processes IDs

With typed IDs:
- **O(1) type detection** — the prefix tells you everything you need to know
- **Self-documenting** — any developer can look at an ID and know its type
- **Extensible** — new types are added by defining a prefix and generator, no existing code changes
- **Defensive** — invalid ID formats are rejected immediately with clear error messages