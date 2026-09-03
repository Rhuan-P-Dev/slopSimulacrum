# BUG-104: Unused `knife` Component Definition in data/components.json

- **Severity**: LOW
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
- **Related Files**: `data/components.json` (lines 42-46)

## Symptoms

The `knife` component type is defined in `data/components.json` but is never used as a component anywhere in the codebase. The knife is properly defined and used in:
- `data/inventoryItems.json` — as an inventory item definition
- `data/holdingCost.json` — as a holding cost configuration
- `data/actions.json` — in the `cut` action definition
- `data/synergy.json` — in synergy configurations

However, the `knife` entry in `data/components.json` is never referenced in `data/blueprints.json` or assigned to any entity as a component type.

## Root Cause

The `knife` component was likely defined as a component type during initial development but the knife was later re-designed to be an inventory item that gets equipped onto other components (like `droidHand`), not a standalone component itself. The entry in `components.json` was never cleaned up.

## Fix

Removed the `knife` component definition from `data/components.json`. The knife is still properly defined in `inventoryItems.json` where it belongs.

## Prevention

When redesigning data models, ensure that legacy entries are removed. Cross-reference validation tools should verify that all entries in definition files are actually used by blueprint or entity definitions.

## References

- Related wiki: `wiki/subMDs/data/components_and_entities.md`
- Related file: `data/inventoryItems.json`