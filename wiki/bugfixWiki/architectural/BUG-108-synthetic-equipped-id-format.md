# BUG-108: Synthetic equipped ID format (`equipped-${uuid}-${type}`) replaced with typed `eq-${uuid}` IDs

- **Severity**: ARCHITECTURAL
- **Status**: ✅ Fixed
- **Fixed In**: `typed-id-full-migration`
- **Related Files**: `src/controllers/capabilities/componentCapabilityController.js`, `src/controllers/WorldStateController.js`, `public/js/App.js`, `public/js/NavActionsPanel.js`, `public/js/InventoryManager.js`, `public/js/WorldStateManager.js`, `src/services/WorldStateBroadcastService.js`

## Symptoms

Equipped item IDs used a synthetic concatenation format `equipped-${itemId}-${itemType}` (e.g., `equipped-item-uuid-knife`) instead of the typed ID system's `eq-${uuid}` format. This violated the typed ID system's consistency and required legacy string parsing on the client side using `componentId.startsWith('equipped-')` and manual `substring()`/`lastIndexOf()` parsing to extract the itemId and itemType.

## Root Cause

The typed ID system was partially adopted (BUG-106, BUG-107), but equipped item IDs were not migrated. The ComponentCapabilityController generated equipped IDs using the synthetic `equipped-` prefix pattern, which was incompatible with the `IdResolver` system and required custom parsing logic across multiple client files.

## Fix

Migrated equipped item IDs from the synthetic `equipped-${itemId}-${itemType}` format to typed `eq-${uuid}` IDs, so equipped items resolve through the same `IdResolver` path as every other ID type. Capability entries and state broadcasts now carry typed equipped IDs, and client code determines ID type through the resolver instead of manual string-prefix parsing.

### Browser-compatible IdResolver

A browser-compatible copy of the resolver was created because client code cannot depend on Node.js modules — the same parsing logic therefore runs on both sides without divergence.

### Legacy Compatibility

**Removed entirely** — no backward compatibility for raw UUIDs or the `equipped-` prefix, because supporting both formats would perpetuate the dual-format ambiguity this bug documents.

## Prevention

1. All ID generation must use the typed ID generators (`generateEntityId`, `generateCompId`, `generateItemId`, `generateEquippedId`)
2. Client-side ID type checks must use `IdResolver` methods, not string prefix checks
3. All IDs in state broadcasts must pass through `_transformForBroadcast()`
4. No synthetic ID formats (like `equipped-${uuid}-${type}`) are permitted

## References
- Related wiki: `wiki/subMDs/systems/typed_id_adoption.md`
- Related bug: `wiki/bugfixWiki/architectural/BUG-106-missing-typed-id-system.md`
- Related bug: `wiki/bugfixWiki/architectural/BUG-107-typed-id-system-partial-adoption.md`