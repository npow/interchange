"""Tests for interchange.tools — ToolSpec, ToolRegistry, @tool decorator, built-ins."""
from __future__ import annotations

import pytest

from interchange.tools import (
    DEFAULT_TOOLS,
    ToolRegistry,
    ToolSpec,
    bash,
    read_file,
    tool,
    write_file,
)


class TestToolDecorator:
    def test_creates_tool_spec(self):
        @tool(name="greet", description="Say hello")
        def greet(name: str) -> str:
            return f"Hello {name}"

        assert isinstance(greet, ToolSpec)
        assert greet.name == "greet"
        assert greet.description == "Say hello"

    def test_infers_name_from_function(self):
        @tool()
        def my_function(x: str) -> str:
            return x

        assert my_function.name == "my_function"

    def test_schema_required_field(self):
        @tool()
        def add(a: int, b: int) -> int:
            return a + b

        schema = add.parameters
        assert "a" in schema["required"]
        assert "b" in schema["required"]

    def test_schema_optional_field(self):
        @tool()
        def greet(name: str, greeting: str = "Hello") -> str:
            return f"{greeting} {name}"

        schema = greet.parameters
        assert "name" in schema["required"]
        assert "greeting" not in schema["required"]

    def test_to_litellm_format(self):
        @tool(name="test_tool", description="A test")
        def test_tool(query: str) -> str:
            return query

        spec = test_tool.to_litellm()
        assert spec["type"] == "function"
        assert spec["function"]["name"] == "test_tool"
        assert "parameters" in spec["function"]


class TestToolRegistry:
    def test_register_and_get(self, echo_tool):
        registry = ToolRegistry()
        registry.register(echo_tool)
        assert registry.get("echo") is echo_tool

    def test_get_unknown_returns_none(self):
        registry = ToolRegistry()
        assert registry.get("nonexistent") is None

    def test_all_returns_list(self, echo_tool):
        registry = ToolRegistry([echo_tool])
        assert len(registry.all()) == 1

    def test_to_litellm(self, echo_tool):
        registry = ToolRegistry([echo_tool])
        schemas = registry.to_litellm()
        assert len(schemas) == 1
        assert schemas[0]["type"] == "function"
        assert schemas[0]["function"]["name"] == "echo"

    def test_overwrite_on_register(self, echo_tool):
        registry = ToolRegistry([echo_tool])
        new_spec = ToolSpec(
            name="echo",
            description="New echo",
            parameters=echo_tool.parameters,
            fn=lambda text: text.upper(),
        )
        registry.register(new_spec)
        assert registry.get("echo").description == "New echo"

    @pytest.mark.asyncio
    async def test_execute_sync_tool(self, echo_tool):
        registry = ToolRegistry([echo_tool])
        result = await registry.execute("echo", {"text": "hello"})
        assert result == "hello"

    @pytest.mark.asyncio
    async def test_execute_async_tool(self):
        async def async_fn(x: str) -> str:
            return f"async:{x}"

        spec = ToolSpec(
            name="async_echo",
            description="Async echo",
            parameters={
                "type": "object",
                "properties": {"x": {"type": "string"}},
                "required": ["x"],
            },
            fn=async_fn,
        )
        registry = ToolRegistry([spec])
        result = await registry.execute("async_echo", {"x": "test"})
        assert result == "async:test"

    @pytest.mark.asyncio
    async def test_execute_unknown_raises(self):
        registry = ToolRegistry()
        with pytest.raises(ValueError, match="Unknown tool"):
            await registry.execute("unknown", {})


class TestBuiltinTools:
    def test_bash_is_tool_spec(self):
        assert isinstance(bash, ToolSpec)
        assert bash.name == "bash"

    def test_read_file_is_tool_spec(self):
        assert isinstance(read_file, ToolSpec)
        assert read_file.name == "read_file"

    def test_write_file_is_tool_spec(self):
        assert isinstance(write_file, ToolSpec)
        assert write_file.name == "write_file"

    @pytest.mark.asyncio
    async def test_bash_executes(self):
        registry = ToolRegistry([bash])
        result = await registry.execute("bash", {"command": "echo hello"})
        assert "hello" in result

    @pytest.mark.asyncio
    async def test_read_write_roundtrip(self, tmp_path):
        path = str(tmp_path / "test.txt")
        registry = ToolRegistry([read_file, write_file])
        await registry.execute("write_file", {"path": path, "content": "interchange"})
        content = await registry.execute("read_file", {"path": path})
        assert content == "interchange"

    @pytest.mark.asyncio
    async def test_read_nonexistent(self):
        registry = ToolRegistry([read_file])
        result = await registry.execute("read_file", {"path": "/nonexistent/file.txt"})
        assert "ERROR" in result

    def test_default_tools_has_all_builtins(self):
        assert DEFAULT_TOOLS.get("bash") is not None
        assert DEFAULT_TOOLS.get("read_file") is not None
        assert DEFAULT_TOOLS.get("write_file") is not None
