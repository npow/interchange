import { itemId, callId } from "../ids.js";
import type { GlobInput, CodexFunctionCall, CodexFunctionCallOutput } from "../types.js";

function extractMatches(response: unknown): string {
  if (typeof response === "string") return response;
  if (Array.isArray(response)) return response.join("\n");
  if (typeof response === "object" && response !== null) {
    const r = response as Record<string, unknown>;
    if (Array.isArray(r["files"])) return (r["files"] as string[]).join("\n");
    if (typeof r["output"] === "string") return r["output"];
  }
  return String(response);
}

export function translateGlob(
  input: GlobInput,
  response: unknown
): [CodexFunctionCall, CodexFunctionCallOutput] {
  const cid = callId();
  const searchDir = input.path ?? ".";
  const cmd = `find ${searchDir} -name '${input.pattern}' | sort`;

  const call: CodexFunctionCall = {
    type: "function_call",
    id: itemId(),
    call_id: cid,
    name: "shell",
    arguments: JSON.stringify({ cmd }),
    status: "completed",
  };
  const output: CodexFunctionCallOutput = {
    type: "function_call_output",
    call_id: cid,
    output: extractMatches(response),
  };
  return [call, output];
}
