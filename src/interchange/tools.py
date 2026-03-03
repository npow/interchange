"""Tool registry and built-in tools for interchange."""
from __future__ import annotations

import asyncio
import functools
import inspect
import subprocess
from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass
class ToolSpec:
    """Specification for a tool that agents can call."""

    name: str
    description: str
    parameters: dict[str, Any]  # JSON Schema object
    fn: Callable

    def to_litellm(self) -> dict[str, Any]:
        """Render as an OpenAI-compatible tool definition (LiteLLM normalises from here)."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


def tool(name: str | None = None, description: str = "") -> Callable:
    """Decorator to turn a function into a ToolSpec.

    Usage::

        @tool(name="bash", description="Run a shell command")
        def bash(command: str) -> str:
            ...
    """

    def decorator(fn: Callable) -> ToolSpec:
        tool_name = name or fn.__name__
        doc = description or (fn.__doc__ or "").strip()
        schema = _build_schema(fn)
        return ToolSpec(name=tool_name, description=doc, parameters=schema, fn=fn)

    return decorator


def _build_schema(fn: Callable) -> dict[str, Any]:
    """Build a minimal JSON Schema from a function's type annotations."""
    hints = {k: v for k, v in fn.__annotations__.items() if k != "return"}
    sig = inspect.signature(fn)
    properties: dict[str, Any] = {}
    required: list[str] = []

    for param_name, hint in hints.items():
        properties[param_name] = _hint_to_json_type(hint)
        param = sig.parameters.get(param_name)
        if param and param.default is inspect.Parameter.empty:
            required.append(param_name)

    return {"type": "object", "properties": properties, "required": required}


def _hint_to_json_type(hint: Any) -> dict[str, str]:
    mapping = {str: "string", int: "integer", float: "number", bool: "boolean"}
    return {"type": mapping.get(hint, "string")}


class ToolRegistry:
    """Registry of tools available to agents.

    Provides a unified interface for executing tools regardless of which model
    made the call. All tools are available in OpenAI-compatible format via
    ``to_litellm()``.
    """

    def __init__(self, tools: list[ToolSpec] | None = None) -> None:
        self._tools: dict[str, ToolSpec] = {}
        for t in tools or []:
            self.register(t)

    def register(self, spec: ToolSpec) -> None:
        """Register a tool. Overwrites any existing tool with the same name."""
        self._tools[spec.name] = spec

    def get(self, name: str) -> ToolSpec | None:
        return self._tools.get(name)

    def all(self) -> list[ToolSpec]:
        return list(self._tools.values())

    def to_litellm(self) -> list[dict[str, Any]]:
        """Return all tools in OpenAI-compatible format for LiteLLM."""
        return [spec.to_litellm() for spec in self._tools.values()]

    async def execute(self, name: str, inputs: dict[str, Any]) -> str:
        """Execute a tool by name, returning its string output."""
        spec = self._tools.get(name)
        if not spec:
            raise ValueError(f"Unknown tool: {name!r}. Available: {list(self._tools)}")

        if asyncio.iscoroutinefunction(spec.fn):
            result = await spec.fn(**inputs)
        else:
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                None, functools.partial(spec.fn, **inputs)
            )
        return str(result) if result is not None else ""


# ---------------------------------------------------------------------------
# Built-in tools
# ---------------------------------------------------------------------------


@tool(name="bash", description="Run a shell command and return its combined stdout/stderr output.")
def bash(command: str) -> str:
    """Run a shell command and return its combined stdout/stderr output."""
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=60,
        )
        parts = []
        if result.stdout:
            parts.append(result.stdout)
        if result.stderr:
            parts.append(f"STDERR:\n{result.stderr}")
        if result.returncode != 0:
            parts.append(f"EXIT CODE: {result.returncode}")
        return "\n".join(parts) or "(no output)"
    except subprocess.TimeoutExpired:
        return "ERROR: command timed out after 60 seconds"


@tool(name="read_file", description="Read the full contents of a file at the given path.")
def read_file(path: str) -> str:
    """Read the full contents of a file at the given path."""
    try:
        with open(path) as f:
            return f.read()
    except OSError as e:
        return f"ERROR: {e}"


@tool(name="write_file", description="Write content to a file, creating it if it does not exist.")
def write_file(path: str, content: str) -> str:
    """Write content to a file, creating it if it does not exist."""
    try:
        with open(path, "w") as f:
            f.write(content)
        return f"Wrote {len(content)} bytes to {path!r}"
    except OSError as e:
        return f"ERROR: {e}"


DEFAULT_TOOLS = ToolRegistry([bash, read_file, write_file])
