import type { AgentSessionRecord, TeamRuntime, TeamState } from "../domain/types.js";
import { InvalidStateError } from "../errors.js";
import { addEvent } from "../services/events.js";
import { requireActiveTeam, requireTeam } from "../services/guards.js";
import { nowIso } from "../utils/id.js";
import type { AgentBackend } from "./agentBackend.js";
import { AgentSpawner } from "./agentSpawner.js";
import type { RuntimePauseInput, RuntimeReadyInput, RuntimeResumeInput, RuntimeStartInput, RuntimeStatusView, RuntimeStopInput } from "./types.js";

export class RuntimeService {
  constructor(
    private readonly state: TeamState,
    private readonly backend: AgentBackend
  ) {}

  markReady(input: RuntimeReadyInput): RuntimeStatusView {
    const team = requireActiveTeam(this.state, input.teamId);
    const now = nowIso();
    const existing = this.state.teamRuntimes[team.id];
    const runtime: TeamRuntime = {
      teamId: team.id,
      status: "ready",
      backend: input.backend ?? existing?.backend ?? this.backend.name,
      workdir: input.workdir ?? existing?.workdir,
      maxParallel: input.maxParallel ?? existing?.maxParallel ?? Math.max(team.memberIds.length, 1),
      autoAssign: input.autoAssign ?? existing?.autoAssign ?? true,
      startedAt: existing?.startedAt,
      stoppedAt: existing?.stoppedAt,
      updatedAt: now
    };
    if (runtime.backend !== this.backend.name) {
      throw new InvalidStateError("Runtime backend does not match service backend", { requested: runtime.backend, actual: this.backend.name });
    }
    this.state.teamRuntimes[team.id] = runtime;
    this.state.schedulerStates[team.id] = {
      ...(this.state.schedulerStates[team.id] ?? { teamId: team.id }),
      teamId: team.id,
      paused: true,
      updatedAt: now
    };
    addEvent(this.state, {
      teamId: team.id,
      entityType: "team",
      entityId: team.id,
      type: "runtime.ready",
      message: `Runtime ready for ${team.name}`
    });
    return this.status(team.id);
  }

  async start(input: RuntimeStartInput): Promise<RuntimeStatusView> {
    const team = requireActiveTeam(this.state, input.teamId);
    const memberIds = team.memberIds.filter((memberId) => this.state.members[memberId]?.status === "active");
    const existing = this.state.teamRuntimes[team.id];
    const now = nowIso();
    const runtime: TeamRuntime = {
      teamId: team.id,
      status: "running",
      backend: input.backend ?? existing?.backend ?? this.backend.name,
      workdir: input.workdir ?? existing?.workdir,
      maxParallel: input.maxParallel ?? existing?.maxParallel ?? Math.max(memberIds.length, 1),
      autoAssign: input.autoAssign ?? existing?.autoAssign ?? true,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now
    };

    if (runtime.backend !== this.backend.name) {
      throw new InvalidStateError("Runtime backend does not match service backend", { requested: runtime.backend, actual: this.backend.name });
    }

    this.state.teamRuntimes[team.id] = runtime;
    this.state.schedulerStates[team.id] = {
      teamId: team.id,
      paused: false,
      updatedAt: now
    };

    try {
      await this.backend.start();
      const spawner = new AgentSpawner(this.state, this.backend);
      for (const memberId of memberIds.slice(0, runtime.maxParallel)) {
        await spawner.ensureSession(team.id, memberId, runtime.workdir);
      }
    } catch (error) {
      runtime.status = "error";
      runtime.updatedAt = nowIso();
      addEvent(this.state, {
        teamId: team.id,
        entityType: "team",
        entityId: team.id,
        type: "runtime.error",
        message: `Runtime failed to start: ${error instanceof Error ? error.message : String(error)}`
      });
      throw error;
    }

    addEvent(this.state, {
      teamId: team.id,
      entityType: "team",
      entityId: team.id,
      type: "runtime.started",
      message: `Started runtime for ${team.name}`
    });
    return this.status(team.id);
  }

  pause(input: RuntimePauseInput): RuntimeStatusView {
    const runtime = this.requireRuntime(input.teamId);
    runtime.status = "paused";
    runtime.updatedAt = nowIso();
    this.state.schedulerStates[input.teamId] = {
      ...(this.state.schedulerStates[input.teamId] ?? { teamId: input.teamId, lastDecision: undefined }),
      teamId: input.teamId,
      paused: true,
      updatedAt: runtime.updatedAt
    };
    addEvent(this.state, {
      teamId: input.teamId,
      entityType: "team",
      entityId: input.teamId,
      type: "runtime.paused",
      message: "Paused runtime"
    });
    return this.status(input.teamId);
  }

  resume(input: RuntimeResumeInput): RuntimeStatusView {
    const runtime = this.requireRuntime(input.teamId);
    runtime.status = "running";
    runtime.updatedAt = nowIso();
    this.state.schedulerStates[input.teamId] = {
      ...(this.state.schedulerStates[input.teamId] ?? { teamId: input.teamId, lastDecision: undefined }),
      teamId: input.teamId,
      paused: false,
      updatedAt: runtime.updatedAt
    };
    addEvent(this.state, {
      teamId: input.teamId,
      entityType: "team",
      entityId: input.teamId,
      type: "runtime.resumed",
      message: "Resumed runtime"
    });
    return this.status(input.teamId);
  }

  async stop(input: RuntimeStopInput): Promise<RuntimeStatusView> {
    const runtime = this.requireRuntime(input.teamId);
    const now = nowIso();
    const sessions = this.sessions(input.teamId).filter((session) => !input.memberIds || input.memberIds.includes(session.memberId));
    for (const session of sessions) {
      if (session.backendSessionId && session.status !== "stopped") {
        await this.backend.abortSession(session.backendSessionId);
      }
      session.status = "stopped";
      session.updatedAt = now;
    }
    if (!input.memberIds) {
      await this.backend.stop();
      runtime.status = "stopped";
      runtime.stoppedAt = now;
    }
    runtime.updatedAt = now;
    addEvent(this.state, {
      teamId: input.teamId,
      entityType: "team",
      entityId: input.teamId,
      type: "runtime.stopped",
      message: input.reason ? `Stopped runtime: ${input.reason}` : "Stopped runtime"
    });
    return this.status(input.teamId);
  }

  status(teamId: string): RuntimeStatusView {
    requireTeam(this.state, teamId);
    const runtime = this.state.teamRuntimes[teamId] ?? this.notStartedRuntime(teamId);
    return {
      runtime,
      sessions: this.sessions(teamId),
      status: runtime.status
    };
  }

  private requireRuntime(teamId: string): TeamRuntime {
    requireTeam(this.state, teamId);
    const runtime = this.state.teamRuntimes[teamId];
    if (!runtime) {
      throw new InvalidStateError("Runtime has not been started", { teamId });
    }
    return runtime;
  }

  private sessions(teamId: string): AgentSessionRecord[] {
    return Object.values(this.state.agentSessions)
      .filter((session) => session.teamId === teamId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private notStartedRuntime(teamId: string): TeamRuntime {
    return {
      teamId,
      status: "not_started",
      backend: this.backend.name,
      maxParallel: 0,
      autoAssign: false,
      updatedAt: nowIso()
    };
  }
}
