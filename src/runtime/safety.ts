import type {
  SafetySignal,
  SafetySignalKind,
  SafetySignalLevel,
  SafetySignalStatus,
  Task,
  TaskBoundary,
  TeamState
} from "../domain/types.js";
import { normalizeTeamPath } from "../services/pathMatch.js";
import { newId, nowIso } from "../utils/id.js";

export interface SafetyCompactSummary {
  level: SafetySignalLevel;
  headline: string;
  taskId?: string;
  recommendedAction: string;
}

export interface RuntimeSafetySummary {
  openSignals: SafetySignal[];
  highestLevel?: SafetySignalLevel;
  needsReviewCount: number;
  blockedCount: number;
  recent: SafetySignal[];
  compact?: SafetyCompactSummary;
}

export function getSafetySignal(state: TeamState, signalId: string): SafetySignal | undefined {
  return state.safetySignals[signalId];
}

export function syncTaskBoundary(state: TeamState, task: Task): TaskBoundary {
  const now = nowIso();
  const scopePaths = task.pathHints.map(normalizeTeamPath).filter(Boolean);
  const existing = state.taskBoundaries[task.id];
  const boundary: TaskBoundary = {
    taskId: task.id,
    teamId: task.teamId,
    scopePaths,
    scopeSource: scopePaths.length > 0 ? "path_hints" : "none",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    closedAt: existing?.closedAt
  };
  state.taskBoundaries[task.id] = boundary;
  return boundary;
}

export function closeTaskBoundary(state: TeamState, taskId: string): TaskBoundary | undefined {
  const boundary = state.taskBoundaries[taskId];
  if (!boundary) {
    return undefined;
  }
  const now = nowIso();
  boundary.closedAt ??= now;
  boundary.updatedAt = now;
  return boundary;
}

export function recordScopeMissingSignal(state: TeamState, task: Task): SafetySignal {
  return upsertSafetySignal(state, {
    teamId: task.teamId,
    taskId: task.id,
    kind: "scope_missing",
    level: "warning",
    summary: `Task ${task.id} has no explicit edit scope.`
  });
}

export function recordScopeWarningSignal(
  state: TeamState,
  input: { teamId: string; taskId: string; memberId?: string; summary: string }
): SafetySignal {
  return upsertSafetySignal(state, {
    ...input,
    kind: "scope_warning",
    level: "needs_review"
  });
}

export function recordPolicyBlockedSignal(
  state: TeamState,
  input: { teamId: string; taskId?: string; memberId?: string; summary: string }
): SafetySignal {
  return upsertSafetySignal(state, {
    ...input,
    kind: "policy_blocked",
    level: "blocked"
  });
}

export function resolveTaskSignals(
  state: TeamState,
  taskId: string,
  kinds?: SafetySignalKind[]
): number {
  return resolveSignals(state, (signal) => (
    signal.taskId === taskId
    && (!kinds || kinds.includes(signal.kind))
  ));
}

export function openSafetySignalsForTask(
  state: TeamState,
  taskId: string,
  levels?: SafetySignalLevel[]
): SafetySignal[] {
  return sortSignals(Object.values(state.safetySignals).filter((signal) => (
    signal.taskId === taskId
    && isActiveSignal(signal.status)
    && (!levels || levels.includes(signal.level))
  )));
}

export function summarizeTeamSafety(state: TeamState, teamId: string): RuntimeSafetySummary {
  const openSignals = sortSignals(Object.values(state.safetySignals).filter((signal) => (
    signal.teamId === teamId
    && isActiveSignal(signal.status)
  )));
  const top = openSignals[0];
  return {
    openSignals,
    highestLevel: top?.level,
    needsReviewCount: openSignals.filter((signal) => signal.level === "needs_review").length,
    blockedCount: openSignals.filter((signal) => signal.level === "blocked").length,
    recent: openSignals.slice(0, 5),
    compact: top ? {
      level: top.level,
      headline: top.summary,
      taskId: top.taskId,
      recommendedAction: recommendedActionForSignal(top)
    } : undefined
  };
}

export function resolveSafetySignal(state: TeamState, signalId: string): SafetySignal | undefined {
  const signal = state.safetySignals[signalId];
  if (!signal || signal.status === "resolved") {
    return undefined;
  }
  const now = nowIso();
  signal.status = "resolved";
  signal.updatedAt = now;
  signal.resolvedAt = now;
  return signal;
}

export function acknowledgeSafetySignal(
  state: TeamState,
  signalId: string,
  options?: { summary?: string; level?: SafetySignalLevel }
): SafetySignal | undefined {
  const signal = state.safetySignals[signalId];
  if (!signal || signal.status === "resolved") {
    return undefined;
  }
  const now = nowIso();
  signal.status = "acknowledged";
  signal.summary = options?.summary ?? signal.summary;
  signal.level = options?.level ?? signal.level;
  signal.updatedAt = now;
  delete signal.resolvedAt;
  return signal;
}

export function resolveSafetySignalsByIds(state: TeamState, signalIds: string[]): SafetySignal[] {
  const resolved: SafetySignal[] = [];
  for (const signalId of signalIds) {
    const signal = resolveSafetySignal(state, signalId);
    if (signal) {
      resolved.push(signal);
    }
  }
  return resolved;
}

function upsertSafetySignal(
  state: TeamState,
  input: {
    teamId: string;
    taskId?: string;
    memberId?: string;
    kind: SafetySignalKind;
    level: SafetySignalLevel;
    summary: string;
  }
): SafetySignal {
  const now = nowIso();
  const existing = Object.values(state.safetySignals).find((signal) => (
    signal.status !== "resolved"
    && signal.teamId === input.teamId
    && signal.taskId === input.taskId
    && signal.memberId === input.memberId
    && signal.kind === input.kind
  ));
  if (existing) {
    existing.status = "open";
    existing.level = input.level;
    existing.summary = input.summary;
    existing.updatedAt = now;
    delete existing.resolvedAt;
    return existing;
  }

  const signal: SafetySignal = {
    id: newId("signal"),
    teamId: input.teamId,
    taskId: input.taskId,
    memberId: input.memberId,
    kind: input.kind,
    level: input.level,
    summary: input.summary,
    status: "open",
    createdAt: now,
    updatedAt: now
  };
  state.safetySignals[signal.id] = signal;
  return signal;
}

function resolveSignals(state: TeamState, matches: (signal: SafetySignal) => boolean): number {
  const now = nowIso();
  let resolved = 0;
  for (const signal of Object.values(state.safetySignals)) {
    if (signal.status === "resolved" || !matches(signal)) {
      continue;
    }
    signal.status = "resolved";
    signal.updatedAt = now;
    signal.resolvedAt = now;
    resolved += 1;
  }
  return resolved;
}

function sortSignals(signals: SafetySignal[]): SafetySignal[] {
  return [...signals].sort((first, second) => (
    levelRank(second.level) - levelRank(first.level)
    || second.updatedAt.localeCompare(first.updatedAt)
    || second.createdAt.localeCompare(first.createdAt)
  ));
}

function levelRank(level: SafetySignalLevel): number {
  if (level === "blocked") {
    return 3;
  }
  if (level === "needs_review") {
    return 2;
  }
  return 1;
}

export function recommendedActionForSignal(signal: SafetySignal): string {
  if (signal.kind === "scope_missing") {
    return signal.taskId
      ? `Use team_work with work.review.decision=revise_scope and pathHints to update task ${signal.taskId} before rerunning work.`
      : "Use team_work with work.review.decision=revise_scope and pathHints before rerunning work.";
  }
  if (signal.kind === "scope_warning") {
    return "Use team_work with work.review.decision=approve_scope_exception to review the out-of-scope edit request before rerunning work.";
  }
  if (signal.status === "acknowledged") {
    return "Continue manually or adjust member permissions before rerunning work.";
  }
  return "Use team_work with work.review.decision=acknowledge to review the blocked action before rerunning work.";
}

function isActiveSignal(status: SafetySignalStatus): boolean {
  return status === "open" || status === "acknowledged";
}
