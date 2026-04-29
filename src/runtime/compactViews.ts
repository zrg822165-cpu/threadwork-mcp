import type { AgentSessionRecord, Task, TeamBuild, TeamRuntime, TeamState } from "../domain/types.js";
import type { RuntimeControlPlane } from "./controlPlane.js";
import type { DiscussionActionabilityState, DiscussionClosureReason, DiscussionNextAction, DiscussionNextTurnSummary, DiscussionRoundTurn, DiscussionSynthesis } from "./discussionState.js";
import type { ContinuationAction } from "./explainability.js";
import type { RuntimeExplainability, RuntimeResultsExplainability } from "./explainability.js";
import type { SafetyCompactSummary } from "./safety.js";
import type { RuntimeResults } from "./timeline.js";
import type { TaskReviewSummary } from "./taskReview.js";

export interface CompactStatusView {
  team: {
    id: string;
    name: string;
  };
  phase: RuntimeExplainability["phase"];
  headline: string;
  supportingLine: string;
  currentTask?: {
    id: string;
    title: string;
    status: string;
    assignedMemberName?: string;
  };
  blockers: string[];
  discussion?: {
    threadId: string;
    state: string;
    lifecycleState: string;
    resolutionState: string;
    committedTaskId?: string;
    committedTaskTitle?: string;
    commitMessageId?: string;
    closureReason?: DiscussionClosureReason;
    closedAtMessageId?: string;
    closedTaskId?: string;
    actionabilityState: DiscussionActionabilityState;
    suggestedActionSummary: string;
    suggestedTaskTitle?: string;
    suggestedTaskDescriptionPreview?: string;
    actionSourceMessageIds: string[];
    turnTakingState: string;
    nextResponsibleMemberIds: string[];
    nextResponsibleMemberNames: string[];
    nextTurnSummary?: string;
    progressSummary: string;
    synthesis: DiscussionSynthesis;
    participationSummary?: string;
    turnSummary?: string;
    hostAttentionSummary?: string;
    disagreementSummary?: string;
    proposedNextAction: DiscussionNextAction;
    respondedMemberNames: string[];
    owedMemberIds: string[];
    owedMemberNames: string[];
    invitedMemberIds: string[];
    invitedMemberNames: string[];
    currentRoundTurns: DiscussionRoundTurn[];
    nextTurns: DiscussionNextTurnSummary[];
  };
  recentActivity: {
    activeTaskCount: number;
    unreadMessageCount: number;
    failedTaskCount: number;
    blockedTaskCount: number;
  };
  continuation?: ContinuationAction;
  safety?: SafetyCompactSummary;
  background?: {
    status: string;
    stoppedReason?: string;
    ticksRun: number;
    totalAssignments: number;
    lastDecision?: string;
    needsAttentionReason?: string;
  };
  emptyState?: string;
  nextAction: string;
}

export interface CompactResultsView {
  team: {
    id: string;
    name: string;
  };
  phase: RuntimeResultsExplainability["phase"];
  headline: string;
  topResult: string;
  supportingLine: string;
  latestTask?: {
    id: string;
    title: string;
    status: string;
    memberName?: string;
    summary?: string;
    review?: TaskReviewSummary;
  };
    latestDiscussion?: {
      threadId: string;
      subject?: string;
      state: string;
      lifecycleState: string;
      resolutionState: string;
      committedTaskId?: string;
      committedTaskTitle?: string;
      commitMessageId?: string;
      closureReason?: DiscussionClosureReason;
      closedAtMessageId?: string;
      closedTaskId?: string;
      actionabilityState: DiscussionActionabilityState;
      suggestedActionSummary: string;
      suggestedTaskTitle?: string;
      suggestedTaskDescriptionPreview?: string;
      actionSourceMessageIds: string[];
      turnTakingState: string;
      nextResponsibleMemberIds: string[];
      nextResponsibleMemberNames: string[];
      nextTurnSummary?: string;
      currentRoundSummary: string;
      synthesis: DiscussionSynthesis;
      participationSummary?: string;
      turnSummary?: string;
      hostAttentionSummary?: string;
      disagreementSummary?: string;
      proposedNextAction: DiscussionNextAction;
      conclusionSummary?: string;
      currentRoundTurns: DiscussionRoundTurn[];
      nextTurns: DiscussionNextTurnSummary[];
    messageCount: number;
    currentRoundMessageCount: number;
      opinionCount: number;
      latestOpinion?: string;
      respondedMemberNames: string[];
      pendingMemberCount: number;
      owedMemberIds: string[];
      owedMemberNames: string[];
      invitedMemberIds: string[];
      invitedMemberNames: string[];
      unresolvedQuestionCount: number;
      needsHostDecision: boolean;
    };
  memberInvolvement: Array<{
    memberId: string;
    memberName: string;
    completedCount: number;
    failedCount: number;
    resultMessageCount: number;
    latestContributionSummary?: string;
  }>;
  continuation?: ContinuationAction;
  safety?: SafetyCompactSummary;
  latestBoundedRun?: {
    status: string;
    stoppedReason?: string;
    ticksRun: number;
    totalAssignments: number;
    lastDecision?: string;
    completedAt?: string;
  };
  emptyState?: string;
}

export function compactStatusView(
  state: TeamState,
  teamId: string,
  build: TeamBuild | undefined,
  runtime: TeamRuntime,
  sessions: AgentSessionRecord[],
  controlPlane: RuntimeControlPlane,
  explain: RuntimeExplainability
): CompactStatusView {
  const team = state.teams[teamId];
  const currentTask = currentTaskSummary(state, controlPlane.activeWork.map((entry) => entry.task).find((task) => !!task));
  const blockers = [
    explain.blockingReason,
    ...controlPlane.taskBuckets.blockedByDependency.flatMap((task) => task.blockReasons ?? []).slice(0, 2),
    ...controlPlane.taskBuckets.failed.slice(0, 2).map((task) => task.failureSummary ?? `Task ${task.id} failed.`)
  ].filter((value, index, values): value is string => !!value && values.indexOf(value) === index);

  return {
    team: {
      id: teamId,
      name: team?.name ?? teamId
    },
    phase: build && build.status !== "finalized" ? "building" : explain.phase,
    headline: explain.headline,
    supportingLine: statusSupportingLine(controlPlane, explain),
    currentTask,
    blockers,
    discussion: controlPlane.inbox.activeThreads[0] ? {
      threadId: controlPlane.inbox.activeThreads[0].threadId,
      state: controlPlane.inbox.activeThreads[0].state,
      lifecycleState: controlPlane.inbox.activeThreads[0].lifecycleState,
      resolutionState: controlPlane.inbox.activeThreads[0].resolutionState,
      committedTaskId: controlPlane.inbox.activeThreads[0].committedTaskId,
      committedTaskTitle: controlPlane.inbox.activeThreads[0].committedTaskTitle,
      commitMessageId: controlPlane.inbox.activeThreads[0].commitMessageId,
      closureReason: controlPlane.inbox.activeThreads[0].closureReason,
      closedAtMessageId: controlPlane.inbox.activeThreads[0].closedAtMessageId,
      closedTaskId: controlPlane.inbox.activeThreads[0].closedTaskId,
      actionabilityState: controlPlane.inbox.activeThreads[0].actionabilityState,
      suggestedActionSummary: controlPlane.inbox.activeThreads[0].suggestedActionSummary,
      suggestedTaskTitle: controlPlane.inbox.activeThreads[0].suggestedTaskTitle,
      suggestedTaskDescriptionPreview: controlPlane.inbox.activeThreads[0].suggestedTaskDescriptionPreview,
      actionSourceMessageIds: controlPlane.inbox.activeThreads[0].actionSourceMessageIds,
      turnTakingState: controlPlane.inbox.activeThreads[0].turnTakingState,
      nextResponsibleMemberIds: controlPlane.inbox.activeThreads[0].nextResponsibleMemberIds,
      nextResponsibleMemberNames: controlPlane.inbox.activeThreads[0].nextResponsibleMemberNames,
      nextTurnSummary: controlPlane.inbox.activeThreads[0].nextTurnSummary,
      progressSummary: controlPlane.inbox.discussionProgressSummary ?? controlPlane.inbox.activeThreads[0].currentRoundSummary,
      synthesis: controlPlane.inbox.activeThreads[0].synthesis,
      participationSummary: controlPlane.inbox.activeThreads[0].participationSummary,
      turnSummary: controlPlane.inbox.activeThreads[0].turnSummary,
      hostAttentionSummary: controlPlane.inbox.discussionHostAttentionSummary,
      disagreementSummary: controlPlane.inbox.activeThreads[0].disagreementState !== "none"
        ? controlPlane.inbox.activeThreads[0].disagreementSummary
        : undefined,
      proposedNextAction: controlPlane.inbox.activeThreads[0].proposedNextAction,
      respondedMemberNames: controlPlane.inbox.activeThreads[0].respondedMemberNames,
      owedMemberIds: controlPlane.inbox.activeThreads[0].owedMemberIds,
      owedMemberNames: controlPlane.inbox.activeThreads[0].owedMemberNames,
      invitedMemberIds: controlPlane.inbox.activeThreads[0].invitedMemberIds,
      invitedMemberNames: controlPlane.inbox.activeThreads[0].invitedMemberNames,
      currentRoundTurns: compactTurnPreview(controlPlane.inbox.activeThreads[0].currentRoundTurns),
      nextTurns: compactNextTurnPreview(controlPlane.inbox.activeThreads[0].nextTurns)
    } : undefined,
    recentActivity: {
      activeTaskCount: controlPlane.activeWork.length,
      unreadMessageCount: controlPlane.inbox.threadsNeedingAttention.length,
      failedTaskCount: controlPlane.taskBuckets.failed.length,
      blockedTaskCount: controlPlane.taskBuckets.blockedByDependency.length
    },
    continuation: explain.continuation,
    safety: controlPlane.safety.compact,
    background: controlPlane.scheduler?.background ? {
      status: controlPlane.scheduler.background.status,
      stoppedReason: controlPlane.scheduler.background.stoppedReason,
      ticksRun: controlPlane.scheduler.background.ticksRun,
      totalAssignments: controlPlane.scheduler.background.totalAssignments,
      lastDecision: controlPlane.scheduler.background.lastDecision,
      needsAttentionReason: controlPlane.scheduler.background.needsAttentionReason
    } : undefined,
    emptyState: currentTask || blockers.length > 0 || controlPlane.activeWork.length > 0
      ? undefined
      : statusEmptyState(controlPlane, explain),
    nextAction: explain.recommendedNextAction
  };
}

export function compactResultsView(
  state: TeamState,
  teamId: string,
  results: RuntimeResults,
  explain: RuntimeResultsExplainability
): CompactResultsView {
  const team = state.teams[teamId];
  const latestTaskResult = results.failuresNeedingAttention[0] ?? results.taskResults.find((result) => result.task.status === "completed");
  const latestContribution = latestTaskResult
    ? results.memberContributions.find((contribution) => (
      contribution.completedTaskIds.includes(latestTaskResult.task.id)
      || contribution.failedTaskIds.includes(latestTaskResult.task.id)
    ))
    : undefined;
  const latestDiscussion = results.discussionThreads[0];
  const topResult = explain.failureSummary ?? latestDiscussion?.latestOpinion?.body ?? explain.resultSummary;
  const memberInvolvement = results.memberContributions.slice(0, 5).map((contribution) => ({
    memberId: contribution.memberId,
    memberName: contribution.memberName,
    completedCount: contribution.completedTaskIds.length,
    failedCount: contribution.failedTaskIds.length,
    resultMessageCount: contribution.resultMessageIds.length,
    latestContributionSummary: contribution.latestContributionSummary
  }));
  const background = state.schedulerStates[teamId]?.background;

  return {
    team: {
      id: teamId,
      name: team?.name ?? teamId
    },
    phase: explain.phase,
    headline: explain.headline,
    topResult,
    supportingLine: resultsSupportingLine(results, explain),
    latestTask: latestTaskResult ? {
      id: latestTaskResult.task.id,
      title: latestTaskResult.task.title,
      status: latestTaskResult.task.status,
      memberName: latestContribution?.memberName,
      summary: latestTaskResult.summary,
      review: latestTaskResult.review
    } : undefined,
    latestDiscussion: latestDiscussion ? {
      threadId: latestDiscussion.threadId,
      subject: latestDiscussion.subject,
      state: latestDiscussion.state,
      lifecycleState: latestDiscussion.lifecycleState,
      resolutionState: latestDiscussion.resolutionState,
      committedTaskId: latestDiscussion.committedTaskId,
      committedTaskTitle: latestDiscussion.committedTaskTitle,
      commitMessageId: latestDiscussion.commitMessageId,
      closureReason: latestDiscussion.closureReason,
      closedAtMessageId: latestDiscussion.closedAtMessageId,
      closedTaskId: latestDiscussion.closedTaskId,
      actionabilityState: latestDiscussion.actionabilityState,
      suggestedActionSummary: latestDiscussion.suggestedActionSummary,
      suggestedTaskTitle: latestDiscussion.suggestedTaskTitle,
      suggestedTaskDescriptionPreview: latestDiscussion.suggestedTaskDescriptionPreview,
      actionSourceMessageIds: latestDiscussion.actionSourceMessageIds,
      turnTakingState: latestDiscussion.turnTakingState,
      nextResponsibleMemberIds: latestDiscussion.nextResponsibleMemberIds,
      nextResponsibleMemberNames: latestDiscussion.nextResponsibleMemberNames,
      nextTurnSummary: latestDiscussion.nextTurnSummary,
      currentRoundSummary: latestDiscussion.currentRoundSummary,
      synthesis: latestDiscussion.synthesis,
      participationSummary: latestDiscussion.participationSummary,
      turnSummary: latestDiscussion.turnSummary,
      hostAttentionSummary: latestDiscussion.proposedNextAction.kind === "host_decision"
        ? latestDiscussion.proposedNextAction.summary
        : undefined,
      disagreementSummary: latestDiscussion.disagreementState !== "none"
        ? latestDiscussion.disagreementSummary
        : undefined,
      proposedNextAction: latestDiscussion.proposedNextAction,
      conclusionSummary: latestDiscussion.lifecycleState === "settled"
        ? latestDiscussion.conclusionSummary
        : undefined,
      currentRoundTurns: compactTurnPreview(latestDiscussion.currentRoundTurns),
      nextTurns: compactNextTurnPreview(latestDiscussion.nextTurns),
      messageCount: latestDiscussion.messages.length,
      currentRoundMessageCount: latestDiscussion.currentRoundMessageCount,
      opinionCount: latestDiscussion.opinions.length,
      latestOpinion: latestDiscussion.latestOpinion?.body,
      respondedMemberNames: latestDiscussion.respondedMemberNames,
      pendingMemberCount: latestDiscussion.pendingMemberIds.length,
      owedMemberIds: latestDiscussion.owedMemberIds,
      owedMemberNames: latestDiscussion.owedMemberNames,
      invitedMemberIds: latestDiscussion.invitedMemberIds,
      invitedMemberNames: latestDiscussion.invitedMemberNames,
      unresolvedQuestionCount: latestDiscussion.unresolvedQuestionCount,
      needsHostDecision: latestDiscussion.needsHostDecision
    } : undefined,
    memberInvolvement,
    continuation: explain.continuation,
    safety: explain.safety,
    latestBoundedRun: background ? {
      status: background.status,
      stoppedReason: background.stoppedReason,
      ticksRun: background.ticksRun,
      totalAssignments: background.totalAssignments,
      lastDecision: background.lastDecision,
      completedAt: background.completedAt
    } : undefined,
    emptyState: latestTaskResult || memberInvolvement.length > 0 || latestDiscussion ? undefined : "No completed or failed team results yet."
  };
}

function statusSupportingLine(controlPlane: RuntimeControlPlane, explain: RuntimeExplainability): string {
  const activeDiscussion = controlPlane.inbox.activeThreads[0];
  if (activeDiscussion?.proposedNextAction.kind === "host_decision") {
    return activeDiscussion.synthesis.openIssueSummary ?? activeDiscussion.proposedNextAction.summary;
  }
  if (activeDiscussion?.proposedNextAction.kind === "wait_for_members" || activeDiscussion?.proposedNextAction.kind === "prompt_member") {
    return activeDiscussion.nextTurnSummary ?? activeDiscussion.synthesis.summary;
  }
  if (activeDiscussion?.disagreementState === "needs_resolution") {
    return activeDiscussion.disagreementSummary ?? activeDiscussion.synthesis.summary;
  }
  if (activeDiscussion?.lifecycleState === "closed") {
    return activeDiscussion.suggestedActionSummary;
  }
  if (activeDiscussion?.lifecycleState === "settled" && activeDiscussion.conclusionSummary) {
    if (activeDiscussion.committedTaskId) {
      return activeDiscussion.suggestedActionSummary;
    }
    if (activeDiscussion.actionabilityState === "ready_for_task" || activeDiscussion.actionabilityState === "waiting_host_commit") {
      return activeDiscussion.suggestedActionSummary;
    }
    return activeDiscussion.synthesis.summary ?? activeDiscussion.conclusionSummary;
  }
  if (activeDiscussion?.proposedNextAction.kind === "continue_discussion") {
    return activeDiscussion.nextTurnSummary ?? activeDiscussion.synthesis.summary;
  }
  if (controlPlane.inbox.activeConversationTurns.length > 0) {
    return `${controlPlane.inbox.activeConversationTurns.length} teammate${controlPlane.inbox.activeConversationTurns.length === 1 ? " is" : "s are"} actively handling mailbox turn${controlPlane.inbox.activeConversationTurns.length === 1 ? "" : "s"}.`;
  }
  if (explain.blockingReason) {
    return explain.blockingReason;
  }
  if (controlPlane.activeWork.length > 0) {
    return `${controlPlane.activeWork.length} active task${controlPlane.activeWork.length === 1 ? "" : "s"}; ${controlPlane.taskBuckets.runnable.length} runnable next.`;
  }
  if (controlPlane.inbox.threadsNeedingAttention.length > 0) {
    return `${controlPlane.inbox.threadsNeedingAttention.length} unread runtime message${controlPlane.inbox.threadsNeedingAttention.length === 1 ? "" : "s"} waiting for review.`;
  }
  if (controlPlane.taskBuckets.runnable.length > 0) {
    return `${controlPlane.taskBuckets.runnable.length} runnable task${controlPlane.taskBuckets.runnable.length === 1 ? " is" : "s are"} ready to assign.`;
  }
  return explain.recommendedNextAction;
}

function statusEmptyState(controlPlane: RuntimeControlPlane, explain: RuntimeExplainability): string | undefined {
  if (controlPlane.taskBuckets.completed.length > 0) {
    return "No active task is running right now.";
  }
  if (explain.phase === "building") {
    return "Team setup is still in progress.";
  }
  if (explain.phase === "idle" || explain.phase === "ready" || explain.phase === "running") {
    return "No active task yet.";
  }
  return undefined;
}

function resultsSupportingLine(results: RuntimeResults, explain: RuntimeResultsExplainability): string {
  const latestDiscussion = results.discussionThreads[0];
  if (explain.phase === "attention" && explain.blockingReason) {
    return explain.blockingReason;
  }
  if (explain.failureSummary) {
    return `${results.failedTasks.length} failed task${results.failedTasks.length === 1 ? "" : "s"} currently need attention.`;
  }
  if (latestDiscussion && !explain.safety) {
    const latest = latestDiscussion;
    if (latest.proposedNextAction.kind === "host_decision") {
      return latest.synthesis.openIssueSummary ?? latest.proposedNextAction.summary;
    }
    if (latest.proposedNextAction.kind === "wait_for_members" || latest.proposedNextAction.kind === "prompt_member") {
      return latest.nextTurnSummary ?? latest.synthesis.summary;
    }
    if (latest.disagreementState === "needs_resolution") {
      return latest.disagreementSummary ?? latest.synthesis.summary;
    }
    if (latest.lifecycleState === "closed") {
      return latest.suggestedActionSummary;
    }
    if (latest.lifecycleState === "settled" && latest.conclusionSummary) {
      if (latest.committedTaskId) {
        return latest.suggestedActionSummary;
      }
      if (latest.actionabilityState === "ready_for_task" || latest.actionabilityState === "waiting_host_commit") {
        return latest.suggestedActionSummary;
      }
      return latest.synthesis.summary ?? latest.conclusionSummary;
    }
    if (latest.proposedNextAction.kind === "continue_discussion") {
      return latest.nextTurnSummary ?? latest.synthesis.summary;
    }
  }
  const latestReview = results.taskResults.find((result) => result.task.status === "completed")?.review;
  if (latestReview?.reviewActionSummary && latestReview.reviewState !== "not_applicable") {
    return latestReview.reviewActionSummary;
  }
  if (results.completedTasks.length > 0) {
    return `${results.completedTasks.length} completed task${results.completedTasks.length === 1 ? "" : "s"} recorded in recent results.`;
  }
  if (results.memberContributions.length > 0) {
    return `${results.memberContributions.length} member${results.memberContributions.length === 1 ? "" : "s"} contributed recent runtime output.`;
  }
  if (latestDiscussion) {
    const latest = latestDiscussion;
    return `${latest.opinions.length} opinion${latest.opinions.length === 1 ? "" : "s"} recorded in the latest team discussion.`;
  }
  return explain.resultSummary;
}

function currentTaskSummary(state: TeamState, task: Task | undefined): CompactStatusView["currentTask"] | undefined {
  if (!task) {
    return undefined;
  }

  return {
    id: task.id,
    title: task.title,
    status: task.status,
    assignedMemberName: task.assignedMemberId ? state.members[task.assignedMemberId]?.name : undefined
  };
}

function compactTurnPreview(turns: DiscussionRoundTurn[], limit = 4): DiscussionRoundTurn[] {
  return turns.slice(-limit);
}

function compactNextTurnPreview(turns: DiscussionNextTurnSummary[], limit = 5): DiscussionNextTurnSummary[] {
  return turns.slice(0, limit);
}
