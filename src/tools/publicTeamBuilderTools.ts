import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TeamBuild } from "../domain/types.js";
import { teamBuildStatus, teamConfirmMember, teamDraftMember, teamFinish, teamRemoveMember, teamStart } from "../builder/teamBuilderService.js";
import { listOpenCodeModels } from "../opencode/modelService.js";
import { compactStatusView } from "../runtime/compactViews.js";
import { runtimeControlPlane, tasksByStatus, unreadMessagesByMember } from "../runtime/controlPlane.js";
import { explainRuntimeStatus } from "../runtime/explainability.js";
import { RuntimeService } from "../runtime/runtimeService.js";
import type { AgentBackend } from "../runtime/agentBackend.js";
import { OpenCodeBackend } from "../runtime/openCodeBackend.js";
import type { JsonStore } from "../store/jsonStore.js";
import { runTool } from "./response.js";
import { draftSchema } from "./schemas.js";

export interface PublicTeamBuilderToolOptions {
  backendFactory?: () => AgentBackend;
  advancedTools?: boolean;
}

export function registerPublicTeamBuilderTools(server: McpServer, store: JsonStore, options: PublicTeamBuilderToolOptions = {}): void {
  const backendFactory = options.backendFactory ?? (() => new OpenCodeBackend());
  if (options.advancedTools) {
    server.registerTool(
      "team_start",
      {
        title: "Start Team Builder",
        description: "Advanced/manual builder control: start or resume a user-authored runtime team build and record host metadata.",
        inputSchema: {
          teamId: z.string().optional(),
          teamName: z.string().optional(),
          name: z.string().optional(),
          description: z.string().optional(),
          hostName: z.string().optional(),
          hostModel: z.string().optional(),
          hostResponsibility: z.string().optional(),
          hostNotes: z.string().optional()
        }
      },
      async (input) => runTool(() => store.transaction((state) => teamStart(state, input)))
    );
  }

  server.registerTool(
    "team_models",
    {
      title: "List Team Models",
      description: "List backend models available for runtime team members.",
      inputSchema: {
        provider: z.string().optional()
      }
    },
    async (input) => runTool(() => listOpenCodeModels(store.projectRootDir, input.provider))
  );

  if (options.advancedTools) {
    server.registerTool(
      "team_draft",
      {
        title: "Draft Team Member",
        description: "Advanced/manual builder control: save one user-authored runtime member draft without creating backend scaffold files.",
        inputSchema: draftSchema()
      },
      async (input) => runTool(() => store.transaction((state) => teamDraftMember(state, input)))
    );
  }

  if (options.advancedTools) {
    server.registerTool(
      "team_confirm",
      {
        title: "Confirm Team Member",
        description: "Advanced/manual builder control: confirm the current draft as a runtime-managed member without generating scaffold files.",
        inputSchema: {
          teamId: z.string().optional(),
          force: z.boolean().optional()
        }
      },
      async (input) => runTool(() => store.transaction((state) => teamConfirmMember(state, input)))
    );
  }

  if (options.advancedTools) {
    server.registerTool(
      "team_remove_member",
      {
        title: "Remove Team Member",
        description: "Advanced/manual builder control: remove one confirmed runtime-managed member from the build.",
        inputSchema: {
          teamId: z.string().optional(),
          memberId: z.string().optional(),
          agentId: z.string().optional(),
          name: z.string().optional()
        }
      },
      async (input) => runTool(() => store.transaction((state) => teamRemoveMember(state, input)))
    );
  }

  if (options.advancedTools) {
    server.registerTool(
      "team_finish",
      {
        title: "Finish Team Builder",
        description: "Advanced/manual builder control: finish team configuration and mark the runtime ready for activation.",
        inputSchema: {
          teamId: z.string().optional()
        }
      },
      async (input) => runTool(() => store.transaction((state) => {
        const result = teamFinish(state, input) as Record<string, unknown>;
        const build = result.build as { teamId: string };
        const runtime = new RuntimeService(state, backendFactory()).markReady({ teamId: build.teamId });
        return { ...result, runtime: runtime.runtime, sessions: runtime.sessions };
      }))
    );
  }

  server.registerTool(
    "team_status",
    {
      title: "Team Builder Status",
      description: "Inspect/debug team build plus runtime state. Prefer team_work for normal task progress.",
      inputSchema: {
        teamId: z.string().optional()
      }
    },
    async (input) => runTool(async () => {
      const state = await store.read();
      const buildStatus = teamBuildStatus(state, input.teamId) as Record<string, unknown>;
      const team = buildStatus.team as { id: string };
      const runtime = new RuntimeService(state, backendFactory()).status(team.id);
      const controlPlane = runtimeControlPlane(state, team.id, runtime.sessions);
      const explain = explainRuntimeStatus(state, buildStatus.build as TeamBuild | undefined, runtime.runtime, controlPlane);
      return {
        ...buildStatus,
        host: controlPlane.host,
        runtime: runtime.runtime,
        sessions: runtime.sessions,
        tasks: tasksByStatus(state, team.id),
        unreadMessages: unreadMessagesByMember(state, team.id),
        pathLocks: Object.values(state.pathLocks).filter((lock) => lock.teamId === team.id),
        scheduler: state.schedulerStates[team.id],
        recentEvents: state.events.filter((event) => !event.teamId || event.teamId === team.id).slice(-20),
        controlPlane,
        explain,
        compactStatus: compactStatusView(state, team.id, buildStatus.build as TeamBuild | undefined, runtime.runtime, runtime.sessions, controlPlane, explain)
      };
    })
  );
}
