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

Role validation is now explicitly skipped for the action types whose client and server resolve component roles differently (`spatial`, `none`, `self_target`). Because these actions resolve components on opposite sides — the client sends the raw `targetingType` while the server resolves it to an internal role — a strict comparison of client-sent role against server-resolved role would always fail. The skip lets requirement checks proceed against the server-resolved role, fixing the mismatch without weakening validation for action types that resolve identically on both sides.

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