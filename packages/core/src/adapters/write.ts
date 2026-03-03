import { itemId, callId } from "../ids.js";
import type { WriteInput, CodexFunctionCall, CodexFunctionCallOutput } from "../types.js";

/**
 * Write is represented as a shell `tee` command. The file content is NOT
 * re-injected into the shell argument — it was already written to disk by
 * Claude Code, and re-injecting large content would bloat the session history.
 * The output record confirms what was written.
 */
export function translateWrite(
  input: WriteInput,
  _response: unknown
): [CodexFunctionCall, CodexFunctionCallOutput] {
  const cid = callId();
  const byteCount = Buffer.byteLength(input.content, "utf8");
  const lineCount = input.content.split("\n").filter((l) => l.length > 0).length;

  const call: CodexFunctionCall = {
    type: "function_call",
    id: itemId(),
    call_id: cid,
    name: "shell",
    arguments: JSON.stringify({ cmd: `tee ${input.file_path} > /dev/null` }),
    status: "completed",
  };
  const output: CodexFunctionCallOutput = {
    type: "function_call_output",
    call_id: cid,
    output: `Wrote ${lineCount} lines (${byteCount} bytes) to ${input.file_path}`,
  };
  return [call, output];
}
