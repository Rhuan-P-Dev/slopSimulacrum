# BUG-004: Role Mismatch — Client/Server Resolution Difference

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `2573bea` ("fix: resolve spatial action locks and handle refresh scenarios")
- **Related Files**: `src/controllers/actionController.js` (requirement binding resolution)

## Symptoms

When executing spatial or self-targeting actions:
- Client-side component resolution returned a different role than the server-side resolution
- Requirement validation failed because the server couldn't find the expected component role
- Actions that worked on the client failed on the server with role mismatch errors

### Role Mismatch Table

| Action Type | Client Sends | Server Resolves To | Mismatch |
|-------------|-------------|-------------------|----------|
| Spatial (`move`, `dash`) | `'spatial'` | `'source'` | ❌ |
| None (`attack`) | `'source'` | `'self_target'` | ❌ |
| Self-Target (`selfHeal`) | `'self_target'` | `'self_target'` | ✅ |

## Root Cause

The client and server used different logic for resolving component roles:
- The client sent the raw `targetingType` value (e.g., `'spatial'`)
- The server resolved this to an internal role (e.g., `'source'`)
- Role validation compared client-sent roles against server-resolved roles, causing mismatches

## Fix

Added explicit role mismatch skip logic for actions where client/server resolution differs:

```javascript
// Role validation skip for targetingType actions
const skipRoleValidation = [
    'spatial',      // Client: 'spatial' → Server: 'source'
    'none',         // Client: 'source' → Server: 'self_target'
    'self_target'   // Self-targeting (instant execution)
];

if (skipRoleValidation.includes(targetingType)) {
    // Skip role validation — component resolution happens differently
    // between client and server for these action types
} else {
    // Normal role validation
}
```

### Binding Resolution Priority

1. `attackerComponentId` from params → punch actions
2. `targetComponentId` from params → spatial/self_target actions with explicit selection
3. `targetingType: 'spatial'` → auto-find Movement component
4. `targetingType: 'none'` or `'self_target'` → auto-find Physical self-target component
5. Fallback → entity-wide requirement check

## Prevention

- When adding new action types, document client vs server role resolution
- Use the `targetingType` field consistently between client and server
- Follow the **Loose Coupling** principle from `wiki/code_quality_and_best_practices.md` Section 1.2

## References

- Related wiki: `wiki/subMDs/action_system.md`
- Related wiki: `wiki/subMDs/controller_patterns.md`
- Related controller: `ActionController`
- Git commit: `2573bea`
- Related bug: [BUG-003](../critical/BUG-003-spatial-action-lock-leak.md)