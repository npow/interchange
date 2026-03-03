import { describe, it, expect, vi, beforeEach } from "vitest";
import { recordsToText, distillSession } from "../src/distill.js";
import type { ClaudeRecord } from "@interchange/core";

// Mock the ai module so tests don't make real LLM calls
vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

import { generateObject } from "ai";

const mockGenerateObject = vi.mocked(generateObject);

function makeRecord(
  role: "user" | "assistant",
  text: string,
  uuid = "uuid-" + Math.random()
): ClaudeRecord {
  return {
    uuid,
    parentUuid: null,
    sessionId: "sess-001",
    timestamp: new Date().toISOString(),
    version: "1",
    cwd: "/project",
    message: { role, content: [{ type: "text", text }] },
  };
}

function makeToolUseRecord(name: string, input: Record<string, unknown>): ClaudeRecord {
  return {
    uuid: "uuid-tool-" + Math.random(),
    parentUuid: null,
    sessionId: "sess-001",
    timestamp: new Date().toISOString(),
    version: "1",
    cwd: "/project",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "tid", name, input }],
    },
  };
}

describe("recordsToText", () => {
  it("converts text messages to readable lines", () => {
    const records = [
      makeRecord("user", "Fix the auth module"),
      makeRecord("assistant", "I'll look at auth.ts first"),
    ];
    const text = recordsToText(records);
    expect(text).toContain("[USER] Fix the auth module");
    expect(text).toContain("[ASSISTANT] I'll look at auth.ts first");
  });

  it("converts tool_use blocks", () => {
    const records = [makeToolUseRecord("Bash", { command: "ls -la" })];
    const text = recordsToText(records);
    expect(text).toContain("Tool: Bash");
    expect(text).toContain("ls -la");
  });

  it("truncates long text to 600 chars", () => {
    const long = "x".repeat(800);
    const records = [makeRecord("assistant", long)];
    const text = recordsToText(records);
    const line = text.split("\n").find((l) => l.includes("[ASSISTANT]"))!;
    expect(line.length).toBeLessThan(650);
  });

  it("returns empty string for no records", () => {
    expect(recordsToText([])).toBe("");
  });
});

describe("distillSession", () => {
  beforeEach(() => {
    mockGenerateObject.mockReset();
  });

  it("calls generateObject and returns a Baton", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        facts: { authMethod: "JWT" },
        decisions: [{ what: "Use JWT", why: "Already in use" }],
        triedAndRejected: [],
        openQuestions: ["Token expiry?"],
        nextSteps: ["Add refresh endpoint"],
        recommendation: "Add refresh endpoint",
        status: "partial",
      },
    } as ReturnType<typeof generateObject> extends Promise<infer T> ? T : never);

    const records = [makeRecord("user", "Fix auth"), makeRecord("assistant", "Done")];
    const baton = await distillSession(records, "sess-001");

    expect(baton.taskId).toBe("sess-001");
    expect(baton.fromRole).toBe("claude-code");
    expect(baton.facts).toEqual({ authMethod: "JWT" });
    expect(baton.decisions).toHaveLength(1);
    expect(baton.decisions[0]!.what).toBe("Use JWT");
    expect(baton.openQuestions).toContain("Token expiry?");
    expect(baton.nextSteps).toContain("Add refresh endpoint");
    expect(baton.status).toBe("partial");
    expect(baton.id).toBeDefined();
    expect(baton.createdAt).toBeDefined();
  });

  it("includes prior context in prompt when prior baton provided", async () => {
    const priorBaton = {
      id: "b0",
      taskId: "sess-000",
      taskNodeId: "sess-000",
      fromRole: "claude-code",
      fromModel: "claude-haiku",
      toRole: "next-agent",
      facts: { dbType: "postgres" },
      decisions: [],
      triedAndRejected: [],
      openQuestions: [],
      nextSteps: [],
      toolCallsSummary: [],
      recommendation: "continue",
      status: "partial" as const,
      createdAt: new Date().toISOString(),
    };

    mockGenerateObject.mockResolvedValue({
      object: {
        facts: { dbType: "postgres", authMethod: "JWT" },
        decisions: [],
        triedAndRejected: [],
        openQuestions: [],
        nextSteps: [],
        recommendation: "deploy",
        status: "complete",
      },
    } as ReturnType<typeof generateObject> extends Promise<infer T> ? T : never);

    await distillSession([makeRecord("user", "add auth")], "sess-001", priorBaton);

    const call = mockGenerateObject.mock.calls[0]![0] as { prompt: string };
    expect(call.prompt).toContain("postgres");
  });
});
