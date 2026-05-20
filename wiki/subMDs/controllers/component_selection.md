# Component Selection System

## 1. Overview

Enforces the **"one component, one action"** rule: selected components are locked to a specific action and cannot be reused until released.

## 2. Architecture

```
Root Controller → SelectionController (injected into SynergyController, ActionController)
```

The server-side controller manages component locking with automatic TTL-based expiry. The client-side selection controller tracks the active action, selected component IDs, and cross-action selection state.

## 3. Lifecycle

1. **Lock**: Single or batch component lock
2. **Validate**: Selection is validated before action execution
3. **Execute**: Consequences apply to locked components
4. **Release**: Locks are released after action execution, including spatial actions that resolve components differently

**Auto-Expiry**: Stale selections expire before action execution.

## 4. Multi-Component Flow

1. Click-to-toggle components on the client
2. Live synergy preview when two or more components are selected
3. Map click triggers batch lock followed by execution and release

## 5. API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/select-component` | POST | Lock single component |
| `/select-components` | POST | Lock multiple components (batch) |
| `/release-selection` | POST | Release single component |
| `/selections/:entityId` | GET | Get all selections for entity |
| `/synergy/preview` | POST | Preview synergy without executing |