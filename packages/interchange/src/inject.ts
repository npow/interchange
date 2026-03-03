/**
 * Formats a Baton for injection into an agent session.
 *
 * Each agent tool has its own preferred context format. This module
 * translates the structured baton into the right shape for the target.
 */
import type { Baton } from "@npow/interchange-core";

export type AgentTarget = "claude" | "codex" | "gemini" | "amp" | "generic";

/** Format a baton as a markdown context block (Claude, Gemini, Amp, generic). */
function toMarkdown(baton: Baton): string {
  const lines: string[] = [
    "## Interchange Handoff Context",
    "",
    "You are continuing work on this project. The previous session established the following.",
    "",
  ];

  if (Object.keys(baton.facts).length > 0) {
    lines.push("### Established Facts");
    for (const [k, v] of Object.entries(baton.facts)) {
      lines.push(`- **${k}**: ${JSON.stringify(v)}`);
    }
    lines.push("");
  }

  if (baton.decisions.length > 0) {
    lines.push("### Decisions Made (do not re-litigate)");
    for (const d of baton.decisions) {
      lines.push(`- **${d.what}** — ${d.why}`);
    }
    lines.push("");
  }

  if (baton.triedAndRejected.length > 0) {
    lines.push("### Already Tried — Do Not Repeat");
    for (const t of baton.triedAndRejected) {
      lines.push(`- **${t.what}** — ${t.why}`);
    }
    lines.push("");
  }

  if (baton.openQuestions.length > 0) {
    lines.push("### Open Questions");
    for (const q of baton.openQuestions) {
      lines.push(`- ${q}`);
    }
    lines.push("");
  }

  if (baton.nextSteps.length > 0) {
    lines.push("### Recommended Next Steps");
    for (const s of baton.nextSteps) {
      lines.push(`- ${s}`);
    }
    lines.push("");
  }

  if (baton.recommendation) {
    lines.push(`### Bottom Line\n${baton.recommendation}`);
  }

  return lines.join("\n");
}

/** Format a baton as a Codex JSONL system message. */
function toCodexSystemMessage(baton: Baton): string {
  return JSON.stringify({
    type: "message",
    id: "item_interchange_000",
    role: "system",
    content: toMarkdown(baton),
    status: "completed",
  });
}

/**
 * Format a baton for injection into a target agent.
 *
 * @param baton  - The baton to format
 * @param target - The agent that will receive this context
 * @returns A string ready to pass as system prompt or prepended context
 */
export function formatBatonForAgent(
  baton: Baton,
  target: AgentTarget = "generic"
): string {
  switch (target) {
    case "codex":
      return toCodexSystemMessage(baton);
    case "claude":
    case "gemini":
    case "amp":
    case "generic":
    default:
      return toMarkdown(baton);
  }
}

/**
 * Extract a baton JSON dict from agent output text.
 *
 * Tries three strategies:
 * 1. Direct JSON parse
 * 2. Extract last ```json ... ``` block
 * 3. First { to last } span
 */
export function parseBatonFromOutput(
  output: string
): Record<string, unknown> | null {
  const trimmed = output.trim();

  try {
    const data = JSON.parse(trimmed) as unknown;
    if (isObject(data)) return data as Record<string, unknown>;
  } catch {
    // fall through
  }

  const blocks = [...trimmed.matchAll(/```(?:json)?\s*(\{.*?\})\s*```/gs)];
  if (blocks.length > 0) {
    const last = blocks[blocks.length - 1]![1]!;
    try {
      const data = JSON.parse(last) as unknown;
      if (isObject(data)) return data as Record<string, unknown>;
    } catch {
      // fall through
    }
  }

  const lastBrace = trimmed.lastIndexOf("}");
  if (lastBrace !== -1) {
    const firstBrace = trimmed.indexOf("{");
    if (firstBrace !== -1 && firstBrace < lastBrace) {
      try {
        const data = JSON.parse(
          trimmed.slice(firstBrace, lastBrace + 1)
        ) as unknown;
        if (isObject(data)) return data as Record<string, unknown>;
      } catch {
        // fall through
      }
    }
  }

  return null;
}

function isObject(data: unknown): data is Record<string, unknown> {
  return typeof data === "object" && data !== null;
}
