# 🤖 LLM Integration

## 1. Overview

An LLM controller communicates with an OpenAI-compatible Chat Completion API via HTTP POST. It is the single source of truth for LLM interaction on the server side.

## 2. Communication

- **Endpoint**: Configurable OpenAI-compatible Chat Completion API URL
- **Request shape**: Model name, messages array with role/content pairs, temperature, max tokens, streaming flag
- **Response shape**: Choices array with role/content message, usage statistics for prompts/completion/total

## 3. Best Practices

- Implement timeout to prevent hanging
- Validate response choices exist before accessing message content
- Use centralized logger for all logging