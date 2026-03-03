// ─── Claude Code types ────────────────────────────────────────────────────────

export interface ClaudeRecord {
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string; // ISO-8601
  version: string;
  gitBranch?: string;
  cwd: string;
  message: ClaudeMessage;
  isSidechain?: boolean;
  costUSD?: number;
}

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: ClaudeContentBlock | ClaudeContentBlock[];
  model?: string;
  usage?: ClaudeUsage;
}

export type ClaudeContentBlock =
  | { type: "text"; text: string }
  | ClaudeToolUse
  | ClaudeToolResult
  | { type: "thinking"; thinking: string; signature?: string };

export interface ClaudeToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ClaudeToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string | ClaudeContentBlock[];
  is_error?: boolean;
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// ─── Claude tool input types ──────────────────────────────────────────────────

export interface BashInput {
  command: string;
  description?: string;
  timeout?: number;
  restart?: boolean;
}

export interface ReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

export interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
}

export interface MultiEditOperation {
  old_string: string;
  new_string: string;
}

export interface MultiEditInput {
  file_path: string;
  edits: MultiEditOperation[];
}

export interface WriteInput {
  file_path: string;
  content: string;
}

export interface GlobInput {
  pattern: string;
  path?: string;
}

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: "content" | "files_with_matches" | "count";
  case_insensitive?: boolean;
  context?: number;
  "-A"?: number;
  "-B"?: number;
  "-C"?: number;
  "-n"?: boolean;
  "-i"?: boolean;
}

// ─── Codex rollout item types (OpenAI Responses API) ─────────────────────────

export interface CodexMessage {
  type: "message";
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  status?: "completed" | "in_progress";
}

export interface CodexFunctionCall {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string; // JSON-encoded string
  status?: "completed" | "in_progress";
}

export interface CodexFunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export type CodexRolloutItem =
  | CodexMessage
  | CodexFunctionCall
  | CodexFunctionCallOutput;

// ─── Hook event types ─────────────────────────────────────────────────────────

export interface PostToolUseEvent {
  hook_event_name: "PostToolUse";
  session_id: string;
  transcript_path: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: unknown;
  tool_use_id: string;
}

export interface StopEvent {
  hook_event_name: "Stop";
  session_id: string;
  transcript_path: string;
  stop_hook_active: boolean;
}

export type HookEvent = PostToolUseEvent | StopEvent;

// ─── Translation result types ─────────────────────────────────────────────────

export interface TranslationResult {
  records: CodexRolloutItem[];
  dropped: DroppedItem[];
}

export interface DroppedItem {
  source_uuid: string;
  reason: "thinking_block" | "mcp_tool" | "unknown_tool" | "empty_content";
  summary: string;
}

// ─── Interchange handoff types ────────────────────────────────────────────────

/** A decision made during a session, with rationale. */
export interface BatonDecision {
  what: string;
  why: string;
}

/** Canonical, model-agnostic tool call record stored in WorldState. */
export interface ToolCall {
  id: string;
  name: string;
  inputs: Record<string, unknown>;
  result: string | null;
  error: string | null;
  role: string;
  model: string;
  taskNodeId: string;
  timestamp: string; // ISO-8601
}

/** Typed handoff written by the outgoing agent, read by the incoming agent. */
export interface Baton {
  id: string;
  taskId: string;
  taskNodeId: string;
  fromRole: string;
  fromModel: string;
  toRole: string;
  facts: Record<string, unknown>;
  /** Explicit decisions made with their rationale — do not re-litigate these. */
  decisions: BatonDecision[];
  /** Approaches tried during this session that did not work and why. */
  triedAndRejected: BatonDecision[];
  openQuestions: string[];
  nextSteps: string[];
  recommendation: string;
  status: "complete" | "partial" | "blocked";
  toolCallsSummary: string[];
  createdAt: string; // ISO-8601
}

/** A single unit of work in the task graph. */
export interface TaskNode {
  id: string;
  description: string;
  role: string;
  dependsOn: string[];
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  assignedModel: string | null;
  batonIn: Baton | null;
  batonOut: Baton | null;
  startedAt: string | null; // ISO-8601
  completedAt: string | null; // ISO-8601
}

/**
 * Canonical state maintained independently of any model's message history.
 * Structured facts replace raw message history, keeping size sub-linear
 * with task depth.
 */
export interface WorldState {
  taskId: string;
  originalTask: string;
  taskNodes: Record<string, TaskNode>;
  facts: Record<string, unknown>;
  toolCallHistory: ToolCall[];
  batons: Baton[];
  status: "running" | "completed" | "failed" | "paused";
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
  version: number; // incremented on each save
}

