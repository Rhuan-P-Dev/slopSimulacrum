# BUG-022: Duplicate Contributing Components in Synergy Result

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `22bf5dc`
- **Related Files**: `src/controllers/synergyController.js` (lines 410-418, 582-590)

## Symptoms

In the synergy preview "Contributing Components:" section, the same component appeared multiple times:

```
Contributing Components:
• droidRollingBall (c60b12ba...)
• droidRollingBall (8b926599...)
• droidRollingBall (c60b12ba...)  ← duplicate
• droidRollingBall (8b926599...)  ← duplicate
Synergy: 1.95x, 4 components
```

Only 2 physical `droidRollingBall` components existed, but 4 entries were shown.

## Root Cause

The `dash` synergy configuration in `data/synergy.json` has **two component groups**:

```json
{
  "dash": {
    "componentGroups": [
      {
        "groupType": "sameComponentType",
        "componentType": "droidRollingBall",
        ...
      },
      {
        "groupType": "movementComponents",
        ...
      }
    ]
  }
}
```

Both groups matched the same 2 `droidRollingBall` components (they have both `droidRollingBall` type AND `Movement` traits), creating 4 entries in `contributingComponents`:
- Group 1 (`sameComponentType`): 2 entries
- Group 2 (`movementComponents`): 2 entries (same components)

## Fix

Added deduplication by `componentId` in both `_evaluateProvidedComponents()` and `_evaluateComponentGroups()`:

```javascript
// synergyController.js
// Deduplicate: each component should appear at most once
const seen = new Set();
const unique = [];
for (const c of contributingComponents) {
    if (!seen.has(c.componentId)) {
        seen.add(c.componentId);
        unique.push(c);
    }
}
return { multiplier: totalMultiplier, components: unique };
```

## Prevention

When accumulating items from multiple groups/sessions, always deduplicate by a unique identifier before returning results.

## References

- Related wiki: `wiki/subMDs/synergy_system.md`
- Related controller: `SynergyController`