# 📄 Software Engineering Standards and Best Practices

## 1. Design Philosophy
The primary objective is **Maintainability**. The code must be written so that a human or an AI agent, six months from now, can understand the intent and modify the system without causing unforeseen side effects.

### 1.1. Single Responsibility Principle (SRP)
*   Each class, function, or controller must have **one, and only one, reason to change**.
*   If a controller is managing game logic AND text formatting, it must be split into two (e.g., `ActionController` and `StorytellingController`).

### 1.2. Loose Coupling
*   Controllers must not access the internal state (private variables) of other controllers.
*   Communication must be handled via **Interfaces or Public Methods** (APIs).
*   **Prohibited:** Direct modification of another controller's internal variables.

### 1.3. Data-Driven Design
*   Game logic (stats, actions, items) must be decoupled from the engine code.
*   Use configuration files (JSON, YAML) or databases to define content, keeping the code as a generic interpreter of these definitions.

---

## 2. Coding Standards (Clean Code)

### 2.1. Semantic Naming
*   **Variables and Functions:** Must be self-explanatory.
    *   ❌ `func x(a, b)` $\rightarrow$ ✅ `func calculate_damage(attacker, defender)`
    *   ❌ `data_list` $\rightarrow$ ✅ `active_entities_list`
*   **Consistency:** Use `snake_case` for functions/variables and `PascalCase` for classes (or the standard of the chosen language).

### 2.2. Strong Typing and Validation
*   **Type Hinting:** While JavaScript is dynamically typed, use JSDoc for type hinting to ensure clarity (e.g., `/** @param {Entity} entity @param {Vector2D} direction @returns {boolean} */`).
*   **Input Validation:** Never assume that data coming from an LLM or another controller is correct. Validate types, ranges, and formats before processing.

### 2.3. Avoid "Magic Numbers"
*   Never use hard-coded values within the logic.
    *   ❌ `if stamina < 10:` $\rightarrow$ ✅ `if stamina < MIN_STAMINA_THRESHOLD:`
*   Define constants at the top of the file or in a global configuration file.

---

## 3. Robustness and Error Handling

### 3.1. Graceful Degradation (Fail-Safe)
*   The system must not crash due to an error in a non-essential module.
*   Use `try...catch` blocks at critical integration points, especially when dealing with LLM responses.
*   **Error Logging:** Implement a detailed logging system (`INFO`, `WARNING`, `ERROR`, `CRITICAL`) to track runtime failures.

### 3.2. Schema Validation
*   All communication between the LLM and the system must pass through a schema validator (e.g., Pydantic, Zod, or JSON Schema).
*   If the data is incorrect, the system must reject the input and request a correction rather than attempting to process incomplete or malformed data.

---

## 4. Documentation and Maintainability

### 4.1. Documenting "Why", Not "How"
*   The code should be clean enough to explain **how** it works.
*   Comments should explain **why** a certain design decision was made or why a specific "hack" or workaround was necessary.

### 4.2. Internal API Documentation
*   Every public method in a controller must have a docstring detailing:
    *   **Description:** What the function does.
    *   **Arguments:** What it receives and their respective types.
    *   **Return Value:** What it returns and under which conditions.

---

## 5. Quality Assurance (QA)

### 5.1. Unit Testing and Regression
*   Every new feature must be accompanied by a unit test.
*   The Auditor Agent must verify that new code passes existing tests to prevent regression.

### 5.2. Continuous Refactoring
*   If a function becomes too complex (e.g., exceeding 20-30 lines), it must be refactored into smaller, single-purpose functions.
*   Do not ignore **Technical Debt**. Any code written "quickly and dirty" for prototyping must be marked with `TODO: Refactor` and corrected before the final version.

---

## 6. Version Control and State Management

### 6.1. Atomic Commits
*   Each commit must contain only **one** logical change.
*   Commit messages must be clear: `feat: add stamina cost to attack action` or `fix: resolve null pointer in PerceptionController`.

### 6.2. Long-term State Persistence
*   The game state must be fully serializable (capable of being converted to JSON/File) at any moment to ensure reliable Save/Load functionality.

---

**Signed:** *Software Governance Systems - Gemma 4*