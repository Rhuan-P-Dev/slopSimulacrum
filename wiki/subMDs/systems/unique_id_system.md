# Unique ID System

## 1. Design Rationale

The typed ID system was designed to solve a fundamental ambiguity in the original architecture: **how does the server determine whether an incoming ID refers to a component, an inventory item, or an equipped item?**

### The Problem

The original system used three different ID schemes — raw UUIDs for components, prefixed sequential numbers for inventory items, and synthetic strings for equipped items. This meant the server had to **guess** the type of an incoming ID, leading to:

- Complex fallback logic for matching equipped items
- Malformed ID bugs (e.g., an "equipped-undefined-knife" id)
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

## 2. Data-Driven Design

The typed ID system follows data-driven principles:

- ID generation is centralized in [`idGenerator.js`](src/utils/idGenerator.js) — new types only need a new generator function
- ID parsing is centralized in [`IdResolver.js`](src/utils/IdResolver.js) — new types only need a new prefix and parse rule
- No hardcoded type-checking logic exists in controllers — all validation goes through the single resolver

Because a mirror of the resolver exists on the client, both sides validate and interpret IDs identically without duplicating type logic.

## 3. Why This Matters

Without typed IDs:

- The server has to try multiple lookup strategies until one succeeds
- Errors in ID construction lead to silent failures (e.g., `equipped-undefined-knife`)
- Adding new entity/item types requires updating every controller that processes IDs

With typed IDs:

- **O(1) type detection** — the prefix tells you everything you need to know
- **Self-documenting** — any developer can look at an ID and know its type
- **Extensible** — new types are added by defining a prefix and generator, no existing code changes
- **Defensive** — invalid ID formats are rejected immediately with clear error messages
