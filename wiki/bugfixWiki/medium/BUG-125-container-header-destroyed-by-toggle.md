# BUG-125: Container Header Destroyed by _toggleContainer()

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: Current implementation
- **Related Files**: `public/js/InventoryManager.js`

## Symptoms
When clicking to collapse a container, then expand it, then collapse again, then expand again — the container header ("Metal Box 12v 5/10 (50%)") disappears. The container items area shows but the header with item name, volume, and capacity bar is missing.

## Root Cause
The container header `<div class="inventory-container-header">` and the `<button class="inventory-container-toggle">` both shared the same `data-toggle-container` attribute. Since `querySelector()` returns the first matching element, `_toggleContainer()` found the header div instead of the button. When it executed `toggleBtn.textContent = '▼ '`, it overwrote the entire content of the header div, destroying all child elements (the button, spans, etc.).

## Fix
1. Separated attributes: Changed header div to use `data-container-header="${item.id}"` and kept `data-toggle-container` only on the button
2. Updated event listener attachment to query `[data-container-header]` elements
3. Fixed `_toggleContainer()` to query the header div first, then use `headerEl.querySelector('.inventory-container-toggle')` to find the button

## Prevention
Use distinct data attributes for different DOM elements. Never share query selectors between parent and child elements.

## References
- Related wiki: `wiki/subMDs/data/inventory_system.md`
