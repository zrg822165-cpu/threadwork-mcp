import type { Event, TeamBuild, TeamRuntime, TeamState } from "../domain/types.js";
import type { RuntimeControlPlane } from "./controlPlane.js";
import type { DiscussionThreadState } from "./discussionState.js";
import type { SafetyCompactSummary } from "./safety.js";
import type { RuntimeResults } from "./timeline.js";

export type ContinuationActionKind =
  | "resume_same_task"
  | "recover_session_then_retry"
  | "review_before_continue"
  | "create_followup_task";

export interface ContinuationAction {
  kind: ContinuationActionKind;
  taskId?: string;
  headline: string;
}

export interface RuntimeExplainability {
  phase: "building" | "ready" | "running" | "attention" | "idle";
  headline: string;
  blockingReason?: string;
  recommendedNextAction: string;
  recoveryHint?: string;
  continuation?: ContinuationAction;
  safety?: SafetyCompactSummary;
  lastMeaningfulEvent?: Pick<Event, "type" | "message" | "createdAt">;
}

export interface RuntimeResultsExplainability extends RuntimeExplainability {
  resultSummary: string;
  failureSummary?: string;
}

export type HostAttentionIssueKind =
  | "blocked_safety"
  | "needs_review_safety"
  | "failed_task"
  | "runtime_error"
  | "broken_claimed_session"
  | "runtime_paused"
  | "discussion_ready_for_host"
  | "unread_escalation"
  | "dependency_blocked"
  | "warning_safety";

export interface HostAttentionIssue {
  kind: HostAttentionIssueKind;
  headline: string;
  blockingReason?: string;
  recommendedNextAction: string;
  recoveryHint?: string;
}

export function explainRuntimeStatus(
  state: TeamState,
  build: TeamBuild | undefined,
  runtime: TeamRuntime,
  controlPlane: RuntimeControlPlane
): RuntimeExplainability {
  const lastMeaningfulEvent = recentMeaningfulEvent(state, runtime.teamId);
  const safety = controlPlane.safety.compact;
  const issue = highestPriorityHostIssue([
    ...(safety ? [attentionIssueForSafety(safety)] : []),
    ...(controlPlane.taskBuckets.failed.length > 0 ? [failedTaskIssue(controlPlane)] : []),
    ...(runtime.status === "error" ? [runtimeErrorIssue()] : []),
    ...(brokenClaimedSessionIssue(state, runtime.teamId) ? [brokenClaimedSessionIssue(state, runtime.teamId)!] : []),
    ...(runtime.status === "paused" ? [runtimePausedIssue()] : []),
    ...(discussionReadyForHostIssue(controlPlane) ? [discussionReadyForHostIssue(controlPlane)!] : []),
    ...(shouldSurfaceUnreadAttentionIssue(controlPlane) ? [unreadEscalationIssue(controlPlane)] : []),
    ...(controlPlane.taskBuckets.blockedByDependency.length > 0 ? [dependencyBlockedIssue(controlPlane)] : [])
  ]);
  const continuation = continuationForHostIssue(issue);
  const recommendedNextAction = issue?.recommendedNextAction ?? controlPlane.nextActions[0] ?? "No action needed.";
  const blockingReason = issue?.blockingReason ?? statusBlockingReason(runtime, controlPlane);
  const recoveryHint = issue?.recoveryHint ?? statusRecoveryHint(runtime, controlPlane);

  if (build && build.status !== "finalized") {
    return {
      phase: "building",
      headline: `Team setup is still in progress with ${build.confirmedMemberIds.length} confirmed member${build.confirmedMemberIds.length === 1 ? "" : "s"}.`,
      blockingReason: build.currentDraft
        ? `A draft for ${build.currentDraft.name} is waiting for confirmation or revision.`
        : "The team is not finished yet.",
      recommendedNextAction,
      continuation: {
        kind: "review_before_continue",
        headline: "Finish team setup before continuing runtime work."
      },
      safety,
      lastMeaningfulEvent
    };
  }

  if (issue) {
    return {
      phase: "attention",
      headline: issue.headline,
      blockingReason,
      recommendedNextAction,
      recoveryHint,
      continuation,
      safety,
      lastMeaningfulEvent
    };
  }

  if (runtime.status === "ready") {
    return {
      phase: "ready",
      headline: "Runtime is ready, but work is not running yet.",
      recommendedNextAction,
      continuation: {
        kind: "resume_same_task",
        headline: "Runtime work can start when the host is ready."
      },
      safety,
      lastMeaningfulEvent
    };
  }

  if (runtime.status === "paused" || runtime.status === "error" || controlPlane.taskBuckets.failed.length > 0) {
    return {
      phase: "attention",
      headline: statusHeadline(runtime, controlPlane),
      blockingReason,
      recommendedNextAction,
      recoveryHint,
      continuation,
      safety,
      lastMeaningfulEvent
    };
  }

  if (runtime.status === "running") {
    return {
      phase: "running",
      headline: statusHeadline(runtime, controlPlane),
      blockingReason,
      recommendedNextAction,
      recoveryHint,
      continuation: {
        kind: "resume_same_task",
        headline: "Current runtime work can continue inside the existing task boundary."
      },
      safety,
      lastMeaningfulEvent
    };
  }

  return {
    phase: "idle",
    headline: statusHeadline(runtime, controlPlane),
    blockingReason,
    recommendedNextAction,
    recoveryHint,
    continuation,
    safety,
    lastMeaningfulEvent
  };
}

export function explainRuntimeResults(
  state: TeamState,
  runtime: TeamRuntime,
  controlPlane: RuntimeControlPlane,
  results: RuntimeResults
): RuntimeResultsExplainability {
  const base = explainRuntimeStatus(state, undefined, runtime, controlPlane);
  const latestFailure = results.failuresNeedingAttention[0];
  const latestCompleted = results.taskResults.find((result) => result.task.status === "completed");
  const latestFailureContributor = latestFailure
    ? results.memberContributions.find((contribution) => contribution.failedTaskIds.includes(latestFailure.task.id))
    : undefined;
  const latestCompletedContributor = latestCompleted
    ? results.memberContributions.find((contribution) => contribution.completedTaskIds.includes(latestCompleted.task.id))
    : undefined;
  const resultSummary = latestFailure
    ? `${results.failedTasks.length} failed task${results.failedTasks.length === 1 ? "" : "s"} need attention; latest: ${latestFailure.task.title}${latestFailureContributor ? ` by ${latestFailureContributor.memberName}` : ""}.`
    : latestCompleted
      ? `${results.completedTasks.length} completed task${results.completedTasks.length === 1 ? "" : "s"}; latest: ${latestCompleted.task.title}${latestCompletedContributor ? ` by ${latestCompletedContributor.memberName}` : ""}.`
      : "No completed or failed task results yet.";
  const attentionDominatesResults = (base.safety?.level === "blocked" || base.safety?.level === "needs_review")
    || runtime.status === "paused"
    || runtime.status === "error"
    || (base.safety?.level === "warning" && !latestFailure)
    || (!latestFailure && shouldSurfaceUnreadAttentionIssue(controlPlane))
    || (!latestFailure && controlPlane.taskBuckets.blockedByDependency.length > 0);

  return {
    ...base,
    headline: attentionDominatesResults
      ? base.headline
      : latestFailure
        ? `Latest failure${latestFailureContributor ? ` from ${latestFailureContributor.memberName}` : ""}: ${latestFailure.summary ?? latestFailure.task.failureSummary ?? latestFailure.task.title}`
        : latestCompleted
          ? `Latest result${latestCompletedContributor ? ` from ${latestCompletedContributor.memberName}` : ""}: ${latestCompleted.summary ?? latestCompleted.task.completionSummary ?? latestCompleted.task.title}`
          : base.headline,
    failureSummary: latestFailure?.summary,
    resultSummary: attentionDominatesResults
      ? `Current attention state: ${base.blockingReason ?? base.headline}`
      : resultSummary
  };
}

export function highestPriorityHostIssue<T extends HostAttentionIssue>(issues: T[]): T | undefined {
  return [...issues].sort((first, second) => hostIssuePriority(second.kind) - hostIssuePriority(first.kind))[0];
}

function shouldSurfaceUnreadAttentionIssue(controlPlane: RuntimeControlPlane): boolean {
  if (controlPlane.inbox.threadsNeedingAttention.length === 0) {
    return false;
  }
  const activeDiscussion = controlPlane.inbox.activeThreads[0];
  if (!activeDiscussion) {
    return true;
  }
  return activeDiscussion.proposedNextAction.kind === "none"
    || activeDiscussion.proposedNextAction.kind === "summarize_conclusion";
}

export function continuationForHostIssue(
  issue: HostAttentionIssue | undefined,
  taskId?: string
): ContinuationAction | undefined {
  if (!issue) {
    return undefined;
  }

  switch (issue.kind) {
    case "broken_claimed_session":
      return {
        kind: "recover_session_then_retry",
        taskId,
        headline: "Recover the broken claimed session before retrying this task."
      };
    case "failed_task":
      return {
        kind: "create_followup_task",
        taskId,
        headline: "Create follow-up work after reviewing the failed task."
      };
    case "blocked_safety":
    case "needs_review_safety":
    case "runtime_error":
    case "runtime_paused":
    case "discussion_ready_for_host":
    case "unread_escalation":
    case "dependency_blocked":
      return {
        kind: "review_before_continue",
        taskId,
        headline: "Review the current runtime state before continuing work."
      };
    case "warning_safety":
      return {
        kind: "resume_same_task",
        taskId,
        headline: "Current work can continue, but the warning should remain visible."
      };
  }
}

function statusHeadline(runtime: TeamRuntime, controlPlane: RuntimeControlPlane): string {
  if (runtime.status === "paused") {
    return "Runtime is paused and waiting for manual follow-up.";
  }
  if (runtime.status === "error") {
    return "Runtime is in error state and needs recovery before it can continue.";
  }
  if (controlPlane.taskBuckets.failed.length > 0) {
    return `${controlPlane.taskBuckets.failed.length} failed task${controlPlane.taskBuckets.failed.length === 1 ? "" : "s"} need attention.`;
  }
  if (controlPlane.taskBuckets.blockedByDependency.length > 0) {
    return `${controlPlane.taskBuckets.blockedByDependency.length} task${controlPlane.taskBuckets.blockedByDependency.length === 1 ? " is" : "s are"} blocked by dependencies.`;
  }
  const activeDiscussion = controlPlane.inbox.activeThreads[0];
  if (activeDiscussion && activeDiscussion.lifecycleState !== "settled") {
    return discussionHeadline(activeDiscussion);
  }
  if (controlPlane.inbox.activeConversationTurns.length > 0) {
    return `${controlPlane.inbox.activeConversationTurns.length} teammate${controlPlane.inbox.activeConversationTurns.length === 1 ? " is" : "s are"} handling active mailbox turns.`;
  }
  if (controlPlane.inbox.threadsNeedingAttention.length > 0) {
    return `${controlPlane.inbox.threadsNeedingAttention.length} unread runtime message${controlPlane.inbox.threadsNeedingAttention.length === 1 ? " needs" : "s need"} attention.`;
  }
  if (runtime.status === "running") {
    return `${controlPlane.activeWork.length} active task${controlPlane.activeWork.length === 1 ? "" : "s"}; ${controlPlane.taskBuckets.runnable.length} runnable next.`;
  }
  return `Runtime is ${runtime.status}.`;
}

function statusBlockingReason(runtime: TeamRuntime, controlPlane: RuntimeControlPlane): string | undefined {
  if (runtime.status === "paused") {
    return "Scheduling is paused.";
  }
  if (runtime.status === "error") {
    return "The runtime itself is errored.";
  }
  if (controlPlane.taskBuckets.failed.length > 0) {
    const failedTask = controlPlane.taskBuckets.failed[0]!;
    return failedTask.failureSummary ?? `Task ${failedTask.id} failed.`;
  }
  if (controlPlane.taskBuckets.blockedByDependency.length > 0) {
    const blockedTask = controlPlane.taskBuckets.blockedByDependency[0]!;
    return blockedTask.blockReasons?.[0] ?? `Task ${blockedTask.id} is blocked.`;
  }
  const activeDiscussion = controlPlane.inbox.activeThreads[0];
  if (activeDiscussion && activeDiscussion.lifecycleState !== "settled") {
    return controlPlane.inbox.discussionProgressSummary ?? discussionBlockingReason(activeDiscussion);
  }
  if (controlPlane.inbox.threadsNeedingAttention.length > 0) {
    const message = controlPlane.inbox.threadsNeedingAttention[0]!;
    return message.subject ?? message.body;
  }
  return undefined;
}

function statusRecoveryHint(runtime: TeamRuntime, controlPlane: RuntimeControlPlane): string | undefined {
  if (runtime.status === "paused") {
    return "Resume scheduling only after the team is ready to continue work.";
  }
  if (runtime.status === "error") {
    return "Inspect errored sessions and recover or replace them before rerunning work.";
  }
  if (controlPlane.taskBuckets.failed.length > 0) {
    return "Create follow-up work after reviewing the failed task summary.";
  }
  if (controlPlane.taskBuckets.blockedByDependency.length > 0) {
    return "Finish or unblock the dependency task before rerunning the blocked task.";
  }
  const activeDiscussion = controlPlane.inbox.activeThreads[0];
  if (activeDiscussion) {
    if (activeDiscussion.proposedNextAction.kind === "host_decision") {
      return "Review the discussion thread and decide how the team should proceed.";
    }
    if (activeDiscussion.proposedNextAction.kind === "wait_for_members" || activeDiscussion.proposedNextAction.kind === "prompt_member") {
      return "Continue with team_work to advance active discussion turns and collect the remaining member responses.";
    }
    if (activeDiscussion.proposedNextAction.kind === "continue_discussion") {
      return "Continue with team_work so the team can resolve the remaining discussion question.";
    }
  }
  if (controlPlane.inbox.threadsNeedingAttention.length > 0) {
    return "Read the unread runtime message before asking the team to continue.";
  }
  return undefined;
}

function recentMeaningfulEvent(state: TeamState, teamId: string): Pick<Event, "type" | "message" | "createdAt"> | undefined {
  return [...state.events]
    .reverse()
    .find((event) => event.teamId === teamId || !event.teamId);
}

function attentionIssueForSafety(safety: SafetyCompactSummary): HostAttentionIssue {
  return {
    kind: safety.level === "blocked"
      ? "blocked_safety"
      : safety.level === "needs_review"
        ? "needs_review_safety"
        : "warning_safety",
    headline: safety.level === "blocked"
      ? `Safety block: ${safety.headline}`
      : safety.level === "needs_review"
        ? `Safety review required: ${safety.headline}`
        : `Safety warning: ${safety.headline}`,
    blockingReason: safety.headline,
    recommendedNextAction: safety.recommendedAction,
    recoveryHint: safety.recommendedAction
  };
}

function failedTaskIssue(controlPlane: RuntimeControlPlane): HostAttentionIssue {
  const failedTask = controlPlane.taskBuckets.failed[0]!;
  return {
    kind: "failed_task",
    headline: `${controlPlane.taskBuckets.failed.length} failed task${controlPlane.taskBuckets.failed.length === 1 ? "" : "s"} need attention.`,
    blockingReason: failedTask.failureSummary ?? `Task ${failedTask.id} failed.`,
    recommendedNextAction: "Review the failed task summary and create follow-up work before continuing.",
    recoveryHint: "Create follow-up work after reviewing the failed task summary."
  };
}

function runtimeErrorIssue(): HostAttentionIssue {
  return {
    kind: "runtime_error",
    headline: "Runtime is in error state and needs recovery before it can continue.",
    blockingReason: "The runtime itself is errored.",
    recommendedNextAction: "Inspect error sessions and recover or replace blocked work before continuing.",
    recoveryHint: "Inspect errored sessions and recover or replace them before rerunning work."
  };
}

function brokenClaimedSessionIssue(state: TeamState, teamId: string): HostAttentionIssue | undefined {
  const session = Object.values(state.agentSessions).find((candidate) => (
    candidate.teamId === teamId
    && !!candidate.currentTaskId
    && (candidate.status === "error" || candidate.status === "stopped")
  ));
  if (!session) {
    return undefined;
  }

  return {
    kind: "broken_claimed_session",
    headline: `Claimed task ${session.currentTaskId} is waiting on a ${session.status} session.`,
    blockingReason: `Session ${session.id} is ${session.status}.`,
    recommendedNextAction: "Inspect the claimed task session, then recover or reassign the blocked work before continuing.",
    recoveryHint: "Recover or replace the broken session before rerunning the affected task."
  };
}

function runtimePausedIssue(): HostAttentionIssue {
  return {
    kind: "runtime_paused",
    headline: "Runtime is paused and waiting for manual follow-up.",
    blockingReason: "Scheduling is paused.",
    recommendedNextAction: "Resume the paused runtime manually when the team should continue scheduling work.",
    recoveryHint: "Resume scheduling only after the team is ready to continue work."
  };
}

function discussionReadyForHostIssue(controlPlane: RuntimeControlPlane): HostAttentionIssue | undefined {
  const thread = controlPlane.inbox.activeThreads.find((candidate) => candidate.proposedNextAction.kind === "host_decision");
  if (!thread) {
    return undefined;
  }

  return {
    kind: "discussion_ready_for_host",
    headline: discussionHeadline(thread),
    blockingReason: controlPlane.inbox.discussionHostAttentionSummary ?? discussionBlockingReason(thread),
    recommendedNextAction: "Review the active discussion thread and decide how the team should proceed.",
    recoveryHint: "Inspect the discussion thread, then continue with team_work once the host decision is clear."
  };
}

function unreadEscalationIssue(controlPlane: RuntimeControlPlane): HostAttentionIssue {
  const message = controlPlane.inbox.threadsNeedingAttention[0]!;
  const isEscalation = message.type === "escalation";
  const needsLabel = controlPlane.inbox.threadsNeedingAttention.length === 1 ? "needs" : "need";
  const targetLabel = controlPlane.host.escalationTarget === "lead_member"
    ? controlPlane.host.leadMemberName
      ? `lead member ${controlPlane.host.leadMemberName}`
      : "the explicit lead member"
    : "the host";
  const recommendedNextAction = isEscalation
    ? `Review the unread runtime escalation for ${targetLabel} before rerunning work.`
    : "Review unread runtime messages or route them to the relevant teammate.";

  return {
    kind: "unread_escalation",
    headline: isEscalation
      ? `${controlPlane.inbox.threadsNeedingAttention.length} unread runtime escalation${controlPlane.inbox.threadsNeedingAttention.length === 1 ? "" : "s"} ${needsLabel} attention from ${targetLabel}.`
      : `${controlPlane.inbox.threadsNeedingAttention.length} unread runtime message${controlPlane.inbox.threadsNeedingAttention.length === 1 ? " needs" : "s need"} attention.`,
    blockingReason: message.subject ?? message.body,
    recommendedNextAction,
    recoveryHint: isEscalation
      ? `Read the unread runtime escalation for ${targetLabel} before asking the team to continue.`
      : "Read the unread runtime message before asking the team to continue."
  };
}

function dependencyBlockedIssue(controlPlane: RuntimeControlPlane): HostAttentionIssue {
  const blockedTask = controlPlane.taskBuckets.blockedByDependency[0]!;
  return {
    kind: "dependency_blocked",
    headline: `${controlPlane.taskBuckets.blockedByDependency.length} task${controlPlane.taskBuckets.blockedByDependency.length === 1 ? " is" : "s are"} blocked by dependencies.`,
    blockingReason: blockedTask.blockReasons?.[0] ?? `Task ${blockedTask.id} is blocked.`,
    recommendedNextAction: "Resolve or complete dependency tasks before blocked pending work can run.",
    recoveryHint: "Finish or unblock the dependency task before rerunning the blocked task."
  };
}

function hostIssuePriority(kind: HostAttentionIssueKind): number {
  switch (kind) {
    case "blocked_safety":
      return 900;
    case "needs_review_safety":
      return 800;
    case "failed_task":
      return 700;
    case "runtime_error":
      return 650;
    case "broken_claimed_session":
      return 600;
    case "runtime_paused":
      return 550;
    case "discussion_ready_for_host":
      return 525;
    case "unread_escalation":
      return 500;
    case "dependency_blocked":
      return 400;
    case "warning_safety":
      return 300;
  }
}

function discussionHeadline(thread: DiscussionThreadState): string {
  const subject = thread.subject ? `Discussion "${thread.subject}"` : "The active discussion";
  if (thread.proposedNextAction.kind === "host_decision") {
    return `${subject} is ready for a host decision.`;
  }
  if (thread.proposedNextAction.kind === "wait_for_members" || thread.proposedNextAction.kind === "prompt_member") {
    return `${subject} is waiting for ${thread.pendingMemberIds.length} member response${thread.pendingMemberIds.length === 1 ? "" : "s"}.`;
  }
  if (thread.lifecycleState === "contested") {
    return `${subject} has an active disagreement to resolve.`;
  }
  if (thread.lifecycleState === "closed") {
    return thread.closedTaskId
      ? `${subject} is closed and handed off to task ${thread.closedTaskId}.`
      : `${subject} is closed.`;
  }
  if (thread.lifecycleState === "settled") {
    return `${subject} is settled for now.`;
  }
  return `${subject} is open and waiting for the first member response.`;
}

function discussionBlockingReason(thread: DiscussionThreadState): string {
  if (thread.proposedNextAction.kind === "host_decision") {
    return thread.proposedNextAction.summary;
  }
  if (thread.proposedNextAction.kind === "wait_for_members" || thread.proposedNextAction.kind === "prompt_member") {
    return thread.participationSummary
      ?? thread.turnSummary
      ?? `${thread.pendingMemberIds.length} participant${thread.pendingMemberIds.length === 1 ? " is" : "s are"} still expected to respond in this thread.`;
  }
  if (thread.proposedNextAction.kind === "continue_discussion") {
    return thread.participationSummary ?? thread.turnSummary ?? thread.currentRoundSummary;
  }
  if (thread.disagreementSummary) {
    return thread.disagreementSummary;
  }
  if (thread.conclusionSummary) {
    return thread.conclusionSummary;
  }
  return thread.currentRoundSummary;
}
