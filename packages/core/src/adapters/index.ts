import { itemId } from "../ids.js";
import { translateBash } from "./bash.js";
import { translateRead } from "./read.js";
import { translateEdit, translateMultiEdit } from "./edit.js";
import { translateWrite } from "./write.js";
import { translateGlob } from "./glob.js";
import { translateGrep } from "./grep.js";
import type {
  ClaudeRecord,
  ClaudeContentBlock,
  ClaudeToolUse,
  CodexRolloutItem,
  CodexMessage,
  TranslationResult,
  DroppedItem,
  BashInput,
  ReadInput,
  EditInput,
  MultiEditInput,
  WriteInput,
  GlobInput,
  GrepInput,
} from "../types.js";

export { translateBash } from "./bash.js";
export { translateRead, stripLineNumbers } from "./read.js";
export { translateEdit, translateMultiEdit } from "./edit.js";
export { translateWrite } from "./write.js";
export { translateGlob } from "./glob.js";
export { translateGrep } from "./grep.js";

/** Translate a single ClaudeRecord to zero or more Codex rollout items. */
export function translateRecord(record: ClaudeRecord): TranslationResult {
  const records: CodexRolloutItem[] = [];
  const dropped: DroppedItem[] = [];

  const blocks = Array.isArray(record.message.content)
    ? record.message.content
    : [record.message.content];

  const role = record.message.role;

  for (const block of blocks) {
    const result = translateBlock(block, role, record.uuid);
    records.push(...result.records);
    dropped.push(...result.dropped);
  }

  return { records, dropped };
}

function translateBlock(
  block: ClaudeContentBlock,
  role: "user" | "assistant",
  sourceUuid: string
): TranslationResult {
  const records: CodexRolloutItem[] = [];
  const dropped: DroppedItem[] = [];

  switch (block.type) {
    case "text": {
      if (!block.text.trim()) break;
      const msg: CodexMessage = {
        type: "message",
        id: itemId(),
        role,
        content: block.text,
        status: "completed",
      };
      records.push(msg);
      break;
    }

    case "tool_use": {
      const toolRecords = translateToolUse(block, sourceUuid);
      records.push(...toolRecords.records);
      dropped.push(...toolRecords.dropped);
      break;
    }

    case "tool_result": {
      // tool_result blocks are paired with tool_use — the output is emitted
      // as part of translateToolUse. Standalone tool_result in a user message
      // can appear when Claude Code reconstructs from transcript; emit as text.
      const content =
        typeof block.content === "string"
          ? block.content
          : extractTextFromBlocks(block.content);
      if (content.trim()) {
        records.push({
          type: "message",
          id: itemId(),
          role: "user",
          content: `[Tool result: ${content}]`,
          status: "completed",
        });
      }
      break;
    }

    case "thinking": {
      dropped.push({
        source_uuid: sourceUuid,
        reason: "thinking_block",
        summary: `Extended thinking block (~${Math.ceil(block.thinking.length / 4)} tokens)`,
      });
      break;
    }
  }

  return { records, dropped };
}

function translateToolUse(
  block: ClaudeToolUse,
  sourceUuid: string
): TranslationResult {
  const records: CodexRolloutItem[] = [];
  const dropped: DroppedItem[] = [];
  const { name, input } = block;

  // MCP tools follow the pattern "mcp__<server>__<tool>"
  if (name.startsWith("mcp__")) {
    const [, server, tool] = name.split("__");
    dropped.push({
      source_uuid: sourceUuid,
      reason: "mcp_tool",
      summary: `MCP tool call: ${server}/${tool}`,
    });
    records.push({
      type: "message",
      id: itemId(),
      role: "assistant",
      content: `[MCP tool: ${server}/${tool} — not translatable, omitted from history]`,
      status: "completed",
    });
    return { records, dropped };
  }

  try {
    switch (name) {
      case "Bash":
        records.push(...translateBash(input as unknown as BashInput, undefined));
        break;
      case "Read":
        records.push(...translateRead(input as unknown as ReadInput, undefined));
        break;
      case "Edit":
        records.push(...translateEdit(input as unknown as EditInput, undefined));
        break;
      case "MultiEdit":
        records.push(...translateMultiEdit(input as unknown as MultiEditInput, undefined));
        break;
      case "Write":
        records.push(...translateWrite(input as unknown as WriteInput, undefined));
        break;
      case "Glob":
        records.push(...translateGlob(input as unknown as GlobInput, undefined));
        break;
      case "Grep":
        records.push(...translateGrep(input as unknown as GrepInput, undefined));
        break;
      case "WebFetch":
      case "WebSearch":
      case "TodoRead":
      case "TodoWrite":
      case "NotebookEdit":
      case "NotebookRead":
        records.push({
          type: "message",
          id: itemId(),
          role: "assistant",
          content: `[${name} call — translated as annotation]`,
          status: "completed",
        });
        break;
      default:
        dropped.push({
          source_uuid: sourceUuid,
          reason: "unknown_tool",
          summary: `Unknown tool: ${name}`,
        });
    }
  } catch (err) {
    dropped.push({
      source_uuid: sourceUuid,
      reason: "unknown_tool",
      summary: `Translation error for ${name}: ${String(err)}`,
    });
  }

  return { records, dropped };
}

/**
 * Translate a tool_use + its paired tool_result together.
 * Called by the hook handler which has both sides of the exchange.
 */
export function translateToolExchange(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResponse: unknown,
  sourceUuid: string
): TranslationResult {
  const records: CodexRolloutItem[] = [];
  const dropped: DroppedItem[] = [];

  if (toolName.startsWith("mcp__")) {
    const parts = toolName.split("__");
    const server = parts[1] ?? "unknown";
    const tool = parts[2] ?? "unknown";
    dropped.push({
      source_uuid: sourceUuid,
      reason: "mcp_tool",
      summary: `MCP tool call: ${server}/${tool}`,
    });
    records.push({
      type: "message",
      id: itemId(),
      role: "assistant",
      content: `[MCP tool: ${server}/${tool} — not translatable, omitted from history]`,
      status: "completed",
    });
    return { records, dropped };
  }

  try {
    switch (toolName) {
      case "Bash":
        records.push(...translateBash(toolInput as unknown as BashInput, toolResponse));
        break;
      case "Read":
        records.push(...translateRead(toolInput as unknown as ReadInput, toolResponse));
        break;
      case "Edit":
        records.push(...translateEdit(toolInput as unknown as EditInput, toolResponse));
        break;
      case "MultiEdit":
        records.push(...translateMultiEdit(toolInput as unknown as MultiEditInput, toolResponse));
        break;
      case "Write":
        records.push(...translateWrite(toolInput as unknown as WriteInput, toolResponse));
        break;
      case "Glob":
        records.push(...translateGlob(toolInput as unknown as GlobInput, toolResponse));
        break;
      case "Grep":
        records.push(...translateGrep(toolInput as unknown as GrepInput, toolResponse));
        break;
      case "WebFetch":
      case "WebSearch":
      case "TodoRead":
      case "TodoWrite":
      case "NotebookEdit":
      case "NotebookRead":
        records.push({
          type: "message",
          id: itemId(),
          role: "assistant",
          content: `[${toolName} call — translated as annotation]`,
          status: "completed",
        });
        break;
      default:
        dropped.push({
          source_uuid: sourceUuid,
          reason: "unknown_tool",
          summary: `Unknown tool: ${toolName}`,
        });
    }
  } catch (err) {
    dropped.push({
      source_uuid: sourceUuid,
      reason: "unknown_tool",
      summary: `Translation error for ${toolName}: ${String(err)}`,
    });
  }

  return { records, dropped };
}

function extractTextFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return String(blocks);
  return blocks
    .map((b: unknown) =>
      typeof b === "object" && b !== null && "text" in b
        ? String((b as { text: unknown }).text)
        : ""
    )
    .join("");
}
