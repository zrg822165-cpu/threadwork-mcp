import type { TeamBuild, TeamState } from "../domain/types.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { teamBuilds } from "../builder/teamBuildState.js";

export function selectTeam(state: TeamState, requestedTeamId?: string) {
  if (requestedTeamId) {
    const team = state.teams[requestedTeamId];
    if (!team) {
      throw new NotFoundError(`Team not found: ${requestedTeamId}`);
    }
    return team;
  }
  const active = Object.values(state.teams).filter((team) => team.status === "active");
  if (active.length === 1) {
    return active[0];
  }
  if (active.length === 0) {
    throw new NotFoundError("No active team found. Create one with team_start or create_team first.");
  }
  throw new ConflictError("Multiple active teams found. Pass teamId explicitly.", { teamIds: active.map((team) => team.id) });
}

export function requireBuild(state: TeamState, requestedTeamId?: string) {
  const team = selectTeam(state, requestedTeamId);
  const build = openCodeBuilds(state)[team.id];
  if (!build) {
    throw new NotFoundError("No OpenCode team build exists. Start one with team_start first.", { teamId: team.id });
  }
  return build;
}

export function openCodeBuilds(state: TeamState): Record<string, TeamBuild> {
  return teamBuilds(state);
}

export function ensureBuilding(status: "building" | "finalized"): void {
  if (status !== "building") {
    throw new ConflictError("Team build is already finalized.");
  }
}
