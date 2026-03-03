// ─── Public API ───────────────────────────────────────────────────────────────

export { distillSession, recordsToText, DISTILL_MODEL } from "./distill.js";

export {
  formatBatonForAgent,
  parseBatonFromOutput,
} from "./inject.js";
export type { AgentTarget } from "./inject.js";

export {
  handleStopHook,
  getStateDir,
  getStateFile,
} from "./hooks.js";

export { startMcpServer } from "./mcp.js";

export { resolveModel } from "./models.js";

// Re-export everything from @interchange/core for convenience
export * from "@interchange/core";
