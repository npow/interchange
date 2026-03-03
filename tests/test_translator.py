"""Tests for interchange.translator — system prompt rendering and baton parsing."""
from __future__ import annotations

import json

import pytest

from interchange.models import Baton, WorldState
from interchange.translator import ContextTranslator


@pytest.fixture
def tx() -> ContextTranslator:
    return ContextTranslator()


@pytest.fixture
def state_no_facts() -> WorldState:
    return WorldState(task_id="t1", original_task="Build an API")


@pytest.fixture
def state_with_facts() -> WorldState:
    state = WorldState(task_id="t1", original_task="Build an API")
    state.facts = {"language": "Python", "framework": "FastAPI"}
    return state


class TestRenderSystemPrompt:
    def test_no_baton_includes_role(self, tx, state_no_facts):
        prompt = tx.render_system_prompt(state_no_facts, None, "coder")
        assert "coder" in prompt

    def test_no_baton_includes_baton_instructions(self, tx, state_no_facts):
        prompt = tx.render_system_prompt(state_no_facts, None, "coder")
        assert "Baton Output Instructions" in prompt
        assert '"status"' in prompt

    def test_no_baton_with_facts_includes_facts(self, tx, state_with_facts):
        prompt = tx.render_system_prompt(state_with_facts, None, "coder")
        assert "Python" in prompt
        assert "FastAPI" in prompt

    def test_with_baton_includes_facts(self, tx, state_no_facts, sample_baton):
        prompt = tx.render_system_prompt(state_no_facts, sample_baton, "coder")
        assert "REST API" in prompt
        assert "Python" in prompt

    def test_with_baton_includes_recommendation(self, tx, state_no_facts, sample_baton):
        prompt = tx.render_system_prompt(state_no_facts, sample_baton, "coder")
        assert sample_baton.recommendation in prompt

    def test_with_baton_includes_open_questions(self, tx, state_no_facts, sample_baton):
        prompt = tx.render_system_prompt(state_no_facts, sample_baton, "coder")
        assert "Which database?" in prompt

    def test_with_baton_shows_to_role(self, tx, state_no_facts, sample_baton):
        prompt = tx.render_system_prompt(state_no_facts, sample_baton, "coder")
        assert "coder" in prompt

    def test_empty_facts_renders_placeholder(self, tx, state_no_facts):
        baton = Baton(
            task_id="t1",
            task_node_id="s1",
            from_role="planner",
            from_model="gpt-4o",
            to_role="coder",
            facts={},
            open_questions=[],
            recommendation="Go",
            status="complete",
        )
        prompt = tx.render_system_prompt(state_no_facts, baton, "coder")
        assert "none established yet" in prompt.lower()

    def test_returns_string(self, tx, state_no_facts):
        result = tx.render_system_prompt(state_no_facts, None, "planner")
        assert isinstance(result, str)
        assert len(result) > 0


class TestParseBatonFromOutput:
    def test_parse_pure_json(self, tx):
        output = json.dumps({
            "facts": {"lang": "Python"},
            "tool_calls_summary": ["wrote code"],
            "open_questions": [],
            "recommendation": "deploy it",
            "status": "complete",
        })
        data = tx.parse_baton_from_output(output)
        assert data is not None
        assert data["facts"]["lang"] == "Python"
        assert data["status"] == "complete"

    def test_parse_json_in_code_block(self, tx):
        output = """
Here is my summary:

```json
{"facts": {"x": 1}, "status": "complete", "tool_calls_summary": [], "open_questions": [], "recommendation": "done"}
```
"""
        data = tx.parse_baton_from_output(output)
        assert data is not None
        assert data["facts"]["x"] == 1

    def test_parse_json_with_surrounding_text(self, tx):
        baton_dict = {
            "facts": {"y": 2},
            "status": "partial",
            "tool_calls_summary": [],
            "open_questions": ["still pending"],
            "recommendation": "continue",
        }
        output = f"I completed the task.\n\n{json.dumps(baton_dict)}\n\nEnd."
        data = tx.parse_baton_from_output(output)
        assert data is not None
        assert data["status"] == "partial"

    def test_returns_none_for_no_json(self, tx):
        result = tx.parse_baton_from_output("I am done with the task.")
        assert result is None

    def test_returns_none_for_json_without_status(self, tx):
        result = tx.parse_baton_from_output('{"foo": "bar"}')
        assert result is None

    def test_handles_empty_string(self, tx):
        result = tx.parse_baton_from_output("")
        assert result is None

    def test_prefers_last_json_block(self, tx):
        """When multiple JSON blocks present, uses the last one with a status field."""
        first = json.dumps({"facts": {"a": 1}, "status": "partial",
                            "tool_calls_summary": [], "open_questions": [],
                            "recommendation": "first"})
        second = json.dumps({"facts": {"b": 2}, "status": "complete",
                             "tool_calls_summary": [], "open_questions": [],
                             "recommendation": "second"})
        output = f"```json\n{first}\n```\n\n```json\n{second}\n```"
        data = tx.parse_baton_from_output(output)
        assert data is not None
        assert data["recommendation"] == "second"
