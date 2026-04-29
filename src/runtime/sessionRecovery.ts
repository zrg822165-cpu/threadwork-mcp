import type { AgentSessionRecord, Task, TeamState } from "../domain/types.js";
import { addEvent } from "../services/events.js";
import { requireActiveTeam } from "../services/guards.js";
import { PathLockService } from "../services/pathLockService.js";
import { nowIso } from "../utils/id.js";
import type { AgentBackend } from "./agentBackend.js";
import { AgentSpawner } from "./agentSpawner.js";

export interface RecoverSessionsInput {
  teamId: string;
  sessionIds?: string[];
  staleAfterMs?: number;
  releaseClaimedTasks?: boolean;
  replaceSessions?: boolean;
  reason?: string;
}

export interface SessionRecoveryAction {
  sessionId: string;
  memberId: string;
  taskId?: string;
  action: "released_claimed_task" | "cleared_terminal_task" | "marked_stale" | "replaced_session" | "skipped";
  reason: string;
}

export interface SessionRecoveryResult {
  recoveredSessions: AgentSessionRecord[];
  replacedSessions: AgentSessionRecord[];
  releasedTasks: Task[];
  actions: SessionRecoveryAction[];
}

export class SessionRecoveryService {
  constructor(
    private readonly state: TeamState,
    private readonly backend?: AgentBackend
  ) {}

  async recover(input: RecoverSessionsInput): Promise<SessionRecoveryResult> {
    requireActiveTeam(this.state, input.teamId);
    const releaseClaimedTasks = input.releaseClaimedTasks ?? true;
    const now = nowIso();
    const sessions = this.targetSessions(input);
    const releasedTasks: Task[] = [];
    const recoveredSessions: AgentSessionRecord[] = [];
    const replaceMemberIds = new Set<string>();
    const replacedSessions: AgentSessionRecord[] = [];
    const actions: SessionRecoveryAction[] = [];

    for (const session of sessions) {
      const stale = isStale(session, input.staleAfterMs, now);
      const failedOrStopped = session.status === "error" || session.status === "stopped";
      if (!failedOrStopped && !stale) {
        actions.push({ sessionId: session.id, memberId: session.memberId, taskId: session.currentTaskId, action: "skipped", reason: "Session is not error, stopped, or stale." });
        continue;
      }

      if (stale && session.status !== "error" && session.status !== "stopped") {
        session.status = "error";
        session.errorMessage = `Session heartbeat is stale${input.reason ? `: ${input.reason}` : ""}`;
        session.updatedAt = now;
        addEvent(this.state, {
          teamId: input.teamId,
          actorMemberId: session.memberId,
          entityType: "member",
          entityId: session.memberId,
          type: "session.stale",
          message: `Marked session stale for member ${session.memberId}`
        });
        actions.push({ sessionId: session.id, memberId: session.memberId, taskId: session.currentTaskId, action: "marked_stale", reason: "Session heartbeat exceeded staleAfterMs." });
      }

      const task = session.currentTaskId ? this.state.tasks[session.currentTaskId] : undefined;
      if (!task) {
        if (session.currentTaskId) {
          session.currentTaskId = undefined;
          session.updatedAt = now;
          recoveredSessions.push(session);
        }
        if (input.replaceSessions) {
          session.status = "stopped";
          session.updatedAt = now;
          replaceMemberIds.add(session.memberId);
        }
        continue;
      }

      if (task.status === "claimed") {
        if (!releaseClaimedTasks) {
          actions.push({ sessionId: session.id, memberId: session.memberId, taskId: task.id, action: "skipped", reason: "Claimed task release was disabled." });
          continue;
        }
        task.status = "pending";
        task.assignedMemberId = undefined;
        task.claimedAt = undefined;
        task.updatedAt = now;
        session.currentTaskId = undefined;
        session.status = "stopped";
        session.updatedAt = now;
        new PathLockService(this.state).releaseTaskLocks({ teamId: input.teamId, taskId: task.id, ownerMemberId: session.memberId });
        addEvent(this.state, {
          teamId: input.teamId,
          actorMemberId: session.memberId,
          entityType: "task",
          entityId: task.id,
          type: "session.recovered",
          message: `Released claimed task ${task.title} from unrecoverable session${input.reason ? `: ${input.reason}` : ""}`
        });
        releasedTasks.push(task);
        recoveredSessions.push(session);
        if (input.replaceSessions) {
          replaceMemberIds.add(session.memberId);
        }
        actions.push({ sessionId: session.id, memberId: session.memberId, taskId: task.id, action: "released_claimed_task", reason: "Task was claimed by an error, stopped, or stale session." });
        continue;
      }

      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
        session.currentTaskId = undefined;
        session.updatedAt = now;
        recoveredSessions.push(session);
        if (input.replaceSessions) {
          session.status = "stopped";
          replaceMemberIds.add(session.memberId);
        }
        actions.push({ sessionId: session.id, memberId: session.memberId, taskId: task.id, action: "cleared_terminal_task", reason: `Task is already ${task.status}.` });
      }
    }

    if (input.replaceSessions && replaceMemberIds.size > 0) {
      if (!this.backend) {
        actions.push(...Array.from(replaceMemberIds).map((memberId) => ({ sessionId: "", memberId, action: "skipped" as const, reason: "No backend was provided for session replacement." })));
      } else {
        await this.backend.start();
        const runtime = this.state.teamRuntimes[input.teamId];
        const spawner = new AgentSpawner(this.state, this.backend);
        for (const memberId of replaceMemberIds) {
          const replacement = await spawner.ensureSession(input.teamId, memberId, runtime?.workdir);
          replacedSessions.push(replacement);
          addEvent(this.state, {
            teamId: input.teamId,
            actorMemberId: memberId,
            entityType: "member",
            entityId: memberId,
            type: "session.replaced",
            message: `Replaced runtime session for member ${memberId}${input.reason ? `: ${input.reason}` : ""}`
          });
          actions.push({ sessionId: replacement.id, memberId, action: "replaced_session", reason: "Created a replacement session for the recovered member." });
        }
      }
    }

    return { recoveredSessions, replacedSessions, releasedTasks, actions };
  }

  private targetSessions(input: RecoverSessionsInput): AgentSessionRecord[] {
    const wanted = new Set(input.sessionIds ?? []);
    return Object.values(this.state.agentSessions)
      .filter((session) => session.teamId === input.teamId)
      .filter((session) => wanted.size === 0 || wanted.has(session.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

function isStale(session: AgentSessionRecord, staleAfterMs: number | undefined, now: string): boolean {
  if (!staleAfterMs || staleAfterMs <= 0 || session.status !== "working" && session.status !== "waiting") {
    return false;
  }
  const heartbeat = session.lastHeartbeatAt ?? session.updatedAt;
  return Date.parse(now) - Date.parse(heartbeat) > staleAfterMs;
}
