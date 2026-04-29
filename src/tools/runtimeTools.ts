import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PolicyBlockedError } from "../errors.js";
import type { AgentBackend } from "../runtime/agentBackend.js";
import { compactResultsView } from "../runtime/compactViews.js";
import type { AgentSessionRecord, PathLock, Task, TeamState } from "../domain/types.js";
import { runtimeControlPlane } from "../runtime/controlPlane.js";
import { OpenCodeBackend } from "../runtime/openCodeBackend.js";
import { RuntimePolicyService } from "../runtime/policy.js";
import { recordPolicyBlockedSignal } from "../runtime/safety.js";
import { runSchedulerTickWithSplitStore } from "../runtime/schedulerExecutor.js";
import { RuntimeScheduler } from "../runtime/scheduler.js";
import { RuntimeSchedulerRunner } from "../runtime/schedulerRunner.js";
import { SessionRecoveryService } from "../runtime/sessionRecovery.js";
import { explainRuntimeResults } from "../runtime/explainability.js";
import { runtimeHostSummary } from "../runtime/hostRouting.js";
import { TeamWorkService } from "../runtime/teamWork.js";
import { runtimeResults, runtimeTimeline } from "../runtime/timeline.js";
import { RuntimeService } from "../runtime/runtimeService.js";
import { MailboxService } from "../services/mailboxService.js";
import { addEvent } from "../services/events.js";
import { PathLockService } from "../services/pathLockService.js";
import { TaskService } from "../services/taskService.js";
import type { JsonStore } from "../store/jsonStore.js";
import { runTool } from "./response.js";

export interface RuntimeToolOptions {
  backendFactory?: () => AgentBackend;
  advancedTools?: boolean;
}

export function registerRuntimeTools(server: McpServer, store: JsonStore, options: RuntimeToolOptions = {}): void {
  const backendFactory = options.backendFactory ?? (() => new OpenCodeBackend());

  server.registerTool(
    "team_work",
    {
      title: "Work On Team Task",
      description: "Primary team entrypoint: build the team, finish setup, start a task, or continue work from one lightweight call.",
      inputSchema: {
        teamId: z.string().min(1).optional(),
        request: z.string().min(1).optional(),
        team: z.object({
          teamName: z.string().optional(),
          description: z.string().optional(),
          hostName: z.string().optional(),
          hostModel: z.string().optional(),
          hostResponsibility: z.string().optional(),
          hostNotes: z.string().optional()
        }).optional(),
        builder: z.object({
          draftMember: z.object({
            name: z.string().min(1),
            agentId: z.string().optional(),
            model: z.string().min(1),
            rawResponsibility: z.string().min(1),
            polishedPrompt: z.string().min(1),
            permissions: z.array(z.string()).optional(),
            callWhen: z.array(z.string()).optional(),
            doNot: z.array(z.string()).optional()
          }).optional(),
          confirmMember: z.boolean().optional(),
          removeMember: z.object({
            memberId: z.string().optional(),
            agentId: z.string().optional(),
            name: z.string().optional()
          }).optional(),
          finishTeam: z.boolean().optional()
        }).optional(),
        work: z.object({
          goal: z.string().min(1).optional(),
          taskId: z.string().min(1).optional(),
          pathHints: z.array(z.string()).optional(),
          review: z.object({
            signalId: z.string().min(1).optional(),
            taskId: z.string().min(1).optional(),
            decision: z.enum(["revise_scope", "approve_scope_exception", "acknowledge", "cancel_task"]),
            note: z.string().optional(),
            pathHints: z.array(z.string()).optional()
          }).optional(),
          preferredMemberId: z.string().optional(),
          priority: z.enum(["low", "medium", "high"]).optional(),
          autoRun: z.boolean().optional(),
          maxTicks: z.number().int().positive().max(20).optional(),
          background: z.object({
            enabled: z.boolean().optional(),
            timeoutMs: z.number().int().positive().max(60000).optional()
          }).optional(),
          includeDetails: z.boolean().optional(),
          discussion: z.object({
            subject: z.string().min(1).optional(),
            body: z.string().min(1).optional(),
            taskId: z.string().min(1).optional(),
            participantMemberIds: z.array(z.string().min(1)).optional(),
            maxTurns: z.number().int().positive().max(20).optional(),
            autoRun: z.boolean().optional(),
            replyToMessageId: z.string().min(1).optional(),
            commitToTask: z.object({
              title: z.string().min(1).optional(),
              description: z.string().min(1).optional()
            }).optional(),
            hostDecision: z.object({
              decision: z.string().min(1),
              note: z.string().optional(),
              participantMemberIds: z.array(z.string().min(1)).optional()
            }).optional()
          }).refine((discussion) => !!discussion.body || !!discussion.hostDecision || !!discussion.commitToTask, {
            message: "discussion.body, discussion.hostDecision, or discussion.commitToTask is required"
          }).optional()
        }).optional(),
        goal: z.string().min(1).optional(),
        taskId: z.string().min(1).optional(),
        pathHints: z.array(z.string()).optional(),
        preferredMemberId: z.string().optional(),
        priority: z.enum(["low", "medium", "high"]).optional(),
        autoRun: z.boolean().optional(),
        maxTicks: z.number().int().positive().max(20).optional(),
        background: z.object({
          enabled: z.boolean().optional(),
          timeoutMs: z.number().int().positive().max(60000).optional()
        }).optional(),
        includeDetails: z.boolean().optional(),
        teamName: z.string().optional(),
        description: z.string().optional(),
        hostName: z.string().optional(),
        hostModel: z.string().optional(),
        hostResponsibility: z.string().optional(),
        hostNotes: z.string().optional(),
        draftMember: z.object({
          name: z.string().min(1),
          agentId: z.string().optional(),
          model: z.string().min(1),
          rawResponsibility: z.string().min(1),
          polishedPrompt: z.string().min(1),
          permissions: z.array(z.string()).optional(),
          callWhen: z.array(z.string()).optional(),
          doNot: z.array(z.string()).optional()
        }).optional(),
        confirmMember: z.boolean().optional(),
        removeMember: z.object({
          memberId: z.string().optional(),
          agentId: z.string().optional(),
          name: z.string().optional()
        }).optional(),
        finishTeam: z.boolean().optional()
      }
    },
    async (input) => runTool(() => new TeamWorkService(
      store,
      backendFactory,
      (backend) => new RuntimeSchedulerRunner((tickInput) => runSchedulerTickWithSplitStore(store, backend, tickInput))
    ).work(input))
  );

  if (options.advancedTools) {
    server.registerTool(
      "team_run",
      {
        title: "Run Team Runtime",
        description: "Advanced/manual control: start runtime-managed teammate sessions. Prefer team_work for normal task flow.",
        inputSchema: {
          teamId: z.string().min(1),
          backend: z.literal("opencode").optional(),
          workdir: z.string().optional(),
          maxParallel: z.number().int().positive().optional(),
          autoAssign: z.boolean().optional()
        }
      },
      async (input) => runTool(() => store.transaction((state) => new RuntimeService(state, backendFactory()).start(input)))
    );
  }

  if (options.advancedTools) {
    server.registerTool(
      "team_pause",
      {
        title: "Pause Team Runtime",
        description: "Advanced/manual control: pause scheduling without destroying runtime sessions. Prefer team_work for normal task progress.",
        inputSchema: { teamId: z.string().min(1) }
      },
      async (input) => runTool(() => store.transaction((state) => new RuntimeService(state, backendFactory()).pause(input)))
    );
  }

  if (options.advancedTools) {
    server.registerTool(
      "team_resume",
      {
        title: "Resume Team Runtime",
        description: "Advanced/manual control: resume scheduling after a pause. Prefer team_work after resuming normal task progress.",
        inputSchema: { teamId: z.string().min(1) }
      },
      async (input) => runTool(() => store.transaction((state) => new RuntimeService(state, backendFactory()).resume(input)))
    );
  }

  if (options.advancedTools) {
    server.registerTool(
      "team_stop",
      {
        title: "Stop Team Runtime",
        description: "Advanced/manual control: stop all or selected runtime sessions. Prefer team_work for ordinary task continuation.",
        inputSchema: {
          teamId: z.string().min(1),
          memberIds: z.array(z.string().min(1)).optional(),
          reason: z.string().optional()
        }
      },
      async (input) => runTool(() => store.transaction((state) => new RuntimeService(state, backendFactory()).stop(input)))
    );
  }

  if (options.advancedTools) {
    server.registerTool(
      "team_scheduler_tick",
    {
      title: "Run Scheduler Tick",
      description: "Advanced/manual control: run one deterministic scheduler tick for a running team runtime. Prefer team_work for normal task flow.",
      inputSchema: { teamId: z.string().min(1) }
    },
    async (input) => runTool(() => runSchedulerTickWithSplitStore(store, backendFactory(), input))
    );
  }

  if (options.advancedTools) {
    server.registerTool(
      "team_scheduler_run",
      {
        title: "Run Bounded Scheduler",
        description: "Advanced/manual control: run deterministic scheduler ticks until idle, paused, error, or maxTicks. Prefer team_work for normal task flow.",
        inputSchema: {
          teamId: z.string().min(1),
          maxTicks: z.number().int().positive().max(100).optional(),
          timeoutMs: z.number().int().positive().max(60000).optional(),
          rethrowOnError: z.boolean().optional()
        }
      },
    async (input) => runTool(() => new RuntimeSchedulerRunner((tickInput) => runSchedulerTickWithSplitStore(store, backendFactory(), tickInput)).run(input))
    );
  }

  if (options.advancedTools) {
    server.registerTool(
      "team_runtime_status",
    {
      title: "Team Runtime Status",
      description: "Inspect/debug runtime state and session records. Prefer team_work for normal task progress.",
      inputSchema: { teamId: z.string().min(1) }
    },
    async (input) => runTool(async () => {
      const state = await store.read();
      const runtime = new RuntimeService(state, backendFactory()).status(input.teamId);
      return {
        ...runtime,
        controlPlane: runtimeControlPlane(state, input.teamId, runtime.sessions)
      };
    })
    );
  }

  if (options.advancedTools) {
    server.registerTool(
      "team_recover_sessions",
    {
      title: "Recover Runtime Sessions",
      description: "Advanced/manual recovery: release, clear, or replace work held by error, stopped, or stale sessions. Prefer team_work unless recovery is explicitly needed.",
      inputSchema: {
        teamId: z.string().min(1),
        sessionIds: z.array(z.string().min(1)).optional(),
        staleAfterMs: z.number().int().positive().optional(),
        releaseClaimedTasks: z.boolean().optional(),
        replaceSessions: z.boolean().optional(),
        reason: z.string().optional()
      }
    },
    async (input) => runTool(() => store.transaction((state) => new SessionRecoveryService(state, backendFactory()).recover(input)))
    );
  }

  if (options.advancedTools) {
    server.registerTool(
      "team_task_create",
    {
      title: "Create Runtime Task",
      description: "Low-level task board operation: create a pending runtime task. Prefer team_work for normal task flow.",
      inputSchema: {
        teamId: z.string().min(1),
        title: z.string().min(1),
        description: z.string().optional(),
        dependencyTaskIds: z.array(z.string()).optional(),
        pathHints: z.array(z.string()).optional(),
        createdByMemberId: z.string().optional(),
        preferredMemberId: z.string().optional(),
        priority: z.enum(["low", "medium", "high"]).optional()
      }
    },
    async (input) => runTool(() => store.transaction((state) => new TaskService(state).createTask(input)))
    );
  }

  if (options.advancedTools) {
    server.registerTool(
      "team_tasks",
    {
      title: "List Runtime Tasks",
      description: "Inspect/debug task board state, optionally filtered by status. Prefer team_work for normal task creation and continuation.",
      inputSchema: {
        teamId: z.string().min(1),
        status: z.enum(["pending", "claimed", "completed", "failed", "cancelled"]).optional()
      }
    },
    async (input) => runTool(async () => {
      const state = await store.read();
      return Object.values(state.tasks)
        .filter((task) => task.teamId === input.teamId)
        .filter((task) => !input.status || task.status === input.status)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    })
    );
  }

  if (options.advancedTools) {
    server.registerTool(
      "team_task_cancel",
    {
      title: "Cancel Runtime Task",
      description: "Advanced/manual task board operation: cancel a pending or claimed runtime task.",
      inputSchema: {
        teamId: z.string().min(1),
        taskId: z.string().min(1),
        memberId: z.string().optional(),
        reason: z.string().optional()
      }
    },
    async (input) => runTool(() => store.transaction((state) => new TaskService(state).cancelTask(input)))
    );
  }

  if (options.advancedTools) {
    server.registerTool(
      "team_task_update",
    {
      title: "Update Runtime Task",
      description: "Advanced/manual task board operation: update a pending runtime task before it is claimed.",
      inputSchema: {
        teamId: z.string().min(1),
        taskId: z.string().min(1),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        dependencyTaskIds: z.array(z.string().min(1)).optional(),
        pathHints: z.array(z.string()).optional(),
        preferredMemberId: z.string().optional(),
        priority: z.enum(["low", "medium", "high"]).optional()
      }
    },
    async (input) => runTool(() => store.transaction((state) => new TaskService(state).updateTask(input)))
    );
  }

  if (options.advancedTools) {
    server.registerTool(
      "team_assign",
    {
      title: "Assign Runtime Task",
      description: "Advanced/manual task board operation: set the preferred member for a pending runtime task.",
      inputSchema: {
        teamId: z.string().min(1),
        taskId: z.string().min(1),
        memberId: z.string().min(1)
      }
    },
    async (input) => runTool(() => store.transaction((state) => new TaskService(state).assignTask(input)))
    );
  }

  if (options.advancedTools) {
    server.registerTool(
      "team_message",
    {
      title: "Send Runtime Message",
      description: "Advanced/manual mailbox operation: send a direct or task-scoped runtime message. Runtime-owned members normally use send_message.",
      inputSchema: {
        teamId: z.string().min(1),
        fromMemberId: z.string().optional(),
        toMemberId: z.string().optional(),
        taskId: z.string().optional(),
        type: z.enum(["question", "handoff", "result", "notification", "escalation", "opinion"]).optional(),
        subject: z.string().optional(),
        body: z.string().min(1),
        replyToMessageId: z.string().optional(),
        participantMemberIds: z.array(z.string().min(1)).optional()
      }
    },
    async (input) => runTool(() => store.transaction((state) => new MailboxService(state).sendMessage(input)))
    );
  }

  if (options.advancedTools) {
    server.registerTool(
      "team_inbox",
    {
      title: "Read Runtime Inbox",
      description: "Inspect/debug mailbox operation: read member messages. Prefer team_work or team_status for normal progress checks.",
      inputSchema: {
        teamId: z.string().min(1),
        memberId: z.string().optional(),
        taskId: z.string().optional(),
        includeAcknowledged: z.boolean().optional(),
        includeConsumed: z.boolean().optional()
      }
    },
    async (input) => runTool(async () => new MailboxService(await store.read()).inbox(input))
    );
  }

  if (options.advancedTools) {
    server.registerTool(
      "team_ack",
    {
      title: "Acknowledge Runtime Message",
      description: "Advanced/manual mailbox operation: acknowledge a message. Runtime-owned members normally use ack_message.",
      inputSchema: {
        teamId: z.string().min(1),
        messageId: z.string().min(1),
        memberId: z.string().optional()
      }
    },
    async (input) => runTool(() => store.transaction((state) => new MailboxService(state).ackMessage(input)))
    );
  }

  if (options.advancedTools) {
    server.registerTool(
      "team_lock_paths",
    {
      title: "Lock Runtime Paths",
      description: "Advanced/manual lock operation: acquire exclusive path locks before editing files. Runtime-owned members normally use lock_paths.",
      inputSchema: {
        teamId: z.string().min(1),
        ownerMemberId: z.string().min(1),
        paths: z.array(z.string().min(1)).min(1),
        taskId: z.string().optional(),
        expiresAt: z.string().optional()
      }
    },
    async (input) => runTool(() => store.transaction((state) => new PathLockService(state).lockPaths(input)))
    );
  }

  if (options.advancedTools) {
    server.registerTool(
      "team_unlock_paths",
    {
      title: "Unlock Runtime Paths",
      description: "Advanced/manual lock operation: release path locks. Runtime-owned members normally use unlock_paths.",
      inputSchema: {
        teamId: z.string().min(1),
        ownerMemberId: z.string().optional(),
        lockId: z.string().optional(),
        paths: z.array(z.string().min(1)).optional()
      }
    },
    async (input) => runTool(() => store.transaction((state) => new PathLockService(state).unlockPaths(input)))
    );
  }

  if (options.advancedTools) {
    server.registerTool(
      "team_path_locks",
    {
      title: "List Runtime Path Locks",
      description: "Inspect/debug lock state for a team. Prefer team_work or team_status for normal progress checks.",
      inputSchema: { teamId: z.string().min(1) }
    },
    async (input) => runTool(() => store.transaction((state) => new PathLockService(state).listPathLocks(input.teamId)))
    );
  }

  if (options.advancedTools) {
    server.registerTool(
      "team_check_path_conflicts",
    {
      title: "Check Runtime Path Conflicts",
      description: "Inspect/debug lock operation: check whether requested paths conflict with active locks.",
      inputSchema: {
        teamId: z.string().min(1),
        paths: z.array(z.string().min(1)).min(1),
        ownerMemberId: z.string().optional()
      }
    },
    async (input) => runTool(() => store.transaction((state) => new PathLockService(state).checkPathConflicts(input)))
    );
  }

  if (options.advancedTools) {
    server.registerTool(
      "team_timeline",
    {
      title: "Team Runtime Timeline",
      description: "Inspect/debug collaboration history: recent events, messages, scheduler decisions, and task threads. Prefer team_work for compact normal progress.",
      inputSchema: {
        teamId: z.string().min(1),
        limit: z.number().int().positive().optional()
      }
    },
    async (input) => runTool(async () => runtimeTimeline(await store.read(), input.teamId, input.limit))
    );
  }

  server.registerTool(
    "team_results",
    {
      title: "Team Runtime Results",
      description: "Inspect/debug deliverables: completed and failed task outputs plus recent member summaries. Prefer team_work for compact normal progress.",
      inputSchema: {
        teamId: z.string().min(1),
        limit: z.number().int().positive().optional()
      }
    },
    async (input) => runTool(async () => {
      const state = await store.read();
      const results = runtimeResults(state, input.teamId, input.limit);
      const runtime = new RuntimeService(state, backendFactory()).status(input.teamId);
      const controlPlane = runtimeControlPlane(state, input.teamId, runtime.sessions);
      const explain = explainRuntimeResults(state, runtime.runtime, controlPlane, results);
      return {
        ...results,
        host: controlPlane.host,
        explain,
        compactResults: compactResultsView(state, input.teamId, results, explain)
      };
    })
  );

  server.registerTool(
    "claim_task",
    {
      title: "Claim Runtime Task",
      description: "Agent-facing only: runtime-owned members claim one pending runtime task when instructed by the scheduler.",
      inputSchema: {
        teamId: z.string().min(1),
        taskId: z.string().min(1),
        memberId: z.string().min(1)
      }
    },
    async (input) => runAgentFacingTool(store, (state) => {
      new RuntimePolicyService(state).requirePermission({ teamId: input.teamId, memberId: input.memberId, action: "complete_task", taskId: input.taskId });
      return new TaskService(state).claimTask(input);
    })
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete Runtime Task",
      description: "Agent-facing only: runtime-owned members complete their claimed task with a summary and artifacts.",
      inputSchema: {
        teamId: z.string().min(1),
        taskId: z.string().min(1),
        memberId: z.string().min(1),
        completionSummary: z.string().optional(),
        resultArtifacts: z.array(z.string()).optional()
      }
    },
    async (input) => runAgentFacingTool(store, (state) => {
      new RuntimePolicyService(state).requireTaskOwner({ teamId: input.teamId, memberId: input.memberId, taskId: input.taskId, action: "complete_task" });
      return new TaskService(state).completeTask(input);
    })
  );

  server.registerTool(
    "fail_task",
    {
      title: "Fail Runtime Task",
      description: "Agent-facing only: runtime-owned members report failure for their claimed task.",
      inputSchema: {
        teamId: z.string().min(1),
        taskId: z.string().min(1),
        memberId: z.string().min(1),
        failureSummary: z.string().optional()
      }
    },
    async (input) => runAgentFacingTool(store, (state) => {
      new RuntimePolicyService(state).requireTaskOwner({ teamId: input.teamId, memberId: input.memberId, taskId: input.taskId, action: "complete_task" });
      return new TaskService(state).failTask(input);
    })
  );

  server.registerTool(
    "send_message",
    {
      title: "Send Agent Message",
      description: "Agent-facing only: runtime-owned members send useful task-scoped questions, handoffs, or results.",
      inputSchema: {
        teamId: z.string().min(1),
        fromMemberId: z.string().min(1),
        toMemberId: z.string().optional(),
        taskId: z.string().optional(),
        type: z.enum(["question", "handoff", "result", "notification", "escalation", "opinion"]).optional(),
        subject: z.string().optional(),
        body: z.string().min(1),
        replyToMessageId: z.string().optional(),
        participantMemberIds: z.array(z.string().min(1)).optional()
      }
    },
    async (input) => runAgentFacingTool(store, (state) => {
      new RuntimePolicyService(state).requirePermission({ teamId: input.teamId, memberId: input.fromMemberId, action: "message", taskId: input.taskId });
      return new MailboxService(state).sendMessage(input);
    })
  );

  server.registerTool(
    "inbox",
    {
      title: "Read Agent Inbox",
      description: "Agent-facing only: runtime-owned members read mailbox messages relevant to their work.",
      inputSchema: {
        teamId: z.string().min(1),
        memberId: z.string().min(1),
        taskId: z.string().optional(),
        includeAcknowledged: z.boolean().optional(),
        includeConsumed: z.boolean().optional()
      }
    },
    async (input) => runAgentFacingTool(store, (state) => {
      new RuntimePolicyService(state).requirePermission({ teamId: input.teamId, memberId: input.memberId, action: "read", taskId: input.taskId });
      return new MailboxService(state).inbox(input);
    })
  );

  server.registerTool(
    "ack_message",
    {
      title: "Acknowledge Agent Message",
      description: "Agent-facing only: runtime-owned members acknowledge mailbox messages they handled.",
      inputSchema: {
        teamId: z.string().min(1),
        messageId: z.string().min(1),
        memberId: z.string().min(1)
      }
    },
    async (input) => runAgentFacingTool(store, (state) => {
      new RuntimePolicyService(state).requirePermission({ teamId: input.teamId, memberId: input.memberId, action: "message" });
      return new MailboxService(state).ackMessage(input);
    })
  );

  server.registerTool(
    "lock_paths",
    {
      title: "Lock Agent Paths",
      description: "Agent-facing only: runtime-owned members acquire exclusive path locks before editing.",
      inputSchema: {
        teamId: z.string().min(1),
        ownerMemberId: z.string().min(1),
        paths: z.array(z.string().min(1)).min(1),
        taskId: z.string().optional(),
        expiresAt: z.string().optional()
      }
    },
    async (input) => runAgentFacingTool(store, (state) => {
      new RuntimePolicyService(state).requireCanLockPaths({ teamId: input.teamId, memberId: input.ownerMemberId, taskId: input.taskId, paths: input.paths });
      return new PathLockService(state).lockPaths(input);
    })
  );

  server.registerTool(
    "unlock_paths",
    {
      title: "Unlock Agent Paths",
      description: "Agent-facing only: runtime-owned members release path locks after editing.",
      inputSchema: {
        teamId: z.string().min(1),
        ownerMemberId: z.string().min(1),
        lockId: z.string().optional(),
        paths: z.array(z.string().min(1)).optional()
      }
    },
    async (input) => runAgentFacingTool(store, (state) => {
      new RuntimePolicyService(state).requireCanUnlock({ teamId: input.teamId, memberId: input.ownerMemberId, lockId: input.lockId, paths: input.paths });
      return new PathLockService(state).unlockPaths(input);
    })
  );

  server.registerTool(
    "team_self_status",
    {
      title: "Agent Self Status",
      description: "Agent-facing only: runtime-owned members read their current task, inbox, locks, and session context.",
      inputSchema: {
        teamId: z.string().min(1),
        memberId: z.string().min(1)
      }
    },
    async (input) => runAgentFacingTool(store, (state) => {
      new RuntimePolicyService(state).requirePermission({ teamId: input.teamId, memberId: input.memberId, action: "read" });
      return selfStatus(state, input.teamId, input.memberId);
    })
  );

  server.registerTool(
    "ask_lead",
    {
      title: "Ask Team Lead",
      description: "Agent-facing only: runtime-owned members escalate a task-blocking question to the human-facing lead.",
      inputSchema: {
        teamId: z.string().min(1),
        fromMemberId: z.string().min(1),
        taskId: z.string().optional(),
        subject: z.string().optional(),
        body: z.string().min(1)
      }
    },
    async (input) => runAgentFacingTool(store, (state) => {
      new RuntimePolicyService(state).requirePermission({ teamId: input.teamId, memberId: input.fromMemberId, action: "message", taskId: input.taskId });
      const host = runtimeHostSummary(state, input.teamId);
      const message = new MailboxService(state).sendMessage({
        ...input,
        toMemberId: host.leadMemberId,
        type: "escalation"
      });
      return {
        ...message,
        escalationTarget: host.escalationTarget,
        leadMemberId: host.leadMemberId,
        leadMemberName: host.leadMemberName,
        hostRuntimeSession: host.hostRuntimeSession
      };
    })
  );
}

async function runAgentFacingTool<T>(store: JsonStore, fn: (state: TeamState) => Promise<T> | T) {
  return runTool(async () => {
    try {
      return await store.transaction(fn);
    } catch (error) {
      if (error instanceof PolicyBlockedError) {
        await recordPolicyBlockedAfterRollback(store, error);
      }
      throw error;
    }
  });
}

async function recordPolicyBlockedAfterRollback(store: JsonStore, error: PolicyBlockedError): Promise<void> {
  const details = error.details as { teamId?: string; memberId?: string; taskId?: string; action?: string; reason?: string } | undefined;
  if (!details?.teamId || !details.memberId) {
    return;
  }
  const teamId = details.teamId;
  const memberId = details.memberId;
  await store.transaction((state) => {
    addEvent(state, {
      teamId,
      actorMemberId: memberId,
      entityType: details.taskId ? "task" : "member",
      entityId: details.taskId ?? memberId,
      type: "policy.blocked",
      message: details.reason ?? error.message
    });
    recordPolicyBlockedSignal(state, {
      teamId,
      taskId: details.taskId,
      memberId,
      summary: details.reason ?? error.message
    });
  });
}

function selfStatus(state: TeamState, teamId: string, memberId: string): { session: AgentSessionRecord | undefined; activeTask: Task | undefined; unreadInboxCount: number; heldPathLocks: PathLock[] } {
  const session = Object.values(state.agentSessions).find((candidate) => candidate.teamId === teamId && candidate.memberId === memberId);
  return {
    session,
    activeTask: session?.currentTaskId ? state.tasks[session.currentTaskId] : undefined,
    unreadInboxCount: Object.values(state.messageDeliveries)
      .filter((delivery) => delivery.teamId === teamId && delivery.memberId === memberId)
      .filter((delivery) => !delivery.acknowledgedAt && !delivery.consumedAt).length,
    heldPathLocks: Object.values(state.pathLocks).filter((lock) => lock.teamId === teamId && lock.ownerMemberId === memberId)
  };
}
