import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  MemoryBackend,
  JSONFileBackend,
  StateManager,
  makeWorldState,
  makeTaskNode,
  makeBaton,
  serializeState,
  deserializeState,
} from "../src/state/index.js";
import {
  BatonValidationError,
  FactConflictError,
  TaskNotFoundError,
} from "../src/exceptions.js";
import type { WorldState, Baton } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sampleState(): WorldState {
  return makeWorldState("task-1", "Write a hello world program");
}

function sampleBaton(
  taskId: string,
  taskNodeId: string,
  overrides: Partial<Baton> = {}
): Baton {
  return makeBaton({
    taskId,
    taskNodeId,
    fromRole: "coder",
    fromModel: "gpt-4o",
    toRole: "reviewer",
    facts: { language: "TypeScript" },
    openQuestions: [],
    recommendation: "Review the implementation",
    status: "complete",
    toolCallsSummary: ["Wrote hello.ts"],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Serialization round-trip
// ---------------------------------------------------------------------------
describe("serialization round-trip", () => {
  it("round-trips an empty state", () => {
    const state = sampleState();
    const restored = deserializeState(serializeState(state) as Record<string, unknown>);
    expect(restored.taskId).toBe(state.taskId);
    expect(restored.originalTask).toBe(state.originalTask);
    expect(restored.status).toBe("running");
    expect(restored.version).toBe(0);
  });

  it("round-trips a state with nodes and batons", () => {
    const state = sampleState();
    state.taskNodes["step_1"] = makeTaskNode("step_1", "Code it", "coder");
    const baton = sampleBaton("task-1", "step_1");
    state.batons.push(baton);
    state.facts["language"] = "TypeScript";

    const restored = deserializeState(serializeState(state) as Record<string, unknown>);
    expect(restored.taskNodes["step_1"]).toBeDefined();
    expect(restored.taskNodes["step_1"]!.role).toBe("coder");
    expect(restored.batons).toHaveLength(1);
    expect(restored.batons[0]!.fromRole).toBe("coder");
    expect(restored.facts["language"]).toBe("TypeScript");
  });
});

// ---------------------------------------------------------------------------
// MemoryBackend
// ---------------------------------------------------------------------------
describe("MemoryBackend", () => {
  it("saves and loads state", () => {
    const backend = new MemoryBackend();
    const state = sampleState();
    backend.save(state);
    const loaded = backend.load("task-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.taskId).toBe("task-1");
  });

  it("returns null for unknown taskId", () => {
    const backend = new MemoryBackend();
    expect(backend.load("nonexistent")).toBeNull();
  });

  it("does not share references between saved and live state", () => {
    const backend = new MemoryBackend();
    const state = sampleState();
    backend.save(state);
    // Mutate live state AFTER saving
    state.facts["mutated"] = true;
    const loaded = backend.load("task-1");
    expect(loaded!.facts["mutated"]).toBeUndefined();
  });

  it("lists saved task IDs", () => {
    const backend = new MemoryBackend();
    backend.save(makeWorldState("t1", "task 1"));
    backend.save(makeWorldState("t2", "task 2"));
    expect(backend.listTasks()).toContain("t1");
    expect(backend.listTasks()).toContain("t2");
  });
});

// ---------------------------------------------------------------------------
// JSONFileBackend
// ---------------------------------------------------------------------------
describe("JSONFileBackend", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "interchange-test-"));
  });

  it("persists across backend instances", () => {
    const path = join(tmpDir, "state.json");
    const backend1 = new JSONFileBackend(path);
    backend1.save(sampleState());

    const backend2 = new JSONFileBackend(path);
    const loaded = backend2.load("task-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.taskId).toBe("task-1");
  });

  it("returns null for unknown taskId", () => {
    const backend = new JSONFileBackend(join(tmpDir, "state.json"));
    expect(backend.load("nonexistent")).toBeNull();
  });

  it("overwrites existing state on save", () => {
    const path = join(tmpDir, "state.json");
    const backend = new JSONFileBackend(path);
    const state = sampleState();
    backend.save(state);
    state.facts["updated"] = true;
    backend.save(state);
    const loaded = backend.load("task-1");
    expect(loaded!.facts["updated"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// StateManager
// ---------------------------------------------------------------------------
describe("StateManager", () => {
  it("creates and retrieves a WorldState", () => {
    const sm = new StateManager();
    const state = sm.create("task-1", "Test task");
    expect(state.taskId).toBe("task-1");
    expect(state.originalTask).toBe("Test task");

    const loaded = sm.get("task-1");
    expect(loaded.taskId).toBe("task-1");
  });

  it("throws TaskNotFoundError for unknown task", () => {
    const sm = new StateManager();
    expect(() => sm.get("unknown")).toThrow(TaskNotFoundError);
  });

  it("bumps version and updatedAt on save", () => {
    const sm = new StateManager();
    const state = sm.create("task-1", "Test task");
    const originalVersion = state.version;
    const originalUpdatedAt = state.updatedAt;

    sm.save(state);
    expect(state.version).toBe(originalVersion + 1);
    // updatedAt should have advanced (or at least not regressed)
    expect(state.updatedAt >= originalUpdatedAt).toBe(true);
  });

  it("applies a valid baton successfully", () => {
    const sm = new StateManager();
    const state = sm.create("task-1", "Test task");
    state.taskNodes["step_1"] = makeTaskNode("step_1", "Do work", "coder");
    sm.save(state);

    const baton = sampleBaton("task-1", "step_1");
    sm.applyBaton(state, baton);

    expect(state.facts["language"]).toBe("TypeScript");
    expect(state.batons).toHaveLength(1);
    expect(state.taskNodes["step_1"]!.status).toBe("completed");
    expect(state.taskNodes["step_1"]!.batonOut).toBeDefined();
  });

  it("raises BatonValidationError for invalid baton", () => {
    const sm = new StateManager();
    const state = sm.create("task-1", "Test task");
    const baton = sampleBaton("task-1", "step_1", {
      fromRole: "",
      status: "invalid" as Baton["status"],
    });
    expect(() => sm.applyBaton(state, baton)).toThrow(BatonValidationError);
  });

  it("raises FactConflictError when baton contradicts existing facts", () => {
    const sm = new StateManager();
    const state = sm.create("task-1", "Test task");
    state.facts["language"] = "Python"; // already established
    sm.save(state);

    const baton = sampleBaton("task-1", "step_1", {
      facts: { language: "TypeScript" }, // contradicts!
    });
    expect(() => sm.applyBaton(state, baton)).toThrow(FactConflictError);
  });

  it("allows baton to extend existing facts without conflict", () => {
    const sm = new StateManager();
    const state = sm.create("task-1", "Test task");
    state.facts["language"] = "TypeScript"; // pre-established
    sm.save(state);

    const baton = sampleBaton("task-1", "step_1", {
      facts: { language: "TypeScript", framework: "Express" }, // language matches
    });
    expect(() => sm.applyBaton(state, baton)).not.toThrow();
    expect(state.facts["framework"]).toBe("Express");
  });

  it("records tool calls", () => {
    const sm = new StateManager();
    const state = sm.create("task-1", "Test task");
    sm.recordToolCall(state, {
      id: "call-1",
      name: "bash",
      inputs: { command: "echo hi" },
      result: "hi",
      error: null,
      role: "coder",
      model: "gpt-4o",
      taskNodeId: "step_1",
      timestamp: new Date().toISOString(),
    });
    expect(state.toolCallHistory).toHaveLength(1);
    expect(state.toolCallHistory[0]!.name).toBe("bash");
  });
});
