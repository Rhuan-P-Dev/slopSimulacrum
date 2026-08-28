# BUG-117: World Map Arrow Overlap — Bidirectional Connection Arrows and Text Labels Too Close Together

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `—`
- **Related Files**: `public/js/RoomConnectionRenderer.js`, `public/js/WorldMapView.js`

## Symptoms

- Bidirectional room connections (A→B and B→A) had arrows that were visually too close, making it difficult to distinguish between them
- Text labels on arrows overlapped with the arrow curves and with each other
- This affected both the in-room spatial map view and the full-screen world map overlay

## Root Cause

- The `CURVE_OFFSET` constant was too small in both connection renderers — the perpendicular offset between bidirectional arrow curves (A→B and B→A) was insufficient, so the arrows nearly overlapped
- The `LABEL_OFFSET` constant was too small in both renderers — text labels sat too close to the arrow curves and to each other
- The world map view had no background rectangle behind connection labels, reducing readability when text overlapped map elements

## Fix

The `CURVE_OFFSET` and `LABEL_OFFSET` constants were increased in both renderers so bidirectional arrow curves and labels are visually distinct, and a background rectangle was added behind the world map's connection labels so text stays readable over map elements.

## Prevention

- Consider extracting visual constants (`CURVE_OFFSET`, `LABEL_OFFSET`) to file-level constants for easier tuning
- Consider adding visual regression tests for map rendering

## References

- Related wiki: `wiki/subMDs/architecture/system_map.md`
