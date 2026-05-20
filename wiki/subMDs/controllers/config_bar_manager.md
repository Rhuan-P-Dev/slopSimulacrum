# ⚙️ Config Bar Manager

## 1. Overview

Manages the top config bar buttons and overlay coordination. Wires together all overlay modules and ensures only one overlay is open at a time.

## 2. Public API

Methods for initializing the DOM and event listeners, closing individual overlays (component viewer, actions panel, world map), closing all overlays, and toggling a single panel while closing others.

## 3. Buttons

| Button | Purpose |
|--------|---------|
| Component Viewer | Toggle component detail overlay |
| Actions | Toggle actions panel |
| World Map | Toggle world map overlay |
| Add Stat | Open stat bar addition dialog |
| Color Scheme | Theme customization |