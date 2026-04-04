# Core Wiki

This wiki is specifically designed for AI agents. 

### ⚠️ Mandatory Requirement for AI Agents
All AI agents working on this project **must** use this wiki and its `subMDs` as the **single source of truth** for all code implementations. 

**It is a strict requirement to read and analyze the relevant sections of the wiki and sub-wikis BEFORE writing or modifying any code.**

## Table of Contents
- [About the Project](#)
- [LLM Integration](subMDs/llm_integration.md)

## Sub-Documentation
- [Code Quality and Best Practices](code_quality_and_best_practices.md)
- [LLM Integration](subMDs/llm_integration.md)
- Check the `subMDs` folder for more detailed guides.

### 📢 Note for Future Agents
When implementing or modifying any feature that requires the use of a Large Language Model, you **must** use the `LLMController` located in `src/controllers/LLMController.js`. Do not implement new HTTP calls to the LLM directly in other controllers; instead, extend or utilize the `LLMController` to maintain a single source of truth for LLM communication.
