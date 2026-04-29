import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyState, type TeamMemberDraft } from "../src/domain/types.js";
import { ConflictError, InvalidStateError, PolicyBlockedError } from "../src/errors.js";
import { RuntimePolicyService } from "../src/runtime/policy.js";
import { MailboxService } from "../src/services/mailboxService.js";
import { PathLockService } from "../src/services/pathLockService.js";
import { TaskService } from "../src/services/taskService.js";
import { TeamService } from "../src/services/teamService.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { initOpenCode } from "../src/cli/initOpencode.js";
import { runOpenCodeTool } from "../src/cli/opencodeTools.js";
import { registerTools } from "../src/tools/registerTools.js";
import type { RegisterToolsOptions } from "../src/tools/registerTools.js";
import { teamConfirmMember, teamDraftMember, teamFinish, teamStart } from "../src/opencode/teamBuilderService.js";
import { parseOpenCodeModels } from "../src/opencode/modelService.js";
import { slugifyAgentId, writeAgentFile } from "../src/opencode/agentFileService.js";
import { checkOpenCodeScaffold } from "../src/opencode/scaffoldService.js";
import { runOpenCodeDogfoodSmoke } from "../src/opencode/dogfoodService.js";
import { TEAM_BUILDER_AGENT } from "../src/opencode/templates.js";
import { FakeAgentBackend } from "../src/runtime/fakeAgentBackend.js";
import { runtimeControlPlane } from "../src/runtime/controlPlane.js";
import { RuntimeService } from "../src/runtime/runtimeService.js";
import { runtimeResults } from "../src/runtime/timeline.js";
import type { AgentBackend } from "../src/runtime/agentBackend.js";
import type { PromptSessionInput, PromptSessionResult, SpawnSessionInput, SpawnSessionResult } from "../src/runtime/types.js";
import { teamBuilds } from "../src/builder/teamBuildState.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("team coordination services", () => {
  it("creates and persists project-local team state", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });

    const created = await store.transaction((state) => new TeamService(state).createTeam({ name: "core", leadName: "lead" }));
    const reopened = new JsonStore({ rootDir });
    const state = await reopened.read();

    expect(state.teams[created.team.id]?.name).toBe("core");
    expect(created.leadMember?.role).toBe("lead");
    expect(state.members[created.leadMember!.id]?.teamId).toBe(created.team.id);
  });

  it("distinguishes a default host from runtime-owned lead members", async () => {
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "explicit lead", leadName: "Runtime Lead" }).team;
    const worker = teams.addMember({ teamId: team.id, name: "Worker", agentId: "worker", model: "test/model" });
    const backend = new FakeAgentBackend();

    const runtime = await new RuntimeService(state, backend).start({ teamId: team.id, maxParallel: 2 });
    const controlPlane = runtimeControlPlane(state, team.id, runtime.sessions);
    const leadSession = runtime.sessions.find((session) => session.memberId === team.leadMemberId);
    const workerSession = runtime.sessions.find((session) => session.memberId === worker.id);

    expect(controlPlane.host).toMatchObject({
      leadMode: "explicit_lead_member",
      leadMemberId: team.leadMemberId,
      leadMemberName: "Runtime Lead",
      escalationTarget: "lead_member",
      hostRuntimeSession: false,
      leadRuntimeSessionId: leadSession?.id
    });
    expect(runtime.sessions).toHaveLength(2);
    expect(leadSession).toBeTruthy();
    expect(workerSession).toBeTruthy();
    expect(leadSession?.id).not.toBe(workerSession?.id);
  });

  it("enforces task dependencies and claim conflicts", () => {
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "builders", leadName: "lead" }).team;
    const member = teams.addMember({ teamId: team.id, name: "worker" });
    const tasks = new TaskService(state);
    const dependency = tasks.createTask({ teamId: team.id, title: "prepare" });
    const dependent = tasks.createTask({ teamId: team.id, title: "implement", dependencyTaskIds: [dependency.id] });

    expect(() => tasks.claimTask({ teamId: team.id, taskId: dependent.id, memberId: member.id })).toThrowError(InvalidStateError);

    tasks.claimTask({ teamId: team.id, taskId: dependency.id, memberId: member.id });
    tasks.completeTask({ teamId: team.id, taskId: dependency.id, memberId: member.id });
    tasks.claimTask({ teamId: team.id, taskId: dependent.id, memberId: member.id });

    expect(() => tasks.claimTask({ teamId: team.id, taskId: dependent.id, memberId: member.id })).toThrowError(ConflictError);
  });

  it("keeps mailbox ack separate from task state", () => {
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "mail", leadName: "lead" }).team;
    const member = teams.addMember({ teamId: team.id, name: "worker" });
    const mailbox = new MailboxService(state);
    const message = mailbox.sendMessage({ teamId: team.id, toMemberId: member.id, body: "please review" });

    expect(mailbox.inbox({ teamId: team.id, memberId: member.id })).toHaveLength(1);
    mailbox.ackMessage({ teamId: team.id, messageId: message.id, memberId: member.id });

    expect(mailbox.inbox({ teamId: team.id, memberId: member.id })).toHaveLength(0);
    expect(mailbox.inbox({ teamId: team.id, memberId: member.id, includeAcknowledged: true })).toHaveLength(1);
  });

  it("keeps broadcast discussion deliveries independent per member", () => {
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "discussion deliveries", leadName: "lead" }).team;
    const first = teams.addMember({ teamId: team.id, name: "first" });
    const second = teams.addMember({ teamId: team.id, name: "second" });
    const mailbox = new MailboxService(state);
    const message = mailbox.sendMessage({
      teamId: team.id,
      type: "question",
      subject: "Design direction",
      body: "Share your opinion.",
      participantMemberIds: [first.id, second.id]
    });

    expect(message.threadId).toBe(message.id);
    expect(Object.values(state.messageDeliveries).filter((delivery) => delivery.messageId === message.id)).toHaveLength(2);
    mailbox.consumeMessages({ teamId: team.id, memberId: first.id, messageIds: [message.id] });

    expect(mailbox.inbox({ teamId: team.id, memberId: first.id })).toHaveLength(0);
    expect(mailbox.inbox({ teamId: team.id, memberId: second.id })).toEqual([message]);
    expect(Object.values(state.messageDeliveries).find((delivery) => delivery.messageId === message.id && delivery.memberId === first.id)?.consumedAt).toBeTruthy();
    expect(Object.values(state.messageDeliveries).find((delivery) => delivery.messageId === message.id && delivery.memberId === second.id)?.consumedAt).toBeUndefined();
  });

  it("keeps broadcast opinions in the thread without turning them into teammate inbox work", () => {
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "quiet opinions", leadName: "lead" }).team;
    const author = teams.addMember({ teamId: team.id, name: "author" });
    const reviewer = teams.addMember({ teamId: team.id, name: "reviewer" });
    const mailbox = new MailboxService(state);
    const root = mailbox.sendMessage({
      teamId: team.id,
      type: "question",
      subject: "Direction",
      body: "Share one opinion each.",
      participantMemberIds: [author.id, reviewer.id]
    });

    mailbox.sendMessage({
      teamId: team.id,
      fromMemberId: author.id,
      type: "opinion",
      body: "Keep the runtime contract small.",
      replyToMessageId: root.id
    });

    expect(Object.values(state.messageDeliveries).filter((delivery) => delivery.messageId !== root.id)).toHaveLength(0);
    expect(mailbox.inbox({ teamId: team.id, memberId: reviewer.id })).toEqual([root]);
  });

  it("attributes message-only contributors to their runtime sessions in results", async () => {
    const rootDir = await tempRoot();
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "message session attribution" }).team;
    const author = teams.addMember({ teamId: team.id, name: "Author", agentId: "author", model: "test/model" });
    const reviewer = teams.addMember({ teamId: team.id, name: "Reviewer", agentId: "reviewer", model: "test/model" });
    const backend = new FakeAgentBackend();

    await new RuntimeService(state, backend).start({ teamId: team.id, workdir: rootDir, maxParallel: 2 });

    const authorSession = Object.values(state.agentSessions).find((session) => session.teamId === team.id && session.memberId === author.id);
    const reviewerSession = Object.values(state.agentSessions).find((session) => session.teamId === team.id && session.memberId === reviewer.id);
    const task = new TaskService(state).createTask({ teamId: team.id, title: "Review coordinated change", preferredMemberId: author.id });

    new TaskService(state).claimTask({ teamId: team.id, taskId: task.id, memberId: author.id });
    new MailboxService(state).sendMessage({
      teamId: team.id,
      fromMemberId: reviewer.id,
      toMemberId: author.id,
      taskId: task.id,
      type: "result",
      subject: "Review result",
      body: "Looks good."
    });
    new TaskService(state).completeTask({
      teamId: team.id,
      taskId: task.id,
      memberId: author.id,
      completionSummary: "Author completed the coordinated change.",
      resultArtifacts: ["src/runtime/timeline.ts"]
    });

    const results = runtimeResults(state, team.id, 10);

    expect(results.memberContributions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        memberId: author.id,
        memberName: "Author",
        sessionIds: [authorSession!.id],
        completedTaskIds: [task.id]
      }),
      expect.objectContaining({
        memberId: reviewer.id,
        memberName: "Reviewer",
        sessionIds: [reviewerSession!.id],
        resultMessageIds: [expect.any(String)],
        latestContributionSummary: "Review result"
      })
    ]));
  });

  it("stores message type replies and consumed state separately from ack", () => {
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "mail routing", leadName: "lead" }).team;
    const sender = teams.addMember({ teamId: team.id, name: "sender" });
    const receiver = teams.addMember({ teamId: team.id, name: "receiver" });
    const mailbox = new MailboxService(state);
    const question = mailbox.sendMessage({
      teamId: team.id,
      fromMemberId: sender.id,
      toMemberId: receiver.id,
      type: "question",
      subject: "API shape",
      body: "Which response shape should I use?"
    });
    const reply = mailbox.sendMessage({
      teamId: team.id,
      fromMemberId: receiver.id,
      toMemberId: sender.id,
      type: "result",
      body: "Use the compact shape.",
      replyToMessageId: question.id
    });

    mailbox.consumeMessages({ teamId: team.id, memberId: receiver.id, messageIds: [question.id] });

    expect(question.type).toBe("question");
    expect(reply.replyToMessageId).toBe(question.id);
    expect(mailbox.inbox({ teamId: team.id, memberId: receiver.id })).toHaveLength(0);
    expect(mailbox.inbox({ teamId: team.id, memberId: receiver.id, includeConsumed: true })).toEqual([question]);
    expect(question.acknowledgedAt).toBeUndefined();
    expect(question.consumedAt).toBeTruthy();
    expect(state.events.map((event) => event.type)).toContain("message.consumed");
  });

  it("detects path lock conflicts across different owners", () => {
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "locks", leadName: "lead" }).team;
    const alice = teams.addMember({ teamId: team.id, name: "alice" });
    const bob = teams.addMember({ teamId: team.id, name: "bob" });
    const locks = new PathLockService(state);

    locks.lockPaths({ teamId: team.id, ownerMemberId: alice.id, paths: ["src/services/**"] });

    expect(locks.checkPathConflicts({ teamId: team.id, ownerMemberId: bob.id, paths: ["src/services/taskService.ts"] }).conflicts).toHaveLength(1);
    expect(() => locks.lockPaths({ teamId: team.id, ownerMemberId: bob.id, paths: ["src/services/taskService.ts"] })).toThrowError(ConflictError);
    expect(locks.checkPathConflicts({ teamId: team.id, ownerMemberId: alice.id, paths: ["src/services/taskService.ts"] }).conflicts).toHaveLength(0);
  });

  it("expires stale path locks before conflict checks and new locks", () => {
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "expired locks", leadName: "lead" }).team;
    const alice = teams.addMember({ teamId: team.id, name: "alice" });
    const bob = teams.addMember({ teamId: team.id, name: "bob" });
    const locks = new PathLockService(state);
    const expired = locks.lockPaths({
      teamId: team.id,
      ownerMemberId: alice.id,
      paths: ["src/services/**"],
      expiresAt: "2000-01-01T00:00:00.000Z"
    }).lock;

    expect(locks.checkPathConflicts({ teamId: team.id, ownerMemberId: bob.id, paths: ["src/services/taskService.ts"] }).conflicts).toHaveLength(0);
    expect(state.pathLocks[expired.id]).toBeUndefined();

    const replacement = locks.lockPaths({ teamId: team.id, ownerMemberId: bob.id, paths: ["src/services/taskService.ts"] }).lock;

    expect(replacement.ownerMemberId).toBe(bob.id);
    expect(locks.listPathLocks(team.id)).toEqual([replacement]);
    expect(state.events.map((event) => event.type)).toContain("path_lock.expired");
  });

  it("releases task path locks when tasks complete, fail, or cancel", () => {
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "terminal locks", leadName: "lead" }).team;
    const member = teams.addMember({ teamId: team.id, name: "worker" });
    const tasks = new TaskService(state);
    const locks = new PathLockService(state);

    const completed = tasks.createTask({ teamId: team.id, title: "complete" });
    tasks.claimTask({ teamId: team.id, taskId: completed.id, memberId: member.id });
    locks.lockPaths({ teamId: team.id, taskId: completed.id, ownerMemberId: member.id, paths: ["src/complete.ts"] });
    tasks.completeTask({ teamId: team.id, taskId: completed.id, memberId: member.id, completionSummary: "done", resultArtifacts: ["src/complete.ts"] });

    const failed = tasks.createTask({ teamId: team.id, title: "fail" });
    tasks.claimTask({ teamId: team.id, taskId: failed.id, memberId: member.id });
    locks.lockPaths({ teamId: team.id, taskId: failed.id, ownerMemberId: member.id, paths: ["src/fail.ts"] });
    tasks.failTask({ teamId: team.id, taskId: failed.id, memberId: member.id, failureSummary: "blocked" });

    const cancelled = tasks.createTask({ teamId: team.id, title: "cancel" });
    locks.lockPaths({ teamId: team.id, taskId: cancelled.id, ownerMemberId: member.id, paths: ["src/cancel.ts"] });
    tasks.cancelTask({ teamId: team.id, taskId: cancelled.id, memberId: member.id, reason: "not needed" });

    expect(locks.listPathLocks(team.id)).toHaveLength(0);
    expect(state.tasks[completed.id]?.resultArtifacts).toEqual(["src/complete.ts"]);
    expect(state.tasks[failed.id]?.failureSummary).toBe("blocked");
    expect(state.tasks[cancelled.id]?.failureSummary).toBe("not needed");
  });

  it("creates task boundaries and scope-missing safety signals for tasks without pathHints", () => {
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "task boundaries", leadName: "lead" }).team;
    const task = new TaskService(state).createTask({ teamId: team.id, title: "Investigate scope" });

    expect(state.taskBoundaries[task.id]).toMatchObject({
      taskId: task.id,
      teamId: team.id,
      scopePaths: [],
      scopeSource: "none"
    });
    expect(Object.values(state.safetySignals)).toEqual([
      expect.objectContaining({
        taskId: task.id,
        teamId: team.id,
        kind: "scope_missing",
        level: "warning",
        status: "open"
      })
    ]);
  });

  it("updates task boundaries and resolves scope-missing safety signals when pathHints are added", () => {
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "task boundaries update", leadName: "lead" }).team;
    const tasks = new TaskService(state);
    const task = tasks.createTask({ teamId: team.id, title: "Investigate scope" });

    tasks.updateTask({ teamId: team.id, taskId: task.id, pathHints: ["src/runtime/**"] });

    expect(state.taskBoundaries[task.id]).toMatchObject({
      taskId: task.id,
      teamId: team.id,
      scopePaths: ["src/runtime/**"],
      scopeSource: "path_hints"
    });
    expect(Object.values(state.safetySignals)).toEqual([
      expect.objectContaining({
        taskId: task.id,
        kind: "scope_missing",
        status: "resolved"
      })
    ]);
  });

  it("enforces runtime policy for path locks and records inspectable blocks", () => {
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "policy locks", leadName: "lead" }).team;
    const observer = teams.addMember({ teamId: team.id, name: "observer", permissions: ["read-only"] });
    const editor = teams.addMember({ teamId: team.id, name: "editor", permissions: ["read", "edit"] });
    const tasks = new TaskService(state);
    const observedTask = tasks.createTask({ teamId: team.id, title: "observe", pathHints: ["src/runtime/**"] });
    const editTask = tasks.createTask({ teamId: team.id, title: "edit", pathHints: ["src/runtime/**"] });
    const policy = new RuntimePolicyService(state);

    tasks.claimTask({ teamId: team.id, taskId: observedTask.id, memberId: observer.id });
    tasks.claimTask({ teamId: team.id, taskId: editTask.id, memberId: editor.id });

    expect(() => policy.requireCanLockPaths({ teamId: team.id, memberId: observer.id, taskId: observedTask.id, paths: ["src/runtime/policy.ts"] })).toThrowError(PolicyBlockedError);
    policy.requireCanLockPaths({ teamId: team.id, memberId: editor.id, taskId: editTask.id, paths: ["docs/runtime-rfc.md"] });
    const lock = new PathLockService(state).lockPaths({ teamId: team.id, ownerMemberId: editor.id, taskId: editTask.id, paths: ["src/runtime/policy.ts"] }).lock;

    expect(() => policy.requireCanUnlock({ teamId: team.id, memberId: observer.id, lockId: lock.id })).toThrowError(PolicyBlockedError);
    expect(() => policy.requireCanUnlock({ teamId: team.id, memberId: editor.id, lockId: lock.id })).not.toThrow();
    expect(state.events.map((event) => event.type)).toEqual(expect.arrayContaining(["policy.blocked", "policy.warning", "path_lock.created"]));
  });

  it("enforces runtime policy before agent-facing tools mutate state", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new FakeAgentBackend();
    const server = registeredServer(store, { backendFactory: () => backend });
    const setup = await store.transaction((state) => {
      const teams = new TeamService(state);
      const team = teams.createTeam({ name: "tool policy", leadName: "lead" }).team;
      const reader = teams.addMember({ teamId: team.id, name: "reader", permissions: ["read-only"] });
      const editor = teams.addMember({ teamId: team.id, name: "editor", permissions: ["read", "edit"] });
      const tasks = new TaskService(state);
      const readerTask = tasks.createTask({ teamId: team.id, title: "read", pathHints: ["src/**"] });
      const editorTask = tasks.createTask({ teamId: team.id, title: "edit", pathHints: ["src/**"] });
      tasks.claimTask({ teamId: team.id, taskId: readerTask.id, memberId: reader.id });
      tasks.claimTask({ teamId: team.id, taskId: editorTask.id, memberId: editor.id });
      return { teamId: team.id, readerId: reader.id, editorId: editor.id, readerTaskId: readerTask.id, editorTaskId: editorTask.id };
    });

    const blockedLock = await callRegisteredTool(server, "lock_paths", {
      teamId: setup.teamId,
      ownerMemberId: setup.readerId,
      taskId: setup.readerTaskId,
      paths: ["src/reader.ts"]
    }) as { ok: false; error: { code: string } };
    const lock = await callRegisteredTool(server, "lock_paths", {
      teamId: setup.teamId,
      ownerMemberId: setup.editorId,
      taskId: setup.editorTaskId,
      paths: ["src/editor.ts"]
    }) as { result: { lock: { id: string } } };
    const blockedUnlock = await callRegisteredTool(server, "unlock_paths", {
      teamId: setup.teamId,
      ownerMemberId: setup.readerId,
      lockId: lock.result.lock.id
    }) as { ok: false; error: { code: string } };
    const blockedComplete = await callRegisteredTool(server, "complete_task", {
      teamId: setup.teamId,
      taskId: setup.editorTaskId,
      memberId: setup.readerId,
      completionSummary: "wrong owner"
    }) as { ok: false; error: { code: string } };
    const completed = await callRegisteredTool(server, "complete_task", {
      teamId: setup.teamId,
      taskId: setup.editorTaskId,
      memberId: setup.editorId,
      completionSummary: "policy allowed"
    }) as { result: { status: string } };
    const state = await store.read();

    expect(blockedLock.error.code).toBe("POLICY_BLOCKED");
    expect(blockedUnlock.error.code).toBe("POLICY_BLOCKED");
    expect(blockedComplete.error.code).toBe("POLICY_BLOCKED");
    expect(completed.result.status).toBe("completed");
    expect(state.events.map((event) => event.type)).toEqual(expect.arrayContaining(["policy.blocked", "path_lock.created", "task.completed"]));
  });

  it("reviews scope-missing safety through team_work and updates task boundaries", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const server = registeredServer(store, { backendFactory: () => new FakeAgentBackend() });
    const started = await callRegisteredTool(server, "team_start", { teamName: "review missing scope" }) as {
      result: { team: { id: string } };
    };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Scope Worker",
      model: "test/model",
      rawResponsibility: "Handle scoped runtime work.",
      polishedPrompt: "Handle scoped runtime work."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });
    const task = await callRegisteredTool(server, "team_task_create", {
      teamId: started.result.team.id,
      title: "Add explicit scope later"
    }) as { result: { id: string } };

    const reviewed = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      work: {
        taskId: task.result.id,
        review: {
          decision: "revise_scope",
          pathHints: ["src/runtime/**"]
        }
      }
    }) as {
      result: {
        reviewResult?: { decision: string; taskId?: string; resolvedSignalIds: string[]; nextAction: string };
        recommendedInput: { teamId: string; work: { taskId: string; autoRun: boolean } };
      };
    };
    const state = await store.read();

    expect(state.tasks[task.result.id]).toMatchObject({ pathHints: ["src/runtime/**"] });
    expect(state.taskBoundaries[task.result.id]).toMatchObject({
      taskId: task.result.id,
      scopePaths: ["src/runtime/**"],
      scopeSource: "path_hints"
    });
    expect(Object.values(state.safetySignals)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: task.result.id,
        kind: "scope_missing",
        status: "resolved"
      })
    ]));
    expect(reviewed.result.reviewResult).toMatchObject({
      decision: "revise_scope",
      taskId: task.result.id,
      resolvedSignalIds: [expect.any(String)],
      nextAction: expect.stringContaining("scope was updated")
    });
    expect(reviewed.result.recommendedInput).toMatchObject({
      teamId: started.result.team.id,
      work: { taskId: task.result.id, autoRun: true }
    });
  });

  it("reviews scope-warning safety through team_work without changing pathHints", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const server = registeredServer(store, { backendFactory: () => new FakeAgentBackend() });
    const setup = await store.transaction((state) => {
      const teams = new TeamService(state);
      const team = teams.createTeam({ name: "review scope warning" }).team;
      const member = teams.addMember({ teamId: team.id, name: "Editor", permissions: ["read", "edit"] });
      teamStart(state, { teamId: team.id, teamName: team.name });
      teamFinish(state, { teamId: team.id });
      new RuntimeService(state, new FakeAgentBackend()).markReady({ teamId: team.id });
      const task = new TaskService(state).createTask({
        teamId: team.id,
        title: "Scoped task",
        pathHints: ["src/scoped.ts"]
      });
      new TaskService(state).claimTask({ teamId: team.id, taskId: task.id, memberId: member.id });
      new RuntimePolicyService(state).requireCanLockPaths({
        teamId: team.id,
        memberId: member.id,
        taskId: task.id,
        paths: ["src/outside.ts"]
      });
      return { teamId: team.id, taskId: task.id };
    });

    const reviewed = await callRegisteredTool(server, "team_work", {
      teamId: setup.teamId,
      work: {
        taskId: setup.taskId,
        review: {
          decision: "approve_scope_exception"
        }
      }
    }) as {
      result: {
        reviewResult?: { decision: string; taskId?: string; resolvedSignalIds: string[]; nextAction: string };
        recommendedInput: { teamId: string; work: { taskId: string; autoRun: boolean } };
      };
    };
    const state = await store.read();

    expect(state.tasks[setup.taskId]).toMatchObject({ pathHints: ["src/scoped.ts"] });
    expect(Object.values(state.safetySignals)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: setup.taskId,
        kind: "scope_warning",
        status: "resolved"
      })
    ]));
    expect(reviewed.result.reviewResult).toMatchObject({
      decision: "approve_scope_exception",
      taskId: setup.taskId,
      resolvedSignalIds: [expect.any(String)],
      nextAction: expect.stringContaining("reviewed")
    });
    expect(reviewed.result.recommendedInput).toMatchObject({
      teamId: setup.teamId,
      work: { taskId: setup.taskId, autoRun: true }
    });
  });

  it("acknowledges policy-blocked safety through team_work and keeps follow-up manual", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new FakeAgentBackend();
    const server = registeredServer(store, { backendFactory: () => backend });
    const setup = await store.transaction((state) => {
      const teams = new TeamService(state);
      const team = teams.createTeam({ name: "ack blocked policy" }).team;
      const member = teams.addMember({ teamId: team.id, name: "Reader", permissions: ["read-only"] });
      teamStart(state, { teamId: team.id, teamName: team.name });
      teamFinish(state, { teamId: team.id });
      new RuntimeService(state, backend).markReady({ teamId: team.id });
      const task = new TaskService(state).createTask({
        teamId: team.id,
        title: "Blocked lock request",
        pathHints: ["src/blocked.ts"]
      });
      new TaskService(state).claimTask({ teamId: team.id, taskId: task.id, memberId: member.id });
      return { teamId: team.id, taskId: task.id, memberId: member.id };
    });

    const blocked = await callRegisteredTool(server, "lock_paths", {
      teamId: setup.teamId,
      ownerMemberId: setup.memberId,
      taskId: setup.taskId,
      paths: ["src/blocked.ts"]
    }) as { ok: false; error: { code: string } };
    const reviewed = await callRegisteredTool(server, "team_work", {
      teamId: setup.teamId,
      work: {
        taskId: setup.taskId,
        review: {
          decision: "acknowledge"
        }
      }
    }) as {
      result: {
        reviewResult?: { decision: string; taskId?: string; resolvedSignalIds: string[]; nextAction: string };
        recommendedInput: { teamId: string; work: { taskId: string; autoRun: boolean } };
        nextActions: string[];
      };
    };
    const followUp = await callRegisteredTool(server, "team_work", {
      teamId: setup.teamId,
      work: {
        taskId: setup.taskId,
        autoRun: true,
        includeDetails: true
      }
    }) as {
      result: {
        schedulerRun?: { stoppedReason?: string; needsAttentionReason?: string; ticksRun: number };
        explain: { headline: string; safety?: { level: string; headline: string; recommendedAction: string } };
        recommendedInput: { teamId: string; work: { taskId: string; autoRun: boolean; review?: unknown } };
      };
    };
    const state = await store.read();

    expect(blocked.error.code).toBe("POLICY_BLOCKED");
    expect(Object.values(state.safetySignals)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: setup.taskId,
        kind: "policy_blocked",
        status: "acknowledged",
        summary: "The blocked action was acknowledged, but permissions were not changed."
      })
    ]));
    expect(reviewed.result.reviewResult).toMatchObject({
      decision: "acknowledge",
      taskId: setup.taskId,
      resolvedSignalIds: [],
      nextAction: "The blocked action was acknowledged, but permissions were not changed; continue manually or adjust member permissions before rerunning work."
    });
    expect(reviewed.result.nextActions[0]).toBe("The blocked action was acknowledged, but permissions were not changed; continue manually or adjust member permissions before rerunning work.");
    expect(reviewed.result.recommendedInput).toMatchObject({
      teamId: setup.teamId,
      work: { taskId: setup.taskId, autoRun: false }
    });
    expect(followUp.result.schedulerRun).toMatchObject({
      stoppedReason: "needs_attention",
      needsAttentionReason: "The blocked action was acknowledged, but permissions were not changed.",
      ticksRun: 0
    });
    expect(followUp.result.explain.headline).toContain("manual follow-up");
    expect(followUp.result.explain.safety).toMatchObject({
      level: "blocked",
      headline: "The blocked action was acknowledged, but permissions were not changed.",
      recommendedAction: "Continue manually or adjust member permissions before rerunning work."
    });
    expect(followUp.result.recommendedInput).toMatchObject({
      teamId: setup.teamId,
      work: { taskId: setup.taskId, autoRun: false }
    });
    expect(followUp.result.recommendedInput.work.review).toBeUndefined();
  });

  it("cancels a task through team_work safety review and closes task-scoped signals", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const server = registeredServer(store, { backendFactory: () => new FakeAgentBackend() });
    const started = await callRegisteredTool(server, "team_start", { teamName: "cancel reviewed task" }) as {
      result: { team: { id: string } };
    };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Cancel Worker",
      model: "test/model",
      rawResponsibility: "Handle cancelled work.",
      polishedPrompt: "Handle cancelled work."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });
    const task = await callRegisteredTool(server, "team_task_create", {
      teamId: started.result.team.id,
      title: "Cancel after review"
    }) as { result: { id: string } };

    const reviewed = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      work: {
        taskId: task.result.id,
        review: {
          decision: "cancel_task",
          note: "Scope needs to be reconsidered."
        }
      }
    }) as {
      result: {
        task?: { id: string; status: string };
        reviewResult?: { decision: string; taskId?: string; resolvedSignalIds: string[]; nextAction: string };
        recommendedInput: { teamId: string; work: { goal: string; autoRun: boolean } };
      };
    };
    const state = await store.read();

    expect(state.tasks[task.result.id]).toMatchObject({
      status: "cancelled",
      failureSummary: "Scope needs to be reconsidered."
    });
    expect(Object.values(state.safetySignals)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: task.result.id,
        status: "resolved"
      })
    ]));
    expect(reviewed.result.task).toMatchObject({ id: task.result.id, status: "cancelled" });
    expect(reviewed.result.reviewResult).toMatchObject({
      decision: "cancel_task",
      taskId: task.result.id,
      nextAction: `Task ${task.result.id} was cancelled after host safety review.`
    });
    expect(reviewed.result.recommendedInput).toMatchObject({
      teamId: started.result.team.id,
      work: {
        goal: expect.stringContaining(`Follow up on task ${task.result.id}`),
        autoRun: false
      }
    });
  });

  it("does not unblock dependent tasks when a dependency fails", () => {
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "failed dependency", leadName: "lead" }).team;
    const member = teams.addMember({ teamId: team.id, name: "worker" });
    const tasks = new TaskService(state);
    const dependency = tasks.createTask({ teamId: team.id, title: "prepare" });
    const dependent = tasks.createTask({ teamId: team.id, title: "implement", dependencyTaskIds: [dependency.id] });

    tasks.claimTask({ teamId: team.id, taskId: dependency.id, memberId: member.id });
    tasks.failTask({ teamId: team.id, taskId: dependency.id, memberId: member.id, failureSummary: "cannot prepare" });

    expect(() => tasks.claimTask({ teamId: team.id, taskId: dependent.id, memberId: member.id })).toThrowError(InvalidStateError);
  });

  it("allows only one concurrent claimant for the same task", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir, lockTimeoutMs: 2000, lockPollMs: 5 });
    const setup = await store.transaction((state) => {
      const teams = new TeamService(state);
      const team = teams.createTeam({ name: "race", leadName: "lead" }).team;
      const first = teams.addMember({ teamId: team.id, name: "first" });
      const second = teams.addMember({ teamId: team.id, name: "second" });
      const task = new TaskService(state).createTask({ teamId: team.id, title: "claim once" });
      return { teamId: team.id, taskId: task.id, firstId: first.id, secondId: second.id };
    });

    const attempts = await Promise.allSettled([
      store.transaction((state) => new TaskService(state).claimTask({ teamId: setup.teamId, taskId: setup.taskId, memberId: setup.firstId })),
      store.transaction((state) => new TaskService(state).claimTask({ teamId: setup.teamId, taskId: setup.taskId, memberId: setup.secondId }))
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    const finalState = await store.read();
    expect(finalState.tasks[setup.taskId]?.status).toBe("claimed");
  });

  it("scaffolds only the user-authored OpenCode team builder without overwriting existing files", async () => {
    const rootDir = await tempRoot();
    await mkdir(join(rootDir, ".opencode", "agents"), { recursive: true });
    const existingAgent = join(rootDir, ".opencode", "agents", "team-builder.md");
    await writeFile(existingAgent, "custom team builder", "utf8");

    const result = await initOpenCode({ rootDir, serverCommand: ["node", "./dist/index.js"] });
    const teamBuilder = await readFile(existingAgent, "utf8");
    const config = JSON.parse(await readFile(join(rootDir, "opencode.json"), "utf8")) as {
      mcp: Record<string, { type: string; command: string[] }>;
      agent: Record<string, unknown>;
    };

    expect(teamBuilder).toBe("custom team builder");
    expect(result.skipped).toContain(existingAgent);
    expect(config.mcp.team_mcpv2.type).toBe("local");
    expect(config.mcp.team_mcpv2.command).toEqual(["node", "./dist/index.js"]);
    expect(config.agent["team-builder"]).toBeTruthy();
    expect(config.agent.builder).toBeFalsy();
    await expect(readFile(join(rootDir, ".opencode", "agents", "builder.md"), "utf8")).rejects.toThrow();
    expect(await readFile(join(rootDir, ".opencode", "commands", "team-start.md"), "utf8")).toContain("team_start");
    const teamTools = await readFile(join(rootDir, ".opencode", "tools", "team.ts"), "utf8");
    expect(teamTools).toContain("runTeamTool");
    expect(teamTools).toContain("function projectRootFromToolFile()");
    expect(teamTools).toContain('resolve(dirname(toolFile), "..", "..")');
    expect(teamTools).toContain('"--root", rootDir');
    expect(teamTools).toContain("Show team builder status");
    expect(teamTools).not.toContain("active tasks, locks, inbox");
  });

  it("uses the package entrypoint when init-opencode infers the default MCP command", async () => {
    const rootDir = await tempRoot();

    await initOpenCode({ rootDir });

    const config = JSON.parse(await readFile(join(rootDir, "opencode.json"), "utf8")) as {
      mcp: Record<string, { command: string[] }>;
    };
    const command = config.mcp.team_mcpv2.command;

    expect(command[0]).toBe("node");
    expect(command[1]).toContain("dist/index.js");
    expect(command[1]).not.toBe("C:/team-mcpv2/dist/index.js");
    expect(isAbsolute(command[1])).toBe(true);
  });

  it("checks OpenCode scaffold state without writing files", async () => {
    const rootDir = await tempRoot();
    const missing = await checkOpenCodeScaffold(rootDir, { includeOpenCodeRuntime: false });
    expect(missing.ok).toBe(false);
    expect(missing.items.map((item) => item.id)).toContain("mcp_entrypoint");
    await expect(readFile(join(rootDir, "opencode.json"), "utf8")).rejects.toThrow();

    await writeFile(join(rootDir, "opencode.json"), JSON.stringify({ mcp: { team_mcpv2: { command: ["node", "./dist/index.js"] } } }), "utf8");
    const partial = await checkOpenCodeScaffold(rootDir, { includeOpenCodeRuntime: false });
    expect(partial.ok).toBe(false);
    expect(partial.items.find((item) => item.id === "opencode_config")?.ok).toBe(true);
    expect(partial.items.find((item) => item.id === "team_builder_agent")?.ok).toBe(false);

    await writeDummyEntrypoint(rootDir);
    await initOpenCode({ rootDir, serverCommand: ["node", "./dist/index.js"] });
    const ready = await checkOpenCodeScaffold(rootDir, { includeOpenCodeRuntime: false });
    expect(ready.ok).toBe(true);
    expect(ready.items.map((item) => item.id)).toContain("mcp_config");
    expect(ready.items.find((item) => item.id === "command_team-start")?.ok).toBe(true);
    expect(ready.items.find((item) => item.id === "opencode_package")?.ok).toBe(true);
  });

  it("builds a user-authored OpenCode team through draft, confirm, and finalize", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const started = await runOpenCodeTool(store, "team_start", {
      teamName: "manual team",
      hostName: "host",
      hostModel: "anthropic/claude-haiku"
    }) as { team: { id: string }; build: { confirmedMemberIds: string[] } };

    expect(started.build.confirmedMemberIds).toHaveLength(0);

    const draft = await runOpenCodeTool(store, "team_draft_member", {
      teamId: started.team.id,
      name: "Spec Keeper",
      model: "anthropic/claude-sonnet-4.5",
      rawResponsibility: "Keep product requirements clear and challenge vague scope.",
      polishedPrompt: "You keep product requirements clear, identify vague scope, and ask for crisp acceptance criteria.",
      permissions: ["read-only"],
      callWhen: ["requirements are unclear"],
      doNot: ["edit files without explicit instruction"]
    }) as { id: string; agentId: string };

    expect(draft.agentId).toBe("spec-keeper");
    await expect(readFile(join(rootDir, ".opencode", "agents", "spec-keeper.md"), "utf8")).rejects.toThrow();
    await expect(runOpenCodeTool(store, "team_draft_member", {
      teamId: started.team.id,
      name: "Second Draft",
      model: "openai/gpt-5.1",
      rawResponsibility: "Another role",
      polishedPrompt: "Another role"
    })).rejects.toThrow(ConflictError);

    const confirmed = await runOpenCodeTool(store, "team_confirm_member", { teamId: started.team.id }) as {
      member: { name: string; model: string; rawResponsibility: string; polishedPrompt: string };
      agentPath: string;
    };
    const agentFile = await readFile(confirmed.agentPath, "utf8");
    const opencodeConfig = JSON.parse(await readFile(join(rootDir, "opencode.json"), "utf8")) as {
      agent: Record<string, { prompt?: string; model?: string }>;
    };

    expect(confirmed.member.name).toBe("Spec Keeper");
    expect(confirmed.member.model).toBe("anthropic/claude-sonnet-4.5");
    expect(confirmed.member.rawResponsibility).toContain("Keep product requirements");
    expect(confirmed.member.polishedPrompt).toContain("acceptance criteria");
    expect(agentFile).toContain("You keep product requirements clear");
    expect(opencodeConfig.agent["spec-keeper"]?.prompt).toBe("{file:.opencode/agents/spec-keeper.md}");
    expect(opencodeConfig.agent["spec-keeper"]?.model).toBe("anthropic/claude-sonnet-4.5");

    const finalized = await runOpenCodeTool(store, "team_finalize", { teamId: started.team.id }) as {
      reportPrompts: Array<{ prompt: string }>;
      reportingInstructions: string;
      restartMayBeRequired: boolean;
      membersToMention: string[];
    };
    expect(finalized.reportPrompts).toHaveLength(1);
    expect(finalized.reportPrompts[0].prompt).toContain("@spec-keeper");
    expect(finalized.restartMayBeRequired).toBe(true);
    expect(finalized.reportingInstructions).toContain("restart or refresh OpenCode");
    expect(finalized.membersToMention).toEqual(["spec-keeper"]);
  });

  it("runs OpenCode team-friendly tools against the shared store", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const setup = await store.transaction((state) => {
      const teams = new TeamService(state);
      const team = teams.createTeam({ name: "opencode", leadName: "lead" }).team;
      const builder = teams.addMember({ teamId: team.id, name: "builder" });
      const reviewer = teams.addMember({ teamId: team.id, name: "reviewer" });
      const task = new TaskService(state).createTask({ teamId: team.id, title: "wire team mode" });
      return { teamId: team.id, builderId: builder.id, reviewerId: reviewer.id, taskId: task.id };
    });

    const claim = await runOpenCodeTool(store, "team_claim", {
      teamId: setup.teamId,
      taskId: setup.taskId,
      memberId: setup.builderId,
      paths: ["src/**"]
    }) as { lock?: unknown };
    const handoff = await runOpenCodeTool(store, "team_handoff", {
      teamId: setup.teamId,
      fromMemberId: setup.builderId,
      toMemberName: "reviewer",
      taskId: setup.taskId,
      summary: "Implementation is ready for review."
    });
    const inbox = await runOpenCodeTool(store, "team_inbox", { teamId: setup.teamId, memberId: setup.reviewerId }) as unknown[];

    expect(claim).toMatchObject({ task: { id: setup.taskId, status: "claimed" } });
    expect(claim.lock).toBeTruthy();
    expect(handoff).toMatchObject({ toMemberId: setup.reviewerId });
    expect(inbox).toHaveLength(1);
  });

  it("registers the lean default team surface", () => {
    const previous = process.env.TEAM_MCP_EXPERIMENTAL_TOOLS;
    delete process.env.TEAM_MCP_EXPERIMENTAL_TOOLS;
    try {
      const names = registeredToolNames(new JsonStore({ rootDir: "unused" }));
      const definitions = registeredToolDefinitions(new JsonStore({ rootDir: "unused" }));
      expect(names).toEqual(expect.arrayContaining([
        "team_models",
        "team_results",
        "team_status",
        "team_work"
      ]));
      expect(names).not.toEqual(expect.arrayContaining([
        "team_start",
        "team_draft",
        "team_confirm",
        "team_finish",
        "team_run",
        "team_task_create",
        "team_timeline"
      ]));
      expect(definitions.team_work?.description).toContain("Primary team entrypoint");
      expect(definitions.team_status?.description).toContain("Inspect/debug");
      expect(definitions.team_results?.description).toContain("Inspect/debug deliverables");
      expect(definitions.team_models?.description).toContain("List backend models");
    } finally {
      restoreEnv("TEAM_MCP_EXPERIMENTAL_TOOLS", previous);
    }
  });

  it("registers advanced builder and runtime tools only when explicitly enabled", () => {
    const store = new JsonStore({ rootDir: "unused" });
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerTools(server, store, { advancedTools: true });
    const toolRegistry = server as unknown as { _registeredTools: Record<string, { description?: string }> };
    const names = Object.keys(toolRegistry._registeredTools).sort();

    expect(names).toEqual(expect.arrayContaining([
      "team_start",
      "team_draft",
      "team_confirm",
      "team_finish",
      "team_run",
      "team_task_create",
      "team_scheduler_tick",
      "team_scheduler_run",
      "team_timeline",
      "team_runtime_status"
    ]));
    expect(toolRegistry._registeredTools.team_run?.description).toContain("Advanced/manual control");
    expect(toolRegistry._registeredTools.team_start?.description).toContain("Advanced/manual builder control");
  });

  it("keeps runtime-first builder state behind the team-native facade", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerTools(server, store, { backendFactory: () => new FakeAgentBackend(), advancedTools: true });

    await callRegisteredTool(server, "team_start", { teamName: "facade", hostName: "lead" });
    const state = await store.read();
    const build = Object.values(teamBuilds(state))[0];

    expect(build).toMatchObject({ host: { name: "lead" }, status: "building" });
    expect(await readFile("src/builder/teamBuilderService.ts", "utf8")).not.toContain("state.openCode.builds");
    expect(await readFile("src/builder/teamBuilderService.ts", "utf8")).not.toContain("OpenCodeMemberDraft");
    expect(await readFile("src/opencode/teamBuilderService.ts", "utf8")).not.toContain("state.openCode.builds");
    expect(await readFile("src/opencode/teamBuilderService.ts", "utf8")).not.toContain("OpenCodeMemberDraft");
    expect(await readFile("src/opencode/agentFileService.ts", "utf8")).not.toContain("OpenCodeMemberDraft");
    const domainTypes = await readFile("src/domain/types.ts", "utf8");
    expect(domainTypes).not.toContain("LegacyOpenCodeState");
    expect(domainTypes).not.toContain("OpenCodeMemberDraft");
    expect(domainTypes).not.toContain("OpenCodeTeamBuild");
    expect(domainTypes).not.toContain("OpenCodeState");
    expect(await readFile("src/opencode/legacyCollaborationService.ts", "utf8")).not.toContain("state.openCode.builds");
    expect(await readFile("src/opencode/teamStateHelpers.ts", "utf8")).toContain("openCodeBuilds");
    const migrationDoc = await readFile("docs/runtime-migration.md", "utf8");
    expect(migrationDoc).toContain("teamBuilds(state)");
    expect(migrationDoc).toContain("compatibility scaffold code reads build state through an explicit adapter");
    expect(migrationDoc).toContain("old files with only `openCode.builds` migrate into `teamBuilds`");
    expect(migrationDoc).toContain("new writes persist only `teamBuilds`");
  });

  it("keeps the team-builder prompt locked to the user-authored first-session flow", () => {
    const prompt = TEAM_BUILDER_AGENT.prompt;

    expect(prompt).toContain("Use team_mcpv2 to build one user-authored OpenCode team.");
    expect(prompt).toContain("team_start starts or resumes the build.");
    expect(prompt).toContain("team_draft saves exactly one member draft");
    expect(prompt).toContain("team_remove_member removes one confirmed member");
    expect(prompt).toContain("Ask only for missing required details.");
    expect(prompt).toContain("If the user asks you to fill in missing boundaries from their stated constraints");
    expect(prompt).toContain("Do not call team_confirm until the user confirms the checklist.");
    expect(prompt).toContain("Do not call team_finish until the user declines another member.");
    expect(prompt).toContain("After team_finish, send the returned @member prompts in order.");
    expect(prompt).toContain("show the unresolved member id");
    expect(TEAM_BUILDER_AGENT.tools).toMatchObject({ write: false, edit: false, bash: false });
  });

  it("keeps the repository docs focused on the runtime rewrite", async () => {
    const readme = await readFile("README.md", "utf8");

    expect(readme).toContain("runtime-first");
    expect(readme).toContain("docs/runtime-rfc.md");
    expect(readme).toContain("working runtime-first implementation");
    expect(readme).not.toContain("docs/first-session-guide.md");
    expect(readme).not.toContain("docs/dogfood.md");
  });

  it("points new work at the runtime docs and keeps only legacy OpenCode CLI gated by default", async () => {
    const readme = await readFile("README.md", "utf8");
    const runtimeRfc = await readFile(join("docs", "runtime-rfc.md"), "utf8");
    const runtimeApi = await readFile(join("docs", "runtime-api.md"), "utf8");
    const runtimeImplementation = await readFile(join("docs", "runtime-implementation.md"), "utf8");
    const runtimeMigration = await readFile(join("docs", "runtime-migration.md"), "utf8");

    expect(readme).toContain("runtime-rfc.md");
    expect(readme).toContain("default package entrypoint starts the runtime-first MCP server");
    expect(readme).toContain("does not load the legacy scaffold CLI path");
    expect(readme).toContain("First-Run Quickstart");
    expect(readme).toContain("The default product entrypoint is the stdio MCP server in `dist/index.js`");
    expect(readme).toContain("First-run and release readiness are intentionally separate concerns");
    expect(readme).toContain("`team_work`, `team_status`, `team_results`, and `team_models`");
    expect(readme).toContain("Suggested first-run tool flow");
    expect(readme).toContain("`team_models`");
    expect(readme).toContain("TEAM_MCP_ENABLE_ADVANCED_TOOLS=1");
    expect(readme).toContain("`team_work`");
    expect(readme).toContain('"command": ["node", "./dist/index.js"]');
    expect(readme).toContain("Stage 10A keeps release readiness and smoke discipline in place while simplifying the default runtime surface");
    expect(readme).toContain("Recommended release readiness order");
    expect(readme).toContain("npm run build");
    expect(readme).toContain("npm run typecheck");
    expect(readme).toContain("npm test");
    expect(readme).toContain("npm pack --dry-run");
    expect(readme).toContain("must stay offline, deterministic, and free of OpenCode credential requirements");
    expect(readme).toContain("built stdio entrypoint smoke covers the default MCP product surface shipped from `dist/index.js`");
    expect(readme).toContain("real OpenCode smoke only validates the live backend and dogfood path; it does not belong in default CI");
    expect(readme).toContain("TEAM_MCP_REAL_OPENCODE_SMOKE=1 npm test -- tests/runtime.opencode.smoke.test.ts");
    expect(readme).toContain("init-opencode");
    expect(readme).toContain("opencode-tool");
    expect(readme).toContain("dogfood-opencode");
    expect(readme).not.toContain("TEAM_MCP_ENABLE_LEGACY_MCP=1");
    expect(readme).toContain("TEAM_MCP_ENABLE_LEGACY_OPENCODE=1");
    expect(runtimeRfc).toContain("runtime-first team system");
    expect(runtimeRfc).toContain("legacy scaffold-writing behavior kept only as compatibility support");
    expect(runtimeRfc).toContain("Stage 10A: Lean Team Surface And Unified `team_work` Team Entry");
    expect(runtimeRfc).toContain("Stage 10A should keep six things aligned");
    expect(runtimeRfc).toContain("real OpenCode smoke must stay env-gated, live-backend-only, and outside default CI");
    expect(runtimeRfc).toContain("TEAM_MCP_ENABLE_ADVANCED_TOOLS=1");
    expect(runtimeRfc).toContain("Stage 10A is not a new capability phase");
    expect(runtimeRfc).toContain("always-on daemon scheduler");
    expect(runtimeRfc).toContain("worktree or checkpoint isolation");
    expect(runtimeApi).toContain("builder guidance mode");
    expect(runtimeApi).toContain("TEAM_MCP_ENABLE_ADVANCED_TOOLS=1");
    expect(runtimeApi).toContain("AgentSessionRecord");
    expect(runtimeImplementation).toContain("OpenCode Backend Proof");
    expect(runtimeImplementation).toContain("Current Stage 10A Status");
    expect(runtimeImplementation).toContain("`team_work` as the default build-and-work surface");
    expect(runtimeImplementation).toContain("TEAM_MCP_REAL_OPENCODE_SMOKE=1 npm test -- tests/runtime.opencode.smoke.test.ts");
    expect(runtimeImplementation).toContain("default tests must remain offline, deterministic, and free of OpenCode credential requirements");
    expect(runtimeImplementation).toContain("real OpenCode smoke is env-gated live-backend dogfood and should not be re-described as a default CI requirement");
    expect(runtimeImplementation).toContain("default stdio MCP server path is runtime-first and enabled by default");
    expect(runtimeImplementation).toContain("Stage 8H isolates the legacy OpenCode scaffold CLI boundary");
    expect(runtimeImplementation).toContain("TEAM_MCP_ENABLE_LEGACY_OPENCODE=1");
    expect(runtimeImplementation).toContain("TEAM_MCP_ENABLE_ADVANCED_TOOLS=1");
    expect(runtimeMigration).toContain("default MCP registration and package stdio startup are runtime-first");
    expect(runtimeMigration).toContain("default runtime startup and tool registration must not import scaffold-era legacy modules");
    expect(runtimeMigration).toContain("new writes persist only `teamBuilds`");
  });

  it("keeps the default first-run runtime tool surface visible without legacy flags", () => {
    const names = registeredToolNames(new JsonStore({ rootDir: "unused" }));
    const definitions = registeredToolDefinitions(new JsonStore({ rootDir: "unused" }));

    expect(names).toEqual(expect.arrayContaining(["team_models", "team_results", "team_status", "team_work"]));
    expect(names).not.toEqual(expect.arrayContaining(["team_start", "team_draft", "team_confirm", "team_finish", "team_run", "team_task_create"]));
    expect(definitions.team_work?.description).toContain("Primary team entrypoint");
    expect(definitions.team_status?.description).toContain("Inspect/debug");
    expect(definitions.team_results?.description).toContain("Inspect/debug deliverables");
  });

  it("does not expand the default runtime surface through the old experimental flag", () => {
    const previous = process.env.TEAM_MCP_EXPERIMENTAL_TOOLS;
    process.env.TEAM_MCP_EXPERIMENTAL_TOOLS = "1";
    try {
      const names = registeredToolNames(new JsonStore({ rootDir: "unused" }));
      expect(names).not.toContain("create_team");
      expect(names).not.toContain("team_ask");
      expect(names).not.toContain("team_list_models");
      expect(names).not.toContain("team_task_create");
      expect(names).toEqual(expect.arrayContaining(["team_models", "team_results", "team_status", "team_work"]));
      expect(names).not.toEqual(expect.arrayContaining(["team_start", "team_draft", "team_confirm", "team_finish", "team_run", "team_task_create"]));
    } finally {
      restoreEnv("TEAM_MCP_EXPERIMENTAL_TOOLS", previous);
    }
  });

  it("returns team status diagnostics before init, after init, after member creation, and after finalization", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const started = await runOpenCodeTool(store, "team_start", { teamName: "diagnostics" }) as { team: { id: string } };
    const beforeInit = await runOpenCodeTool(store, "team_status", { teamId: started.team.id }) as {
      diagnostics: { scaffold: { ok: boolean }; agentFiles: unknown[] };
      finalized: boolean;
    };
    expect(beforeInit.diagnostics.scaffold.ok).toBe(false);
    expect(beforeInit.finalized).toBe(false);

    await writeDummyEntrypoint(rootDir);
    await initOpenCode({ rootDir, serverCommand: ["node", "./dist/index.js"] });
    const afterInit = await runOpenCodeTool(store, "team_status", { teamId: started.team.id }) as {
      diagnostics: { scaffold: { ok: boolean }; agentFiles: unknown[] };
    };
    expect(afterInit.diagnostics.scaffold.ok).toBe(true);

    await runOpenCodeTool(store, "team_draft", {
      teamId: started.team.id,
      name: "Reporter",
      model: "test/model",
      rawResponsibility: "Report status.",
      polishedPrompt: "Report status clearly."
    });
    await runOpenCodeTool(store, "team_confirm", { teamId: started.team.id });
    const afterMember = await runOpenCodeTool(store, "team_status", { teamId: started.team.id }) as {
      diagnostics: { agentFiles: Array<{ exists: boolean }> };
    };
    expect(afterMember.diagnostics.agentFiles).toEqual([expect.objectContaining({ exists: true })]);

    await runOpenCodeTool(store, "team_finish", { teamId: started.team.id });
    const finalized = await runOpenCodeTool(store, "team_status", { teamId: started.team.id }) as {
      finalized: boolean;
      membersToMention: string[];
      reportPrompts: unknown[];
    };
    expect(finalized.finalized).toBe(true);
    expect(finalized.membersToMention).toEqual(["reporter"]);
    expect(finalized.reportPrompts).toHaveLength(1);
    expect(finalized).not.toHaveProperty("tasks");
    expect(finalized).not.toHaveProperty("pathLocks");
    expect(finalized).not.toHaveProperty("unreadMessages");
    expect(finalized).not.toHaveProperty("runtime");
  });

  it("runs a CLI-level dogfood smoke without expanding the public tool surface", async () => {
    const rootDir = await tempRoot();
    await writeDummyEntrypoint(rootDir);
    const result = await runOpenCodeDogfoodSmoke({
      rootDir,
      serverCommand: ["node", "./dist/index.js"],
      includeOpenCodeRuntime: false
    });

    expect(result.ok).toBe(true);
    expect(result.doctor.ok).toBe(true);
    expect(result.agentList.includesTeamBuilder).toBe(true);
    expect(result.flow.membersToMention).toEqual(["scope-keeper", "patch-builder"]);
    expect(result.flow.reportPromptCount).toBe(2);
    expect(result.flow.finalized).toBe(true);
    expect(result.flow.statusHasCoordinationFields).toBe(false);
    expect(result.flow.generatedAgents).toHaveLength(2);
    expect(result.flow.stateExists).toBe(true);
    expect(registeredToolNames(new JsonStore({ rootDir: "unused" }))).not.toContain("team_run");
  });

  it("runs the team builder service flow without MCP registration", async () => {
    const rootDir = await tempRoot();
    const state = emptyState();
    const started = teamStart(state, { teamName: "service flow", hostName: "host" }) as { team: { id: string } };
    const draft = teamDraftMember(state, {
      teamId: started.team.id,
      name: "Scope Editor",
      model: "test/model",
      rawResponsibility: "Keep scope tight.",
      polishedPrompt: "Keep scope tight and ask for concrete acceptance criteria."
    });

    expect(draft.agentId).toBe("scope-editor");
    const confirmed = await teamConfirmMember(state, rootDir, { teamId: started.team.id }) as { member: { agentId: string }; agentPath: string };
    const finished = teamFinish(state, { teamId: started.team.id }) as { reportPrompts: Array<{ prompt: string }> };

    expect(confirmed.member.agentId).toBe("scope-editor");
    expect(await readFile(confirmed.agentPath, "utf8")).toContain("Keep scope tight");
    expect(finished.reportPrompts[0].prompt).toContain("@scope-editor");
  });

  it("registers confirmed generated members in opencode.json for mention resolution", async () => {
    const rootDir = await tempRoot();
    await writeDummyEntrypoint(rootDir);
    await initOpenCode({ rootDir, serverCommand: ["node", "./dist/index.js"] });
    const store = new JsonStore({ rootDir });
    const started = await runOpenCodeTool(store, "team_start", { teamName: "registration" }) as { team: { id: string } };

    await runOpenCodeTool(store, "team_draft", {
      teamId: started.team.id,
      name: "Patch Builder",
      model: "openai/gpt-5.4",
      rawResponsibility: "Implement a small confirmed patch.",
      polishedPrompt: "Implement a small confirmed patch and report changed files."
    });
    await runOpenCodeTool(store, "team_confirm", { teamId: started.team.id });

    const config = JSON.parse(await readFile(join(rootDir, "opencode.json"), "utf8")) as {
      agent: Record<string, { mode?: string; prompt?: string; model?: string }>;
    };

    expect(config.agent["patch-builder"]?.mode).toBe("subagent");
    expect(config.agent["patch-builder"]?.prompt).toBe("{file:.opencode/agents/patch-builder.md}");
    expect(config.agent["patch-builder"]?.model).toBe("openai/gpt-5.4");
  });

  it("runs runtime-aware MCP tools with a fake backend", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new FakeAgentBackend();
    const server = registeredServer(store, { backendFactory: () => backend });
    const started = await callRegisteredTool(server, "team_start", { teamName: "runtime tools" }) as { result: { team: { id: string } } };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Patch Builder",
      model: "test/model",
      rawResponsibility: "Implement small patches.",
      polishedPrompt: "Implement small patches and report changed files."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    const finished = await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id }) as { result: { runtime: { status: string } } };
    const task = await callRegisteredTool(server, "team_task_create", {
      teamId: started.result.team.id,
      title: "Wire runtime tools",
      priority: "high"
    }) as { result: { id: string; priority: string } };
    const running = await callRegisteredTool(server, "team_run", { teamId: started.result.team.id, maxParallel: 1 }) as { result: { status: string; sessions: Array<{ memberId: string }> } };
    const memberId = running.result.sessions[0]!.memberId;
    const assigned = await callRegisteredTool(server, "team_assign", {
      teamId: started.result.team.id,
      taskId: task.result.id,
      memberId
    }) as { result: { preferredMemberId: string } };
    const updated = await callRegisteredTool(server, "team_task_update", {
      teamId: started.result.team.id,
      taskId: task.result.id,
      description: "Exercise the unified runtime surface.",
      pathHints: ["src/tools/runtimeTools.ts"]
    }) as { result: { description: string; pathHints: string[] } };
    const tick = await callRegisteredTool(server, "team_scheduler_tick", { teamId: started.result.team.id }) as { result: { assignments: Array<{ taskId: string }> } };
    const run = await callRegisteredTool(server, "team_scheduler_run", { teamId: started.result.team.id, maxTicks: 3 }) as {
      result: { ticksRun: number; totalAssignments: number; stoppedReason: string; decisions: Array<{ decision: string }> };
    };
    const selfStatus = await callRegisteredTool(server, "team_self_status", {
      teamId: started.result.team.id,
      memberId
    }) as { result: { activeTask: { id: string } } };
    await callRegisteredTool(server, "send_message", {
      teamId: started.result.team.id,
      fromMemberId: memberId,
      type: "result",
      subject: "Runtime surface",
      body: "The runtime surface is wired."
    });
    const completed = await callRegisteredTool(server, "complete_task", {
      teamId: started.result.team.id,
      taskId: task.result.id,
      memberId,
      completionSummary: "Runtime tools completed the task.",
      resultArtifacts: ["src/tools/runtimeTools.ts"]
    }) as { result: { status: string; completionSummary: string } };
    await callRegisteredTool(server, "team_scheduler_tick", { teamId: started.result.team.id });
    const timeline = await callRegisteredTool(server, "team_timeline", { teamId: started.result.team.id }) as {
      result: {
        events: Array<{ type: string }>;
        messages: Array<{ type: string }>;
        entries: Array<{ kind: string; taskId?: string }>;
        taskThreads: Array<{ task: { id: string }; events: Array<{ type: string }>; messages: Array<{ type: string }>; statusReason: string }>;
      };
    };
    const results = await callRegisteredTool(server, "team_results", { teamId: started.result.team.id }) as {
      result: {
        completedTasks: Array<{ id: string }>;
        resultMessages: Array<{ subject: string }>;
        taskResults: Array<{ task: { id: string }; resultMessages: Array<{ subject: string }>; summary: string; artifacts: string[] }>;
        memberContributions: Array<{
          memberId: string;
          memberName: string;
          completedTaskIds: string[];
          failedTaskIds: string[];
          resultMessageIds: string[];
          latestContributionSummary?: string;
        }>;
        compactResults: {
          team: { id: string; name: string };
          phase: string;
          headline: string;
          topResult: string;
          latestTask?: { id: string; title: string; status: string; memberName?: string; summary?: string };
          memberInvolvement: Array<{ memberId: string; memberName: string; completedCount: number; resultMessageCount: number }>;
        };
        explain: { phase: string; headline: string; resultSummary: string; recommendedNextAction: string; lastMeaningfulEvent?: { type: string } };
      };
    };
    const status = await callRegisteredTool(server, "team_status", { teamId: started.result.team.id }) as {
      result: {
        runtime: { status: string };
        sessions: Array<{ status: string }>;
        tasks: { completed: Array<{ id: string }> };
        recentEvents: Array<{ type: string }>;
        compactStatus: {
          team: { id: string; name: string };
          phase: string;
          headline: string;
          supportingLine: string;
          recentActivity: { activeTaskCount: number; unreadMessageCount: number; failedTaskCount: number; blockedTaskCount: number };
          nextAction: string;
        };
        explain: { phase: string; headline: string; recommendedNextAction: string; lastMeaningfulEvent?: { type: string } };
      };
    };

    expect(finished.result.runtime.status).toBe("ready");
    expect(task.result.priority).toBe("high");
    expect(assigned.result.preferredMemberId).toBe(memberId);
    expect(updated.result.pathHints).toEqual(["src/tools/runtimeTools.ts"]);
    expect(running.result.status).toBe("running");
    expect(running.result.sessions).toHaveLength(1);
    expect(tick.result.assignments).toEqual([expect.objectContaining({ taskId: task.result.id })]);
    expect(run.result).toMatchObject({ ticksRun: 1, totalAssignments: 0, stoppedReason: "idle" });
    expect(run.result.decisions[0]?.decision).toBe("No runnable assignments");
    expect(selfStatus.result.activeTask.id).toBe(task.result.id);
    expect(completed.result.status).toBe("completed");
    expect(completed.result.completionSummary).toContain("Runtime tools completed");
    expect(timeline.result.events.map((event) => event.type)).toContain("task.completed");
    expect(timeline.result.messages).toEqual([expect.objectContaining({ type: "result" })]);
    expect(timeline.result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "event", taskId: task.result.id }),
      expect.objectContaining({ kind: "message" })
    ]));
    expect(timeline.result.taskThreads).toEqual([expect.objectContaining({
      task: expect.objectContaining({ id: task.result.id }),
      events: expect.arrayContaining([expect.objectContaining({ type: "task.completed" })]),
      statusReason: expect.stringContaining("Runtime tools completed")
    })]);
    expect(results.result.completedTasks).toEqual([expect.objectContaining({ id: task.result.id })]);
    expect(results.result.resultMessages).toEqual([expect.objectContaining({ subject: "Runtime surface" })]);
    expect(results.result.taskResults).toEqual([expect.objectContaining({
      task: expect.objectContaining({ id: task.result.id }),
      resultMessages: [],
      summary: "Runtime tools completed the task.",
      artifacts: ["src/tools/runtimeTools.ts"]
    })]);
    expect(results.result.memberContributions).toEqual([expect.objectContaining({
      memberId,
      memberName: "Patch Builder",
      completedTaskIds: [task.result.id],
      failedTaskIds: [],
      resultMessageIds: [expect.any(String)],
      latestContributionSummary: "Runtime tools completed the task."
    })]);
    expect(results.result.explain).toMatchObject({
      phase: "attention",
      headline: "1 unread runtime message needs attention.",
      resultSummary: "Current attention state: Runtime surface",
      recommendedNextAction: "Review unread runtime messages or route them to the relevant teammate.",
      lastMeaningfulEvent: expect.objectContaining({ type: expect.any(String) })
    });
    expect(results.result.compactResults).toMatchObject({
      team: { id: started.result.team.id, name: "runtime tools" },
      phase: "attention",
      headline: "1 unread runtime message needs attention.",
      topResult: "Current attention state: Runtime surface",
      supportingLine: "Runtime surface",
      latestTask: {
        id: task.result.id,
        title: "Wire runtime tools",
        status: "completed",
        memberName: "Patch Builder",
        summary: "Runtime tools completed the task."
      },
      memberInvolvement: [expect.objectContaining({
        memberId,
        memberName: "Patch Builder",
        completedCount: 1,
        resultMessageCount: 1
      })]
    });
    expect(status.result.runtime.status).toBe("running");
    expect(status.result.sessions).toEqual([expect.objectContaining({ status: "idle" })]);
    expect(status.result.tasks.completed).toEqual([expect.objectContaining({ id: task.result.id })]);
    expect(status.result.recentEvents.map((event) => event.type)).toContain("scheduler.assignment");
    expect(status.result.explain).toMatchObject({
      phase: "attention",
      headline: expect.stringContaining("unread runtime message"),
      recommendedNextAction: "Review unread runtime messages or route them to the relevant teammate.",
      lastMeaningfulEvent: expect.objectContaining({ type: expect.any(String) })
    });
    expect(status.result.compactStatus).toMatchObject({
      team: { id: started.result.team.id, name: "runtime tools" },
      phase: "attention",
      headline: expect.stringContaining("unread runtime message"),
      supportingLine: "Runtime surface",
      recentActivity: {
        activeTaskCount: 0,
        unreadMessageCount: 1,
        failedTaskCount: 0,
        blockedTaskCount: 0
      },
      nextAction: expect.any(String)
    });
  });

  it("does not attribute a newer session summary to an older completed task", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new FakeAgentBackend();
    const server = registeredServer(store, { backendFactory: () => backend });
    const started = await callRegisteredTool(server, "team_start", { teamName: "result attribution" }) as { result: { team: { id: string } } };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Patch Builder",
      model: "test/model",
      rawResponsibility: "Implement patches.",
      polishedPrompt: "Implement patches and complete tasks."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });
    const running = await callRegisteredTool(server, "team_run", { teamId: started.result.team.id, maxParallel: 1 }) as { result: { sessions: Array<{ memberId: string }> } };
    const memberId = running.result.sessions[0]!.memberId;

    const first = await callRegisteredTool(server, "team_task_create", { teamId: started.result.team.id, title: "First task" }) as { result: { id: string } };
    await callRegisteredTool(server, "team_scheduler_tick", { teamId: started.result.team.id });
    await callRegisteredTool(server, "complete_task", {
      teamId: started.result.team.id,
      taskId: first.result.id,
      memberId,
      completionSummary: "First summary"
    });

    const second = await callRegisteredTool(server, "team_task_create", { teamId: started.result.team.id, title: "Second task" }) as { result: { id: string } };
    await callRegisteredTool(server, "team_scheduler_tick", { teamId: started.result.team.id });
    const results = await callRegisteredTool(server, "team_results", { teamId: started.result.team.id }) as {
      result: { taskResults: Array<{ task: { id: string }; summary?: string }> };
    };

    expect(results.result.taskResults.find((entry) => entry.task.id === first.result.id)?.summary).toBe("First summary");
    expect(results.result.taskResults.find((entry) => entry.task.id === second.result.id)).toBeUndefined();
  });

  it("explains failed task results and task-scoped messages", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new FakeAgentBackend();
    const server = registeredServer(store, { backendFactory: () => backend });
    const started = await callRegisteredTool(server, "team_start", { teamName: "failed results" }) as { result: { team: { id: string } } };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Failure Reporter",
      model: "test/model",
      rawResponsibility: "Report failed runtime tasks.",
      polishedPrompt: "Report failed runtime tasks."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });
    const running = await callRegisteredTool(server, "team_run", { teamId: started.result.team.id, maxParallel: 1 }) as { result: { sessions: Array<{ memberId: string }> } };
    const memberId = running.result.sessions[0]!.memberId;
    const task = await callRegisteredTool(server, "team_task_create", {
      teamId: started.result.team.id,
      title: "Fail with explanation",
      preferredMemberId: memberId
    }) as { result: { id: string } };

    await callRegisteredTool(server, "claim_task", {
      teamId: started.result.team.id,
      taskId: task.result.id,
      memberId
    });
    await callRegisteredTool(server, "send_message", {
      teamId: started.result.team.id,
      fromMemberId: memberId,
      taskId: task.result.id,
      type: "result",
      subject: "Failure details",
      body: "Blocked by missing fixture."
    });
    await callRegisteredTool(server, "fail_task", {
      teamId: started.result.team.id,
      taskId: task.result.id,
      memberId,
      failureSummary: "Missing fixture prevented completion."
    });

    const timeline = await callRegisteredTool(server, "team_timeline", { teamId: started.result.team.id }) as {
      result: {
        taskThreads: Array<{ task: { id: string }; messages: Array<{ subject: string }>; statusReason: string }>;
      };
    };
    const results = await callRegisteredTool(server, "team_results", { teamId: started.result.team.id }) as {
      result: {
        failedTasks: Array<{ id: string }>;
        taskResults: Array<{ task: { id: string }; resultMessages: Array<{ subject: string }>; summary: string }>;
        failuresNeedingAttention: Array<{ task: { id: string }; summary: string }>;
        memberContributions: Array<{
          memberId: string;
          memberName: string;
          completedTaskIds: string[];
          failedTaskIds: string[];
          resultMessageIds: string[];
          latestContributionSummary?: string;
        }>;
        compactResults: {
          phase: string;
          headline: string;
          topResult: string;
          supportingLine: string;
          continuation?: { kind: string };
          latestTask?: { id: string; title: string; status: string; memberName?: string; summary?: string };
          memberInvolvement: Array<{ memberId: string; memberName: string; failedCount: number; resultMessageCount: number }>;
        };
        explain: {
          phase: string;
          headline: string;
          resultSummary: string;
          failureSummary?: string;
          blockingReason?: string;
          recoveryHint?: string;
          continuation?: { kind: string };
        };
      };
    };

    expect(timeline.result.taskThreads).toEqual([expect.objectContaining({
      task: expect.objectContaining({ id: task.result.id }),
      messages: [expect.objectContaining({ subject: "Failure details" })],
      statusReason: "Missing fixture prevented completion."
    })]);
    expect(results.result.failedTasks).toEqual([expect.objectContaining({ id: task.result.id })]);
    expect(results.result.taskResults).toEqual([expect.objectContaining({
      task: expect.objectContaining({ id: task.result.id }),
      resultMessages: [expect.objectContaining({ subject: "Failure details" })],
      summary: "Missing fixture prevented completion."
    })]);
    expect(results.result.failuresNeedingAttention).toEqual([expect.objectContaining({
      task: expect.objectContaining({ id: task.result.id }),
      summary: "Missing fixture prevented completion."
    })]);
    expect(results.result.memberContributions).toEqual([expect.objectContaining({
      memberId,
      memberName: "Failure Reporter",
      completedTaskIds: [],
      failedTaskIds: [task.result.id],
      resultMessageIds: [expect.any(String)],
      latestContributionSummary: "Missing fixture prevented completion."
    })]);
    expect(results.result.explain).toMatchObject({
      phase: "attention",
      headline: expect.stringContaining("Latest failure from Failure Reporter:"),
      resultSummary: expect.stringContaining("latest: Fail with explanation by Failure Reporter"),
      failureSummary: "Missing fixture prevented completion.",
      blockingReason: "Missing fixture prevented completion.",
      recoveryHint: "Create follow-up work after reviewing the failed task summary.",
      continuation: { kind: "create_followup_task" }
    });
    expect(results.result.compactResults).toMatchObject({
      phase: "attention",
      headline: expect.stringContaining("Latest failure from Failure Reporter:"),
      topResult: "Missing fixture prevented completion.",
      supportingLine: "Missing fixture prevented completion.",
      continuation: { kind: "create_followup_task" },
      latestTask: {
        id: task.result.id,
        title: "Fail with explanation",
        status: "failed",
        memberName: "Failure Reporter",
        summary: "Missing fixture prevented completion."
      },
      memberInvolvement: [expect.objectContaining({
        memberId,
        memberName: "Failure Reporter",
        failedCount: 1,
        resultMessageCount: 1
      })]
    });
  });

  it("returns compact empty-state status when runtime is ready without active work", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const server = registeredServer(store, { backendFactory: () => new FakeAgentBackend(), advancedTools: false });

    const started = await callRegisteredTool(server, "team_work", { team: { teamName: "ready compact status" } }) as {
      result: { team: { id: string } };
    };
    const teamId = started.result.team.id;

    await callRegisteredTool(server, "team_work", {
      teamId,
      builder: {
        draftMember: {
          name: "Ready Worker",
          model: "test/model",
          rawResponsibility: "Stay ready for future work.",
          polishedPrompt: "Stay ready for future work and wait for assignment."
        }
      }
    });
    await callRegisteredTool(server, "team_work", { teamId, builder: { confirmMember: true } });
    await callRegisteredTool(server, "team_work", { teamId, builder: { finishTeam: true } });

    const status = await callRegisteredTool(server, "team_status", { teamId }) as {
      result: {
        compactStatus: {
          phase: string;
          headline: string;
          supportingLine: string;
          emptyState?: string;
          nextAction: string;
        };
      };
    };

    expect(status.result.compactStatus).toMatchObject({
      phase: "running",
      headline: expect.stringContaining("0 active task"),
      supportingLine: "No immediate host action detected from runtime state.",
      emptyState: "No active task yet.",
      nextAction: "No immediate host action detected from runtime state."
    });
  });

  it("keeps builder guidance recommendedInput grouped even when starting from flat compatibility fields", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const server = registeredServer(store, { backendFactory: () => new FakeAgentBackend(), advancedTools: false });

    const started = await callRegisteredTool(server, "team_work", {
      teamName: "flat compatibility start",
      request: "Create the first teammate."
    }) as {
      result: {
        mode: string;
        team: { id: string };
        recommendedInput: Record<string, unknown>;
      };
    };

    expect(started.result.mode).toBe("builder_guidance");
    expect(started.result.recommendedInput).toMatchObject({
      teamId: started.result.team.id,
      builder: { draftMember: { name: "Your Teammate Name" } }
    });
    expect(started.result.recommendedInput).not.toHaveProperty("draftMember");
    expect(started.result.recommendedInput).not.toHaveProperty("teamName");
  });

  it("runs task-first team work through the primary tool", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new FakeAgentBackend();
    const server = registeredServer(store, { backendFactory: () => backend });
    const started = await callRegisteredTool(server, "team_start", { teamName: "team work" }) as { result: { team: { id: string } } };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Patch Builder",
      model: "test/model",
      rawResponsibility: "Implement focused task changes.",
      polishedPrompt: "Implement focused task changes and complete runtime tasks."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });

    const worked = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      goal: "Wire task-first team_work",
      pathHints: ["src/runtime/teamWork.ts"],
      priority: "high",
      maxTicks: 2
    }) as {
      result: {
        task: { id: string; title: string; status: string; priority: string; pathHints: string[] };
        runtime: { status: string };
        schedulerRun: { totalAssignments: number; decisions: Array<{ assignments: Array<{ taskId: string }> }> };
        view: { taskStatus: string; summary: string; runnableCount: number; activeCount: number; background?: { status: string; stoppedReason?: string; totalAssignments: number } };
        explain: { phase: string; headline: string; recommendedNextAction: string };
        nextPrompt: string;
        details?: unknown;
      };
    };
    const continued = await callRegisteredTool(server, "team_work", { teamId: started.result.team.id, maxTicks: 1 }) as {
      result: { schedulerRun: { totalAssignments: number; stoppedReason: string }; view: { activeCount: number; runnableCount: number } };
    };
    const tasks = await callRegisteredTool(server, "team_tasks", { teamId: started.result.team.id }) as { result: Array<{ id: string }> };

    expect(worked.result.task).toMatchObject({ title: "Wire task-first team_work", status: "claimed", priority: "high", pathHints: ["src/runtime/teamWork.ts"] });
    expect(worked.result.runtime.status).toBe("running");
    expect(worked.result.schedulerRun.totalAssignments).toBe(1);
    expect(worked.result.schedulerRun.decisions[0]?.assignments).toEqual([expect.objectContaining({ taskId: worked.result.task.id })]);
    expect(worked.result.view).toMatchObject({
      taskStatus: "claimed",
      runnableCount: 0,
      activeCount: 1
    });
    expect(worked.result.view.background).toBeUndefined();
    expect(worked.result.view.summary).toContain(worked.result.task.id);
    expect(worked.result.explain).toMatchObject({
      phase: "running",
      headline: expect.stringContaining("active task"),
      recommendedNextAction: expect.any(String)
    });
    expect(worked.result.nextPrompt).toContain(`Continue team_work for claimed task ${worked.result.task.id}`);
    expect(worked.result.recommendedInput).toMatchObject({
      teamId: started.result.team.id,
      work: { taskId: worked.result.task.id, autoRun: true }
    });
    expect(worked.result.details).toBeUndefined();
    expect(continued.result.schedulerRun).toMatchObject({ totalAssignments: 0, stoppedReason: "idle" });
    expect(continued.result.view.activeCount).toBe(1);
    expect(continued.result.view.runnableCount).toBe(0);
    expect(tasks.result).toHaveLength(1);
  });

  it("keeps team_work compact by default and expands details on demand", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new FakeAgentBackend();
    const server = registeredServer(store, { backendFactory: () => backend });
    const started = await callRegisteredTool(server, "team_start", { teamName: "team work details" }) as { result: { team: { id: string } } };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Daily Worker",
      model: "test/model",
      rawResponsibility: "Handle daily task-first work.",
      polishedPrompt: "Handle daily task-first work and complete assigned runtime tasks.",
      permissions: ["read", "edit"]
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });

    const created = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      goal: "Ship compact default team_work UX",
      preferredMemberId: undefined,
      maxTicks: 1,
      includeDetails: false
    }) as {
      result: {
        task: { id: string; status: string };
        details?: unknown;
        nextPrompt: string;
      };
    };
    const continued = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      taskId: created.result.task.id,
      includeDetails: true,
      maxTicks: 1
    }) as {
      result: {
        task: { id: string; status: string };
        details?: {
          controlPlane: { nextActions: string[]; activeWork: Array<{ taskId: string }> };
          results: { taskResults: unknown[] };
          timeline: { taskThreads: Array<{ task: { id: string } }> };
        };
        nextPrompt: string;
      };
    };
    const resumed = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      includeDetails: false,
      maxTicks: 1
    }) as {
      result: {
        details?: unknown;
        nextPrompt: string;
      };
    };

    expect(created.result.details).toBeUndefined();
    expect(created.result.nextPrompt).toContain(`task ${created.result.task.id}`);
    expect(created.result.recommendedInput).toMatchObject({
      teamId: started.result.team.id,
      work: { taskId: created.result.task.id, autoRun: true }
    });
    expect(continued.result.task.id).toBe(created.result.task.id);
    expect(continued.result.details?.controlPlane.activeWork).toEqual([
      expect.objectContaining({ task: expect.objectContaining({ id: created.result.task.id }) })
    ]);
    expect(Array.isArray(continued.result.details?.results.taskResults)).toBe(true);
    expect(continued.result.details?.timeline.taskThreads).toEqual([expect.objectContaining({ task: expect.objectContaining({ id: created.result.task.id }) })]);
    expect(continued.result.recommendedInput).toMatchObject({
      teamId: started.result.team.id,
      work: { taskId: created.result.task.id, includeDetails: true, autoRun: true }
    });
    expect(resumed.result.details).toBeUndefined();
    expect(resumed.result.nextPrompt).toContain("Continue team_work for");
    expect(resumed.result.recommendedInput).toMatchObject({
      teamId: started.result.team.id,
      work: { goal: "Describe the next task to run", autoRun: true }
    });
  });

  it("persists bounded progress for team_work and exposes it through status and results", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new FakeAgentBackend();
    const server = registeredServer(store, { backendFactory: () => backend });
    const started = await callRegisteredTool(server, "team_start", { teamName: "bounded progress" }) as { result: { team: { id: string } } };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Bounded Worker",
      model: "test/model",
      rawResponsibility: "Handle bounded background progress.",
      polishedPrompt: "Handle bounded background progress and report status."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });

    const worked = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      work: {
        goal: "Record bounded progress",
        maxTicks: 2,
        background: { enabled: true, timeoutMs: 5000 }
      }
    }) as {
      result: {
        schedulerRun: { ticksRun: number; totalAssignments: number; stoppedReason: string };
        view: { background?: { status: string; stoppedReason?: string; ticksRun: number; totalAssignments: number; timeoutMs?: number } };
      };
    };
    const status = await callRegisteredTool(server, "team_status", { teamId: started.result.team.id }) as {
      result: {
        scheduler?: { background?: { status: string; stoppedReason?: string; ticksRun: number; totalAssignments: number; timeoutMs?: number } };
        compactStatus: { background?: { status: string; stoppedReason?: string; ticksRun: number; totalAssignments: number } };
      };
    };
    const results = await callRegisteredTool(server, "team_results", { teamId: started.result.team.id }) as {
      result: {
        compactResults: { latestBoundedRun?: { status: string; stoppedReason?: string; ticksRun: number; totalAssignments: number } };
      };
    };

    expect(worked.result.schedulerRun).toMatchObject({ ticksRun: 2, totalAssignments: 1, stoppedReason: "idle" });
    expect(worked.result.view.background).toMatchObject({ status: "idle", stoppedReason: "idle", ticksRun: 2, totalAssignments: 1, timeoutMs: 5000 });
    expect(status.result.scheduler?.background).toMatchObject({ status: "idle", stoppedReason: "idle", ticksRun: 2, totalAssignments: 1, timeoutMs: 5000 });
    expect(status.result.compactStatus.background).toMatchObject({ status: "idle", stoppedReason: "idle", ticksRun: 2, totalAssignments: 1 });
    expect(results.result.compactResults.latestBoundedRun).toMatchObject({ status: "idle", stoppedReason: "idle", ticksRun: 2, totalAssignments: 1 });
  });

  it("stops bounded background progress for unread escalation that needs host review", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new FakeAgentBackend();
    const server = registeredServer(store, { backendFactory: () => backend });
    const started = await callRegisteredTool(server, "team_start", { teamName: "attention escalation" }) as { result: { team: { id: string } } };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Worker",
      model: "test/model",
      rawResponsibility: "Handle tasks.",
      polishedPrompt: "Handle tasks."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });

    const task = await callRegisteredTool(server, "team_task_create", {
      teamId: started.result.team.id,
      title: "Review escalation before continuing"
    }) as { result: { id: string } };
    await callRegisteredTool(server, "team_message", {
      teamId: started.result.team.id,
      taskId: task.result.id,
      type: "escalation",
      subject: "Need host decision",
      body: "Please review before rerunning this task."
    });

    const worked = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      work: {
        taskId: task.result.id,
        maxTicks: 3,
        background: { enabled: true, timeoutMs: 5000 }
      }
    }) as {
      result: {
        schedulerRun: { stoppedReason: string; needsAttentionReason?: string; ticksRun: number; totalAssignments: number };
        view: { background?: { status: string; stoppedReason?: string; needsAttentionReason?: string } };
      };
    };

    expect(worked.result.schedulerRun).toMatchObject({
      stoppedReason: "needs_attention",
      needsAttentionReason: 'Discussion "Need host decision": A host escalation is holding the current round for judgment.',
      ticksRun: 0,
      totalAssignments: 0
    });
    expect(worked.result.view.background).toMatchObject({
      status: "needs_attention",
      stoppedReason: "needs_attention",
      needsAttentionReason: 'Discussion "Need host decision": A host escalation is holding the current round for judgment.'
    });
  });

  it("does not stop bounded background progress for teammate-directed task questions", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new FakeAgentBackend();
    const server = registeredServer(store, { backendFactory: () => backend });
    const started = await callRegisteredTool(server, "team_start", { teamName: "teammate question" }) as { result: { team: { id: string } } };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Worker",
      model: "test/model",
      rawResponsibility: "Handle tasks.",
      polishedPrompt: "Handle tasks."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });
    const runtime = await callRegisteredTool(server, "team_run", { teamId: started.result.team.id, maxParallel: 1 }) as {
      result: { sessions: Array<{ memberId: string }> };
    };

    const memberId = runtime.result.sessions[0]!.memberId;
    const task = await callRegisteredTool(server, "team_task_create", {
      teamId: started.result.team.id,
      title: "Continue after teammate question"
    }) as { result: { id: string } };
    await callRegisteredTool(server, "team_message", {
      teamId: started.result.team.id,
      toMemberId: memberId,
      taskId: task.result.id,
      type: "question",
      subject: "API shape",
      body: "Please confirm the response schema."
    });

    const worked = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      work: {
        taskId: task.result.id,
        maxTicks: 3,
        background: { enabled: true, timeoutMs: 5000 }
      }
    }) as {
      result: {
        schedulerRun: { stoppedReason: string; ticksRun: number; totalAssignments: number; needsAttentionReason?: string };
        view: { background?: { status: string; stoppedReason?: string; needsAttentionReason?: string } };
      };
    };

    expect(worked.result.schedulerRun.stoppedReason).toBe("idle");
    expect(worked.result.schedulerRun.ticksRun).toBe(2);
    expect(worked.result.schedulerRun.totalAssignments).toBe(1);
    expect(worked.result.schedulerRun.needsAttentionReason).toBeUndefined();
    expect(worked.result.view.background).toMatchObject({ status: "idle", stoppedReason: "idle" });
    expect(worked.result.view.background?.needsAttentionReason).toBeUndefined();
  });

  it("starts a team discussion through team_work and returns a same-thread recommendedInput", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new FakeAgentBackend();
    const server = registeredServer(store, { backendFactory: () => backend });
    const started = await callRegisteredTool(server, "team_start", { teamName: "discussion team" }) as { result: { team: { id: string } } };
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Author",
      model: "test/model",
      rawResponsibility: "Offer implementation opinions.",
      polishedPrompt: "Offer implementation opinions."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Reviewer",
      model: "test/model",
      rawResponsibility: "Offer review opinions.",
      polishedPrompt: "Offer review opinions."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });

    const discussed = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      work: {
        discussion: {
          subject: "Stage 14 direction",
          body: "Each member should share one opinion.",
          autoRun: false,
          maxTurns: 2
        }
      }
    }) as {
      result: {
        discussion: { id: string; threadId: string; subject: string };
        recommendedInput: { teamId: string; work: { discussion: { replyToMessageId: string; subject: string; body: string; autoRun: boolean } } };
        view: { unreadMessageCount: number };
      };
    };
    const status = await callRegisteredTool(server, "team_status", { teamId: started.result.team.id }) as {
      result: {
        controlPlane: {
          inbox: {
            activeThreads: Array<{
              threadId: string;
              lifecycleState: string;
              resolutionState: string;
              actionabilityState: string;
              suggestedActionSummary: string;
              turnTakingState: string;
              nextResponsibleMemberIds: string[];
              nextResponsibleMemberNames: string[];
              nextTurnSummary?: string;
              pendingMemberIds: string[];
              currentRoundSummary: string;
              synthesis: { resolutionState: string; summary: string };
              proposedNextAction: { kind: string; summary: string };
            }>;
            discussionProgressSummary?: string;
            discussionHostAttentionSummary?: string;
          };
        };
        compactStatus: {
          recentActivity: { unreadMessageCount: number };
          supportingLine: string;
          discussion?: {
            lifecycleState: string;
            resolutionState: string;
            actionabilityState: string;
            suggestedActionSummary: string;
            turnTakingState: string;
            nextResponsibleMemberIds: string[];
            nextResponsibleMemberNames: string[];
            nextTurnSummary?: string;
            progressSummary: string;
            synthesis: { resolutionState: string; summary: string };
            hostAttentionSummary?: string;
            proposedNextAction: { kind: string; summary: string };
          };
        };
      };
    };

    expect(discussed.result.discussion).toMatchObject({
      id: discussed.result.discussion.threadId,
      subject: "Stage 14 direction"
    });
    expect(discussed.result.recommendedInput).toMatchObject({
      teamId: started.result.team.id,
      work: {
        discussion: {
          replyToMessageId: discussed.result.discussion.id,
          subject: "Stage 14 direction",
          body: "Continue this team discussion.",
          autoRun: false
        }
      }
    });
    expect(discussed.result.view.unreadMessageCount).toBe(2);
    expect(status.result.compactStatus.recentActivity.unreadMessageCount).toBe(1);
    expect(status.result.compactStatus.supportingLine).toBe("Waiting on Author and Reviewer to reply in the current round.");
    expect(status.result.controlPlane.inbox.discussionProgressSummary).toBe("Author and Reviewer still owe a reply.");
    expect(status.result.controlPlane.inbox.discussionHostAttentionSummary).toBeUndefined();
    expect(status.result.compactStatus.discussion).toMatchObject({
      lifecycleState: "open",
      resolutionState: "not_started",
      actionabilityState: "none",
      suggestedActionSummary: "The discussion is still collecting or confirming member replies.",
      turnTakingState: "waiting_required",
      nextResponsibleMemberNames: ["Author", "Reviewer"],
      nextTurnSummary: "Waiting on Author and Reviewer to reply in the current round.",
      progressSummary: "Author and Reviewer still owe a reply.",
      synthesis: {
        resolutionState: "not_started",
        summary: "Author and Reviewer still owe a reply."
      },
      proposedNextAction: {
        kind: "wait_for_members",
        summary: "Wait for Author and Reviewer to respond before settling the round."
      }
    });
    expect(status.result.controlPlane.inbox.activeThreads[0]).toMatchObject({
      threadId: discussed.result.discussion.threadId,
      lifecycleState: "open",
      resolutionState: "not_started",
      actionabilityState: "none",
      suggestedActionSummary: "The discussion is still collecting or confirming member replies.",
      turnTakingState: "waiting_required",
      nextResponsibleMemberNames: ["Author", "Reviewer"],
      nextTurnSummary: "Waiting on Author and Reviewer to reply in the current round.",
      currentRoundSummary: "Current round started with the host question and is waiting for 2 member responses.",
      synthesis: {
        resolutionState: "not_started",
        summary: "Author and Reviewer still owe a reply."
      },
      proposedNextAction: {
        kind: "wait_for_members",
        summary: "Wait for Author and Reviewer to respond before settling the round."
      },
      pendingMemberIds: expect.arrayContaining([expect.any(String), expect.any(String)])
    });
  });

  it("does not persist background run state unless background.enabled is true", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new FakeAgentBackend();
    const server = registeredServer(store, { backendFactory: () => backend });
    const started = await callRegisteredTool(server, "team_start", { teamName: "no background state" }) as { result: { team: { id: string } } };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Worker",
      model: "test/model",
      rawResponsibility: "Handle tasks.",
      polishedPrompt: "Handle tasks."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });

    const worked = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      goal: "Do normal bounded work",
      maxTicks: 2
    }) as { result: { view: { background?: unknown } } };
    const status = await callRegisteredTool(server, "team_status", { teamId: started.result.team.id }) as {
      result: { scheduler?: { background?: unknown }; compactStatus: { background?: unknown } };
    };
    const results = await callRegisteredTool(server, "team_results", { teamId: started.result.team.id }) as {
      result: { compactResults: { latestBoundedRun?: unknown } };
    };

    expect(worked.result.view.background).toBeUndefined();
    expect(status.result.scheduler?.background).toBeUndefined();
    expect(status.result.compactStatus.background).toBeUndefined();
    expect(results.result.compactResults.latestBoundedRun).toBeUndefined();
  });

  it("auto-readies finalized teams without a runtime record before task-first work", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new FakeAgentBackend();
    const server = registeredServer(store, { backendFactory: () => backend });
    const started = await callRegisteredTool(server, "team_start", { teamName: "finalized no runtime" }) as { result: { team: { id: string } } };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Worker",
      model: "test/model",
      rawResponsibility: "Handle tasks.",
      polishedPrompt: "Handle tasks."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });
    await store.transaction((state) => {
      delete state.teamRuntimes[started.result.team.id];
      delete state.schedulerStates[started.result.team.id];
    });

    const worked = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      goal: "Recover finalized runtime state",
      maxTicks: 1
    }) as {
      result: { mode: string; runtime: { status: string }; task: { title: string } };
    };

    expect(worked.result.mode).toBe("task_flow");
    expect(worked.result.runtime.status).toBe("running");
    expect(worked.result.task.title).toBe("Recover finalized runtime state");
  });

  it("advances team_work from request-only input with grouped recommendedInput", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const server = registeredServer(store, { backendFactory: () => new FakeAgentBackend(), advancedTools: false });

    const started = await callRegisteredTool(server, "team_work", {
      request: "Create a reviewer teammate for small patches."
    }) as {
      result: {
        mode: string;
        team: { id: string };
        recommendedInput: { teamId: string; builder: { draftMember: { name: string } } };
      };
    };

    expect(started.result.mode).toBe("builder_guidance");
    expect(started.result.team.id).toBeTruthy();
    expect(started.result.recommendedInput).toMatchObject({
      teamId: started.result.team.id,
      builder: { draftMember: { name: "Your Reviewer Name" } }
    });
  });

  it("advances team_work from confirm-only input after a saved draft", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const server = registeredServer(store, { backendFactory: () => new FakeAgentBackend(), advancedTools: false });

    const started = await callRegisteredTool(server, "team_work", { team: { teamName: "confirm-only" } }) as {
      result: { team: { id: string } };
    };
    const teamId = started.result.team.id;

    await callRegisteredTool(server, "team_work", {
      teamId,
      builder: {
        draftMember: {
          name: "Reviewer",
          model: "test/model",
          rawResponsibility: "Review focused code changes.",
          polishedPrompt: "Review focused code changes and report concise findings."
        }
      }
    });

    const confirmed = await callRegisteredTool(server, "team_work", {
      teamId,
      builder: { confirmMember: true }
    }) as {
      result: {
        mode: string;
        members: Array<{ name: string }>;
        recommendedInput: { teamId: string; builder: { finishTeam: boolean } };
      };
    };

    expect(confirmed.result.mode).toBe("builder_guidance");
    expect(confirmed.result.members).toEqual([expect.objectContaining({ name: "Reviewer" })]);
    expect(confirmed.result.recommendedInput).toMatchObject({ teamId, builder: { finishTeam: true } });
  });

  it("advances team_work from work.goal-only input after the team is ready", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const server = registeredServer(store, { backendFactory: () => new FakeAgentBackend(), advancedTools: false });

    const started = await callRegisteredTool(server, "team_work", { team: { teamName: "goal-only" } }) as {
      result: { team: { id: string } };
    };
    const teamId = started.result.team.id;

    await callRegisteredTool(server, "team_work", {
      teamId,
      builder: {
        draftMember: {
          name: "Worker",
          model: "test/model",
          rawResponsibility: "Handle goal-only work.",
          polishedPrompt: "Handle goal-only work and complete assigned tasks."
        }
      }
    });
    await callRegisteredTool(server, "team_work", { teamId, builder: { confirmMember: true } });
    await callRegisteredTool(server, "team_work", { teamId, builder: { finishTeam: true } });

    const worked = await callRegisteredTool(server, "team_work", {
      teamId,
      work: { goal: "Ship goal-only progression", autoRun: false }
    }) as {
      result: {
        mode: string;
        task: { id: string; title: string; status: string };
        runtime: { status: string };
        recommendedInput: { teamId: string; work: { taskId: string; autoRun: boolean } };
      };
    };

    expect(worked.result.mode).toBe("task_flow");
    expect(worked.result.task).toMatchObject({ title: "Ship goal-only progression", status: "pending" });
    expect(worked.result.runtime.status).toBe("running");
    expect(worked.result.recommendedInput).toMatchObject({
      teamId,
      work: { taskId: worked.result.task.id, autoRun: false }
    });
  });

  it("keeps scheduler member prompts as compact task cards", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new FakeAgentBackend();
    const server = registeredServer(store, { backendFactory: () => backend });
    const started = await callRegisteredTool(server, "team_start", { teamName: "compact prompt" }) as { result: { team: { id: string } } };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Focused Worker",
      model: "test/model",
      rawResponsibility: "Handle focused tasks.",
      polishedPrompt: "Handle focused tasks with minimal coordination noise.",
      permissions: ["read", "edit"]
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });
    const running = await callRegisteredTool(server, "team_run", { teamId: started.result.team.id, maxParallel: 1 }) as { result: { sessions: Array<{ memberId: string }> } };
    await callRegisteredTool(server, "team_task_create", {
      teamId: started.result.team.id,
      title: "Implement compact scheduler prompt",
      description: "Keep the prompt focused on the task card.",
      preferredMemberId: running.result.sessions[0]!.memberId,
      pathHints: ["src/runtime/scheduler.ts"]
    });

    await callRegisteredTool(server, "team_scheduler_tick", { teamId: started.result.team.id });
    const prompt = backend.prompts[0]!.prompt;

    expect(prompt).toContain("Task for Focused Worker");
    expect(prompt).toMatch(/teamId=team_/);
    expect(prompt).toMatch(/memberId=mem_/);
    expect(prompt).toMatch(/taskId=task_/);
    expect(prompt).toContain("Goal: Implement compact scheduler prompt");
    expect(prompt).toContain("Paths: src/runtime/scheduler.ts");
    expect(prompt).toContain("Finish:");
    expect(prompt).toContain("complete_task with summary/artifacts when done.");
    expect(prompt).toContain("Tools:");
    expect(prompt).toContain("Allowed:");
    expect(prompt).not.toContain("Runtime tool contract:");
    expect(prompt).not.toContain("A task remains claimed until complete_task or fail_task succeeds");
    expect(prompt).not.toContain("Runtime policy:");
    expect(prompt).not.toContain("Member permissions:");
    expect(prompt).not.toContain("Inbox: no unread runtime messages for this task.");
    expect(prompt.length).toBeLessThan(900);
  });

  it("guides team creation through team_work without requiring low-level builder tools", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const server = registeredServer(store, { backendFactory: () => new FakeAgentBackend(), advancedTools: false });

    const started = await callRegisteredTool(server, "team_work", {
      teamName: "guided builder",
      request: "Create a reviewer teammate for small patches."
    }) as {
      result: {
        mode: string;
        team: { id: string };
        question: string;
        choices: Array<{ label: string }>;
        nextPrompt: string;
        recommendedInput: { teamId: string; builder: { draftMember: { name: string } } };
        statusSummary: string;
        members: unknown[];
      };
    };

    expect(started.result.mode).toBe("builder_guidance");
    expect(started.result.question).toContain("Draft the first teammate");
    expect(started.result.question).toContain("name, model, and role you want");
    expect(started.result.choices).toEqual([expect.objectContaining({ label: "Draft first member" })]);
    expect(started.result.nextPrompt).toContain(`team ${started.result.team.id}`);
    expect(started.result.nextPrompt).not.toContain("Choices:");
    expect(started.result.recommendedInput).toMatchObject({
      teamId: started.result.team.id,
      builder: { draftMember: { name: "Your Reviewer Name" } }
    });
    expect(started.result.statusSummary).toContain("0 confirmed members");
    expect(started.result.members).toEqual([]);
  });

  it("can save a draft, confirm a member, continue, and finish the team through team_work", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const server = registeredServer(store, { backendFactory: () => new FakeAgentBackend(), advancedTools: false });

    const started = await callRegisteredTool(server, "team_work", { team: { teamName: "team-work builder" } }) as {
      result: { team: { id: string } };
    };
    const teamId = started.result.team.id;

    const drafted = await callRegisteredTool(server, "team_work", {
      teamId,
      builder: {
        draftMember: {
          name: "Patch Builder",
          model: "test/model",
          rawResponsibility: "Implement a small confirmed patch.",
          polishedPrompt: "Implement a small confirmed patch and report changed files."
        }
      }
    }) as {
      result: {
        mode: string;
        currentDraft: { name: string; model: string };
        question: string;
        choices: Array<{ label: string }>;
        recommendedInput: { teamId: string; builder: { confirmMember: boolean } };
      };
    };
    const confirmed = await callRegisteredTool(server, "team_work", { teamId, builder: { confirmMember: true } }) as {
      result: {
        mode: string;
        members: Array<{ name: string; model: string }>;
        choices: Array<{ label: string }>;
        recommendedInput: { teamId: string; builder: { finishTeam: boolean } };
        statusSummary: string;
      };
    };
    const finished = await callRegisteredTool(server, "team_work", { teamId, builder: { finishTeam: true } }) as {
      result: {
        mode: string;
        runtime: { teamId: string; status: string };
        nextPrompt: string;
        recommendedInput: { teamId: string; work: { goal: string } };
      };
    };
    const state = await store.read();

    expect(drafted.result.mode).toBe("builder_guidance");
    expect(drafted.result.currentDraft).toMatchObject({ name: "Patch Builder", model: "test/model" });
    expect(drafted.result.question).toContain("Confirm it or revise it");
    expect(drafted.result.choices.map((choice) => choice.label)).toEqual(["Confirm member", "Revise draft"]);
    expect(drafted.result.recommendedInput).toMatchObject({ teamId, builder: { confirmMember: true } });
    expect(confirmed.result.members).toEqual([expect.objectContaining({ name: "Patch Builder", model: "test/model" })]);
    expect(confirmed.result.choices.map((choice) => choice.label)).toEqual(["Add member", "Finish team"]);
    expect(confirmed.result.recommendedInput).toMatchObject({ teamId, builder: { finishTeam: true } });
    expect(confirmed.result.statusSummary).toContain("1 confirmed member");
    expect(finished.result.mode).toBe("task_flow");
    expect(finished.result.runtime).toMatchObject({ teamId, status: "running" });
    expect(finished.result.nextPrompt).toContain("Continue team_work for the current team work");
    expect(finished.result.recommendedInput).toMatchObject({ teamId, work: { goal: "Describe the next task to run" } });
    expect(state.tasks).toEqual({});
  });

  it("returns focused team_work guidance when the team is not ready", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const server = registeredServer(store, { backendFactory: () => new FakeAgentBackend(), advancedTools: false });
    const started = await callRegisteredTool(server, "team_work", { team: { teamName: "not ready work" } }) as { result: { team: { id: string } } };

    const worked = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      work: {
        goal: "Attempt work before finish",
        autoRun: true,
        includeDetails: true
      }
    }) as {
      result: {
        mode: string;
        team: { id: string };
        build: { status: string };
        question: string;
        choices: Array<{ label: string }>;
        nextPrompt: string;
        recommendedInput: { teamId: string; builder: { draftMember: { name: string } } };
        statusSummary: string;
      };
    };
    const state = await store.read();

    expect(worked.result.mode).toBe("builder_guidance");
    expect(worked.result.team.id).toBe(started.result.team.id);
    expect(worked.result.build.status).toBe("building");
    expect(worked.result.question).toContain("Draft the first teammate");
    expect(worked.result.question).toContain("name, model, and role you want");
    expect(worked.result.choices).toEqual([expect.objectContaining({ label: "Draft first member" })]);
    expect(worked.result.nextPrompt).toContain(`team ${started.result.team.id}`);
    expect(worked.result.nextPrompt).not.toContain("Choices:");
    expect(worked.result.recommendedInput).toMatchObject({
      teamId: started.result.team.id,
      builder: { draftMember: { name: "Your Teammate Name" } }
    });
    expect(worked.result.statusSummary).toContain("not finished yet");
    expect(Object.keys(state.tasks)).toHaveLength(0);
  });

  it("uses a neutral request-aware placeholder name in builder guidance", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const server = registeredServer(store, { backendFactory: () => new FakeAgentBackend(), advancedTools: false });

    const started = await callRegisteredTool(server, "team_work", {
      request: "Create a reviewer teammate for small patches."
    }) as {
      result: {
        recommendedInput: {
          builder: {
            draftMember: {
              name: string;
              rawResponsibility: string;
              polishedPrompt: string;
            };
          };
        };
      };
    };

    expect(started.result.recommendedInput.builder.draftMember.name).toBe("Your Reviewer Name");
    expect(started.result.recommendedInput.builder.draftMember.rawResponsibility).toBe(
      "Describe how you want this teammate to review changes."
    );
    expect(started.result.recommendedInput.builder.draftMember.polishedPrompt).toBe(
      "Write the review prompt you want this teammate to follow."
    );
  });

  it("keeps generic placeholder responsibility text when the request has no clear role keyword", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const server = registeredServer(store, { backendFactory: () => new FakeAgentBackend(), advancedTools: false });

    const started = await callRegisteredTool(server, "team_work", {
      request: "Create the first teammate."
    }) as {
      result: {
        recommendedInput: {
          builder: {
            draftMember: {
              name: string;
              rawResponsibility: string;
              polishedPrompt: string;
            };
          };
        };
      };
    };

    expect(started.result.recommendedInput.builder.draftMember.name).toBe("Your Teammate Name");
    expect(started.result.recommendedInput.builder.draftMember.rawResponsibility).toBe(
      "Describe this teammate's responsibility."
    );
    expect(started.result.recommendedInput.builder.draftMember.polishedPrompt).toBe(
      "Write the prompt you want this teammate to follow."
    );
  });

  it("explains how to continue an already claimed task through team_work", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new FakeAgentBackend();
    const server = registeredServer(store, { backendFactory: () => backend });
    const started = await callRegisteredTool(server, "team_start", { teamName: "claimed work guidance" }) as { result: { team: { id: string } } };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Claimed Worker",
      model: "test/model",
      rawResponsibility: "Continue claimed tasks.",
      polishedPrompt: "Continue claimed tasks and complete them through runtime tools."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });
    const first = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      goal: "Keep this task in progress",
      maxTicks: 1
    }) as { result: { task: { id: string; status: string } } };

    const continued = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      taskId: first.result.task.id,
      maxTicks: 1
    }) as {
      result: {
        task: { id: string; status: string };
        nextActions: string[];
        nextPrompt: string;
        explain: { continuation?: { kind: string; taskId?: string }; safety?: { level: string; headline: string } };
        recommendedInput: { teamId: string; work: { taskId: string } };
        view: { summary: string };
      };
    };

    expect(continued.result.task).toMatchObject({ id: first.result.task.id, status: "claimed" });
    expect(continued.result.nextActions[0]).toContain(`Task ${first.result.task.id} is already claimed`);
    expect(continued.result.nextPrompt).toContain(`claimed task ${first.result.task.id}`);
    expect(continued.result.explain.continuation).toMatchObject({
      kind: "resume_same_task",
      taskId: first.result.task.id
    });
    expect(continued.result.recommendedInput).toMatchObject({ teamId: started.result.team.id, work: { taskId: first.result.task.id } });
    expect(continued.result.view.summary).toContain(`Next: Task ${first.result.task.id} is already claimed`);
    expect(continued.result.explain.safety).toMatchObject({
      level: "warning",
      headline: `Task ${first.result.task.id} has no explicit edit scope.`
    });
  });

  it("surfaces failed task guidance when team_work continues a failed task", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new FakeAgentBackend();
    const server = registeredServer(store, { backendFactory: () => backend });
    const started = await callRegisteredTool(server, "team_start", { teamName: "failed work guidance" }) as { result: { team: { id: string } } };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Failure Worker",
      model: "test/model",
      rawResponsibility: "Report task failures clearly.",
      polishedPrompt: "Report task failures clearly and stop when blocked."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });
    const running = await callRegisteredTool(server, "team_run", { teamId: started.result.team.id, maxParallel: 1 }) as { result: { sessions: Array<{ memberId: string }> } };
    const task = await callRegisteredTool(server, "team_task_create", {
      teamId: started.result.team.id,
      title: "Fail and explain",
      preferredMemberId: running.result.sessions[0]!.memberId,
      pathHints: ["src/failure.ts"]
    }) as { result: { id: string } };

    await callRegisteredTool(server, "claim_task", {
      teamId: started.result.team.id,
      taskId: task.result.id,
      memberId: running.result.sessions[0]!.memberId
    });
    await callRegisteredTool(server, "fail_task", {
      teamId: started.result.team.id,
      taskId: task.result.id,
      memberId: running.result.sessions[0]!.memberId,
      failureSummary: "missing dependency config"
    });

    const worked = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      taskId: task.result.id,
      maxTicks: 1
    }) as {
      result: {
        task: { status: string };
        nextActions: string[];
        nextPrompt: string;
        explain: { continuation?: { kind: string; taskId?: string } };
        recommendedInput: { teamId: string; work: { goal?: string; pathHints?: string[]; autoRun: boolean } };
      };
    };

    expect(worked.result.task.status).toBe("failed");
    expect(worked.result.nextActions[0]).toContain("create follow-up work before continuing");
    expect(worked.result.nextPrompt).toContain(`task ${task.result.id}`);
    expect(worked.result.explain.continuation).toMatchObject({
      kind: "create_followup_task",
      taskId: task.result.id
    });
    expect(worked.result.recommendedInput).toMatchObject({
      teamId: started.result.team.id,
      work: {
        goal: `Follow up on task ${task.result.id}: missing dependency config`,
        pathHints: ["src/failure.ts"],
        autoRun: false
      }
    });
  });

  it("recommends recovery when team_work sees a claimed task on an error session", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new FakeAgentBackend();
    const server = registeredServer(store, { backendFactory: () => backend });
    const started = await callRegisteredTool(server, "team_start", { teamName: "error session guidance" }) as { result: { team: { id: string } } };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Recovery Worker",
      model: "test/model",
      rawResponsibility: "Recover errored runtime work.",
      polishedPrompt: "Recover errored runtime work."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });
    const running = await callRegisteredTool(server, "team_run", { teamId: started.result.team.id, maxParallel: 1 }) as { result: { sessions: Array<{ id: string; memberId: string }> } };
    const session = running.result.sessions[0]!;
    const task = await callRegisteredTool(server, "team_task_create", {
      teamId: started.result.team.id,
      title: "Recover this claimed task",
      preferredMemberId: session.memberId
    }) as { result: { id: string } };

    await callRegisteredTool(server, "claim_task", {
      teamId: started.result.team.id,
      taskId: task.result.id,
      memberId: session.memberId
    });
    await store.transaction((state) => {
      const storedSession = state.agentSessions[session.id]!;
      storedSession.status = "error";
      storedSession.currentTaskId = task.result.id;
      storedSession.errorMessage = "agent crashed";
    });

    const worked = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      taskId: task.result.id,
      maxTicks: 1
    }) as {
      result: {
        nextActions: string[];
        nextPrompt: string;
        recommendedInput: { teamId: string; work: { taskId: string; autoRun: boolean } };
      };
    };

    expect(worked.result.nextActions).toEqual(expect.arrayContaining([
      `Task ${task.result.id} is still claimed but its session is error; recover or reassign the blocked work before continuing.`,
      "Inspect 1 error/stopped session holding or blocking work, then recover, retry, or reassign as needed."
    ]));
    expect(worked.result.nextPrompt).toContain("recover or reassign the blocked work");
    expect(worked.result.recommendedInput).toMatchObject({ teamId: started.result.team.id, work: { taskId: task.result.id, autoRun: false } });
  });

  it("prioritizes unread task messages when team_work continues a pending task", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new FakeAgentBackend();
    const server = registeredServer(store, { backendFactory: () => backend });
    const started = await callRegisteredTool(server, "team_start", { teamName: "message guidance" }) as { result: { team: { id: string } } };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Message Worker",
      model: "test/model",
      rawResponsibility: "Continue message-scoped work.",
      polishedPrompt: "Continue message-scoped work."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });
    const task = await callRegisteredTool(server, "team_task_create", {
      teamId: started.result.team.id,
      title: "Read the escalation first"
    }) as { result: { id: string } };
    await callRegisteredTool(server, "team_message", {
      teamId: started.result.team.id,
      taskId: task.result.id,
      type: "escalation",
      subject: "Need decision",
      body: "Please decide before rerunning this task."
    });

    const worked = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      taskId: task.result.id,
      autoRun: false
    }) as {
      result: {
        nextActions: string[];
        nextPrompt: string;
        recommendedInput: { teamId: string; work: { taskId: string; autoRun: boolean } };
      };
    };

    expect(worked.result.nextActions[0]).toBe("Review the active discussion thread and decide how the team should proceed.");
    expect(worked.result.nextPrompt).toContain("decide how the team should proceed");
    expect(worked.result.recommendedInput).toMatchObject({ teamId: started.result.team.id, work: { taskId: task.result.id, autoRun: false } });
  });

  it("treats ask_lead as host-facing when no explicit lead member exists", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new FakeAgentBackend();
    const server = registeredServer(store, { backendFactory: () => backend });
    const started = await callRegisteredTool(server, "team_start", {
      teamName: "host escalation routing",
      hostName: "Main Host"
    }) as { result: { team: { id: string } } };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Escalation Worker",
      model: "test/model",
      rawResponsibility: "Escalate blocked work.",
      polishedPrompt: "Escalate blocked work."
    });
    const confirmed = await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id }) as {
      result: { member: { id: string } };
    };
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });
    const task = await callRegisteredTool(server, "team_task_create", {
      teamId: started.result.team.id,
      title: "Need a host decision"
    }) as { result: { id: string } };
    await callRegisteredTool(server, "claim_task", {
      teamId: started.result.team.id,
      taskId: task.result.id,
      memberId: confirmed.result.member.id
    });

    const asked = await callRegisteredTool(server, "ask_lead", {
      teamId: started.result.team.id,
      fromMemberId: confirmed.result.member.id,
      taskId: task.result.id,
      subject: "Need host review",
      body: "Please decide before broadening scope."
    }) as {
      result: {
        type: string;
        toMemberId?: string;
        escalationTarget: string;
        leadMemberId?: string;
        hostRuntimeSession: boolean;
      };
    };
    const worked = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      taskId: task.result.id,
      autoRun: false
    }) as {
      result: {
        explain: { recommendedNextAction: string };
        recommendedInput: { teamId: string; work: { taskId: string; autoRun: boolean } };
      };
    };
    const status = await callRegisteredTool(server, "team_status", { teamId: started.result.team.id }) as {
      result: {
        host: { leadMode: string; escalationTarget: string; hostRuntimeSession: boolean };
        explain: { headline: string; recommendedNextAction: string; blockingReason?: string };
        compactStatus: { headline: string; supportingLine: string; nextAction: string };
      };
    };

    expect(asked.result).toMatchObject({
      type: "escalation",
      escalationTarget: "host",
      hostRuntimeSession: false
    });
    expect(asked.result.toMemberId).toBeUndefined();
    expect(asked.result.leadMemberId).toBeUndefined();
    expect(worked.result.explain.recommendedNextAction).toBe(
      "Review the active discussion thread and decide how the team should proceed."
    );
    expect(worked.result.recommendedInput).toMatchObject({
      teamId: started.result.team.id,
      work: { taskId: task.result.id, autoRun: false }
    });
    expect(status.result.host).toMatchObject({
      leadMode: "host_only",
      escalationTarget: "host",
      hostRuntimeSession: false
    });
    expect(status.result.explain).toMatchObject({
      headline: 'Discussion "Need host review" is ready for a host decision.',
      blockingReason: "A host escalation is holding the current round for judgment.",
      recommendedNextAction: "Review the active discussion thread and decide how the team should proceed."
    });
    expect(status.result.compactStatus).toMatchObject({
      headline: 'Discussion "Need host review" is ready for a host decision.',
      supportingLine: "A host escalation is holding the current round for judgment.",
      discussion: {
        progressSummary: "A host escalation is holding the current round for judgment.",
        hostAttentionSummary: "A host escalation is holding the current round for judgment."
      },
      nextAction: "Review the active discussion thread and decide how the team should proceed."
    });
  });

  it("explains blocked dependencies when team_work continues a blocked task", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new FakeAgentBackend();
    const server = registeredServer(store, { backendFactory: () => backend });
    const started = await callRegisteredTool(server, "team_start", { teamName: "blocked guidance" }) as { result: { team: { id: string } } };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Dependency Worker",
      model: "test/model",
      rawResponsibility: "Track dependency-blocked work.",
      polishedPrompt: "Track dependency-blocked work."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });
    const dependency = await callRegisteredTool(server, "team_task_create", {
      teamId: started.result.team.id,
      title: "Prepare prerequisite"
    }) as { result: { id: string } };
    const blocked = await callRegisteredTool(server, "team_task_create", {
      teamId: started.result.team.id,
      title: "Blocked follow-up",
      dependencyTaskIds: [dependency.result.id]
    }) as { result: { id: string } };

    const worked = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      taskId: blocked.result.id,
      autoRun: false
    }) as {
      result: {
        nextActions: string[];
        nextPrompt: string;
        explain: { phase: string; blockingReason?: string; recommendedNextAction: string; continuation?: { kind: string; taskId?: string } };
        recommendedInput: { teamId: string; work: { taskId: string; autoRun: boolean } };
      };
    };
    const status = await callRegisteredTool(server, "team_status", {
      teamId: started.result.team.id
    }) as {
      result: {
        explain: { headline: string; blockingReason?: string; recommendedNextAction: string; continuation?: { kind: string } };
        compactStatus: {
          headline: string;
          supportingLine: string;
          nextAction: string;
          continuation?: { kind: string };
          safety?: { level: string; headline: string };
        };
      };
    };
    const results = await callRegisteredTool(server, "team_results", {
      teamId: started.result.team.id
    }) as {
      result: {
        explain: { headline: string; blockingReason?: string; continuation?: { kind: string } };
        compactResults: {
          headline: string;
          supportingLine: string;
          continuation?: { kind: string };
          safety?: { level: string; headline: string };
        };
      };
    };

    expect(worked.result.nextActions[0]).toContain(`Task ${blocked.result.id} is blocked by dependency ${dependency.result.id} (pending)`);
    expect(worked.result.nextPrompt).toContain(`task ${blocked.result.id}`);
    expect(worked.result.explain).toMatchObject({
      phase: "attention",
      blockingReason: `dependency ${dependency.result.id} is pending`,
      safety: expect.objectContaining({
        level: "warning",
        headline: `Task ${blocked.result.id} has no explicit edit scope.`
      }),
      recommendedNextAction: `Task ${blocked.result.id} is blocked by dependency ${dependency.result.id} (pending); continue that dependency before rerunning this task.`,
      continuation: {
        kind: "review_before_continue",
        taskId: dependency.result.id
      }
    });
    expect(status.result.explain).toMatchObject({
      blockingReason: expect.stringContaining(`dependency ${dependency.result.id} is pending`),
      recommendedNextAction: "Resolve or complete dependency tasks before blocked pending work can run.",
      continuation: { kind: "review_before_continue" }
    });
    expect(status.result.compactStatus).toMatchObject({
      headline: "1 task is blocked by dependencies.",
      supportingLine: `dependency ${dependency.result.id} is pending`,
      nextAction: "Resolve or complete dependency tasks before blocked pending work can run.",
      continuation: { kind: "review_before_continue" },
      safety: expect.objectContaining({
        level: "warning",
        headline: expect.stringContaining("has no explicit edit scope")
      })
    });
    expect(results.result.explain.blockingReason).toBe(`dependency ${dependency.result.id} is pending`);
    expect(results.result.compactResults).toMatchObject({
      headline: "1 task is blocked by dependencies.",
      supportingLine: `dependency ${dependency.result.id} is pending`,
      continuation: { kind: "review_before_continue" },
      safety: expect.objectContaining({
        level: "warning",
        headline: expect.stringContaining("has no explicit edit scope")
      })
    });
    expect(results.result.explain.continuation).toMatchObject({ kind: "review_before_continue" });
    expect(worked.result.recommendedInput).toMatchObject({ teamId: started.result.team.id, work: { taskId: dependency.result.id, autoRun: false } });
  });

  it("prioritizes unread escalation guidance over warning-only safety in team_work", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new FakeAgentBackend();
    const server = registeredServer(store, { backendFactory: () => backend });
    const started = await callRegisteredTool(server, "team_start", { teamName: "warning versus escalation" }) as { result: { team: { id: string } } };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Escalation Worker",
      model: "test/model",
      rawResponsibility: "Handle escalations before continuing work.",
      polishedPrompt: "Handle escalations before continuing work."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });
    const task = await callRegisteredTool(server, "team_task_create", {
      teamId: started.result.team.id,
      title: "Needs host decision"
    }) as { result: { id: string } };
    await callRegisteredTool(server, "team_message", {
      teamId: started.result.team.id,
      taskId: task.result.id,
      type: "escalation",
      subject: "Need decision",
      body: "Please decide before broadening scope."
    });

    const worked = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      taskId: task.result.id,
      autoRun: false
    }) as {
      result: {
        nextActions: string[];
        nextPrompt: string;
        explain: { blockingReason?: string; recommendedNextAction: string; safety?: { level: string } };
        recommendedInput: { teamId: string; work: { taskId: string; autoRun: boolean } };
      };
    };

    expect(worked.result.nextActions[0]).toBe("Review the active discussion thread and decide how the team should proceed.");
    expect(worked.result.nextPrompt).toContain("decide how the team should proceed");
    expect(worked.result.explain).toMatchObject({
      blockingReason: "A host escalation is holding the current round for judgment.",
      recommendedNextAction: "Review the active discussion thread and decide how the team should proceed.",
      continuation: expect.objectContaining({
        kind: "review_before_continue",
        taskId: task.result.id
      }),
      safety: expect.objectContaining({ level: "warning" })
    });
    expect(worked.result.recommendedInput).toMatchObject({
      teamId: started.result.team.id,
      work: { taskId: task.result.id, autoRun: false }
    });
  });

  it("prioritizes claimed-session recovery over warning-only safety in team_work", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new FakeAgentBackend();
    const server = registeredServer(store, { backendFactory: () => backend });
    const started = await callRegisteredTool(server, "team_start", { teamName: "warning versus broken session" }) as { result: { team: { id: string } } };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Recovery Worker",
      model: "test/model",
      rawResponsibility: "Recover claimed work after session failures.",
      polishedPrompt: "Recover claimed work after session failures."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });
    const running = await callRegisteredTool(server, "team_run", { teamId: started.result.team.id, maxParallel: 1 }) as {
      result: { sessions: Array<{ id: string; memberId: string }> };
    };
    const task = await callRegisteredTool(server, "team_task_create", {
      teamId: started.result.team.id,
      title: "Recover claimed work"
    }) as { result: { id: string } };
    await store.transaction((state) => {
      new TaskService(state).claimTask({
        teamId: started.result.team.id,
        taskId: task.result.id,
        memberId: running.result.sessions[0]!.memberId
      });
      new PathLockService(state).lockPaths({
        teamId: started.result.team.id,
        taskId: task.result.id,
        ownerMemberId: running.result.sessions[0]!.memberId,
        paths: ["src/recovery.ts"]
      });
      new MailboxService(state).sendMessage({
        teamId: started.result.team.id,
        taskId: task.result.id,
        fromMemberId: running.result.sessions[0]!.memberId,
        type: "result",
        subject: "Partial progress",
        body: "Path lock acquired before the session failed."
      });
      const storedSession = state.agentSessions[running.result.sessions[0]!.id]!;
      storedSession.status = "error";
      storedSession.currentTaskId = task.result.id;
      storedSession.errorMessage = "agent crashed";
    });

    const worked = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      taskId: task.result.id,
      maxTicks: 1
    }) as {
      result: {
        nextActions: string[];
        nextPrompt: string;
        explain: { blockingReason?: string; recommendedNextAction: string; safety?: { level: string } };
        recommendedInput: { teamId: string; work: { taskId: string; autoRun: boolean } };
      };
    };

    expect(worked.result.nextActions[0]).toBe(`Task ${task.result.id} is still claimed but its session is error; recover or reassign the blocked work before continuing.`);
    expect(worked.result.nextPrompt).toContain("recover or reassign the blocked work");
    expect(worked.result.explain).toMatchObject({
      blockingReason: expect.stringContaining("is error"),
      recommendedNextAction: `Task ${task.result.id} is still claimed but its session is error; recover or reassign the blocked work before continuing.`,
      continuation: expect.objectContaining({
        kind: "recover_session_then_retry",
        taskId: task.result.id
      }),
      safety: expect.objectContaining({ level: "warning" })
    });
    expect(worked.result.recommendedInput).toMatchObject({
      teamId: started.result.team.id,
      work: { taskId: task.result.id, autoRun: false }
    });
  });

  it("recommends manual follow-up when team_work sees a paused runtime", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const server = registeredServer(store, { backendFactory: () => new FakeAgentBackend(), advancedTools: false });

    const started = await callRegisteredTool(server, "team_work", { team: { teamName: "paused runtime guidance" } }) as {
      result: { team: { id: string } };
    };
    const teamId = started.result.team.id;

    await callRegisteredTool(server, "team_work", {
      teamId,
      builder: {
        draftMember: {
          name: "Pause Worker",
          model: "test/model",
          rawResponsibility: "Resume paused runtime work carefully.",
          polishedPrompt: "Resume paused runtime work carefully and wait for host direction."
        }
      }
    });
    await callRegisteredTool(server, "team_work", { teamId, builder: { confirmMember: true } });
    await callRegisteredTool(server, "team_work", { teamId, builder: { finishTeam: true } });
    await store.transaction(async (state) => {
      const runtime = new RuntimeService(state, new FakeAgentBackend());
      await runtime.start({ teamId });
      runtime.pause({ teamId });
    });

    const worked = await callRegisteredTool(server, "team_work", {
      teamId,
      work: { goal: "Resume after inspection", autoRun: false }
    }) as {
      result: {
        task: { id: string; title: string };
        runtime: { status: string };
        nextActions: string[];
        nextPrompt: string;
        explain: { phase: string; recommendedNextAction: string };
        recommendedInput: { teamId: string; work: { taskId: string; autoRun: boolean } };
      };
    };

    expect(worked.result.task.title).toBe("Resume after inspection");
    expect(worked.result.runtime.status).toBe("paused");
    expect(worked.result.nextActions[0]).toBe("Resume the paused runtime manually when the team should continue scheduling work.");
    expect(worked.result.nextPrompt).toContain("Resume the paused runtime manually when the team should continue scheduling work.");
    expect(worked.result.explain).toMatchObject({
      phase: "attention",
      recommendedNextAction: "Resume the paused runtime manually when the team should continue scheduling work.",
      continuation: expect.objectContaining({
        kind: "review_before_continue",
        taskId: worked.result.task.id
      })
    });
    expect(worked.result.recommendedInput).toMatchObject({ teamId, work: { taskId: worked.result.task.id, autoRun: false } });
    expect(worked.result.explain.safety).toMatchObject({
      level: "warning",
      headline: `Task ${worked.result.task.id} has no explicit edit scope.`
    });
  });

  it("resumes a paused runtime when team_work explicitly requests autoRun", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const server = registeredServer(store, { backendFactory: () => new FakeAgentBackend(), advancedTools: false });

    const started = await callRegisteredTool(server, "team_work", { team: { teamName: "paused runtime resume" } }) as {
      result: { team: { id: string } };
    };
    const teamId = started.result.team.id;

    await callRegisteredTool(server, "team_work", {
      teamId,
      builder: {
        draftMember: {
          name: "Pause Worker",
          model: "test/model",
          rawResponsibility: "Resume paused runtime work carefully.",
          polishedPrompt: "Resume paused runtime work carefully and keep going once the host explicitly restarts work."
        }
      }
    });
    await callRegisteredTool(server, "team_work", { teamId, builder: { confirmMember: true } });
    await callRegisteredTool(server, "team_work", { teamId, builder: { finishTeam: true } });
    await store.transaction(async (state) => {
      const runtime = new RuntimeService(state, new FakeAgentBackend());
      await runtime.start({ teamId });
      runtime.pause({ teamId });
    });

    const worked = await callRegisteredTool(server, "team_work", {
      teamId,
      work: { goal: "Resume after inspection", autoRun: true, maxTicks: 1 }
    }) as {
      result: {
        task: { id: string; title: string; status: string };
        runtime: { status: string };
        schedulerRun?: { ticksRun: number };
      };
    };

    expect(worked.result.task.title).toBe("Resume after inspection");
    expect(worked.result.runtime.status).toBe("running");
    expect(worked.result.schedulerRun).toBeDefined();
  });

  it("recommends manual follow-up when team_work sees an errored runtime", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const server = registeredServer(store, { backendFactory: () => new FakeAgentBackend(), advancedTools: false });

    const started = await callRegisteredTool(server, "team_work", { team: { teamName: "errored runtime guidance" } }) as {
      result: { team: { id: string } };
    };
    const teamId = started.result.team.id;

    await callRegisteredTool(server, "team_work", {
      teamId,
      builder: {
        draftMember: {
          name: "Error Worker",
          model: "test/model",
          rawResponsibility: "Recover errored runtime work carefully.",
          polishedPrompt: "Recover errored runtime work carefully and wait for host direction."
        }
      }
    });
    await callRegisteredTool(server, "team_work", { teamId, builder: { confirmMember: true } });
    await callRegisteredTool(server, "team_work", { teamId, builder: { finishTeam: true } });
    await store.transaction((state) => {
      const runtime = new RuntimeService(state, new FakeAgentBackend());
      runtime.markReady({ teamId });
      state.teamRuntimes[teamId]!.status = "error";
    });

    const worked = await callRegisteredTool(server, "team_work", {
      teamId,
      work: { goal: "Recover after inspection", autoRun: true }
    }) as {
      result: {
        task: { id: string; title: string };
        runtime: { status: string };
        nextActions: string[];
        nextPrompt: string;
        explain: { phase: string; recommendedNextAction: string };
        recommendedInput: { teamId: string; work: { taskId: string; autoRun: boolean } };
      };
    };

    expect(worked.result.task.title).toBe("Recover after inspection");
    expect(worked.result.runtime.status).toBe("error");
    expect(worked.result.nextActions).toEqual(expect.arrayContaining([
      "Inspect error sessions and recover or replace blocked work before continuing."
    ]));
    expect(worked.result.nextPrompt).toContain("Inspect error sessions and recover or replace blocked work before continuing.");
    expect(worked.result.explain).toMatchObject({
      phase: "attention",
      recommendedNextAction: "Inspect error sessions and recover or replace blocked work before continuing.",
      continuation: expect.objectContaining({
        kind: "review_before_continue",
        taskId: worked.result.task.id
      })
    });
    expect(worked.result.recommendedInput).toMatchObject({ teamId, work: { taskId: worked.result.task.id, autoRun: false } });
  });

  it("recovers claimed work from error sessions", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new FakeAgentBackend();
    const server = registeredServer(store, { backendFactory: () => backend });
    const started = await callRegisteredTool(server, "team_start", { teamName: "recover sessions" }) as { result: { team: { id: string } } };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Recovery Worker",
      model: "test/model",
      rawResponsibility: "Recover runtime work.",
      polishedPrompt: "Recover runtime work.",
      permissions: ["read", "edit"]
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });
    const running = await callRegisteredTool(server, "team_run", { teamId: started.result.team.id, maxParallel: 1 }) as { result: { sessions: Array<{ id: string; memberId: string }> } };
    const session = running.result.sessions[0]!;
    const task = await callRegisteredTool(server, "team_task_create", {
      teamId: started.result.team.id,
      title: "Recover held task",
      preferredMemberId: session.memberId,
      pathHints: ["src/runtime/**"]
    }) as { result: { id: string } };

    await callRegisteredTool(server, "claim_task", {
      teamId: started.result.team.id,
      taskId: task.result.id,
      memberId: session.memberId
    });
    await callRegisteredTool(server, "lock_paths", {
      teamId: started.result.team.id,
      ownerMemberId: session.memberId,
      taskId: task.result.id,
      paths: ["src/runtime/sessionRecovery.ts"]
    });
    await store.transaction((state) => {
      const storedSession = state.agentSessions[session.id]!;
      storedSession.status = "error";
      storedSession.currentTaskId = task.result.id;
      storedSession.errorMessage = "backend session disappeared";
    });

    const recovered = await callRegisteredTool(server, "team_recover_sessions", {
      teamId: started.result.team.id,
      sessionIds: [session.id],
      replaceSessions: true,
      reason: "backend session disappeared"
    }) as {
      result: {
        recoveredSessions: Array<{ id: string; status: string; currentTaskId?: string }>;
        replacedSessions: Array<{ id: string; status: string; memberId: string; backendSessionId: string }>;
        releasedTasks: Array<{ id: string; status: string; assignedMemberId?: string }>;
        actions: Array<{ action: string; taskId?: string }>;
      };
    };
    const status = await callRegisteredTool(server, "team_status", { teamId: started.result.team.id }) as {
      result: { controlPlane: { taskBuckets: { runnable: Array<{ id: string }> }; locks: unknown[]; nextActions: string[] } };
    };
    const timeline = await callRegisteredTool(server, "team_timeline", { teamId: started.result.team.id }) as { result: { events: Array<{ type: string }> } };

    expect(recovered.result.recoveredSessions).toEqual([expect.objectContaining({ id: session.id, status: "stopped" })]);
    expect(recovered.result.recoveredSessions[0]).not.toHaveProperty("currentTaskId");
    expect(recovered.result.replacedSessions).toEqual([expect.objectContaining({ status: "idle", memberId: session.memberId, backendSessionId: `fake_${session.memberId}_2` })]);
    expect(recovered.result.replacedSessions[0]!.id).not.toBe(session.id);
    expect(recovered.result.releasedTasks).toEqual([expect.objectContaining({ id: task.result.id, status: "pending" })]);
    expect(recovered.result.releasedTasks[0]).not.toHaveProperty("assignedMemberId");
    expect(recovered.result.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "released_claimed_task", taskId: task.result.id }),
      expect.objectContaining({ action: "replaced_session" })
    ]));
    expect(status.result.controlPlane.taskBuckets.runnable).toEqual([expect.objectContaining({ id: task.result.id })]);
    expect(status.result.controlPlane.locks).toEqual([]);
    expect(status.result.controlPlane.nextActions).toContain("Continue with team_work to assign runnable work and advance bounded progress.");
    expect(status.result.controlPlane.nextActions).not.toContain("No idle teammate session is available for runnable work; wait, stop/restart a session, or increase runtime capacity.");
    expect(timeline.result.events.map((event) => event.type)).toEqual(expect.arrayContaining(["session.recovered", "session.replaced"]));
  });

  it("marks stale working sessions and replaces them during recovery", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new FakeAgentBackend();
    const server = registeredServer(store, { backendFactory: () => backend });
    const started = await callRegisteredTool(server, "team_start", { teamName: "stale recovery" }) as { result: { team: { id: string } } };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Stale Worker",
      model: "test/model",
      rawResponsibility: "Recover stale runtime work.",
      polishedPrompt: "Recover stale runtime work.",
      permissions: ["read", "edit"]
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });
    const running = await callRegisteredTool(server, "team_run", { teamId: started.result.team.id, maxParallel: 1 }) as { result: { sessions: Array<{ id: string; memberId: string }> } };
    const session = running.result.sessions[0]!;
    const task = await callRegisteredTool(server, "team_task_create", {
      teamId: started.result.team.id,
      title: "Recover stale task",
      preferredMemberId: session.memberId
    }) as { result: { id: string } };

    await callRegisteredTool(server, "claim_task", {
      teamId: started.result.team.id,
      taskId: task.result.id,
      memberId: session.memberId
    });
    await store.transaction((state) => {
      const storedSession = state.agentSessions[session.id]!;
      storedSession.status = "working";
      storedSession.currentTaskId = task.result.id;
      storedSession.lastHeartbeatAt = "2000-01-01T00:00:00.000Z";
      storedSession.updatedAt = "2000-01-01T00:00:00.000Z";
    });

    const recovered = await callRegisteredTool(server, "team_recover_sessions", {
      teamId: started.result.team.id,
      sessionIds: [session.id],
      staleAfterMs: 1,
      replaceSessions: true,
      reason: "heartbeat expired"
    }) as {
      result: {
        recoveredSessions: Array<{ id: string; status: string; errorMessage?: string; currentTaskId?: string }>;
        replacedSessions: Array<{ id: string; status: string; memberId: string; backendSessionId: string }>;
        releasedTasks: Array<{ id: string; status: string }>;
        actions: Array<{ action: string; taskId?: string; sessionId: string }>;
      };
    };
    const timeline = await callRegisteredTool(server, "team_timeline", { teamId: started.result.team.id }) as { result: { events: Array<{ type: string }> } };

    expect(recovered.result.recoveredSessions).toEqual([expect.objectContaining({
      id: session.id,
      status: "stopped",
      errorMessage: "Session heartbeat is stale: heartbeat expired"
    })]);
    expect(recovered.result.recoveredSessions[0]).not.toHaveProperty("currentTaskId");
    expect(recovered.result.releasedTasks).toEqual([expect.objectContaining({ id: task.result.id, status: "pending" })]);
    expect(recovered.result.replacedSessions).toEqual([expect.objectContaining({
      status: "idle",
      memberId: session.memberId,
      backendSessionId: `fake_${session.memberId}_2`
    })]);
    expect(recovered.result.replacedSessions[0]!.id).not.toBe(session.id);
    expect(recovered.result.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "marked_stale", taskId: task.result.id, sessionId: session.id }),
      expect.objectContaining({ action: "released_claimed_task", taskId: task.result.id, sessionId: session.id }),
      expect.objectContaining({ action: "replaced_session" })
    ]));
    expect(timeline.result.events.map((event) => event.type)).toEqual(expect.arrayContaining(["session.stale", "session.recovered", "session.replaced"]));
  });

  it("lets scheduler-assigned prompts call mutating tools without holding the store lock", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir, lockTimeoutMs: 100, lockPollMs: 5 });
    const backend = new ToolCallingBackend(store);
    const server = registeredServer(store, { backendFactory: () => backend });
    const started = await callRegisteredTool(server, "team_start", { teamName: "split scheduler" }) as { result: { team: { id: string } } };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Tool Caller",
      model: "test/model",
      rawResponsibility: "Complete tasks through runtime tools.",
      polishedPrompt: "Complete tasks through runtime tools."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });
    const running = await callRegisteredTool(server, "team_run", { teamId: started.result.team.id, maxParallel: 1 }) as { result: { sessions: Array<{ memberId: string }> } };
    const task = await callRegisteredTool(server, "team_task_create", {
      teamId: started.result.team.id,
      title: "Complete inside scheduler prompt",
      preferredMemberId: running.result.sessions[0]!.memberId
    }) as { result: { id: string } };

    const tick = await callRegisteredTool(server, "team_scheduler_tick", { teamId: started.result.team.id }) as { result?: { assignments: Array<{ taskId: string }>; decision: string }; error?: unknown };
    const state = await store.read();

    expect(tick.error).toBeUndefined();
    expect(tick.result.assignments).toEqual([expect.objectContaining({ taskId: task.result.id })]);
    expect(state.tasks[task.result.id]).toMatchObject({
      status: "completed",
      completionSummary: "completed inside scheduler prompt"
    });
    expect(Object.values(state.messages)).toEqual([expect.objectContaining({ body: "tool-called-inside-scheduler-prompt" })]);
    expect(state.events.map((event) => event.type)).toEqual(expect.arrayContaining(["message.sent", "task.completed", "scheduler.assignment", "scheduler.tick"]));
  });

  it("keeps default builder confirmation runtime-only without scaffold writes", async () => {
    const rootDir = await tempRoot();
    await writeDummyEntrypoint(rootDir);
    await initOpenCode({ rootDir, serverCommand: ["node", "./dist/index.js"] });
    const store = new JsonStore({ rootDir });
    const server = registeredServer(store, { backendFactory: () => new FakeAgentBackend() });
    const started = await callRegisteredTool(server, "team_start", { teamName: "runtime-only builder" }) as { result: { team: { id: string } } };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Runtime Member",
      model: "test/model",
      rawResponsibility: "Run through runtime sessions.",
      polishedPrompt: "Run through runtime sessions and report via runtime tools."
    });
    const confirmed = await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id }) as {
      result: { member: { id: string; agentId: string }; scaffoldGenerated: boolean; agentPath?: string };
    };
    const finished = await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id }) as { result: { runtime: { status: string } } };
    const removed = await callRegisteredTool(server, "team_remove_member", {
      teamId: started.result.team.id,
      agentId: "runtime-member"
    }) as { result: { member: { id: string }; scaffoldGenerated: boolean; agentPath?: string } };
    const config = JSON.parse(await readFile(join(rootDir, "opencode.json"), "utf8")) as { agent: Record<string, unknown> };

    expect(confirmed.result.member.agentId).toBe("runtime-member");
    expect(confirmed.result.scaffoldGenerated).toBe(false);
    expect(confirmed.result.agentPath).toBeUndefined();
    await expect(readFile(join(rootDir, ".opencode", "agents", "runtime-member.md"), "utf8")).rejects.toThrow();
    expect(config.agent["runtime-member"]).toBeUndefined();
    expect(finished.result.runtime.status).toBe("ready");
    expect(removed.result.member.id).toBe(confirmed.result.member.id);
    expect(removed.result.scaffoldGenerated).toBe(false);
    expect(removed.result.agentPath).toBeUndefined();
  });

  it("keeps default builder finish and status runtime-first without scaffold diagnostics", async () => {
    const rootDir = await tempRoot();
    await writeDummyEntrypoint(rootDir);
    await initOpenCode({ rootDir, serverCommand: ["node", "./dist/index.js"] });
    const store = new JsonStore({ rootDir });
    const server = registeredServer(store, { backendFactory: () => new FakeAgentBackend() });
    const started = await callRegisteredTool(server, "team_start", { teamName: "runtime status" }) as { result: { team: { id: string } } };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Runtime Reporter",
      model: "test/model",
      rawResponsibility: "Report runtime status.",
      polishedPrompt: "Report runtime status through runtime tools."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    const finished = await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id }) as Record<string, unknown>;
    const status = await callRegisteredTool(server, "team_status", { teamId: started.result.team.id }) as Record<string, unknown>;
    const result = finished.result as Record<string, unknown>;
    const statusResult = status.result as Record<string, unknown>;

    expect(result.runtime).toMatchObject({ status: "ready" });
    expect(result.nextPrompt).toContain("team_run");
    expect(result).not.toHaveProperty("reportPrompts");
    expect(result).not.toHaveProperty("membersToMention");
    expect(result).not.toHaveProperty("restartMayBeRequired");
    expect(result).not.toHaveProperty("reportingInstructions");
    expect(statusResult).toMatchObject({
      runtime: { status: "ready" },
      tasks: { pending: [], claimed: [], completed: [], failed: [], cancelled: [] },
      unreadMessages: expect.any(Object),
      pathLocks: []
    });
    expect(statusResult).not.toHaveProperty("diagnostics");
    expect(statusResult).not.toHaveProperty("reportPrompts");
    expect(statusResult).not.toHaveProperty("membersToMention");
  });

  it("exposes host-only routing without creating a runtime host session", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const server = registeredServer(store, { backendFactory: () => new FakeAgentBackend() });

    const started = await callRegisteredTool(server, "team_work", {
      request: "Create one implementation teammate.",
      team: {
        teamName: "host-only routing",
        hostName: "Main Host",
        hostModel: "openai/gpt-5.4",
        hostResponsibility: "Coordinate teammate work."
      }
    }) as {
      result: {
        mode: string;
        team: { id: string };
        host: {
          hostName?: string;
          hostModel?: string;
          hostResponsibility?: string;
          leadMode: string;
          escalationTarget: string;
          hostRuntimeSession: boolean;
        };
      };
    };
    const teamId = started.result.team.id;

    await callRegisteredTool(server, "team_work", {
      teamId,
      builder: {
        draftMember: {
          name: "Builder",
          model: "test/model",
          rawResponsibility: "Implement focused changes.",
          polishedPrompt: "Implement focused changes."
        }
      }
    });
    await callRegisteredTool(server, "team_work", { teamId, builder: { confirmMember: true } });
    await callRegisteredTool(server, "team_work", { teamId, builder: { finishTeam: true } });
    const running = await callRegisteredTool(server, "team_run", { teamId, maxParallel: 1 }) as {
      result: { sessions: Array<{ memberId: string }> };
    };
    const status = await callRegisteredTool(server, "team_status", { teamId }) as {
      result: {
        host: {
          hostName?: string;
          hostModel?: string;
          hostResponsibility?: string;
          leadMode: string;
          escalationTarget: string;
          hostRuntimeSession: boolean;
          leadMemberId?: string;
        };
        members: Array<{ name: string }>;
        sessions: Array<{ memberId: string }>;
      };
    };
    const state = await store.read();

    expect(started.result.host).toMatchObject({
      hostName: "Main Host",
      hostModel: "openai/gpt-5.4",
      hostResponsibility: "Coordinate teammate work.",
      leadMode: "host_only",
      escalationTarget: "host",
      hostRuntimeSession: false
    });
    expect(status.result.host).toMatchObject({
      hostName: "Main Host",
      hostModel: "openai/gpt-5.4",
      hostResponsibility: "Coordinate teammate work.",
      leadMode: "host_only",
      escalationTarget: "host",
      hostRuntimeSession: false
    });
    expect(status.result.host.leadMemberId).toBeUndefined();
    expect(status.result.members).toEqual([expect.objectContaining({ name: "Builder" })]);
    expect(status.result.members.map((member) => member.name)).not.toContain("Main Host");
    expect(running.result.sessions).toHaveLength(1);
    expect(status.result.sessions).toHaveLength(1);
    expect(Object.values(state.agentSessions)).toHaveLength(1);
  });

  it("shows team runtime control-plane status for runnable and blocked work", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const server = registeredServer(store, { backendFactory: () => new FakeAgentBackend() });
    const started = await callRegisteredTool(server, "team_start", { teamName: "control plane" }) as { result: { team: { id: string } } };

    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Patch Builder",
      model: "test/model",
      rawResponsibility: "Implement runtime patches.",
      polishedPrompt: "Implement runtime patches.",
      permissions: ["read-only"]
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });
    const running = await callRegisteredTool(server, "team_run", { teamId: started.result.team.id, maxParallel: 1 }) as { result: { sessions: Array<{ memberId: string }> } };
    const memberId = running.result.sessions[0]!.memberId;
    const dependency = await callRegisteredTool(server, "team_task_create", {
      teamId: started.result.team.id,
      title: "Prepare API"
    }) as { result: { id: string } };
    const runnable = await callRegisteredTool(server, "team_task_create", {
      teamId: started.result.team.id,
      title: "Runnable implementation"
    }) as { result: { id: string } };
    const blocked = await callRegisteredTool(server, "team_task_create", {
      teamId: started.result.team.id,
      title: "Blocked implementation",
      dependencyTaskIds: [dependency.result.id]
    }) as { result: { id: string } };

    await callRegisteredTool(server, "team_message", {
      teamId: started.result.team.id,
      toMemberId: memberId,
      type: "question",
      body: "Please inspect this before continuing."
    });
    const denied = await callRegisteredTool(server, "lock_paths", {
      teamId: started.result.team.id,
      ownerMemberId: memberId,
      taskId: runnable.result.id,
      paths: ["src/runtime/status.ts"]
    }) as { error?: unknown };
    const status = await callRegisteredTool(server, "team_status", { teamId: started.result.team.id }) as {
      result: {
        explain: {
          phase: string;
          headline: string;
          blockingReason?: string;
          recommendedNextAction: string;
          recoveryHint?: string;
          lastMeaningfulEvent?: { type: string };
        };
        controlPlane: {
          sessionBuckets: { idle: Array<{ memberId: string }> };
          taskBuckets: {
            runnable: Array<{ id: string }>;
            blockedByDependency: Array<{ id: string; blockReasons: string[] }>;
          };
          inbox: { unreadByMember: Record<string, number>; threadsNeedingAttention: Array<{ body: string }> };
          policy: { recentBlocks: Array<{ type: string }> };
          safety: {
            highestLevel?: string;
            blockedCount: number;
            recent: Array<{ kind: string }>;
          };
          nextActions: string[];
        };
        compactStatus: {
          safety?: { level: string; headline: string; recommendedAction: string };
        };
      };
    };
    const runtimeStatus = await callRegisteredTool(server, "team_runtime_status", { teamId: started.result.team.id }) as {
      result: {
        controlPlane: {
          taskBuckets: {
            runnable: Array<{ id: string }>;
            blockedByDependency: Array<{ id: string; blockReasons: string[] }>;
          };
          policy: { recentBlocks: Array<{ type: string }> };
          safety: { highestLevel?: string };
          nextActions: string[];
        };
      };
    };
    const results = await callRegisteredTool(server, "team_results", { teamId: started.result.team.id }) as {
      result: {
        explain: {
          headline: string;
          blockingReason?: string;
          recommendedNextAction: string;
          safety?: { level: string; recommendedAction: string };
        };
        compactResults: {
          headline: string;
          supportingLine: string;
          safety?: { level: string; recommendedAction: string };
        };
      };
    };

    expect(denied.error).toBeDefined();
    expect(status.result.controlPlane.sessionBuckets.idle).toEqual([expect.objectContaining({ memberId })]);
    expect(status.result.controlPlane.taskBuckets.runnable.map((task) => task.id)).toContain(runnable.result.id);
    expect(status.result.controlPlane.taskBuckets.runnable.map((task) => task.id)).not.toContain(blocked.result.id);
    expect(status.result.controlPlane.taskBuckets.blockedByDependency).toEqual([
      expect.objectContaining({
        id: blocked.result.id,
        blockReasons: [expect.stringContaining(`dependency ${dependency.result.id} is pending`)]
      })
    ]);
    expect(status.result.controlPlane.inbox.unreadByMember[memberId]).toBe(1);
    expect(status.result.controlPlane.inbox.threadsNeedingAttention).toEqual([expect.objectContaining({ body: "Please inspect this before continuing." })]);
    expect(status.result.controlPlane.policy.recentBlocks).toEqual([expect.objectContaining({ type: "policy.blocked" })]);
    expect(status.result.controlPlane.safety).toMatchObject({
      highestLevel: "blocked",
      blockedCount: 1,
      recent: expect.arrayContaining([expect.objectContaining({ kind: "policy_blocked" })])
    });
    expect(status.result.compactStatus.safety).toMatchObject({
      level: "blocked",
      headline: expect.stringContaining("not allowed to lock_paths"),
      recommendedAction: "Use team_work with work.review.decision=acknowledge to review the blocked action before rerunning work."
    });
    expect(status.result.compactStatus.nextAction).toBe("Use team_work with work.review.decision=acknowledge to review the blocked action before rerunning work.");
    expect(status.result.controlPlane.nextActions).toEqual(expect.arrayContaining([
      "Use team_work with work.review.decision=acknowledge to review the blocked action before rerunning work.",
      "Continue with team_work to assign runnable work and advance bounded progress.",
      "Resolve or complete dependency tasks before blocked pending work can run.",
      "Review recent policy.blocked events before rerunning the affected task.",
      "Review unread runtime messages or route them to the relevant teammate."
    ]));
    expect(status.result.explain).toMatchObject({
      phase: "attention",
      headline: expect.stringContaining("Safety block:"),
      blockingReason: expect.stringContaining("not allowed to lock_paths"),
      recommendedNextAction: "Use team_work with work.review.decision=acknowledge to review the blocked action before rerunning work.",
      recoveryHint: "Use team_work with work.review.decision=acknowledge to review the blocked action before rerunning work.",
      safety: expect.objectContaining({
        level: "blocked",
        headline: expect.stringContaining("not allowed to lock_paths")
      }),
      lastMeaningfulEvent: expect.objectContaining({ type: "policy.blocked" })
    });
    expect(results.result.explain).toMatchObject({
      headline: expect.stringContaining("Safety block"),
      blockingReason: expect.stringContaining("not allowed to lock_paths"),
      recommendedNextAction: "Use team_work with work.review.decision=acknowledge to review the blocked action before rerunning work.",
      safety: expect.objectContaining({
        level: "blocked",
        recommendedAction: "Use team_work with work.review.decision=acknowledge to review the blocked action before rerunning work."
      })
    });
    expect(results.result.compactResults).toMatchObject({
      headline: expect.stringContaining("Safety block"),
      supportingLine: expect.stringContaining("not allowed to lock_paths"),
      safety: expect.objectContaining({
        level: "blocked",
        recommendedAction: "Use team_work with work.review.decision=acknowledge to review the blocked action before rerunning work."
      })
    });
    expect(runtimeStatus.result.controlPlane.taskBuckets.runnable.map((task) => task.id)).toContain(runnable.result.id);
    expect(runtimeStatus.result.controlPlane.taskBuckets.blockedByDependency[0]?.blockReasons).toEqual([expect.stringContaining(`dependency ${dependency.result.id} is pending`)]);
    expect(runtimeStatus.result.controlPlane.policy.recentBlocks).toEqual([expect.objectContaining({ type: "policy.blocked" })]);
    expect(runtimeStatus.result.controlPlane.safety.highestLevel).toBe("blocked");
    expect(runtimeStatus.result.controlPlane.nextActions).toEqual(status.result.controlPlane.nextActions);
  });

  it("allows adding more members after finalization by resuming the build", async () => {
    const rootDir = await tempRoot();
    await writeDummyEntrypoint(rootDir);
    await initOpenCode({ rootDir, serverCommand: ["node", "./dist/index.js"] });
    const store = new JsonStore({ rootDir });
    const started = await runOpenCodeTool(store, "team_start", { teamName: "resume-build" }) as { team: { id: string } };

    await runOpenCodeTool(store, "team_draft", {
      teamId: started.team.id,
      name: "Scope Keeper",
      model: "openai/gpt-5.4",
      rawResponsibility: "Keep scope tight.",
      polishedPrompt: "Keep scope tight and challenge ambiguous expansion."
    });
    await runOpenCodeTool(store, "team_confirm", { teamId: started.team.id });
    await runOpenCodeTool(store, "team_finish", { teamId: started.team.id });

    await runOpenCodeTool(store, "team_draft", {
      teamId: started.team.id,
      name: "Patch Builder",
      model: "openai/gpt-5.4",
      rawResponsibility: "Implement small patches.",
      polishedPrompt: "Implement small confirmed patches and report changed files."
    });
    await runOpenCodeTool(store, "team_confirm", { teamId: started.team.id });

    const status = await runOpenCodeTool(store, "team_status", { teamId: started.team.id }) as {
      finalized: boolean;
      members: Array<{ name: string }>;
      nextPrompt: string;
    };

    expect(status.finalized).toBe(false);
    expect(status.members.map((member) => member.name)).toEqual(["Scope Keeper", "Patch Builder"]);
    expect(status.nextPrompt).toContain("create the next member");
  });

  it("removes a confirmed member and cleans its generated files and registration", async () => {
    const rootDir = await tempRoot();
    await writeDummyEntrypoint(rootDir);
    await initOpenCode({ rootDir, serverCommand: ["node", "./dist/index.js"] });
    const store = new JsonStore({ rootDir });
    const started = await runOpenCodeTool(store, "team_start", { teamName: "remove-member" }) as { team: { id: string } };

    await runOpenCodeTool(store, "team_draft", {
      teamId: started.team.id,
      name: "Patch Builder",
      model: "openai/gpt-5.4",
      rawResponsibility: "Implement small patches.",
      polishedPrompt: "Implement small confirmed patches and report changed files."
    });
    await runOpenCodeTool(store, "team_confirm", { teamId: started.team.id });
    await runOpenCodeTool(store, "team_finish", { teamId: started.team.id });

    const removed = await runOpenCodeTool(store, "team_remove_member", {
      teamId: started.team.id,
      agentId: "patch-builder"
    }) as { member: { name: string }; agentPath?: string };
    const status = await runOpenCodeTool(store, "team_status", { teamId: started.team.id }) as {
      finalized: boolean;
      members: Array<{ name: string }>;
      membersToMention: string[];
    };
    const config = JSON.parse(await readFile(join(rootDir, "opencode.json"), "utf8")) as {
      agent: Record<string, unknown>;
    };

    expect(removed.member.name).toBe("Patch Builder");
    expect(removed.agentPath).toContain("patch-builder.md");
    await expect(readFile(join(rootDir, ".opencode", "agents", "patch-builder.md"), "utf8")).rejects.toThrow();
    expect(config.agent["patch-builder"]).toBeUndefined();
    expect(status.finalized).toBe(false);
    expect(status.members).toEqual([]);
    expect(status.membersToMention).toEqual([]);
  });

  it("parses OpenCode model output independently", () => {
    expect(parseOpenCodeModels("anthropic/claude-sonnet-4.5 openai/gpt-5.1\nnot-a-model")).toEqual([
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-5.1"
    ]);
  });

  it("writes agent files without overwriting unless forced", async () => {
    const rootDir = await tempRoot();
    const draft: TeamMemberDraft = {
      id: "draft_test",
      teamId: "team_test",
      name: "Safety Reviewer",
      agentId: slugifyAgentId("Safety Reviewer"),
      model: "test/model",
      rawResponsibility: "Review safety.",
      polishedPrompt: "Review safety and call out risky behavior.",
      permissions: ["read-only"],
      callWhen: [],
      doNot: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const path = await writeAgentFile({ rootDir, draft });
    await expect(writeAgentFile({ rootDir, draft })).rejects.toThrow(ConflictError);
    await writeAgentFile({ rootDir, draft, force: true });

    expect(path).toContain("safety-reviewer.md");
    expect(await readFile(path, "utf8")).toContain("Review safety");
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "team-mcpv2-"));
  tempRoots.push(root);
  return root;
}

async function writeDummyEntrypoint(rootDir: string): Promise<void> {
  await mkdir(join(rootDir, "dist"), { recursive: true });
  await writeFile(join(rootDir, "dist", "index.js"), "#!/usr/bin/env node\n", "utf8");
}

function registeredToolNames(store: JsonStore): string[] {
  const server = registeredServer(store, { advancedTools: false });
  const toolRegistry = server as unknown as { _registeredTools: Record<string, unknown> };
  return Object.keys(toolRegistry._registeredTools).sort();
}

function registeredToolDefinitions(store: JsonStore): Record<string, { description?: string; title?: string }> {
  const server = registeredServer(store, { advancedTools: false });
  const toolRegistry = server as unknown as { _registeredTools: Record<string, { description?: string; title?: string }> };
  return toolRegistry._registeredTools;
}

function registeredServer(store: JsonStore, options: RegisterToolsOptions = {}): McpServer {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server, store, { advancedTools: true, ...options });
  return server;
}

class ToolCallingBackend implements AgentBackend {
  readonly name = "opencode" as const;
  private started = false;

  constructor(private readonly store: JsonStore) {}

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async spawnSession(input: SpawnSessionInput): Promise<SpawnSessionResult> {
    this.requireStarted();
    return { backendSessionId: `tool_${input.memberId}`, status: "idle" };
  }

  async promptSession(input: PromptSessionInput): Promise<PromptSessionResult> {
    this.requireStarted();
    const memberId = matchPromptValue(input.prompt, /memberId=([^\s.]+)/);
    const taskId = matchPromptValue(input.prompt, /taskId=([^\s.]+)/);
    await this.store.transaction((state) => {
      const task = state.tasks[taskId];
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }
      new MailboxService(state).sendMessage({
        teamId: task.teamId,
        fromMemberId: memberId,
        taskId,
        type: "result",
        body: "tool-called-inside-scheduler-prompt"
      });
      new TaskService(state).completeTask({
        teamId: task.teamId,
        taskId,
        memberId,
        completionSummary: "completed inside scheduler prompt"
      });
    });
    return { summary: "scheduler prompt tool calls completed" };
  }

  async abortSession(_sessionId: string): Promise<void> {}

  private requireStarted(): void {
    if (!this.started) {
      throw new Error("backend is not started");
    }
  }
}

function matchPromptValue(prompt: string, pattern: RegExp): string {
  const match = prompt.match(pattern);
  if (!match?.[1]) {
    throw new Error(`Prompt did not contain ${pattern}`);
  }
  return match[1];
}

async function callRegisteredTool(server: McpServer, name: string, input: Record<string, unknown>): Promise<unknown> {
  const toolRegistry = server as unknown as { _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> };
  const response = await toolRegistry._registeredTools[name]!.handler(input);
  return JSON.parse(response.content[0]!.text) as unknown;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
