"""Tests for interchange.state — backends, StateManager, baton validation."""
from __future__ import annotations

import pytest

from interchange.exceptions import (
    BatonValidationError,
    FactConflictError,
    TaskNotFoundError,
)
from interchange.models import Baton, TaskNode, ToolCall, WorldState
from interchange.state import (
    MemoryBackend,
    SQLiteBackend,
    StateManager,
    deserialize_state,
    serialize_state,
)


# ---------------------------------------------------------------------------
# Serialisation round-trips
# ---------------------------------------------------------------------------


class TestSerialisation:
    def test_empty_state_roundtrip(self, empty_state):
        data = serialize_state(empty_state)
        restored = deserialize_state(data)
        assert restored.task_id == empty_state.task_id
        assert restored.original_task == empty_state.original_task
        assert restored.facts == {}
        assert restored.status == "running"

    def test_state_with_facts_roundtrip(self, state_with_facts):
        data = serialize_state(state_with_facts)
        restored = deserialize_state(data)
        assert restored.facts == state_with_facts.facts

    def test_state_with_tool_calls_roundtrip(self, empty_state):
        tc = ToolCall(
            name="bash",
            inputs={"command": "ls"},
            role="coder",
            model="gpt-4o",
            task_node_id="step_1",
            result="file.py",
        )
        empty_state.tool_call_history.append(tc)
        data = serialize_state(empty_state)
        restored = deserialize_state(data)
        assert len(restored.tool_call_history) == 1
        assert restored.tool_call_history[0].name == "bash"
        assert restored.tool_call_history[0].result == "file.py"

    def test_state_with_task_nodes_roundtrip(self, empty_state):
        node = TaskNode(
            id="step_1",
            description="Do a thing",
            role="coder",
            depends_on=["step_0"],
            status="in_progress",
            assigned_model="gpt-4o",
        )
        empty_state.task_nodes["step_1"] = node
        data = serialize_state(empty_state)
        restored = deserialize_state(data)
        assert "step_1" in restored.task_nodes
        restored_node = restored.task_nodes["step_1"]
        assert restored_node.role == "coder"
        assert restored_node.assigned_model == "gpt-4o"
        assert restored_node.depends_on == ["step_0"]

    def test_baton_roundtrip(self, empty_state, sample_baton):
        empty_state.batons.append(sample_baton)
        data = serialize_state(empty_state)
        restored = deserialize_state(data)
        assert len(restored.batons) == 1
        b = restored.batons[0]
        assert b.from_role == "planner"
        assert b.facts["approach"] == "REST API"


# ---------------------------------------------------------------------------
# MemoryBackend
# ---------------------------------------------------------------------------


class TestMemoryBackend:
    def test_save_and_load(self, empty_state):
        backend = MemoryBackend()
        backend.save(empty_state)
        loaded = backend.load(empty_state.task_id)
        assert loaded is not None
        assert loaded.task_id == empty_state.task_id

    def test_load_missing_returns_none(self):
        backend = MemoryBackend()
        assert backend.load("nonexistent") is None

    def test_list_tasks(self, empty_state):
        backend = MemoryBackend()
        backend.save(empty_state)
        assert empty_state.task_id in backend.list_tasks()

    def test_save_returns_copy(self, empty_state):
        """Mutating the original after save should not affect stored state."""
        backend = MemoryBackend()
        backend.save(empty_state)
        empty_state.facts["key"] = "value"
        loaded = backend.load(empty_state.task_id)
        assert "key" not in loaded.facts

    def test_overwrite_on_second_save(self, empty_state):
        backend = MemoryBackend()
        backend.save(empty_state)
        empty_state.facts["x"] = 1
        backend.save(empty_state)
        loaded = backend.load(empty_state.task_id)
        assert loaded.facts["x"] == 1


# ---------------------------------------------------------------------------
# SQLiteBackend
# ---------------------------------------------------------------------------


class TestSQLiteBackend:
    def test_save_and_load(self, tmp_path, empty_state):
        backend = SQLiteBackend(str(tmp_path / "test.db"))
        backend.save(empty_state)
        loaded = backend.load(empty_state.task_id)
        assert loaded is not None
        assert loaded.task_id == empty_state.task_id

    def test_load_missing_returns_none(self, tmp_path):
        backend = SQLiteBackend(str(tmp_path / "test.db"))
        assert backend.load("nonexistent") is None

    def test_list_tasks(self, tmp_path, empty_state):
        backend = SQLiteBackend(str(tmp_path / "test.db"))
        backend.save(empty_state)
        assert empty_state.task_id in backend.list_tasks()

    def test_roundtrip_with_facts(self, tmp_path, state_with_facts):
        backend = SQLiteBackend(str(tmp_path / "test.db"))
        backend.save(state_with_facts)
        loaded = backend.load(state_with_facts.task_id)
        assert loaded.facts == state_with_facts.facts

    def test_overwrite(self, tmp_path, empty_state):
        backend = SQLiteBackend(str(tmp_path / "test.db"))
        backend.save(empty_state)
        empty_state.status = "completed"
        backend.save(empty_state)
        loaded = backend.load(empty_state.task_id)
        assert loaded.status == "completed"


# ---------------------------------------------------------------------------
# StateManager
# ---------------------------------------------------------------------------


class TestStateManager:
    def test_create(self, state_manager):
        state = state_manager.create("new-task", "Build something")
        assert state.task_id == "new-task"
        assert state.original_task == "Build something"
        assert state.status == "running"

    def test_get_existing(self, state_manager, empty_state):
        state_manager._backend.save(empty_state)
        loaded = state_manager.get(empty_state.task_id)
        assert loaded.task_id == empty_state.task_id

    def test_get_missing_raises(self, state_manager):
        with pytest.raises(TaskNotFoundError):
            state_manager.get("nonexistent")

    def test_save_bumps_version(self, state_manager, empty_state):
        state_manager._backend.save(empty_state)
        assert empty_state.version == 0
        state_manager.save(empty_state)
        assert empty_state.version == 1
        state_manager.save(empty_state)
        assert empty_state.version == 2

    def test_record_tool_call(self, state_manager, empty_state):
        state_manager._backend.save(empty_state)
        tc = ToolCall(
            name="bash", inputs={}, role="coder", model="gpt-4o", task_node_id="s1"
        )
        state_manager.record_tool_call(empty_state, tc)
        assert len(empty_state.tool_call_history) == 1
        # Verify persisted
        loaded = state_manager.get(empty_state.task_id)
        assert len(loaded.tool_call_history) == 1

    def test_list_tasks(self, state_manager):
        state_manager.create("t1", "task 1")
        state_manager.create("t2", "task 2")
        tasks = state_manager.list_tasks()
        assert "t1" in tasks
        assert "t2" in tasks


# ---------------------------------------------------------------------------
# StateManager.apply_baton
# ---------------------------------------------------------------------------


class TestApplyBaton:
    def _make_baton(self, facts: dict, status: str = "complete") -> Baton:
        return Baton(
            task_id="test-task-1",
            task_node_id="step_1",
            from_role="planner",
            from_model="claude-opus-4-6",
            to_role="coder",
            facts=facts,
            open_questions=[],
            recommendation="proceed",
            status=status,
        )

    def test_apply_new_facts(self, state_manager, empty_state):
        state_manager._backend.save(empty_state)
        node = TaskNode(id="step_1", description="plan", role="planner")
        empty_state.task_nodes["step_1"] = node
        baton = self._make_baton({"lang": "Python"})
        state_manager.apply_baton(empty_state, baton)
        assert empty_state.facts["lang"] == "Python"

    def test_apply_same_facts_ok(self, state_manager, state_with_facts):
        state_manager._backend.save(state_with_facts)
        node = TaskNode(id="step_1", description="plan", role="planner")
        state_with_facts.task_nodes["step_1"] = node
        # Same values — no conflict
        baton = self._make_baton({"auth_method": "JWT"})
        state_manager.apply_baton(state_with_facts, baton)
        assert state_with_facts.facts["auth_method"] == "JWT"

    def test_apply_conflicting_facts_raises(self, state_manager, state_with_facts):
        state_manager._backend.save(state_with_facts)
        # "auth_method" already "JWT", trying to set "sessions"
        baton = self._make_baton({"auth_method": "sessions"})
        with pytest.raises(FactConflictError) as exc_info:
            state_manager.apply_baton(state_with_facts, baton)
        assert "auth_method" in exc_info.value.conflicts

    def test_apply_marks_node_completed(self, state_manager, empty_state):
        state_manager._backend.save(empty_state)
        node = TaskNode(id="step_1", description="plan", role="planner")
        empty_state.task_nodes["step_1"] = node
        baton = self._make_baton({})
        state_manager.apply_baton(empty_state, baton)
        assert empty_state.task_nodes["step_1"].status == "completed"

    def test_invalid_status_raises(self, state_manager, empty_state):
        state_manager._backend.save(empty_state)
        baton = self._make_baton({}, status="invalid_status")
        with pytest.raises(BatonValidationError):
            state_manager.apply_baton(empty_state, baton)

    def test_baton_appended_to_state(self, state_manager, empty_state):
        state_manager._backend.save(empty_state)
        node = TaskNode(id="step_1", description="plan", role="planner")
        empty_state.task_nodes["step_1"] = node
        baton = self._make_baton({"x": 1})
        state_manager.apply_baton(empty_state, baton)
        assert len(empty_state.batons) == 1
        assert empty_state.batons[0].facts["x"] == 1
