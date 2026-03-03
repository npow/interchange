import { describe, it, expect } from "vitest";
import {
  checkCycles,
  getReadyNodes,
} from "../src/orchestrator.js";
import { makeTaskNode, makeWorldState } from "@interchange/core";
import { CyclicDependencyError } from "@interchange/core";

// ---------------------------------------------------------------------------
// checkCycles
// ---------------------------------------------------------------------------
describe("checkCycles", () => {
  it("accepts a linear chain (no cycles)", () => {
    const nodes = [
      makeTaskNode("a", "task a", "coder"),
      makeTaskNode("b", "task b", "coder", ["a"]),
      makeTaskNode("c", "task c", "reviewer", ["b"]),
    ];
    expect(() => checkCycles(nodes)).not.toThrow();
  });

  it("accepts parallel nodes with shared dependency", () => {
    const nodes = [
      makeTaskNode("a", "task a", "planner"),
      makeTaskNode("b", "task b", "coder", ["a"]),
      makeTaskNode("c", "task c", "reviewer", ["a"]),
    ];
    expect(() => checkCycles(nodes)).not.toThrow();
  });

  it("detects a direct cycle (a → b → a)", () => {
    const nodes = [
      makeTaskNode("a", "task a", "coder", ["b"]),
      makeTaskNode("b", "task b", "coder", ["a"]),
    ];
    expect(() => checkCycles(nodes)).toThrow(CyclicDependencyError);
  });

  it("detects a longer cycle (a → b → c → a)", () => {
    const nodes = [
      makeTaskNode("a", "task a", "coder", ["c"]),
      makeTaskNode("b", "task b", "coder", ["a"]),
      makeTaskNode("c", "task c", "coder", ["b"]),
    ];
    expect(() => checkCycles(nodes)).toThrow(CyclicDependencyError);
  });

  it("accepts a single node with no dependencies", () => {
    expect(() => checkCycles([makeTaskNode("a", "task", "coder")])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getReadyNodes
// ---------------------------------------------------------------------------
describe("getReadyNodes", () => {
  function makeState(nodes: ReturnType<typeof makeTaskNode>[]) {
    const state = makeWorldState("t1", "test");
    for (const node of nodes) {
      state.taskNodes[node.id] = node;
    }
    return state;
  }

  it("returns nodes with no dependencies", () => {
    const state = makeState([
      makeTaskNode("a", "task a", "coder"),
      makeTaskNode("b", "task b", "coder"),
    ]);
    const ready = getReadyNodes(state);
    expect(ready.map((n) => n.id).sort()).toEqual(["a", "b"]);
  });

  it("does not return nodes with incomplete dependencies", () => {
    const state = makeState([
      makeTaskNode("a", "task a", "coder"),
      makeTaskNode("b", "task b", "coder", ["a"]),
    ]);
    const ready = getReadyNodes(state);
    expect(ready.map((n) => n.id)).toEqual(["a"]);
  });

  it("returns a node once all its dependencies are completed", () => {
    const state = makeState([
      makeTaskNode("a", "task a", "coder"),
      makeTaskNode("b", "task b", "coder", ["a"]),
    ]);
    state.taskNodes["a"]!.status = "completed";
    const ready = getReadyNodes(state);
    expect(ready.map((n) => n.id)).toEqual(["b"]);
  });

  it("skips already-running or completed nodes", () => {
    const state = makeState([
      makeTaskNode("a", "task a", "coder"),
      makeTaskNode("b", "task b", "coder"),
    ]);
    state.taskNodes["a"]!.status = "in_progress";
    state.taskNodes["b"]!.status = "completed";
    const ready = getReadyNodes(state);
    expect(ready).toHaveLength(0);
  });

  it("returns empty list when all nodes done", () => {
    const state = makeState([makeTaskNode("a", "task", "coder")]);
    state.taskNodes["a"]!.status = "completed";
    expect(getReadyNodes(state)).toHaveLength(0);
  });
});
