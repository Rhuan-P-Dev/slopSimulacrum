# BUG-125: Container Header Destroyed by _toggleContainer()

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: Current implementation
- **Related Files**: `public/js/InventoryManager.js`

## Symptoms
When clicking to collapse a container, then expand it, then collapse again, then expand again — the container header ("Metal Box 12v 5/10 (50%)") disappears. The container items area shows but the header with item name, volume, and capacity bar is missing.

## Root Cause
The container header and its toggle button shared the same `data-toggle-container` attribute. Since `querySelector()` returns the first matching element, `_toggleContainer()` resolved the outer header instead of the inner button; when it updated the toggle button's label, it overwrote the header's entire content, destroying the button and its inner spans.

## Fix
The header and the toggle button now have distinct data attributes, so the toggle handler resolves the intended element and updates only the button's label — leaving the rest of the header (item name, volume, capacity bar) intact.

## Prevention
Use distinct data attributes for different DOM elements. Never share query selectors between parent and child elements.

## References
- Related wiki: `wiki/subMDs/data/inventory_system.md`
