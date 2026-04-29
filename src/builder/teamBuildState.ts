import type { Team, TeamBuild, TeamState } from "../domain/types.js";
import { ConflictError, NotFoundError } from "../errors.js";

export function teamBuilds(state: TeamState): Record<string, TeamBuild> {
  state.teamBuilds ??= {};
  return state.teamBuilds;
}

export function selectTeam(state: TeamState, requestedTeamId?: string): Team {
  if (requestedTeamId) {
    const team = state.teams[requestedTeamId];
    if (!team) {
      throw new NotFoundError(`Team not found: ${requestedTeamId}`);
    }
    return team;
  }
  const active = Object.values(state.teams).filter((team) => team.status === "active");
  if (active.length === 1) {
    return active[0]!;
  }
  if (active.length === 0) {
    throw new NotFoundError("No active team found. Create one with team_start or create_team first.");
  }
  throw new ConflictError("Multiple active teams found. Pass teamId explicitly.", { teamIds: active.map((team) => team.id) });
}

export function requireTeamBuild(state: TeamState, requestedTeamId?: string): TeamBuild {
  const team = selectTeam(state, requestedTeamId);
  const build = teamBuilds(state)[team.id];
  if (!build) {
    throw new NotFoundError("No team build exists. Start one with team_start first.", { teamId: team.id });
  }
  return build;
}
