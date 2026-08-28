# BUG-012: Removal Marker Sent as `null` Instead of Structured Object

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: — (architectural fix in ComponentCapabilityController)
- **Related Files**: `src/controllers/componentCapabilityController.js`

## Symptoms

When a capability cache entry was removed (e.g., component stats dropped below requirement threshold):
- Subscribers received `null` instead of a structured removal signal
- Subscriber code couldn't distinguish between "entry updated" and "entry removed"
- UI failed to update correctly — removed capabilities remained highlighted

## Root Cause

The `_notifySubscribers()` method passed `null` when an entry was removed from the cache, so subscribers had no way to know which component was removed, making it impossible to clean up UI state or related data.

## Fix

Implemented structured `RemovalMarker` objects for removal notifications. A marker carries the identity of the removed component and entity, so subscribers can distinguish a removal from an update and clean up dependent UI state.

## Prevention

- Never use `null` to signal state changes — use explicit marker objects
- Document the contract for subscriber callbacks
- Follow the **Strong Typing** principle from `wiki/code_quality_and_best_practices.md` Section 2.2

## References

- Related wiki: `wiki/subMDs/action_capability_cache.md`
- Related wiki: `wiki/subMDs/controller_patterns.md` Section 7
- Related controller: `ComponentCapabilityController`