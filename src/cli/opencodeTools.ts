import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NotFoundError } from "../errors.js";
import { checkOpenCodeScaffold } from "../opencode/scaffoldService.js";
import {
  teamAsk,
  teamClaim,
  teamHandoff,
  teamInbox,
  teamTimeline
} from "../opencode/legacyCollaborationService.js";
import { listOpenCodeModels } from "../opencode/modelService.js";
import {
  teamBuildStatus,
  teamConfirmMember,
  teamDiscardMemberDraft,
  teamDraftMember,
  teamFinish,
  teamRemoveMember,
  teamReportPrompts,
  teamStart
} from "../opencode/teamBuilderService.js";
import { numberArg, stringArg } from "../opencode/argHelpers.js";
import { requireBuild } from "../opencode/teamStateHelpers.js";
import type { TeamState } from "../domain/types.js";
import type { JsonStore } from "../store/jsonStore.js";

// Legacy OpenCode scaffold CLI dispatcher. Runtime-first MCP registration must not import this module.
export async function runLegacyOpenCodeTool(store: JsonStore, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  switch (toolName) {
    case "team_start":
      return store.transaction((state) => teamStart(state, args));
    case "team_models":
    case "team_list_models":
      return listOpenCodeModels(store.projectRootDir, stringArg(args.provider));
    case "team_draft":
    case "team_draft_member":
      return store.transaction((state) => teamDraftMember(state, args));
    case "team_confirm":
    case "team_confirm_member":
      return store.transaction((state) => teamConfirmMember(state, store.projectRootDir, args));
    case "team_discard_member_draft":
      return store.transaction((state) => teamDiscardMemberDraft(state, args));
    case "team_remove_member":
      return store.transaction((state) => teamRemoveMember(state, store.projectRootDir, args));
    case "team_finish":
    case "team_finalize":
      return store.transaction((state) => teamFinish(state, args));
    case "team_report_prompts":
      return teamReportPrompts(await store.read(), stringArg(args.teamId));
    case "team_build_status": {
      const state = await store.read();
      return teamBuildStatus(state, stringArg(args.teamId), {
        rootDir: store.projectRootDir,
        scaffold: await checkOpenCodeScaffold(store.projectRootDir, { includeOpenCodeRuntime: false }),
        agentFiles: await agentFilesForBuild(state, store.projectRootDir, stringArg(args.teamId))
      });
    }
    case "team_status": {
      const state = await store.read();
      return teamBuildStatus(state, stringArg(args.teamId), {
        rootDir: store.projectRootDir,
        scaffold: await checkOpenCodeScaffold(store.projectRootDir, { includeOpenCodeRuntime: false }),
        agentFiles: await agentFilesForBuild(state, store.projectRootDir, stringArg(args.teamId))
      });
    }
    case "team_ask":
      return store.transaction((state) => teamAsk(state, args));
    case "team_handoff":
      return store.transaction((state) => teamHandoff(state, args));
    case "team_claim":
      return store.transaction((state) => teamClaim(state, args));
    case "team_inbox":
      return teamInbox(await store.read(), args);
    case "team_timeline":
      return teamTimeline(await store.read(), stringArg(args.teamId), numberArg(args.limit) ?? 20);
    default:
      throw new NotFoundError(`Unknown OpenCode team tool: ${toolName}`);
  }
}

export const runOpenCodeTool = runLegacyOpenCodeTool;

async function agentFilesForBuild(state: TeamState, rootDir: string, requestedTeamId?: string) {
  const build = requireBuild(state, requestedTeamId);
  return Promise.all(
    build.confirmedMemberIds
      .map((memberId) => state.members[memberId])
      .filter((member) => member?.agentId)
      .map(async (member) => {
        const path = join(rootDir, ".opencode", "agents", `${member.agentId}.md`);
        return {
          memberId: member.id,
          agentId: member.agentId,
          path,
          exists: await fileExists(path)
        };
      })
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
