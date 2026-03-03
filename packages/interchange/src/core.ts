/**
 * Interchange: public API.
 *
 * Usage:
 *   const ix = new Interchange({ roles: { ... } });
 *   const result = await ix.run("Write a web server in Node.js");
 */
import { makeId, StateManager, makeWorldState } from "@interchange/core";
import type {
  InterchangeResult,
  Role,
  RouteConstraints,
  WorldState,
} from "@interchange/core";
import { Orchestrator } from "./orchestrator.js";
import { defaultTools, type ToolRegistry } from "./tools.js";
import { type StateBackend } from "@interchange/core";

/** Default role configuration — suitable for general software engineering tasks. */
export const DEFAULT_ROLES: Record<string, Role> = {
  planner: {
    preferredModel: "claude-opus-4-6",
    fallbackModel: "claude-sonnet-4-6",
    capabilities: ["plan", "decompose", "design", "architect", "strategy"],
    allowedTools: null,
  },
  coder: {
    preferredModel: "gpt-4o",
    fallbackModel: "claude-sonnet-4-6",
    capabilities: [
      "implement",
      "code",
      "function",
      "class",
      "fix",
      "bug",
      "write",
    ],
    allowedTools: null,
  },
  reviewer: {
    preferredModel: "claude-sonnet-4-6",
    fallbackModel: "gpt-4o",
    capabilities: [
      "review",
      "check",
      "audit",
      "verify",
      "test",
      "quality",
      "lint",
    ],
    allowedTools: null,
  },
  researcher: {
    preferredModel: "gemini-2.0-flash",
    fallbackModel: "claude-sonnet-4-6",
    capabilities: [
      "research",
      "search",
      "find",
      "look up",
      "investigate",
      "analyze",
    ],
    allowedTools: null,
  },
};

export interface InterchangeOptions {
  roles?: Record<string, Role>;
  stateBackend?: StateBackend;
  toolRegistry?: ToolRegistry;
  plannerRole?: string;
}

/** Handle for resuming an interrupted task. */
export interface ResumeHandle {
  taskId: string;
  state: WorldState;
}

export class Interchange {
  private orchestrator: Orchestrator;
  private sm: StateManager;

  constructor(options: InterchangeOptions = {}) {
    const roles = options.roles ?? DEFAULT_ROLES;
    this.sm = new StateManager(options.stateBackend);
    this.orchestrator = new Orchestrator({
      roles,
      stateManager: this.sm,
      toolRegistry: options.toolRegistry ?? defaultTools(),
      plannerRole: options.plannerRole ?? "planner",
    });
  }

  /**
   * Run a task from scratch, automatically decomposing and routing to agents.
   */
  async run(
    task: string,
    constraints?: RouteConstraints
  ): Promise<InterchangeResult> {
    const taskId = makeId();
    const state = this.sm.create(taskId, task);
    return this.orchestrator.run(state, constraints);
  }

  /**
   * Run a task forcing a specific role, skipping decomposition.
   */
  async runAs(
    task: string,
    role: string,
    constraints?: RouteConstraints
  ): Promise<InterchangeResult> {
    const taskId = makeId();
    const state = this.sm.create(taskId, task);
    return this.orchestrator.run(state, constraints, role);
  }

  /**
   * Resume an interrupted task from its saved state.
   */
  async resume(
    handle: ResumeHandle,
    constraints?: RouteConstraints
  ): Promise<InterchangeResult> {
    const state = this.sm.get(handle.taskId);
    // Reset any in_progress nodes to pending so they re-run
    for (const node of Object.values(state.taskNodes)) {
      if (node.status === "in_progress") {
        node.status = "pending";
      }
    }
    state.status = "running";
    this.sm.save(state);
    return this.orchestrator.run(state, constraints);
  }

  /** Get the current state of a task by ID. */
  getState(taskId: string): WorldState {
    return this.sm.get(taskId);
  }

  /** List all known task IDs. */
  listTasks(): string[] {
    return this.sm.listTasks();
  }
}
