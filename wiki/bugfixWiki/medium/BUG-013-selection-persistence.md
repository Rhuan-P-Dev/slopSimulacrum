# BUG-013: Component Selection Lost on Page Refresh

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `2573bea` ("fix: resolve spatial action locks and handle refresh scenarios")
- **Related Files**: `public/js/App.js`, `src/controllers/actionController.js`

## Symptoms

When the user refreshed the page while having component selections:
- All component selections were lost
- The player had to re-select components manually
- Spatial actions were broken after refresh because component locks were stale

## Root Cause

1. **Client-side selections**: The `App.js` component selection state was stored in JavaScript variables that were lost on page refresh
2. **Stale server-side locks**: The `ActionSelectController` on the server still held locks from before the refresh
3. **No synchronization**: No mechanism to synchronize client selections with server locks after refresh

## Fix

Addresses each root cause: the client clears stale selections on load, the server now always releases component locks after action execution (including error paths) so a refresh never inherits stale locks, and explicit spatial component tracking ensures locked components are released consistently. On refresh, the client re-synchronizes with the server's authoritative lock state so the UI reflects a clean state.

## Prevention

- Always handle page refresh scenarios in stateful applications
- Implement cleanup logic for stale locks on reconnection
- Follow the **Long-term State Persistence** principle from `wiki/code_quality_and_best_practices.md` Section 6.2

## References

- Related wiki: `wiki/subMDs/component_selection.md`
- Related wiki: `wiki/subMDs/client_ui.md`
- Related controller: `ActionSelectController`, `ActionController`
- Git commit: `2573bea`
- Related bug: [BUG-003](../critical/BUG-003-spatial-action-lock-leak.md)