import { itemId, callId } from "../ids.js";
import type { GrepInput, CodexFunctionCall, CodexFunctionCallOutput } from "../types.js";

function extractMatches(response: unknown): string {
  if (typeof response === "string") return response;
  if (typeof response === "object" && response !== null) {
    const r = response as Record<string, unknown>;
    if (typeof r["output"] === "string") return r["output"];
    if (typeof r["content"] === "string") return r["content"];
  }
  return String(response);
}

function buildCmd(input: GrepInput): string {
  const flags: string[] = [];
  if (input.case_insensitive ?? input["-i"]) flags.push("-i");
  if (input.context) flags.push(`-C${input.context}`);
  else {
    if (input["-A"]) flags.push(`-A${input["-A"]}`);
    if (input["-B"]) flags.push(`-B${input["-B"]}`);
  }
  if (input.output_mode === "files_with_matches") flags.push("-l");
  if (input.output_mode === "count") flags.push("-c");
  if (input.glob) flags.push(`-g '${input.glob}'`);

  const flagStr = flags.length ? " " + flags.join(" ") : "";
  const searchPath = input.path ? ` ${input.path}` : "";
  return `rg${flagStr} '${input.pattern}'${searchPath}`;
}

export function translateGrep(
  input: GrepInput,
  response: unknown
): [CodexFunctionCall, CodexFunctionCallOutput] {
  const cid = callId();
  const call: CodexFunctionCall = {
    type: "function_call",
    id: itemId(),
    call_id: cid,
    name: "shell",
    arguments: JSON.stringify({ cmd: buildCmd(input) }),
    status: "completed",
  };
  const output: CodexFunctionCallOutput = {
    type: "function_call_output",
    call_id: cid,
    output: extractMatches(response),
  };
  return [call, output];
}
