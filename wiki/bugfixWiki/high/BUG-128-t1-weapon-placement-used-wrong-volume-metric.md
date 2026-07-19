# BUG-128: T1 Weapon Placement Checked Max Volume Instead of Available Volume

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `t1-weapon-implementation`
- **Related Files**: [`src/controllers/WorldStateController.js`](src/controllers/WorldStateController.js)

## Symptoms

The T1 weapon failed to equip with the error message "Component does not have enough volume. Available: 0, Item needs: 1" even when the target hand components had sufficient free space. The weapon could not be placed on any available hand component despite valid volume capacity being present.

## Root Cause

Two separate issues in the weapon placement logic within `WorldStateController.js`:

1. **Wrong volume metric**: The code used `Physical.volume` (the component's maximum volume) instead of calculating the available volume (maximum minus currently used). This resulted in an incorrect available value of 0 being reported.

2. **Wrong volume threshold**: The placement check used the T1's internal volume (10) as the required space instead of its external volume (1), causing the fit check to fail even if available volume had been calculated correctly.

3. **No component priority**: Without specific hand component targeting logic, the placement algorithm could evaluate incorrect components first.

## Fix

Changed the placement logic to use `inventoryManager._getComponentMaxVolumeFromEntity()` and `_calculateComponentUsedVolume()` to compute actual available volume (max minus used). Changed the volume threshold from the T1's internal volume (10) to its external volume (1). Added hand component priority logic to ensure weapons are placed on appropriate hand components first.

## Prevention

Always use available volume calculations (max volume minus used volume) when checking if an item fits on a component. For items with `externalVolume`, use the external volume as the placement threshold, not the internal capacity. When equipping items with specific component requirements, implement priority logic for target component types.

## References

- Related wiki: `wiki/subMDs/data/inventory_system.md`
- Related wiki: `wiki/subMDs/systems/t1_weapon_system.md`
- Related bug: `wiki/bugfixWiki/high/BUG-127-inventory-items-lack-dual-volume-model.md`
- Related controller: `WorldStateController`
