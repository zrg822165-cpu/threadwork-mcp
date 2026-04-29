import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentBackend } from "../runtime/agentBackend.js";
import type { JsonStore } from "../store/jsonStore.js";
import { registerPublicTeamBuilderTools } from "./publicTeamBuilderTools.js";
import { registerRuntimeTools } from "./runtimeTools.js";

export interface RegisterToolsOptions {
  backendFactory?: () => AgentBackend;
  advancedTools?: boolean;
}

export function registerTools(server: McpServer, store: JsonStore, options: RegisterToolsOptions = {}): void {
  const advancedTools = options.advancedTools ?? process.env.TEAM_MCP_ENABLE_ADVANCED_TOOLS === "1";
  registerPublicTeamBuilderTools(server, store, { ...options, advancedTools });
  registerRuntimeTools(server, store, { ...options, advancedTools });
}
