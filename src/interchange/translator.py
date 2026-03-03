"""Context translator: renders WorldState and Baton into model-native prompts.

LiteLLM handles the low-level API format differences (Anthropic tool blocks vs
OpenAI function schemas). This module handles the semantic layer: how to present
accumulated state and baton context to an incoming agent as a system prompt.
"""
from __future__ import annotations

import json
from typing import Any

from .models import Baton, WorldState


_BATON_SYSTEM_TEMPLATE = """\
## Handoff Context

You are continuing work on a multi-step task. The previous agent has handed off
to you with the following structured context. Trust this information — it has
been validated against the shared world state.

### Established Facts
{facts}

### Completed Work Summary
{tool_calls_summary}

### Open Questions You Must Address
{open_questions}

### Recommendation from Previous Agent
{recommendation}

### Your Role
You are acting as the **{to_role}** agent. Focus only on the work described in
your task. When you have finished, produce a JSON baton summary as your final
message (see instructions below).
"""

_NO_BATON_SYSTEM_TEMPLATE = """\
## Task Context

You are the first agent on this task. No prior work has been done.

### Your Role
You are acting as the **{role}** agent. Complete the task below, then produce
a JSON baton summary as your final message (see instructions below).
"""

_BATON_REQUEST_SUFFIX = """

---
## Baton Output Instructions

When you have completed your work, output ONLY a JSON object (no other text)
with this exact structure:

```json
{
  "facts": {
    "key": "value"
  },
  "tool_calls_summary": ["brief description of what was done"],
  "open_questions": ["anything still unresolved"],
  "recommendation": "one sentence for the next agent",
  "status": "complete"
}
```

`status` must be one of: "complete", "partial", "blocked".
`facts` must contain only facts that are now established — do not contradict
any facts listed in the handoff context above.
"""


class ContextTranslator:
    """Renders WorldState and optional Baton into a system prompt string.

    The system prompt is model-agnostic; LiteLLM translates the surrounding
    message format to each provider's native schema automatically.
    """

    def render_system_prompt(
        self,
        state: WorldState,
        baton_in: Baton | None,
        role: str,
    ) -> str:
        """Build the system prompt for an agent turn.

        Args:
            state: Current WorldState (used for global facts).
            baton_in: Incoming baton from the previous agent, if any.
            role: The role name for this agent turn.

        Returns:
            A system prompt string ready to pass to litellm.completion.
        """
        if baton_in:
            facts_block = self._format_facts(baton_in.facts or state.facts)
            summary_block = self._format_list(baton_in.tool_calls_summary)
            questions_block = self._format_list(baton_in.open_questions)
            context = _BATON_SYSTEM_TEMPLATE.format(
                facts=facts_block,
                tool_calls_summary=summary_block,
                open_questions=questions_block,
                recommendation=baton_in.recommendation or "(none)",
                to_role=role,
            )
        else:
            context = _NO_BATON_SYSTEM_TEMPLATE.format(role=role)

        # Append global facts if there are any and we didn't already show them
        if state.facts and not baton_in:
            context += f"\n### Global Facts So Far\n{self._format_facts(state.facts)}\n"

        return context + _BATON_REQUEST_SUFFIX

    def parse_baton_from_output(self, output: str) -> dict[str, Any] | None:
        """Extract a baton JSON dict from the agent's final output.

        Tries to parse the entire output as JSON first, then falls back to
        extracting the last JSON block if the agent included prose around it.

        Returns None if no valid baton JSON is found.
        """
        output = output.strip()

        # Direct JSON parse
        try:
            data = json.loads(output)
            if isinstance(data, dict) and "status" in data:
                return data
        except json.JSONDecodeError:
            pass

        # Extract last ```json ... ``` block
        import re
        blocks = re.findall(r"```(?:json)?\s*(\{.*?\})\s*```", output, re.DOTALL)
        if blocks:
            try:
                data = json.loads(blocks[-1])
                if isinstance(data, dict) and "status" in data:
                    return data
            except json.JSONDecodeError:
                pass

        # Last-resort: find first { ... last } span in the string
        last_brace = output.rfind("}")
        if last_brace != -1:
            first_brace = output.find("{")
            if first_brace != -1 and first_brace < last_brace:
                try:
                    data = json.loads(output[first_brace: last_brace + 1])
                    if isinstance(data, dict) and "status" in data:
                        return data
                except json.JSONDecodeError:
                    pass

        return None

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _format_facts(facts: dict[str, Any]) -> str:
        if not facts:
            return "(none established yet)"
        return "\n".join(f"- **{k}**: {v}" for k, v in facts.items())

    @staticmethod
    def _format_list(items: list[str]) -> str:
        if not items:
            return "(none)"
        return "\n".join(f"- {item}" for item in items)
