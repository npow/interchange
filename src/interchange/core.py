"""Interchange: main entry point."""
from __future__ import annotations

import uuid
from typing import Any

from .models import InterchangeResult, Role, RouteConstraints, WorldState
from .orchestrator import Orchestrator
from .router import Router
from .state import MemoryBackend, SQLiteBackend, StateManager
from .tools import DEFAULT_TOOLS, ToolRegistry
from .translator import ContextTranslator

_DEFAULT_ROLES: dict[str, Role] = {
    "planner": Role(
        preferred_model="claude-opus-4-6",
        fallback_model="gpt-4o",
        capabilities=["plan", "design", "architect", "strategy", "decompose"],
    ),
    "coder": Role(
        preferred_model="gpt-4o",
        fallback_model="claude-sonnet-4-6",
        capabilities=["implement", "code", "write", "build", "fix", "test", "debug"],
    ),
    "reviewer": Role(
        preferred_model="claude-sonnet-4-6",
        fallback_model="gpt-4o-mini",
        capabilities=["review", "check", "audit", "verify", "validate"],
    ),
    "researcher": Role(
        preferred_model="gemini-2.0-flash",
        fallback_model="claude-sonnet-4-6",
        capabilities=["research", "find", "search", "analyze", "summarize"],
    ),
}


class Interchange:
    """Stateful, role-aware multi-model agent orchestrator.

    Usage::

        ix = Interchange(
            roles={
                "planner": Role(preferred_model="claude-opus-4-6", fallback_model="gpt-4o"),
                "coder":   Role(preferred_model="gpt-4o", fallback_model="claude-sonnet-4-6"),
            }
        )
        result = await ix.run("Implement a user auth module")
        print(result.output)

    """

    def __init__(
        self,
        roles: dict[str, Role] | None = None,
        tools: ToolRegistry | None = None,
        state_backend: str = "memory",
        state_path: str = "~/.interchange/state.db",
        planner_role: str = "planner",
    ) -> None:
        """
        Args:
            roles: Role registry mapping role name -> Role. Defaults to a
                   planner/coder/reviewer/researcher set.
            tools: ToolRegistry to expose to agents. Defaults to bash/read_file/write_file.
            state_backend: ``"memory"``, ``"sqlite"``. Defaults to ``"memory"``.
            state_path: Path for the SQLite database (ignored for memory backend).
            planner_role: Name of the role used for task decomposition.
        """
        self._roles = roles or dict(_DEFAULT_ROLES)
        self._tools = tools or DEFAULT_TOOLS

        backend = (
            SQLiteBackend(state_path)
            if state_backend == "sqlite"
            else MemoryBackend()
        )
        self._sm = StateManager(backend)
        self._router = Router(self._roles)
        self._translator = ContextTranslator()
        self._orchestrator = Orchestrator(
            roles=self._roles,
            state_manager=self._sm,
            tool_registry=self._tools,
            router=self._router,
            translator=self._translator,
            planner_role=planner_role,
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def run(
        self,
        task: str,
        constraints: RouteConstraints | None = None,
        task_id: str | None = None,
    ) -> InterchangeResult:
        """Decompose and execute a task, routing each subtask to the best model.

        Args:
            task: Natural-language description of the work to be done.
            constraints: Optional routing constraints (cost, latency, etc.).
            task_id: Optional stable ID for this run. Auto-generated if omitted.

        Returns:
            An InterchangeResult with output, task graph, batons, and tool calls.
        """
        tid = task_id or str(uuid.uuid4())
        state = self._sm.create(tid, task)
        return await self._orchestrator.run(state, constraints)

    async def run_as(
        self,
        role: str,
        task: str,
        baton: Any | None = None,
        model_override: str | None = None,
        constraints: RouteConstraints | None = None,
        task_id: str | None = None,
    ) -> InterchangeResult:
        """Execute a single-step task with an explicit role (no decomposition).

        Args:
            role: Role name to use (must be in the registry).
            task: The task description.
            baton: Optional incoming Baton from a prior agent turn.
            model_override: If set, use this model instead of the role's default.
            constraints: Optional routing constraints.
            task_id: Optional stable ID.
        """
        from .models import TaskNode
        from .orchestrator import _check_cycles

        if role not in self._roles:
            raise ValueError(
                f"Role {role!r} not registered. Available: {list(self._roles)}"
            )

        tid = task_id or str(uuid.uuid4())
        state = self._sm.create(tid, task)

        node = TaskNode(id="step_1", description=task, role=role)
        if baton:
            node.baton_in = baton
        state.task_nodes["step_1"] = node
        self._sm.save(state)

        effective_constraints = constraints or RouteConstraints()
        if model_override:
            effective_constraints = RouteConstraints(
                disallowed_models=[
                    m
                    for m in [
                        self._roles[role].preferred_model,
                        self._roles[role].fallback_model,
                    ]
                    if m != model_override
                ]
            )

        return await self._orchestrator.run(state, effective_constraints, force_role=role)

    def resume(self, task_id: str) -> "ResumeHandle":
        """Return a handle for resuming an existing task.

        Usage::

            handle = ix.resume("abc-123")
            result = await handle.run()
        """
        return ResumeHandle(task_id, self._sm, self._orchestrator)

    @property
    def state(self) -> StateManager:
        """Direct access to the StateManager for inspection."""
        return self._sm


class ResumeHandle:
    """Returned by ``Interchange.resume()`` to continue an interrupted task."""

    def __init__(
        self, task_id: str, sm: StateManager, orchestrator: Orchestrator
    ) -> None:
        self._task_id = task_id
        self._sm = sm
        self._orchestrator = orchestrator

    async def run(
        self, constraints: RouteConstraints | None = None
    ) -> InterchangeResult:
        """Resume and complete the task."""
        state = self._sm.get(self._task_id)
        return await self._orchestrator.run(state, constraints)
