# 🤖 LLM Integration Specification

## 1. Overview
This document specifies the integration with the Large Language Model (LLM) backend. The system uses a controller-based approach to abstract the communication with the LLM, ensuring that the rest of the application remains decoupled from the specific API implementation.

## 2. Communication Pattern
The integration follows the **OpenAI Chat Completion** pattern. Communication is handled via HTTP POST requests.

### 2.1. Endpoint
- **URL**: `http://127.0.0.1:20003/v1/chat/completions`
- **Method**: `POST`

### 2.2. Request Schema
The request body must be a JSON object following this structure:

```json
{
  "model": "string",           // The ID of the model to use
  "messages": [                // A list of messages comprising the conversation
    {
      "role": "system" | "user" | "assistant",
      "content": "string"
    }
  ],
  "temperature": "number",     // Sampling temperature (0.0 to 2.0)
  "max_tokens": "integer",     // Maximum number of tokens to generate
  "stream": "boolean"          // Whether to stream the response
}
```

### 2.3. Response Schema
The expected response is a JSON object containing the generated content:

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "string"
      },
      "finish_reason": "string"
    }
  ],
  "usage": {
    "prompts": "integer",
    "completion": "integer",
    "total": "integer"
  }
}
```

## 3. The `LLMController`
The `LLMController` is the single source of truth for LLM communication.

### 3.1. Responsibilities
- Formulate requests in the OpenAI format.
- Handle HTTP communication.
- Perform basic error handling and graceful degradation.
- Validate LLM responses before passing them back to the calling controller.

### 3.2. Usage Example
```javascript
const llm = new LLMController();
const response = await llm.chat([
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Hello!' }
]);
```

## 4. Best Practices for LLM Calls
- **Prompt Engineering**: System prompts should be clearly defined in separate configuration files or constants, not hard-coded in the `LLMController`.
- **Timeout Handling**: Always implement a timeout for LLM calls to prevent the system from hanging.
- **Validation**: Always validate that the response contains `choices[0].message.content` before accessing it.
