/**
 * ToolRegistry: manages tool definitions and converts to Vercel AI SDK format.
 *
 * Tools are defined with a Zod schema for parameters. The registry handles
 * execution and provides the tool map expected by generateText().
 */
import { tool, type CoreTool } from "ai";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { readFile, writeFile } from "fs/promises";

const execAsync = promisify(exec);

export interface ToolDefinition<T extends z.ZodSchema = z.ZodSchema> {
  description: string;
  parameters: T;
  execute: (input: z.infer<T>) => Promise<string>;
}

export class ToolRegistry {
  private defs: Map<string, ToolDefinition> = new Map();

  register<T extends z.ZodSchema>(name: string, def: ToolDefinition<T>): this {
    this.defs.set(name, def as unknown as ToolDefinition);
    return this;
  }

  /** Convert to the tool map format expected by Vercel AI SDK's generateText. */
  toVercelTools(): Record<string, CoreTool> {
    const result: Record<string, CoreTool> = {};
    for (const [name, def] of this.defs.entries()) {
      result[name] = tool({
        description: def.description,
        parameters: def.parameters,
        execute: def.execute,
      });
    }
    return result;
  }

  names(): string[] {
    return [...this.defs.keys()];
  }

  has(name: string): boolean {
    return this.defs.has(name);
  }
}

// ---------------------------------------------------------------------------
// Built-in tools
// ---------------------------------------------------------------------------

const bashDef: ToolDefinition<z.ZodObject<{ command: z.ZodString; timeout: z.ZodOptional<z.ZodNumber> }>> = {
  description: "Execute a shell command and return its output.",
  parameters: z.object({
    command: z.string().describe("The shell command to run"),
    timeout: z.number().optional().describe("Timeout in milliseconds (default 30000)"),
  }),
  async execute({ command, timeout = 30_000 }) {
    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout,
        maxBuffer: 1024 * 1024 * 10,
      });
      const parts = [stdout.trim()];
      if (stderr.trim()) parts.push(`STDERR:\n${stderr.trim()}`);
      return parts.filter(Boolean).join("\n") || "(no output)";
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      const parts = [e.message];
      if (e.stdout) parts.push(e.stdout.trim());
      if (e.stderr) parts.push(`STDERR:\n${e.stderr.trim()}`);
      return parts.filter(Boolean).join("\n");
    }
  },
};

const readFileDef: ToolDefinition<z.ZodObject<{ path: z.ZodString }>> = {
  description: "Read the contents of a file.",
  parameters: z.object({
    path: z.string().describe("Absolute or relative path to the file"),
  }),
  async execute({ path }) {
    try {
      return await readFile(path, "utf8");
    } catch (err) {
      return `Error reading file: ${(err as Error).message}`;
    }
  },
};

const writeFileDef: ToolDefinition<z.ZodObject<{ path: z.ZodString; content: z.ZodString }>> = {
  description: "Write content to a file, creating it if it does not exist.",
  parameters: z.object({
    path: z.string().describe("Absolute or relative path to the file"),
    content: z.string().describe("Content to write"),
  }),
  async execute({ path, content }) {
    try {
      await writeFile(path, content, "utf8");
      return `Successfully wrote ${content.length} characters to ${path}`;
    } catch (err) {
      return `Error writing file: ${(err as Error).message}`;
    }
  },
};

/**
 * Default tool registry with bash, read_file, and write_file.
 * Passed to the orchestrator unless overridden.
 */
export function defaultTools(): ToolRegistry {
  return new ToolRegistry()
    .register("bash", bashDef)
    .register("read_file", readFileDef)
    .register("write_file", writeFileDef);
}
