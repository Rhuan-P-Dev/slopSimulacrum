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

## Root Cause

The component binding resolution did not properly handle self-targeting actions: the client sends an explicit `targetComponentId`, but the server had no defined priority for using it, so the selected component was not reliably used for requirement resolution.

## Fix

Introduced an explicit resolution priority for component binding so that a component explicitly selected by the user always takes precedence over auto-discovery and entity-wide fallbacks. When stat changes are applied, the target component is resolved from the explicit selection made at action time (or the fulfilling component for self-targeting actions) rather than re-guessed afterwards.

**⚠️ Note:** The old "first component with the trait" fallback has been removed because it could apply effects to an arbitrary component, producing unpredictable behavior.

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