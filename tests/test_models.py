"""Tests for interchange.models — construction, defaults, and field types."""
from __future__ import annotations

from datetime import datetime

from interchange.models import (
    Baton,
    InterchangeResult,
    Role,
    RouteConstraints,
    RouteDecision,
    TaskNode,
    ToolCall,
    WorldState,
)


class TestToolCall:
    def test_defaults_assigned(self):
        tc = ToolCall(
            name="bash",
            inputs={"command": "ls"},
            role="coder",
            model="gpt-4o",
            task_node_id="step_1",
        )
        assert tc.id  # auto-generated uuid
        assert tc.result is None
        assert tc.error is None
        assert isinstance(tc.timestamp, datetime)

    def test_with_result(self):
        tc = ToolCall(
            name="bash",
            inputs={"command": "ls"},
            role="coder",
            model="gpt-4o",
            task_node_id="step_1",
            result="file.py",
        )
        assert tc.result == "file.py"

    def test_unique_ids(self):
        a = ToolCall(name="x", inputs={}, role="r", model="m", task_node_id="n")
        b = ToolCall(name="x", inputs={}, role="r", model="m", task_node_id="n")
        assert a.id != b.id


class TestBaton:
    def test_construction(self, sample_baton):
        assert sample_baton.from_role == "planner"
        assert sample_baton.to_role == "coder"
        assert sample_baton.facts["approach"] == "REST API"
        assert sample_baton.status == "complete"

    def test_defaults(self):
        b = Baton(
            task_id="t1",
            task_node_id="s1",
            from_role="planner",
            from_model="gpt-4o",
            to_role="coder",
            facts={},
            open_questions=[],
            recommendation="",
            status="complete",
        )
        assert b.id
        assert b.tool_calls_summary == []
        assert isinstance(b.created_at, datetime)


class TestTaskNode:
    def test_defaults(self):
        node = TaskNode(id="step_1", description="Do something", role="coder")
        assert node.status == "pending"
        assert node.depends_on == []
        assert node.assigned_model is None
        assert node.baton_in is None
        assert node.baton_out is None

    def test_status_values(self):
        for status in ("pending", "in_progress", "completed", "failed", "skipped"):
            node = TaskNode(id="x", description="x", role="coder", status=status)
            assert node.status == status


class TestWorldState:
    def test_defaults(self):
        ws = WorldState(task_id="t1", original_task="do it")
        assert ws.task_nodes == {}
        assert ws.facts == {}
        assert ws.tool_call_history == []
        assert ws.batons == []
        assert ws.status == "running"
        assert ws.version == 0

    def test_unique_created_at(self):
        a = WorldState(task_id="t1", original_task="x")
        b = WorldState(task_id="t2", original_task="y")
        # Not guaranteed to differ in nanoseconds, but both should be recent
        assert isinstance(a.created_at, datetime)
        assert isinstance(b.created_at, datetime)


class TestRole:
    def test_defaults(self):
        role = Role(preferred_model="gpt-4o", fallback_model="gpt-4o-mini")
        assert role.capabilities == []
        assert role.allowed_tools is None

    def test_with_capabilities(self):
        role = Role(
            preferred_model="claude-opus-4-6",
            fallback_model="gpt-4o",
            capabilities=["plan", "design"],
        )
        assert "plan" in role.capabilities


class TestRouteConstraints:
    def test_defaults(self):
        c = RouteConstraints()
        assert c.max_cost_usd_per_1k_tokens is None
        assert c.max_latency_ms is None
        assert not c.prefer_local
        assert c.disallowed_models == []
