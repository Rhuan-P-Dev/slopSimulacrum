# Overlay Manager

## Purpose

Central coordinator for all floating window overlay panels. Replaces ConfigBarManager entirely.

**Why this pattern**: Without a coordinator, each panel managed its own visibility independently, allowing multiple panels to overlap. This created visual conflicts and no way to close all panels at once.

## Registration Model

Each panel registers itself with the manager at application startup rather than managing its own visibility. Registration is the manager's single coordination point: it tells the manager which panels it coordinates, along with each panel's config bar entry point and keyboard shortcut, so the manager can own open/close behavior, z-index stacking, and dismissal without any panel knowing about the others.

## Panel Contract

Panels interact with the manager through a small uniform interface. The uniformity is what lets the manager coordinate any panel without knowing its internals — a new panel joins by implementing the same contract, not by extending the manager.

## Design Decisions

### Why exclusive visibility?
Having multiple floating panels overlap creates visual clutter and user confusion. Most panels show different aspects of the same context (entity state, actions, inventory), and only one is relevant at a time.

### Why keyboard shortcuts?
Power users need fast access to panels. Keyboard shortcuts (1-4) provide instant toggle without clicking config bar buttons. Escape provides universal close.

### Why click-outside dismissal?
The shared backdrop serves as an affordance that clicking outside the panel will close it. This matches common UI patterns users expect from overlay/modal interfaces.