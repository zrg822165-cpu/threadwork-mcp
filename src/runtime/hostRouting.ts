import type { AgentSessionRecord, TeamState } from "../domain/types.js";

export interface RuntimeHostSummary {
  hostName?: string;
  hostModel?: string;
  hostResponsibility?: string;
  leadMode: "host_only" | "explicit_lead_member";
  leadMemberId?: string;
  leadMemberName?: string;
  leadRuntimeSessionId?: string;
  escalationTarget: "host" | "lead_member";
  hostRuntimeSession: false;
}

export function runtimeHostSummary(
  state: TeamState,
  teamId: string,
  sessions?: AgentSessionRecord[]
): RuntimeHostSummary {
  const build = state.teamBuilds[teamId];
  const team = state.teams[teamId];
  const leadMember = team?.leadMemberId ? state.members[team.leadMemberId] : undefined;
  const teamSessions = sessions ?? Object.values(state.agentSessions).filter((session) => session.teamId === teamId);
  const leadSession = leadMember
    ? teamSessions.find((session) => session.memberId === leadMember.id)
    : undefined;

  return {
    hostName: build?.host.name,
    hostModel: build?.host.model,
    hostResponsibility: build?.host.responsibility,
    leadMode: leadMember ? "explicit_lead_member" : "host_only",
    leadMemberId: leadMember?.id,
    leadMemberName: leadMember?.name,
    leadRuntimeSessionId: leadSession?.id,
    escalationTarget: leadMember ? "lead_member" : "host",
    hostRuntimeSession: false
  };
}
