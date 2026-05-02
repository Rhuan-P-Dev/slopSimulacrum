# 🌐 Server-Client Architecture

This document describes the communication layer between the end-user and the LLM backend in the SlopSimulacrum project.

## 1. Architectural Overview
The project follows a middleware architecture to decouple the client interface from the LLM provider logic. It employs a hybrid communication model using both REST for state retrieval/actions and WebSockets for identity management.

**Flow:**
- **LLM Interaction:** `Client (CLI/UI)` $\rightarrow$ `Node.js Server (Express)` $\rightarrow$ `LLMController` $\rightarrow$ `LLM Backend API`
- **World State Interaction:** `Browser/Client` $\rightarrow$ `Node.js Server (Express)` $\rightarrow$ `WorldStateController` $\rightarrow$ `Sub-Controllers`
- **Identity & Incarnation:** `Browser/Client` $\xleftrightarrow{\text{WebSocket}}$ `Node.js Server (Socket.io)` $\rightarrow$ `WorldStateController`

### 1.1. Why this design?
*   **Security**: API keys and endpoints are kept on the server, not exposed to the client.
*   **Control**: The server can implement rate limiting, input filtering, and logging without updating the client.
*   **Consistency**: The `LLMController` remains the single source of truth for LLM communication.

---

## 2. Communication Protocol

### 2.1. Server API
The server exposes a REST API for chat interactions and world state retrieval, and a WebSocket layer for identity management.

#### 2.1.1. WebSocket Events
**Event:** `incarnate` (Server $\rightarrow$ Client)
**Payload:**
```json
{
  "entityId": "uuid-entity-123"
}
```
**Description:** Triggered upon connection. The server spawns a new entity for the client and notifies them of their identity.

**Event:** `world-state-update` (Server $\rightarrow$ Client)
**Payload:**
```json
{
  "state": { ... }
}
```
**Description:** Broadcasted to all connected clients whenever a world state change occurs (e.g., after an action execution or entity movement).

#### 2.1.2. REST Endpoints
The server exposes the following REST API:

**Endpoint:** `POST /chat`
**Payload:**
```json
{
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ]
}
```

**Successful Response (200 OK):**
```json
{
  "response": "The generated text from the LLM"
}
```

**Error Response (400/500):**
```json
{
  "error": "Error description",
  "details": "Detailed error message"
}
```

**Endpoint:** `GET /world-state`
**Description:** Retrieves the full world state including spatial data.
**Successful Response (200 OK):**
```json
{
  "state": {
    "rooms": {
      "uuid-1234-5678": {
        "id": "uuid-1234-5678",
        "name": "Room Name",
        "description": "Room description",
        "x": 200,
        "y": 250,
        "width": 300,
        "height": 200,
        "connections": { ... },
        "entities": [ ... ],
        "objects": [ ... ]
      }
    },
    "entities": {
      "uuid-entity-1": {
        "id": "uuid-entity-1",
        "blueprint": "smallBallDroid",
        "location": "uuid-room",
        "spatial": {
          "x": 0,
          "y": 0
        },
        "components": [ ... ]
      }
    },
    "components": { ... }
  }
}
```

**Endpoint:** `GET /rooms`
**Description:** Retrieves all rooms with their coordinates and dimensions.
**Successful Response (200 OK):**
```json
{
  "rooms": {
    "uuid-1234-5678": {
      "id": "uuid-1234-5678",
      "name": "The Entrance Hall",
      "x": 200,
      "y": 250,
      "width": 300,
      "height": 200,
      "connections": { ... }
    }
  }
}
```

**Endpoint:** `GET /actions`
**Description:** Retrieves the action registry. If `entityId` is passed as a query parameter, the list is filtered to only show actions relevant to that entity.
**Query Parameter:** `entityId` (Optional)
**Successful Response (200 OK):**
```json
{
  "actions": {
    "actionName": { ... }
  }
}
```

**Endpoint:** `POST /move-entity`
**Description:** Moves a specific entity to a target room.
**Payload:**
```json
{
  "entityId": "uuid-entity",
  "targetRoomId": "uuid-room"
}
```
**Successful Response (200 OK):**
```json
{
  "message": "Entity moved successfully."
}
```

---

## 3. Components

### 3.1. Server (`src/server.js`)
A Node.js Express server integrated with Socket.io that:
- Validates request formats and delegates LLM calls to the `LLMController`.
- Coordinates world state and action requests via the `WorldStateController` and `ActionController`.
- Manages "Incarnation": maps WebSocket IDs to spawned entities and handles automatic despawning on disconnect.
- Serves a static front-end from the `/public` directory.

### 3.2. Client
- **Web Front-end (`public/`)**: A cyber-terminal interface utilizing a modular JavaScript architecture. It consists of `index.html` (structure), `styles.css` (styling), and a set of managers in `public/js/` (`App.js`, `Config.js`, `WorldStateManager.js`, `UIManager.js`, and `ActionManager.js`) that visualize the world state and handle action execution.

---

## 4. How to Run

### 4.1. Start the Server
```bash
node src/server.js
```
The server will start by default on `http://localhost:3000`.

---

### 📢 Notice for Future Agents
**Language Requirement:** All source code in this project must be written in **JavaScript**.
**Single Source of Truth:** Always refer to the wiki and its `subMDs` before implementing or modifying code.
