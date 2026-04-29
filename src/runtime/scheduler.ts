import type { AgentSessionRecord, Member, Message, PathLock, Task, TeamState } from "../domain/types.js";
import { InvalidStateError } from "../errors.js";
import { addEvent } from "../services/events.js";
import { MailboxService } from "../services/mailboxService.js";
import { PathLockService } from "../services/pathLockService.js";
import { TaskService } from "../services/taskService.js";
import type { DiscussionThreadState, DiscussionTurnObligation } from "./discussionState.js";
import { discussionThreadForMessage, discussionThreads, expectedContributionForTurn } from "./discussionState.js";
import { RuntimePolicyService } from "./policy.js";
import { syncTaskBoundary } from "./safety.js";
import { nowIso } from "../utils/id.js";
import type { AgentBackend } from "./agentBackend.js";

export interface SchedulerTickInput {
  teamId: string;
}

export interface SchedulerAssignment {
  taskId?: string;
  messageId?: string;
  memberId: string;
  sessionId: string;
  backendSessionId: string;
}

export interface SchedulerTickResult {
  assignments: SchedulerAssignment[];
  decision: string;
}

export interface SchedulerPromptAssignment extends SchedulerAssignment {
  prompt: string;
  messageIds: string[];
}

export interface SchedulerPreparedTickResult {
  assignments: SchedulerPromptAssignment[];
  decision: string;
}

interface ConversationTurnCandidate {
  thread?: DiscussionThreadState;
  message: Message;
  obligation?: DiscussionTurnObligation;
  consumeMessageIds: string[];
}

interface ThreadConversationTurnCandidate extends ConversationTurnCandidate {
  thread: DiscussionThreadState;
  obligation: DiscussionTurnObligation;
}

export class RuntimeScheduler {
  constructor(
    private readonly state: TeamState,
    private readonly backend: AgentBackend
  ) {}

  async tick(input: SchedulerTickInput): Promise<SchedulerTickResult> {
    const prepared = this.prepareTick(input);
    for (const assignment of prepared.assignments) {
      try {
        const result = await this.backend.promptSession({ backendSessionId: assignment.backendSessionId, prompt: assignment.prompt });
        this.finalizePromptSuccess(input.teamId, assignment, result);
      } catch (error) {
        this.finalizePromptFailure(input.teamId, assignment, error);
        throw error;
      }
    }
    if (prepared.assignments.length === 0) {
      return prepared;
    }
    return this.recordDecision(input.teamId, prepared.assignments, prepared.decision);
  }

  prepareTick(input: SchedulerTickInput): SchedulerPreparedTickResult {
    const runtime = this.state.teamRuntimes[input.teamId];
    if (!runtime || (runtime.status !== "running" && runtime.status !== "paused")) {
      throw new InvalidStateError("Runtime is not running", { teamId: input.teamId, status: runtime?.status });
    }
    const schedulerState = this.state.schedulerStates[input.teamId];
    if (runtime.status === "paused" || schedulerState?.paused) {
      return this.recordPreparedDecision(input.teamId, "Scheduler is paused");
    }

    const pathLocks = new PathLockService(this.state);
    pathLocks.releaseExpiredLocks({ teamId: input.teamId });
    this.recycleTerminalTaskSessions(input.teamId);
    this.recycleResolvedConversationSessions(input.teamId);
    const assignments: SchedulerPromptAssignment[] = [];
    const usedSessionIds = new Set<string>();
    const idleSessions = this.sessions(input.teamId).filter((session) => session.status === "idle" && session.backendSessionId);

    for (const session of idleSessions) {
      if (!session.backendSessionId) {
        continue;
      }
      const member = this.state.members[session.memberId];
      const turn = member ? this.nextConversationTurn(input.teamId, member.id) : undefined;
      if (!member || !turn) {
        continue;
      }
      session.status = "waiting";
      session.currentMessageId = turn.message.id;
      session.updatedAt = nowIso();
      usedSessionIds.add(session.id);
      assignments.push({
        messageId: turn.message.id,
        memberId: member.id,
        sessionId: session.id,
        backendSessionId: session.backendSessionId,
        prompt: this.conversationPrompt(input.teamId, member, turn.message, turn.thread, turn.obligation),
        messageIds: turn.consumeMessageIds
      });
    }

    const runnableTasks = this.runnableTasks(input.teamId);

    for (const task of runnableTasks) {
      const session = this.chooseSession(task, idleSessions.filter((candidate) => !usedSessionIds.has(candidate.id)));
      if (!session?.backendSessionId) {
        continue;
      }
      const member = this.state.members[session.memberId];
      if (!member) {
        continue;
      }

      new TaskService(this.state).claimTask({ teamId: input.teamId, taskId: task.id, memberId: member.id });
      const activeLocks = pathLocks.listPathLocks(input.teamId);
      session.status = "working";
      session.currentTaskId = task.id;
      session.updatedAt = nowIso();
      const messages = this.promptMessages(input.teamId, member.id, task.id);
      usedSessionIds.add(session.id);
      assignments.push({
        taskId: task.id,
        memberId: member.id,
        sessionId: session.id,
        backendSessionId: session.backendSessionId,
        prompt: this.taskPrompt(input.teamId, member, task, messages, activeLocks),
        messageIds: messages.map((message) => message.id)
      });
    }

    if (assignments.length === 0) {
      return this.recordPreparedDecision(input.teamId, "No runnable assignments");
    }
    const taskCount = assignments.filter((assignment) => assignment.taskId).length;
    const messageCount = assignments.filter((assignment) => assignment.messageId).length;
    if (taskCount > 0 && messageCount === 0) {
      return { assignments, decision: `Assigned ${taskCount} task(s)` };
    }
    const parts = [
      taskCount > 0 ? `Assigned ${taskCount} task${taskCount === 1 ? "" : "s"}` : undefined,
      messageCount > 0 ? `prompted ${messageCount} conversation turn${messageCount === 1 ? "" : "s"}` : undefined
    ].filter(Boolean);
    return { assignments, decision: parts.join("; ") };
  }

  finalizePromptSuccess(teamId: string, assignment: SchedulerPromptAssignment, result: Awaited<ReturnType<AgentBackend["promptSession"]>>): void {
    const session = this.state.agentSessions[assignment.sessionId];
    const task = assignment.taskId ? this.state.tasks[assignment.taskId] : undefined;
    const member = this.state.members[assignment.memberId];
    const message = assignment.messageId ? this.state.messages[assignment.messageId] : undefined;
    if (!session || !member || (!task && !message)) {
      throw new InvalidStateError("Scheduler assignment state is missing", {
        teamId,
        taskId: assignment.taskId,
        messageId: assignment.messageId,
        memberId: assignment.memberId,
        sessionId: assignment.sessionId
      });
    }
    if (assignment.messageIds.length > 0) {
      new MailboxService(this.state).consumeMessages({ teamId, memberId: assignment.memberId, messageIds: assignment.messageIds });
    }
    session.lastResultSummary = result.summary;
    session.lastHeartbeatAt = nowIso();
    session.updatedAt = session.lastHeartbeatAt;
    if (message) {
      const shouldKeepWaiting = result.conversationState === "waiting" && !this.conversationTurnHandled(teamId, assignment.memberId, message);
      if (shouldKeepWaiting) {
        session.status = "waiting";
        session.currentMessageId = message.id;
        addEvent(this.state, {
          teamId,
          actorMemberId: member.id,
          entityType: "message",
          entityId: message.id,
          type: "scheduler.conversation_waiting",
          message: `Prompted ${member.name} to keep working on message ${message.id}`
        });
        return;
      }
      session.status = "idle";
      session.currentMessageId = undefined;
      addEvent(this.state, {
        teamId,
        actorMemberId: member.id,
        entityType: "message",
        entityId: message.id,
        type: "scheduler.conversation",
        message: `Prompted ${member.name} to respond to message ${message.id}`
      });
      return;
    }
    addEvent(this.state, {
      teamId,
      actorMemberId: member.id,
      entityType: "task",
      entityId: task!.id,
      type: "scheduler.assignment",
      message: `Assigned task ${task!.title} to ${member.name}`
    });
  }

  finalizePromptFailure(teamId: string, assignment: SchedulerPromptAssignment, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const session = this.state.agentSessions[assignment.sessionId];
    const task = assignment.taskId ? this.state.tasks[assignment.taskId] : undefined;
    const message = assignment.messageId ? this.state.messages[assignment.messageId] : undefined;
    if (!session || (!task && !message)) {
      throw new InvalidStateError("Scheduler assignment state is missing", {
        teamId,
        taskId: assignment.taskId,
        messageId: assignment.messageId,
        memberId: assignment.memberId,
        sessionId: assignment.sessionId
      });
    }

    if (message) {
      session.status = "error";
      session.currentMessageId = undefined;
      session.errorMessage = errorMessage;
      session.updatedAt = nowIso();
      addEvent(this.state, {
        teamId,
        actorMemberId: assignment.memberId,
        entityType: "message",
        entityId: message.id,
        type: "scheduler.conversation_error",
        message: `Conversation prompt failed for message ${message.id}: ${errorMessage}`
      });
      return;
    }

    if (task!.status === "claimed") {
      new TaskService(this.state).failTask({
        teamId,
        taskId: task!.id,
        memberId: assignment.memberId,
        failureSummary: `Prompt failed: ${errorMessage}`
      });
      session.status = "error";
      session.currentTaskId = undefined;
      session.errorMessage = errorMessage;
    } else {
      session.lastResultSummary = `Prompt failed after task reached ${task!.status}: ${errorMessage}`;
      session.lastHeartbeatAt = nowIso();
    }
    session.updatedAt = nowIso();
    addEvent(this.state, {
      teamId,
      actorMemberId: assignment.memberId,
      entityType: "task",
      entityId: task!.id,
      type: "scheduler.prompt_error",
      message: `Prompt failed for task ${task!.title}: ${errorMessage}`
    });
  }

  private sessions(teamId: string): AgentSessionRecord[] {
    return Object.values(this.state.agentSessions)
      .filter((session) => session.teamId === teamId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private recycleTerminalTaskSessions(teamId: string): void {
    for (const session of this.sessions(teamId)) {
      if (!session.currentTaskId || (session.status !== "working" && session.status !== "waiting")) {
        continue;
      }
      const task = this.state.tasks[session.currentTaskId];
      if (!task) {
        session.status = "error";
        session.errorMessage = `Current task not found: ${session.currentTaskId}`;
        session.currentTaskId = undefined;
        session.updatedAt = nowIso();
        continue;
      }
      if (task.status === "completed") {
        session.status = "idle";
        session.currentTaskId = undefined;
        session.currentMessageId = undefined;
        session.lastResultSummary = task.completionSummary ?? session.lastResultSummary;
        session.lastHeartbeatAt = nowIso();
        session.updatedAt = session.lastHeartbeatAt;
        addEvent(this.state, {
          teamId,
          actorMemberId: session.memberId,
          entityType: "task",
          entityId: task.id,
          type: "scheduler.completion",
          message: `Session completed task ${task.title}`
        });
      }
      if (task.status === "failed" || task.status === "cancelled") {
        session.status = task.status === "failed" ? "error" : "idle";
        session.currentTaskId = undefined;
        session.currentMessageId = undefined;
        session.errorMessage = task.status === "failed" ? task.failureSummary : undefined;
        session.lastResultSummary = task.failureSummary ?? session.lastResultSummary;
        session.lastHeartbeatAt = nowIso();
        session.updatedAt = session.lastHeartbeatAt;
        addEvent(this.state, {
          teamId,
          actorMemberId: session.memberId,
          entityType: "task",
          entityId: task.id,
          type: task.status === "failed" ? "scheduler.failure" : "scheduler.cancellation",
          message: task.status === "failed" ? `Session failed task ${task.title}` : `Session cancelled task ${task.title}`
        });
      }
    }
  }

  private recycleResolvedConversationSessions(teamId: string): void {
    for (const session of this.sessions(teamId)) {
      if (session.status !== "waiting" || session.currentTaskId || !session.currentMessageId) {
        continue;
      }
      const currentMessageId = session.currentMessageId;
      const message = this.state.messages[currentMessageId];
      if (!message || this.conversationTurnHandled(teamId, session.memberId, message)) {
        session.status = "idle";
        session.currentMessageId = undefined;
        session.lastHeartbeatAt = nowIso();
        session.updatedAt = session.lastHeartbeatAt;
        addEvent(this.state, {
          teamId,
          actorMemberId: session.memberId,
          entityType: "message",
          entityId: message?.id ?? currentMessageId,
          type: "scheduler.conversation_resolved",
          message: message
            ? `Conversation turn on message ${message.id} is now resolved.`
            : "Conversation turn was cleared because the message no longer exists."
        });
      }
    }
  }

  private runnableTasks(teamId: string): Task[] {
    return Object.values(this.state.tasks)
      .filter((task) => task.teamId === teamId && task.status === "pending")
      .filter((task) => task.dependencyTaskIds.every((dependencyTaskId) => this.state.tasks[dependencyTaskId]?.status === "completed"))
      .sort((a, b) => priorityRank(b) - priorityRank(a) || a.createdAt.localeCompare(b.createdAt));
  }

  private chooseSession(task: Task, sessions: AgentSessionRecord[]): AgentSessionRecord | undefined {
    if (task.preferredMemberId) {
      const preferred = sessions.find((session) => session.memberId === task.preferredMemberId);
      if (preferred) {
        return preferred;
      }
    }
    return sessions
      .map((session) => ({ session, score: this.memberScore(task, this.state.members[session.memberId]) }))
      .sort((a, b) => b.score - a.score || a.session.createdAt.localeCompare(b.session.createdAt))[0]?.session;
  }

  private memberScore(task: Task, member: Member | undefined): number {
    if (!member) {
      return 0;
    }
    const haystack = [member.name, member.agentId, member.rawResponsibility, member.polishedPrompt, ...(member.callWhen ?? [])].join(" ").toLowerCase();
    const needles = [task.title, task.description, ...task.pathHints].join(" ").toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);
    return needles.reduce((score, word) => score + (haystack.includes(word) ? 1 : 0), 0);
  }

  private promptMessages(teamId: string, memberId: string, taskId: string): Message[] {
    return new MailboxService(this.state).inbox({ teamId, memberId })
      .filter((message) => !message.taskId || message.taskId === taskId);
  }

  private nextConversationTurn(teamId: string, memberId: string): ConversationTurnCandidate | undefined {
    const inbox = new MailboxService(this.state).inbox({ teamId, memberId })
      .filter((message) => message.fromMemberId !== memberId);
    const inboxMessageIds = new Set(inbox.map((message) => message.id));
    const currentRoundCandidates: ThreadConversationTurnCandidate[] = [];
    for (const thread of discussionThreads(this.state, teamId)) {
      if (
        thread.proposedNextAction.kind !== "wait_for_members"
        && thread.proposedNextAction.kind !== "prompt_member"
        && thread.proposedNextAction.kind !== "continue_discussion"
      ) {
        continue;
      }
      for (const obligation of thread.turnObligations.filter((candidate) => candidate.memberId === memberId)) {
        const message = this.state.messages[obligation.messageId] ?? thread.currentRoundAnchor;
        if (!message || !shouldPromptThreadObligation(thread, message, memberId, obligation)) {
          continue;
        }
        currentRoundCandidates.push({
          thread,
          message,
          obligation,
          consumeMessageIds: inboxMessageIds.has(message.id) ? [message.id] : []
        });
      }
    }
    currentRoundCandidates.sort((a, b) => threadObligationPriority(memberId, b) - threadObligationPriority(memberId, a) || b.message.createdAt.localeCompare(a.message.createdAt));

    if (currentRoundCandidates.length > 0) {
      return currentRoundCandidates[0]!;
    }

    const fallback = inbox
      .filter((message) => shouldPromptFallbackConversationTurn(this.state, teamId, memberId, message))
      .sort((a, b) => fallbackConversationMessagePriority(this.state, teamId, memberId, b) - fallbackConversationMessagePriority(this.state, teamId, memberId, a) || a.createdAt.localeCompare(b.createdAt))[0];
    if (!fallback) {
      return undefined;
    }
    return {
      thread: discussionThreadForMessage(this.state, teamId, fallback.id),
      message: fallback,
      consumeMessageIds: [fallback.id]
    };
  }

  private conversationTurnHandled(teamId: string, memberId: string, message: Message): boolean {
    const deliveryHandled = Object.values(this.state.messageDeliveries)
      .filter((delivery) => delivery.teamId === teamId && delivery.messageId === message.id && delivery.memberId === memberId)
      .some((delivery) => !!delivery.acknowledgedAt);
    if (deliveryHandled) {
      return true;
    }
    const threadId = message.threadId ?? message.id;
    return Object.values(this.state.messages).some((candidate) => (
      candidate.teamId === teamId
      && candidate.threadId === threadId
      && candidate.fromMemberId === memberId
      && candidate.id !== message.id
    ));
  }

  private taskPrompt(teamId: string, member: Member, task: Task, messages: Message[], activeLocks: PathLock[]): string {
    const scope = this.state.taskBoundaries[task.id] ?? syncTaskBoundary(this.state, task);
    return [
      `Task for ${member.name}`,
      `teamId=${teamId}`,
      `memberId=${member.id}`,
      `taskId=${task.id}`,
      `Goal: ${task.title}`,
      task.description ? `Details: ${task.description}` : undefined,
      scope.scopePaths.length > 0
        ? `Scope: stay within ${scope.scopePaths.join(", ")}; ask_lead if broader edits are needed.`
        : "Scope: no explicit edit scope recorded; ask_lead before broad edits.",
      task.pathHints.length > 0 ? `Paths: ${task.pathHints.join(", ")}` : undefined,
      messages.length > 0 ? this.messagePromptBlock(messages) : undefined,
      this.pathLockPromptBlock(activeLocks),
      this.policyPromptBlock(member),
      this.agentToolContractBlock()
    ].filter(Boolean).join("\n");
  }

  private conversationPrompt(
    teamId: string,
    member: Member,
    message: Message,
    thread = discussionThreadForMessage(this.state, teamId, message.id),
    obligation?: DiscussionTurnObligation
  ): string {
    return [
      `Conversation turn for ${member.name}`,
      `teamId=${teamId}`,
      `memberId=${member.id}`,
      `messageId=${message.id}`,
      `threadId=${message.threadId ?? message.id}`,
      message.taskId ? `taskId=${message.taskId}` : undefined,
      member.rawResponsibility ? `Role: ${member.rawResponsibility}` : undefined,
      thread?.currentRoundSummary ? `Round: ${thread.currentRoundSummary}` : undefined,
      thread ? `Lifecycle: ${thread.lifecycleState}` : undefined,
      thread?.turnTakingState ? `Turn state: ${thread.turnTakingState}` : undefined,
      thread?.turnSummary ? `Turn: ${thread.turnSummary}` : undefined,
      thread?.proposedNextAction.summary ? `Next: ${thread.proposedNextAction.summary}` : undefined,
      obligation ? `Trigger: ${obligation.trigger}` : undefined,
      obligation ? `Reason: ${obligation.reason}` : undefined,
      obligation ? `Expected contribution: ${expectedContributionForTurn(obligation)}` : undefined,
      obligation ? `Required: ${obligation.required ? "yes" : "no"}` : undefined,
      `Type: ${message.type ?? "notification"}`,
      message.subject ? `Subject: ${message.subject}` : undefined,
      `Body: ${message.body}`,
      message.fromMemberId ? `From: ${message.fromMemberId}` : "From: host",
      "Respond through the runtime mailbox, not through the host:",
      "- use send_message with type opinion, question, handoff, result, or notification",
      "- set replyToMessageId to the messageId above when replying",
      "- use ask_lead only when the team needs human clarification",
      "- use ack_message after you have handled the message if this turn came from a direct delivery"
    ].filter(Boolean).join("\n");
  }

  private agentToolContractBlock(): string {
    return [
      "Finish:",
      "- complete_task with summary/artifacts when done.",
      "- fail_task with reason if blocked.",
      "- send_message for teammate questions/handoffs/results.",
      "- ask_lead for human clarification."
    ].join("\n");
  }

  private policyPromptBlock(member: Member): string {
    const policy = new RuntimePolicyService(this.state).policySummary(member);
    return [
      "Tools:",
      `- Allowed: ${policy.allowed.join(", ")}.`,
      policy.denied.length > 0 ? `- Denied: ${policy.denied.join(", ")}.` : undefined,
      policy.denied.length > 0 ? "- If blocked by policy, ask_lead or fail_task." : undefined
    ].filter(Boolean).join("\n");
  }

  private messagePromptBlock(messages: Message[]): string {
    return [
      "Messages:",
      ...messages.map((message) => [
        `- ${message.id} ${message.fromMemberId ? `from ${message.fromMemberId}: ` : ""}${message.subject ? `${message.subject} - ` : ""}${message.body}`,
        message.replyToMessageId ? `  replyTo=${message.replyToMessageId}` : undefined
      ].filter(Boolean).join("\n"))
    ].join("\n");
  }

  private pathLockPromptBlock(activeLocks: PathLock[]): string {
    const blockingLocks = activeLocks.filter((lock) => lock.ownerMemberId !== undefined);
    return [
      "Edits: lock_paths before edits; unlock_paths when done.",
      blockingLocks.length > 0 ? [
        "Active locks:",
        ...blockingLocks.map((lock) => `- ${lock.paths.join(", ")} by ${lock.ownerMemberId}${lock.taskId ? ` for ${lock.taskId}` : ""}`)
      ].join("\n") : undefined
    ].filter(Boolean).join("\n");
  }

  recordDecision(teamId: string, assignments: SchedulerAssignment[], decision: string): SchedulerTickResult {
    const now = nowIso();
    this.state.schedulerStates[teamId] = {
      ...(this.state.schedulerStates[teamId] ?? { teamId, paused: false }),
      teamId,
      lastTickAt: now,
      lastDecision: decision,
      updatedAt: now
    };
    addEvent(this.state, {
      teamId,
      entityType: "team",
      entityId: teamId,
      type: "scheduler.tick",
      message: decision
    });
    return { assignments, decision };
  }

  private recordPreparedDecision(teamId: string, decision: string): SchedulerPreparedTickResult {
    this.recordDecision(teamId, [], decision);
    return { assignments: [], decision };
  }
}

function priorityRank(task: Task): number {
  if (task.priority === "high") {
    return 3;
  }
  if (task.priority === "medium") {
    return 2;
  }
  if (task.priority === "low") {
    return 1;
  }
  return 0;
}

function messagePriority(message: Message): number {
  if (message.type === "handoff") {
    return 5;
  }
  if (message.type === "question") {
    return 4;
  }
  if (message.type === "escalation") {
    return 3;
  }
  if (message.type === "opinion") {
    return 2;
  }
  return 1;
}

function fallbackConversationMessagePriority(state: TeamState, teamId: string, memberId: string, message: Message): number {
  const thread = discussionThreadForMessage(state, teamId, message.id);
  return messagePriority(message)
    + (message.toMemberId === memberId ? 100 : 0)
    + (thread?.owedMemberIds.includes(memberId) ? 50 : 0)
    + ((thread?.proposedNextAction.kind === "wait_for_members" || thread?.proposedNextAction.kind === "prompt_member") ? 20 : 0)
    + (thread?.proposedNextAction.kind === "continue_discussion" ? 10 : 0);
}

function shouldPromptThreadObligation(
  thread: DiscussionThreadState,
  message: Message,
  memberId: string,
  obligation: DiscussionTurnObligation
): boolean {
  if (thread.proposedNextAction.kind === "host_decision" || thread.proposedNextAction.kind === "summarize_conclusion" || thread.proposedNextAction.kind === "none") {
    return false;
  }
  if (message.type === "escalation") {
    return false;
  }
  if (obligation.kind === "invited_opinion") {
    return true;
  }
  if (obligation.kind === "participant_reply") {
    return thread.owedMemberIds.includes(memberId);
  }
  if (message.toMemberId) {
    return message.toMemberId === memberId && (message.type === "question" || message.type === "handoff" || message.type === "notification");
  }
  return !message.fromMemberId || message.type === "question" || message.type === "handoff";
}

function threadObligationPriority(memberId: string, candidate: ThreadConversationTurnCandidate): number {
  return messagePriority(candidate.message)
    + candidate.obligation.priorityScore
    + (candidate.message.toMemberId === memberId ? 100 : 0)
    + (candidate.message.fromMemberId ? 15 : 25)
    + ((candidate.thread.proposedNextAction.kind === "wait_for_members" || candidate.thread.proposedNextAction.kind === "prompt_member") ? 20 : 0)
    + (candidate.thread.proposedNextAction.kind === "continue_discussion" ? 10 : 0);
}

function shouldPromptFallbackConversationTurn(state: TeamState, teamId: string, memberId: string, message: Message): boolean {
  const thread = discussionThreadForMessage(state, teamId, message.id);
  const isDirect = message.toMemberId === memberId;

  if (message.type === "escalation") {
    return false;
  }
  if (thread?.proposedNextAction.kind === "host_decision" || thread?.proposedNextAction.kind === "summarize_conclusion" || thread?.proposedNextAction.kind === "none") {
    return false;
  }
  if (isDirect) {
    return true;
  }
  if (!thread) {
    return false;
  }
  if (thread.proposedNextAction.kind === "prompt_member") {
    return thread.proposedNextAction.memberIds?.includes(memberId) ?? false;
  }
  if (!thread.owedMemberIds.includes(memberId)) {
    return false;
  }
  if (!message.fromMemberId && (message.type === "question" || message.type === "notification" || message.type === "handoff")) {
    return true;
  }
  return message.type === "question" || message.type === "handoff";
}
