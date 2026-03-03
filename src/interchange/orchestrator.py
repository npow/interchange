"""Orchestrator: task decomposition, graph management, and agent dispatch loop."""
from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from datetime import datetime
from typing import Any

import litellm

from .exceptions import CyclicDependencyError
from .models import (
    Baton,
    InterchangeResult,
    Role,
    RouteConstraints,
    TaskNode,
    ToolCall,
    WorldState,
)
from .router import Router
from .state import StateManager
from .tools import ToolRegistry
from .translator import ContextTranslator

# Max tool-call iterations per agent turn to prevent infinite loops
_MAX_TOOL_ITERATIONS = 20

# System prompt for task decomposition
_DECOMPOSE_SYSTEM = """\
You are a task planner. Decompose the given task into sequential or parallel subtasks.
Each subtask must be assigned to exactly one role from the available roles list.

Return ONLY a JSON array (no other text) with this structure:
[
  {
    "id": "step_1",
    "description": "What this subtask does",
    "role": "one of the available roles",
    "depends_on": []
  }
]

Rules:
- Use short IDs like "step_1", "step_2", etc.
- depends_on lists IDs that must complete before this node starts.
- Keep it to the minimum number of steps needed.
- If the task can be done in one step, return a single-element array.
"""


class Orchestrator:
    """Decomposes tasks into a graph of TaskNodes and dispatches them to agents.

    Each node is executed by the model chosen by the Router for its assigned role.
    Tool calls are intercepted, normalised, and recorded in WorldState. On
    completion, each agent writes a Baton that is validated and applied to state.
    """

    def __init__(
        self,
        roles: dict[str, Role],
        state_manager: StateManager,
        tool_registry: ToolRegistry,
        router: Router,
        translator: ContextTranslator,
        planner_role: str = "planner",
    ) -> None:
        self._roles = roles
        self._sm = state_manager
        self._tools = tool_registry
        self._router = router
        self._translator = translator
        self._planner_role = planner_role

    async def run(
        self,
        state: WorldState,
        constraints: RouteConstraints | None = None,
        force_role: str | None = None,
    ) -> InterchangeResult:
        """Execute the full orchestration loop for a WorldState.

        If the WorldState has no task_nodes yet, decomposes the task first.
        """
        constraints = constraints or RouteConstraints()
        start_ms = int(time.time() * 1000)
        total_tokens = 0

        # --- Decompose if needed ----------------------------------------
        if not state.task_nodes:
            nodes = await self._decompose(state, constraints)
            if not nodes:
                nodes = [
                    TaskNode(
                        id="step_1",
                        description=state.original_task,
                        role=force_role or self._planner_role,
                    )
                ]
            _check_cycles(nodes)
            for node in nodes:
                state.task_nodes[node.id] = node
            self._sm.save(state)

        # --- Dispatch loop -----------------------------------------------
        while True:
            ready = _get_ready_nodes(state)
            if not ready:
                break

            results = await asyncio.gather(
                *[
                    self._execute_node(state, node, constraints, force_role)
                    for node in ready
                ],
                return_exceptions=True,
            )

            for node, result in zip(ready, results):
                if isinstance(result, Exception):
                    node.status = "failed"
                    self._sm.save(state)

            total_tokens += sum(
                r for r in results if isinstance(r, int)
            )

            # Check for failures
            failed = [n for n in state.task_nodes.values() if n.status == "failed"]
            if failed:
                state.status = "failed"
                self._sm.save(state)
                break

            if all(n.status in ("completed", "skipped") for n in state.task_nodes.values()):
                state.status = "completed"
                self._sm.save(state)
                break

        # --- Assemble result --------------------------------------------
        output = self._collect_output(state)
        wall_time_ms = int(time.time() * 1000) - start_ms

        return InterchangeResult(
            task_id=state.task_id,
            output=output,
            status=state.status,  # type: ignore[arg-type]
            task_nodes=list(state.task_nodes.values()),
            batons=list(state.batons),
            tool_calls=list(state.tool_call_history),
            total_tokens=total_tokens,
            wall_time_ms=wall_time_ms,
        )

    # ------------------------------------------------------------------
    # Private: decomposition
    # ------------------------------------------------------------------

    async def _decompose(
        self, state: WorldState, constraints: RouteConstraints
    ) -> list[TaskNode]:
        """Ask the planner model to decompose state.original_task into TaskNodes."""
        decision = self._router.route(
            state.original_task, constraints, force_role=self._planner_role
        )
        role_names = list(self._roles.keys())

        response = await litellm.acompletion(
            model=decision.model,
            messages=[
                {
                    "role": "system",
                    "content": _DECOMPOSE_SYSTEM
                    + f"\n\nAvailable roles: {role_names}",
                },
                {"role": "user", "content": state.original_task},
            ],
        )
        content = response.choices[0].message.content or ""
        return _parse_task_nodes(content, role_names)

    # ------------------------------------------------------------------
    # Private: node execution
    # ------------------------------------------------------------------

    async def _execute_node(
        self,
        state: WorldState,
        node: TaskNode,
        constraints: RouteConstraints,
        force_role: str | None,
    ) -> int:
        """Execute a single TaskNode. Returns tokens used."""
        decision = self._router.route(
            node.description, constraints, force_role=force_role or None
        )
        node.assigned_model = decision.model
        node.status = "in_progress"
        node.started_at = datetime.utcnow()
        self._sm.save(state)

        # Use pre-set baton_in (e.g. from run_as) or find from completed dependency
        baton_in = node.baton_in or _get_incoming_baton(state, node)
        node.baton_in = baton_in

        system_prompt = self._translator.render_system_prompt(
            state, baton_in, node.role
        )
        tools_schema = self._tools.to_litellm()

        output, tokens = await self._agent_loop(
            model=decision.model,
            task=node.description,
            system_prompt=system_prompt,
            tools_schema=tools_schema,
            state=state,
            node=node,
        )

        # Build and apply baton
        baton = self._build_baton(output, state, node, decision.model)
        self._sm.apply_baton(state, baton)

        return tokens

    async def _agent_loop(
        self,
        model: str,
        task: str,
        system_prompt: str,
        tools_schema: list[dict[str, Any]],
        state: WorldState,
        node: TaskNode,
    ) -> tuple[str, int]:
        """Run the tool-use loop for one agent turn.

        Returns (final_text_output, total_tokens).
        """
        messages: list[dict[str, Any]] = [{"role": "user", "content": task}]
        total_tokens = 0

        for _ in range(_MAX_TOOL_ITERATIONS):
            kwargs: dict[str, Any] = {
                "model": model,
                "messages": [{"role": "system", "content": system_prompt}] + messages,
            }
            if tools_schema:
                kwargs["tools"] = tools_schema

            response = await litellm.acompletion(**kwargs)
            total_tokens += getattr(getattr(response, "usage", None), "total_tokens", 0) or 0

            msg = response.choices[0].message
            # Append assistant message (serialise to dict for history)
            messages.append(_message_to_dict(msg))

            tool_calls = getattr(msg, "tool_calls", None) or []
            if not tool_calls:
                # Agent is done — return its text content
                return (msg.content or ""), total_tokens

            # Execute tool calls
            for tc in tool_calls:
                fn = tc.function
                try:
                    inputs = json.loads(fn.arguments) if fn.arguments else {}
                    result = await self._tools.execute(fn.name, inputs)
                    error = None
                except Exception as exc:
                    result = f"ERROR: {exc}"
                    error = str(exc)

                # Record normalised ToolCall in WorldState
                canonical = ToolCall(
                    name=fn.name,
                    inputs=inputs if "inputs" in dir() else {},
                    result=result,
                    error=error,
                    role=node.role,
                    model=model,
                    task_node_id=node.id,
                )
                self._sm.record_tool_call(state, canonical)

                # Append tool result to message history
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result,
                })

        # Exceeded max iterations — return whatever we have
        last_content = next(
            (m.get("content", "") for m in reversed(messages) if m.get("role") == "assistant"),
            "Max tool iterations reached.",
        )
        return last_content or "Max tool iterations reached.", total_tokens

    # ------------------------------------------------------------------
    # Private: baton construction
    # ------------------------------------------------------------------

    def _build_baton(
        self,
        output: str,
        state: WorldState,
        node: TaskNode,
        model: str,
    ) -> Baton:
        """Parse baton JSON from agent output; fall back to a minimal baton."""
        data = self._translator.parse_baton_from_output(output)

        # Determine the next role (first pending dependency-free node after this one)
        next_role = self._get_next_role(state, node)

        if data:
            return Baton(
                task_id=state.task_id,
                task_node_id=node.id,
                from_role=node.role,
                from_model=model,
                to_role=next_role,
                facts=data.get("facts") or {},
                tool_calls_summary=data.get("tool_calls_summary") or [],
                open_questions=data.get("open_questions") or [],
                recommendation=data.get("recommendation") or "",
                status=data.get("status") or "complete",
            )

        # Fallback: minimal baton with no facts
        return Baton(
            task_id=state.task_id,
            task_node_id=node.id,
            from_role=node.role,
            from_model=model,
            to_role=next_role,
            facts={},
            tool_calls_summary=[f"Completed: {node.description[:100]}"],
            open_questions=[],
            recommendation=output[:200] if output else "No recommendation.",
            status="complete",
        )

    def _get_next_role(self, state: WorldState, current_node: TaskNode) -> str:
        """Find the role of the first pending node that depends on current_node."""
        for node in state.task_nodes.values():
            if current_node.id in node.depends_on and node.status == "pending":
                return node.role
        return current_node.role  # self if no downstream

    # ------------------------------------------------------------------
    # Private: result assembly
    # ------------------------------------------------------------------

    @staticmethod
    def _collect_output(state: WorldState) -> str:
        """Collect the final output from the last completed baton."""
        if not state.batons:
            return ""
        last = state.batons[-1]
        parts = []
        if last.recommendation:
            parts.append(last.recommendation)
        if last.facts:
            parts.append(
                "Facts established:\n"
                + "\n".join(f"  {k}: {v}" for k, v in last.facts.items())
            )
        return "\n\n".join(parts) if parts else ""


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------


def _check_cycles(nodes: list[TaskNode]) -> None:
    """Raise CyclicDependencyError if the dependency graph has a cycle."""
    graph: dict[str, list[str]] = {n.id: list(n.depends_on) for n in nodes}
    visited: set[str] = set()
    rec_stack: set[str] = set()

    def dfs(node_id: str, path: list[str]) -> None:
        visited.add(node_id)
        rec_stack.add(node_id)
        for dep in graph.get(node_id, []):
            if dep not in visited:
                dfs(dep, path + [dep])
            elif dep in rec_stack:
                raise CyclicDependencyError(path + [dep])
        rec_stack.discard(node_id)

    for node_id in graph:
        if node_id not in visited:
            dfs(node_id, [node_id])


def _get_ready_nodes(state: WorldState) -> list[TaskNode]:
    """Return nodes that are pending and have all dependencies completed."""
    completed_ids = {
        nid for nid, n in state.task_nodes.items() if n.status == "completed"
    }
    return [
        n
        for n in state.task_nodes.values()
        if n.status == "pending" and all(dep in completed_ids for dep in n.depends_on)
    ]


def _get_incoming_baton(state: WorldState, node: TaskNode) -> Baton | None:
    """Return the most recent baton_out from a completed dependency, if any."""
    for dep_id in reversed(node.depends_on):
        dep = state.task_nodes.get(dep_id)
        if dep and dep.baton_out:
            return dep.baton_out
    return None


def _parse_task_nodes(content: str, valid_roles: list[str]) -> list[TaskNode]:
    """Parse a JSON array from the planner's decomposition response."""
    # Try direct JSON parse
    try:
        data = json.loads(content.strip())
    except json.JSONDecodeError:
        # Extract first [...] block
        match = re.search(r"\[.*\]", content, re.DOTALL)
        if not match:
            return []
        try:
            data = json.loads(match.group())
        except json.JSONDecodeError:
            return []

    if not isinstance(data, list):
        return []

    nodes = []
    for item in data:
        if not isinstance(item, dict):
            continue
        role = item.get("role", valid_roles[0] if valid_roles else "planner")
        if role not in valid_roles and valid_roles:
            role = valid_roles[0]
        nodes.append(
            TaskNode(
                id=item.get("id") or f"step_{len(nodes) + 1}",
                description=item.get("description") or "",
                role=role,
                depends_on=item.get("depends_on") or [],
            )
        )
    return nodes


def _message_to_dict(msg: Any) -> dict[str, Any]:
    """Convert a LiteLLM message object to a plain dict for the messages list."""
    d: dict[str, Any] = {"role": msg.role, "content": msg.content or ""}
    tool_calls = getattr(msg, "tool_calls", None)
    if tool_calls:
        d["tool_calls"] = [
            {
                "id": tc.id,
                "type": "function",
                "function": {
                    "name": tc.function.name,
                    "arguments": tc.function.arguments,
                },
            }
            for tc in tool_calls
        ]
    return d
