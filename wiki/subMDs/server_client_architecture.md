# 🌐 Server-Client Architecture

This document describes the communication layer between the end-user and the LLM backend in the SlopSimulacrum project.

## 1. Architectural Overview
The project follows a middleware architecture to decouple the client interface from the LLM provider logic.

**Flow:**
- **LLM Interaction:** `Client (CLI/UI)` $\rightarrow$ `Node.js Server (Express)` $\rightarrow$ `LLMController` $\rightarrow$ `LLM Backend API`
- **World State Interaction:** `Browser/Client` $\rightarrow$ `Node.js Server (Express)` $\rightarrow$ `WorldStateController` $\rightarrow$ `Sub-Controllers`

### 1.1. Why this design?
*   **Security**: API keys and endpoints are kept on the server, not exposed to the client.
*   **Control**: The server can implement rate limiting, input filtering, and logging without updating the client.
*   **Consistency**: The `LLMController` remains the single source of truth for LLM communication.

---

## 2. Communication Protocol

### 2.1. Server API
The server exposes a REST API for chat interactions and world state retrieval.

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
A Node.js Express server that:
- Validates request formats and delegates LLM calls to the `LLMController`.
- Coordinates world state requests via the `WorldStateController`.
- Serves a static front-end from the `/public` directory.

### 3.2. Clients
- **CLI Client (`src/client.js`)**: A command-line interface that manages conversation history and communicates with the server via HTTP.
- **Web Front-end (`public/index.html`)**: A simple web page that visualizes the current world state in plain text.

---

## 4. How to Run

### 4.1. Start the Server
```bash
node src/server.js
```
The server will start by default on `http://localhost:3000`.

### 4.2. Start the Client
In a new terminal:
```bash
node src/client.js
```

---

### 📢 Notice for Future Agents
**Language Requirement:** All source code in this project must be written in **JavaScript**.
**Single Source of Truth:** Always refer to the wiki and its `subMDs` before implementing or modifying code.
