# 🎨 CSS Architecture

This document describes the modular CSS architecture of the `slopSimulacrum` frontend.

## Overview

The monolithic `public/styles.css` (785 lines) has been refactored into **9 single-responsibility modules** following the **Single Responsibility Principle (SRP)**. Each CSS file has ONE clear purpose and contains no duplicate selectors.

## File Structure

```
public/
├── styles.css           ← Root: CSS variables only (no @import)
├── css/
│   ├── base.css         ← Global typography: body, h1
│   ├── layout.css       ← Page grid: .main-layout, .section
│   ├── map.css          ← SVG map: rooms, entities, components
│   ├── navigation.css   ← Nav & overlays: buttons, detail cards, overlays
│   ├── actions.css      ← Action list: capabilities, selection states
│   ├── synergy.css      ← Synergy preview: multipliers, modified values
│   ├── components.css   ← Component HUD: tactical targeting, durability
│   ├── utilities.css    ← Micro-utilities: text colors, alignment
│   └── feedback.css     ← Feedback: error popups, release buttons, animations
```

## Module Responsibilities

| File | Lines | Responsibility |
|------|-------|----------------|
| `styles.css` | ~15 | `:root` CSS custom properties (shared reference) |
| `css/base.css` | ~30 | Reset, body typography, h1 styling |
| `css/layout.css` | ~25 | Top-level grid layout, panel containers |
| `css/map.css` | ~70 | SVG map visualization, room boundaries, entity/component markers |
| `css/navigation.css` | ~157 | Navigation buttons, room info panels, detail overlays, world map overlay, room connection arrows |
| `css/actions.css` | ~90 | Action list rendering, capability status, multi-component selection |
| `css/synergy.css` | ~115 | Synergy preview display, multiplier display, modified values |
| `css/components.css` | ~115 | Component selection list, durability bars, tactical HUD |
| `css/utilities.css` | ~20 | Reusable micro-utilities (text colors, alignment) |
| `css/feedback.css` | ~60 | Error popups, release buttons, animation keyframes |

## Loading Mechanism

The project uses **no build tools** (no webpack, vite, or CSS bundler). CSS is loaded via individual `<link>` tags in `public/index.html`:

```html
<link rel="stylesheet" href="styles.css">
<link rel="stylesheet" href="css/base.css">
<link rel="stylesheet" href="css/layout.css">
<link rel="stylesheet" href="css/map.css">
<link rel="stylesheet" href="css/navigation.css">
<link rel="stylesheet" href="css/actions.css">
<link rel="stylesheet" href="css/synergy.css">
<link rel="stylesheet" href="css/components.css">
<link rel="stylesheet" href="css/utilities.css">
<link rel="stylesheet" href="css/feedback.css">
```

Each module file includes its own `:root` CSS variables block so it loads independently without `@import` dependency.

## CSS Custom Properties

All CSS variables are defined in `:root` in `public/styles.css` AND duplicated in each module file:

```css
:root {
    --neon-green: #00ff00;
    --dark-green: #004400;
    --bg-black: #0a0a0a;
    --panel-bg: #161616;
    --text-main: #fff;
    --text-dim: #aaa;
    --glow: 0 0 10px rgba(0, 255, 0, 0.5);
}
```

## Naming Conventions

- **BEM-like**: `.component-select-item`, `.synergy-value-row`
- **Modifier classes**: `.active`, `.clickable`, `.locked`
- **Utility classes**: `.text-muted`, `.text-center`
- **No naming conflicts**: Each class appears in exactly ONE file

## Maintenance Guidelines

1. **Adding new styles**: Determine which module the style belongs to. If it doesn't fit any existing module, create a new one.
2. **No duplicate selectors**: Before adding a class, verify it doesn't already exist in another module.
3. **CSS variables**: Always use `var(--variable-name)` — never hard-code color values.
4. **Section headers**: Each file must start with a `/* ========================================================================= ... */` comment block describing its responsibility.

## Recent Changes

| Date | Change |
|------|--------|
| 2026-05-13 | **Added:** World Map overlay styles (`.world-map-overlay`, `.world-map-room-node`) and Room Connection arrow styles (`.room-connection-line`, `.room-connection-label`, `.room-connection-label-bg`, `.room-connection-arrow`) |

## References

- [Client UI Wiki](client_ui.md) — Frontend architecture
- [World Map Wiki](world_map.md) — World Map System (CSS styles section)
- [Code Quality Standards](../code_quality_and_best_practices.md) — SRP requirements
