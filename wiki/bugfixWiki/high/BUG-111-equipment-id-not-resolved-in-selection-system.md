# BUG-111: Equipment ID (eq-*) Not Resolved in Component Selection System

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `actionSelectController.js`, `selectionRoutes.js`, `actionController.js`, `WorldStateController.js`

## Symptoms

When a user equips an item (e.g., knife) and then tries to use an action that requires that equipped item (e.g., "cut" action):

1. **Server Log Warning**: `⚠️ WARN: [ActionSelectController] Invalid component ID format in batch: "eq-f1e132d2-e1f6-4622-a6cc-ec5b224ddc3b".`

2. The action fails because the server rejects the equipment ID (`eq-*`) as an invalid component ID format.

3. The client shows the error but the action is not executed.

## Root Cause

The component capability system (`ComponentCapabilityController`) returns capability entries where equipped items use the typed `eqId` (e.g., `eq-f1e132d2-...`) as the `componentId` field. When the client selects this component for an action, it sends the `eq-*` ID to the server.

However, the `ActionSelectController` only accepted `comp-*` (component) IDs and rejected `eq-*` (equipment) IDs as invalid format. This caused the selection lock to fail, and subsequently the action execution to fail.

The ID resolution gap existed because:
1. The `ComponentCapabilityController` correctly uses `eq-*` IDs for equipped item entries
2. The `ActionSelectController` did not have logic to resolve `eq-*` IDs to their host `comp-*` IDs
3. The selection routes validated component IDs but only accepted `comp-*` format

## Fix

### 1. Added ID Resolution Helper to `ActionSelectController`

A `_resolveToComponentId()` helper resolves equipment IDs to their host component IDs (component IDs pass through unchanged), so selection logic can work with both ID types transparently.

### 2. Updated Selection Methods to Use Resolution

All selection register/validate/release methods (including batch variants) now resolve equipment IDs before locking, validation, or release.

### 3. Updated Selection Routes

`selectionRoutes.js` now accepts both `comp-*` and `eq-*` IDs, rejecting only truly malformed IDs.

### 4. Updated Call Sites in `actionController.js`

All calls to selection methods now pass `entityId`, which equipment ID resolution requires to find the owning entity.

### 5. Updated `ComponentResolver.js`

Component list building and source-component resolution now accept both `comp-*` and `eq-*` IDs (plus legacy raw UUIDs).

### 6. Updated `actionController.js` Validation

Attacker component ID validation now accepts `eq-*` IDs alongside `comp-*` IDs and legacy raw UUIDs.

## Prevention

1. **Unified ID Resolution**: Any method that accepts component IDs should use `_resolveToComponentId()` to handle both `comp-*` and `eq-*` IDs transparently.

2. **Route Validation**: Selection routes should validate that IDs are either `comp-*` or `eq-*` format, not just `comp-*`.

3. **EntityId Propagation**: Methods that need to resolve equipment IDs must have access to `entityId`. Ensure `entityId` is passed through the call chain.

4. **Documentation**: Document that capability entries use `eq-*` IDs for equipped items, and that consumers should handle this appropriately.

## References

- Related wiki: `wiki/subMDs/typed_id_adoption.md`
- Related controller: `ActionSelectController`
- Related controller: `ComponentCapabilityController`
- Related controller: `HoldingCostController`
