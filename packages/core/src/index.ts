// ─── Types ────────────────────────────────────────────────────────────────────
export type {
  // Claude types
  ClaudeRecord,
  ClaudeMessage,
  ClaudeContentBlock,
  ClaudeToolUse,
  ClaudeToolResult,
  ClaudeUsage,
  // Tool input types
  BashInput,
  ReadInput,
  EditInput,
  MultiEditOperation,
  MultiEditInput,
  WriteInput,
  GlobInput,
  GrepInput,
  // Codex output types
  CodexMessage,
  CodexFunctionCall,
  CodexFunctionCallOutput,
  CodexRolloutItem,
  // Hook event types
  PostToolUseEvent,
  StopEvent,
  HookEvent,
  // Translation types
  TranslationResult,
  DroppedItem,
  // Interchange handoff types
  BatonDecision,
  ToolCall,
  Baton,
  TaskNode,
  WorldState,
} from "./types.js";

// ─── Exceptions ───────────────────────────────────────────────────────────────
export {
  InterchangeError,
  FactConflictError,
  CyclicDependencyError,
  RoutingError,
  TranslationError,
  TaskNotFoundError,
  BatonValidationError,
} from "./exceptions.js";

// ─── ID generators ────────────────────────────────────────────────────────────
export { itemId, callId, makeId } from "./ids.js";

// ─── Adapters ─────────────────────────────────────────────────────────────────
export {
  translateRecord,
  translateToolExchange,
  translateBash,
  translateRead,
  translateEdit,
  translateMultiEdit,
  translateWrite,
  translateGlob,
  translateGrep,
  stripLineNumbers,
} from "./adapters/index.js";

// ─── State management ─────────────────────────────────────────────────────────
export {
  StateManager,
  MemoryBackend,
  JSONFileBackend,
  makeWorldState,
  makeTaskNode,
  makeBaton,
  serializeState,
  deserializeState,
} from "./state/index.js";
export type { StateBackend } from "./state/index.js";
