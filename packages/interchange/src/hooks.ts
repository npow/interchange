/**
 * Claude Code hook handlers for interchange.
 *
 * The Stop hook fires when a Claude Code session ends. It reads the session
 * transcript, distills it into a Baton, and saves it to .interchange/state.json
 * in the project directory.
 *
 * Register in ~/.claude/settings.json:
 *
 *   "hooks": {
 *     "Stop": [{
 *       "matcher": "",
 *       "hooks": [{ "type": "command", "command": "interchange distill-hook" }]
 *     }]
 *   }
 */
import { readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { JSONFileBackend, StateManager } from "@npow/interchange-core";
import type { StopEvent, ClaudeRecord } from "@npow/interchange-core";
import { distillSession } from "./distill.js";

export function getStateDir(projectDir: string): string {
  return join(projectDir, ".interchange");
}

export function getStateFile(projectDir: string): string {
  return join(getStateDir(projectDir), "state.json");
}

/** Read ClaudeRecords from a JSONL transcript file. */
function readTranscript(transcriptPath: string): ClaudeRecord[] {
  const content = readFileSync(transcriptPath, "utf8");
  const records: ClaudeRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as ClaudeRecord;
      if (record.message && record.uuid) {
        records.push(record);
      }
    } catch {
      // malformed line — skip
    }
  }
  return records;
}

/**
 * Handle a Claude Code Stop hook event.
 *
 * Reads the session transcript, distills it into a Baton, and merges it
 * into the project's WorldState.
 *
 * @param event      - The StopEvent from Claude Code (read from stdin)
 * @param projectDir - Project root directory (default: cwd)
 * @param model      - Model to use for distillation (default: claude-haiku)
 */
export async function handleStopHook(
  event: StopEvent,
  projectDir: string = process.cwd(),
  model?: string
): Promise<void> {
  const { session_id: sessionId, transcript_path: transcriptPath } = event;

  if (!existsSync(transcriptPath)) return;

  const records = readTranscript(transcriptPath);
  if (records.length === 0) return;

  // Ensure .interchange/ exists
  const stateDir = getStateDir(projectDir);
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }

  const stateFile = getStateFile(projectDir);
  const backend = new JSONFileBackend(stateFile);
  const manager = new StateManager(backend);

  let state;
  try {
    state = manager.get(sessionId);
  } catch {
    state = manager.create(sessionId, `Session ${sessionId}`);
  }

  const prior =
    state.batons.length > 0
      ? state.batons[state.batons.length - 1]
      : undefined;

  const baton = await distillSession(records, sessionId, prior, model);

  // applyBaton merges facts and detects conflicts (throws FactConflictError)
  manager.applyBaton(state, baton);
}
