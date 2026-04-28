# BUG-010: Self-Targeting Action Component Resolution

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `53fa440` ("feat: support self_target actions with immediate execution")
- **Related Files**: `src/controllers/actionController.js`

## Symptoms

When executing self-targeting actions (e.g., `selfHeal`):
- The target component was not resolved correctly
- Actions failed because the system couldn't find the correct component to apply effects to
- `selfHeal` failed because the component was still locked from a previous action (related to [BUG-003](../critical/BUG-003-spatial-action-lock-leak.md))

### Self-Targeting Action Flow

For `targetingType: 'self_target'` actions:
1. User clicks a component row in the action list → component selected, action executes instantly
2. Client sends `POST /execute-action` with `targetComponentId` and `componentIdentifier`
3. `ActionController.executeAction()` resolves via Priority 2 (explicit targetComponentId)
4. `ConsequenceHandlers.updateComponentStatDelta()` applies heal to the selected component
5. `WorldStateController` broadcasts updated state

## Root Cause

The component binding resolution did not properly handle self-targeting actions where the client sends `targetComponentId` but the server needed to resolve it correctly:

```javascript
// ❌ BEFORE (buggy resolution)
// Self-targeting actions didn't have a clear resolution priority
// The targetComponentId was not properly used for requirement resolution
```

## Fix

Implemented explicit component binding resolution priority:

1. `attackerComponentId` from params → punch actions
2. `targetComponentId` from params → spatial/self_target actions with explicit selection
3. `targetingType: 'spatial'` → auto-find Movement component
4. `targetingType: 'none'` or `'self_target'` → auto-find Physical self-target component
5. Fallback → entity-wide requirement check

### updateComponentStatDelta Handler Resolution

When applying stat changes, the handler now resolves the target component in this priority:

1. **Explicit `targetComponentId`** from `actionParams` (targeted actions like damage)
2. **Fulfilling component** from `context.fulfillingComponents` (self-targeting actions)
3. **Fallback to entity-wide update** via `_handleUpdateStat`

**⚠️ Note:** The old "first component with the trait" fallback has been removed to prevent unpredictable behavior.

## Prevention

- Always document client vs server component resolution for new action types
- Use explicit `targetComponentId` for self-targeting actions
- Follow the **Single Responsibility Principle** — component resolution belongs in `ActionController`

## References

- Related wiki: `wiki/subMDs/action_system.md`
- Related wiki: `wiki/subMDs/controller_patterns.md`
- Related controller: `ActionController`
- Git commit: `53fa440`
- Related bug: [BUG-003](../critical/BUG-003-spatial-action-lock-leak.md)
- Related bug: [BUG-004](../high/BUG-004-role-mismatch-skip.md)