"""State management: WorldState persistence and Baton validation."""
from __future__ import annotations

import json
import sqlite3
import threading
from abc import ABC, abstractmethod
from copy import deepcopy
from datetime import datetime
from typing import Any

from .exceptions import BatonValidationError, FactConflictError, TaskNotFoundError
from .models import Baton, TaskNode, ToolCall, WorldState


# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------


def _dt_to_str(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _str_to_dt(s: str | None) -> datetime | None:
    return datetime.fromisoformat(s) if s else None


def _serialize_tool_call(tc: ToolCall) -> dict[str, Any]:
    return {
        "id": tc.id,
        "name": tc.name,
        "inputs": tc.inputs,
        "result": tc.result,
        "error": tc.error,
        "role": tc.role,
        "model": tc.model,
        "task_node_id": tc.task_node_id,
        "timestamp": _dt_to_str(tc.timestamp),
    }


def _deserialize_tool_call(d: dict[str, Any]) -> ToolCall:
    return ToolCall(
        id=d["id"],
        name=d["name"],
        inputs=d["inputs"],
        result=d.get("result"),
        error=d.get("error"),
        role=d["role"],
        model=d["model"],
        task_node_id=d["task_node_id"],
        timestamp=_str_to_dt(d.get("timestamp")) or datetime.utcnow(),
    )


def _serialize_baton(b: Baton) -> dict[str, Any]:
    return {
        "id": b.id,
        "task_id": b.task_id,
        "task_node_id": b.task_node_id,
        "from_role": b.from_role,
        "from_model": b.from_model,
        "to_role": b.to_role,
        "facts": b.facts,
        "open_questions": b.open_questions,
        "recommendation": b.recommendation,
        "status": b.status,
        "tool_calls_summary": b.tool_calls_summary,
        "created_at": _dt_to_str(b.created_at),
    }


def _deserialize_baton(d: dict[str, Any]) -> Baton:
    return Baton(
        id=d["id"],
        task_id=d["task_id"],
        task_node_id=d["task_node_id"],
        from_role=d["from_role"],
        from_model=d["from_model"],
        to_role=d["to_role"],
        facts=d["facts"],
        open_questions=d.get("open_questions", []),
        recommendation=d.get("recommendation", ""),
        status=d["status"],
        tool_calls_summary=d.get("tool_calls_summary", []),
        created_at=_str_to_dt(d.get("created_at")) or datetime.utcnow(),
    )


def _serialize_node(n: TaskNode) -> dict[str, Any]:
    return {
        "id": n.id,
        "description": n.description,
        "role": n.role,
        "depends_on": n.depends_on,
        "status": n.status,
        "assigned_model": n.assigned_model,
        "baton_in": _serialize_baton(n.baton_in) if n.baton_in else None,
        "baton_out": _serialize_baton(n.baton_out) if n.baton_out else None,
        "started_at": _dt_to_str(n.started_at),
        "completed_at": _dt_to_str(n.completed_at),
    }


def _deserialize_node(d: dict[str, Any]) -> TaskNode:
    return TaskNode(
        id=d["id"],
        description=d["description"],
        role=d["role"],
        depends_on=d.get("depends_on", []),
        status=d.get("status", "pending"),
        assigned_model=d.get("assigned_model"),
        baton_in=_deserialize_baton(d["baton_in"]) if d.get("baton_in") else None,
        baton_out=_deserialize_baton(d["baton_out"]) if d.get("baton_out") else None,
        started_at=_str_to_dt(d.get("started_at")),
        completed_at=_str_to_dt(d.get("completed_at")),
    )


def serialize_state(state: WorldState) -> dict[str, Any]:
    return {
        "task_id": state.task_id,
        "original_task": state.original_task,
        "task_nodes": {k: _serialize_node(v) for k, v in state.task_nodes.items()},
        "facts": state.facts,
        "tool_call_history": [_serialize_tool_call(tc) for tc in state.tool_call_history],
        "batons": [_serialize_baton(b) for b in state.batons],
        "status": state.status,
        "created_at": _dt_to_str(state.created_at),
        "updated_at": _dt_to_str(state.updated_at),
        "version": state.version,
    }


def deserialize_state(d: dict[str, Any]) -> WorldState:
    return WorldState(
        task_id=d["task_id"],
        original_task=d["original_task"],
        task_nodes={k: _deserialize_node(v) for k, v in d.get("task_nodes", {}).items()},
        facts=d.get("facts", {}),
        tool_call_history=[_deserialize_tool_call(tc) for tc in d.get("tool_call_history", [])],
        batons=[_deserialize_baton(b) for b in d.get("batons", [])],
        status=d.get("status", "running"),
        created_at=_str_to_dt(d.get("created_at")) or datetime.utcnow(),
        updated_at=_str_to_dt(d.get("updated_at")) or datetime.utcnow(),
        version=d.get("version", 0),
    )


# ---------------------------------------------------------------------------
# Backends
# ---------------------------------------------------------------------------


class StateBackend(ABC):
    @abstractmethod
    def save(self, state: WorldState) -> None: ...

    @abstractmethod
    def load(self, task_id: str) -> WorldState | None: ...

    @abstractmethod
    def list_tasks(self) -> list[str]: ...


class MemoryBackend(StateBackend):
    """In-process memory backend. Thread-safe via lock. Not persistent.

    Serialises through JSON on every save/load to guarantee no shared
    references between the stored snapshot and the live WorldState object.
    """

    def __init__(self) -> None:
        self._store: dict[str, str] = {}  # task_id -> JSON string
        self._lock = threading.Lock()

    def save(self, state: WorldState) -> None:
        with self._lock:
            self._store[state.task_id] = json.dumps(serialize_state(state))

    def load(self, task_id: str) -> WorldState | None:
        with self._lock:
            raw = self._store.get(task_id)
        return deserialize_state(json.loads(raw)) if raw else None

    def list_tasks(self) -> list[str]:
        with self._lock:
            return list(self._store.keys())


class SQLiteBackend(StateBackend):
    """SQLite-backed persistent state. Zero infrastructure required."""

    def __init__(self, path: str = "~/.interchange/state.db") -> None:
        import os

        self.path = os.path.expanduser(path)
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self._init_db()

    def _init_db(self) -> None:
        with sqlite3.connect(self.path) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS world_states (
                    task_id    TEXT PRIMARY KEY,
                    data       TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.commit()

    def save(self, state: WorldState) -> None:
        with sqlite3.connect(self.path) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO world_states VALUES (?, ?, ?)",
                (
                    state.task_id,
                    json.dumps(serialize_state(state)),
                    state.updated_at.isoformat(),
                ),
            )
            conn.commit()

    def load(self, task_id: str) -> WorldState | None:
        with sqlite3.connect(self.path) as conn:
            row = conn.execute(
                "SELECT data FROM world_states WHERE task_id = ?", (task_id,)
            ).fetchone()
        return deserialize_state(json.loads(row[0])) if row else None

    def list_tasks(self) -> list[str]:
        with sqlite3.connect(self.path) as conn:
            rows = conn.execute("SELECT task_id FROM world_states").fetchall()
        return [r[0] for r in rows]


# ---------------------------------------------------------------------------
# StateManager
# ---------------------------------------------------------------------------


class StateManager:
    """High-level interface over a StateBackend.

    Handles WorldState lifecycle, Baton validation, and fact-conflict detection.
    """

    def __init__(self, backend: StateBackend | None = None) -> None:
        self._backend = backend or MemoryBackend()

    def create(self, task_id: str, original_task: str) -> WorldState:
        """Create and persist a new WorldState."""
        state = WorldState(task_id=task_id, original_task=original_task)
        self._backend.save(state)
        return state

    def get(self, task_id: str) -> WorldState:
        """Load a WorldState, raising TaskNotFoundError if absent."""
        state = self._backend.load(task_id)
        if state is None:
            raise TaskNotFoundError(task_id)
        return state

    def save(self, state: WorldState) -> None:
        """Persist state, bumping updated_at and version."""
        state.updated_at = datetime.utcnow()
        state.version += 1
        self._backend.save(state)

    def apply_baton(self, state: WorldState, baton: Baton) -> WorldState:
        """Validate baton facts against WorldState then apply.

        Raises:
            BatonValidationError: if the baton is structurally invalid.
            FactConflictError: if baton facts contradict existing WorldState facts.
        """
        self._validate_baton_structure(baton)
        self._check_fact_conflicts(state, baton)

        state.facts.update(baton.facts)
        state.batons.append(baton)

        node = state.task_nodes.get(baton.task_node_id)
        if node:
            node.baton_out = baton
            node.status = "completed"
            node.completed_at = datetime.utcnow()

        self.save(state)
        return state

    def record_tool_call(self, state: WorldState, call: ToolCall) -> None:
        """Append a tool call to WorldState history and persist."""
        state.tool_call_history.append(call)
        self.save(state)

    def list_tasks(self) -> list[str]:
        return self._backend.list_tasks()

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _validate_baton_structure(baton: Baton) -> None:
        missing = []
        if not baton.task_id:
            missing.append("task_id")
        if not baton.from_role:
            missing.append("from_role")
        if not baton.from_model:
            missing.append("from_model")
        if baton.facts is None:
            missing.append("facts")
        if baton.status not in ("complete", "partial", "blocked"):
            missing.append(f"status (got {baton.status!r})")
        if missing:
            raise BatonValidationError(f"Baton missing or invalid fields: {missing}")

    @staticmethod
    def _check_fact_conflicts(state: WorldState, baton: Baton) -> None:
        conflicts = {
            k: (state.facts[k], v)
            for k, v in baton.facts.items()
            if k in state.facts and state.facts[k] != v
        }
        if conflicts:
            raise FactConflictError(conflicts)
