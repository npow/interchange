/**
 * Orchestrator: task decomposition, graph management, and agent dispatch loop.
 */
import { generateText } from "ai";
import { z } from "zod";
import {
  makeId,
  makeTaskNode,
  makeBaton,
  CyclicDependencyError,
  StateManager,
} from "@interchange/core";
import type {
  Baton,
  InterchangeResult,
  Role,
  RouteConstraints,
  TaskNode,
  ToolCall,
  WorldState,
} from "@interchange/core";
import { resolveModel } from "./models.js";
import { Router } from "./router.js";
import { ContextTranslator } from "./translator.js";
import { defaultTools, type ToolRegistry } from "./tools.js";

const MAX_TOOL_STEPS = 20;

const DECOMPOSE_SYSTEM = `\
You are a task planner. Decompose the given task into sequential or parallel subtasks.
Each subtask must be assigned to exactly one role from the available roles list.

Return ONLY a JSON array (no other text) with this structure:
[
  {
    "id": "step_1",
    "description": "What this subtask does",
    "role": "one of the available roles",
    "depends_on": []
  }
]

Rules:
- Use short IDs like "step_1", "step_2", etc.
- depends_on lists IDs that must complete before this node starts.
- Keep it to the minimum number of steps needed.
- If the task can be done in one step, return a single-element array.
`;

export class Orchestrator {
  private sm: StateManager;
  private router: Router;
  private translator: ContextTranslator;
  private tools: ToolRegistry;
  private plannerRole: string;

  constructor({
    roles,
    stateManager,
    toolRegistry,
    plannerRole = "planner",
  }: {
    roles: Record<string, Role>;
    stateManager?: StateManager;
    toolRegistry?: ToolRegistry;
    plannerRole?: string;
  }) {
    this.sm = stateManager ?? new StateManager();
    this.router = new Router(roles);
    this.translator = new ContextTranslator();
    this.tools = toolRegistry ?? defaultTools();
    this.plannerRole = plannerRole;
  }

  /**
   * Execute the full orchestration loop for a WorldState.
   * If the WorldState has no task_nodes yet, decomposes the task first.
   */
  async run(
    state: WorldState,
    constraints: RouteConstraints = {},
    forceRole?: string
  ): Promise<InterchangeResult> {
    const startMs = Date.now();
    let totalTokens = 0;

    // Decompose if needed
    if (Object.keys(state.taskNodes).length === 0) {
      const nodes = await this._decompose(state, constraints);
      const finalNodes =
        nodes.length > 0
          ? nodes
          : [
              makeTaskNode(
                "step_1",
                state.originalTask,
                forceRole ?? this.plannerRole
              ),
            ];
      checkCycles(finalNodes);
      for (const node of finalNodes) {
        state.taskNodes[node.id] = node;
      }
      this.sm.save(state);
    }

    // Dispatch loop
    while (true) {
      const ready = getReadyNodes(state);
      if (ready.length === 0) break;

      const results = await Promise.allSettled(
        ready.map((node) => this._executeNode(state, node, constraints, forceRole))
      );

      for (const [i, result] of results.entries()) {
        const node = ready[i]!;
        if (result.status === "rejected") {
          node.status = "failed";
          this.sm.save(state);
        } else {
          totalTokens += result.value;
        }
      }

      const failed = Object.values(state.taskNodes).filter(
        (n) => n.status === "failed"
      );
      if (failed.length > 0) {
        state.status = "failed";
        this.sm.save(state);
        break;
      }

      if (
        Object.values(state.taskNodes).every((n) =>
          ["completed", "skipped"].includes(n.status)
        )
      ) {
        state.status = "completed";
        this.sm.save(state);
        break;
      }
    }

    const output = collectOutput(state);
    return {
      taskId: state.taskId,
      output,
      status: state.status as InterchangeResult["status"],
      taskNodes: Object.values(state.taskNodes),
      batons: state.batons,
      toolCalls: state.toolCallHistory,
      totalTokens,
      wallTimeMs: Date.now() - startMs,
    };
  }

  // ---------------------------------------------------------------------------
  // Private: decomposition
  // ---------------------------------------------------------------------------

  private async _decompose(
    state: WorldState,
    constraints: RouteConstraints
  ): Promise<TaskNode[]> {
    const decision = this.router.route(
      state.originalTask,
      constraints,
      this.plannerRole
    );
    const roleNames = Object.keys(this.sm["backend"] ? [] : []);
    // We need the role names from the router — expose them via a helper
    const availableRoles = this.router["roles"]
      ? Object.keys(this.router["roles"] as Record<string, Role>)
      : [];

    const { text } = await generateText({
      model: resolveModel(decision.model),
      system:
        DECOMPOSE_SYSTEM + `\n\nAvailable roles: ${JSON.stringify(availableRoles)}`,
      prompt: state.originalTask,
    });

    return parseTaskNodes(text, availableRoles);
  }

  // ---------------------------------------------------------------------------
  // Private: node execution
  // ---------------------------------------------------------------------------

  private async _executeNode(
    state: WorldState,
    node: TaskNode,
    constraints: RouteConstraints,
    forceRole?: string
  ): Promise<number> {
    const decision = this.router.route(
      node.description,
      constraints,
      forceRole
    );
    node.assignedModel = decision.model;
    node.status = "in_progress";
    node.startedAt = new Date().toISOString();
    this.sm.save(state);

    // Use pre-set batonIn (e.g. from runAs) or find from completed dependency
    const batonIn = node.batonIn ?? getIncomingBaton(state, node);
    node.batonIn = batonIn;

    const systemPrompt = this.translator.renderSystemPrompt(
      state,
      batonIn,
      node.role
    );

    const vercelTools = this.tools.toVercelTools();
    let totalTokens = 0;
    const toolCallsForNode: ToolCall[] = [];

    const { text, usage, steps } = await generateText({
      model: resolveModel(decision.model),
      system: systemPrompt,
      prompt: node.description,
      tools: Object.keys(vercelTools).length > 0 ? vercelTools : undefined,
      maxSteps: MAX_TOOL_STEPS,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onStepFinish: async (event: any) => {
        const stepUsage = event.usage as { totalTokens?: number } | undefined;
        totalTokens += stepUsage?.totalTokens ?? 0;
        const toolResults = (event.toolResults ?? []) as Array<{
          toolName: string;
          args: Record<string, unknown>;
          result: unknown;
        }>;
        // Record each tool call in WorldState
        for (const tr of toolResults) {
          const canonical: ToolCall = {
            id: makeId(),
            name: tr.toolName,
            inputs: tr.args,
            result:
              typeof tr.result === "string"
                ? tr.result
                : JSON.stringify(tr.result),
            error: null,
            role: node.role,
            model: decision.model,
            taskNodeId: node.id,
            timestamp: new Date().toISOString(),
          };
          toolCallsForNode.push(canonical);
          this.sm.recordToolCall(state, canonical);
        }
      },
    });

    totalTokens += (usage?.totalTokens as number | undefined) ?? 0;

    // Build and apply baton
    const baton = this._buildBaton(text, state, node, decision.model);
    this.sm.applyBaton(state, baton);

    return totalTokens;
  }

  // ---------------------------------------------------------------------------
  // Private: baton construction
  // ---------------------------------------------------------------------------

  private _buildBaton(
    output: string,
    state: WorldState,
    node: TaskNode,
    model: string
  ): Baton {
    const data = this.translator.parseBatonFromOutput(output);
    const nextRole = getNextRole(state, node);

    if (data) {
      return makeBaton({
        taskId: state.taskId,
        taskNodeId: node.id,
        fromRole: node.role,
        fromModel: model,
        toRole: nextRole,
        facts: (data["facts"] as Record<string, unknown>) ?? {},
        toolCallsSummary: (data["tool_calls_summary"] as string[]) ?? [],
        openQuestions: (data["open_questions"] as string[]) ?? [],
        recommendation: (data["recommendation"] as string) ?? "",
        status: (data["status"] as Baton["status"]) ?? "complete",
      });
    }

    // Fallback: minimal baton with no facts
    return makeBaton({
      taskId: state.taskId,
      taskNodeId: node.id,
      fromRole: node.role,
      fromModel: model,
      toRole: nextRole,
      facts: {},
      toolCallsSummary: [`Completed: ${node.description.slice(0, 100)}`],
      openQuestions: [],
      recommendation: output.slice(0, 200) || "No recommendation.",
      status: "complete",
    });
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

export function checkCycles(nodes: TaskNode[]): void {
  const graph: Record<string, string[]> = Object.fromEntries(
    nodes.map((n) => [n.id, [...n.dependsOn]])
  );
  const visited = new Set<string>();
  const recStack = new Set<string>();

  function dfs(nodeId: string, path: string[]): void {
    visited.add(nodeId);
    recStack.add(nodeId);
    for (const dep of graph[nodeId] ?? []) {
      if (!visited.has(dep)) {
        dfs(dep, [...path, dep]);
      } else if (recStack.has(dep)) {
        throw new CyclicDependencyError([...path, dep]);
      }
    }
    recStack.delete(nodeId);
  }

  for (const nodeId of Object.keys(graph)) {
    if (!visited.has(nodeId)) {
      dfs(nodeId, [nodeId]);
    }
  }
}

export function getReadyNodes(state: WorldState): TaskNode[] {
  const completedIds = new Set(
    Object.entries(state.taskNodes)
      .filter(([, n]) => n.status === "completed")
      .map(([id]) => id)
  );
  return Object.values(state.taskNodes).filter(
    (n) =>
      n.status === "pending" && n.dependsOn.every((dep) => completedIds.has(dep))
  );
}

function getIncomingBaton(state: WorldState, node: TaskNode): Baton | null {
  for (const depId of [...node.dependsOn].reverse()) {
    const dep = state.taskNodes[depId];
    if (dep?.batonOut) return dep.batonOut;
  }
  return null;
}

function getNextRole(state: WorldState, current: TaskNode): string {
  for (const node of Object.values(state.taskNodes)) {
    if (node.dependsOn.includes(current.id) && node.status === "pending") {
      return node.role;
    }
  }
  return current.role;
}

function collectOutput(state: WorldState): string {
  if (state.batons.length === 0) return "";
  const last = state.batons[state.batons.length - 1]!;
  const parts: string[] = [];
  if (last.recommendation) parts.push(last.recommendation);
  if (Object.keys(last.facts).length > 0) {
    parts.push(
      "Facts established:\n" +
        Object.entries(last.facts)
          .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
          .join("\n")
    );
  }
  return parts.join("\n\n");
}

function parseTaskNodes(content: string, validRoles: string[]): TaskNode[] {
  let data: unknown;
  try {
    data = JSON.parse(content.trim());
  } catch {
    const match = content.match(/\[.*\]/s);
    if (!match) return [];
    try {
      data = JSON.parse(match[0]);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(data)) return [];

  const nodes: TaskNode[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const raw = item as Record<string, unknown>;
    let role = (raw["role"] as string) || validRoles[0] || "planner";
    if (validRoles.length > 0 && !validRoles.includes(role)) {
      role = validRoles[0]!;
    }
    nodes.push(
      makeTaskNode(
        (raw["id"] as string) || `step_${nodes.length + 1}`,
        (raw["description"] as string) || "",
        role,
        (raw["depends_on"] as string[]) || []
      )
    );
  }
  return nodes;
}
