import type { Member, Task, Team, TeamState } from "../domain/types.js";
import { InvalidStateError, NotFoundError } from "../errors.js";

export function requireTeam(state: TeamState, teamId: string): Team {
  const team = state.teams[teamId];
  if (!team) {
    throw new NotFoundError(`Team not found: ${teamId}`);
  }
  return team;
}

export function requireActiveTeam(state: TeamState, teamId: string): Team {
  const team = requireTeam(state, teamId);
  if (team.status !== "active") {
    throw new InvalidStateError(`Team is not active: ${teamId}`, { status: team.status });
  }
  return team;
}

export function requireMember(state: TeamState, memberId: string): Member {
  const member = state.members[memberId];
  if (!member) {
    throw new NotFoundError(`Member not found: ${memberId}`);
  }
  return member;
}

export function requireActiveMember(state: TeamState, teamId: string, memberId: string): Member {
  const member = requireMember(state, memberId);
  if (member.teamId !== teamId) {
    throw new InvalidStateError(`Member does not belong to team: ${memberId}`, { teamId, memberTeamId: member.teamId });
  }
  if (member.status !== "active") {
    throw new InvalidStateError(`Member is not active: ${memberId}`, { status: member.status });
  }
  return member;
}

export function requireTask(state: TeamState, taskId: string): Task {
  const task = state.tasks[taskId];
  if (!task) {
    throw new NotFoundError(`Task not found: ${taskId}`);
  }
  return task;
}

export function requireTeamTask(state: TeamState, teamId: string, taskId: string): Task {
  const task = requireTask(state, taskId);
  if (task.teamId !== teamId) {
    throw new InvalidStateError(`Task does not belong to team: ${taskId}`, { teamId, taskTeamId: task.teamId });
  }
  return task;
}
