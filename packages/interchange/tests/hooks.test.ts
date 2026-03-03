import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { getStateDir, getStateFile, handleStopHook } from "../src/hooks.js";
import type { StopEvent } from "@npow/interchange-core";

// Mock distillSession so tests don't make real LLM calls
vi.mock("../src/distill.js", () => ({
  distillSession: vi.fn(),
}));

import { distillSession } from "../src/distill.js";
import { makeBaton, JSONFileBackend, StateManager } from "@npow/interchange-core";

const mockDistill = vi.mocked(distillSession);

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), "interchange-test-" + randomBytes(4).toString("hex"));
  mkdirSync(testDir, { recursive: true });
  mockDistill.mockReset();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function makeTranscriptFile(sessionId: string): string {
  const path = join(testDir, `${sessionId}.jsonl`);
  const record = {
    uuid: "uuid-001",
    parentUuid: null,
    sessionId,
    timestamp: new Date().toISOString(),
    version: "1",
    cwd: testDir,
    message: { role: "user", content: [{ type: "text", text: "Fix the bug" }] },
  };
  writeFileSync(path, JSON.stringify(record) + "\n", "utf8");
  return path;
}

function makeStopEvent(sessionId: string, transcriptPath: string): StopEvent {
  return {
    hook_event_name: "Stop",
    session_id: sessionId,
    transcript_path: transcriptPath,
    stop_hook_active: false,
  };
}

describe("getStateDir / getStateFile", () => {
  it("returns .interchange/ and state.json under project dir", () => {
    expect(getStateDir("/my/project")).toBe("/my/project/.interchange");
    expect(getStateFile("/my/project")).toBe("/my/project/.interchange/state.json");
  });
});

describe("handleStopHook", () => {
  it("creates .interchange/state.json after processing a session", async () => {
    const sessionId = "sess-abc";
    const transcript = makeTranscriptFile(sessionId);

    mockDistill.mockResolvedValue(
      makeBaton({
        taskId: sessionId,
        taskNodeId: sessionId,
        fromRole: "claude-code",
        fromModel: "claude-haiku",
        toRole: "next-agent",
        facts: { fixed: true },
        decisions: [],
        openQuestions: [],
        recommendation: "done",
        status: "complete",
      })
    );

    const event = makeStopEvent(sessionId, transcript);
    await handleStopHook(event, testDir);

    expect(existsSync(getStateFile(testDir))).toBe(true);
  });

  it("skips processing if transcript_path does not exist", async () => {
    const event = makeStopEvent("sess-x", "/nonexistent/path.jsonl");
    await handleStopHook(event, testDir);
    expect(mockDistill).not.toHaveBeenCalled();
  });

  it("skips processing if transcript is empty", async () => {
    const emptyPath = join(testDir, "empty.jsonl");
    writeFileSync(emptyPath, "", "utf8");
    const event = makeStopEvent("sess-empty", emptyPath);
    await handleStopHook(event, testDir);
    expect(mockDistill).not.toHaveBeenCalled();
  });

  it("stores baton facts in WorldState", async () => {
    const sessionId = "sess-facts";
    const transcript = makeTranscriptFile(sessionId);

    mockDistill.mockResolvedValue(
      makeBaton({
        taskId: sessionId,
        taskNodeId: sessionId,
        fromRole: "claude-code",
        fromModel: "claude-haiku",
        toRole: "next-agent",
        facts: { dbType: "postgres" },
        decisions: [{ what: "Use postgres", why: "Already deployed" }],
        openQuestions: [],
        recommendation: "add indexes",
        status: "partial",
      })
    );

    await handleStopHook(makeStopEvent(sessionId, transcript), testDir);

    const manager = new StateManager(new JSONFileBackend(getStateFile(testDir)));
    const state = manager.get(sessionId);
    expect(state.facts["dbType"]).toBe("postgres");
    expect(state.batons).toHaveLength(1);
    expect(state.batons[0]!.decisions[0]!.what).toBe("Use postgres");
  });
});
