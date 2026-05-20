# Server Splitting Architecture

## 1. Overview

The server is organized into single-responsibility modules following the Single Responsibility Principle and dependency injection. Each module handles one aspect: routing, socket lifecycle, broadcasting, or specific route groups.

## 2. Module Responsibilities

| Module | Responsibility |
|--------|----------------|
| Entry point | Controller initialization and startup |
| Bootstrap utility | HTTP server and WebSocket setup |
| Socket lifecycle controller | Connection handling, incarnation, disconnect |
| World state broadcast service | Broadcasting world state to clients |
| Route composition | Router assembly, route registration |
| Chat routes | Chat completion endpoint |
| World routes | World state, rooms, move-entity |
| Action routes | Action registry, action execution |
| Capability routes | Capability cache endpoints |
| Synergy routes | Synergy preview and computation |
| Selection routes | Component selection and locking |
| Internal component routes | Internal components management |

## 3. Route Registration Pattern

Each route module follows a consistent registration pattern that receives the router and dependency map. The composition file wires all routes together.

**Exception**: One route module uses the app locals pattern for dependency access.

## 4. Quality Standards

- **SRP**: Each module has one reason to change
- **DI**: Dependencies injected via constructor or function parameters
- **Logger**: All modules use centralized logging
- **Public API**: Routes use only the root controller public methods
- **Error Handling**: Consistent try/catch with logging
- **Input Validation**: All POST endpoints validate required fields