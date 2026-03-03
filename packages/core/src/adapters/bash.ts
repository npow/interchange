import { itemId, callId } from "../ids.js";
import type { BashInput, CodexFunctionCall, CodexFunctionCallOutput } from "../types.js";

const MAX_OUTPUT_BYTES = 100_000;

export function truncateOutput(output: string): string {
  const bytes = Buffer.byteLength(output, "utf8");
  if (bytes <= MAX_OUTPUT_BYTES) return output;
  const truncated = Buffer.from(output, "utf8")
    .subarray(0, MAX_OUTPUT_BYTES)
    .toString("utf8");
  return truncated + `\n\n[... truncated ${bytes - MAX_OUTPUT_BYTES} bytes ...]`;
}

function extractOutput(response: unknown): string {
  if (typeof response === "string") return response;
  if (typeof response === "object" && response !== null) {
    const r = response as Record<string, unknown>;
    if (typeof r["output"] === "string") return r["output"];
    const parts: string[] = [];
    if (typeof r["stdout"] === "string" && r["stdout"]) parts.push(r["stdout"]);
    if (typeof r["stderr"] === "string" && r["stderr"])
      parts.push("STDERR:\n" + r["stderr"]);
    if (typeof r["exitCode"] === "number" && r["exitCode"] !== 0)
      parts.push(`[exit ${r["exitCode"]}]`);
    return parts.join("\n").trim();
  }
  return String(response);
}

export function translateBash(
  input: BashInput,
  response: unknown
): [CodexFunctionCall, CodexFunctionCallOutput] {
  const cid = callId();
  const call: CodexFunctionCall = {
    type: "function_call",
    id: itemId(),
    call_id: cid,
    name: "shell",
    arguments: JSON.stringify({ cmd: input.command }),
    status: "completed",
  };
  const output: CodexFunctionCallOutput = {
    type: "function_call_output",
    call_id: cid,
    output: truncateOutput(extractOutput(response)),
  };
  return [call, output];
}
