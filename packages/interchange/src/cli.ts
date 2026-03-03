#!/usr/bin/env node
/**
 * interchange CLI
 *
 * Commands:
 *   interchange init              Set up .interchange/ for the current project
 *   interchange status            Show project state (facts, decisions, open questions)
 *   interchange handoff [target]  Print baton formatted for a target agent
 *   interchange conflicts         Show detected fact conflicts across sessions
 *   interchange distill-hook      Internal: Stop hook handler (reads StopEvent from stdin)
 *   interchange serve             Start MCP server (stdio transport)
 */
import { Command } from "commander";
import { existsSync, mkdirSync } from "fs";
import { JSONFileBackend, StateManager } from "@interchange/core";
import type { StopEvent } from "@interchange/core";
import { getStateDir, getStateFile, handleStopHook } from "./hooks.js";
import { formatBatonForAgent, type AgentTarget } from "./inject.js";
import { startMcpServer } from "./mcp.js";

const program = new Command();

program
  .name("interchange")
  .description("Cross-agent episodic memory and session handoff")
  .version("0.1.0");

// ─── init ────────────────────────────────────────────────────────────────────

program
  .command("init")
  .description("Set up .interchange/ for the current project")
  .option("--dir <path>", "Project directory", process.cwd())
  .action((opts: { dir: string }) => {
    const stateDir = getStateDir(opts.dir);
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
      console.log(`Created ${stateDir}`);
    } else {
      console.log(`Already initialized: ${stateDir}`);
    }
    console.log(`
To enable automatic distillation, add to ~/.claude/settings.json:

  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "interchange distill-hook" }]
    }]
  }

To enable in-session state queries, add to Claude Code MCP config:

  "mcpServers": {
    "interchange": { "command": "interchange", "args": ["serve"] }
  }
`);
  });

// ─── status ──────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show project state (facts, decisions, open questions)")
  .option("--dir <path>", "Project directory", process.cwd())
  .action((opts: { dir: string }) => {
    const stateFile = getStateFile(opts.dir);
    if (!existsSync(stateFile)) {
      console.log("No interchange state found. Run `interchange init` first.");
      process.exit(1);
    }
    const manager = new StateManager(new JSONFileBackend(stateFile));
    const sessions = manager.listTasks();
    if (sessions.length === 0) {
      console.log("No sessions recorded yet.");
      return;
    }
    for (const id of sessions) {
      const state = manager.get(id);
      const baton = state.batons[state.batons.length - 1];
      console.log(`\n── Session ${id} [${state.status}]`);
      if (!baton) continue;

      if (Object.keys(baton.facts).length > 0) {
        console.log("  Facts:");
        for (const [k, v] of Object.entries(baton.facts)) {
          console.log(`    ${k}: ${JSON.stringify(v)}`);
        }
      }
      if (baton.decisions.length > 0) {
        console.log("  Decisions:");
        for (const d of baton.decisions) {
          console.log(`    • ${d.what} — ${d.why}`);
        }
      }
      if (baton.triedAndRejected.length > 0) {
        console.log("  Tried and rejected:");
        for (const t of baton.triedAndRejected) {
          console.log(`    ✗ ${t.what} — ${t.why}`);
        }
      }
      if (baton.openQuestions.length > 0) {
        console.log("  Open questions:");
        for (const q of baton.openQuestions) {
          console.log(`    ? ${q}`);
        }
      }
      if (baton.nextSteps.length > 0) {
        console.log("  Next steps:");
        for (const s of baton.nextSteps) {
          console.log(`    → ${s}`);
        }
      }
      if (baton.recommendation) {
        console.log(`  Bottom line: ${baton.recommendation}`);
      }
    }
  });

// ─── handoff ─────────────────────────────────────────────────────────────────

program
  .command("handoff [target]")
  .description(
    "Print baton formatted for a target agent (claude, codex, gemini, amp)"
  )
  .option("--dir <path>", "Project directory", process.cwd())
  .option("--session <id>", "Session ID (default: latest)")
  .action(
    (
      target: string | undefined,
      opts: { dir: string; session?: string }
    ) => {
      const stateFile = getStateFile(opts.dir);
      if (!existsSync(stateFile)) {
        console.error("No interchange state found.");
        process.exit(1);
      }
      const manager = new StateManager(new JSONFileBackend(stateFile));
      const sessions = manager.listTasks();
      if (sessions.length === 0) {
        console.error("No sessions recorded yet.");
        process.exit(1);
      }
      const sessionId = opts.session ?? sessions[sessions.length - 1]!;
      const state = manager.get(sessionId);
      const baton = state.batons[state.batons.length - 1];
      if (!baton) {
        console.error("No baton found for this session.");
        process.exit(1);
      }
      console.log(formatBatonForAgent(baton, (target as AgentTarget) ?? "generic"));
    }
  );

// ─── conflicts ───────────────────────────────────────────────────────────────

program
  .command("conflicts")
  .description("Show detected fact conflicts across sessions")
  .option("--dir <path>", "Project directory", process.cwd())
  .action((opts: { dir: string }) => {
    const stateFile = getStateFile(opts.dir);
    if (!existsSync(stateFile)) {
      console.log("No interchange state found.");
      return;
    }
    const manager = new StateManager(new JSONFileBackend(stateFile));
    const allFacts: Record<
      string,
      Array<{ sessionId: string; value: unknown }>
    > = {};
    for (const id of manager.listTasks()) {
      const state = manager.get(id);
      for (const [k, v] of Object.entries(state.facts)) {
        if (!allFacts[k]) allFacts[k] = [];
        allFacts[k]!.push({ sessionId: id, value: v });
      }
    }
    const conflicts = Object.entries(allFacts).filter(
      ([, vals]) =>
        new Set(vals.map((v) => JSON.stringify(v.value))).size > 1
    );
    if (conflicts.length === 0) {
      console.log("No conflicts detected.");
      return;
    }
    console.log(`Found ${conflicts.length} conflict(s):\n`);
    for (const [key, values] of conflicts) {
      console.log(`  ${key}:`);
      for (const { sessionId, value } of values) {
        console.log(`    [${sessionId}] ${JSON.stringify(value)}`);
      }
    }
  });

// ─── distill-hook ─────────────────────────────────────────────────────────────

program
  .command("distill-hook")
  .description("Internal: Claude Code Stop hook handler (reads StopEvent from stdin)")
  .option("--dir <path>", "Project directory", process.cwd())
  .option("--model <id>", "Model to use for distillation")
  .action(async (opts: { dir: string; model?: string }) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      input += chunk as string;
    }
    const event = JSON.parse(input) as StopEvent;
    await handleStopHook(event, opts.dir, opts.model);
  });

// ─── serve ────────────────────────────────────────────────────────────────────

program
  .command("serve")
  .description("Start interchange MCP server (stdio transport)")
  .option("--dir <path>", "Project directory", process.cwd())
  .action(async (opts: { dir: string }) => {
    await startMcpServer(opts.dir);
  });

program.parse(process.argv);
