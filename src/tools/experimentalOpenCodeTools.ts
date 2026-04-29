import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runLegacyOpenCodeTool } from "../cli/opencodeTools.js";
import type { JsonStore } from "../store/jsonStore.js";
import { runTool } from "./response.js";
import { draftSchema } from "./schemas.js";

// Legacy migration-only wrappers for the old scaffold-era OpenCode tool names.
export function registerExperimentalOpenCodeTools(server: McpServer, store: JsonStore): void {
  const legacyTools = [
    ["team_list_models", "team_list_models", { provider: z.string().optional() }],
    ["team_draft_member", "team_draft_member", draftSchema()],
    ["team_confirm_member", "team_confirm_member", { teamId: z.string().optional(), force: z.boolean().optional() }],
    ["team_discard_member_draft", "team_discard_member_draft", { teamId: z.string().optional() }],
    ["team_finalize", "team_finalize", { teamId: z.string().optional() }],
    ["team_report_prompts", "team_report_prompts", { teamId: z.string().optional() }],
    ["team_build_status", "team_build_status", { teamId: z.string().optional() }],
    ["team_ask", "team_ask", {
      teamId: z.string().optional(),
      fromMemberId: z.string().optional(),
      toMemberId: z.string().optional(),
      toMemberName: z.string().optional(),
      message: z.string().min(1),
      taskId: z.string().optional()
    }],
    ["team_handoff", "team_handoff", {
      teamId: z.string().optional(),
      fromMemberId: z.string().optional(),
      toMemberId: z.string().optional(),
      toMemberName: z.string().optional(),
      taskId: z.string().optional(),
      summary: z.string().min(1),
      requestedAction: z.string().optional()
    }],
    ["team_claim", "team_claim", {
      teamId: z.string().optional(),
      taskId: z.string().min(1),
      memberId: z.string().min(1),
      paths: z.array(z.string().min(1)).optional()
    }],
    ["team_timeline", "team_timeline", {
      teamId: z.string().optional(),
      limit: z.number().optional()
    }]
  ] as const;

  for (const [name, target, inputSchema] of legacyTools) {
    server.registerTool(
      name,
      {
        title: `Experimental ${name}`,
        description: `Legacy OpenCode scaffold compatibility tool for ${target}. Prefer team_work and the runtime-first MCP surface.`,
        inputSchema
      },
      async (input: Record<string, unknown>) => runTool(() => runLegacyOpenCodeTool(store, target, input))
    );
  }
}
