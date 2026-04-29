import type { AgentSessionRecord, Event, Member, Message, PathLock, Task, TeamState } from "../domain/types.js";
import type { DiscussionThreadState } from "./discussionState.js";
import { discussionThreads } from "./discussionState.js";
import type { TaskReviewSummary } from "./taskReview.js";
import { taskReviewSummary } from "./taskReview.js";

export interface TimelineEntry {
  kind: "event" | "message";
  createdAt: string;
  threadId?: string;
  taskId?: string;
  memberId?: string;
  event?: Event;
  message?: Message;
}

export interface TaskTimelineThread {
  task: Task;
  events: Event[];
  messages: Message[];
  locks: PathLock[];
  sessions: AgentSessionRecord[];
  statusReason: string;
  review?: TaskReviewSummary;
}

export interface RuntimeTimeline {
  scheduler: TeamState["schedulerStates"][string] | undefined;
  events: Event[];
  messages: Message[];
  entries: TimelineEntry[];
  taskThreads: TaskTimelineThread[];
  discussionThreads: DiscussionThreadSummary[];
  policy: {
    blocks: Event[];
    warnings: Event[];
  };
  sessionEvents: Event[];
}

export interface TaskResultSummary {
  task: Task;
  resultMessages: Message[];
  events: Event[];
  session?: AgentSessionRecord;
  summary?: string;
  artifacts: string[];
  taskOwnedSummary?: boolean;
  review: TaskReviewSummary;
}

export interface RuntimeResults {
  completedTasks: Task[];
  failedTasks: Task[];
  resultMessages: Message[];
  sessionSummaries: AgentSessionRecord[];
  taskResults: TaskResultSummary[];
  failuresNeedingAttention: TaskResultSummary[];
  memberContributions: MemberContributionSummary[];
  discussionThreads: DiscussionThreadSummary[];
}

export type DiscussionThreadSummary = DiscussionThreadState;

export interface MemberContributionSummary {
  memberId: string;
  memberName: string;
  sessionIds: string[];
  completedTaskIds: string[];
  failedTaskIds: string[];
  resultMessageIds: string[];
  latestContributionSummary?: string;
}

export function runtimeTimeline(state: TeamState, teamId: string, limit = 20): RuntimeTimeline {
  const events = teamEvents(state, teamId).slice(-limit);
  const messages = teamMessages(state, teamId).slice(-limit);
  const entries = [...events.map((event): TimelineEntry => ({
    kind: "event",
    createdAt: event.createdAt,
    taskId: event.entityType === "task" ? event.entityId : undefined,
    memberId: event.actorMemberId,
    event
  })), ...messages.map((message): TimelineEntry => ({
    kind: "message",
    createdAt: message.createdAt,
    threadId: message.threadId ?? message.id,
    taskId: message.taskId,
    memberId: message.fromMemberId,
    message
  }))]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-limit);

  return {
    scheduler: state.schedulerStates[teamId],
    events,
    messages,
    entries,
    taskThreads: taskThreads(state, teamId, limit),
    discussionThreads: discussionThreads(state, teamId, limit),
    policy: {
      blocks: events.filter((event) => event.type === "policy.blocked"),
      warnings: events.filter((event) => event.type === "policy.warning")
    },
    sessionEvents: events.filter((event) => event.type.startsWith("session."))
  };
}

export function runtimeResults(state: TeamState, teamId: string, limit = 20): RuntimeResults {
  const completedTasks = Object.values(state.tasks)
    .filter((task) => task.teamId === teamId && task.status === "completed")
    .sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt))
    .slice(0, limit);
  const failedTasks = Object.values(state.tasks)
    .filter((task) => task.teamId === teamId && task.status === "failed")
    .sort((a, b) => (b.failedAt ?? b.updatedAt).localeCompare(a.failedAt ?? a.updatedAt))
    .slice(0, limit);
  const resultMessages = teamMessages(state, teamId)
    .filter((message) => message.type === "result")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
  const sessionSummaries = Object.values(state.agentSessions)
    .filter((session) => session.teamId === teamId && !!session.lastResultSummary)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
  const taskResults = [...completedTasks, ...failedTasks]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
    .map((task) => taskResultSummary(state, task));

  return {
    completedTasks,
    failedTasks,
    resultMessages,
    sessionSummaries,
    taskResults,
    failuresNeedingAttention: taskResults.filter((result) => result.task.status === "failed"),
    memberContributions: memberContributions(state, teamId, taskResults, resultMessages, sessionSummaries),
    discussionThreads: discussionThreads(state, teamId, limit)
  };
}

function memberContributions(
  state: TeamState,
  teamId: string,
  taskResults: TaskResultSummary[],
  resultMessages: Message[],
  sessionSummaries: AgentSessionRecord[]
): MemberContributionSummary[] {
  const contributions = new Map<string, MemberContributionSummary>();

  for (const taskResult of taskResults) {
    const memberId = taskResult.task.assignedMemberId;
    if (!memberId) {
      continue;
    }
    const contribution = ensureMemberContribution(contributions, state.members[memberId], memberId);
    contribution.sessionIds = appendUnique(contribution.sessionIds, taskResult.session?.id);
    if (taskResult.task.status === "completed") {
      contribution.completedTaskIds = appendUnique(contribution.completedTaskIds, taskResult.task.id);
    }
    if (taskResult.task.status === "failed") {
      contribution.failedTaskIds = appendUnique(contribution.failedTaskIds, taskResult.task.id);
    }
    contribution.latestContributionSummary ??= taskResult.summary;
  }

  for (const message of resultMessages) {
    if (!message.fromMemberId) {
      continue;
    }
    const contribution = ensureMemberContribution(contributions, state.members[message.fromMemberId], message.fromMemberId);
    for (const sessionId of memberSessionIds(state, teamId, message.fromMemberId)) {
      contribution.sessionIds = appendUnique(contribution.sessionIds, sessionId);
    }
    contribution.resultMessageIds = appendUnique(contribution.resultMessageIds, message.id);
    contribution.latestContributionSummary ??= message.subject ?? message.body;
  }

  for (const session of sessionSummaries) {
    if (session.teamId !== teamId) {
      continue;
    }
    const contribution = ensureMemberContribution(contributions, state.members[session.memberId], session.memberId);
    contribution.sessionIds = appendUnique(contribution.sessionIds, session.id);
    contribution.latestContributionSummary ??= session.lastResultSummary;
  }

  return [...contributions.values()].sort((first, second) => {
    const firstScore = first.completedTaskIds.length + first.failedTaskIds.length + first.resultMessageIds.length;
    const secondScore = second.completedTaskIds.length + second.failedTaskIds.length + second.resultMessageIds.length;
    if (firstScore !== secondScore) {
      return secondScore - firstScore;
    }
    return first.memberName.localeCompare(second.memberName);
  });
}

function ensureMemberContribution(
  contributions: Map<string, MemberContributionSummary>,
  member: Member | undefined,
  memberId: string
): MemberContributionSummary {
  const existing = contributions.get(memberId);
  if (existing) {
    return existing;
  }

  const created: MemberContributionSummary = {
    memberId,
    memberName: member?.name ?? memberId,
    sessionIds: [],
    completedTaskIds: [],
    failedTaskIds: [],
    resultMessageIds: []
  };
  contributions.set(memberId, created);
  return created;
}

function memberSessionIds(state: TeamState, teamId: string, memberId: string): string[] {
  return Object.values(state.agentSessions)
    .filter((session) => session.teamId === teamId && session.memberId === memberId)
    .map((session) => session.id);
}

function appendUnique(values: string[], nextValue: string | undefined): string[] {
  if (!nextValue || values.includes(nextValue)) {
    return values;
  }
  return [...values, nextValue];
}

function taskThreads(state: TeamState, teamId: string, limit: number): TaskTimelineThread[] {
  return Object.values(state.tasks)
    .filter((task) => task.teamId === teamId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
    .map((task) => ({
      task,
      events: taskEvents(state, teamId, task.id),
      messages: taskMessages(state, teamId, task.id),
      locks: Object.values(state.pathLocks).filter((lock) => lock.teamId === teamId && lock.taskId === task.id),
      sessions: Object.values(state.agentSessions).filter((session) => session.teamId === teamId && (session.currentTaskId === task.id || session.memberId === task.assignedMemberId)),
      statusReason: taskStatusReason(state, task),
      review: task.status === "completed" ? taskReviewSummary(state, task) : undefined
    }));
}

function taskResultSummary(state: TeamState, task: Task): TaskResultSummary {
  const session = Object.values(state.agentSessions).find((candidate) => candidate.teamId === task.teamId && candidate.memberId === task.assignedMemberId);
  return {
    task,
    resultMessages: taskMessages(state, task.teamId, task.id).filter((message) => message.type === "result"),
    events: taskEvents(state, task.teamId, task.id),
    session,
    summary: task.completionSummary ?? task.failureSummary,
    artifacts: task.resultArtifacts ?? [],
    taskOwnedSummary: true,
    review: taskReviewSummary(state, task)
  };
}

function taskStatusReason(state: TeamState, task: Task): string {
  if (task.status === "completed") {
    return task.completionSummary ?? "Task completed.";
  }
  if (task.status === "failed") {
    return task.failureSummary ?? "Task failed.";
  }
  if (task.status === "claimed") {
    return task.assignedMemberId ? `Claimed by member ${task.assignedMemberId}.` : "Claimed without an assigned member.";
  }
  if (task.status === "cancelled") {
    return "Task cancelled.";
  }
  const blockedDependencies = task.dependencyTaskIds
    .map((dependencyTaskId) => state.tasks[dependencyTaskId])
    .filter((dependency) => !dependency || dependency.status !== "completed");
  if (blockedDependencies.length > 0) {
    return "Waiting for dependencies.";
  }
  return "Runnable pending work.";
}

function teamEvents(state: TeamState, teamId: string): Event[] {
  return state.events
    .filter((event) => !event.teamId || event.teamId === teamId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function teamMessages(state: TeamState, teamId: string): Message[] {
  return Object.values(state.messages)
    .filter((message) => message.teamId === teamId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function taskEvents(state: TeamState, teamId: string, taskId: string): Event[] {
  return teamEvents(state, teamId).filter((event) => event.entityType === "task" && event.entityId === taskId);
}

function taskMessages(state: TeamState, teamId: string, taskId: string): Message[] {
  return teamMessages(state, teamId).filter((message) => message.taskId === taskId);
}
