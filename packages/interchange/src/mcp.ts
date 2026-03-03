/**
 * interchange MCP server.
 *
 * Exposes accumulated project state as MCP tools that Claude Code
 * (or any other MCP client) can call from within a session.
 *
 * Add to Claude Code settings:
 *   "mcpServers": {
 *     "interchange": { "command": "interchange", "args": ["serve"] }
 *   }
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { JSONFileBackend, StateManager, makeBaton } from "@npow/interchange-core";
import { formatBatonForAgent, type AgentTarget } from "./inject.js";
import { getStateFile } from "./hooks.js";

export async function startMcpServer(
  projectDir: string = process.cwd()
): Promise<void> {
  const stateFile = getStateFile(projectDir);
  const backend = new JSONFileBackend(stateFile);
  const manager = new StateManager(backend);

  const server = new Server(
    { name: "interchange", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "get_project_state",
        description:
          "Get accumulated project state across all sessions: facts established, decisions made, and open questions.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_handoff_baton",
        description:
          "Get a formatted handoff context for a target agent (claude, codex, gemini, amp). Use this to pass context to another agent tool.",
        inputSchema: {
          type: "object",
          properties: {
            target: {
              type: "string",
              enum: ["claude", "codex", "gemini", "amp", "generic"],
              description: "Target agent tool",
            },
            session_id: {
              type: "string",
              description: "Session to get baton from (default: latest)",
            },
          },
        },
      },
      {
        name: "record_decision",
        description:
          "Persist an explicit decision made during this session so future sessions don't re-litigate it.",
        inputSchema: {
          type: "object",
          required: ["session_id", "what", "why"],
          properties: {
            session_id: { type: "string" },
            what: { type: "string", description: "What was decided" },
            why: { type: "string", description: "Rationale for the decision" },
          },
        },
      },
      {
        name: "get_conflicts",
        description:
          "List fact conflicts detected across sessions (contradictory values for the same key).",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const a = args as Record<string, unknown>;

    switch (name) {
      case "get_project_state": {
        const tasks = manager.listTasks();
        if (tasks.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No project state yet. Enable the Stop hook to start capturing sessions.",
              },
            ],
          };
        }
        const summary = tasks.map((id) => {
          try {
            const s = manager.get(id);
            const latest = s.batons[s.batons.length - 1];
            return {
              sessionId: id,
              status: s.status,
              facts: latest?.facts ?? {},
              decisions: latest?.decisions ?? [],
              openQuestions: latest?.openQuestions ?? [],
              nextSteps: latest?.nextSteps ?? [],
            };
          } catch {
            return { sessionId: id, error: "could not load" };
          }
        });
        return {
          content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
        };
      }

      case "get_handoff_baton": {
        const target = (a["target"] as AgentTarget) ?? "generic";
        const sessionId = a["session_id"] as string | undefined;
        const tasks = manager.listTasks();
        if (tasks.length === 0) {
          return { content: [{ type: "text", text: "No sessions found." }] };
        }
        const id = sessionId ?? tasks[tasks.length - 1]!;
        const state = manager.get(id);
        const baton = state.batons[state.batons.length - 1];
        if (!baton) {
          return {
            content: [{ type: "text", text: "No baton found for this session." }],
          };
        }
        return {
          content: [{ type: "text", text: formatBatonForAgent(baton, target) }],
        };
      }

      case "record_decision": {
        const sessionId = a["session_id"] as string;
        const what = a["what"] as string;
        const why = a["why"] as string;
        let state;
        try {
          state = manager.get(sessionId);
        } catch {
          state = manager.create(sessionId, `Session ${sessionId}`);
        }
        const baton = makeBaton({
          taskId: sessionId,
          taskNodeId: sessionId,
          fromRole: "user",
          fromModel: "manual",
          toRole: "next-agent",
          facts: state.facts,
          decisions: [{ what, why }],
          openQuestions: [],
          recommendation: what,
          status: "partial",
        });
        manager.applyBaton(state, baton);
        return {
          content: [{ type: "text", text: `Recorded: "${what}"` }],
        };
      }

      case "get_conflicts": {
        const tasks = manager.listTasks();
        const allFacts: Record<
          string,
          Array<{ sessionId: string; value: unknown }>
        > = {};
        for (const id of tasks) {
          try {
            const s = manager.get(id);
            for (const [k, v] of Object.entries(s.facts)) {
              if (!allFacts[k]) allFacts[k] = [];
              allFacts[k]!.push({ sessionId: id, value: v });
            }
          } catch {
            // skip
          }
        }
        const conflicts = Object.entries(allFacts).filter(
          ([, vals]) =>
            new Set(vals.map((v) => JSON.stringify(v.value))).size > 1
        );
        if (conflicts.length === 0) {
          return { content: [{ type: "text", text: "No conflicts detected." }] };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                conflicts.map(([key, values]) => ({ key, values })),
                null,
                2
              ),
            },
          ],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
