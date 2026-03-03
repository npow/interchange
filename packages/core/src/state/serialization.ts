/**
 * JSON serialization/deserialization for WorldState and its components.
 * TypeScript camelCase properties ↔ JSON snake_case keys.
 */
import type { Baton, TaskNode, ToolCall, WorldState } from "../types.js";

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// ToolCall
// ---------------------------------------------------------------------------

export function serializeToolCall(tc: ToolCall): Record<string, unknown> {
  return {
    id: tc.id,
    name: tc.name,
    inputs: tc.inputs,
    result: tc.result,
    error: tc.error,
    role: tc.role,
    model: tc.model,
    task_node_id: tc.taskNodeId,
    timestamp: tc.timestamp,
  };
}

export function deserializeToolCall(d: Record<string, unknown>): ToolCall {
  return {
    id: d["id"] as string,
    name: d["name"] as string,
    inputs: (d["inputs"] as Record<string, unknown>) ?? {},
    result: (d["result"] as string | null) ?? null,
    error: (d["error"] as string | null) ?? null,
    role: d["role"] as string,
    model: d["model"] as string,
    taskNodeId: d["task_node_id"] as string,
    timestamp: (d["timestamp"] as string) ?? nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Baton
// ---------------------------------------------------------------------------

export function serializeBaton(b: Baton): Record<string, unknown> {
  return {
    id: b.id,
    task_id: b.taskId,
    task_node_id: b.taskNodeId,
    from_role: b.fromRole,
    from_model: b.fromModel,
    to_role: b.toRole,
    facts: b.facts,
    open_questions: b.openQuestions,
    recommendation: b.recommendation,
    status: b.status,
    tool_calls_summary: b.toolCallsSummary,
    created_at: b.createdAt,
  };
}

export function deserializeBaton(d: Record<string, unknown>): Baton {
  return {
    id: d["id"] as string,
    taskId: d["task_id"] as string,
    taskNodeId: d["task_node_id"] as string,
    fromRole: d["from_role"] as string,
    fromModel: d["from_model"] as string,
    toRole: d["to_role"] as string,
    facts: (d["facts"] as Record<string, unknown>) ?? {},
    openQuestions: (d["open_questions"] as string[]) ?? [],
    recommendation: (d["recommendation"] as string) ?? "",
    status: d["status"] as Baton["status"],
    toolCallsSummary: (d["tool_calls_summary"] as string[]) ?? [],
    createdAt: (d["created_at"] as string) ?? nowIso(),
  };
}

// ---------------------------------------------------------------------------
// TaskNode
// ---------------------------------------------------------------------------

export function serializeNode(n: TaskNode): Record<string, unknown> {
  return {
    id: n.id,
    description: n.description,
    role: n.role,
    depends_on: n.dependsOn,
    status: n.status,
    assigned_model: n.assignedModel,
    baton_in: n.batonIn ? serializeBaton(n.batonIn) : null,
    baton_out: n.batonOut ? serializeBaton(n.batonOut) : null,
    started_at: n.startedAt,
    completed_at: n.completedAt,
  };
}

export function deserializeNode(d: Record<string, unknown>): TaskNode {
  return {
    id: d["id"] as string,
    description: d["description"] as string,
    role: d["role"] as string,
    dependsOn: (d["depends_on"] as string[]) ?? [],
    status: (d["status"] as TaskNode["status"]) ?? "pending",
    assignedModel: (d["assigned_model"] as string | null) ?? null,
    batonIn: d["baton_in"]
      ? deserializeBaton(d["baton_in"] as Record<string, unknown>)
      : null,
    batonOut: d["baton_out"]
      ? deserializeBaton(d["baton_out"] as Record<string, unknown>)
      : null,
    startedAt: (d["started_at"] as string | null) ?? null,
    completedAt: (d["completed_at"] as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// WorldState
// ---------------------------------------------------------------------------

export function serializeState(state: WorldState): Record<string, unknown> {
  return {
    task_id: state.taskId,
    original_task: state.originalTask,
    task_nodes: Object.fromEntries(
      Object.entries(state.taskNodes).map(([k, v]) => [k, serializeNode(v)])
    ),
    facts: state.facts,
    tool_call_history: state.toolCallHistory.map(serializeToolCall),
    batons: state.batons.map(serializeBaton),
    status: state.status,
    created_at: state.createdAt,
    updated_at: state.updatedAt,
    version: state.version,
  };
}

export function deserializeState(d: Record<string, unknown>): WorldState {
  const rawNodes = (d["task_nodes"] as Record<string, Record<string, unknown>>) ?? {};
  return {
    taskId: d["task_id"] as string,
    originalTask: d["original_task"] as string,
    taskNodes: Object.fromEntries(
      Object.entries(rawNodes).map(([k, v]) => [k, deserializeNode(v)])
    ),
    facts: (d["facts"] as Record<string, unknown>) ?? {},
    toolCallHistory: (
      (d["tool_call_history"] as Array<Record<string, unknown>>) ?? []
    ).map(deserializeToolCall),
    batons: ((d["batons"] as Array<Record<string, unknown>>) ?? []).map(
      deserializeBaton
    ),
    status: (d["status"] as WorldState["status"]) ?? "running",
    createdAt: (d["created_at"] as string) ?? nowIso(),
    updatedAt: (d["updated_at"] as string) ?? nowIso(),
    version: (d["version"] as number) ?? 0,
  };
}
