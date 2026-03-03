"""Shared fixtures for interchange tests."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from interchange.models import Baton, Role, RouteConstraints, TaskNode, WorldState
from interchange.state import MemoryBackend, StateManager
from interchange.tools import ToolRegistry, ToolSpec
from interchange.router import Router
from interchange.translator import ContextTranslator


# ---------------------------------------------------------------------------
# Roles & registry
# ---------------------------------------------------------------------------


@pytest.fixture
def basic_roles() -> dict[str, Role]:
    return {
        "planner": Role(
            preferred_model="claude-opus-4-6",
            fallback_model="gpt-4o",
            capabilities=["plan", "design", "architect"],
        ),
        "coder": Role(
            preferred_model="gpt-4o",
            fallback_model="claude-sonnet-4-6",
            capabilities=["implement", "code", "write", "test"],
        ),
        "reviewer": Role(
            preferred_model="claude-sonnet-4-6",
            fallback_model="gpt-4o-mini",
            capabilities=["review", "check", "audit"],
        ),
    }


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------


@pytest.fixture
def memory_backend() -> MemoryBackend:
    return MemoryBackend()


@pytest.fixture
def state_manager(memory_backend: MemoryBackend) -> StateManager:
    return StateManager(memory_backend)


@pytest.fixture
def empty_state() -> WorldState:
    return WorldState(task_id="test-task-1", original_task="Build something")


@pytest.fixture
def state_with_facts() -> WorldState:
    state = WorldState(task_id="test-task-2", original_task="Build something")
    state.facts = {"auth_method": "JWT", "framework": "FastAPI"}
    return state


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


@pytest.fixture
def echo_tool() -> ToolSpec:
    return ToolSpec(
        name="echo",
        description="Echo input back",
        parameters={
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
        fn=lambda text: text,
    )


@pytest.fixture
def tool_registry(echo_tool: ToolSpec) -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(echo_tool)
    return registry


# ---------------------------------------------------------------------------
# Router & translator
# ---------------------------------------------------------------------------


@pytest.fixture
def router(basic_roles: dict[str, Role]) -> Router:
    return Router(roles=basic_roles)


@pytest.fixture
def translator() -> ContextTranslator:
    return ContextTranslator()


# ---------------------------------------------------------------------------
# Batons
# ---------------------------------------------------------------------------


@pytest.fixture
def sample_baton() -> Baton:
    return Baton(
        task_id="test-task-1",
        task_node_id="step_1",
        from_role="planner",
        from_model="claude-opus-4-6",
        to_role="coder",
        facts={"approach": "REST API", "language": "Python"},
        tool_calls_summary=["Designed the API structure"],
        open_questions=["Which database?"],
        recommendation="Implement the /auth endpoint first.",
        status="complete",
    )


# ---------------------------------------------------------------------------
# LiteLLM mock factory
# ---------------------------------------------------------------------------


def make_llm_response(
    content: str,
    tool_calls: list[dict] | None = None,
    tokens: int = 42,
) -> MagicMock:
    """Build a mock litellm.acompletion response."""
    response = MagicMock()
    response.choices = [MagicMock()]
    msg = MagicMock()
    msg.role = "assistant"
    msg.content = content

    if tool_calls:
        tc_objects = []
        for tc in tool_calls:
            tc_obj = MagicMock()
            tc_obj.id = tc["id"]
            tc_obj.function = MagicMock()
            tc_obj.function.name = tc["name"]
            tc_obj.function.arguments = tc["arguments"]
            tc_objects.append(tc_obj)
        msg.tool_calls = tc_objects
    else:
        msg.tool_calls = None

    response.choices[0].message = msg
    response.usage = MagicMock()
    response.usage.total_tokens = tokens
    return response


@pytest.fixture
def llm_response_factory():
    return make_llm_response
