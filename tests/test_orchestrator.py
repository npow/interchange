"""Tests for interchange.orchestrator — cycle detection, ready nodes, node parsing."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from interchange.exceptions import CyclicDependencyError
from interchange.models import TaskNode, WorldState
from interchange.orchestrator import (
    Orchestrator,
    _check_cycles,
    _get_incoming_baton,
    _get_ready_nodes,
    _parse_task_nodes,
)
from interchange.router import Router
from interchange.state import StateManager
from interchange.tools import ToolRegistry, ToolSpec
from interchange.translator import ContextTranslator
from tests.conftest import make_llm_response


# ---------------------------------------------------------------------------
# _check_cycles
# ---------------------------------------------------------------------------


class TestCheckCycles:
    def test_no_cycle_passes(self):
        nodes = [
            TaskNode(id="a", description="a", role="coder"),
            TaskNode(id="b", description="b", role="coder", depends_on=["a"]),
            TaskNode(id="c", description="c", role="coder", depends_on=["b"]),
        ]
        _check_cycles(nodes)  # should not raise

    def test_direct_cycle_raises(self):
        nodes = [
            TaskNode(id="a", description="a", role="coder", depends_on=["b"]),
            TaskNode(id="b", description="b", role="coder", depends_on=["a"]),
        ]
        with pytest.raises(CyclicDependencyError):
            _check_cycles(nodes)

    def test_triangle_cycle_raises(self):
        nodes = [
            TaskNode(id="a", description="a", role="coder", depends_on=["c"]),
            TaskNode(id="b", description="b", role="coder", depends_on=["a"]),
            TaskNode(id="c", description="c", role="coder", depends_on=["b"]),
        ]
        with pytest.raises(CyclicDependencyError):
            _check_cycles(nodes)

    def test_disconnected_graph_passes(self):
        nodes = [
            TaskNode(id="a", description="a", role="coder"),
            TaskNode(id="b", description="b", role="coder"),
        ]
        _check_cycles(nodes)

    def test_diamond_dag_passes(self):
        nodes = [
            TaskNode(id="a", description="a", role="coder"),
            TaskNode(id="b", description="b", role="coder", depends_on=["a"]),
            TaskNode(id="c", description="c", role="coder", depends_on=["a"]),
            TaskNode(id="d", description="d", role="coder", depends_on=["b", "c"]),
        ]
        _check_cycles(nodes)  # should not raise


# ---------------------------------------------------------------------------
# _get_ready_nodes
# ---------------------------------------------------------------------------


class TestGetReadyNodes:
    def _make_state(self, nodes: list[TaskNode]) -> WorldState:
        state = WorldState(task_id="t1", original_task="task")
        for n in nodes:
            state.task_nodes[n.id] = n
        return state

    def test_no_deps_all_ready(self):
        state = self._make_state([
            TaskNode(id="a", description="a", role="coder"),
            TaskNode(id="b", description="b", role="coder"),
        ])
        ready = _get_ready_nodes(state)
        assert {n.id for n in ready} == {"a", "b"}

    def test_dep_not_completed_not_ready(self):
        state = self._make_state([
            TaskNode(id="a", description="a", role="coder", status="in_progress"),
            TaskNode(id="b", description="b", role="coder", depends_on=["a"]),
        ])
        ready = _get_ready_nodes(state)
        assert [n.id for n in ready] == []

    def test_dep_completed_unblocks_downstream(self):
        state = self._make_state([
            TaskNode(id="a", description="a", role="coder", status="completed"),
            TaskNode(id="b", description="b", role="coder", depends_on=["a"]),
        ])
        ready = _get_ready_nodes(state)
        assert [n.id for n in ready] == ["b"]

    def test_all_completed_returns_empty(self):
        state = self._make_state([
            TaskNode(id="a", description="a", role="coder", status="completed"),
        ])
        assert _get_ready_nodes(state) == []


# ---------------------------------------------------------------------------
# _parse_task_nodes
# ---------------------------------------------------------------------------


class TestParseTaskNodes:
    def test_parses_valid_json_array(self):
        content = json.dumps([
            {"id": "step_1", "description": "plan", "role": "planner", "depends_on": []},
            {"id": "step_2", "description": "code", "role": "coder", "depends_on": ["step_1"]},
        ])
        nodes = _parse_task_nodes(content, ["planner", "coder"])
        assert len(nodes) == 2
        assert nodes[0].id == "step_1"
        assert nodes[1].depends_on == ["step_1"]

    def test_extracts_json_from_surrounding_text(self):
        content = 'Here is the decomposition:\n[{"id": "s1", "description": "do it", "role": "coder", "depends_on": []}]'
        nodes = _parse_task_nodes(content, ["coder"])
        assert len(nodes) == 1
        assert nodes[0].id == "s1"

    def test_unknown_role_replaced_with_first_valid(self):
        content = json.dumps([
            {"id": "s1", "description": "x", "role": "unknown_role", "depends_on": []}
        ])
        nodes = _parse_task_nodes(content, ["planner", "coder"])
        assert nodes[0].role == "planner"

    def test_returns_empty_for_invalid_json(self):
        nodes = _parse_task_nodes("not json at all", ["coder"])
        assert nodes == []

    def test_returns_empty_for_non_array(self):
        nodes = _parse_task_nodes('{"key": "value"}', ["coder"])
        assert nodes == []

    def test_auto_generates_id_if_missing(self):
        content = json.dumps([
            {"description": "do something", "role": "coder", "depends_on": []}
        ])
        nodes = _parse_task_nodes(content, ["coder"])
        assert len(nodes) == 1
        assert nodes[0].id  # auto-generated


# ---------------------------------------------------------------------------
# _get_incoming_baton
# ---------------------------------------------------------------------------


class TestGetIncomingBaton:
    def test_returns_none_when_no_deps(self, sample_baton):
        state = WorldState(task_id="t1", original_task="x")
        node = TaskNode(id="n1", description="x", role="coder")
        assert _get_incoming_baton(state, node) is None

    def test_returns_baton_from_completed_dep(self, sample_baton):
        state = WorldState(task_id="t1", original_task="x")
        dep = TaskNode(id="step_1", description="plan", role="planner", status="completed")
        dep.baton_out = sample_baton
        state.task_nodes["step_1"] = dep

        node = TaskNode(id="step_2", description="code", role="coder", depends_on=["step_1"])
        assert _get_incoming_baton(state, node) is sample_baton

    def test_returns_none_when_dep_has_no_baton(self):
        state = WorldState(task_id="t1", original_task="x")
        dep = TaskNode(id="step_1", description="plan", role="planner", status="completed")
        state.task_nodes["step_1"] = dep
        node = TaskNode(id="step_2", description="code", role="coder", depends_on=["step_1"])
        assert _get_incoming_baton(state, node) is None


# ---------------------------------------------------------------------------
# Orchestrator integration (mocked LiteLLM)
# ---------------------------------------------------------------------------


@pytest.fixture
def orchestrator(basic_roles, state_manager, tool_registry):
    router = Router(roles=basic_roles)
    translator = ContextTranslator()
    return Orchestrator(
        roles=basic_roles,
        state_manager=state_manager,
        tool_registry=tool_registry,
        router=router,
        translator=translator,
        planner_role="planner",
    )


class TestOrchestratorRun:
    @pytest.mark.asyncio
    async def test_single_node_task(self, orchestrator, state_manager):
        """A task that decomposes to one step completes successfully."""
        decomp_response = make_llm_response(
            json.dumps([{"id": "step_1", "description": "echo hello", "role": "coder", "depends_on": []}])
        )
        baton_json = json.dumps({
            "facts": {"done": True},
            "tool_calls_summary": ["echoed hello"],
            "open_questions": [],
            "recommendation": "all done",
            "status": "complete",
        })
        agent_response = make_llm_response(baton_json)

        state = state_manager.create("t1", "echo hello")

        with patch("litellm.acompletion", new=AsyncMock(side_effect=[decomp_response, agent_response])):
            result = await orchestrator.run(state)

        assert result.status == "completed"
        assert len(result.task_nodes) == 1
        assert len(result.batons) == 1
        assert result.batons[0].facts["done"] is True

    @pytest.mark.asyncio
    async def test_tool_call_is_recorded(self, orchestrator, state_manager):
        """Tool calls made during execution are recorded in WorldState."""
        decomp_response = make_llm_response(
            json.dumps([{"id": "s1", "description": "run bash", "role": "coder", "depends_on": []}])
        )
        tool_call_response = make_llm_response(
            "",
            tool_calls=[{"id": "tc1", "name": "echo", "arguments": '{"text": "hi"}'}],
        )
        baton_response = make_llm_response(
            json.dumps({
                "facts": {},
                "tool_calls_summary": ["called echo"],
                "open_questions": [],
                "recommendation": "done",
                "status": "complete",
            })
        )

        state = state_manager.create("t2", "run bash")
        with patch(
            "litellm.acompletion",
            new=AsyncMock(side_effect=[decomp_response, tool_call_response, baton_response]),
        ):
            result = await orchestrator.run(state)

        assert len(result.tool_calls) >= 1
        assert result.tool_calls[0].name == "echo"

    @pytest.mark.asyncio
    async def test_pre_populated_nodes_skips_decomposition(self, orchestrator, state_manager):
        """If task_nodes already set, decomposition is skipped."""
        state = state_manager.create("t3", "code something")
        node = TaskNode(id="step_1", description="code something", role="coder")
        state.task_nodes["step_1"] = node
        state_manager.save(state)

        baton_response = make_llm_response(
            json.dumps({
                "facts": {"coded": True},
                "tool_calls_summary": [],
                "open_questions": [],
                "recommendation": "done",
                "status": "complete",
            })
        )

        # Only ONE LLM call expected (no decomposition)
        with patch("litellm.acompletion", new=AsyncMock(return_value=baton_response)):
            result = await orchestrator.run(state)

        assert result.status == "completed"
