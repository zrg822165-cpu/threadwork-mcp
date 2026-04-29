import type { AgentBackend } from "./agentBackend.js";
import type { JsonStore } from "../store/jsonStore.js";
import type { RuntimeControlPlane } from "./controlPlane.js";
import { runtimeControlPlane } from "./controlPlane.js";
import type { DiscussionThreadState } from "./discussionState.js";
import {
  discussionThreadById,
  discussionThreadForMessage,
  discussionThreadForTask,
  discussionThreads,
  isHostTaskCommitMessage
} from "./discussionState.js";
import type { ContinuationAction, HostAttentionIssue, RuntimeExplainability } from "./explainability.js";
import { continuationForHostIssue, explainRuntimeStatus, highestPriorityHostIssue } from "./explainability.js";
import type { RuntimeResults, RuntimeTimeline } from "./timeline.js";
import { runtimeResults, runtimeTimeline } from "./timeline.js";
import type { SchedulerTickResult } from "./scheduler.js";
import type { RuntimeSchedulerRunner, SchedulerRunResult } from "./schedulerRunner.js";
import { RuntimeService } from "./runtimeService.js";
import { TaskService } from "../services/taskService.js";
import { MailboxService } from "../services/mailboxService.js";
import { requireTeamTask } from "../services/guards.js";
import { InvalidStateError, NotFoundError } from "../errors.js";
import type { RuntimeHostSummary } from "./hostRouting.js";
import { runtimeHostSummary } from "./hostRouting.js";
import { openSafetySignalsForTask, recommendedActionForSignal } from "./safety.js";
import type { SafetyReviewDecision, SafetyReviewResult } from "./safetyReview.js";
import { SafetyReviewService } from "./safetyReview.js";
import { reviewDiscussionBody, reviewDiscussionThreadForTask, reviewSubjectForTask, taskReviewNeedsFollowUp, taskReviewSummary } from "./taskReview.js";
import type { AgentSessionRecord, BackgroundProgressState, Message, Task, TaskPriority, Team, TeamBuild, TeamMemberDraft, TeamRuntime } from "../domain/types.js";
import { teamBuildStatus, teamConfirmMember, teamDraftMember, teamFinish, teamRemoveMember, teamStart } from "../builder/teamBuilderService.js";
import { selectTeam, teamBuilds } from "../builder/teamBuildState.js";
import { newId, nowIso } from "../utils/id.js";

export interface TeamWorkInput {
  teamId?: string;
  request?: string;
  team?: {
    teamName?: string;
    description?: string;
    hostName?: string;
    hostModel?: string;
    hostResponsibility?: string;
    hostNotes?: string;
  };
  builder?: {
    draftMember?: {
      name: string;
      agentId?: string;
      model: string;
      rawResponsibility: string;
      polishedPrompt: string;
      permissions?: string[];
      callWhen?: string[];
      doNot?: string[];
    };
    confirmMember?: boolean;
    removeMember?: {
      memberId?: string;
      agentId?: string;
      name?: string;
    };
    finishTeam?: boolean;
  };
  work?: {
    goal?: string;
    taskId?: string;
    pathHints?: string[];
    review?: {
      signalId?: string;
      taskId?: string;
      decision: SafetyReviewDecision;
      note?: string;
      pathHints?: string[];
    };
    preferredMemberId?: string;
    priority?: TaskPriority;
    autoRun?: boolean;
    maxTicks?: number;
    background?: {
      enabled?: boolean;
      timeoutMs?: number;
    };
    includeDetails?: boolean;
    discussion?: {
      subject?: string;
      body?: string;
      taskId?: string;
      participantMemberIds?: string[];
      maxTurns?: number;
      autoRun?: boolean;
      replyToMessageId?: string;
      commitToTask?: {
        title?: string;
        description?: string;
      };
      hostDecision?: {
        decision: string;
        note?: string;
        participantMemberIds?: string[];
      };
    };
  };
  goal?: string;
  taskId?: string;
  pathHints?: string[];
  preferredMemberId?: string;
  priority?: TaskPriority;
  autoRun?: boolean;
  maxTicks?: number;
  background?: {
    enabled?: boolean;
    timeoutMs?: number;
  };
  includeDetails?: boolean;
  teamName?: string;
  description?: string;
  hostName?: string;
  hostModel?: string;
  hostResponsibility?: string;
  hostNotes?: string;
  draftMember?: {
    name: string;
    agentId?: string;
    model: string;
    rawResponsibility: string;
    polishedPrompt: string;
    permissions?: string[];
    callWhen?: string[];
    doNot?: string[];
  };
  confirmMember?: boolean;
  removeMember?: {
    memberId?: string;
    agentId?: string;
    name?: string;
  };
  finishTeam?: boolean;
}

export interface TeamWorkChoice {
  label: string;
  value: string;
  description?: string;
}

export interface TeamWorkView {
  summary: string;
  taskStatus?: string;
  runnableCount: number;
  activeCount: number;
  completedCount: number;
  failedCount: number;
  blockedCount: number;
  unreadMessageCount: number;
  background?: BackgroundProgressState;
}

export interface TeamWorkBuilderGuidance {
  mode: "builder_guidance";
  team: Team;
  build: TeamBuild;
  host: RuntimeHostSummary;
  question: string;
  choices: TeamWorkChoice[];
  nextPrompt: string;
  recommendedInput: Partial<TeamWorkInput>;
  statusSummary: string;
  currentDraft?: TeamMemberDraft;
  members: Array<{ id: string; name: string; agentId?: string; model?: string; rawResponsibility?: string }>;
}

export interface TeamWorkTaskFlow {
  mode: "task_flow";
  task?: Task;
  runtime: TeamRuntime;
  host: RuntimeHostSummary;
  reviewResult?: {
    decision: SafetyReviewDecision;
    signalId?: string;
    taskId?: string;
    resolvedSignalIds: string[];
    nextAction: string;
  };
  discussion?: Message;
  schedulerRun?: SchedulerRunResult;
  view: TeamWorkView;
  explain: RuntimeExplainability;
  nextActions: string[];
  nextPrompt: string;
  recommendedInput: Partial<TeamWorkInput>;
  details?: {
    controlPlane: RuntimeControlPlane;
    results: RuntimeResults;
    timeline: RuntimeTimeline;
  };
}

export type TeamWorkResult = TeamWorkBuilderGuidance | TeamWorkTaskFlow;

interface NormalizedTeamWorkInput {
  teamId?: string;
  request?: string;
  goal?: string;
  taskId?: string;
  pathHints?: string[];
  review?: NonNullable<TeamWorkInput["work"]>["review"];
  preferredMemberId?: string;
  priority?: TaskPriority;
  autoRun?: boolean;
  maxTicks?: number;
  background?: {
    enabled?: boolean;
    timeoutMs?: number;
  };
  includeDetails?: boolean;
  discussion?: NonNullable<NonNullable<TeamWorkInput["work"]>["discussion"]>;
  teamName?: string;
  description?: string;
  hostName?: string;
  hostModel?: string;
  hostResponsibility?: string;
  hostNotes?: string;
  draftMember?: TeamWorkInput["draftMember"];
  confirmMember?: boolean;
  removeMember?: TeamWorkInput["removeMember"];
  finishTeam?: boolean;
}

export type SchedulerRunnerFactory = (backend: AgentBackend) => RuntimeSchedulerRunner;

interface BoundedProgressPolicy {
  needsAttentionReason?: string;
  continueWhenIdle?: boolean;
}

export class TeamWorkService {
  constructor(
    private readonly store: JsonStore,
    private readonly backendFactory: () => AgentBackend,
    private readonly schedulerRunnerFactory: SchedulerRunnerFactory
  ) {}

  async work(input: TeamWorkInput): Promise<TeamWorkResult> {
    const normalized = this.normalizeInput(input);
    const teamId = await this.resolveOrInitializeTeamId(normalized);
    const builder = await this.applyBuilderActions(teamId, normalized);
    if (builder) {
      return builder;
    }

    await this.ensureReadyRuntimeForFinalizedTeam(teamId);

    const taskInput = { ...normalized, teamId } satisfies NormalizedTeamWorkInput & { teamId: string };
    let reviewResult: SafetyReviewResult | undefined;
    if (normalized.review) {
      reviewResult = await this.reviewSafety(teamId, normalized);
    }
    let task: Task | undefined;
    let discussion: Message | undefined;
    const committedDiscussion = await this.commitDiscussionToTask(taskInput);
    if (committedDiscussion) {
      task = committedDiscussion.task;
      discussion = committedDiscussion.message;
      taskInput.discussion = { ...taskInput.discussion!, replyToMessageId: discussion.id };
    } else {
      task = await this.createOrReadTask(taskInput);
      discussion = await this.createDiscussion(taskInput, task);
      if (discussion && taskInput.discussion) {
        taskInput.discussion = { ...taskInput.discussion, replyToMessageId: discussion.id };
      }
    }
    if (reviewResult?.taskId) {
      task = await this.readTask(teamId, reviewResult.taskId);
    }
    let runtime = await this.runtimeStatus(teamId);
    const shouldAutoRun = normalized.review ? false : normalized.discussion?.autoRun ?? normalized.autoRun ?? true;
    const explicitlyRequestedAutoRun = normalized.review ? false : (normalized.discussion?.autoRun ?? normalized.autoRun) === true;

    if (runtime.status === "not_started") {
      return this.builderGuidance(teamId, normalized.request, "Finish team setup inside team_work before starting runtime-managed task work.");
    }
    if (runtime.status === "paused") {
      if (explicitlyRequestedAutoRun) {
        runtime = await this.resumeRuntime(teamId);
      } else {
        return this.taskView(taskInput, task, undefined, reviewResult, discussion);
      }
    }
    if (runtime.status === "error") {
      return this.taskView(taskInput, task, undefined, reviewResult, discussion);
    }

    if (shouldAutoRun && (runtime.status === "ready" || runtime.status === "stopped")) {
      runtime = await this.startRuntime(teamId);
    }

    let schedulerRun: SchedulerRunResult | undefined;
    if (shouldAutoRun && runtime.status === "running") {
      schedulerRun = await this.runBoundedProgress(teamId, normalized, task);
      task = task ? await this.readTask(teamId, task.id) : undefined;
    }

    return this.taskView(taskInput, task, schedulerRun, reviewResult, discussion);
  }

  private normalizeInput(input: TeamWorkInput): NormalizedTeamWorkInput {
    return {
      teamId: input.teamId,
      request: input.request,
      goal: input.work?.goal ?? input.goal,
      taskId: input.work?.review?.taskId ?? input.work?.discussion?.taskId ?? input.work?.taskId ?? input.taskId,
      pathHints: input.work?.pathHints ?? input.pathHints,
      review: input.work?.review,
      preferredMemberId: input.work?.preferredMemberId ?? input.preferredMemberId,
      priority: input.work?.priority ?? input.priority,
      autoRun: input.work?.autoRun ?? input.autoRun,
      maxTicks: input.work?.discussion?.maxTurns ?? input.work?.maxTicks ?? input.maxTicks,
      background: input.work?.background ?? input.background,
      includeDetails: input.work?.includeDetails ?? input.includeDetails,
      discussion: input.work?.discussion,
      teamName: input.team?.teamName ?? input.teamName,
      description: input.team?.description ?? input.description,
      hostName: input.team?.hostName ?? input.hostName,
      hostModel: input.team?.hostModel ?? input.hostModel,
      hostResponsibility: input.team?.hostResponsibility ?? input.hostResponsibility,
      hostNotes: input.team?.hostNotes ?? input.hostNotes,
      draftMember: input.builder?.draftMember ?? input.draftMember,
      confirmMember: input.builder?.confirmMember ?? input.confirmMember,
      removeMember: input.builder?.removeMember ?? input.removeMember,
      finishTeam: input.builder?.finishTeam ?? input.finishTeam
    };
  }

  private async resolveOrInitializeTeamId(input: NormalizedTeamWorkInput): Promise<string> {
    if (input.teamId) {
      return input.teamId;
    }

    const state = await this.store.read();
    try {
      return selectTeam(state).id;
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        throw error;
      }
    }

    const created = await this.store.transaction((state) => teamStart(state, {
      teamName: input.teamName,
      description: input.description,
      hostName: input.hostName,
      hostModel: input.hostModel,
      hostResponsibility: input.hostResponsibility,
      hostNotes: input.hostNotes
    })) as { team: Team };
    return created.team.id;
  }

  private async applyBuilderActions(teamId: string, input: NormalizedTeamWorkInput): Promise<TeamWorkBuilderGuidance | undefined> {
    const state = await this.store.read();
    const build = teamBuilds(state)[teamId];
    const hasBuilderInput = !!input.draftMember || !!input.confirmMember || !!input.removeMember || !!input.finishTeam;
    const wantsTaskFlow = !!input.goal || !!input.taskId || !!input.discussion;

    if (!build) {
      await this.store.transaction((state) => {
        teamStart(state, {
          teamId,
          teamName: input.teamName,
          description: input.description,
          hostName: input.hostName,
          hostModel: input.hostModel,
          hostResponsibility: input.hostResponsibility,
          hostNotes: input.hostNotes
        });
      });
      return this.builderGuidance(teamId, input.request, "A team build has been started inside team_work.");
    }

    if (input.removeMember) {
      await this.store.transaction((state) => {
        teamRemoveMember(state, { teamId, ...input.removeMember });
      });
      return this.builderGuidance(teamId, input.request, "The member was removed. Continue team setup inside team_work.");
    }

    if (input.draftMember) {
      await this.store.transaction((state) => {
        teamDraftMember(state, { teamId, ...input.draftMember });
      });
      return this.builderGuidance(teamId, input.request, "The draft was saved. Review it and confirm when ready.");
    }

    if (input.confirmMember) {
      await this.store.transaction((state) => {
        teamConfirmMember(state, { teamId });
      });
      return this.builderGuidance(teamId, input.request, "The current draft was confirmed. Decide whether to add another member or finish the team.");
    }

    if (input.finishTeam) {
      await this.store.transaction((state) => {
        teamFinish(state, { teamId });
        new RuntimeService(state, this.backendFactory()).markReady({ teamId });
      });
      return undefined;
    }

    if (build.status !== "finalized") {
      if (wantsTaskFlow && !hasBuilderInput) {
        return this.builderGuidance(teamId, input.request ?? input.goal, "The team is not finished yet, so team_work is staying in builder guidance mode.");
      }
      return this.builderGuidance(teamId, input.request, hasBuilderInput ? "Team setup is still in progress." : undefined);
    }

    return undefined;
  }

  private async createOrReadTask(input: NormalizedTeamWorkInput & { teamId: string }): Promise<Task | undefined> {
    if (input.review && input.goal) {
      throw new InvalidStateError("Pass either work.review or goal, not both in the same team_work call.", {
        teamId: input.teamId,
        taskId: input.taskId
      });
    }
    if (input.review && input.discussion?.commitToTask) {
      throw new InvalidStateError("Pass either work.review or discussion.commitToTask, not both in the same team_work call.", {
        teamId: input.teamId,
        taskId: input.taskId
      });
    }
    if (input.goal && input.taskId) {
      throw new InvalidStateError("Pass either goal to create a task or taskId to continue one, not both.", { teamId: input.teamId, taskId: input.taskId });
    }
    if (input.goal && input.discussion?.commitToTask) {
      throw new InvalidStateError("Pass either work.goal or discussion.commitToTask, not both in the same team_work call.", {
        teamId: input.teamId,
        taskId: input.taskId
      });
    }
    if (input.goal) {
      const goal = input.goal;
      return this.store.transaction((state) => new TaskService(state).createTask({
        teamId: input.teamId,
        title: goal,
        description: goal,
        pathHints: input.pathHints,
        preferredMemberId: input.preferredMemberId,
        priority: input.priority
      }));
    }
    if (input.taskId) {
      return this.readTask(input.teamId, input.taskId);
    }
    return undefined;
  }

  private async commitDiscussionToTask(
    input: NormalizedTeamWorkInput & { teamId: string }
  ): Promise<{ task: Task; message: Message } | undefined> {
    const commitToTask = input.discussion?.commitToTask;
    if (!commitToTask) {
      return undefined;
    }
    if (input.discussion?.body || input.discussion?.hostDecision) {
      throw new InvalidStateError("Pass discussion.commitToTask by itself when explicitly turning a settled discussion into task work.", {
        teamId: input.teamId,
        taskId: input.taskId
      });
    }
    return this.store.transaction((state) => {
      const thread = this.relevantDiscussionThread(state, {
        teamId: input.teamId,
        task: undefined,
        discussionInput: input.discussion
      });
      if (!thread) {
        throw new NotFoundError("Could not find the discussion thread to commit into task work.", {
          teamId: input.teamId,
          replyToMessageId: input.discussion?.replyToMessageId,
          subject: input.discussion?.subject
        });
      }
      if (thread.lifecycleState !== "settled") {
        throw new InvalidStateError("Only settled discussion threads can be committed into task work.", {
          teamId: input.teamId,
          threadId: thread.threadId,
          lifecycleState: thread.lifecycleState
        });
      }
      if (thread.actionabilityState !== "ready_for_task" && thread.actionabilityState !== "waiting_host_commit") {
        throw new InvalidStateError("This discussion thread is not ready for an explicit task commit.", {
          teamId: input.teamId,
          threadId: thread.threadId,
          actionabilityState: thread.actionabilityState
        });
      }

      const title = commitToTask.title?.trim() || thread.suggestedTaskTitle || "Describe the next task to run";
      const description = commitToTask.description?.trim() || thread.suggestedTaskDescriptionPreview || title;
      const inheritedDefaults = this.commitTaskDefaults(state, input, thread);
      const task = new TaskService(state).createTask({
        teamId: input.teamId,
        title,
        description,
        pathHints: inheritedDefaults.pathHints,
        preferredMemberId: inheritedDefaults.preferredMemberId,
        priority: inheritedDefaults.priority
      });
      const message = new MailboxService(state).sendMessage({
        teamId: input.teamId,
        taskId: task.id,
        type: "notification",
        subject: thread.subject ?? title,
        body: hostCommitTaskBody(task.title, task.id, description),
        replyToMessageId: input.discussion?.replyToMessageId ?? thread.latestMessage?.id
      });
      return { task, message };
    });
  }

  private async createDiscussion(input: NormalizedTeamWorkInput & { teamId: string }, task: Task | undefined): Promise<Message | undefined> {
    const discussion = input.discussion;
    if (!discussion || discussion.commitToTask) {
      return undefined;
    }
    return this.store.transaction((state) => {
      const mailbox = new MailboxService(state);
      const thread = discussion.replyToMessageId
        ? discussionThreadForMessage(state, input.teamId, discussion.replyToMessageId)
        : undefined;
      const participantMemberIds = discussion.hostDecision?.participantMemberIds
        ?? discussion.participantMemberIds
        ?? thread?.pendingMemberIds
        ?? thread?.expectedMemberIds;

      if (discussion.hostDecision) {
        return mailbox.sendMessage({
          teamId: input.teamId,
          taskId: discussion.taskId ?? task?.id ?? thread?.taskId,
          type: "notification",
          subject: discussion.subject ?? thread?.subject ?? "Host decision",
          body: hostDecisionBody(discussion.hostDecision.decision, discussion.hostDecision.note),
          replyToMessageId: discussion.replyToMessageId ?? thread?.latestMessage?.id,
          participantMemberIds
        });
      }

      if (!discussion.body) {
        throw new InvalidStateError("Pass discussion.body or discussion.hostDecision when continuing a discussion.", {
          teamId: input.teamId,
          taskId: input.taskId
        });
      }

      return mailbox.sendMessage({
        teamId: input.teamId,
        taskId: discussion.taskId ?? task?.id,
        type: "question",
        subject: discussion.subject ?? thread?.subject ?? "Team discussion",
        body: discussion.body,
        replyToMessageId: discussion.replyToMessageId,
        participantMemberIds
      });
    });
  }

  private async reviewSafety(
    teamId: string,
    input: NormalizedTeamWorkInput
  ): Promise<SafetyReviewResult> {
    return this.store.transaction((state) => new SafetyReviewService(state).review({
      teamId,
      taskId: input.review?.taskId ?? input.taskId,
      signalId: input.review?.signalId,
      decision: input.review!.decision,
      note: input.review?.note,
      pathHints: input.review?.pathHints
    }));
  }

  private async readTask(teamId: string, taskId: string): Promise<Task> {
    const state = await this.store.read();
    return requireTeamTask(state, teamId, taskId);
  }

  private async runtimeStatus(teamId: string): Promise<TeamRuntime> {
    const state = await this.store.read();
    return new RuntimeService(state, this.backendFactory()).status(teamId).runtime;
  }

  private async startRuntime(teamId: string): Promise<TeamRuntime> {
    const backend = this.backendFactory();
    const started = await this.store.transaction((state) => new RuntimeService(state, backend).start({ teamId }));
    return started.runtime;
  }

  private async resumeRuntime(teamId: string): Promise<TeamRuntime> {
    const resumed = await this.store.transaction((state) => new RuntimeService(state, this.backendFactory()).resume({ teamId }));
    return resumed.runtime;
  }

  private async ensureReadyRuntimeForFinalizedTeam(teamId: string): Promise<void> {
    await this.store.transaction((state) => {
      const build = teamBuilds(state)[teamId];
      if (!build || build.status !== "finalized" || state.teamRuntimes[teamId]) {
        return;
      }
      new RuntimeService(state, this.backendFactory()).markReady({ teamId });
    });
  }

  private async runBoundedProgress(teamId: string, input: NormalizedTeamWorkInput, task: Task | undefined): Promise<SchedulerRunResult> {
    const maxTicks = input.maxTicks ?? 3;
    const timeoutMs = input.background?.timeoutMs;
    const runId = input.background?.enabled ? await this.beginBackgroundRun(teamId, maxTicks, timeoutMs) : undefined;
    const preRunPolicy = await this.boundedProgressPolicy(teamId, task, input.discussion);
    if (preRunPolicy.needsAttentionReason) {
      const schedulerRun: SchedulerRunResult = {
        ticksRun: 0,
        totalAssignments: 0,
        stoppedReason: "needs_attention",
        decisions: [],
        needsAttentionReason: preRunPolicy.needsAttentionReason
      };
      if (runId) {
        await this.completeBackgroundRun(teamId, runId, schedulerRun);
      }
      return schedulerRun;
    }
    const schedulerRun = await this.schedulerRunnerFactory(this.backendFactory()).run({
      teamId,
      maxTicks,
      timeoutMs,
      rethrowOnError: false,
      shouldStopForAttention: async (decisions) => (await this.boundedProgressPolicy(teamId, task, input.discussion, decisions)).needsAttentionReason,
      shouldContinueWhenIdle: async (decisions) => (await this.boundedProgressPolicy(teamId, task, input.discussion, decisions)).continueWhenIdle ?? false
    });
    if (runId) {
      await this.completeBackgroundRun(teamId, runId, schedulerRun);
    }
    return schedulerRun;
  }

  private async beginBackgroundRun(teamId: string, requestedMaxTicks: number, timeoutMs: number | undefined): Promise<string> {
    const runId = newId("run");
    await this.store.transaction((state) => {
      const now = nowIso();
      state.schedulerStates[teamId] = {
        ...(state.schedulerStates[teamId] ?? { teamId, paused: false }),
        teamId,
        background: {
          runId,
          status: "active",
          startedAt: now,
          updatedAt: now,
          requestedMaxTicks,
          timeoutMs,
          ticksRun: 0,
          totalAssignments: 0
        },
        updatedAt: now
      };
    });
    return runId;
  }

  private async completeBackgroundRun(teamId: string, runId: string, schedulerRun: SchedulerRunResult): Promise<void> {
    await this.store.transaction((state) => {
      const schedulerState = state.schedulerStates[teamId];
      if (!schedulerState?.background || schedulerState.background.runId !== runId) {
        return;
      }

      const now = nowIso();
      schedulerState.background = {
        ...schedulerState.background,
        status: backgroundStatus(schedulerRun),
        updatedAt: now,
        completedAt: now,
        ticksRun: schedulerRun.ticksRun,
        totalAssignments: schedulerRun.totalAssignments,
        stoppedReason: schedulerRun.stoppedReason,
        lastDecision: schedulerRun.decisions.at(-1)?.decision,
        lastErrorMessage: schedulerRun.error?.message,
        needsAttentionReason: schedulerRun.needsAttentionReason
      };
      schedulerState.updatedAt = now;
    });
  }

  private async boundedProgressPolicy(
    teamId: string,
    task: Task | undefined,
    discussionInput: NormalizedTeamWorkInput["discussion"],
    decisions: SchedulerTickResult[] = []
  ): Promise<BoundedProgressPolicy> {
    const state = await this.store.read();
    const runtime = state.teamRuntimes[teamId];
    const team = state.teams[teamId];
    const sessions = Object.values(state.agentSessions).filter((session) => session.teamId === teamId);
    const controlPlane = runtimeControlPlane(state, teamId, sessions);
    const discussionThread = this.relevantDiscussionThread(state, {
      teamId,
      task,
      discussionInput
    });
    if (runtime?.status === "paused" || state.schedulerStates[teamId]?.paused) {
      return { needsAttentionReason: "Runtime is paused." };
    }
    if (runtime?.status === "error") {
      return { needsAttentionReason: "Runtime is in error state." };
    }
    const failedTask = task && state.tasks[task.id]?.status === "failed" ? state.tasks[task.id] : undefined;
    if (failedTask) {
      return { needsAttentionReason: `Task ${failedTask.id} failed${failedTask.failureSummary ? `: ${failedTask.failureSummary}` : ""}.` };
    }
    const safetySignal = task
      ? openSafetySignalsForTask(state, task.id, ["needs_review", "blocked"])[0]
      : undefined;
    if (safetySignal) {
      return { needsAttentionReason: safetySignal.summary };
    }
    const errorSession = task
      ? Object.values(state.agentSessions).find((session) => session.teamId === teamId && session.currentTaskId === task.id && (session.status === "error" || session.status === "stopped"))
      : undefined;
    if (errorSession) {
      return { needsAttentionReason: `Session ${errorSession.id} is ${errorSession.status}.` };
    }
    if (discussionThread?.proposedNextAction.kind === "host_decision") {
      return {
        needsAttentionReason: discussionThread.subject
          ? `Discussion "${discussionThread.subject}": ${controlPlane.inbox.discussionHostAttentionSummary ?? discussionThread.currentRoundSummary}`
          : (controlPlane.inbox.discussionHostAttentionSummary ?? discussionThread.currentRoundSummary)
      };
    }
    const unreadMessage = task
      ? this.unreadTaskMessages(state, task.id).find((message) => messageNeedsHostAttention(message, team?.leadMemberId))
      : undefined;
    if (unreadMessage) {
      return { needsAttentionReason: unreadMessage.subject ?? unreadMessage.body };
    }
    if (
      discussionThread
      && (discussionThread.turnTakingState === "waiting_required"
        || discussionThread.turnTakingState === "waiting_follow_up")
      && decisions.some((decision) => decision.assignments.some((assignment) => !!assignment.messageId))
    ) {
      return { continueWhenIdle: true };
    }
    return {};
  }

  private async taskView(
    input: NormalizedTeamWorkInput & { teamId: string },
    task: Task | undefined,
    schedulerRun: SchedulerRunResult | undefined,
    reviewResult: SafetyReviewResult | undefined,
    discussion: Message | undefined
  ): Promise<TeamWorkTaskFlow> {
    const state = await this.store.read();
    const runtimeView = new RuntimeService(state, this.backendFactory()).status(input.teamId);
    const controlPlane = runtimeControlPlane(state, input.teamId, runtimeView.sessions);
    const results = runtimeResults(state, input.teamId, 10);
    const timeline = runtimeTimeline(state, input.teamId, 10);
    const discussionThread = this.relevantDiscussionThread(state, {
      teamId: input.teamId,
      task,
      discussionInput: input.discussion,
      discussionMessage: discussion
    });
    const nextActions = this.nextActions(state, task, runtimeView.runtime, controlPlane, reviewResult, discussionThread);
    const build = teamBuilds(state)[input.teamId];
    const explain = this.taskExplainability(state, build, runtimeView.runtime, controlPlane, task, nextActions, discussionThread);
    const background = state.schedulerStates[input.teamId]?.background;

    return {
      mode: "task_flow",
      task,
      runtime: runtimeView.runtime,
      host: controlPlane.host,
      reviewResult: reviewResult ? {
        decision: reviewResult.decision,
        signalId: reviewResult.signalId,
        taskId: reviewResult.taskId,
        resolvedSignalIds: reviewResult.resolvedSignalIds,
        nextAction: nextActions[0] ?? explain.recommendedNextAction
      } : undefined,
      discussion,
      schedulerRun,
      view: {
        summary: this.summary(task, runtimeView.runtime, schedulerRun, controlPlane, nextActions, discussionThread),
        taskStatus: task?.status,
        runnableCount: controlPlane.taskBuckets.runnable.length,
        activeCount: controlPlane.activeWork.length,
        completedCount: controlPlane.taskBuckets.completed.length,
        failedCount: controlPlane.taskBuckets.failed.length,
        blockedCount: controlPlane.taskBuckets.blockedByDependency.length,
        unreadMessageCount: Object.values(controlPlane.inbox.unreadByMember).reduce((total, count) => total + count, 0),
        background
      },
      explain,
      nextActions,
      nextPrompt: this.taskNextPrompt(task, discussionThread, nextActions),
      recommendedInput: this.taskRecommendedInput(input, task, runtimeView.runtime, state, controlPlane, reviewResult, discussionThread),
      details: input.includeDetails ? { controlPlane, results, timeline } : undefined
    };
  }

  private async builderGuidance(teamId: string, request: string | undefined, prefix?: string): Promise<TeamWorkBuilderGuidance> {
    const state = await this.store.read();
    const status = teamBuildStatus(state, teamId) as {
      team: Team;
      status: TeamBuild["status"];
      currentDraft?: TeamMemberDraft;
      members: Array<{ id: string; name: string; agentId?: string; model?: string; rawResponsibility?: string }>;
    };
    const build = teamBuilds(state)[teamId]!;
    const question = this.builderQuestion(status, request);
    const choices = this.builderChoices(status);
    const nextPrompt = this.builderNextPrompt(status, question, choices);
    const recommendedInput = this.builderRecommendedInput(status, request);
    const statusSummary = this.builderStatusSummary(status, prefix);

    return {
      mode: "builder_guidance",
      team: status.team,
      build,
      host: runtimeHostSummary(state, teamId),
      question,
      choices,
      nextPrompt,
      recommendedInput,
      statusSummary,
      currentDraft: status.currentDraft,
      members: status.members
    };
  }

  private builderQuestion(
    status: { team: Team; currentDraft?: TeamMemberDraft; members: Array<{ id: string; name: string }> },
    request: string | undefined
  ): string {
    if (status.currentDraft) {
      return `Review the draft for ${status.currentDraft.name}. Confirm it or revise it.`;
    }
    if (status.members.length === 0) {
      return request
        ? `Draft the first teammate for: ${request}. Fill in the name, model, and role you want.`
        : "Draft the first teammate. Fill in the name, model, and role you want.";
    }
    return `Add another teammate or finish the team.`;
  }

  private builderChoices(status: { currentDraft?: TeamMemberDraft; members: Array<{ id: string; name: string }> }): TeamWorkChoice[] {
    if (status.currentDraft) {
      return [
        { label: "Confirm member", value: "confirmMember", description: "Create the current draft as a real team member." },
        { label: "Revise draft", value: "draftMember", description: "Submit an updated draftMember payload for this teammate." }
      ];
    }
    if (status.members.length === 0) {
      return [
        { label: "Draft first member", value: "draftMember", description: "Provide one teammate draft inside team_work." }
      ];
    }
    return [
      { label: "Add member", value: "draftMember", description: "Provide another teammate draft inside team_work." },
      { label: "Finish team", value: "finishTeam", description: "Mark the team ready and continue into task work." }
    ];
  }

  private builderNextPrompt(
    status: { team: Team; currentDraft?: TeamMemberDraft; members: Array<{ id: string; name: string }> },
    question: string,
    _choices: TeamWorkChoice[]
  ): string {
    return `Continue team_work for team ${status.team.id}. ${question}`;
  }

  private builderRecommendedInput(
    status: { team: Team; currentDraft?: TeamMemberDraft; members: Array<{ id: string; name: string }> },
    request: string | undefined
  ): Partial<TeamWorkInput> {
    if (status.currentDraft) {
      return {
        teamId: status.team.id,
        builder: {
          confirmMember: true
        }
      };
    }

    if (status.members.length === 0) {
      const placeholder = this.memberDraftPlaceholder(request);
      return {
        teamId: status.team.id,
        builder: {
          draftMember: {
            name: placeholder.name,
            model: "your/model",
            rawResponsibility: placeholder.rawResponsibility,
            polishedPrompt: placeholder.polishedPrompt
          }
        }
      };
    }

    return {
      teamId: status.team.id,
      builder: {
        finishTeam: true
      }
    };
  }

  private placeholderMemberName(request: string | undefined): string {
    return this.memberDraftPlaceholder(request).name;
  }

  private memberDraftPlaceholder(request: string | undefined): {
    name: string;
    rawResponsibility: string;
    polishedPrompt: string;
  } {
    const normalized = request?.toLowerCase();
    if (!normalized) {
      return {
        name: "Your Teammate Name",
        rawResponsibility: "Describe this teammate's responsibility.",
        polishedPrompt: "Write the prompt you want this teammate to follow."
      };
    }

    const placeholders: Array<{
      pattern: RegExp;
      value: { name: string; rawResponsibility: string; polishedPrompt: string };
    }> = [
      {
        pattern: /\breview(?:er)?\b/,
        value: {
          name: "Your Reviewer Name",
          rawResponsibility: "Describe how you want this teammate to review changes.",
          polishedPrompt: "Write the review prompt you want this teammate to follow."
        }
      },
      {
        pattern: /\btest(?:er|ing)?\b|\bqa\b/,
        value: {
          name: "Your Tester Name",
          rawResponsibility: "Describe what you want this teammate to test.",
          polishedPrompt: "Write the testing prompt you want this teammate to follow."
        }
      },
      {
        pattern: /\bdoc(?:s|umentation)?\b|\bwriter\b/,
        value: {
          name: "Your Writer Name",
          rawResponsibility: "Describe what you want this teammate to write or document.",
          polishedPrompt: "Write the documentation prompt you want this teammate to follow."
        }
      },
      {
        pattern: /\bresearch(?:er)?\b/,
        value: {
          name: "Your Researcher Name",
          rawResponsibility: "Describe what you want this teammate to research.",
          polishedPrompt: "Write the research prompt you want this teammate to follow."
        }
      },
      {
        pattern: /\bplan(?:ner|ning)?\b/,
        value: {
          name: "Your Planner Name",
          rawResponsibility: "Describe what you want this teammate to plan.",
          polishedPrompt: "Write the planning prompt you want this teammate to follow."
        }
      },
      {
        pattern: /\bbuild(?:er)?\b|\bimplement(?:er|ation)?\b|\bpatch\b/,
        value: {
          name: "Your Builder Name",
          rawResponsibility: "Describe what you want this teammate to build or implement.",
          polishedPrompt: "Write the implementation prompt you want this teammate to follow."
        }
      }
    ];

    return placeholders.find(({ pattern }) => pattern.test(normalized))?.value ?? {
      name: "Your Teammate Name",
      rawResponsibility: "Describe this teammate's responsibility.",
      polishedPrompt: "Write the prompt you want this teammate to follow."
    };
  }

  private builderStatusSummary(
    status: { team: Team; status: TeamBuild["status"]; currentDraft?: TeamMemberDraft; members: Array<{ id: string; name: string }> },
    prefix: string | undefined
  ): string {
    const base = `Team ${status.team.id} is ${status.status} with ${status.members.length} confirmed member${status.members.length === 1 ? "" : "s"}${status.currentDraft ? ` and a pending draft for ${status.currentDraft.name}` : ""}.`;
    return prefix ? `${prefix} ${base}` : base;
  }

  private summary(
    task: Task | undefined,
    runtime: TeamRuntime,
    schedulerRun: SchedulerRunResult | undefined,
    controlPlane: RuntimeControlPlane,
    nextActions: string[],
    discussionThread?: DiscussionThreadState
  ): string {
    if (task && discussionThread && this.discussionAlreadyCommittedToTask(discussionThread, task)) {
      const guidance = nextActions[0] ? ` Next: ${nextActions[0]}` : "";
      return `Task ${task.id} was created from the settled discussion; runtime is ${runtime.status}; scheduler assignments: ${schedulerRun?.totalAssignments ?? 0}.${guidance}`;
    }
    if (!task && discussionThread) {
      if (discussionThread.committedTaskId) {
        const guidance = nextActions[0] ? ` Next: ${nextActions[0]}` : "";
        return `Discussion ${discussionThread.threadId} was committed to task ${discussionThread.committedTaskId}; runtime is ${runtime.status}; scheduler assignments: ${schedulerRun?.totalAssignments ?? 0}.${guidance}`;
      }
      const label = discussionThread.subject ? `Discussion "${discussionThread.subject}"` : `Discussion ${discussionThread.threadId}`;
      const guidance = nextActions[0] ? ` Next: ${nextActions[0]}` : "";
      const synthesizedProgress = controlPlane.inbox.discussionProgressSummary ?? discussionThread.synthesis.summary;
      const progress = synthesizedProgress === discussionThread.currentRoundSummary
        ? synthesizedProgress
        : `${synthesizedProgress} ${discussionThread.currentRoundSummary}`;
      const attention = controlPlane.inbox.discussionHostAttentionSummary ? ` Attention: ${controlPlane.inbox.discussionHostAttentionSummary}` : "";
      return `${label} is ${discussionThread.lifecycleState}; ${progress}; scheduler assignments: ${schedulerRun?.totalAssignments ?? 0}.${attention}${guidance}`;
    }
    if (task) {
      const guidance = nextActions[0] ? ` Next: ${nextActions[0]}` : "";
      return `Task ${task.id} is ${task.status}; runtime is ${runtime.status}; scheduler assignments: ${schedulerRun?.totalAssignments ?? 0}.${guidance}`;
    }
    return `Runtime is ${runtime.status}; runnable tasks: ${controlPlane.taskBuckets.runnable.length}; active tasks: ${controlPlane.activeWork.length}.`;
  }

  private taskNextPrompt(task: Task | undefined, discussionThread: DiscussionThreadState | undefined, nextActions: string[]): string {
    if (!task && discussionThread) {
      if (discussionThread.committedTaskId) {
        return `Continue team_work for task ${discussionThread.committedTaskId}. ${nextActions[0] ?? "No action needed."}`;
      }
      if (discussionThread.actionabilityState === "ready_for_task" || discussionThread.actionabilityState === "waiting_host_commit") {
        const label = discussionThread.suggestedTaskTitle ?? discussionThread.subject ?? discussionThread.threadId;
        return `Continue team_work to commit "${label}" into the next task. ${nextActions[0] ?? "No action needed."}`;
      }
      const target = discussionThread.subject
        ? `discussion "${discussionThread.subject}"`
        : `discussion thread ${discussionThread.threadId}`;
      return `Continue team_work for ${target}. ${nextActions[0] ?? "No action needed."}`;
    }
    const target = task?.status === "claimed"
      ? `claimed task ${task.id}`
      : task
        ? `task ${task.id}`
        : "the current team work";
    return `Continue team_work for ${target}. ${nextActions[0] ?? "No action needed."}`;
  }

  private taskRecommendedInput(
    input: NormalizedTeamWorkInput & { teamId: string },
    task: Task | undefined,
    runtime: TeamRuntime,
    state: Awaited<ReturnType<JsonStore["read"]>>,
    controlPlane: RuntimeControlPlane,
    reviewResult: SafetyReviewResult | undefined,
    discussionThread: DiscussionThreadState | undefined
  ): Partial<TeamWorkInput> {
    const work: NonNullable<TeamWorkInput["work"]> = {};
    const continuation = this.taskContinuation(state, task, runtime, controlPlane, input.goal, discussionThread);
    const reviewSummary = task ? taskReviewSummary(state, task) : undefined;
    const discussionIsTaskReview = !!discussionThread
      && !!reviewSummary?.reviewThreadId
      && reviewSummary.reviewThreadId === discussionThread.threadId;
    const reviewNeedsFollowUp = !!task && discussionIsTaskReview && taskReviewNeedsFollowUp(state, task);
    const reviewSettledWithoutFollowUp = discussionIsTaskReview
      && reviewSummary?.reviewState === "review_settled"
      && !reviewNeedsFollowUp;
    const discussionNeedsExplicitCommit = !!discussionThread
      && (!task || discussionIsTaskReview)
      && !input.goal
      && (discussionThread.actionabilityState === "ready_for_task" || discussionThread.actionabilityState === "waiting_host_commit")
      && (!discussionIsTaskReview || reviewNeedsFollowUp);
    const discussionNeedsHostDecision = discussionThread?.proposedNextAction.kind === "host_decision";
    const committedTaskId = discussionThread?.committedTaskId;
    const discussionAlreadyCommitted = !!discussionThread && (!!committedTaskId || (!!task && this.discussionAlreadyCommittedToTask(discussionThread, task)));

    if (!input.discussion && !discussionThread && task && reviewSummary?.reviewState === "review_recommended") {
      work.discussion = {
        subject: reviewSubjectForTask(task),
        body: reviewDiscussionBody(task, reviewSummary),
        taskId: task.id,
        participantMemberIds: reviewSummary.reviewerMemberIds,
        maxTurns: input.maxTicks,
        autoRun: true
      };
    } else if (discussionNeedsExplicitCommit && discussionThread) {
      work.discussion = {
        subject: discussionThread.subject ?? input.discussion?.subject ?? "Team discussion",
        autoRun: false,
        replyToMessageId: discussionThread.latestMessage?.id ?? input.discussion?.replyToMessageId,
        commitToTask: {
          title: discussionThread.suggestedTaskTitle ?? "Describe the next task to run",
          description: discussionThread.suggestedTaskDescriptionPreview
        }
      };
    } else if ((input.discussion || discussionThread) && !discussionAlreadyCommitted && !reviewSettledWithoutFollowUp) {
      const discussionActionKind = discussionThread?.proposedNextAction.kind;
      work.discussion = {
        subject: discussionThread?.subject ?? input.discussion?.subject ?? "Team discussion",
        body: discussionActionKind === "host_decision"
          ? "Share the host decision and continue this team discussion."
          : discussionActionKind === "summarize_conclusion"
              ? "Continue this team discussion and share the conclusion."
              : "Continue this team discussion.",
        taskId: discussionThread?.taskId ?? input.discussion?.taskId ?? task?.id,
        participantMemberIds: input.discussion?.participantMemberIds ?? discussionThread?.expectedMemberIds,
        maxTurns: input.discussion?.maxTurns ?? input.maxTicks,
        autoRun: discussionNeedsHostDecision ? false : (input.discussion?.autoRun ?? input.autoRun ?? true),
        replyToMessageId: discussionThread?.latestMessage?.id ?? input.discussion?.replyToMessageId,
        hostDecision: discussionActionKind === "host_decision" ? {
          decision: "State the host decision here.",
          note: "Optionally explain the reasoning or next step."
        } : undefined
      };
    }

    if (!work.discussion && ((!input.discussion && !discussionThread) || task || input.goal || discussionAlreadyCommitted)) {
      switch (continuation?.kind) {
        case "create_followup_task":
          work.goal = task ? this.followUpGoal(task) : (input.goal ?? "Describe the follow-up task to run next");
          if (task?.pathHints.length) {
            work.pathHints = task.pathHints;
          }
          if (task?.preferredMemberId) {
            work.preferredMemberId = task.preferredMemberId;
          }
          break;
        case "review_before_continue":
        case "recover_session_then_retry":
        case "resume_same_task":
        default:
          if (continuation?.taskId) {
            work.taskId = continuation.taskId;
          } else if (committedTaskId) {
            work.taskId = committedTaskId;
          } else if (task) {
            work.taskId = task.id;
          } else if (input.goal) {
            work.goal = input.goal;
          } else {
            work.goal = "Describe the next task to run";
          }
          break;
      }
    }
    if (work.discussion
      && task
      && !discussionIsTaskReview
      && reviewSummary?.reviewState !== "review_recommended"
      && !discussionNeedsExplicitCommit
      && !discussionAlreadyCommitted
      && !reviewSettledWithoutFollowUp
      && !work.taskId) {
      work.taskId = task.id;
    }

    if (input.includeDetails) {
      work.includeDetails = true;
    }

    const reviewTemplate = task ? this.reviewTemplate(state, task) : undefined;
    if (reviewTemplate && !work.discussion) {
      work.review = reviewTemplate;
    }

    if (discussionAlreadyCommitted) {
      work.autoRun = false;
    } else if (continuation?.kind === "create_followup_task" || (!work.discussion && continuation?.kind === "review_before_continue")) {
      work.autoRun = false;
    } else if (discussionNeedsExplicitCommit || discussionNeedsHostDecision) {
      work.autoRun = false;
    } else if (this.shouldRecommendManualFollowUp(state, task, runtime, controlPlane, discussionThread)) {
      work.autoRun = false;
    } else if (runtime.status === "ready" || runtime.status === "running" || runtime.status === "stopped") {
      work.autoRun = input.discussion?.autoRun ?? input.autoRun ?? true;
    }

    if (reviewResult?.forceAutoRunFalse) {
      work.autoRun = false;
    }

    return {
      teamId: input.teamId,
      work
    };
  }

  private discussionAlreadyCommittedToTask(
    discussionThread: DiscussionThreadState,
    task: Task
  ): boolean {
    return discussionThread.committedTaskId === task.id
      || (discussionThread.taskId === task.id
        && !!discussionThread.latestMessage
        && isHostTaskCommitMessage(discussionThread.latestMessage));
  }

  private taskExplainability(
    state: Awaited<ReturnType<JsonStore["read"]>>,
    build: TeamBuild | undefined,
    runtime: TeamRuntime,
    controlPlane: RuntimeControlPlane,
    task: Task | undefined,
    nextActions: string[],
    discussionThread: DiscussionThreadState | undefined
  ): RuntimeExplainability {
    const base = explainRuntimeStatus(state, build, runtime, controlPlane);
    const inspectedTask = task;
    const taskIssue = this.taskAttentionIssue(state, inspectedTask, discussionThread);
    const continuation = this.taskContinuation(state, inspectedTask, runtime, controlPlane, undefined, discussionThread);

    if (!inspectedTask && discussionThread?.committedTaskId) {
      return {
        ...base,
        headline: `Discussion ${discussionThread.threadId} already produced follow-up task ${discussionThread.committedTaskId}.`,
        recommendedNextAction: nextActions[0] ?? `Continue with team_work on task ${discussionThread.committedTaskId}.`,
        continuation: continuation ?? base.continuation
      };
    }

    if (inspectedTask && taskIssue && (runtime.status === "ready" || base.phase === "attention")) {
      return {
        ...base,
        phase: "attention",
        headline: taskIssue.headline,
        blockingReason: taskIssue.blockingReason,
        recommendedNextAction: nextActions[0] ?? base.recommendedNextAction,
        recoveryHint: taskIssue.recoveryHint,
        continuation
      };
    }

    return {
      ...base,
      recommendedNextAction: nextActions[0] ?? base.recommendedNextAction,
      continuation: continuation ?? base.continuation
    };
  }

  private shouldRecommendManualFollowUp(
    state: Awaited<ReturnType<JsonStore["read"]>>,
    task: Task | undefined,
    runtime: TeamRuntime,
    controlPlane: RuntimeControlPlane,
    discussionThread: DiscussionThreadState | undefined
  ): boolean {
    if (runtime.status === "paused" || runtime.status === "error") {
      return true;
    }

    if (discussionThread?.proposedNextAction.kind === "host_decision") {
      return true;
    }

    if (!task) {
      return false;
    }

    const claimedSession = task.status === "claimed"
      ? this.sessionForTask(controlPlane, task.id)
      : undefined;
    const brokenClaimedSession = task.status === "claimed"
      ? this.brokenTaskSession(state, task.teamId, task.id)
      : undefined;
    const safetySignals = openSafetySignalsForTask(state, task.id);
    const blockingDependencies = task.dependencyTaskIds
      .map((dependencyTaskId) => state.tasks[dependencyTaskId])
      .filter((dependency): dependency is Task => Boolean(dependency) && dependency.status !== "completed");

    return task.status === "failed"
      || safetySignals.some((signal) => signal.level === "needs_review" || signal.level === "blocked")
      || blockingDependencies.length > 0
      || this.unreadTaskMessages(state, task.id).length > 0
      || claimedSession?.status === "error"
      || claimedSession?.status === "stopped"
      || brokenClaimedSession?.status === "error"
      || brokenClaimedSession?.status === "stopped";
  }

  private nextActions(
    state: Awaited<ReturnType<JsonStore["read"]>>,
    task: Task | undefined,
    runtime: TeamRuntime,
    controlPlane: RuntimeControlPlane,
    reviewResult: SafetyReviewResult | undefined,
    discussionThread: DiscussionThreadState | undefined
  ): string[] {
    const actions: string[] = [];

    if (reviewResult?.postReviewAction) {
      actions.push(reviewResult.postReviewAction);
    }

    if (runtime.status === "paused") {
      actions.push("Resume the paused runtime manually when the team should continue scheduling work.");
    }
    if (runtime.status === "error") {
      actions.push("Inspect error sessions and recover or replace blocked work before continuing.");
    }

    const discussionAlreadyCommitted = !!discussionThread && !!task && this.discussionAlreadyCommittedToTask(discussionThread, task);
    const taskReview = task ? taskReviewSummary(state, task) : undefined;
    const discussionIsTaskReview = !!discussionThread && taskReview?.reviewThreadId === discussionThread.threadId;

    if (!discussionIsTaskReview && !discussionAlreadyCommitted && discussionThread?.proposedNextAction.kind === "host_decision") {
      actions.push("Review the active discussion thread and decide how the team should proceed.");
    } else if (!discussionIsTaskReview && !discussionAlreadyCommitted && (discussionThread?.proposedNextAction.kind === "wait_for_members" || discussionThread?.proposedNextAction.kind === "prompt_member")) {
      actions.push(runtime.status === "running"
        ? "Continue with team_work to advance active discussion turns and collect pending member responses."
        : "Continue with team_work to start runtime-managed teammate sessions and collect pending member responses.");
    } else if (!discussionIsTaskReview && !discussionAlreadyCommitted && discussionThread?.proposedNextAction.kind === "continue_discussion") {
      actions.push("Continue with team_work so the team can resolve the remaining discussion question.");
    } else if (!discussionIsTaskReview && !discussionAlreadyCommitted && discussionThread?.actionabilityState === "ready_for_task") {
      actions.push("Use team_work to commit the settled discussion into the next task.");
    } else if (!discussionIsTaskReview && !discussionAlreadyCommitted && discussionThread?.actionabilityState === "waiting_host_commit") {
      actions.push("Use team_work to commit the settled discussion into follow-up work, or continue the thread if more alignment is needed.");
    }
    if (!task && discussionThread?.committedTaskId) {
      actions.push(`Continue with team_work on the follow-up task ${discussionThread.committedTaskId} created from this discussion.`);
    }

    if (task) {
      const claimedSession = task.status === "claimed" ? this.sessionForTask(controlPlane, task.id) : undefined;
      const brokenClaimedSession = task.status === "claimed" ? this.brokenTaskSession(state, task.teamId, task.id) : undefined;
      const unreadTaskMessages = this.unreadTaskMessages(state, task.id);
      const safetySignals = openSafetySignalsForTask(state, task.id);
      const reviewSummary = taskReview!;
      const blockingDependencies = task.dependencyTaskIds
        .map((dependencyTaskId) => state.tasks[dependencyTaskId])
        .filter((dependency): dependency is Task => Boolean(dependency) && dependency.status !== "completed");
      const taskIssue = this.taskAttentionIssue(state, task, discussionThread);

      if (taskIssue && taskIssue.kind !== "warning_safety") {
        actions.push(taskIssue.recommendedNextAction);
      }

      if (task.status === "failed") {
        if (taskIssue?.kind !== "failed_task") {
          actions.push(`Task ${task.id} failed${task.failureSummary ? `: ${task.failureSummary}` : ""}. Inspect the failure before retrying or creating follow-up work.`);
        }
        if (task.assignedMemberId && this.hasRecoverableSession(state, task.teamId, task.assignedMemberId)) {
          actions.push(`The failed task belonged to ${task.assignedMemberId}; inspect that session before retrying or reassigning follow-up work.`);
        }
      }

      if (task.status === "completed") {
        if (reviewSummary.reviewState === "review_recommended") {
          actions.push(reviewSummary.reviewActionSummary ?? `Ask reviewers to review completed task ${task.id}.`);
        } else if (reviewSummary.reviewState === "review_open" && reviewSummary.reviewThreadId) {
          actions.push(`Continue task review discussion ${reviewSummary.reviewThreadId} before treating task ${task.id} as fully reviewed.`);
        } else if (reviewSummary.reviewState === "review_settled" && reviewSummary.reviewThreadId) {
          actions.push(taskReviewNeedsFollowUp(state, task)
            ? `Review discussion ${reviewSummary.reviewThreadId} is settled; commit follow-up task work if needed.`
            : `Review discussion ${reviewSummary.reviewThreadId} is settled with no follow-up task recommendation.`);
        } else if (reviewSummary.reviewState === "follow_up_created" && reviewSummary.followUpTaskId) {
          actions.push(`Continue follow-up task ${reviewSummary.followUpTaskId} created from task review ${reviewSummary.reviewThreadId}.`);
        }
      }

      if (task.status === "claimed") {
        if (brokenClaimedSession) {
          actions.push(`Task ${task.id} is still claimed but its session is ${brokenClaimedSession.status}; recover or reassign the blocked work before continuing.`);
        } else if (claimedSession) {
          actions.push(`Task ${task.id} is already claimed by ${claimedSession.memberId}; continue this task with team_work and let that session finish or ask for help.`);
        } else if (task.assignedMemberId) {
          actions.push(`Task ${task.id} is claimed by ${task.assignedMemberId}; inspect status and recover the session if progress has stalled.`);
        }
      }

      if (unreadTaskMessages.length > 0 && taskIssue?.kind !== "unread_escalation") {
        const message = unreadTaskMessages[0]!;
        actions.push(`Task ${task.id} has unread ${message.type ?? "runtime"} message${unreadTaskMessages.length > 1 ? "s" : ""}; review team_status before rerunning work.`);
      }

      if (task.status === "pending" && blockingDependencies.length > 0 && taskIssue?.kind !== "dependency_blocked") {
        const dependency = blockingDependencies[0]!;
        actions.push(`Task ${task.id} is blocked by dependency ${dependency.id} (${dependency.status}); continue that dependency before rerunning this task.`);
      }

      for (const signal of safetySignals.filter((candidate) => candidate.level !== "warning")) {
        if (taskIssue?.blockingReason === signal.summary) {
          continue;
        }
        actions.push(`${signal.summary} ${recommendedActionForSignal(signal)}`);
      }

      for (const signal of safetySignals.filter((candidate) => candidate.level === "warning")) {
        if (taskIssue?.kind === "warning_safety" && signal.summary === taskIssue.blockingReason) {
          continue;
        }
        actions.push(`${signal.summary} ${recommendedActionForSignal(signal)}`);
      }
    }

    const recoverableSessions = Object.values(state.agentSessions)
      .filter((session) => session.teamId === runtime.teamId)
      .filter((session) => session.status === "error" || session.status === "stopped" && !!session.currentTaskId);
    if (recoverableSessions.length > 0) {
      actions.push(`Inspect ${recoverableSessions.length} error/stopped session${recoverableSessions.length > 1 ? "s" : ""} holding or blocking work, then recover, retry, or reassign as needed.`);
    }

    if (actions.length === 0) {
      return controlPlane.nextActions;
    }

    return [...new Set([...actions, ...controlPlane.nextActions])];
  }

  private sessionForTask(controlPlane: RuntimeControlPlane, taskId: string): AgentSessionRecord | undefined {
    return controlPlane.activeWork.find((work) => work.task?.id === taskId)?.session;
  }

  private blockingDependency(
    state: Awaited<ReturnType<JsonStore["read"]>>,
    task: Task
  ): Task | undefined {
    return task.dependencyTaskIds
      .map((dependencyTaskId) => state.tasks[dependencyTaskId])
      .find((dependency): dependency is Task => Boolean(dependency) && dependency.status !== "completed");
  }

  private brokenTaskSession(
    state: Awaited<ReturnType<JsonStore["read"]>>,
    teamId: string,
    taskId: string
  ): AgentSessionRecord | undefined {
    return Object.values(state.agentSessions).find((session) => (
      session.teamId === teamId
      && session.currentTaskId === taskId
      && (session.status === "error" || session.status === "stopped")
    ));
  }

  private taskAttentionIssue(
    state: Awaited<ReturnType<JsonStore["read"]>>,
    task: Task | undefined,
    discussionThread: DiscussionThreadState | undefined
  ): HostAttentionIssue | undefined {
    if (!task) {
      return undefined;
    }

    const blockingDependency = this.blockingDependency(state, task);
    const unreadTaskMessage = this.unreadTaskMessages(state, task.id)[0];
    const safetySignal = openSafetySignalsForTask(state, task.id)[0];
    const brokenClaimedSession = task.status === "claimed" ? this.brokenTaskSession(state, task.teamId, task.id) : undefined;

    return highestPriorityHostIssue([
      ...(discussionThread?.proposedNextAction.kind === "host_decision" ? [{
        kind: "discussion_ready_for_host" as const,
        headline: discussionThread.subject
          ? `Discussion "${discussionThread.subject}" is ready for a host decision.`
          : `Task ${task.id} has a discussion that now needs host judgment.`,
        blockingReason: discussionThread.disagreementSummary ?? discussionThread.proposedNextAction.summary,
        recommendedNextAction: "Review the active discussion thread and decide how the team should proceed.",
        recoveryHint: "Inspect the discussion thread, then continue with team_work once the host decision is clear."
      }] : []),
      ...(safetySignal ? [taskSafetyIssue(task, safetySignal)] : []),
      ...(task.status === "failed" ? [{
        kind: "failed_task" as const,
        headline: `Task ${task.id} needs recovery before runtime work can continue.`,
        blockingReason: task.failureSummary ?? `Task ${task.id} failed.`,
        recommendedNextAction: `Task ${task.id} failed${task.failureSummary ? `: ${task.failureSummary}` : ""}. Review the failure and create follow-up work before continuing.`,
        recoveryHint: "Create follow-up work after reviewing the failed task summary."
      }] : []),
      ...(brokenClaimedSession ? [{
        kind: "broken_claimed_session" as const,
        headline: `Task ${task.id} is still claimed but its session is ${brokenClaimedSession.status}.`,
        blockingReason: `Session ${brokenClaimedSession.id} is ${brokenClaimedSession.status}.`,
        recommendedNextAction: `Task ${task.id} is still claimed but its session is ${brokenClaimedSession.status}; recover or reassign the blocked work before continuing.`,
        recoveryHint: "Recover or replace the broken session before rerunning the affected task."
      }] : []),
      ...(unreadTaskMessage ? [{
        kind: "unread_escalation" as const,
        headline: `Task ${task.id} has unread runtime messages that need review before rerunning work.`,
        blockingReason: unreadTaskMessage.subject ?? unreadTaskMessage.body,
        recommendedNextAction: `Task ${task.id} has unread ${unreadTaskMessage.type ?? "runtime"} message${this.unreadTaskMessages(state, task.id).length > 1 ? "s" : ""}; review team_status before rerunning work.`,
        recoveryHint: "Read the unread runtime message before asking the team to continue."
      }] : []),
      ...(blockingDependency ? [{
        kind: "dependency_blocked" as const,
        headline: `Task ${task.id} is blocked by dependency ${blockingDependency.id}.`,
        blockingReason: `dependency ${blockingDependency.id} is ${blockingDependency.status}`,
        recommendedNextAction: `Task ${task.id} is blocked by dependency ${blockingDependency.id} (${blockingDependency.status}); continue that dependency before rerunning this task.`,
        recoveryHint: "Finish or unblock the dependency task before rerunning the blocked task."
      }] : [])
    ]);
  }

  private unreadTaskMessages(state: Awaited<ReturnType<JsonStore["read"]>>, taskId: string): Message[] {
    const unreadMessageIds = new Set(Object.values(state.messageDeliveries)
      .filter((delivery) => !delivery.acknowledgedAt && !delivery.consumedAt)
      .map((delivery) => delivery.messageId));
    return Object.values(state.messages)
      .filter((message) => message.taskId === taskId)
      .filter((message) => !isHostTaskCommitMessage(message))
      .filter((message) => (
        messageNeedsHostAttention(message, state.teams[message.teamId]?.leadMemberId)
        || (unreadMessageIds.has(message.id)
          && (message.type === "question" || message.type === "handoff" || message.type === "notification" || message.type === "escalation"))
      ))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private hasRecoverableSession(
    state: Awaited<ReturnType<JsonStore["read"]>>,
    teamId: string,
    memberId: string
  ): boolean {
    return Object.values(state.agentSessions)
      .filter((session) => session.teamId === teamId && session.memberId === memberId)
      .some((session) => session.status === "error" || session.status === "stopped");
  }

  private taskContinuation(
    state: Awaited<ReturnType<JsonStore["read"]>>,
    task: Task | undefined,
    runtime: TeamRuntime,
    controlPlane: RuntimeControlPlane,
    fallbackGoal: string | undefined,
    discussionThread: DiscussionThreadState | undefined
  ): ContinuationAction | undefined {
    if (!task && discussionThread?.committedTaskId) {
      return {
        kind: "resume_same_task",
        taskId: discussionThread.committedTaskId,
        headline: `Continue follow-up task ${discussionThread.committedTaskId} created from the settled discussion.`
      };
    }

    if (discussionThread?.proposedNextAction.kind === "host_decision") {
      return {
        kind: "review_before_continue",
        taskId: task?.id,
        headline: "Review the discussion thread before continuing work."
      };
    }

    if (!task && discussionThread?.actionabilityState === "ready_for_task") {
      return {
        kind: "create_followup_task",
        headline: "Create the next task from the settled discussion."
      };
    }

    if (task) {
      const taskIssue = this.taskAttentionIssue(state, task, discussionThread);
      const reviewSummary = taskReviewSummary(state, task);
      if (runtime.status === "paused" || runtime.status === "error") {
        return {
          kind: "review_before_continue",
          taskId: task.id,
          headline: "Inspect the runtime state before continuing this task."
        };
      }

      if (taskIssue) {
        if (taskIssue.kind === "dependency_blocked") {
          const dependency = this.blockingDependency(state, task);
          return {
            kind: "review_before_continue",
            taskId: dependency?.id ?? task.id,
            headline: dependency
              ? `Continue dependency ${dependency.id} before returning to task ${task.id}.`
              : "Review the blocked dependency before continuing work."
          };
        }
        return continuationForHostIssue(taskIssue, task.id);
      }

      if (task.status === "cancelled") {
        return {
          kind: "create_followup_task",
          taskId: task.id,
          headline: `Create follow-up work after cancelled task ${task.id}.`
        };
      }

      if (task.status === "completed" && reviewSummary.reviewState === "follow_up_created" && reviewSummary.followUpTaskId) {
        return {
          kind: "resume_same_task",
          taskId: reviewSummary.followUpTaskId,
          headline: `Continue follow-up task ${reviewSummary.followUpTaskId} created from the task review.`
        };
      }

      if (task.status === "completed" && reviewSummary.reviewState === "review_recommended") {
        return {
          kind: "review_before_continue",
          taskId: task.id,
          headline: reviewSummary.reviewActionSummary ?? `Ask reviewers to review completed task ${task.id}.`
        };
      }

      if (task.status === "completed" && reviewSummary.reviewState === "review_settled" && !taskReviewNeedsFollowUp(state, task)) {
        return {
          kind: "review_before_continue",
          taskId: task.id,
          headline: reviewSummary.reviewActionSummary ?? `Review for task ${task.id} is settled with no follow-up task recommendation.`
        };
      }

      if (task.status === "claimed" || task.status === "pending" || task.status === "completed") {
        return {
          kind: "resume_same_task",
          taskId: task.id,
          headline: `Continue task ${task.id} inside the current task boundary.`
        };
      }
    }

    if (runtime.status === "paused" || runtime.status === "error") {
      return {
        kind: "review_before_continue",
        headline: "Inspect the runtime state before continuing work."
      };
    }

    if (fallbackGoal) {
      return {
        kind: "resume_same_task",
        headline: "Runtime work can continue with the current request."
      };
    }

    if (discussionThread) {
      return {
        kind: discussionThread.actionabilityState === "waiting_host_commit" ? "review_before_continue" : "resume_same_task",
        headline: discussionThread.actionabilityState === "waiting_host_commit"
          ? "Review the settled discussion before choosing the next step."
          : "Continue the current team discussion."
      };
    }

    return undefined;
  }

  private relevantDiscussionThread(
    state: Awaited<ReturnType<JsonStore["read"]>>,
    input: {
      teamId: string;
      task: Task | undefined;
      discussionInput: NormalizedTeamWorkInput["discussion"];
      discussionMessage?: Message;
    }
  ): DiscussionThreadState | undefined {
    const explicitThreadId = input.discussionMessage?.threadId ?? input.discussionMessage?.id;
    if (explicitThreadId) {
      return discussionThreadById(state, input.teamId, explicitThreadId);
    }
    if (input.discussionInput?.replyToMessageId) {
      return discussionThreadForMessage(state, input.teamId, input.discussionInput.replyToMessageId);
    }
    if (input.discussionInput?.subject) {
      return discussionThreads(state, input.teamId)
        .find((thread) => thread.subject === input.discussionInput?.subject);
    }
    if (input.task?.status === "completed") {
      const reviewThread = reviewDiscussionThreadForTask(state, input.task);
      if (reviewThread) {
        return reviewThread;
      }
    }
    const taskId = input.discussionInput?.taskId ?? input.task?.id;
    if (taskId) {
      const taskThread = discussionThreadForTask(state, input.teamId, taskId);
      if (input.task?.status === "completed" && taskThread?.lifecycleState === "closed") {
        return undefined;
      }
      return taskThread;
    }
    return undefined;
  }

  private commitTaskDefaults(
    state: Awaited<ReturnType<JsonStore["read"]>>,
    input: NormalizedTeamWorkInput & { teamId: string },
    thread: DiscussionThreadState
  ): Pick<Task, "pathHints" | "preferredMemberId" | "priority"> {
    const sourceTask = this.sourceTaskForCommit(state, input, thread);
    const sourcePreferredMemberId = sourceTask?.preferredMemberId
      ?? (sourceTask?.assignedMemberId && this.isActiveTeamMember(state, input.teamId, sourceTask.assignedMemberId)
        ? sourceTask.assignedMemberId
        : undefined);

    return {
      pathHints: input.pathHints !== undefined ? input.pathHints : (sourceTask?.pathHints ?? []),
      preferredMemberId: input.preferredMemberId ?? sourcePreferredMemberId,
      priority: input.priority ?? sourceTask?.priority
    };
  }

  private sourceTaskForCommit(
    state: Awaited<ReturnType<JsonStore["read"]>>,
    input: NormalizedTeamWorkInput & { teamId: string },
    thread: DiscussionThreadState
  ): Task | undefined {
    const sourceTaskId = input.discussion?.taskId ?? thread.taskId ?? input.taskId;
    if (!sourceTaskId) {
      return undefined;
    }
    const task = state.tasks[sourceTaskId];
    return task?.teamId === input.teamId ? task : undefined;
  }

  private isActiveTeamMember(
    state: Awaited<ReturnType<JsonStore["read"]>>,
    teamId: string,
    memberId: string
  ): boolean {
    const member = state.members[memberId];
    return !!member && member.teamId === teamId && member.status === "active";
  }

  private followUpGoal(task: Task): string {
    const summary = task.failureSummary ?? task.title;
    return `Follow up on task ${task.id}: ${summary}`;
  }

  private reviewTemplate(
    state: Awaited<ReturnType<JsonStore["read"]>>,
    task: Task
  ): NonNullable<NonNullable<TeamWorkInput["work"]>["review"]> | undefined {
    const signal = openSafetySignalsForTask(state, task.id, ["needs_review", "blocked"])
      .find((candidate) => candidate.status === "open");
    if (!signal) {
      return undefined;
    }

    return {
      signalId: signal.id,
      taskId: task.id,
      decision: signal.kind === "scope_warning" ? "approve_scope_exception" : "acknowledge"
    };
  }
}

function backgroundStatus(schedulerRun: SchedulerRunResult): BackgroundProgressState["status"] {
  if (schedulerRun.stoppedReason === "error") {
    return "error";
  }
  if (schedulerRun.stoppedReason === "needs_attention") {
    return "needs_attention";
  }
  if (schedulerRun.stoppedReason === "idle") {
    return "idle";
  }
  return "stopped";
}

function hostDecisionBody(decision: string, note: string | undefined): string {
  return note
    ? `Host decision: ${decision}\nReasoning: ${note}`
    : `Host decision: ${decision}`;
}

function hostCommitTaskBody(title: string, taskId: string, description: string | undefined): string {
  return description
    ? `Host committed task: ${title}\nTask id: ${taskId}\nTask summary: ${description}`
    : `Host committed task: ${title}\nTask id: ${taskId}`;
}

function messageNeedsHostAttention(message: Message, leadMemberId: string | undefined): boolean {
  if (isHostTaskCommitMessage(message)) {
    return false;
  }
  if (message.type === "escalation") {
    return true;
  }
  if (message.type === "result" && message.fromMemberId && !message.toMemberId) {
    return true;
  }
  if (message.type !== "question") {
    return false;
  }
  if (!message.fromMemberId) {
    return false;
  }
  if (!message.toMemberId) {
    return true;
  }
  return !!leadMemberId && message.toMemberId === leadMemberId;
}

function taskSafetyIssue(
  task: Task,
  signal: ReturnType<typeof openSafetySignalsForTask>[number]
): HostAttentionIssue {
  if (signal.kind === "policy_blocked" && signal.status === "acknowledged") {
    return {
      kind: "blocked_safety",
      headline: `Task ${task.id} still needs manual follow-up before runtime work can continue automatically.`,
      blockingReason: signal.summary,
      recommendedNextAction: recommendedActionForSignal(signal),
      recoveryHint: recommendedActionForSignal(signal)
    };
  }

  if (signal.level === "warning") {
    return {
      kind: "warning_safety",
      headline: `Task ${task.id} has a safety warning that should be reviewed before broader edits continue.`,
      blockingReason: signal.summary,
      recommendedNextAction: `${signal.summary} ${recommendedActionForSignal(signal)}`,
      recoveryHint: recommendedActionForSignal(signal)
    };
  }

  return {
    kind: signal.level === "blocked" ? "blocked_safety" : "needs_review_safety",
    headline: `Task ${task.id} needs safety review before runtime work can continue.`,
    blockingReason: signal.summary,
    recommendedNextAction: recommendedActionForSignal(signal),
    recoveryHint: recommendedActionForSignal(signal)
  };
}
