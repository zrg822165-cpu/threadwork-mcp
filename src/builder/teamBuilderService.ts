import type { TeamBuild, TeamMemberDraft, TeamState } from "../domain/types.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { TeamService } from "../services/teamService.js";
import { requiredString, stringArg, stringArrayArg } from "../utils/args.js";
import { newId, nowIso } from "../utils/id.js";
import { slugifyAgentId } from "../utils/slug.js";
import { requireTeamBuild, selectTeam, teamBuilds } from "./teamBuildState.js";

export function teamStart(state: TeamState, args: Record<string, unknown>): unknown {
  const teamName = stringArg(args.teamName) ?? stringArg(args.name) ?? "Runtime Team";
  const existingTeamId = stringArg(args.teamId);
  const team = existingTeamId ? selectTeam(state, existingTeamId) : new TeamService(state).createTeam({ name: teamName, description: stringArg(args.description) }).team;
  const builds = teamBuilds(state);
  if (builds[team.id]) {
    return teamBuildStatus(state, team.id);
  }

  const now = nowIso();
  builds[team.id] = {
    teamId: team.id,
    host: {
      name: stringArg(args.hostName),
      model: stringArg(args.hostModel),
      responsibility: stringArg(args.hostResponsibility),
      notes: stringArg(args.hostNotes)
    },
    status: "building",
    confirmedMemberIds: [],
    createdAt: now,
    updatedAt: now
  };

  return {
    team,
    build: builds[team.id],
    nextPrompt: "Ask the user for the first member's name, responsibility, model, and boundaries. Do not suggest members unless the user asks for suggestions."
  };
}

export function teamDraftMember(state: TeamState, args: Record<string, unknown>): TeamMemberDraft {
  const build = requireTeamBuild(state, stringArg(args.teamId));
  resumeBuilding(build);
  if (build.currentDraft) {
    throw new ConflictError("A member draft already exists. Confirm or discard it before drafting another member.", { draft: build.currentDraft });
  }

  const name = requiredString(args.name, "name");
  const now = nowIso();
  const draft: TeamMemberDraft = {
    id: newId("draft"),
    teamId: build.teamId,
    name,
    agentId: stringArg(args.agentId) ?? slugifyAgentId(name),
    model: requiredString(args.model, "model"),
    rawResponsibility: requiredString(args.rawResponsibility, "rawResponsibility"),
    polishedPrompt: requiredString(args.polishedPrompt, "polishedPrompt"),
    permissions: stringArrayArg(args.permissions) ?? [],
    callWhen: stringArrayArg(args.callWhen) ?? [],
    doNot: stringArrayArg(args.doNot) ?? [],
    createdAt: now,
    updatedAt: now
  };

  build.currentDraft = draft;
  build.updatedAt = now;
  return draft;
}

export function teamConfirmMember(state: TeamState, args: Record<string, unknown>): unknown {
  const build = requireTeamBuild(state, stringArg(args.teamId));
  resumeBuilding(build);
  const draft = build.currentDraft;
  if (!draft) {
    throw new NotFoundError("No member draft exists. Create one with team_draft_member first.");
  }

  const member = new TeamService(state).addMember({
    teamId: build.teamId,
    name: draft.name,
    role: "teammate",
    capabilities: [draft.model],
    agentId: draft.agentId,
    model: draft.model,
    rawResponsibility: draft.rawResponsibility,
    polishedPrompt: draft.polishedPrompt,
    permissions: draft.permissions,
    callWhen: draft.callWhen,
    doNot: draft.doNot,
    createdOrder: build.confirmedMemberIds.length + 1
  });

  build.confirmedMemberIds.push(member.id);
  build.currentDraft = undefined;
  build.updatedAt = nowIso();

  return {
    member,
    scaffoldGenerated: false,
    nextPrompt: "Ask the user whether to create the next member. If they decline, call team_finish."
  };
}

export function teamRemoveMember(state: TeamState, args: Record<string, unknown>): unknown {
  const build = requireTeamBuild(state, stringArg(args.teamId));
  if (build.currentDraft) {
    throw new ConflictError("Cannot remove a confirmed member while a draft is pending. Confirm or discard the draft first.", { draft: build.currentDraft });
  }

  const member = resolveConfirmedMember(state, build.teamId, build.confirmedMemberIds, args);
  const removedMember = new TeamService(state).removeMember({ teamId: build.teamId, memberId: member.id });
  build.confirmedMemberIds = build.confirmedMemberIds.filter((memberId) => memberId !== member.id);
  resumeBuilding(build);
  build.updatedAt = nowIso();

  return {
    member: removedMember,
    scaffoldGenerated: false,
    nextPrompt: "Ask the user whether to create another member or finish the team again."
  };
}

export function teamDiscardMemberDraft(state: TeamState, args: Record<string, unknown>): unknown {
  const build = requireTeamBuild(state, stringArg(args.teamId));
  const discarded = build.currentDraft;
  build.currentDraft = undefined;
  build.updatedAt = nowIso();
  return { discarded };
}

export function teamFinish(state: TeamState, args: Record<string, unknown>): unknown {
  const build = requireTeamBuild(state, stringArg(args.teamId));
  if (build.currentDraft) {
    throw new ConflictError("Cannot finalize while a member draft is pending. Confirm or discard it first.", { draft: build.currentDraft });
  }
  const now = nowIso();
  build.status = "finalized";
  build.finalizedAt = now;
  build.updatedAt = now;
  return {
    build,
    members: build.confirmedMemberIds.map((memberId) => state.members[memberId]).filter(Boolean),
    nextPrompt: "Team configuration is finished. Call team_run when you are ready to start runtime-managed teammate sessions."
  };
}

export function teamBuildStatus(state: TeamState, requestedTeamId?: string): unknown {
  const build = requireTeamBuild(state, requestedTeamId);
  const team = selectTeam(state, build.teamId);
  return {
    team,
    host: build.host,
    status: build.status,
    finalized: build.status === "finalized",
    currentDraft: build.currentDraft,
    members: build.confirmedMemberIds.map((id) => state.members[id]).filter(Boolean),
    nextPrompt:
      build.status === "finalized"
        ? "Team is ready. Call team_run to start runtime-managed teammate sessions, or add/remove members and finish again."
        : build.currentDraft
          ? "Ask the user to confirm, revise, or discard the current member draft."
          : "Ask the user whether to create the next member. Do not suggest details unless asked."
  };
}

function resumeBuilding(build: TeamBuild): void {
  if (build.status !== "building") {
    build.status = "building";
    build.finalizedAt = undefined;
  }
}

function resolveConfirmedMember(
  state: TeamState,
  teamId: string,
  confirmedMemberIds: string[],
  args: Record<string, unknown>
) {
  const memberId = stringArg(args.memberId);
  const agentId = stringArg(args.agentId)?.toLowerCase();
  const name = stringArg(args.name)?.trim().toLowerCase();
  const members = confirmedMemberIds.map((confirmedId) => state.members[confirmedId]).filter(Boolean);
  const member = members.find((candidate) => {
    if (memberId && candidate.id === memberId) return true;
    if (agentId && candidate.agentId?.toLowerCase() === agentId) return true;
    if (name && candidate.name.trim().toLowerCase() === name) return true;
    return false;
  });
  if (!member) {
    throw new NotFoundError("Confirmed member not found. Pass memberId, agentId, or exact name.", {
      teamId,
      memberId,
      agentId,
      name
    });
  }
  return member;
}
