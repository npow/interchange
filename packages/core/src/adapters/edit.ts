import { itemId, callId } from "../ids.js";
import type {
  EditInput,
  MultiEditInput,
  CodexFunctionCall,
  CodexFunctionCallOutput,
} from "../types.js";

function extractResult(response: unknown): string {
  if (typeof response === "string") return response;
  if (typeof response === "object" && response !== null) {
    const r = response as Record<string, unknown>;
    if (typeof r["result"] === "string") return r["result"];
    if (r["success"] === true) return "Edit applied successfully";
    if (typeof r["error"] === "string") return `Error: ${r["error"]}`;
  }
  return "Edit applied successfully";
}

/**
 * Maps directly to Codex's `str_replace_based_edit` tool which uses
 * identical old_string/new_string semantics.
 */
export function translateEdit(
  input: EditInput,
  response: unknown
): [CodexFunctionCall, CodexFunctionCallOutput] {
  const cid = callId();
  const call: CodexFunctionCall = {
    type: "function_call",
    id: itemId(),
    call_id: cid,
    name: "str_replace_based_edit",
    arguments: JSON.stringify({
      path: input.file_path,
      old_string: input.old_string,
      new_string: input.new_string,
    }),
    status: "completed",
  };
  const output: CodexFunctionCallOutput = {
    type: "function_call_output",
    call_id: cid,
    output: extractResult(response),
  };
  return [call, output];
}

/** MultiEdit: emit one str_replace_based_edit per operation. */
export function translateMultiEdit(
  input: MultiEditInput,
  response: unknown
): Array<CodexFunctionCall | CodexFunctionCallOutput> {
  const result = extractResult(response);
  const records: Array<CodexFunctionCall | CodexFunctionCallOutput> = [];

  for (let i = 0; i < input.edits.length; i++) {
    const edit = input.edits[i];
    if (!edit) continue;
    const cid = callId();
    records.push({
      type: "function_call",
      id: itemId(),
      call_id: cid,
      name: "str_replace_based_edit",
      arguments: JSON.stringify({
        path: input.file_path,
        old_string: edit.old_string,
        new_string: edit.new_string,
      }),
      status: "completed",
    });
    // Only the last operation carries the actual result; others show "applied"
    records.push({
      type: "function_call_output",
      call_id: cid,
      output: i === input.edits.length - 1 ? result : "Edit applied successfully",
    });
  }

  return records;
}
