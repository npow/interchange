/**
 * Distills a Claude Code session transcript into a structured Baton.
 *
 * Uses a fast LLM call (claude-haiku by default) to extract decisions,
 * facts, tried-and-rejected approaches, and next steps from the raw
 * session transcript — producing the compact briefing the next agent needs.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { resolveModel } from "./models.js";
import { makeBaton } from "@npow/interchange-core";
import type { ClaudeRecord, Baton } from "@npow/interchange-core";

export const DISTILL_MODEL =
  process.env.INTERCHANGE_DISTILL_MODEL ?? "claude-haiku-4-5-20251001";

const BatonSchema = z.object({
  facts: z
    .record(z.string(), z.unknown())
    .describe("Key facts now established as true (e.g. 'auth uses JWT', 'tests pass')"),
  decisions: z
    .array(z.object({ what: z.string(), why: z.string() }))
    .describe("Explicit choices made with their rationale"),
  triedAndRejected: z
    .array(z.object({ what: z.string(), why: z.string() }))
    .describe("Approaches attempted but abandoned, with the reason why"),
  openQuestions: z
    .array(z.string())
    .describe("Unresolved questions or blockers"),
  nextSteps: z
    .array(z.string())
    .describe("Concrete recommended next actions"),
  recommendation: z
    .string()
    .describe("One sentence: the single most important thing to do next"),
  status: z
    .enum(["complete", "partial", "blocked"])
    .describe("Whether the session's goal was completed"),
});

const SYSTEM_PROMPT = `You are a technical analyst extracting a structured briefing from an AI coding session.

Extract only what is explicitly established in the transcript:
- FACTS: Things now confirmed true about the codebase or project
- DECISIONS: Choices made with their reasoning (prevents re-litigating them)
- TRIED_AND_REJECTED: Approaches that failed and why (saves future agents from repeating mistakes)
- OPEN_QUESTIONS: Unresolved issues or things still to investigate
- NEXT_STEPS: Concrete actions the next session should take
- RECOMMENDATION: The single most important next action in one sentence

Be concise. Only include what is actually established — no speculation.`;

/** Convert ClaudeRecords to a compact readable text for distillation. */
export function recordsToText(records: ClaudeRecord[]): string {
  const lines: string[] = [];
  for (const record of records) {
    const msg = record.message;
    const role = msg.role.toUpperCase();
    const content = Array.isArray(msg.content) ? msg.content : [msg.content];
    for (const block of content) {
      if (block.type === "text") {
        lines.push(`[${role}] ${block.text.slice(0, 600)}`);
      } else if (block.type === "tool_use") {
        lines.push(
          `[${role}] Tool: ${block.name}(${JSON.stringify(block.input).slice(0, 300)})`
        );
      } else if (block.type === "tool_result") {
        const text =
          typeof block.content === "string"
            ? block.content.slice(0, 300)
            : JSON.stringify(block.content).slice(0, 300);
        lines.push(`[TOOL_RESULT] ${text}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * Distill a session transcript into a Baton.
 *
 * @param records   ClaudeRecords from the session transcript
 * @param sessionId Session identifier (used as baton taskId)
 * @param prior     Previous baton to merge context from (optional)
 * @param model     Model for distillation (default: DISTILL_MODEL)
 */
export async function distillSession(
  records: ClaudeRecord[],
  sessionId: string,
  prior?: Baton,
  model?: string
): Promise<Baton> {
  const transcript = recordsToText(records);

  const priorContext = prior
    ? `\nPrevious state:\n${JSON.stringify(
        { facts: prior.facts, decisions: prior.decisions, openQuestions: prior.openQuestions },
        null,
        2
      )}\n`
    : "";

  const { object } = await generateObject({
    model: resolveModel(model ?? DISTILL_MODEL),
    schema: BatonSchema,
    system: SYSTEM_PROMPT,
    prompt: `${priorContext}\nSession transcript:\n${transcript}`,
  });

  return makeBaton({
    taskId: sessionId,
    taskNodeId: sessionId,
    fromRole: "claude-code",
    fromModel: model ?? DISTILL_MODEL,
    toRole: "next-agent",
    facts: object.facts as Record<string, unknown>,
    decisions: object.decisions,
    triedAndRejected: object.triedAndRejected,
    openQuestions: object.openQuestions,
    nextSteps: object.nextSteps,
    recommendation: object.recommendation,
    status: object.status,
  });
}
