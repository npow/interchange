/**
 * ContextTranslator: renders WorldState and Baton into model-native prompts.
 *
 * LiteLLM/Vercel AI SDK handles the low-level API format differences.
 * This module handles the semantic layer: how to present accumulated state
 * and baton context to an incoming agent as a system prompt.
 */
import type { Baton, WorldState } from "@interchange/core";

const BATON_SYSTEM_TEMPLATE = `\
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
`;

const NO_BATON_SYSTEM_TEMPLATE = `\
## Task Context

You are the first agent on this task. No prior work has been done.

### Your Role
You are acting as the **{role}** agent. Complete the task below, then produce
a JSON baton summary as your final message (see instructions below).
`;

const BATON_REQUEST_SUFFIX = `

---
## Baton Output Instructions

When you have completed your work, output ONLY a JSON object (no other text)
with this exact structure:

\`\`\`json
{
  "facts": {
    "key": "value"
  },
  "tool_calls_summary": ["brief description of what was done"],
  "open_questions": ["anything still unresolved"],
  "recommendation": "one sentence for the next agent",
  "status": "complete"
}
\`\`\`

\`status\` must be one of: "complete", "partial", "blocked".
\`facts\` must contain only facts that are now established — do not contradict
any facts listed in the handoff context above.
`;

export class ContextTranslator {
  /**
   * Build the system prompt for an agent turn.
   */
  renderSystemPrompt(
    state: WorldState,
    batonIn: Baton | null,
    role: string
  ): string {
    let context: string;

    if (batonIn) {
      const factsBlock = formatFacts(batonIn.facts ?? state.facts);
      const summaryBlock = formatList(batonIn.toolCallsSummary);
      const questionsBlock = formatList(batonIn.openQuestions);
      context = BATON_SYSTEM_TEMPLATE
        .replace("{facts}", factsBlock)
        .replace("{tool_calls_summary}", summaryBlock)
        .replace("{open_questions}", questionsBlock)
        .replace("{recommendation}", batonIn.recommendation || "(none)")
        .replace("{to_role}", role);
    } else {
      context = NO_BATON_SYSTEM_TEMPLATE.replace("{role}", role);
    }

    // Append global facts if there are any and we didn't already show them
    if (Object.keys(state.facts).length > 0 && !batonIn) {
      context += `\n### Global Facts So Far\n${formatFacts(state.facts)}\n`;
    }

    return context + BATON_REQUEST_SUFFIX;
  }

  /**
   * Extract a baton JSON dict from the agent's final output.
   *
   * Tries three strategies:
   * 1. Direct JSON parse
   * 2. Extract last ```json ... ``` block
   * 3. Last-resort: first `{` to last `}` span
   */
  parseBatonFromOutput(output: string): Record<string, unknown> | null {
    const trimmed = output.trim();

    // Strategy 1: direct JSON parse
    try {
      const data = JSON.parse(trimmed) as unknown;
      if (isValidBaton(data)) return data as Record<string, unknown>;
    } catch {
      // fall through
    }

    // Strategy 2: extract last ```json ... ``` block
    const blocks = [...trimmed.matchAll(/```(?:json)?\s*(\{.*?\})\s*```/gs)];
    if (blocks.length > 0) {
      const last = blocks[blocks.length - 1]![1]!;
      try {
        const data = JSON.parse(last) as unknown;
        if (isValidBaton(data)) return data as Record<string, unknown>;
      } catch {
        // fall through
      }
    }

    // Strategy 3: first { to last }
    const lastBrace = trimmed.lastIndexOf("}");
    if (lastBrace !== -1) {
      const firstBrace = trimmed.indexOf("{");
      if (firstBrace !== -1 && firstBrace < lastBrace) {
        try {
          const data = JSON.parse(
            trimmed.slice(firstBrace, lastBrace + 1)
          ) as unknown;
          if (isValidBaton(data)) return data as Record<string, unknown>;
        } catch {
          // fall through
        }
      }
    }

    return null;
  }
}

function isValidBaton(data: unknown): data is Record<string, unknown> {
  return (
    typeof data === "object" &&
    data !== null &&
    "status" in data
  );
}

function formatFacts(facts: Record<string, unknown>): string {
  if (!facts || Object.keys(facts).length === 0) return "(none established yet)";
  return Object.entries(facts)
    .map(([k, v]) => `- **${k}**: ${JSON.stringify(v)}`)
    .join("\n");
}

function formatList(items: string[]): string {
  if (!items || items.length === 0) return "(none)";
  return items.map((item) => `- ${item}`).join("\n");
}
