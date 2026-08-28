# ⚙️ Config Bar Manager

## 1. Overview

Manages the top config bar buttons and overlay coordination. Wires together all overlay modules and ensures only one overlay is open at a time.

## 2. Public API

The public surface is the overlay lifecycle: initializing the bar, opening and closing individual panels, and closing all overlays at once — always enforcing the single-overlay invariant.

## 3. Buttons

| Button | Purpose |
|--------|---------|
| Component Viewer | Toggle component detail overlay |
| Actions | Toggle actions panel |
| World Map | Toggle world map overlay |
| Add Stat | Open stat bar addition dialog |
| Color Scheme | Theme customization |