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

- `CURVE_OFFSET` constant was too small (25px in RoomConnectionRenderer, 30px in WorldMapView) — resulting in insufficient perpendicular offset for bidirectional arrow curves
- `LABEL_OFFSET` constant was too small (8px in both files) — resulting in text labels sitting too close to arrow curves and each other
- No background rectangle for text labels in WorldMapView.js reduced readability when text overlapped with map elements

## Fix

- Increased `CURVE_OFFSET` from 25 to 50 in [`RoomConnectionRenderer.js`](../../../../../public/js/RoomConnectionRenderer.js:99)
- Increased `CURVE_OFFSET` from 30 to 50 in [`WorldMapView.js`](../../../../../public/js/WorldMapView.js:237)
- Increased `LABEL_OFFSET` from 8 to 16 in [`RoomConnectionRenderer.js`](../../../../../public/js/RoomConnectionRenderer.js:142)
- Increased `LABEL_OFFSET` from 8 to 16 in [`WorldMapView.js`](../../../../../public/js/WorldMapView.js:294)
- Added text background rectangle for connection labels in [`WorldMapView.js`](../../../../../public/js/WorldMapView.js:305-318)

## Prevention

- Consider extracting visual constants (`CURVE_OFFSET`, `LABEL_OFFSET`) to file-level constants for easier tuning
- Consider adding visual regression tests for map rendering

## References

- Related wiki: `wiki/subMDs/architecture/system_map.md`
