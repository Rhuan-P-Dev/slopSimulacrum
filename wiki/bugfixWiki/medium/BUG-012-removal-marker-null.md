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

The `_notifySubscribers()` method passed `null` when an entry was removed from the cache:

```javascript
// ❌ BEFORE (buggy - null removal)
_notifySubscribers(actionName, null)  // Can't tell what was removed!
```

Subscribers had no way to know which component was removed, making it impossible to clean up UI state or related data.

## Fix

Implemented structured `RemovalMarker` objects for removal notifications:

```javascript
// ✅ AFTER (fixed - structured removal)
_notifySubscribers(actionName, {
    _type: 'REMOVAL',
    componentId: componentId,
    entityId: entityId
})
```

### RemovalMarker Structure

| Field | Type | Description |
|-------|------|-------------|
| `_type` | `string` | Always `'REMOVAL'` |
| `componentId` | `string` | ID of the removed component |
| `entityId` | `string` | ID of the entity containing the component |

### Subscriber Handling

Subscribers now check for removal markers:

```javascript
actionController.on('punch', (actionName, capability) => {
    if (capability && capability._type === 'REMOVAL') {
        // Handle removal: clean up UI, update state
        console.log(`Component ${capability.componentId} removed from ${actionName}`);
    } else if (capability) {
        // Handle new/updated entry
    }
});
```

## Prevention

- Never use `null` to signal state changes — use explicit marker objects
- Document the contract for subscriber callbacks
- Follow the **Strong Typing** principle from `wiki/code_quality_and_best_practices.md` Section 2.2

## References

- Related wiki: `wiki/subMDs/action_capability_cache.md`
- Related wiki: `wiki/subMDs/controller_patterns.md` Section 7
- Related controller: `ComponentCapabilityController`