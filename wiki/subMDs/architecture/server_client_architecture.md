# 🌐 Server-Client Architecture

## 1. Overview

The architecture follows a layered pattern: browser UI connects to a server via REST (HTTP) for state queries and actions, and via WebSocket for real-time updates and identity management.

**Communication**: REST for state retrieval and action execution, WebSocket for identity assignment and real-time world state broadcasting.

## 2. Key Points

- API keys and LLM backend are kept on the server for security
- The server uses only the root controller's public API (no direct sub-controller access)
- WebSocket connection assigns a new entity to each client on connect
- Disconnect automatically despawns the client's entity

## 3. REST Endpoint Categories

| Category | Method | Description |
|----------|--------|-------------|
| Chat | POST | LLM chat completion |
| World State | GET | Full world state snapshot |
| Rooms | GET | All room definitions |
| Actions | GET | Action registry (optionally filtered by entity) |
| World Map | GET | World graph with room names |
| Entity Movement | POST | Move entity to a room |
| Action Execution | POST | Execute an action |
| Capability Cache | GET/POST | Capability cache endpoints |
| Synergy | GET/POST | Synergy preview and computation |
| Component Selection | POST | Component selection and locking |
| Selections | GET | Locked components |
| Internal Components | GET/POST/DELETE | Internal components management |