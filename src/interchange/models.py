"""Core data models for interchange.

All models are plain dataclasses — no external dependencies required.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal


def _make_id() -> str:
    return str(uuid.uuid4())


def _utcnow() -> datetime:
    return datetime.utcnow()


@dataclass
class ToolCall:
    """Canonical, model-agnostic tool call record.

    Stored in WorldState regardless of which model's native format was used.
    """

    name: str
    inputs: dict[str, Any]
    role: str
    model: str
    task_node_id: str
    id: str = field(default_factory=_make_id)
    result: str | None = None
    error: str | None = None
    timestamp: datetime = field(default_factory=_utcnow)


@dataclass
class Baton:
    """Typed handoff written by the outgoing agent, read by the incoming agent.

    Contains structured facts — never raw message history. Validated against
    WorldState before being accepted.
    """

    task_id: str
    task_node_id: str
    from_role: str
    from_model: str
    to_role: str
    facts: dict[str, Any]
    open_questions: list[str]
    recommendation: str
    status: Literal["complete", "partial", "blocked"]
    id: str = field(default_factory=_make_id)
    tool_calls_summary: list[str] = field(default_factory=list)
    created_at: datetime = field(default_factory=_utcnow)


@dataclass
class TaskNode:
    """A single unit of work in the task graph."""

    id: str
    description: str
    role: str
    depends_on: list[str] = field(default_factory=list)
    status: Literal["pending", "in_progress", "completed", "failed", "skipped"] = "pending"
    assigned_model: str | None = None
    baton_in: Baton | None = None
    baton_out: Baton | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None


@dataclass
class WorldState:
    """Canonical state maintained independently of any model's message history.

    This is the single source of truth shared across all agents and model
    boundaries. Structured facts replace raw message history, keeping size
    sub-linear with task depth.
    """

    task_id: str
    original_task: str
    task_nodes: dict[str, TaskNode] = field(default_factory=dict)
    facts: dict[str, Any] = field(default_factory=dict)
    tool_call_history: list[ToolCall] = field(default_factory=list)
    batons: list[Baton] = field(default_factory=list)
    status: Literal["running", "completed", "failed", "paused"] = "running"
    created_at: datetime = field(default_factory=_utcnow)
    updated_at: datetime = field(default_factory=_utcnow)
    version: int = 0  # incremented on each save for optimistic locking


@dataclass
class Role:
    """Defines an agent role: preferred model, fallback, and capabilities."""

    preferred_model: str
    fallback_model: str
    capabilities: list[str] = field(default_factory=list)
    allowed_tools: list[str] | None = None  # None means all registered tools


@dataclass
class RouteDecision:
    """The result of a routing decision."""

    role: str
    model: str
    confidence: float  # 0.0–1.0; below 0.5 triggers planner fallback
    rationale: str


@dataclass
class RouteConstraints:
    """Hard constraints applied during routing."""

    max_cost_usd_per_1k_tokens: float | None = None
    max_latency_ms: int | None = None
    prefer_local: bool = False
    disallowed_models: list[str] = field(default_factory=list)


@dataclass
class InterchangeResult:
    """The final result of a completed interchange run."""

    task_id: str
    output: str
    status: Literal["completed", "failed", "partial"]
    task_nodes: list[TaskNode]
    batons: list[Baton]
    tool_calls: list[ToolCall]
    total_tokens: int
    wall_time_ms: int
