# 🖥️ Client UI

## 1. Overview

A cyber-terminal styled single-page application built with HTML5, CSS3, and vanilla JavaScript. The layout consists of a top config bar, a middle spatial map area, and a bottom stat bars panel.

**CSS modules**: Single-responsibility stylesheets covering base resets, layout, map visualization, navigation, actions, synergy, components, utilities, feedback, and internal components.

## 2. Layout

The top section holds the config bar with buttons for each overlay. The middle section is a flexible SVG-based spatial map displaying rooms, entities, and components. The bottom section is a fixed-height scrollable stat bars panel.

Floating overlays appear on demand: component viewer, actions panel, and world map.

## 3. Key UI Features

- **Map rendering**: SVG with rooms, entities, components, and internal components rendered as colored circles
- **Range indicators**: Color-coded circles for movement range and attack range
- **Stat bars**: Configurable, percentage-based bars colored by trait
- **Component Viewer**: Grid of component cards with an expandable internal component panel
- **Multi-component selection**: Click-to-toggle with cross-action graying and synergy preview
- **World Map overlay**: Pan and zoom navigation with clickable room connections
- **Error display**: Notification pop-ups in the corner of the screen

## 4. Styling

- **Theme**: Cyber-terminal aesthetic with a dark background and neon accent colors
- **Font**: Monospaced typeface
- **Variables**: All colors defined as CSS custom properties