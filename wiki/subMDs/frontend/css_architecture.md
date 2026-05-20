# 🎨 CSS Architecture

## 1. Overview

Modular CSS split into single-responsibility modules. Each file is self-contained with no cross-file dependencies.

## 2. File Organization

| Module | Responsibility |
|--------|---------------|
| `styles.css` | Global CSS custom properties (theme variables) |
| `base.css` | Reset, body typography, heading styles |
| `layout.css` | Top-level grid/flex layout |
| `map.css` | SVG map visualization |
| `navigation.css` | Navigation buttons, overlays, world map, connection arrows |
| `actions.css` | Action list, capability status, selection states |
| `synergy.css` | Synergy preview, multipliers, modified values |
| `components.css` | Component selection, durability bars, tactical HUD |
| `utilities.css` | Micro-utilities (text colors, alignment) |
| `feedback.css` | Error notifications, release buttons, animations |
| `internal-components.css` | SVG internal component rendering, component viewer panel |

## 3. Loading

Individual link tags in the main HTML file. No build tools.

## 4. Key CSS Classes

| Class | Purpose |
|-------|---------|
| `.nav-selected` | Selected component highlight |
| `.nav-locked` | Cross-action grayed component |
| `.action-active` | Active action header |
| `.synergy-preview-display` | Live synergy preview panel (yellow, persistent) |
| `.synergy-result-display` | Post-execution result (green, auto-hide) |
| `.world-map-overlay` | World map overlay container |
| `.world-map-connection-line` | Clickable connection line |
| `.room-connection-line` | In-map connection arrow |
| `.internal-component` | SVG internal component circle |
| `.internal-component-pulse` | Pulsing animation for internal components |

## 5. Styling Philosophy

- **Theme**: Cyber-terminal aesthetic with dark background and neon accents
- **Font**: Monospaced throughout
- **Variables**: All colors via CSS custom properties in the root selector