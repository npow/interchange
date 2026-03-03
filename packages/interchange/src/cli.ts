#!/usr/bin/env node
/**
 * interchange CLI — run multi-model agent tasks from the terminal.
 *
 * Commands:
 *   interchange run <task>            Decompose and run a task
 *   interchange run-as <role> <task>  Run a task with a specific role
 *   interchange status <taskId>       Show current state of a task
 *   interchange list                  List all known tasks
 */
import { Command } from "commander";
import { Interchange, DEFAULT_ROLES } from "./core.js";
import { JSONFileBackend } from "@interchange/core";
import { homedir } from "os";
import { join } from "path";

const DEFAULT_STATE_PATH = join(homedir(), ".interchange", "state.json");

const program = new Command();

program
  .name("interchange")
  .description("Multi-model agent orchestrator")
  .version("0.1.0");

program
  .command("run <task>")
  .description("Decompose and run a task across multiple agents")
  .option("--state-file <path>", "Path to state file", DEFAULT_STATE_PATH)
  .option("--max-cost <usd>", "Max cost per 1k tokens (USD)", parseFloat)
  .option("--no-decompose", "Run as single step (skip decomposition)")
  .action(async (task: string, opts: { stateFile: string; maxCost?: number }) => {
    const ix = new Interchange({
      stateBackend: new JSONFileBackend(opts.stateFile),
    });
    const constraints = opts.maxCost
      ? { maxCostUsdPer1kTokens: opts.maxCost }
      : undefined;

    console.log(`Running task: ${task}`);
    console.log("Routing across agents...\n");

    const result = await ix.run(task, constraints);
    printResult(result);
  });

program
  .command("run-as <role> <task>")
  .description("Run a task with a specific role (skips decomposition)")
  .option("--state-file <path>", "Path to state file", DEFAULT_STATE_PATH)
  .action(async (role: string, task: string, opts: { stateFile: string }) => {
    const ix = new Interchange({
      stateBackend: new JSONFileBackend(opts.stateFile),
    });
    console.log(`Running task as role '${role}': ${task}\n`);
    const result = await ix.runAs(task, role);
    printResult(result);
  });

program
  .command("status <taskId>")
  .description("Show the current state of a task")
  .option("--state-file <path>", "Path to state file", DEFAULT_STATE_PATH)
  .action(async (taskId: string, opts: { stateFile: string }) => {
    const ix = new Interchange({
      stateBackend: new JSONFileBackend(opts.stateFile),
    });
    try {
      const state = ix.getState(taskId);
      console.log(`Task: ${state.taskId}`);
      console.log(`Status: ${state.status}`);
      console.log(`Nodes: ${Object.keys(state.taskNodes).length}`);
      for (const [id, node] of Object.entries(state.taskNodes)) {
        console.log(`  ${id} [${node.status}] (${node.role}) — ${node.description}`);
      }
      console.log(`\nFacts: ${JSON.stringify(state.facts, null, 2)}`);
    } catch (err) {
      console.error(`Task not found: ${taskId}`);
      process.exit(1);
    }
  });

program
  .command("list")
  .description("List all known tasks")
  .option("--state-file <path>", "Path to state file", DEFAULT_STATE_PATH)
  .action(async (opts: { stateFile: string }) => {
    const ix = new Interchange({
      stateBackend: new JSONFileBackend(opts.stateFile),
    });
    const tasks = ix.listTasks();
    if (tasks.length === 0) {
      console.log("No tasks found.");
    } else {
      for (const id of tasks) {
        try {
          const state = ix.getState(id);
          console.log(`${id} [${state.status}] — ${state.originalTask.slice(0, 60)}`);
        } catch {
          console.log(`${id} [unknown]`);
        }
      }
    }
  });

program
  .command("roles")
  .description("List available roles and their models")
  .action(() => {
    for (const [name, role] of Object.entries(DEFAULT_ROLES)) {
      console.log(`${name}:`);
      console.log(`  preferred: ${role.preferredModel}`);
      console.log(`  fallback:  ${role.fallbackModel}`);
      console.log(`  capabilities: ${role.capabilities.join(", ")}`);
    }
  });

function printResult(result: {
  taskId: string;
  status: string;
  output: string;
  totalTokens: number;
  wallTimeMs: number;
  taskNodes: Array<{ id: string; status: string; role: string }>;
}): void {
  console.log(`\n─── Result ───────────────────────────────────────────`);
  console.log(`Status: ${result.status}`);
  console.log(`Tokens: ${result.totalTokens.toLocaleString()}`);
  console.log(`Time:   ${(result.wallTimeMs / 1000).toFixed(1)}s`);
  console.log(`Nodes:  ${result.taskNodes.map((n) => `${n.id}[${n.status}]`).join(", ")}`);
  if (result.output) {
    console.log(`\n${result.output}`);
  }
}

program.parse(process.argv);
