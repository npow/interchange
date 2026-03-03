# @npow/interchange-core

[![npm](https://img.shields.io/npm/v/@npow/interchange-core)](https://www.npmjs.com/package/@npow/interchange-core)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](../../LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-22+-blue.svg)](https://nodejs.org/)

Canonical types, format adapters, and state management for multi-model agent interchange.

This is the library half of the [interchange](https://github.com/npow/interchange) project. Use it to build your own agent pipelines that translate between model formats and carry structured state across handoffs.

## Install

```bash
npm install @npow/interchange-core
```

## What's included

| Module | What it does |
|---|---|
| **Types** | TypeScript interfaces for Claude records, Codex rollout items, hook events, and the baton/task-graph handoff protocol |
| **Adapters** | Translate Claude Code JSONL records → OpenAI Responses API (`CodexRolloutItem[]`) |
| **State management** | `StateManager` + pluggable backends (memory, JSON file) for persisting `WorldState` across agent handoffs |
| **Exceptions** | Typed error classes (`FactConflictError`, `RoutingError`, `BatonValidationError`, …) |
| **ID helpers** | Deterministic `itemId` / `callId` generators |

## Usage

### Translate a Claude record to Codex format

```typescript
import { translateRecord } from "@npow/interchange-core";

const result = translateRecord(claudeRecord);
// result.records — CodexRolloutItem[]
// result.dropped — items that couldn't be translated (thinking blocks, MCP tools, etc.)
```

### Manage task state across agent handoffs

```typescript
import {
  StateManager,
  MemoryBackend,
  JSONFileBackend,
  makeTaskNode,
  makeBaton,
} from "@npow/interchange-core";

// In-memory (testing / ephemeral pipelines)
const state = new StateManager(new MemoryBackend());

// Persistent (production pipelines)
const state = new StateManager(new JSONFileBackend("~/.interchange/state.json"));

// Create a task
const world = state.create("task-1", "Refactor the auth module");

// Add a task node
const node = makeTaskNode("node-1", "Review existing code", "reviewer");
world.taskNodes[node.id] = node;
state.save(world);

// Hand off between agents — apply a baton written by the outgoing agent
const baton = makeBaton({
  taskId: "task-1",
  taskNodeId: "node-1",
  fromRole: "reviewer",
  fromModel: "claude-opus-4-6",
  toRole: "coder",
  facts: { authLibrary: "jose", jwtAlgorithm: "RS256" },
  openQuestions: [],
  recommendation: "Use the existing jose wrapper in src/auth/jwt.ts",
  status: "complete",
});
state.applyBaton(world, baton);
```

### Use the types directly

```typescript
import type {
  ClaudeRecord,
  Baton,
  WorldState,
  TaskNode,
  HookEvent,
} from "@npow/interchange-core";
```

## The baton protocol

A `Baton` is a typed handoff document written by an outgoing agent and read by the incoming agent. It carries:

- **`facts`** — structured key/value pairs merged into `WorldState` (conflicts throw `FactConflictError`)
- **`decisions`** — what was decided and why (the next agent should not re-litigate these)
- **`triedAndRejected`** — approaches that didn't work
- **`openQuestions`** / **`nextSteps`** — forward guidance
- **`recommendation`** — plain-language summary for the next agent
- **`status`** — `"complete"` | `"partial"` | `"blocked"`

## API reference

### `translateRecord(record: ClaudeRecord): TranslationResult`

Converts a single Claude Code JSONL record to `CodexRolloutItem[]`. Thinking blocks, MCP tool calls, and unknown tool types are collected in `result.dropped`.

### `StateManager`

| Method | Description |
|---|---|
| `create(taskId, originalTask)` | Initialize a new `WorldState` |
| `get(taskId)` | Load an existing state (throws `TaskNotFoundError` if missing) |
| `save(state)` | Persist state, incrementing `version` |
| `applyBaton(state, baton)` | Validate and merge a baton into state |
| `recordToolCall(state, call)` | Append a tool call to history |
| `listTasks()` | Return all known task IDs |

### Backends

| Class | Description |
|---|---|
| `MemoryBackend` | In-process map — no persistence, ideal for tests |
| `JSONFileBackend` | Reads/writes a JSON file at the given path |

Implement `StateBackend` to plug in your own storage (Redis, SQLite, etc.).

## License

[Apache 2.0](../../LICENSE)
