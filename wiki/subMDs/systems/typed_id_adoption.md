# 🔢 Typed ID System Adoption Status

This document records that the typed ID system is **fully adopted** across all system areas, and explains **why** the system now uses typed IDs exclusively. The design rationale behind typed IDs themselves is documented in the [Unique ID System](unique_id_system.md).

## Why Self-Describing IDs

The typed ID system provides self-describing identifiers whose prefix encodes the object kind (entity, component, inventory item, equipped item). The prefix alone tells the server what an ID refers to, which removes the need for type-guessing fallback logic and makes every ID validatable in constant time.

## Why Adoption Is Complete (No Legacy Path)

The migration was deliberately left without a backward-compatibility shim:

- **One ID vocabulary, end to end.** Every layer — generation, resolution, broadcast, route validation, and the client — uses only typed IDs. A mixed vocabulary (typed + legacy) would keep the old type-guessing fallbacks alive and reintroduce exactly the ambiguity the system was built to remove.
- **Broadcast is the choke point.** All IDs are normalized to their typed form before they leave the server, so the client never has to interpret a legacy format and no legacy parsing code survives in the frontend.
- **Capability entries carry typed references.** Equipped-item capability entries reference items by their typed equipped ID (plus the owning entity), so downstream consumers resolve an equipped item without re-deriving it from a synthetic string.

## Why Centralized Generation and Parsing

ID generation and parsing are centralized (one module generates, one module resolves) so that adding a new entity/item type is a one-place change — a new prefix and a generator — rather than a change across every controller that touches IDs. No controller contains hardcoded type-checking logic.

## References

- Related wiki: [Unique ID System](unique_id_system.md)
- Related bugs: [BUG-106](../bugfixWiki/architectural/BUG-106-missing-typed-id-system.md), [BUG-107](../bugfixWiki/architectural/BUG-107-typed-id-system-partial-adoption.md), [BUG-108](../bugfixWiki/architectural/BUG-108-synthetic-equipped-id-format.md)
