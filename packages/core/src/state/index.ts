import type { Baton, TaskNode, ToolCall, WorldState } from "../types.js";
import { makeId } from "../ids.js";
import {
  BatonValidationError,
  FactConflictError,
  TaskNotFoundError,
} from "../exceptions.js";
import { MemoryBackend, type StateBackend } from "./backends.js";

export { MemoryBackend, JSONFileBackend } from "./backends.js";
export { serializeState, deserializeState } from "./serialization.js";
export type { StateBackend } from "./backends.js";

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

export function makeWorldState(taskId: string, originalTask: string): WorldState {
  const now = new Date().toISOString();
  return {
    taskId,
    originalTask,
    taskNodes: {},
    facts: {},
    toolCallHistory: [],
    batons: [],
    status: "running",
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}

export function makeTaskNode(
  id: string,
  description: string,
  role: string,
  dependsOn: string[] = []
): TaskNode {
  return {
    id,
    description,
    role,
    dependsOn,
    status: "pending",
    assignedModel: null,
    batonIn: null,
    batonOut: null,
    startedAt: null,
    completedAt: null,
  };
}

export function makeBaton(
  partial: Omit<Baton, "id" | "createdAt">
): Baton {
  return {
    ...partial,
    id: makeId(),
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// StateManager
// ---------------------------------------------------------------------------

/**
 * High-level interface over a StateBackend.
 * Handles WorldState lifecycle, Baton validation, and fact-conflict detection.
 */
export class StateManager {
  private backend: StateBackend;

  constructor(backend?: StateBackend) {
    this.backend = backend ?? new MemoryBackend();
  }

  create(taskId: string, originalTask: string): WorldState {
    const state = makeWorldState(taskId, originalTask);
    this.backend.save(state);
    return state;
  }

  get(taskId: string): WorldState {
    const state = this.backend.load(taskId);
    if (!state) throw new TaskNotFoundError(taskId);
    return state;
  }

  save(state: WorldState): void {
    state.updatedAt = new Date().toISOString();
    state.version += 1;
    this.backend.save(state);
  }

  /**
   * Validate baton facts against WorldState then apply.
   *
   * @throws {BatonValidationError} if the baton is structurally invalid.
   * @throws {FactConflictError} if baton facts contradict existing WorldState facts.
   */
  applyBaton(state: WorldState, baton: Baton): WorldState {
    this._validateBatonStructure(baton);
    this._checkFactConflicts(state, baton);

    Object.assign(state.facts, baton.facts);
    state.batons.push(baton);

    const node = state.taskNodes[baton.taskNodeId];
    if (node) {
      node.batonOut = baton;
      node.status = "completed";
      node.completedAt = new Date().toISOString();
    }

    this.save(state);
    return state;
  }

  recordToolCall(state: WorldState, call: ToolCall): void {
    state.toolCallHistory.push(call);
    this.save(state);
  }

  listTasks(): string[] {
    return this.backend.listTasks();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _validateBatonStructure(baton: Baton): void {
    const missing: string[] = [];
    if (!baton.taskId) missing.push("taskId");
    if (!baton.fromRole) missing.push("fromRole");
    if (!baton.fromModel) missing.push("fromModel");
    if (baton.facts === null || baton.facts === undefined) missing.push("facts");
    if (!["complete", "partial", "blocked"].includes(baton.status)) {
      missing.push(`status (got ${JSON.stringify(baton.status)})`);
    }
    if (missing.length > 0) {
      throw new BatonValidationError(
        `Baton missing or invalid fields: ${missing.join(", ")}`
      );
    }
  }

  private _checkFactConflicts(state: WorldState, baton: Baton): void {
    const conflicts: Record<string, [unknown, unknown]> = {};
    for (const [k, v] of Object.entries(baton.facts)) {
      if (k in state.facts && state.facts[k] !== v) {
        conflicts[k] = [state.facts[k], v];
      }
    }
    if (Object.keys(conflicts).length > 0) {
      throw new FactConflictError(conflicts);
    }
  }
}
