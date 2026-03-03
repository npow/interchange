import { itemId, callId } from "../ids.js";
import type { ReadInput, CodexFunctionCall, CodexFunctionCallOutput } from "../types.js";

const MAX_OUTPUT_BYTES = 100_000;

/**
 * Claude's Read tool returns content formatted by `cat -n`:
 *   "     1\tline one\n     2\tline two\n"
 * Strip the line-number prefix so the resumed agent sees clean file content.
 */
const CAT_N_PREFIX = /^\s*\d+\t/;

export function stripLineNumbers(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(CAT_N_PREFIX, ""))
    .join("\n");
}

function extractContent(response: unknown): string {
  if (typeof response === "string") return response;
  if (typeof response === "object" && response !== null) {
    const r = response as Record<string, unknown>;
    if (typeof r["content"] === "string") return r["content"];
    if (typeof r["output"] === "string") return r["output"];
  }
  return String(response);
}

function buildCmd(input: ReadInput): string {
  if (input.offset !== undefined && input.limit !== undefined) {
    const start = input.offset + 1;
    const end = input.offset + input.limit;
    return `sed -n '${start},${end}p' ${input.file_path}`;
  }
  if (input.offset !== undefined) {
    return `tail -n +${input.offset + 1} ${input.file_path}`;
  }
  if (input.limit !== undefined) {
    return `head -n ${input.limit} ${input.file_path}`;
  }
  return `cat ${input.file_path}`;
}

function truncate(s: string): string {
  const bytes = Buffer.byteLength(s, "utf8");
  if (bytes <= MAX_OUTPUT_BYTES) return s;
  return (
    Buffer.from(s, "utf8").subarray(0, MAX_OUTPUT_BYTES).toString("utf8") +
    `\n[... truncated ${bytes - MAX_OUTPUT_BYTES} bytes ...]`
  );
}

export function translateRead(
  input: ReadInput,
  response: unknown
): [CodexFunctionCall, CodexFunctionCallOutput] {
  const cid = callId();
  const raw = extractContent(response);
  const clean = stripLineNumbers(raw);

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
    output: truncate(clean),
  };
  return [call, output];
}
