# Spec: Relay
**Status:** Draft
**Date:** 2026-03-03
**Author:** Claude

## Problem Statement

Multi-model agent systems today break down at model boundaries. When a task moves from one AI model to another — say, from Claude (planning) to GPT-4o (coding) — the receiving model gets a raw message transcript it didn't participate in, tool call history in a foreign format it may not parse correctly, and no structured understanding of what facts have been established. The result is hallucination spikes at handoff points, context bloat as prior exchanges accumulate, and tool call schemas that silently mismatch. Existing frameworks (mcp-agent, LiteLLM, RouteLLM) solve pieces of this — API normalization, routing heuristics, agent orchestration — but none address the handoff boundary itself: the moment one model yields control to another. Relay is a Python library that wraps that boundary with a typed handoff protocol, a canonical world state store, and a context translation layer so that agents can be swapped between Claude, OpenAI, Gemini, and local models without losing coherence.

## Goals

- Cross-model handoff success rate >95% with no fact loss or tool history corruption, measured over 100 end-to-end task runs across at least 3 model pairs
- Context translation adds <200ms of overhead per handoff vs. a direct API call to the same model
- Routing accuracy >80% on first attempt (correct role assigned without retry), measured against a labeled 50-task benchmark
- World state size grows sub-linearly with task length: <10% of raw message history size at the same task depth
- Zero tool call schema errors when routing across any supported model pair (Anthropic ↔ OpenAI ↔ Gemini) in integration tests

## Non-Goals

- Building a new agent execution runtime — Relay wraps existing model APIs via LiteLLM; it does not replace them
- Training or fine-tuning router models — routing uses embedding similarity and rule-based classification only in v1
- Streaming responses across model boundaries — handoffs are synchronous checkpoints; streaming within a single agent turn is out of scope
- Multi-user session isolation or auth — Relay is a single-tenant library for a single orchestration process
- Visual DAG editors or workflow UIs — the interface is Python code only

## Background and Context

The "disconnected models problem" is well-documented in 2025 multi-agent literature: when agents built on different base models collaborate, the receiving model gets context it didn't generate and interprets it unreliably. Existing approaches fall into three camps. **API unification layers** (LiteLLM) normalize request/response formats across providers but do not address the semantic gap at handoff. **Orchestration frameworks** (mcp-agent, LangGraph) manage agent lifecycles and tool routing but pass raw message history across model boundaries, causing context bloat and hallucination. **Routing systems** (RouteLLM) intelligently select models per query but were designed for single-agent, stateless scenarios and do not model agent roles or inter-agent dependencies.

Relay synthesizes these into a coherent layer: LiteLLM handles format normalization, a structured WorldState replaces raw message history as the canonical truth, and a typed Baton object carries the handoff at model boundaries. The Baton pattern is borrowed from relay racing — the passing runner writes a structured summary of what they accomplished and what the receiver needs to know, rather than handing over an unstructured stream.

The MasRouter paper (ACL 2025) formally defines the Multi-Agent System Routing (MASR) problem — integrating collaboration mode, role allocation, and model selection — and demonstrates that role-aware routing significantly outperforms query-level routing in multi-step tasks. Relay implements a production-grade version of this for Python.

## Design

### API / Interface

```python
from relay import Relay, Role, ToolRegistry
from relay.tools import bash, read_file, write_file

# 1. Define the role registry — what roles exist and which models serve them
relay = Relay(
    roles={
        "planner":    Role(preferred="claude-opus-4-6",    fallback="gpt-4o"),
        "coder":      Role(preferred="gpt-4o",             fallback="claude-sonnet-4-6"),
        "reviewer":   Role(preferred="claude-sonnet-4-6",  fallback="gpt-4o-mini"),
        "researcher": Role(preferred="gemini-2.0-pro",     fallback="claude-sonnet-4-6"),
    },
    tools=ToolRegistry([bash, read_file, write_file]),
    state_backend="sqlite",          # "sqlite" | "redis" | "memory"
    state_path="~/.relay/state.db",  # ignored for redis/memory
)

# 2. Run a task — Relay decomposes, routes, and orchestrates automatically
result = await relay.run(
    task="Implement and test a user authentication module",
    routing="auto",   # "auto" | "manual" | role name string
)
print(result.output)       # final output
print(result.task_graph)   # what was done and by which model
print(result.batons)       # full handoff trail

# 3. Run a single step with explicit role + optional incoming baton
result = await relay.run_as(
    role="coder",
    task="Write unit tests for auth.py",
    baton=prior_result.batons[-1],   # pass context from prior step; optional
    model_override="claude-sonnet-4-6",  # optional; overrides role default
)

# 4. Inspect or resume world state
state = relay.state.get(task_id="abc123")
relay_resumed = Relay.resume(task_id="abc123", state_backend="sqlite")
```

```python
# Defining a custom tool that works across all models
from relay import tool

@tool(name="run_tests", description="Run the test suite and return results")
def run_tests(path: str, pattern: str = "test_*.py") -> str:
    ...
```

```python
# Routing constraints for cost/latency control
from relay import RouteConstraints

result = await relay.run(
    task="Summarize this document",
    constraints=RouteConstraints(
        max_cost_usd_per_1k_tokens=0.002,   # forces cheaper models
        max_latency_ms=3000,
        prefer_local=False,
    ),
)
```

### Data Model

```python
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

@dataclass
class Baton:
    """Structured handoff written by the outgoing agent, read by the incoming agent.
    Contains facts and state, never raw message history."""
    id: str                              # uuid
    task_id: str
    task_node_id: str
    from_role: str
    from_model: str
    to_role: str                         # who should receive this
    facts: dict[str, Any]               # key facts established — validated against WorldState
    tool_calls_summary: list[str]        # human-readable summary of tools called + outcomes
    open_questions: list[str]            # unresolved items the receiver must address
    recommendation: str                  # outgoing agent's suggested next action (1-2 sentences)
    status: Literal["complete", "partial", "blocked"]
    created_at: datetime


@dataclass
class ToolCall:
    """Canonical, model-agnostic tool call record — source of truth regardless of which
    model's native format was used."""
    id: str                              # relay-assigned, not model-assigned
    name: str
    inputs: dict[str, Any]
    result: str | None
    error: str | None
    model: str                           # e.g. "claude-opus-4-6"
    role: str                            # e.g. "coder"
    task_node_id: str
    timestamp: datetime


@dataclass
class TaskNode:
    id: str
    description: str
    role: str
    status: Literal["pending", "in_progress", "completed", "failed", "skipped"]
    assigned_model: str | None
    depends_on: list[str]                # task_node_ids that must complete first
    baton_in: Baton | None
    baton_out: Baton | None
    started_at: datetime | None
    completed_at: datetime | None


@dataclass
class WorldState:
    """Canonical state maintained independently of any model's message history.
    This is the single source of truth passed between components."""
    task_id: str
    original_task: str
    task_nodes: dict[str, TaskNode]       # node_id -> TaskNode
    facts: dict[str, Any]                 # accumulated established facts
    tool_call_history: list[ToolCall]     # normalized, ordered
    batons: list[Baton]                   # handoff trail in order
    status: Literal["running", "completed", "failed", "paused"]
    created_at: datetime
    updated_at: datetime


@dataclass
class Role:
    preferred_model: str
    fallback_model: str
    capabilities: list[str] = field(default_factory=list)  # e.g. ["code", "plan", "research"]
    allowed_tools: list[str] | None = None  # None means all registered tools


@dataclass
class RouteDecision:
    role: str
    model: str
    confidence: float                     # 0.0-1.0; below 0.5 triggers fallback
    rationale: str                        # human-readable reason for logging


@dataclass
class RouteConstraints:
    max_cost_usd_per_1k_tokens: float | None = None
    max_latency_ms: int | None = None
    prefer_local: bool = False
    disallowed_models: list[str] = field(default_factory=list)


@dataclass
class RelayResult:
    task_id: str
    output: str
    status: Literal["completed", "failed", "partial"]
    task_graph: list[TaskNode]
    batons: list[Baton]
    tool_calls: list[ToolCall]
    total_cost_usd: float
    wall_time_ms: int
```

### Workflow / Sequence

```
Task submitted to relay.run()
         │
         ▼
1.  Orchestrator: decompose task into TaskGraph (LLM-assisted, 1 call to planner role)
2.  State Manager: initialize WorldState, persist to backend
3.  Router: for each ready TaskNode (no pending dependencies):
      a. classify task description → role (embedding similarity vs role capabilities)
      b. apply RouteConstraints → select model from Role.preferred / Role.fallback
      c. emit RouteDecision with confidence score
4.  Context Translator: prepare agent context for selected model
      a. if baton_in present: render baton into model-native system prompt format
      b. render relevant WorldState.facts as structured context block
      c. normalize tool schemas to model's native format (via LiteLLM)
5.  Agent executes on selected model (via LiteLLM)
      a. tool calls intercepted by ToolInterceptor
      b. each tool call normalized → ToolCall record → appended to WorldState
6.  On agent completion:
      a. agent writes Baton (facts, open_questions, recommendation)
      b. State Manager validates Baton.facts against WorldState.facts (no contradictions)
      c. WorldState updated; TaskNode marked complete; baton_out saved
7.  Orchestrator: re-evaluate task graph; unblock downstream TaskNodes
8.  Repeat from step 3 until all TaskNodes complete or one fails
9.  Assemble RelayResult from terminal TaskNode baton_out + WorldState
```

```
┌─────────────────────────────────────────────────┐
│               ORCHESTRATOR                       │
│  decompose → task graph → dispatch loop          │
└──────────────────┬──────────────────────────────┘
                   │  WorldState r/w
┌──────────────────▼──────────────────────────────┐
│              STATE MANAGER                       │
│  WorldState │ TaskGraph │ ToolCall history        │
│  Baton store │ Fact store                        │
│  backend: SQLite (default) │ Redis │ memory      │
└──────────────────┬──────────────────────────────┘
                   │  RouteDecision
┌──────────────────▼──────────────────────────────┐
│                 ROUTER                           │
│  task classifier (embeddings) + role registry   │
│  + RouteConstraints → RouteDecision             │
└──────────────────┬──────────────────────────────┘
                   │  formatted context + tools
┌──────────────────▼──────────────────────────────┐
│           CONTEXT TRANSLATOR                     │
│  Baton renderer │ WorldState formatter           │
│  Tool schema normalizer (via LiteLLM)            │
│  Anthropic ↔ OpenAI ↔ Gemini format adapters    │
└────────────┬─────────────────────┬──────────────┘
             ▼                     ▼
      ┌────────────┐       ┌────────────────┐
      │  Anthropic │       │  OpenAI        │
      │  Adapter   │       │  Adapter       │
      │ (Claude)   │       │ (GPT/o-series) │
      └────────────┘       └────────────────┘
```

### Key Design Decisions

| Decision | Options Considered | Chosen | Rationale |
|---|---|---|---|
| API normalization layer | Build from scratch, LiteLLM, raw provider SDKs | LiteLLM | Already handles 100+ models, actively maintained, battle-tested format conversion; building from scratch is redundant |
| State storage format | Raw message history, structured facts + tool log | Structured WorldState separate from history | Message history grows O(n²) with task depth; structured state stays O(n); prevents context bloat and reduces hallucination at boundaries |
| Handoff mechanism | Raw history dump, LLM-generated summary, typed Baton | Typed Baton with validation | Narrative summaries can be faithful or unfaithful — no way to check. Typed Baton facts are validated against WorldState, making faithfulness verifiable |
| Router classification | Fine-tuned router model, embedding similarity, LLM-based, rule-based | Embedding similarity with rule-based constraints | Embedding similarity is fast (<50ms), needs no fine-tuning, and handles novel task descriptions well; rules handle cost/latency hard constraints that embeddings cannot |
| Tool availability across models | Require identical tools for all models, per-model tool sets, shared registry with adapters | Shared ToolRegistry with per-model schema adapters | Identical tools ensure a receiving agent can always continue prior work; adapter layer handles format differences (Anthropic input block vs OpenAI function schema) |
| Default state backend | Redis, SQLite, in-memory | SQLite | Zero infrastructure; works locally with no setup; Redis available for production multi-process deployments |
| Baton validation | None, schema validation only, semantic validation against WorldState | Semantic validation against WorldState | Schema validation catches format errors but not lies; checking baton facts against accumulated WorldState catches factual contradictions before they propagate |

## Failure Modes

| Failure | Probability | Impact | Mitigation |
|---|---|---|---|
| Baton contains facts contradicting WorldState | Medium | High | State Manager validates all baton facts against WorldState on write; contradictions raise `BatonValidationError` and halt the task node, requiring human or orchestrator review |
| Tool availability asymmetry (prior agent used a tool the receiving model's adapter doesn't support) | Low | High | ToolRegistry enforces at construction time that all registered tools have adapters for all configured models; missing adapters raise at startup, not at runtime |
| Router misclassifies task → wrong role assigned | Medium | Medium | RouteDecision includes confidence score; below 0.5 triggers planner role to explicitly assign roles rather than classifier; logged for routing accuracy metrics |
| Context translator produces malformed tool call history | Low | High | Integration tests assert round-trip translation fidelity for all supported model pairs; any format error raises `TranslationError` before the agent call is made |
| Model API failure mid-task | Medium | Medium | Role fallback_model is tried once automatically; if fallback also fails, TaskNode marked `failed` and WorldState preserved for resume |
| Task graph cycle (A depends on B depends on A) | Low | High | Orchestrator runs topological sort at graph construction time; cycles raise `CyclicDependencyError` before any execution begins |
| WorldState drift across concurrent task nodes | Low | High | State Manager uses optimistic locking (CAS on WorldState.updated_at); concurrent writes to the same fact key serialize; conflicts logged |
| Sending agent omits key facts from Baton | Medium | Medium | Baton template prompts the sending agent to enumerate all facts from the current WorldState; post-write diff identifies facts present in WorldState but absent from Baton, which are auto-appended |
| LiteLLM deprecates a provider adapter | Low | Low | Relay's model adapters are thin wrappers; provider updates require only adapter changes, not core relay changes |

## Success Metrics

- Cross-model handoff success rate: >95% of handoffs complete with no fact loss (facts in baton_out match WorldState facts) over 100 end-to-end test runs spanning at least 3 model pairs
- Context translation: zero tool call schema errors on any supported model pair (Anthropic ↔ OpenAI ↔ Gemini) in CI integration test suite
- Routing accuracy: >80% correct role assignment on first attempt against a labeled 50-task benchmark covering planning, coding, review, and research tasks
- Latency overhead: routing + translation adds <200ms per handoff measured against direct LiteLLM API calls for the same model
- WorldState compactness: WorldState size at task completion is <10% of equivalent raw message history size for tasks with >5 tool calls
- Resumability: 100% of interrupted tasks (simulated by mid-run process kill) resume correctly from SQLite state with no re-execution of completed TaskNodes

## Open Questions

1. Should the Orchestrator's task decomposition step be skippable for single-step tasks, or should all tasks flow through the full graph? Assumed: single-step shortcut path exists. — Owner: TBD, Deadline: before v1 implementation
2. How should conflicting facts be resolved when two concurrent agents write contradictory values to WorldState? Assumed: last-writer-wins with a conflict log entry. — Owner: TBD, Deadline: before v1 implementation
3. Should Baton be model-readable (rendered into the system prompt) or tool-readable (injected as a structured tool result)? Assumed: system prompt for compatibility with models that don't support structured inputs. — Owner: TBD, Deadline: before v1 implementation
4. Is a Python library the right distribution form, or should Relay also expose an MCP server so non-Python orchestrators (e.g. Claude Code itself) can use it? Assumed: Python library for v1, MCP server for v2. — Owner: TBD, Deadline: v2 planning

## Appendix

### Name Rationale
**Relay** captures the core mechanic: like a relay race, each agent runs their leg and passes the baton to the next. The baton is the Baton object — structured, verified, and explicit. The relay station is the State Manager. The race coordinator is the Orchestrator.

### Alternatives Considered

**mcp-agent as foundation:** Rejected for v1 because mcp-agent's orchestrator suffers from context bloat (aggregates raw history forward), hallucinated server names, and lacks a structured handoff protocol. Relay addresses exactly those gaps and can optionally expose an MCP server interface in v2.

**LangGraph as foundation:** Rejected because LangGraph's graph-based state passes only state deltas between nodes rather than a full WorldState, making cross-model context reconstruction fragile. LangGraph's node model also makes role-aware routing awkward — roles would be nodes, not a routing concern.

**RouteLLM as router:** Considered using RouteLLM for the routing layer. Rejected because RouteLLM is effectively unmaintained (last commit August 2024), only routes between two model tiers (strong/weak), and was not designed for role-aware multi-agent routing. Relay's embedding-based classifier is simpler and purpose-built for role selection.

### Component Dependency Map

```
Relay (public API)
  └── Orchestrator
        ├── Router
        │     └── RoleRegistry
        ├── StateManager
        │     └── StorageBackend (SQLite | Redis | Memory)
        ├── ContextTranslator
        │     ├── BatonRenderer
        │     ├── ToolSchemaAdapter (per model)
        │     └── LiteLLM (format normalization)
        └── ToolInterceptor
              └── ToolRegistry
```
