import { describe, it, expect } from "vitest";
import { formatBatonForAgent, parseBatonFromOutput } from "../src/inject.js";
import { makeBaton } from "@interchange/core";

function sampleBaton() {
  return makeBaton({
    taskId: "sess_001",
    taskNodeId: "sess_001",
    fromRole: "claude-code",
    fromModel: "claude-haiku-4-5-20251001",
    toRole: "next-agent",
    facts: { authMethod: "JWT", testsPass: true },
    decisions: [
      { what: "Use JWT for auth", why: "Existing infra already uses it" },
    ],
    triedAndRejected: [
      { what: "Session cookies", why: "Doesn't work across subdomains" },
    ],
    openQuestions: ["How should token refresh be handled?"],
    nextSteps: ["Implement refresh token endpoint"],
    recommendation: "Implement the refresh token endpoint next",
    status: "partial",
  });
}

describe("formatBatonForAgent", () => {
  it("generic/claude: includes all sections as markdown", () => {
    const out = formatBatonForAgent(sampleBaton(), "generic");
    expect(out).toContain("## Interchange Handoff Context");
    expect(out).toContain("JWT");
    expect(out).toContain("Use JWT for auth");
    expect(out).toContain("Session cookies");
    expect(out).toContain("refresh token");
    expect(out).toContain("Implement refresh token endpoint");
  });

  it("codex: produces a JSONL system message", () => {
    const out = formatBatonForAgent(sampleBaton(), "codex");
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.type).toBe("message");
    expect(parsed.role).toBe("system");
    expect(typeof parsed.content).toBe("string");
    expect((parsed.content as string)).toContain("JWT");
  });

  it("claude target: same as generic (markdown)", () => {
    const a = formatBatonForAgent(sampleBaton(), "claude");
    const b = formatBatonForAgent(sampleBaton(), "generic");
    expect(a).toBe(b);
  });

  it("omits empty sections", () => {
    const baton = makeBaton({
      taskId: "s1",
      taskNodeId: "s1",
      fromRole: "claude-code",
      fromModel: "claude-haiku",
      toRole: "next-agent",
      facts: {},
      decisions: [],
      triedAndRejected: [],
      openQuestions: [],
      nextSteps: [],
      recommendation: "Just start",
      status: "complete",
    });
    const out = formatBatonForAgent(baton, "generic");
    expect(out).not.toContain("Established Facts");
    expect(out).not.toContain("Decisions Made");
    expect(out).toContain("Just start");
  });
});

describe("parseBatonFromOutput", () => {
  it("strategy 1: direct JSON parse", () => {
    const input = JSON.stringify({ status: "complete", facts: { x: 1 } });
    const result = parseBatonFromOutput(input);
    expect(result).not.toBeNull();
    expect(result!["status"]).toBe("complete");
  });

  it("strategy 2: last ```json block", () => {
    const input = `Here is my result:\n\`\`\`json\n{"status":"partial","facts":{}}\n\`\`\``;
    const result = parseBatonFromOutput(input);
    expect(result).not.toBeNull();
    expect(result!["status"]).toBe("partial");
  });

  it("strategy 3: first { to last }", () => {
    const input = `Some text {"status":"blocked","facts":{}} trailing text`;
    const result = parseBatonFromOutput(input);
    expect(result).not.toBeNull();
    expect(result!["status"]).toBe("blocked");
  });

  it("returns null for unparseable input", () => {
    expect(parseBatonFromOutput("not json at all")).toBeNull();
  });

  it("picks the last ```json block when multiple exist", () => {
    const input = `
\`\`\`json
{"status":"partial"}
\`\`\`
more text
\`\`\`json
{"status":"complete"}
\`\`\``;
    const result = parseBatonFromOutput(input);
    expect(result!["status"]).toBe("complete");
  });
});
