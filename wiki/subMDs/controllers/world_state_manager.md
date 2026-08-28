# 📡 World State Manager

## 1. Overview

Client-side module for state synchronization. Single source of truth for the current simulation state on the client.

## 2. Public API

The public surface serves state consumers: fetching the world state from the server, tracking which entity the player is incarnated as, resolving the active droid for navigation and rendering, and reading the state back (full state, entity map, action registry). Reads of world data return defensive clones so UI code can work with the data without corrupting the single source of truth. Capability checks are deliberately clone-free — answering "can this entity execute this action?" without deep-cloning the world, because they run on hot UI paths where a full clone would be pure waste.

## 3. Active Droid Resolution

The active droid is the entity the player is incarnated as. When no incarnation exists, resolution falls back to a default droid entity, so navigation and rendering always have a valid subject even before the player incarnates.

## 4. Integration

- The app orchestrator calls fetchState during world refresh cycles
- getActiveDroid() provides droid for rendering
- State includes internal components for ComponentViewer
- Internal components live on the entity objects that own them rather than in a top-level field, keeping component data scoped to its owner
