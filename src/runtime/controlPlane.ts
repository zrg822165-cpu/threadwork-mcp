import type { AgentSessionRecord, Event, Message, PathLock, Task, TeamState } from "../domain/types.js";
import type { DiscussionThreadState } from "./discussionState.js";
import { discussionThreads, isHostTaskCommitMessage } from "./discussionState.js";
import type { RuntimeHostSummary } from "./hostRouting.js";
import { runtimeHostSummary } from "./hostRouting.js";
import type { RuntimeSafetySummary } from "./safety.js";
import { summarizeTeamSafety } from "./safety.js";
import { taskReviewSummary } from "./taskReview.js";

export interface TaskControlSummary extends Task {
  blockReasons?: string[];
}

export interface RuntimeControlPlane {
  host: RuntimeHostSummary;
  sessionBuckets: Record<string, AgentSessionRecord[]>;
  taskBuckets: {
    pending: Task[];
    runnable: Task[];
    blockedByDependency: TaskControlSummary[];
    claimed: Task[];
    completed: Task[];
    failed: Task[];
    cancelled: Task[];
  };
  activeWork: Array<{ session: AgentSessionRecord; task?: Task }>;
  inbox: {
    unreadByMember: Record<string, number>;
    threadsNeedingAttention: Message[];
    activeThreads: DiscussionThreadState[];
    activeConversationTurns: Array<{
      sessionId: string;
      memberId: string;
      memberName?: string;
      messageId: string;
      threadId: string;
      subject?: string;
      kind?: string;
      trigger?: string;
      priorityScore?: number;
      reason?: string;
    }>;
    discussionProgressSummary?: string;
    discussionHostAttentionSummary?: string;
  };
  locks: Array<PathLock & { isExpired: boolean }>;
  policy: {
    recentBlocks: Event[];
    recentWarnings: Event[];
  };
  safety: RuntimeSafetySummary;
  scheduler: TeamState["schedulerStates"][string] | undefined;
  nextActions: string[];
}

export function runtimeControlPlane(state: TeamState, teamId: string, sessions: AgentSessionRecord[]): RuntimeControlPlane {
  const taskBuckets = tasksByStatus(state, teamId);
  const sessionBuckets = sessionsByStatus(sessions);
  const unreadByMember = unreadMessagesByMember(state, teamId);
  const recentEvents = state.events.filter((event) => !event.teamId || event.teamId === teamId).slice(-50);
  const activeThreads = discussionThreads(state, teamId);
  const activeConversationTurns = sessions
    .filter((session) => session.teamId === teamId && session.status === "waiting" && !!session.currentMessageId)
    .map((session) => {
      const message = state.messages[session.currentMessageId!];
      if (!message) {
        return undefined;
      }
      const thread = activeThreads.find((candidate) => candidate.threadId === (message.threadId ?? message.id));
      const obligation = thread?.turnObligations.find((candidate) => (
        candidate.memberId === session.memberId && candidate.messageId === message.id
      ));
      return {
        sessionId: session.id,
        memberId: session.memberId,
        memberName: state.members[session.memberId]?.name,
        messageId: message.id,
        threadId: message.threadId ?? message.id,
        subject: message.subject,
        kind: obligation?.kind,
        trigger: obligation?.trigger,
        priorityScore: obligation?.priorityScore,
        reason: obligation?.reason
      };
    })
    .filter((turn): turn is NonNullable<typeof turn> => !!turn);
  const activeWork = sessions
    .filter((session) => !!session.currentTaskId || session.status === "working" || session.status === "waiting")
    .map((session) => ({ session, task: session.currentTaskId ? state.tasks[session.currentTaskId] : undefined }));
  const locks = Object.values(state.pathLocks)
    .filter((lock) => lock.teamId === teamId)
    .map((lock) => ({ ...lock, isExpired: !!lock.expiresAt && lock.expiresAt <= new Date().toISOString() }));
  const policy = {
    recentBlocks: recentEvents.filter((event) => event.type === "policy.blocked").slice(-10),
    recentWarnings: recentEvents.filter((event) => event.type === "policy.warning").slice(-10)
  };
  const safety = summarizeTeamSafety(state, teamId);
  const host = runtimeHostSummary(state, teamId, sessions);

  return {
    host,
    sessionBuckets,
    taskBuckets,
    activeWork,
    inbox: {
      unreadByMember,
      threadsNeedingAttention: unreadMessages(state, teamId).slice(-20),
      activeThreads: activeThreads.slice(0, 10),
      activeConversationTurns,
      discussionProgressSummary: discussionProgressSummary(activeThreads[0]),
      discussionHostAttentionSummary: discussionHostAttentionSummary(activeThreads[0])
    },
    locks,
    policy,
    safety,
    scheduler: state.schedulerStates[teamId],
    nextActions: nextActions(state, teamId, sessions, taskBuckets, policy, safety, activeThreads)
  };
}

function discussionHostAttentionSummary(thread: DiscussionThreadState | undefined): string | undefined {
  if (!thread) {
    return undefined;
  }
  if (thread.proposedNextAction.kind === "host_decision") {
    return thread.synthesis.openIssueSummary ?? thread.proposedNextAction.summary;
  }
  return undefined;
}

function discussionProgressSummary(thread: DiscussionThreadState | undefined): string | undefined {
  if (!thread) {
    return undefined;
  }
  if (thread.proposedNextAction.kind === "host_decision") {
    return thread.synthesis.openIssueSummary ?? thread.proposedNextAction.summary;
  }
  if (thread.proposedNextAction.kind === "wait_for_members" || thread.proposedNextAction.kind === "prompt_member") {
    return thread.synthesis.summary;
  }
  if (thread.proposedNextAction.kind === "continue_discussion") {
    return thread.synthesis.summary;
  }
  if (thread.lifecycleState === "closed") {
    return thread.suggestedActionSummary;
  }
  if (thread.lifecycleState === "settled") {
    if (thread.committedTaskId) {
      return thread.suggestedActionSummary;
    }
    return thread.actionabilityState === "ready_for_task" || thread.actionabilityState === "waiting_host_commit"
      ? thread.suggestedActionSummary
      : thread.synthesis.summary;
  }
  return thread.synthesis.summary;
}

export function tasksByStatus(state: TeamState, teamId: string): RuntimeControlPlane["taskBuckets"] {
  const groups: RuntimeControlPlane["taskBuckets"] = { pending: [], runnable: [], blockedByDependency: [], claimed: [], completed: [], failed: [], cancelled: [] };
  for (const task of Object.values(state.tasks).filter((task) => task.teamId === teamId)) {
    if (task.status === "pending") {
      groups.pending.push(task);
      const blockReasons = taskBlockReasons(state, task);
      if (blockReasons.length > 0) {
        groups.blockedByDependency.push({ ...task, blockReasons });
      } else {
        groups.runnable.push(task);
      }
      continue;
    }
    groups[task.status].push(task);
  }
  return groups;
}

export function unreadMessagesByMember(state: TeamState, teamId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const member of Object.values(state.members).filter((member) => member.teamId === teamId)) {
    counts[member.id] = 0;
  }
  for (const delivery of Object.values(state.messageDeliveries).filter((delivery) => {
    const message = state.messages[delivery.messageId];
    return delivery.teamId === teamId
      && !delivery.acknowledgedAt
      && !delivery.consumedAt
      && (!message || !isHostTaskCommitMessage(message));
  })) {
    counts[delivery.memberId] = (counts[delivery.memberId] ?? 0) + 1;
  }
  return counts;
}

function sessionsByStatus(sessions: AgentSessionRecord[]): Record<string, AgentSessionRecord[]> {
  const buckets: Record<string, AgentSessionRecord[]> = {
    starting: [],
    idle: [],
    working: [],
    waiting: [],
    completed: [],
    error: [],
    stopped: []
  };
  for (const session of sessions) {
    buckets[session.status] ??= [];
    buckets[session.status]!.push(session);
  }
  return buckets;
}

function taskBlockReasons(state: TeamState, task: Task): string[] {
  return task.dependencyTaskIds
    .map((dependencyTaskId) => state.tasks[dependencyTaskId])
    .filter((dependency) => !dependency || dependency.status !== "completed")
    .map((dependency) => dependency ? `dependency ${dependency.id} is ${dependency.status}` : "dependency is missing");
}

function unreadMessages(state: TeamState, teamId: string): Message[] {
  const unreadMessageIds = new Set(Object.values(state.messageDeliveries)
    .filter((delivery) => delivery.teamId === teamId && !delivery.acknowledgedAt && !delivery.consumedAt)
    .map((delivery) => delivery.messageId));
  return Object.values(state.messages)
    .filter((message) => message.teamId === teamId)
    .filter((message) => messageNeedsRuntimeAttention(state, unreadMessageIds, message))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function messageNeedsRuntimeAttention(state: TeamState, unreadMessageIds: Set<string>, message: Message): boolean {
  if (isHostTaskCommitMessage(message)) {
    return false;
  }
  if (hostFacingMessageNeedsAttention(state, message)) {
    return true;
  }
  if (!unreadMessageIds.has(message.id)) {
    return false;
  }
  return message.type === "question" || message.type === "handoff" || message.type === "notification" || message.type === "escalation";
}

function hostFacingMessageNeedsAttention(state: TeamState, message: Message): boolean {
  if (isHostTaskCommitMessage(message)) {
    return false;
  }
  if (message.acknowledgedAt || message.consumedAt) {
    return false;
  }
  if (message.type === "escalation") {
    return true;
  }
  if (message.type === "result" && message.fromMemberId && !message.toMemberId) {
    return true;
  }
  if (message.type !== "question" || !message.fromMemberId) {
    return false;
  }
  const leadMemberId = state.teams[message.teamId]?.leadMemberId;
  return !message.toMemberId || (!!leadMemberId && message.toMemberId === leadMemberId);
}

function nextActions(
  state: TeamState,
  teamId: string,
  sessions: AgentSessionRecord[],
  taskBuckets: RuntimeControlPlane["taskBuckets"],
  policy: RuntimeControlPlane["policy"],
  safety: RuntimeSafetySummary,
  activeThreads: DiscussionThreadState[]
): string[] {
  const runtime = state.teamRuntimes[teamId];
  const scheduler = state.schedulerStates[teamId];
  const actions: string[] = [];
  const idleCount = sessions.filter((session) => session.status === "idle").length;
  const errorSessions = sessions.filter((session) => session.status === "error");
  const stoppedWithClaimedTasks = sessions
    .filter((session) => session.status === "stopped" && session.currentTaskId)
    .map((session) => session.currentTaskId);
  const hostDecisionThread = activeThreads.find((thread) => thread.proposedNextAction.kind === "host_decision");
  const unresolvedThread = activeThreads.find((thread) => thread.proposedNextAction.kind === "continue_discussion");
  const waitingThread = activeThreads.find((thread) => (
    thread.proposedNextAction.kind === "wait_for_members"
    || thread.proposedNextAction.kind === "prompt_member"
  ));
  const committedThread = activeThreads.find((thread) => !!thread.committedTaskId);
  const reviewRecommendedTask = taskBuckets.completed
    .map((task) => ({ task, review: taskReviewSummary(state, task) }))
    .find(({ review }) => review.reviewState === "review_recommended");

  if (safety.compact && safety.highestLevel && safety.highestLevel !== "warning") {
    actions.push(safety.compact.recommendedAction);
  }

  if (reviewRecommendedTask) {
    actions.push(reviewRecommendedTask.review.reviewActionSummary ?? `Ask reviewers to review completed task ${reviewRecommendedTask.task.id}.`);
  }

  if (hostDecisionThread) {
    actions.push("Review the active discussion thread and decide how the team should proceed.");
  } else if (waitingThread) {
    actions.push(runtime?.status === "running"
      ? "Continue with team_work to advance active discussion turns and collect pending member responses."
      : "Continue with team_work to start runtime-managed teammate sessions and collect pending member responses.");
  } else if (unresolvedThread) {
    actions.push("Continue with team_work to help the team resolve the open discussion question.");
  } else if (committedThread) {
    actions.push(`Continue with team_work on the follow-up task ${committedThread.committedTaskId} created from the settled discussion.`);
  } else {
    const settledThread = activeThreads.find((thread) => thread.actionabilityState === "ready_for_task" || thread.actionabilityState === "waiting_host_commit");
    if (settledThread?.actionabilityState === "ready_for_task") {
      actions.push("Use team_work to turn the settled discussion into the next task.");
    } else if (settledThread?.actionabilityState === "waiting_host_commit") {
      actions.push("Review the settled discussion and decide whether to create follow-up work or continue the thread.");
    }
  }

  if (!runtime || runtime.status === "not_started") {
    actions.push("Finish team setup, then continue with team_work to start runtime-managed teammate sessions.");
  } else if (runtime.status === "ready" || runtime.status === "stopped") {
    actions.push("Continue with team_work to start runtime-managed teammate sessions.");
  } else if (runtime.status === "error") {
    actions.push("Inspect error sessions and recover or replace blocked work before continuing.");
  } else if (runtime.status === "paused" || scheduler?.paused) {
    actions.push("Resume the paused runtime manually when the team should continue scheduling work.");
  } else if (runtime.status === "running" && taskBuckets.runnable.length > 0 && idleCount > 0) {
    actions.push("Continue with team_work to assign runnable work and advance bounded progress.");
  }

  if (taskBuckets.runnable.length > 0 && idleCount === 0) {
    actions.push("No idle teammate session is available for runnable work; wait, stop/restart a session, or increase runtime capacity.");
  }
  if (taskBuckets.blockedByDependency.length > 0) {
    actions.push("Resolve or complete dependency tasks before blocked pending work can run.");
  }
  if (errorSessions.length > 0) {
    actions.push("Inspect error sessions and decide whether to retry, reassign, replace, or stop affected work.");
  }
  if (stoppedWithClaimedTasks.length > 0) {
    actions.push("Inspect claimed tasks on stopped sessions and decide whether to release, retry, or reassign them.");
  }
  if (policy.recentBlocks.length > 0) {
    actions.push("Review recent policy.blocked events before rerunning the affected task.");
  }
  if (unreadMessages(state, teamId).length > 0) {
    actions.push("Review unread runtime messages or route them to the relevant teammate.");
  }
  if (actions.length === 0) {
    actions.push("No immediate host action detected from runtime state.");
  }
  return actions;
}
