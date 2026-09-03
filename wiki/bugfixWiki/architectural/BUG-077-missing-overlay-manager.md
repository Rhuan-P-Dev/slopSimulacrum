# BUG-077: Missing Overlay Manager — Floating Window Coordination

- **Severity**: ARCHITECTURAL
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
- **Related Files**: `OverlayManager.js`, `floating-windows.css`, `ConfigBarManager.js` (deleted), `App.js`, `index.html`

## Symptoms

1. Multiple floating overlay panels could overlap simultaneously with no conflict resolution
2. ConfigBarManager was a pure pass-through — calling `.show()`, `.hide()`, `.toggle()` on individual controllers with zero unique logic
3. Inline `onclick` handlers in HTML for close buttons (`index.html` lines 92, 103, 114)
4. No keyboard shortcut support for opening/closing panels
5. No click-outside dismissal mechanism
6. App.js → ConfigBarManager → Panel was an unnecessary 2-layer delegation chain

## Root Cause

No centralized coordinator existed for floating window visibility. Each panel controller managed its own display independently. ConfigBarManager existed solely as a delegation layer with no unique business logic, adding ~330 lines of code that provided zero value.

## Fix

The fix involved three architectural changes:

1. **Replaced pure-delegation anti-pattern with centralized coordination.** ConfigBarManager was removed because it implemented zero unique business logic — it only delegated `.show()`, `.hide()`, `.toggle()` calls to panel controllers. This violated SRP by adding ~330 lines of code that served as a pass-through layer. The OverlayManager replaces it as the single coordinator for panel lifecycle management.

2. **Consolidated overlay coordination into a singleton registry.** Panel visibility, keyboard shortcuts, click-outside dismissal, and z-index stacking are now managed by a single OverlayManager instance. This emerged from the design decision that floating panels share a common context (entity state, actions, inventory) where only one is relevant at a time. Exclusive visibility is a natural consequence of the coordinator pattern rather than an added constraint.

3. **Decoupled panel-close UX from lifecycle management.** Panel controllers attach their own close button listeners in `init()` because close button behavior is a presentation concern specific to each panel's UX. The OverlayManager manages the broader lifecycle (exclusive visibility, backdrop, z-index) while panels own their local close interaction. This separation ensures each module has exactly one reason to change.

## Prevention

- Any future overlay panel should register with OverlayManager, not manage visibility independently
- ConfigBarManager pattern (pure delegation with zero logic) is prohibited
- Inline HTML event handlers should be moved to JS controllers

## References
- Related wiki: `wiki/subMDs/frontend/client_architecture.md`
- Related controller: `OverlayManager`
- Removed controller: `ConfigBarManager`