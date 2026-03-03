import { describe, it, expect } from "vitest";
import { ContextTranslator } from "../src/translator.js";
import { makeWorldState, makeBaton } from "@interchange/core";

const translator = new ContextTranslator();

function emptyState() {
  return makeWorldState("task-1", "Write a web server");
}

function sampleBaton() {
  return makeBaton({
    taskId: "task-1",
    taskNodeId: "step_1",
    fromRole: "coder",
    fromModel: "gpt-4o",
    toRole: "reviewer",
    facts: { language: "TypeScript", framework: "Express" },
    openQuestions: ["Should we add auth?"],
    recommendation: "Review the Express server implementation",
    status: "complete",
    toolCallsSummary: ["Created server.ts with Express", "Added GET /health endpoint"],
  });
}

// ---------------------------------------------------------------------------
// renderSystemPrompt
// ---------------------------------------------------------------------------
describe("ContextTranslator.renderSystemPrompt", () => {
  it("includes role in system prompt", () => {
    const prompt = translator.renderSystemPrompt(emptyState(), null, "coder");
    expect(prompt).toContain("coder");
    expect(prompt).toContain("Baton Output Instructions");
  });

  it("uses no-baton template when no baton provided", () => {
    const prompt = translator.renderSystemPrompt(emptyState(), null, "coder");
    expect(prompt).toContain("first agent");
    expect(prompt).not.toContain("Handoff Context");
  });

  it("uses baton template when baton provided", () => {
    const baton = sampleBaton();
    const prompt = translator.renderSystemPrompt(emptyState(), baton, "reviewer");
    expect(prompt).toContain("Handoff Context");
    expect(prompt).toContain("TypeScript");
    expect(prompt).toContain("Express");
    expect(prompt).toContain("Should we add auth?");
    expect(prompt).toContain("Review the Express server implementation");
    expect(prompt).toContain("reviewer");
  });

  it("includes global facts when no baton and state has facts", () => {
    const state = emptyState();
    state.facts["owner"] = "alice";
    const prompt = translator.renderSystemPrompt(state, null, "coder");
    expect(prompt).toContain("Global Facts");
    expect(prompt).toContain("alice");
  });

  it("shows (none) for empty lists in baton template", () => {
    const baton = makeBaton({
      taskId: "t1",
      taskNodeId: "s1",
      fromRole: "planner",
      fromModel: "claude-opus-4-6",
      toRole: "coder",
      facts: {},
      openQuestions: [],
      recommendation: "",
      status: "complete",
      toolCallsSummary: [],
    });
    const prompt = translator.renderSystemPrompt(emptyState(), baton, "coder");
    expect(prompt).toContain("(none)");
  });
});

// ---------------------------------------------------------------------------
// parseBatonFromOutput
// ---------------------------------------------------------------------------
describe("ContextTranslator.parseBatonFromOutput", () => {
  it("parses direct JSON output", () => {
    const output = JSON.stringify({
      facts: { key: "value" },
      tool_calls_summary: ["did something"],
      open_questions: [],
      recommendation: "proceed",
      status: "complete",
    });
    const result = translator.parseBatonFromOutput(output);
    expect(result).not.toBeNull();
    expect(result!["status"]).toBe("complete");
    expect((result!["facts"] as Record<string, unknown>)["key"]).toBe("value");
  });

  it("extracts JSON from markdown code block", () => {
    const output = `
Here is my summary:

\`\`\`json
{
  "facts": {"done": true},
  "tool_calls_summary": [],
  "open_questions": [],
  "recommendation": "all good",
  "status": "complete"
}
\`\`\`
    `;
    const result = translator.parseBatonFromOutput(output);
    expect(result).not.toBeNull();
    expect(result!["status"]).toBe("complete");
  });

  it("extracts JSON from prose using last-resort span", () => {
    const output = `
I did some work. Here are the results:
{"facts": {"result": 42}, "status": "partial", "tool_calls_summary": [], "open_questions": ["next?"], "recommendation": "continue"}
    `;
    const result = translator.parseBatonFromOutput(output);
    expect(result).not.toBeNull();
    expect(result!["status"]).toBe("partial");
  });

  it("returns null for unparseable output", () => {
    expect(translator.parseBatonFromOutput("just some prose")).toBeNull();
    expect(translator.parseBatonFromOutput("")).toBeNull();
    expect(translator.parseBatonFromOutput("{broken json")).toBeNull();
  });

  it("returns null if JSON lacks status field", () => {
    const output = JSON.stringify({ facts: {}, recommendation: "hi" });
    expect(translator.parseBatonFromOutput(output)).toBeNull();
  });

  it("handles nested JSON — picks outermost object", () => {
    // The outer object has status; inner objects should not confuse the parser
    const output = JSON.stringify({
      facts: { nested: { a: 1, b: 2 } },
      status: "complete",
      tool_calls_summary: [],
      open_questions: [],
      recommendation: "done",
    });
    const result = translator.parseBatonFromOutput(output);
    expect(result).not.toBeNull();
    expect(result!["status"]).toBe("complete");
  });
});
