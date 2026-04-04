# 🌐 Server-Client Architecture

This document describes the communication layer between the end-user and the LLM backend in the SlopSimulacrum project.

## 1. Architectural Overview
The project follows a middleware architecture to decouple the client interface from the LLM provider logic.

**Flow:**
`Client (CLI/UI)` $\rightarrow$ `Node.js Server (Express)` $\rightarrow$ `LLMController` $\rightarrow$ `LLM Backend API`

### 1.1. Why this design?
*   **Security**: API keys and endpoints are kept on the server, not exposed to the client.
*   **Control**: The server can implement rate limiting, input filtering, and logging without updating the client.
*   **Consistency**: The `LLMController` remains the single source of truth for LLM communication.

---

## 2. Communication Protocol

### 2.1. Server API
The server exposes a REST API for chat interactions.

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

---

## 3. Components

### 3.1. Server (`src/server.js`)
A Node.js Express server that validates the request format and delegates the LLM call to the `LLMController`.

### 3.2. Client (`src/client.js`)
A CLI-based interface that manages conversation history and communicates with the server via HTTP.

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
