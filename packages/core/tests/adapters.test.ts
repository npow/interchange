import { describe, it, expect } from "vitest";
import {
  translateBash,
  translateRead,
  translateEdit,
  translateMultiEdit,
  translateWrite,
  translateGlob,
  translateGrep,
  translateRecord,
  translateToolExchange,
  stripLineNumbers,
} from "../src/adapters/index.js";
import type { ClaudeRecord } from "../src/types.js";

// ---------------------------------------------------------------------------
// translateBash
// ---------------------------------------------------------------------------
describe("translateBash", () => {
  it("maps command to shell tool call", () => {
    const [call, output] = translateBash({ command: "echo hello" }, "hello\n");
    expect(call.type).toBe("function_call");
    expect(call.name).toBe("shell");
    expect(JSON.parse(call.arguments)).toEqual({ cmd: "echo hello" });
    expect(output.type).toBe("function_call_output");
    expect(output.output).toBe("hello\n");
    expect(call.call_id).toBe(output.call_id);
  });

  it("extracts output from object response", () => {
    const [, out] = translateBash(
      { command: "ls" },
      { output: "file.txt\n", exitCode: 0 }
    );
    expect(out.output).toBe("file.txt\n");
  });

  it("combines stdout and stderr", () => {
    const [, out] = translateBash(
      { command: "ls" },
      { stdout: "file.txt", stderr: "warning", exitCode: 0 }
    );
    expect(out.output).toContain("file.txt");
    expect(out.output).toContain("STDERR:");
    expect(out.output).toContain("warning");
  });

  it("truncates large output", () => {
    const large = "x".repeat(200_000);
    const [, out] = translateBash({ command: "cat" }, large);
    expect(out.output).toContain("truncated");
    expect(Buffer.byteLength(out.output, "utf8")).toBeLessThan(150_000);
  });

  it("handles undefined response", () => {
    const [, out] = translateBash({ command: "true" }, undefined);
    expect(typeof out.output).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// translateRead
// ---------------------------------------------------------------------------
describe("translateRead", () => {
  it("generates cat command for simple read", () => {
    const [call] = translateRead({ file_path: "/etc/hosts" }, "127.0.0.1 localhost\n");
    expect(JSON.parse(call.arguments)["cmd"]).toBe("cat /etc/hosts");
  });

  it("generates sed command for offset+limit", () => {
    const [call] = translateRead(
      { file_path: "/etc/hosts", offset: 5, limit: 10 },
      ""
    );
    expect(JSON.parse(call.arguments)["cmd"]).toContain("sed");
    expect(JSON.parse(call.arguments)["cmd"]).toContain("6,15p");
  });

  it("strips cat -n line number prefixes from output", () => {
    const raw = "     1\tline one\n     2\tline two\n";
    const [, out] = translateRead({ file_path: "f.ts" }, raw);
    expect(out.output).toBe("line one\nline two\n");
  });
});

describe("stripLineNumbers", () => {
  it("removes cat -n prefixes", () => {
    expect(stripLineNumbers("  1\thello\n  2\tworld")).toBe("hello\nworld");
  });

  it("leaves content without prefixes unchanged", () => {
    expect(stripLineNumbers("no prefix here")).toBe("no prefix here");
  });
});

// ---------------------------------------------------------------------------
// translateEdit
// ---------------------------------------------------------------------------
describe("translateEdit", () => {
  it("maps to str_replace_based_edit", () => {
    const [call, out] = translateEdit(
      { file_path: "src/foo.ts", old_string: "let x", new_string: "const x" },
      "Edit applied successfully"
    );
    expect(call.name).toBe("str_replace_based_edit");
    const args = JSON.parse(call.arguments);
    expect(args["path"]).toBe("src/foo.ts");
    expect(args["old_string"]).toBe("let x");
    expect(args["new_string"]).toBe("const x");
    expect(out.output).toBe("Edit applied successfully");
    expect(call.call_id).toBe(out.call_id);
  });
});

// ---------------------------------------------------------------------------
// translateMultiEdit
// ---------------------------------------------------------------------------
describe("translateMultiEdit", () => {
  it("emits one str_replace per operation", () => {
    const items = translateMultiEdit(
      {
        file_path: "foo.ts",
        edits: [
          { old_string: "a", new_string: "b" },
          { old_string: "c", new_string: "d" },
        ],
      },
      "done"
    );
    const calls = items.filter((i) => i.type === "function_call");
    const outputs = items.filter((i) => i.type === "function_call_output");
    expect(calls).toHaveLength(2);
    expect(outputs).toHaveLength(2);
    // Last output carries the real result
    expect(outputs[outputs.length - 1]!.output).toBe("done");
    // Intermediate outputs show "applied"
    expect(outputs[0]!.output).toBe("Edit applied successfully");
  });
});

// ---------------------------------------------------------------------------
// translateWrite
// ---------------------------------------------------------------------------
describe("translateWrite", () => {
  it("uses tee command", () => {
    const [call, out] = translateWrite(
      { file_path: "out.txt", content: "hello\nworld\n" },
      null
    );
    expect(JSON.parse(call.arguments)["cmd"]).toContain("tee out.txt");
    expect(out.output).toContain("out.txt");
    expect(out.output).toContain("bytes");
  });
});

// ---------------------------------------------------------------------------
// translateGlob
// ---------------------------------------------------------------------------
describe("translateGlob", () => {
  it("generates find command", () => {
    const [call, out] = translateGlob(
      { pattern: "*.ts", path: "src" },
      "src/foo.ts\nsrc/bar.ts\n"
    );
    const cmd = JSON.parse(call.arguments)["cmd"] as string;
    expect(cmd).toContain("find src");
    expect(cmd).toContain("*.ts");
    expect(out.output).toContain("src/foo.ts");
  });

  it("uses . as default search dir", () => {
    const [call] = translateGlob({ pattern: "*.ts" }, "");
    expect(JSON.parse(call.arguments)["cmd"]).toContain("find .");
  });
});

// ---------------------------------------------------------------------------
// translateGrep
// ---------------------------------------------------------------------------
describe("translateGrep", () => {
  it("generates rg command", () => {
    const [call] = translateGrep({ pattern: "TODO" }, "file.ts:42:TODO: fix me");
    expect(JSON.parse(call.arguments)["cmd"]).toContain("rg");
    expect(JSON.parse(call.arguments)["cmd"]).toContain("TODO");
  });

  it("adds -i for case_insensitive", () => {
    const [call] = translateGrep({ pattern: "foo", case_insensitive: true }, "");
    expect(JSON.parse(call.arguments)["cmd"]).toContain("-i");
  });

  it("adds -l for files_with_matches", () => {
    const [call] = translateGrep(
      { pattern: "foo", output_mode: "files_with_matches" },
      ""
    );
    expect(JSON.parse(call.arguments)["cmd"]).toContain("-l");
  });

  it("adds context flags", () => {
    const [call] = translateGrep({ pattern: "foo", context: 3 }, "");
    expect(JSON.parse(call.arguments)["cmd"]).toContain("-C3");
  });
});

// ---------------------------------------------------------------------------
// translateRecord
// ---------------------------------------------------------------------------
describe("translateRecord", () => {
  function makeRecord(content: unknown): ClaudeRecord {
    return {
      uuid: "test-uuid",
      parentUuid: null,
      sessionId: "sess-1",
      timestamp: new Date().toISOString(),
      version: "1",
      cwd: "/tmp",
      message: {
        role: "assistant",
        content: content as ClaudeRecord["message"]["content"],
      },
    };
  }

  it("translates text blocks", () => {
    const rec = makeRecord([{ type: "text", text: "Hello, world!" }]);
    const { records, dropped } = translateRecord(rec);
    expect(records).toHaveLength(1);
    expect(records[0]!.type).toBe("message");
    if (records[0]!.type === "message") {
      expect(records[0]!.content).toBe("Hello, world!");
    }
    expect(dropped).toHaveLength(0);
  });

  it("drops empty text blocks", () => {
    const rec = makeRecord([{ type: "text", text: "   " }]);
    const { records } = translateRecord(rec);
    expect(records).toHaveLength(0);
  });

  it("drops thinking blocks", () => {
    const rec = makeRecord([{ type: "thinking", thinking: "hmm...", signature: "" }]);
    const { records, dropped } = translateRecord(rec);
    expect(records).toHaveLength(0);
    expect(dropped[0]!.reason).toBe("thinking_block");
  });

  it("translates Bash tool_use blocks", () => {
    const rec = makeRecord([
      {
        type: "tool_use",
        id: "tool-1",
        name: "Bash",
        input: { command: "ls" },
      },
    ]);
    const { records } = translateRecord(rec);
    expect(records).toHaveLength(2); // call + output
    expect(records[0]!.type).toBe("function_call");
  });

  it("annotates MCP tool calls and marks dropped", () => {
    const rec = makeRecord([
      {
        type: "tool_use",
        id: "t1",
        name: "mcp__server__tool",
        input: {},
      },
    ]);
    const { records, dropped } = translateRecord(rec);
    expect(dropped[0]!.reason).toBe("mcp_tool");
    // Annotation message is still emitted
    expect(records).toHaveLength(1);
    expect(records[0]!.type).toBe("message");
  });

  it("marks unknown tools as dropped", () => {
    const rec = makeRecord([
      { type: "tool_use", id: "t1", name: "UnknownTool", input: {} },
    ]);
    const { dropped } = translateRecord(rec);
    expect(dropped[0]!.reason).toBe("unknown_tool");
  });

  it("handles single (non-array) content block", () => {
    const rec = makeRecord({ type: "text", text: "hi" });
    const { records } = translateRecord(rec);
    expect(records).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// translateToolExchange
// ---------------------------------------------------------------------------
describe("translateToolExchange", () => {
  it("translates Bash exchange", () => {
    const { records, dropped } = translateToolExchange(
      "Bash",
      { command: "echo hi" },
      "hi",
      "uuid-1"
    );
    expect(dropped).toHaveLength(0);
    expect(records[0]!.type).toBe("function_call");
    expect(records[1]!.type).toBe("function_call_output");
  });

  it("handles MCP tools", () => {
    const { records, dropped } = translateToolExchange(
      "mcp__server__mytool",
      {},
      "result",
      "uuid-2"
    );
    expect(dropped[0]!.reason).toBe("mcp_tool");
    expect(records[0]!.type).toBe("message");
  });

  it("handles unknown tools", () => {
    const { dropped } = translateToolExchange(
      "WeirdTool",
      {},
      null,
      "uuid-3"
    );
    expect(dropped[0]!.reason).toBe("unknown_tool");
  });

  it("handles annotated tools (WebFetch etc.)", () => {
    const { records, dropped } = translateToolExchange(
      "WebFetch",
      {},
      null,
      "uuid-4"
    );
    expect(dropped).toHaveLength(0);
    expect(records[0]!.type).toBe("message");
  });
});
