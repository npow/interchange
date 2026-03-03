"""Integration tests for the full Interchange pipeline (mocked LiteLLM)."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from interchange import Interchange, Role, RouteConstraints
from tests.conftest import make_llm_response


@pytest.fixture
def ix() -> Interchange:
    return Interchange(
        roles={
            "planner": Role(
                preferred_model="claude-opus-4-6",
                fallback_model="gpt-4o",
                capabilities=["plan", "design"],
            ),
            "coder": Role(
                preferred_model="gpt-4o",
                fallback_model="claude-sonnet-4-6",
                capabilities=["implement", "code", "write"],
            ),
        },
        state_backend="memory",
    )


def _baton_json(**kwargs) -> str:
    defaults = {
        "facts": {},
        "tool_calls_summary": [],
        "open_questions": [],
        "recommendation": "done",
        "status": "complete",
    }
    return json.dumps({**defaults, **kwargs})


class TestInterchangeRun:
    @pytest.mark.asyncio
    async def test_run_single_step(self, ix):
        decomp = make_llm_response(
            json.dumps([{"id": "s1", "description": "do it", "role": "coder", "depends_on": []}])
        )
        agent = make_llm_response(_baton_json(facts={"result": "done"}))

        with patch("litellm.acompletion", new=AsyncMock(side_effect=[decomp, agent])):
            result = await ix.run("implement something")

        assert result.status == "completed"
        assert result.task_id
        assert len(result.task_nodes) == 1

    @pytest.mark.asyncio
    async def test_run_two_step_pipeline(self, ix):
        """Planner → coder pipeline with baton passing."""
        decomp = make_llm_response(
            json.dumps([
                {"id": "s1", "description": "plan", "role": "planner", "depends_on": []},
                {"id": "s2", "description": "code it", "role": "coder", "depends_on": ["s1"]},
            ])
        )
        plan_baton = make_llm_response(
            _baton_json(
                facts={"approach": "microservices"},
                recommendation="Build the service layer next.",
            )
        )
        code_baton = make_llm_response(
            _baton_json(
                facts={"approach": "microservices", "status_code": 200},
                recommendation="All done.",
            )
        )

        with patch("litellm.acompletion", new=AsyncMock(side_effect=[decomp, plan_baton, code_baton])):
            result = await ix.run("plan and implement a service")

        assert result.status == "completed"
        assert len(result.task_nodes) == 2
        assert len(result.batons) == 2
        # Facts from both steps accumulated in world state
        final_facts = {k: v for b in result.batons for k, v in b.facts.items()}
        assert "approach" in final_facts

    @pytest.mark.asyncio
    async def test_run_returns_interchange_result(self, ix):
        from interchange.models import InterchangeResult

        decomp = make_llm_response(
            json.dumps([{"id": "s1", "description": "do it", "role": "coder", "depends_on": []}])
        )
        agent = make_llm_response(_baton_json())

        with patch("litellm.acompletion", new=AsyncMock(side_effect=[decomp, agent])):
            result = await ix.run("do something")

        assert isinstance(result, InterchangeResult)
        assert result.wall_time_ms >= 0
        assert result.total_tokens >= 0

    @pytest.mark.asyncio
    async def test_run_with_stable_task_id(self, ix):
        decomp = make_llm_response(
            json.dumps([{"id": "s1", "description": "task", "role": "coder", "depends_on": []}])
        )
        agent = make_llm_response(_baton_json())

        with patch("litellm.acompletion", new=AsyncMock(side_effect=[decomp, agent])):
            result = await ix.run("task", task_id="my-custom-id")

        assert result.task_id == "my-custom-id"


class TestInterchangeRunAs:
    @pytest.mark.asyncio
    async def test_run_as_skips_decomposition(self, ix):
        """run_as should make exactly one LLM call (no decomposition call)."""
        agent = make_llm_response(_baton_json(facts={"built": True}))

        with patch("litellm.acompletion", new=AsyncMock(return_value=agent)) as mock_llm:
            result = await ix.run_as(role="coder", task="write tests")

        assert result.status == "completed"
        assert mock_llm.call_count == 1

    @pytest.mark.asyncio
    async def test_run_as_unknown_role_raises(self, ix):
        with pytest.raises(ValueError, match="not registered"):
            await ix.run_as(role="unknown", task="do it")

    @pytest.mark.asyncio
    async def test_run_as_passes_baton_context(self, ix, sample_baton):
        """When a baton is passed, the system prompt should contain baton facts."""
        captured_calls = []

        async def capture(*args, **kwargs):
            captured_calls.append(kwargs.get("messages", []))
            return make_llm_response(_baton_json())

        with patch("litellm.acompletion", new=capture):
            await ix.run_as(role="coder", task="implement it", baton=sample_baton)

        # System prompt should mention baton facts
        assert captured_calls
        system_msgs = [
            m for call in captured_calls for m in call if m.get("role") == "system"
        ]
        system_text = " ".join(m["content"] for m in system_msgs)
        assert "REST API" in system_text  # from sample_baton.facts


class TestResume:
    @pytest.mark.asyncio
    async def test_resume_continues_incomplete_task(self, ix):
        """Create a task with a pre-built node, then resume it."""
        from interchange.models import TaskNode

        # Create state with one pending node manually
        state = ix.state.create("resume-task", "continue this")
        node = TaskNode(id="s1", description="continue this", role="coder")
        state.task_nodes["s1"] = node
        ix.state.save(state)

        agent = make_llm_response(_baton_json(facts={"resumed": True}))

        with patch("litellm.acompletion", new=AsyncMock(return_value=agent)):
            handle = ix.resume("resume-task")
            result = await handle.run()

        assert result.status == "completed"
        assert result.task_id == "resume-task"


class TestConstraints:
    @pytest.mark.asyncio
    async def test_cost_constraint_filters_expensive_model(self, ix):
        """With tight cost constraint, should fall back to cheaper model."""
        captured_models = []

        async def capture(*args, **kwargs):
            captured_models.append(kwargs.get("model", ""))
            return make_llm_response(_baton_json())

        # planner prefers claude-opus-4-6 (0.015/1k), fallback gpt-4o (0.005/1k)
        constraints = RouteConstraints(max_cost_usd_per_1k_tokens=0.010)

        with patch("litellm.acompletion", new=capture):
            await ix.run_as(role="planner", task="plan it", constraints=constraints)

        # Should have used gpt-4o, not claude-opus-4-6
        assert any("gpt-4o" in m for m in captured_models)
        assert not any("claude-opus" in m for m in captured_models)


class TestFactConflictOnHandoff:
    @pytest.mark.asyncio
    async def test_conflicting_facts_fail_the_task(self, ix):
        """If the second agent returns facts contradicting the first, task fails."""
        decomp = make_llm_response(
            json.dumps([
                {"id": "s1", "description": "plan", "role": "planner", "depends_on": []},
                {"id": "s2", "description": "code", "role": "coder", "depends_on": ["s1"]},
            ])
        )
        plan_baton = make_llm_response(
            _baton_json(facts={"auth": "JWT"})
        )
        # Second agent contradicts auth=JWT with auth=sessions
        conflict_baton = make_llm_response(
            _baton_json(facts={"auth": "sessions"})
        )

        with patch("litellm.acompletion", new=AsyncMock(side_effect=[decomp, plan_baton, conflict_baton])):
            result = await ix.run("plan and implement")

        # s2 should fail due to conflict
        node_statuses = {n.id: n.status for n in result.task_nodes}
        assert node_statuses.get("s2") == "failed"
        assert result.status == "failed"
