# 📐 Project Rules

All agents **must** follow the rules defined in this document. Violations will result in rejected changes.

---

## 1. Language & Reference Requirements

- **JavaScript Only:** All source code in this project must be written in **JavaScript**.
- **Wiki-First Workflow:** Always refer to the wiki and its `subMDs` **before** implementing or modifying any code.
  - It is a **strict requirement** to read and analyze the relevant sections of the wiki and sub-wikis **BEFORE** writing or modifying any code.

---

## 2. Critical Architectural Constraints

These constraints are fundamental to the project's architecture. Violating them causes critical bugs such as state desynchronization.

| Constraint | Description |
|------------|-------------|
| **No Direct Instantiation** | Only the root controller (`WorldStateController`) uses constructor-based creation. All other controllers are dependency-injected. |
| **One-Way Flow** | State flows top-to-bottom through the hierarchy. Sub-controllers never push state upward. |
| **Single Source of Truth** | Use injected controllers for data access. Never access another controller's internal state directly. |
| **Public API Only** | Use the root controller's public methods (e.g., `spawnEntity`, `despawnEntity`, `moveEntity`, `getRoomUidByLogicalId`). Never access sub-controllers directly. |
| **Centralized Logging** | Use the centralized `Logger` utility (`src/utils/Logger.js`). Never use `console.log`, `console.warn`, or `console.error` in controllers. |
| **Defensive Copying** | State controllers must return deep copies from public getters to prevent external mutation of internal state. |

**Special Notice:** The [Controller Patterns Guide](subMDs/controller_patterns.md) is **obligatory**. All controllers must be implemented using the specified Dependency Injection patterns to prevent critical state desynchronization.

---

## 3. Server API Access

The server entry point (`src/server.js`) **must** use `WorldStateController` public API methods instead of directly accessing sub-controllers:

- `spawnEntity()` — not direct access to `stateEntityController`
- `despawnEntity()` — not direct access to `stateEntityController`
- `moveEntity()` — not direct access to `stateEntityController`
- `getRoomUidByLogicalId()` — not direct access to `RoomsController`

Reference: [Controller Patterns Guide](subMDs/controller_patterns.md) Section 5.1.

---

## 4. Middleware Architecture

The project employs a two-flow middleware architecture:

| Flow | Path |
|------|------|
| **LLM Interaction** | `Client` → `Server` → `LLMController` → `LLM Backend` |
| **World State Management** | `Client` → `Server` → `WorldStateController` → `SubControllers` |

---

## 5. Data Loading Standard

All **state controllers** (controllers that store raw data, per [Controller Patterns](subMDs/controller_patterns.md) Section 4) **must** use `DataLoader.loadJsonSafe()` to load JSON data files from the `data/` directory.

**Prohibited:** Direct use of `fs.readFileSync()` or `require()` for data loading in controllers.

### 5.1. Purpose

Every state controller loads its data through a single, safe path: `DataLoader.loadJsonSafe()` supplies a fallback when a file is missing or unreadable, and the controller validates what it loaded before trusting it. The goal is one consistent, defensive way for every controller to bootstrap its data instead of each controller reinventing file I/O.

### 5.2. Rules

1. Always use `DataLoader.loadJsonSafe(filePath, fallback)` — never use `require()` or `fs.readFileSync()` directly in controllers
2. Always provide a fallback value (e.g., `{}` or `[]`) as the second argument
3. Always validate loaded data via a `_validate*()` method before processing
4. Always log initialization count via `Logger.info()`
5. Validation method names must be specific to the controller's data type (e.g., `_validateRoomDefinitions()`, `_validateComponentDefinitions()`)

---

## 6. Validation Pattern

All state controllers **must** implement a `_validate*()` method that:

- Throws `TypeError` for invalid or malformed data
- Runs **before** initialization proceeds
- Prevents corrupted data from entering the internal state

This aligns with [Code Quality Standards](code_quality_and_best_practices.md) Section 3.2: all external data must pass schema validation.

---

## 7. Map Maintenance

The architecture maps must be kept up-to-date whenever the system structure changes:

- [Controller Relationship Map](map.md) — high-level map
- [System Architecture Map](subMDs/system_map.md) — deep-detailed version

---

## 8. Wiki Writing Standards ("Why" over "How")

The wiki documents **why** design decisions were made, not **how** code works. The code itself explains the "how" through JSDoc comments, method names, and structure.

### 8.1. Prohibited Wiki Content

| Rule | Description |
|------|-------------|
| No code snippets | The code IS the implementation documentation. Never duplicate code logic in wiki |
| No JSON schemas | Data file structures are self-evident from reading the JSON |
| No method-by-method explanations | Method names and JSDoc explain themselves |
| No step-by-step processing flow | Describe purpose, not iteration order |
| No API endpoint tables | API contracts belong in code comments or OpenAPI specs |
| No calculation formulas | The math is self-evident from code |

### 8.2. Required Wiki Content

The wiki must document:
- Design decisions and their rationale
- Why a pattern was chosen over alternatives
- Why data structures exist (purpose, not shape)
- Why systems are decoupled and how they interact at a conceptual level
- Why certain constraints are enforced (e.g., no direct instantiation)

### 8.3. Self-Check Before Writing Wiki

Before adding wiki content, verify:
- [ ] Does this explain WHY, or does it explain HOW? (Must be WHY)
- [ ] Could a developer understand this from reading the code instead? (If yes, remove from wiki)
- [ ] Is there a code snippet that should be removed? (Code IS the documentation)
- [ ] Am I documenting intent, or am I documenting implementation?

---

## 9. Summary Checklist for Agents

Before writing or modifying any code:

- [ ] Read the relevant wiki sections (this file, [CORE.md](CORE.md), [subMDs/*](subMDs/))
- [ ] Verify architectural constraints are respected (Section 2)
- [ ] Use public API methods, not direct sub-controller access (Sections 2 & 3)
- [ ] Use `DataLoader.loadJsonSafe()` for data loading (Section 5)
- [ ] Implement validation via `_validate*()` methods (Section 6)
- [ ] Use centralized `Logger`, never `console.*` (Section 2)
- [ ] Update architecture maps if structure changed (Section 7)