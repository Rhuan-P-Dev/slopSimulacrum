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

The REST surface groups the server's query and command operations by domain (chat, world
state, rooms, actions, movement, capabilities, synergy, selection, internal components); the
WebSocket channel is reserved for identity assignment and real-time world-state broadcast.
Individual endpoint contracts live in the server's route modules (code), not in the wiki.