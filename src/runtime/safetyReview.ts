import type { SafetySignal, TeamState } from "../domain/types.js";
import { InvalidStateError } from "../errors.js";
import { addEvent } from "../services/events.js";
import { requireActiveTeam, requireTeamTask } from "../services/guards.js";
import { TaskService } from "../services/taskService.js";
import { acknowledgeSafetySignal, getSafetySignal, openSafetySignalsForTask, resolveSafetySignal } from "./safety.js";

export type SafetyReviewDecision =
  | "revise_scope"
  | "approve_scope_exception"
  | "acknowledge"
  | "cancel_task";

export interface SafetyReviewInput {
  teamId: string;
  taskId?: string;
  signalId?: string;
  decision: SafetyReviewDecision;
  note?: string;
  pathHints?: string[];
}

export interface SafetyReviewResult {
  decision: SafetyReviewDecision;
  signalId?: string;
  taskId?: string;
  resolvedSignalIds: string[];
  forceAutoRunFalse: boolean;
  postReviewAction: string;
}

export class SafetyReviewService {
  constructor(private readonly state: TeamState) {}

  review(input: SafetyReviewInput): SafetyReviewResult {
    requireActiveTeam(this.state, input.teamId);
    const signal = this.resolveSignal(input);
    const taskId = input.taskId ?? signal?.taskId;
    const note = input.note?.trim() || undefined;

    switch (input.decision) {
      case "revise_scope":
        return this.reviseScope(input, signal, taskId, note);
      case "approve_scope_exception":
        return this.approveScopeException(input, signal, taskId, note);
      case "acknowledge":
        return this.acknowledge(input, signal, taskId, note);
      case "cancel_task":
        return this.cancelTask(input, signal, taskId, note);
    }
  }

  private resolveSignal(input: SafetyReviewInput): SafetySignal | undefined {
    if (input.signalId) {
      const signal = getSafetySignal(this.state, input.signalId);
      if (!signal || signal.teamId !== input.teamId || signal.status !== "open") {
        throw new InvalidStateError("Safety signal is not open for this team", {
          teamId: input.teamId,
          signalId: input.signalId
        });
      }
      if (input.taskId && signal.taskId && signal.taskId !== input.taskId) {
        throw new InvalidStateError("Safety signal does not match the requested task", {
          teamId: input.teamId,
          signalId: input.signalId,
          taskId: input.taskId,
          signalTaskId: signal.taskId
        });
      }
      return signal;
    }

    if (!input.taskId) {
      throw new InvalidStateError("Pass signalId or taskId when reviewing safety state", {
        teamId: input.teamId,
        decision: input.decision
      });
    }

    const signal = openSafetySignalsForTask(this.state, input.taskId)
      .find((candidate) => candidate.status === "open");
    if (!signal) {
      throw new InvalidStateError("No open safety signal exists for the requested task", {
        teamId: input.teamId,
        taskId: input.taskId
      });
    }
    return signal;
  }

  private reviseScope(
    input: SafetyReviewInput,
    signal: SafetySignal | undefined,
    taskId: string | undefined,
    note: string | undefined
  ): SafetyReviewResult {
    if (!signal || signal.kind !== "scope_missing" || !taskId) {
      throw new InvalidStateError("revise_scope requires an open scope_missing signal for a task", {
        teamId: input.teamId,
        signalId: signal?.id,
        taskId
      });
    }
    const task = requireTeamTask(this.state, input.teamId, taskId);
    if (task.status !== "pending") {
      throw new InvalidStateError("Only pending tasks can change pathHints through revise_scope", {
        teamId: input.teamId,
        taskId,
        status: task.status
      });
    }
    if (!input.pathHints || input.pathHints.length === 0) {
      throw new InvalidStateError("revise_scope requires non-empty pathHints", {
        teamId: input.teamId,
        taskId
      });
    }

    new TaskService(this.state).updateTask({
      teamId: input.teamId,
      taskId,
      pathHints: input.pathHints
    });
    this.recordReviewEvent(input.teamId, taskId, signal, "revise_scope", note);

    return {
      decision: "revise_scope",
      signalId: signal.id,
      taskId,
      resolvedSignalIds: signal.status === "resolved" ? [signal.id] : [],
      forceAutoRunFalse: false,
      postReviewAction: `Task ${taskId} scope was updated during host review. Continue when ready.`
    };
  }

  private approveScopeException(
    input: SafetyReviewInput,
    signal: SafetySignal | undefined,
    taskId: string | undefined,
    note: string | undefined
  ): SafetyReviewResult {
    if (!signal || signal.kind !== "scope_warning") {
      throw new InvalidStateError("approve_scope_exception requires an open scope_warning signal", {
        teamId: input.teamId,
        signalId: signal?.id
      });
    }
    const resolved = resolveSafetySignal(this.state, signal.id);
    this.recordReviewEvent(input.teamId, taskId, signal, "approve_scope_exception", note);

    return {
      decision: "approve_scope_exception",
      signalId: signal.id,
      taskId,
      resolvedSignalIds: resolved ? [resolved.id] : [],
      forceAutoRunFalse: false,
      postReviewAction: taskId
        ? `The out-of-scope request for task ${taskId} was reviewed. Continue the task manually when ready.`
        : "The out-of-scope request was reviewed. Continue manually when ready."
    };
  }

  private acknowledge(
    input: SafetyReviewInput,
    signal: SafetySignal | undefined,
    taskId: string | undefined,
    note: string | undefined
  ): SafetyReviewResult {
    if (!signal) {
      throw new InvalidStateError("acknowledge requires an open safety signal", {
        teamId: input.teamId
      });
    }
    const isBlockedAction = signal.kind === "policy_blocked";
    const updated = isBlockedAction
      ? acknowledgeSafetySignal(this.state, signal.id, {
        summary: "The blocked action was acknowledged, but permissions were not changed.",
        level: "blocked"
      })
      : resolveSafetySignal(this.state, signal.id);
    this.recordReviewEvent(input.teamId, taskId, signal, "acknowledge", note);

    return {
      decision: "acknowledge",
      signalId: signal.id,
      taskId,
      resolvedSignalIds: !isBlockedAction && updated ? [updated.id] : [],
      forceAutoRunFalse: isBlockedAction,
      postReviewAction: isBlockedAction
        ? "The blocked action was acknowledged, but permissions were not changed; continue manually or adjust member permissions before rerunning work."
        : taskId
          ? `The safety signal for task ${taskId} was acknowledged. Continue when ready.`
          : "The safety signal was acknowledged. Continue when ready."
    };
  }

  private cancelTask(
    input: SafetyReviewInput,
    signal: SafetySignal | undefined,
    taskId: string | undefined,
    note: string | undefined
  ): SafetyReviewResult {
    if (!taskId) {
      throw new InvalidStateError("cancel_task requires a taskId or task-scoped signal", {
        teamId: input.teamId,
        signalId: signal?.id
      });
    }

    new TaskService(this.state).cancelTask({
      teamId: input.teamId,
      taskId,
      reason: note ?? (signal ? `Cancelled after safety review: ${signal.summary}` : "Cancelled after safety review")
    });
    this.recordReviewEvent(input.teamId, taskId, signal, "cancel_task", note);

    return {
      decision: "cancel_task",
      signalId: signal?.id,
      taskId,
      resolvedSignalIds: signal?.status === "resolved" ? [signal.id] : [],
      forceAutoRunFalse: true,
      postReviewAction: `Task ${taskId} was cancelled after host safety review.`
    };
  }

  private recordReviewEvent(
    teamId: string,
    taskId: string | undefined,
    signal: SafetySignal | undefined,
    decision: SafetyReviewDecision,
    note: string | undefined
  ): void {
    const signalLabel = signal ? ` for ${signal.kind}` : "";
    const noteLabel = note ? `: ${note}` : "";
    addEvent(this.state, {
      teamId,
      entityType: taskId ? "task" : "member",
      entityId: taskId ?? signal?.memberId ?? teamId,
      type: "safety.reviewed",
      message: `Host reviewed safety with ${decision}${signalLabel}${taskId ? ` on ${taskId}` : ""}${noteLabel}`
    });
  }
}
