import type { Member, Message, TeamState } from "../domain/types.js";

export type DiscussionThreadStateName = "waiting_for_members" | "in_discussion" | "ready_for_host" | "settled" | "closed";
export type DiscussionLifecycleState = "open" | "collecting" | "contested" | "settled" | "closed";
export type DiscussionDisagreementState = "none" | "possible" | "needs_resolution";
export type DiscussionResolutionState = "not_started" | "forming" | "blocked" | "resolved";
export type DiscussionActionabilityState = "none" | "follow_up_discussion" | "ready_for_task" | "waiting_host_commit";
export type DiscussionTurnTakingState =
  | "blocked_by_host"
  | "waiting_follow_up"
  | "waiting_required"
  | "inviting_optional"
  | "settled"
  | "none";
export type DiscussionNextActionKind =
  | "wait_for_members"
  | "prompt_member"
  | "continue_discussion"
  | "host_decision"
  | "summarize_conclusion"
  | "none";

export interface DiscussionNextAction {
  kind: DiscussionNextActionKind;
  summary: string;
  memberIds?: string[];
}

export type DiscussionTurnObligationKind = "direct_reply" | "participant_reply" | "follow_up_reply" | "invited_opinion";
export type DiscussionTurnObligationSource = "delivery" | "thread_state" | "callWhen_match";
export type DiscussionTurnObligationTrigger =
  | "direct_message"
  | "participant_obligation"
  | "callWhen_match"
  | "host_decision_follow_through"
  | "unresolved_question_follow_up";

export type DiscussionMemberSynthesisStatus = "responded" | "owed" | "invited";
export type DiscussionClosureReason = "committed_to_task";
export type DiscussionExpectedContribution = "reply" | "opinion" | "acknowledge_or_opinion";

export interface DiscussionNextTurnSummary {
  memberId: string;
  memberName?: string;
  kind: DiscussionTurnObligationKind;
  trigger: DiscussionTurnObligationTrigger;
  reason: string;
  required: boolean;
  priorityScore: number;
  expectedContribution: DiscussionExpectedContribution;
}

export interface DiscussionMemberSynthesis {
  memberId: string;
  memberName: string;
  status: DiscussionMemberSynthesisStatus;
  latestMessageId?: string;
  latestMessageType?: Message["type"];
  latestBodyPreview?: string;
}

export interface DiscussionSynthesis {
  headline: string;
  summary: string;
  resolutionState: DiscussionResolutionState;
  memberSummaries: DiscussionMemberSynthesis[];
  openIssueSummary?: string;
  nextActionSummary: string;
}

export interface DiscussionTurnObligation {
  memberId: string;
  memberName?: string;
  kind: DiscussionTurnObligationKind;
  trigger: DiscussionTurnObligationTrigger;
  reason: string;
  messageId: string;
  source: DiscussionTurnObligationSource;
  required: boolean;
  priorityScore: number;
}

export interface DiscussionRoundTurn {
  messageId: string;
  type?: Message["type"];
  fromMemberId?: string;
  fromMemberName?: string;
  toMemberId?: string;
  toMemberName?: string;
  subject?: string;
  bodyPreview: string;
  createdAt: string;
  isCurrentAnchor: boolean;
  awaiting?: "member_response" | "host_decision";
}

export interface DiscussionThreadState {
  threadId: string;
  subject?: string;
  taskId?: string;
  committedTaskId?: string;
  committedTaskTitle?: string;
  commitMessageId?: string;
  closureReason?: DiscussionClosureReason;
  closedAtMessageId?: string;
  closedTaskId?: string;
  state: DiscussionThreadStateName;
  lifecycleState: DiscussionLifecycleState;
  disagreementState: DiscussionDisagreementState;
  resolutionState: DiscussionResolutionState;
  disagreementSummary?: string;
  proposedNextAction: DiscussionNextAction;
  conclusionSummary?: string;
  synthesis: DiscussionSynthesis;
  actionabilityState: DiscussionActionabilityState;
  suggestedActionSummary: string;
  suggestedTaskTitle?: string;
  suggestedTaskDescriptionPreview?: string;
  actionSourceMessageIds: string[];
  turnTakingState: DiscussionTurnTakingState;
  nextResponsibleMemberIds: string[];
  nextResponsibleMemberNames: string[];
  nextTurnSummary?: string;
  currentRoundMessageCount: number;
  currentRoundSummary: string;
  currentRoundAnchor?: Message;
  currentRoundTurns: DiscussionRoundTurn[];
  needsHostDecision: boolean;
  unresolvedQuestionCount: number;
  expectedMemberIds: string[];
  respondedMemberIds: string[];
  respondedMemberNames: string[];
  pendingMemberIds: string[];
  turnObligations: DiscussionTurnObligation[];
  nextTurns: DiscussionNextTurnSummary[];
  owedMemberIds: string[];
  owedMemberNames: string[];
  invitedMemberIds: string[];
  invitedMemberNames: string[];
  participationSummary?: string;
  turnSummary?: string;
  messages: Message[];
  opinions: Message[];
  latestMessage?: Message;
  latestOpinion?: Message;
  latestOpinions: Message[];
}

const RESPONSE_MESSAGE_TYPES = new Set(["opinion", "question", "handoff", "result", "notification"]);
const ACTION_REQUIRED_MESSAGE_TYPES = new Set(["question", "handoff", "notification", "escalation"]);
const DIRECT_RESPONSE_MESSAGE_TYPES = new Set(["question", "handoff", "notification"]);
export const HOST_COMMITTED_TASK_PREFIX = "Host committed task:";

export function discussionThreads(state: TeamState, teamId: string, limit?: number): DiscussionThreadState[] {
  const byThread = new Map<string, Message[]>();
  for (const message of Object.values(state.messages).filter((candidate) => candidate.teamId === teamId)) {
    const threadId = message.threadId ?? message.id;
    byThread.set(threadId, [...(byThread.get(threadId) ?? []), message]);
  }

  const activeTeamMembers = Object.values(state.members)
    .filter((member) => member.teamId === teamId && member.status === "active");

  const threads = [...byThread.entries()]
    .map(([threadId, messages]) => buildThreadState(state, teamId, activeTeamMembers, threadId, messages))
    .filter((thread) => (
      thread.messages.length > 1
      || thread.opinions.length > 0
      || thread.pendingMemberIds.length > 0
      || thread.unresolvedQuestionCount > 0
      || thread.needsHostDecision
    ))
    .sort((first, second) => (second.latestMessage?.createdAt ?? "").localeCompare(first.latestMessage?.createdAt ?? ""));

  return typeof limit === "number" ? threads.slice(0, limit) : threads;
}

export function discussionThreadById(state: TeamState, teamId: string, threadId: string): DiscussionThreadState | undefined {
  return discussionThreads(state, teamId).find((thread) => thread.threadId === threadId);
}

export function discussionThreadForMessage(state: TeamState, teamId: string, messageId: string): DiscussionThreadState | undefined {
  const message = state.messages[messageId];
  if (!message || message.teamId !== teamId) {
    return undefined;
  }
  return discussionThreadById(state, teamId, message.threadId ?? message.id);
}

export function discussionThreadForTask(state: TeamState, teamId: string, taskId: string): DiscussionThreadState | undefined {
  return discussionThreads(state, teamId).find((thread) => thread.taskId === taskId);
}

export function activeDiscussionMessages(messages: Message[]): Message[] {
  const latestHostTurnStart = findLatestHostTurnBoundaryIndex(messages);
  return latestHostTurnStart >= 0 ? messages.slice(latestHostTurnStart) : messages;
}

function buildThreadState(
  state: TeamState,
  teamId: string,
  activeTeamMembers: Member[],
  threadId: string,
  messages: Message[]
): DiscussionThreadState {
  const memberNameById = new Map(activeTeamMembers.map((member) => [member.id, member.name]));
  const sorted = [...messages].sort((first, second) => first.createdAt.localeCompare(second.createdAt));
  const activeMessages = activeDiscussionMessages(sorted);
  const subject = sorted.find((message) => !!message.subject)?.subject;
  const taskId = [...sorted].reverse().find((message) => !!message.taskId)?.taskId;
  const latestCommitMessage = [...sorted].reverse().find((message) => isHostTaskCommitMessage(message));
  const committedTaskId = latestCommitMessage?.taskId;
  const committedTask = committedTaskId ? state.tasks[committedTaskId] : undefined;
  const isClosed = !!committedTaskId;
  const opinions = activeMessages.filter((message) => message.type === "opinion");
  const latestOpinionsByMember = new Map<string, Message>();
  for (const opinion of opinions) {
    if (!opinion.fromMemberId) {
      continue;
    }
    latestOpinionsByMember.set(opinion.fromMemberId, opinion);
  }

  const messageIds = new Set(sorted.map((message) => message.id));
  const activeMessageIds = new Set(activeMessages.map((message) => message.id));
  const deliveries = Object.values(state.messageDeliveries)
    .filter((delivery) => delivery.teamId === teamId && messageIds.has(delivery.messageId));
  const activeDeliveries = deliveries.filter((delivery) => activeMessageIds.has(delivery.messageId));
  const activeTeamMemberIds = activeTeamMembers.map((member) => member.id);
  const expectedMemberIds = unique(
    activeDeliveries.length > 0
      ? activeDeliveries.map((delivery) => delivery.memberId)
      : deliveries.length > 0
        ? deliveries.map((delivery) => delivery.memberId)
      : activeTeamMemberIds
  );
  const respondedMemberIds = unique(activeMessages
    .filter((message) => !!message.fromMemberId && RESPONSE_MESSAGE_TYPES.has(message.type ?? "notification"))
    .map((message) => message.fromMemberId!));
  const actionableUnreadDeliveryKeys = new Set(activeDeliveries
    .filter((delivery) => !delivery.acknowledgedAt && !delivery.consumedAt)
    .filter((delivery) => ACTION_REQUIRED_MESSAGE_TYPES.has(state.messages[delivery.messageId]?.type ?? "notification"))
    .map((delivery) => deliveryKey(delivery.messageId, delivery.memberId)));
  const unresolvedQuestions = activeMessages.filter((message, index) => (
    message.type === "question"
    && !questionAnsweredByLaterMessage(message, activeMessages.slice(index + 1))
  ));
  const unresolvedDirectMessages = activeMessages.filter((message, index) => (
    !!message.toMemberId
    && DIRECT_RESPONSE_MESSAGE_TYPES.has(message.type ?? "notification")
    && !directMessageAnsweredByLaterMessage(message, activeMessages.slice(index + 1))
  ));
  const structuredTurnThread = isStructuredTurnThread(activeMessages);
  const requiredTurnObligations = isClosed
    ? []
    : buildRequiredTurnObligations(
      structuredTurnThread,
      activeMessages,
      expectedMemberIds,
      respondedMemberIds,
      unresolvedDirectMessages,
      actionableUnreadDeliveryKeys,
      memberNameById
    );
  const owedMemberIds = unique(requiredTurnObligations.map((obligation) => obligation.memberId));
  const pendingMemberIds = [...owedMemberIds];
  const currentRoundAnchor = currentRoundFocusMessage(activeMessages, unresolvedQuestions, requiredTurnObligations, pendingMemberIds.length > 0);
  const hasHostFacingEscalation = activeMessages.some((message) => message.type === "escalation");
  const hasUnaddressedQuestionWithoutPendingMembers = unresolvedQuestions.some((message) => !message.toMemberId) && pendingMemberIds.length === 0;
  const multipleOpinionMembers = latestOpinionsByMember.size > 1;
  const needsHostDecision = !isClosed && (hasHostFacingEscalation
    || hasUnaddressedQuestionWithoutPendingMembers
    || (multipleOpinionMembers && unresolvedQuestions.length > 0 && pendingMemberIds.length === 0));
  const lifecycleState = isClosed
    ? "closed"
    : lifecycleStateName(pendingMemberIds.length, needsHostDecision, respondedMemberIds.length, unresolvedQuestions.length);
  const disagreementState = isClosed
    ? "none"
    : disagreementStateName(hasHostFacingEscalation, unresolvedQuestions.length, multipleOpinionMembers);
  const invitedTurnObligations = isClosed
    ? []
    : buildInvitedTurnObligations(
      activeTeamMembers,
      memberNameById,
      subject,
      activeMessages,
      currentRoundAnchor,
      expectedMemberIds,
      respondedMemberIds,
      pendingMemberIds,
      lifecycleState,
      needsHostDecision,
      unresolvedQuestions.length,
      latestOpinionsByMember.size
    );
  const invitedMemberIds = unique(invitedTurnObligations.map((obligation) => obligation.memberId));
  const respondedMemberNames = memberLabels(respondedMemberIds, memberNameById);
  const owedMemberNames = memberLabels(owedMemberIds, memberNameById);
  const invitedMemberNames = memberLabels(invitedMemberIds, memberNameById);
  const turnObligations = [...requiredTurnObligations, ...invitedTurnObligations];
  const nextTurns = buildNextTurnSummaries(turnObligations);
  const participationSummary = buildParticipationSummary(
    lifecycleState,
    respondedMemberNames,
    owedMemberNames,
    invitedMemberNames
  );
  const turnSummary = buildTurnSummary(owedMemberNames, invitedMemberNames);
  const disagreementSummary = isClosed
    ? undefined
    : buildDisagreementSummary(disagreementState, hasHostFacingEscalation, unresolvedQuestions.length, latestOpinionsByMember.size);
  const conclusionSummary = buildConclusionSummary(activeMessages, lifecycleState, respondedMemberNames, latestOpinionsByMember.size);
  const proposedNextAction: DiscussionNextAction = isClosed
    ? {
      kind: "none",
      summary: `This discussion is closed and has moved to task ${committedTaskId}.`
    }
    : buildProposedNextAction(
      currentRoundAnchor,
      lifecycleState,
      needsHostDecision,
      pendingMemberIds,
      owedMemberNames,
      invitedMemberIds,
      invitedMemberNames,
      disagreementSummary,
      conclusionSummary
    );
  const currentRoundTurns = buildCurrentRoundTurns(activeMessages, currentRoundAnchor, pendingMemberIds.length > 0, needsHostDecision, memberNameById);
  const turnTaking = buildTurnTakingState(proposedNextAction, lifecycleState, turnObligations, memberNameById);
  const actionability = buildActionabilityState({
    threadId,
    subject,
    activeMessages,
    currentRoundAnchor,
    lifecycleState,
    proposedNextAction,
    needsHostDecision,
    unresolvedQuestionCount: unresolvedQuestions.length,
    conclusionSummary
  });
  const synthesis = buildSynthesis({
    subject,
    lifecycleState,
    needsHostDecision,
    proposedNextAction,
    disagreementSummary,
    conclusionSummary,
    currentRoundTurns,
    expectedMemberIds,
    respondedMemberIds,
    owedMemberIds,
    invitedMemberIds,
    nextTurnSummary: turnTaking.nextTurnSummary,
    closedTaskId: isClosed ? committedTaskId : undefined,
    memberNameById
  });
  const currentRoundSummaryText = isClosed
    ? `Discussion is closed and handed off to task ${committedTaskId}.`
    : currentRoundSummary(currentRoundAnchor, pendingMemberIds.length, unresolvedQuestions.length, needsHostDecision, respondedMemberIds.length);

  return {
    threadId,
    subject,
    taskId,
    committedTaskId,
    committedTaskTitle: committedTask?.title,
    commitMessageId: latestCommitMessage?.id,
    closureReason: isClosed ? "committed_to_task" : undefined,
    closedAtMessageId: isClosed ? latestCommitMessage?.id : undefined,
    closedTaskId: isClosed ? committedTaskId : undefined,
    state: threadStateName(lifecycleState, proposedNextAction.kind),
    lifecycleState,
    disagreementState,
    resolutionState: synthesis.resolutionState,
    disagreementSummary,
    proposedNextAction,
    conclusionSummary,
    synthesis,
    actionabilityState: actionability.actionabilityState,
    suggestedActionSummary: actionability.suggestedActionSummary,
    suggestedTaskTitle: actionability.suggestedTaskTitle,
    suggestedTaskDescriptionPreview: actionability.suggestedTaskDescriptionPreview,
    actionSourceMessageIds: actionability.actionSourceMessageIds,
    turnTakingState: turnTaking.turnTakingState,
    nextResponsibleMemberIds: turnTaking.nextResponsibleMemberIds,
    nextResponsibleMemberNames: turnTaking.nextResponsibleMemberNames,
    nextTurnSummary: turnTaking.nextTurnSummary,
    currentRoundMessageCount: activeMessages.length,
    currentRoundSummary: currentRoundSummaryText,
    currentRoundAnchor,
    currentRoundTurns,
    needsHostDecision,
    unresolvedQuestionCount: isClosed ? 0 : unresolvedQuestions.length,
    expectedMemberIds,
    respondedMemberIds,
    respondedMemberNames,
    pendingMemberIds,
    turnObligations,
    nextTurns,
    owedMemberIds,
    owedMemberNames,
    invitedMemberIds,
    invitedMemberNames,
    participationSummary,
    turnSummary,
    messages: sorted,
    opinions,
    latestMessage: sorted.at(-1),
    latestOpinion: opinions.at(-1),
    latestOpinions: [...latestOpinionsByMember.values()].sort((first, second) => second.createdAt.localeCompare(first.createdAt))
  };
}

export function discussionTurnPriorityScore(trigger: DiscussionTurnObligationTrigger): number {
  switch (trigger) {
    case "direct_message":
      return 500;
    case "unresolved_question_follow_up":
      return 450;
    case "host_decision_follow_through":
      return 400;
    case "participant_obligation":
      return 300;
    case "callWhen_match":
      return 100;
  }
}

export function expectedContributionForTurn(
  obligation: Pick<DiscussionTurnObligation, "kind" | "trigger">
): DiscussionExpectedContribution {
  if (obligation.trigger === "host_decision_follow_through") {
    return "acknowledge_or_opinion";
  }
  if (obligation.kind === "invited_opinion") {
    return "opinion";
  }
  return "reply";
}

function buildNextTurnSummaries(turnObligations: DiscussionTurnObligation[]): DiscussionNextTurnSummary[] {
  return [...turnObligations]
    .sort((first, second) => {
      if (first.priorityScore !== second.priorityScore) {
        return second.priorityScore - first.priorityScore;
      }
      return first.memberId.localeCompare(second.memberId);
    })
    .map((obligation) => ({
      memberId: obligation.memberId,
      memberName: obligation.memberName,
      kind: obligation.kind,
      trigger: obligation.trigger,
      reason: obligation.reason,
      required: obligation.required,
      priorityScore: obligation.priorityScore,
      expectedContribution: expectedContributionForTurn(obligation)
    }));
}

function findLatestHostTurnBoundaryIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isHostTurnBoundary(messages[index]!)) {
      return index;
    }
  }
  return -1;
}

function isHostTurnBoundary(message: Message): boolean {
  return !message.fromMemberId
    && !isHostTaskCommitMessage(message)
    && ACTION_REQUIRED_MESSAGE_TYPES.has(message.type ?? "notification");
}

function isHostDecisionMessage(message: Message): boolean {
  return !message.fromMemberId && message.type === "notification" && message.body.startsWith("Host decision:");
}

export function isHostTaskCommitMessage(message: Message): boolean {
  return !message.fromMemberId
    && message.type === "notification"
    && message.body.startsWith(HOST_COMMITTED_TASK_PREFIX);
}

function questionAnsweredByLaterMessage(question: Message, laterMessages: Message[]): boolean {
  if (question.toMemberId) {
    return laterMessages.some((message) => message.fromMemberId === question.toMemberId);
  }
  return laterMessages.some((message) => !!message.fromMemberId && RESPONSE_MESSAGE_TYPES.has(message.type ?? "notification"));
}

function directMessageAnsweredByLaterMessage(message: Message, laterMessages: Message[]): boolean {
  if (!message.toMemberId) {
    return false;
  }
  return laterMessages.some((candidate) => candidate.fromMemberId === message.toMemberId);
}

function threadStateName(
  lifecycleState: DiscussionLifecycleState,
  nextActionKind: DiscussionNextActionKind
): DiscussionThreadStateName {
  if (lifecycleState === "closed") {
    return "closed";
  }
  if (nextActionKind === "host_decision") {
    return "ready_for_host";
  }
  if (lifecycleState === "open" || lifecycleState === "collecting") {
    return "waiting_for_members";
  }
  if (lifecycleState === "contested") {
    return "in_discussion";
  }
  return "settled";
}

function lifecycleStateName(
  pendingMemberCount: number,
  needsHostDecision: boolean,
  respondedMemberCount: number,
  unresolvedQuestionCount: number
): DiscussionLifecycleState {
  if (respondedMemberCount === 0) {
    return "open";
  }
  if (pendingMemberCount > 0) {
    return "collecting";
  }
  if (needsHostDecision || unresolvedQuestionCount > 0) {
    return "contested";
  }
  return "settled";
}

function disagreementStateName(
  hasHostFacingEscalation: boolean,
  unresolvedQuestionCount: number,
  multipleOpinionMembers: boolean
): DiscussionDisagreementState {
  if (hasHostFacingEscalation) {
    return "needs_resolution";
  }
  if (multipleOpinionMembers && unresolvedQuestionCount > 0) {
    return "needs_resolution";
  }
  if (unresolvedQuestionCount > 0) {
    return "possible";
  }
  return "none";
}

function buildDisagreementSummary(
  disagreementState: DiscussionDisagreementState,
  hasHostFacingEscalation: boolean,
  unresolvedQuestionCount: number,
  opinionCount: number
): string | undefined {
  if (disagreementState === "none") {
    return undefined;
  }
  if (hasHostFacingEscalation) {
    return "A host escalation is holding the current round for judgment.";
  }
  if (opinionCount > 1 && unresolvedQuestionCount > 0) {
    return `${opinionCount} member opinions are recorded and ${unresolvedQuestionCount} question${unresolvedQuestionCount === 1 ? " is" : "s are"} still unresolved.`;
  }
  return `${unresolvedQuestionCount} question${unresolvedQuestionCount === 1 ? " is" : "s are"} still unresolved in the current round.`;
}

function buildProposedNextAction(
  currentRoundAnchor: Message | undefined,
  lifecycleState: DiscussionLifecycleState,
  needsHostDecision: boolean,
  pendingMemberIds: string[],
  owedMemberNames: string[],
  invitedMemberIds: string[],
  invitedMemberNames: string[],
  disagreementSummary: string | undefined,
  conclusionSummary: string | undefined
): DiscussionNextAction {
  if (needsHostDecision) {
    return {
      kind: "host_decision",
      summary: disagreementSummary ?? "The current round needs a host decision."
    };
  }
  if (pendingMemberIds.length > 0) {
    if (pendingMemberIds.length === 1 || (currentRoundAnchor?.toMemberId && pendingMemberIds.includes(currentRoundAnchor.toMemberId))) {
      return {
        kind: "prompt_member",
        summary: `Prompt ${formatMemberList(owedMemberNames)} to respond to the current round.`,
        memberIds: pendingMemberIds
      };
    }
    return {
      kind: "wait_for_members",
      summary: `Wait for ${formatMemberList(owedMemberNames)} to respond before settling the round.`,
      memberIds: pendingMemberIds
    };
  }
  if (lifecycleState === "contested") {
    return {
      kind: "continue_discussion",
      summary: invitedMemberIds.length > 0
        ? `Invite ${formatMemberList(invitedMemberNames)} to weigh in on the current discussion round.`
        : disagreementSummary ?? "Continue the current discussion round.",
      memberIds: invitedMemberIds.length > 0 ? invitedMemberIds : undefined
    };
  }
  if (lifecycleState === "settled") {
    return {
      kind: "summarize_conclusion",
      summary: conclusionSummary ?? "The current round is settled and ready for a brief conclusion."
    };
  }
  return {
    kind: "none",
    summary: "No immediate discussion action is pending."
  };
}

function buildConclusionSummary(
  activeMessages: Message[],
  lifecycleState: DiscussionLifecycleState,
  respondedMemberNames: string[],
  opinionCount: number
): string | undefined {
  if (lifecycleState === "closed") {
    const commit = [...activeMessages].reverse().find((message) => isHostTaskCommitMessage(message));
    return commit?.taskId
      ? `The discussion was closed and handed off to task ${commit.taskId}.`
      : "The discussion was closed.";
  }
  if (lifecycleState !== "settled") {
    return undefined;
  }
  const hostDecision = [...activeMessages]
    .reverse()
    .find((message) => isHostDecisionMessage(message));
  if (hostDecision) {
    return previewBody(hostDecision.body);
  }
  if (respondedMemberNames.length > 0) {
    return `${formatMemberList(respondedMemberNames)} ${hasHave(respondedMemberNames)} responded; the round is now settled.`;
  }
  if (opinionCount > 0) {
    return `${opinionCount} member opinion${opinionCount === 1 ? " was" : "s were"} collected; the round is now settled.`;
  }
  return "The current round is now settled.";
}

function buildSynthesis(input: {
  subject: string | undefined;
  lifecycleState: DiscussionLifecycleState;
  needsHostDecision: boolean;
  proposedNextAction: DiscussionNextAction;
  disagreementSummary: string | undefined;
  conclusionSummary: string | undefined;
  currentRoundTurns: DiscussionRoundTurn[];
  expectedMemberIds: string[];
  respondedMemberIds: string[];
  owedMemberIds: string[];
  invitedMemberIds: string[];
  nextTurnSummary: string | undefined;
  closedTaskId?: string;
  memberNameById: Map<string, string>;
}): DiscussionSynthesis {
  const resolutionState = discussionResolutionState(
    input.lifecycleState,
    input.needsHostDecision,
    input.respondedMemberIds.length
  );
  const memberSummaries = buildMemberSummaries(
    input.currentRoundTurns,
    input.expectedMemberIds,
    input.respondedMemberIds,
    input.owedMemberIds,
    input.invitedMemberIds,
    input.memberNameById
  );
  const respondedNames = memberSummaries.filter((member) => member.status === "responded").map((member) => member.memberName);
  const owedNames = memberSummaries.filter((member) => member.status === "owed").map((member) => member.memberName);
  const invitedNames = memberSummaries.filter((member) => member.status === "invited").map((member) => member.memberName);
  const openIssueSummary = resolutionState === "blocked"
    ? input.disagreementSummary ?? input.proposedNextAction.summary
    : input.disagreementSummary;
  const summary = buildSynthesisSummary(resolutionState, respondedNames, owedNames, invitedNames, openIssueSummary, input.conclusionSummary, input.lifecycleState, input.closedTaskId);

  return {
    headline: buildSynthesisHeadline(input.subject, input.lifecycleState, resolutionState, owedNames, input.closedTaskId),
    summary,
    resolutionState,
    memberSummaries,
    openIssueSummary: resolutionState === "blocked" || input.disagreementSummary ? openIssueSummary : undefined,
    nextActionSummary: input.nextTurnSummary ?? input.proposedNextAction.summary
  };
}

function buildTurnTakingState(
  proposedNextAction: DiscussionNextAction,
  lifecycleState: DiscussionLifecycleState,
  turnObligations: DiscussionTurnObligation[],
  memberNameById: Map<string, string>
): {
  turnTakingState: DiscussionTurnTakingState;
  nextResponsibleMemberIds: string[];
  nextResponsibleMemberNames: string[];
  nextTurnSummary?: string;
} {
  if (lifecycleState === "closed") {
    return {
      turnTakingState: "none",
      nextResponsibleMemberIds: [],
      nextResponsibleMemberNames: []
    };
  }
  if (proposedNextAction.kind === "host_decision") {
    return {
      turnTakingState: "blocked_by_host",
      nextResponsibleMemberIds: [],
      nextResponsibleMemberNames: [],
      nextTurnSummary: "Waiting for the host decision before member turns continue."
    };
  }
  if (lifecycleState === "settled" || proposedNextAction.kind === "summarize_conclusion") {
    return {
      turnTakingState: "settled",
      nextResponsibleMemberIds: [],
      nextResponsibleMemberNames: []
    };
  }
  if (turnObligations.length === 0) {
    return {
      turnTakingState: "none",
      nextResponsibleMemberIds: [],
      nextResponsibleMemberNames: []
    };
  }

  const priorityScore = Math.max(...turnObligations.map((obligation) => obligation.priorityScore));
  const topObligations = turnObligations.filter((obligation) => obligation.priorityScore === priorityScore);
  const nextResponsibleMemberIds = unique(topObligations.map((obligation) => obligation.memberId));
  const nextResponsibleMemberNames = memberLabels(nextResponsibleMemberIds, memberNameById);
  const trigger = topObligations[0]!.trigger;

  if (trigger === "direct_message" || trigger === "unresolved_question_follow_up") {
    return {
      turnTakingState: "waiting_follow_up",
      nextResponsibleMemberIds,
      nextResponsibleMemberNames,
      nextTurnSummary: trigger === "direct_message"
        ? `Waiting on ${formatMemberList(nextResponsibleMemberNames)} to answer a direct message.`
        : `Waiting on ${formatMemberList(nextResponsibleMemberNames)} to answer a follow-up message.`
    };
  }
  if (trigger === "host_decision_follow_through") {
    return {
      turnTakingState: "waiting_required",
      nextResponsibleMemberIds,
      nextResponsibleMemberNames,
      nextTurnSummary: `Waiting on ${formatMemberList(nextResponsibleMemberNames)} to acknowledge the host decision.`
    };
  }
  if (trigger === "participant_obligation") {
    return {
      turnTakingState: "waiting_required",
      nextResponsibleMemberIds,
      nextResponsibleMemberNames,
      nextTurnSummary: `Waiting on ${formatMemberList(nextResponsibleMemberNames)} to reply in the current round.`
    };
  }
  return {
    turnTakingState: "inviting_optional",
    nextResponsibleMemberIds,
    nextResponsibleMemberNames,
    nextTurnSummary: `Inviting ${formatMemberList(nextResponsibleMemberNames)} to weigh in on the current round.`
  };
}

function buildActionabilityState(input: {
  threadId: string;
  subject: string | undefined;
  activeMessages: Message[];
  currentRoundAnchor: Message | undefined;
  lifecycleState: DiscussionLifecycleState;
  proposedNextAction: DiscussionNextAction;
  needsHostDecision: boolean;
  unresolvedQuestionCount: number;
  conclusionSummary: string | undefined;
}): {
  actionabilityState: DiscussionActionabilityState;
  suggestedActionSummary: string;
  suggestedTaskTitle?: string;
  suggestedTaskDescriptionPreview?: string;
  actionSourceMessageIds: string[];
} {
  const latestMessage = input.activeMessages.at(-1);
  const currentRoundAnchor = input.currentRoundAnchor;
  const executionCue = settledExecutionCue(input.activeMessages, currentRoundAnchor);

  if (latestMessage && isHostTaskCommitMessage(latestMessage)) {
    return {
      actionabilityState: "none",
      suggestedActionSummary: latestMessage.taskId
        ? `This discussion has already produced follow-up task ${latestMessage.taskId}.`
        : "A follow-up task has already been created from this settled discussion.",
      actionSourceMessageIds: [latestMessage.id]
    };
  }

  if (input.lifecycleState === "closed") {
    return {
      actionabilityState: "none",
      suggestedActionSummary: "This discussion is closed.",
      actionSourceMessageIds: latestMessage ? [latestMessage.id] : []
    };
  }

  if (input.proposedNextAction.kind === "host_decision") {
    return {
      actionabilityState: "follow_up_discussion",
      suggestedActionSummary: input.proposedNextAction.summary,
      actionSourceMessageIds: latestMessage ? [latestMessage.id] : []
    };
  }

  if (input.proposedNextAction.kind === "continue_discussion") {
    return {
      actionabilityState: "follow_up_discussion",
      suggestedActionSummary: "Continue the current discussion before turning it into task work.",
      actionSourceMessageIds: currentRoundAnchor ? [currentRoundAnchor.id] : latestMessage ? [latestMessage.id] : []
    };
  }

  if (
    input.lifecycleState !== "settled"
    && currentRoundAnchor?.fromMemberId
    && (currentRoundAnchor.type === "question" || currentRoundAnchor.type === "handoff")
  ) {
    return {
      actionabilityState: "follow_up_discussion",
      suggestedActionSummary: "Continue the current discussion before turning it into task work.",
      actionSourceMessageIds: [currentRoundAnchor.id]
    };
  }

  if (input.lifecycleState !== "settled") {
    return {
      actionabilityState: "none",
      suggestedActionSummary: "The discussion is still collecting or confirming member replies.",
      actionSourceMessageIds: currentRoundAnchor ? [currentRoundAnchor.id] : latestMessage ? [latestMessage.id] : []
    };
  }

  if (executionCue) {
    return {
      actionabilityState: "ready_for_task",
      suggestedActionSummary: `The discussion is settled and the latest ${executionCue.label} can be turned into task work.`,
      suggestedTaskTitle: suggestedTaskTitle(input.subject, executionCue.message),
      suggestedTaskDescriptionPreview: previewBody(executionCue.message.body),
      actionSourceMessageIds: [executionCue.message.id]
    };
  }

  return {
    actionabilityState: "waiting_host_commit",
    suggestedActionSummary: "The discussion is settled; decide whether to create follow-up task work or continue the thread.",
    suggestedTaskTitle: input.subject ? `Follow up on ${input.subject}` : "Describe the next task to run",
    suggestedTaskDescriptionPreview: input.conclusionSummary,
    actionSourceMessageIds: latestMessage ? [latestMessage.id] : []
  };
}

function settledExecutionCue(
  activeMessages: Message[],
  currentRoundAnchor: Message | undefined
): { message: Message; label: string } | undefined {
  if (currentRoundAnchor?.type === "handoff") {
    return { message: currentRoundAnchor, label: "handoff" };
  }
  if (currentRoundAnchor?.type === "result") {
    return { message: currentRoundAnchor, label: "result" };
  }
  if (currentRoundAnchor && isHostDecisionMessage(currentRoundAnchor)) {
    return { message: currentRoundAnchor, label: "host decision" };
  }
  const latestHandoff = [...activeMessages].reverse().find((message) => message.type === "handoff");
  if (latestHandoff) {
    return { message: latestHandoff, label: "handoff" };
  }
  const latestResult = [...activeMessages].reverse().find((message) => message.type === "result");
  if (latestResult) {
    return { message: latestResult, label: "result" };
  }
  return undefined;
}

function suggestedTaskTitle(subject: string | undefined, message: Message): string {
  if (message.subject) {
    return message.subject;
  }
  if (isHostDecisionMessage(message)) {
    return subject ? `Follow up on ${subject}` : "Follow up on the host decision";
  }
  if (subject) {
    return `Follow up on ${subject}`;
  }
  return "Describe the next task to run";
}

function discussionResolutionState(
  lifecycleState: DiscussionLifecycleState,
  needsHostDecision: boolean,
  respondedMemberCount: number
): DiscussionResolutionState {
  if (needsHostDecision) {
    return "blocked";
  }
  if (lifecycleState === "settled" || lifecycleState === "closed") {
    return "resolved";
  }
  if (respondedMemberCount === 0) {
    return "not_started";
  }
  return "forming";
}

function buildMemberSummaries(
  currentRoundTurns: DiscussionRoundTurn[],
  expectedMemberIds: string[],
  respondedMemberIds: string[],
  owedMemberIds: string[],
  invitedMemberIds: string[],
  memberNameById: Map<string, string>
): DiscussionMemberSynthesis[] {
  const relevantMemberIds = unique([
    ...expectedMemberIds,
    ...respondedMemberIds,
    ...owedMemberIds,
    ...invitedMemberIds
  ]);
  return relevantMemberIds.map((memberId) => {
    const latestTurn = [...currentRoundTurns].reverse().find((turn) => turn.fromMemberId === memberId);
    return {
      memberId,
      memberName: memberNameById.get(memberId) ?? memberId,
      status: owedMemberIds.includes(memberId)
        ? "owed"
        : invitedMemberIds.includes(memberId)
          ? "invited"
          : "responded",
      latestMessageId: latestTurn?.messageId,
      latestMessageType: latestTurn?.type,
      latestBodyPreview: latestTurn?.bodyPreview
    };
  });
}

function buildSynthesisHeadline(
  subject: string | undefined,
  lifecycleState: DiscussionLifecycleState,
  resolutionState: DiscussionResolutionState,
  owedMemberNames: string[],
  closedTaskId: string | undefined
): string {
  const label = subject ? `Discussion "${subject}"` : "Discussion thread";
  if (lifecycleState === "closed") {
    return closedTaskId
      ? `${label} is closed and handed off to task ${closedTaskId}.`
      : `${label} is closed.`;
  }
  if (resolutionState === "blocked") {
    return `${label} needs a host decision.`;
  }
  if (resolutionState === "resolved") {
    return `${label} is settled.`;
  }
  if (owedMemberNames.length > 0) {
    return `${label} is waiting for ${formatMemberList(owedMemberNames)}.`;
  }
  return `${label} is forming.`;
}

function buildSynthesisSummary(
  resolutionState: DiscussionResolutionState,
  respondedMemberNames: string[],
  owedMemberNames: string[],
  invitedMemberNames: string[],
  openIssueSummary: string | undefined,
  conclusionSummary: string | undefined,
  lifecycleState: DiscussionLifecycleState,
  closedTaskId: string | undefined
): string {
  if (lifecycleState === "closed") {
    return closedTaskId
      ? `The discussion is closed and should continue through task ${closedTaskId}.`
      : "The discussion is closed.";
  }
  if (resolutionState === "blocked") {
    return [
      memberProgressClause(respondedMemberNames, owedMemberNames, invitedMemberNames),
      openIssueSummary
    ].filter(Boolean).join(" ");
  }
  if (resolutionState === "resolved") {
    return conclusionSummary ?? memberProgressClause(respondedMemberNames, owedMemberNames, invitedMemberNames) ?? "The current round is settled.";
  }
  return memberProgressClause(respondedMemberNames, owedMemberNames, invitedMemberNames)
    ?? "The current discussion round has not started receiving member replies.";
}

function memberProgressClause(
  respondedMemberNames: string[],
  owedMemberNames: string[],
  invitedMemberNames: string[]
): string | undefined {
  const parts: string[] = [];
  if (respondedMemberNames.length > 0) {
    parts.push(`${formatMemberList(respondedMemberNames)} ${hasHave(respondedMemberNames)} responded`);
  }
  if (owedMemberNames.length > 0) {
    parts.push(`${formatMemberList(owedMemberNames)} ${stillOwes(owedMemberNames)} a reply`);
  }
  if (invitedMemberNames.length > 0) {
    parts.push(`${formatMemberList(invitedMemberNames)} ${isAre(invitedMemberNames)} invited to weigh in`);
  }
  if (parts.length === 0) {
    return undefined;
  }
  return `${parts.join("; ")}.`;
}

function currentRoundFocusMessage(
  activeMessages: Message[],
  unresolvedQuestions: Message[],
  requiredTurnObligations: DiscussionTurnObligation[],
  hasPendingMembers: boolean
): Message | undefined {
  const targetedFollowUp = [...requiredTurnObligations]
    .filter((obligation) => obligation.kind === "direct_reply" || obligation.kind === "follow_up_reply")
    .map((obligation) => activeMessages.find((message) => message.id === obligation.messageId))
    .filter((message): message is Message => !!message)
    .sort((first, second) => second.createdAt.localeCompare(first.createdAt))[0];
  if (targetedFollowUp) {
    return targetedFollowUp;
  }
  if (hasPendingMembers && unresolvedQuestions.length > 0) {
    return unresolvedQuestions.at(-1);
  }
  for (let index = activeMessages.length - 1; index >= 0; index -= 1) {
    const message = activeMessages[index]!;
    if (ACTION_REQUIRED_MESSAGE_TYPES.has(message.type ?? "notification")) {
      return message;
    }
  }
  return activeMessages[0];
}

function currentRoundSummary(
  anchor: Message | undefined,
  pendingMemberCount: number,
  unresolvedQuestionCount: number,
  needsHostDecision: boolean,
  respondedMemberCount: number
): string {
  if (needsHostDecision) {
    return `Current round reached a host decision point after ${respondedMemberCount} member response${respondedMemberCount === 1 ? "" : "s"}.`;
  }
  if (pendingMemberCount > 0) {
    return `Current round started with ${roundAnchorLabel(anchor)} and is waiting for ${pendingMemberCount} member response${pendingMemberCount === 1 ? "" : "s"}.`;
  }
  if (unresolvedQuestionCount > 0) {
    return `Current round still has ${unresolvedQuestionCount} unresolved question${unresolvedQuestionCount === 1 ? "" : "s"}.`;
  }
  return `Current round is settled with ${respondedMemberCount} member response${respondedMemberCount === 1 ? "" : "s"}.`;
}

function roundAnchorLabel(message: Message | undefined): string {
  if (!message) {
    return "the latest discussion turn";
  }
  const actor = message.fromMemberId ? "a member" : "the host";
  return `${actor} ${message.type ?? "notification"}`;
}

function buildCurrentRoundTurns(
  messages: Message[],
  currentRoundAnchor: Message | undefined,
  hasPendingMemberResponses: boolean,
  needsHostDecision: boolean,
  memberNameById: Map<string, string>
): DiscussionRoundTurn[] {
  return messages.map((message) => ({
    messageId: message.id,
    type: message.type,
    fromMemberId: message.fromMemberId,
    fromMemberName: message.fromMemberId ? memberNameById.get(message.fromMemberId) : undefined,
    toMemberId: message.toMemberId,
    toMemberName: message.toMemberId ? memberNameById.get(message.toMemberId) : undefined,
    subject: message.subject,
    bodyPreview: previewBody(message.body),
    createdAt: message.createdAt,
    isCurrentAnchor: currentRoundAnchor?.id === message.id,
    awaiting: currentRoundAnchor?.id === message.id
      ? needsHostDecision
        ? "host_decision"
        : hasPendingMemberResponses
          ? "member_response"
          : undefined
      : undefined
  }));
}

function previewBody(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (normalized.length <= 120) {
    return normalized;
  }
  return `${normalized.slice(0, 117)}...`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function buildRequiredTurnObligations(
  structuredTurnThread: boolean,
  activeMessages: Message[],
  expectedMemberIds: string[],
  respondedMemberIds: string[],
  unresolvedDirectMessages: Message[],
  actionableUnreadDeliveryKeys: Set<string>,
  memberNameById: Map<string, string>
): DiscussionTurnObligation[] {
  const obligations: DiscussionTurnObligation[] = [];
  const roundStartMessage = activeMessages[0];
  const participantTrigger: DiscussionTurnObligationTrigger = roundStartMessage && isHostDecisionMessage(roundStartMessage)
    ? "host_decision_follow_through"
    : "participant_obligation";
  if (structuredTurnThread) {
    for (const memberId of expectedMemberIds) {
      if (!roundStartMessage || respondedMemberIds.includes(memberId)) {
        continue;
      }
      const source = actionableUnreadDeliveryKeys.has(deliveryKey(roundStartMessage.id, memberId)) ? "delivery" : "thread_state";
      obligations.push({
        memberId,
        memberName: memberNameById.get(memberId),
        kind: "participant_reply",
        trigger: participantTrigger,
        reason: source === "delivery"
          ? "This member still has an unread discussion delivery in the current round."
          : "This member is still expected to reply in the current round.",
        messageId: roundStartMessage.id,
        source,
        required: true,
        priorityScore: discussionTurnPriorityScore(participantTrigger)
      });
    }
  }
  for (const message of unresolvedDirectMessages) {
    if (!structuredTurnThread && message.taskId) {
      continue;
    }
    const memberId = message.toMemberId;
    if (!memberId) {
      continue;
    }
    const source = actionableUnreadDeliveryKeys.has(deliveryKey(message.id, memberId)) ? "delivery" : "thread_state";
    obligations.push({
      memberId,
      memberName: memberNameById.get(memberId),
      kind: message.fromMemberId ? "follow_up_reply" : "direct_reply",
      trigger: message.fromMemberId ? "unresolved_question_follow_up" : "direct_message",
      reason: message.fromMemberId
        ? "Another teammate is waiting for this member's follow-up reply."
        : "The host is waiting for this member's direct reply.",
      messageId: message.id,
      source,
      required: true,
      priorityScore: discussionTurnPriorityScore(message.fromMemberId ? "unresolved_question_follow_up" : "direct_message")
    });
  }
  return obligations;
}

function buildInvitedTurnObligations(
  activeTeamMembers: Member[],
  memberNameById: Map<string, string>,
  subject: string | undefined,
  activeMessages: Message[],
  currentRoundAnchor: Message | undefined,
  expectedMemberIds: string[],
  respondedMemberIds: string[],
  pendingMemberIds: string[],
  lifecycleState: DiscussionLifecycleState,
  needsHostDecision: boolean,
  unresolvedQuestionCount: number,
  opinionCount: number
): DiscussionTurnObligation[] {
  if (!shouldInviteIntoActiveRound(
    activeMessages,
    pendingMemberIds.length,
    respondedMemberIds.length,
    lifecycleState,
    needsHostDecision,
    unresolvedQuestionCount,
    opinionCount
  )) {
    return [];
  }
  const haystack = invitationHaystack(subject, activeMessages, currentRoundAnchor);
  const anchorMessageId = currentRoundAnchor?.id ?? activeMessages.at(-1)?.id;
  if (!anchorMessageId) {
    return [];
  }
  return activeTeamMembers
    .filter((member) => !expectedMemberIds.includes(member.id))
    .filter((member) => !respondedMemberIds.includes(member.id))
    .filter((member) => callWhenMatches(member.callWhen, haystack))
    .map((member) => ({
      memberId: member.id,
      memberName: memberNameById.get(member.id),
      kind: "invited_opinion" as const,
      trigger: "callWhen_match" as const,
      reason: "This member's callWhen guidance matched the active discussion text.",
      messageId: anchorMessageId,
      source: "callWhen_match" as const,
      required: false,
      priorityScore: discussionTurnPriorityScore("callWhen_match")
    }));
}

function callWhenMatches(callWhen: string[] | undefined, haystack: string): boolean {
  if (!callWhen?.length || !haystack.trim()) {
    return false;
  }
  return callWhen.some((entry) => {
    const normalized = entry.toLowerCase().trim();
    if (!normalized) {
      return false;
    }
    if (haystack.includes(normalized)) {
      return true;
    }
    const tokens = normalized.split(/[^a-z0-9]+/).filter((token) => token.length > 2);
    return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
  });
}

function buildTurnSummary(owedMemberNames: string[], invitedMemberNames: string[]): string | undefined {
  if (owedMemberNames.length > 0 && invitedMemberNames.length > 0) {
    return `Waiting on ${formatMemberList(owedMemberNames)} to reply while inviting ${formatMemberList(invitedMemberNames)} to weigh in.`;
  }
  if (owedMemberNames.length > 0) {
    return `Waiting on ${formatMemberList(owedMemberNames)} to reply in the current round.`;
  }
  if (invitedMemberNames.length > 0) {
    return `Inviting ${formatMemberList(invitedMemberNames)} to weigh in on the current round.`;
  }
  return undefined;
}

function buildParticipationSummary(
  lifecycleState: DiscussionLifecycleState,
  respondedMemberNames: string[],
  owedMemberNames: string[],
  invitedMemberNames: string[]
): string | undefined {
  if (respondedMemberNames.length === 0 && owedMemberNames.length > 0) {
    return `Waiting for ${formatMemberList(owedMemberNames)} to respond.`;
  }
  if (respondedMemberNames.length > 0 && owedMemberNames.length > 0) {
    return `${formatMemberList(respondedMemberNames)} ${hasHave(respondedMemberNames)} responded; ${formatMemberList(owedMemberNames)} ${stillOwes(owedMemberNames)} a reply${invitedMemberNames.length > 0 ? `; ${formatMemberList(invitedMemberNames)} ${isAre(invitedMemberNames)} invited to weigh in.` : "."}`;
  }
  if (respondedMemberNames.length > 0 && invitedMemberNames.length > 0) {
    return `${formatMemberList(respondedMemberNames)} ${hasHave(respondedMemberNames)} responded; ${formatMemberList(invitedMemberNames)} ${isAre(invitedMemberNames)} invited to weigh in.`;
  }
  if (respondedMemberNames.length > 0 && lifecycleState === "settled") {
    return `${formatMemberList(respondedMemberNames)} ${hasHave(respondedMemberNames)} responded; the round is settled.`;
  }
  if (respondedMemberNames.length > 0) {
    return `${formatMemberList(respondedMemberNames)} ${hasHave(respondedMemberNames)} responded in the current round.`;
  }
  if (invitedMemberNames.length > 0) {
    return `Inviting ${formatMemberList(invitedMemberNames)} to weigh in.`;
  }
  return undefined;
}

function shouldInviteIntoActiveRound(
  activeMessages: Message[],
  pendingMemberCount: number,
  respondedMemberCount: number,
  lifecycleState: DiscussionLifecycleState,
  needsHostDecision: boolean,
  unresolvedQuestionCount: number,
  opinionCount: number
): boolean {
  if (needsHostDecision || (lifecycleState !== "collecting" && lifecycleState !== "contested") || activeMessages.length < 2) {
    return false;
  }
  if (respondedMemberCount === 0) {
    return false;
  }
  if (lifecycleState === "collecting" && pendingMemberCount > 1 && unresolvedQuestionCount === 0) {
    return false;
  }
  return unresolvedQuestionCount > 0 || opinionCount > 0;
}

function deliveryKey(messageId: string, memberId: string): string {
  return `${messageId}:${memberId}`;
}

function isStructuredTurnThread(activeMessages: Message[]): boolean {
  const roundStartMessage = activeMessages[0];
  if (!roundStartMessage) {
    return false;
  }
  return activeMessages.length > 1 || !!roundStartMessage.replyToMessageId || !roundStartMessage.toMemberId;
}

function invitationHaystack(
  subject: string | undefined,
  activeMessages: Message[],
  currentRoundAnchor: Message | undefined
): string {
  return [
    subject,
    currentRoundAnchor?.subject,
    currentRoundAnchor?.body,
    ...activeMessages.slice(-2).flatMap((message) => [message.subject, message.body])
  ]
    .filter((value): value is string => !!value)
    .join(" ")
    .toLowerCase();
}

function memberLabels(memberIds: string[], memberNameById: Map<string, string>): string[] {
  return memberIds.map((memberId) => memberNameById.get(memberId) ?? memberId);
}

function formatMemberList(memberNames: string[]): string {
  if (memberNames.length === 0) {
    return "the relevant teammate";
  }
  if (memberNames.length === 1) {
    return memberNames[0]!;
  }
  if (memberNames.length === 2) {
    return `${memberNames[0]} and ${memberNames[1]}`;
  }
  return `${memberNames.slice(0, -1).join(", ")}, and ${memberNames.at(-1)}`;
}

function hasHave(memberNames: string[]): string {
  return memberNames.length === 1 ? "has" : "have";
}

function isAre(memberNames: string[]): string {
  return memberNames.length === 1 ? "is" : "are";
}

function stillOwes(memberNames: string[]): string {
  return memberNames.length === 1 ? "still owes" : "still owe";
}
