"""Interchange-specific exceptions."""
from __future__ import annotations

from typing import Any


class InterchangeError(Exception):
    """Base class for all interchange errors."""


class FactConflictError(InterchangeError):
    """Raised when a baton contains facts that contradict WorldState.

    Attributes:
        conflicts: mapping of fact key -> (existing_value, proposed_value)
    """

    def __init__(self, conflicts: dict[str, tuple[Any, Any]]) -> None:
        self.conflicts = conflicts
        pairs = ", ".join(
            f"{k!r}: {old!r} != {new!r}" for k, (old, new) in conflicts.items()
        )
        super().__init__(f"Baton fact conflicts detected: {pairs}")


class CyclicDependencyError(InterchangeError):
    """Raised when the task graph contains a cycle."""

    def __init__(self, cycle: list[str]) -> None:
        self.cycle = cycle
        super().__init__(f"Cyclic dependency in task graph: {' -> '.join(cycle)}")


class RoutingError(InterchangeError):
    """Raised when no valid route can be determined for a task."""


class TranslationError(InterchangeError):
    """Raised when context translation between model formats fails."""


class TaskNotFoundError(InterchangeError):
    """Raised when a task_id is not found in the state backend."""

    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        super().__init__(f"Task not found: {task_id!r}")


class BatonValidationError(InterchangeError):
    """Raised when a baton fails structural validation (missing required fields)."""
