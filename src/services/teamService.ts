import type { Member, MemberRole, Team, TeamState } from "../domain/types.js";
import { InvalidStateError } from "../errors.js";
import { newId, nowIso } from "../utils/id.js";
import { addEvent } from "./events.js";
import { requireActiveTeam, requireTeam } from "./guards.js";

export interface CreateTeamInput {
  name: string;
  description?: string;
  leadName?: string;
}

export interface AddMemberInput {
  teamId: string;
  name: string;
  role?: MemberRole;
  capabilities?: string[];
  agentId?: string;
  model?: string;
  rawResponsibility?: string;
  polishedPrompt?: string;
  permissions?: string[];
  callWhen?: string[];
  doNot?: string[];
  createdOrder?: number;
}

export interface RemoveMemberInput {
  teamId: string;
  memberId: string;
}

export class TeamService {
  constructor(private readonly state: TeamState) {}

  createTeam(input: CreateTeamInput): { team: Team; leadMember?: Member; nextActions: string[] } {
    const now = nowIso();
    const team: Team = {
      id: newId("team"),
      name: input.name,
      description: input.description,
      status: "active",
      memberIds: [],
      createdAt: now,
      updatedAt: now
    };

    let leadMember: Member | undefined;
    if (input.leadName) {
      leadMember = {
        id: newId("mem"),
        teamId: team.id,
        name: input.leadName,
        role: "lead",
        status: "active",
        capabilities: [],
        createdAt: now,
        updatedAt: now
      };
      team.leadMemberId = leadMember.id;
      team.memberIds.push(leadMember.id);
      this.state.members[leadMember.id] = leadMember;
    }

    this.state.teams[team.id] = team;
    addEvent(this.state, {
      teamId: team.id,
      actorMemberId: leadMember?.id,
      entityType: "team",
      entityId: team.id,
      type: "team.created",
      message: `Created team ${team.name}`
    });

    return {
      team,
      leadMember,
      nextActions: [
        "add_member to register teammates",
        "create_task to add work to the shared task board",
        "lock_paths before editing files that may conflict"
      ]
    };
  }

  getTeam(teamId: string): { team: Team; members: Member[] } {
    const team = requireTeam(this.state, teamId);
    const members = team.memberIds.map((id) => this.state.members[id]).filter((member): member is Member => Boolean(member));
    return { team, members };
  }

  closeTeam(teamId: string, actorMemberId?: string): Team {
    const team = requireTeam(this.state, teamId);
    if (team.status === "closed") {
      return team;
    }
    const now = nowIso();
    team.status = "closed";
    team.updatedAt = now;
    team.closedAt = now;
    addEvent(this.state, {
      teamId,
      actorMemberId,
      entityType: "team",
      entityId: teamId,
      type: "team.closed",
      message: `Closed team ${team.name}`
    });
    return team;
  }

  addMember(input: AddMemberInput): Member {
    const team = requireActiveTeam(this.state, input.teamId);
    if (input.role === "lead" && team.leadMemberId) {
      throw new InvalidStateError("Team already has a lead member", { leadMemberId: team.leadMemberId });
    }

    const now = nowIso();
    const member: Member = {
      id: newId("mem"),
      teamId: input.teamId,
      name: input.name,
      role: input.role ?? "teammate",
      status: "active",
      capabilities: input.capabilities ?? [],
      agentId: input.agentId,
      model: input.model,
      rawResponsibility: input.rawResponsibility,
      polishedPrompt: input.polishedPrompt,
      permissions: input.permissions,
      callWhen: input.callWhen,
      doNot: input.doNot,
      createdOrder: input.createdOrder,
      createdAt: now,
      updatedAt: now
    };

    this.state.members[member.id] = member;
    team.memberIds.push(member.id);
    if (member.role === "lead") {
      team.leadMemberId = member.id;
    }
    team.updatedAt = now;
    addEvent(this.state, {
      teamId: team.id,
      actorMemberId: member.id,
      entityType: "member",
      entityId: member.id,
      type: "member.added",
      message: `Added member ${member.name}`
    });
    return member;
  }

  removeMember(input: RemoveMemberInput): Member {
    const team = requireActiveTeam(this.state, input.teamId);
    const member = this.state.members[input.memberId];
    if (!member || member.teamId !== team.id) {
      throw new InvalidStateError("Member does not belong to this team", { teamId: team.id, memberId: input.memberId });
    }

    const now = nowIso();
    team.memberIds = team.memberIds.filter((memberId) => memberId !== member.id);
    if (team.leadMemberId === member.id) {
      team.leadMemberId = undefined;
    }
    team.updatedAt = now;
    delete this.state.members[member.id];
    addEvent(this.state, {
      teamId: team.id,
      actorMemberId: member.id,
      entityType: "member",
      entityId: member.id,
      type: "member.removed",
      message: `Removed member ${member.name}`
    });
    return member;
  }
}
