"""interchange — stateful, role-aware routing with context translation at model boundaries."""

from .core import Interchange
from .exceptions import (
    BatonValidationError,
    CyclicDependencyError,
    FactConflictError,
    InterchangeError,
    RoutingError,
    TaskNotFoundError,
    TranslationError,
)
from .models import (
    Baton,
    InterchangeResult,
    Role,
    RouteConstraints,
    RouteDecision,
    TaskNode,
    ToolCall,
    WorldState,
)
from .tools import DEFAULT_TOOLS, ToolRegistry, ToolSpec, tool

__version__ = "0.1.0"

__all__ = [
    # Main class
    "Interchange",
    # Models
    "Baton",
    "InterchangeResult",
    "Role",
    "RouteConstraints",
    "RouteDecision",
    "TaskNode",
    "ToolCall",
    "WorldState",
    # Tools
    "DEFAULT_TOOLS",
    "ToolRegistry",
    "ToolSpec",
    "tool",
    # Exceptions
    "InterchangeError",
    "BatonValidationError",
    "CyclicDependencyError",
    "FactConflictError",
    "RoutingError",
    "TaskNotFoundError",
    "TranslationError",
]
