# agent-subsystems

[![CI](https://github.com/npow/interchange/actions/workflows/ci.yml/badge.svg)](https://github.com/npow/interchange/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/interchange)](https://www.npmjs.com/package/interchange)
[![npm](https://img.shields.io/npm/v/%40npow%2Finterchange-core)](https://www.npmjs.com/package/@npow/interchange-core)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-22+-blue.svg)](https://nodejs.org/)

Route each step of a multi-agent task to the right AI model automatically.

## The problem

When you build a pipeline where research goes to a cheap fast model, code review goes to a powerful one, and planning goes to the most capable — you end up writing the same routing logic, context translation, and state handoff boilerplate every time. There's no standard way to describe a task's cost/capability tradeoff and have a runtime enforce it. Each new workflow is a fresh engineering problem.

## Quick start

```bash
npm install -g interchange

export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...

interchange run "Research recent advances in RAG, then write a concise summary"
```

## Install

```bash
# CLI
npm install -g interchange

# Library (types, adapters, state management)
npm install @npow/interchange-core
```

## Usage

**Run a task — automatically routed to the optimal model**

```bash
interchange run "Refactor the auth module to use JWT"
```

**Force a specific role**

```bash
interchange run-as coder "Add rate limiting to the API"
interchange run-as reviewer "Review the changes in auth.ts"
```

**Resume from a previous handle**

```bash
# Save the handle from a previous run
HANDLE=$(interchange run "Research X" --json | jq -r .handle)
interchange resume "$HANDLE"
```

**Use `@interchange/core` in your own code**

```typescript
import { translateRecord, StateManager, MemoryBackend } from "@npow/interchange-core";

// Translate Claude tool calls to Codex JSONL format
const result = translateRecord(claudeRecord);

// Manage task state across agent handoffs
const state = new StateManager(new MemoryBackend());
const task = await state.create({ taskId: "t1", role: "coder", goal: "Fix the bug" });
```

## How it works

`interchange run` decomposes your task into a DAG of subtasks. Each node is classified by required capability (planning, coding, research, review) and routed to the best available model within optional cost constraints. The **baton protocol** carries structured context — facts, decisions, tool call history — across handoffs as a typed system prompt. State is persisted to `~/.interchange/state.json`.

Built on the [Vercel AI SDK](https://sdk.vercel.ai/) with support for Anthropic, OpenAI, and Google models.

## Configuration

| Env var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Enables Claude models (claude-opus-4-6, claude-sonnet-4-6) |
| `OPENAI_API_KEY` | Enables GPT/o-series models (gpt-4o, o3-mini) |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Enables Gemini models (gemini-2.0-flash) |

Pass `--max-cost <usd-per-1k>` to `run` / `run-as` to cap model selection by cost.

## Development

```bash
git clone https://github.com/npow/interchange
cd agent-subsystems
npm install
npm run build --workspaces
npm test --workspaces
```

Packages:
- `packages/core/` — `@interchange/core`: canonical types, format adapters, state management
- `packages/interchange/` — `interchange`: router, orchestrator, CLI

## License

[Apache 2.0](LICENSE)
