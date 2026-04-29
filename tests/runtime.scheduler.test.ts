import { describe, expect, it } from "vitest";
import { emptyState, type Member, type Task, type Team } from "../src/domain/types.js";
import type { AgentBackend } from "../src/runtime/agentBackend.js";
import { FakeAgentBackend } from "../src/runtime/fakeAgentBackend.js";
import { RuntimeService } from "../src/runtime/runtimeService.js";
import { RuntimeScheduler } from "../src/runtime/scheduler.js";
import { RuntimeSchedulerRunner } from "../src/runtime/schedulerRunner.js";
import type { PromptSessionInput, PromptSessionResult, SpawnSessionInput, SpawnSessionResult } from "../src/runtime/types.js";
import { MailboxService } from "../src/services/mailboxService.js";
import { PathLockService } from "../src/services/pathLockService.js";
import { TaskService } from "../src/services/taskService.js";
import { TeamService } from "../src/services/teamService.js";

describe("RuntimeScheduler", () => {
  it("assigns one pending task to one idle session", async () => {
    const setup = await setupRuntime();
    const task = new TaskService(setup.state).createTask({ teamId: setup.team.id, title: "Implement scheduler" });

    const result = await new RuntimeScheduler(setup.state, setup.backend).tick({ teamId: setup.team.id });

    expect(result.assignments).toEqual([expect.objectContaining({ taskId: task.id, memberId: setup.members[0]!.id })]);
    expect(setup.state.tasks[task.id]?.status).toBe("claimed");
    expect(setup.state.agentSessions[result.assignments[0]!.sessionId]?.status).toBe("working");
    expect(setup.backend.prompts).toHaveLength(1);
    expect(setup.backend.prompts[0]?.prompt).toContain("Task for Worker");
    expect(setup.backend.prompts[0]?.prompt).toContain(`teamId=${setup.team.id}`);
    expect(setup.backend.prompts[0]?.prompt).toContain("Goal: Implement scheduler");
    expect(setup.backend.prompts[0]?.prompt).toContain(`taskId=${task.id}`);
    expect(setup.backend.prompts[0]?.prompt).toContain("Scope: no explicit edit scope recorded; ask_lead before broad edits.");
    expect(setup.state.events.map((event) => event.type)).toContain("scheduler.assignment");
  });

  it("does not complete a task from natural-language prompt output", async () => {
    const setup = await setupRuntime();
    const task = new TaskService(setup.state).createTask({
      teamId: setup.team.id,
      title: "Say done",
      description: "Reply that the work is done without calling complete_task."
    });

    const result = await new RuntimeScheduler(setup.state, setup.backend).tick({ teamId: setup.team.id });
    const session = setup.state.agentSessions[result.assignments[0]!.sessionId]!;

    expect(setup.state.tasks[task.id]).toMatchObject({ status: "claimed", assignedMemberId: setup.members[0]!.id });
    expect(session).toMatchObject({ status: "working", currentTaskId: task.id, lastResultSummary: `Prompted ${session.backendSessionId}` });
    expect(setup.state.events.map((event) => event.type)).not.toContain("task.completed");
  });

  it("assigns two independent tasks to two idle sessions", async () => {
    const setup = await setupRuntime({ memberNames: ["Patch Builder", "Scope Keeper"] });
    const tasks = new TaskService(setup.state);
    const first = tasks.createTask({ teamId: setup.team.id, title: "Implement patch", preferredMemberId: setup.members[0]!.id });
    const second = tasks.createTask({ teamId: setup.team.id, title: "Review scope", preferredMemberId: setup.members[1]!.id });

    const result = await new RuntimeScheduler(setup.state, setup.backend).tick({ teamId: setup.team.id });

    expect(result.assignments).toHaveLength(2);
    expect(result.assignments.map((assignment) => assignment.taskId).sort()).toEqual([first.id, second.id].sort());
    expect(setup.state.tasks[first.id]?.assignedMemberId).toBe(setup.members[0]!.id);
    expect(setup.state.tasks[second.id]?.assignedMemberId).toBe(setup.members[1]!.id);
    expect(setup.backend.prompts).toHaveLength(2);
  });

  it("does not assign dependent tasks until dependencies complete", async () => {
    const setup = await setupRuntime();
    const tasks = new TaskService(setup.state);
    const dependency = tasks.createTask({ teamId: setup.team.id, title: "Prepare API" });
    const dependent = tasks.createTask({ teamId: setup.team.id, title: "Use API", dependencyTaskIds: [dependency.id] });

    const firstTick = await new RuntimeScheduler(setup.state, setup.backend).tick({ teamId: setup.team.id });
    tasks.completeTask({ teamId: setup.team.id, taskId: dependency.id, memberId: setup.members[0]!.id, completionSummary: "API ready" });
    idleAllSessions(setup.state, setup.team.id);
    const secondTick = await new RuntimeScheduler(setup.state, setup.backend).tick({ teamId: setup.team.id });

    expect(firstTick.assignments).toEqual([expect.objectContaining({ taskId: dependency.id })]);
    expect(setup.state.tasks[dependent.id]?.status).toBe("claimed");
    expect(secondTick.assignments).toEqual([expect.objectContaining({ taskId: dependent.id })]);
  });

  it("recycles completed task sessions before assigning unblocked work", async () => {
    const setup = await setupRuntime();
    const tasks = new TaskService(setup.state);
    const dependency = tasks.createTask({ teamId: setup.team.id, title: "Prepare API" });
    const dependent = tasks.createTask({ teamId: setup.team.id, title: "Use API", dependencyTaskIds: [dependency.id] });

    const firstTick = await new RuntimeScheduler(setup.state, setup.backend).tick({ teamId: setup.team.id });
    const session = setup.state.agentSessions[firstTick.assignments[0]!.sessionId]!;
    tasks.completeTask({ teamId: setup.team.id, taskId: dependency.id, memberId: setup.members[0]!.id, completionSummary: "API ready" });

    const secondTick = await new RuntimeScheduler(setup.state, setup.backend).tick({ teamId: setup.team.id });

    expect(session.status).toBe("working");
    expect(session.currentTaskId).toBe(dependent.id);
    expect(session.lastResultSummary).toContain("Prompted");
    expect(secondTick.assignments).toEqual([expect.objectContaining({ taskId: dependent.id })]);
    expect(setup.state.events.map((event) => event.type)).toContain("scheduler.completion");
  });

  it("advances dependent work only after tool-driven task completion", async () => {
    const setup = await setupRuntime();
    const tasks = new TaskService(setup.state);
    const dependency = tasks.createTask({ teamId: setup.team.id, title: "Complete via tool" });
    const dependent = tasks.createTask({ teamId: setup.team.id, title: "Run after tool completion", dependencyTaskIds: [dependency.id] });

    const firstTick = await new RuntimeScheduler(setup.state, setup.backend).tick({ teamId: setup.team.id });
    const session = setup.state.agentSessions[firstTick.assignments[0]!.sessionId]!;
    expect(setup.state.tasks[dependency.id]?.status).toBe("claimed");
    expect(setup.state.tasks[dependent.id]?.status).toBe("pending");

    tasks.completeTask({
      teamId: setup.team.id,
      taskId: dependency.id,
      memberId: setup.members[0]!.id,
      completionSummary: "completed through complete_task",
      resultArtifacts: ["tool-contract"]
    });
    const secondTick = await new RuntimeScheduler(setup.state, setup.backend).tick({ teamId: setup.team.id });

    expect(session.status).toBe("working");
    expect(session.currentTaskId).toBe(dependent.id);
    expect(session.lastResultSummary).toContain("Prompted");
    expect(setup.state.tasks[dependency.id]).toMatchObject({
      status: "completed",
      completionSummary: "completed through complete_task",
      resultArtifacts: ["tool-contract"]
    });
    expect(setup.state.tasks[dependent.id]).toMatchObject({ status: "claimed", assignedMemberId: setup.members[0]!.id });
    expect(secondTick.assignments).toEqual([expect.objectContaining({ taskId: dependent.id })]);
    expect(setup.state.events.map((event) => event.type)).toEqual(expect.arrayContaining(["task.completed", "scheduler.completion"]));
  });

  it("marks failed task sessions as error and does not assign them", async () => {
    const setup = await setupRuntime();
    const tasks = new TaskService(setup.state);
    const failing = tasks.createTask({ teamId: setup.team.id, title: "Fail this", preferredMemberId: setup.members[0]!.id });
    const next = tasks.createTask({ teamId: setup.team.id, title: "Do next", preferredMemberId: setup.members[0]!.id });

    const firstTick = await new RuntimeScheduler(setup.state, setup.backend).tick({ teamId: setup.team.id });
    const failedSessionId = firstTick.assignments.find((assignment) => assignment.taskId === failing.id)!.sessionId;
    tasks.failTask({ teamId: setup.team.id, taskId: failing.id, memberId: setup.members[0]!.id, failureSummary: "broken" });

    const secondTick = await new RuntimeScheduler(setup.state, setup.backend).tick({ teamId: setup.team.id });

    expect(setup.state.agentSessions[failedSessionId]?.status).toBe("error");
    expect(setup.state.agentSessions[failedSessionId]?.currentTaskId).toBeUndefined();
    expect(setup.state.agentSessions[failedSessionId]?.errorMessage).toBe("broken");
    expect(secondTick.assignments.map((assignment) => assignment.taskId)).not.toContain(next.id);
    expect(setup.state.events.map((event) => event.type)).toContain("scheduler.failure");
  });

  it("recycles cancelled task sessions as idle", async () => {
    const setup = await setupRuntime();
    const tasks = new TaskService(setup.state);
    const cancelled = tasks.createTask({ teamId: setup.team.id, title: "Cancel this" });

    const firstTick = await new RuntimeScheduler(setup.state, setup.backend).tick({ teamId: setup.team.id });
    const session = setup.state.agentSessions[firstTick.assignments[0]!.sessionId]!;
    tasks.cancelTask({ teamId: setup.team.id, taskId: cancelled.id, memberId: setup.members[0]!.id, reason: "not needed" });

    const secondTick = await new RuntimeScheduler(setup.state, setup.backend).tick({ teamId: setup.team.id });

    expect(session.status).toBe("idle");
    expect(session.currentTaskId).toBeUndefined();
    expect(secondTick.assignments).toEqual([]);
    expect(setup.state.events.map((event) => event.type)).toContain("scheduler.cancellation");
  });

  it("prefers preferredMemberId over text scoring", async () => {
    const setup = await setupRuntime({ memberNames: ["Patch Builder", "Scope Keeper"] });
    setup.members[0]!.rawResponsibility = "Implement patch work";
    setup.members[1]!.rawResponsibility = "Keep scope clear";
    const task = new TaskService(setup.state).createTask({
      teamId: setup.team.id,
      title: "Implement patch",
      preferredMemberId: setup.members[1]!.id
    });

    const result = await new RuntimeScheduler(setup.state, setup.backend).tick({ teamId: setup.team.id });

    expect(result.assignments).toEqual([expect.objectContaining({ taskId: task.id, memberId: setup.members[1]!.id })]);
  });

  it("includes explicit scope hints in task prompts", async () => {
    const setup = await setupRuntime();
    new TaskService(setup.state).createTask({
      teamId: setup.team.id,
      title: "Edit runtime files",
      pathHints: ["src/runtime/**"]
    });

    await new RuntimeScheduler(setup.state, setup.backend).tick({ teamId: setup.team.id });

    expect(setup.backend.prompts[0]?.prompt).toContain("Scope: stay within src/runtime/**; ask_lead if broader edits are needed.");
    expect(setup.backend.prompts[0]?.prompt).toContain("Paths: src/runtime/**");
  });

  it("prompts a conversation turn for unconsumed member inbox messages before assigning task work", async () => {
    const setup = await setupRuntime({ memberNames: ["Sender", "Receiver"] });
    const tasks = new TaskService(setup.state);
    const task = tasks.createTask({ teamId: setup.team.id, title: "Use API", preferredMemberId: setup.members[1]!.id });
    const message = new MailboxService(setup.state).sendMessage({
      teamId: setup.team.id,
      fromMemberId: setup.members[0]!.id,
      toMemberId: setup.members[1]!.id,
      taskId: task.id,
      type: "question",
      subject: "API shape",
      body: "Please confirm the response schema."
    });

    await new RuntimeScheduler(setup.state, setup.backend).tick({ teamId: setup.team.id });

    expect(setup.backend.prompts[0]?.prompt).toContain("Conversation turn for Receiver");
    expect(setup.backend.prompts[0]?.prompt).toContain(message.id);
    expect(setup.backend.prompts[0]?.prompt).toContain("Subject: API shape");
    expect(setup.backend.prompts[0]?.prompt).toContain("Body: Please confirm the response schema.");
    expect(setup.backend.prompts[0]?.prompt).toContain("replyToMessageId");
    expect(setup.state.messages[message.id]?.consumedAt).toBeTruthy();
    expect(setup.state.messages[message.id]?.acknowledgedAt).toBeUndefined();
    expect(Object.values(setup.state.messageDeliveries).find((delivery) => delivery.messageId === message.id && delivery.memberId === setup.members[1]!.id)?.consumedAt).toBeTruthy();
  });

  it("prompts the addressed teammate to answer a direct member message without host relay", async () => {
    const setup = await setupRuntime({ memberNames: ["Author", "Reviewer"] });
    const message = new MailboxService(setup.state).sendMessage({
      teamId: setup.team.id,
      fromMemberId: setup.members[0]!.id,
      toMemberId: setup.members[1]!.id,
      type: "question",
      subject: "Review request",
      body: "Can you check this approach?"
    });

    const result = await new RuntimeScheduler(setup.state, setup.backend).tick({ teamId: setup.team.id });

    expect(result.assignments).toEqual([expect.objectContaining({
      messageId: message.id,
      memberId: setup.members[1]!.id
    })]);
    expect(setup.backend.prompts[0]?.prompt).toContain("Conversation turn for Reviewer");
    expect(setup.backend.prompts[0]?.prompt).toContain("Subject: Review request");
    expect(setup.state.agentSessions[result.assignments[0]!.sessionId]?.currentMessageId).toBeUndefined();
    expect(setup.state.events.map((event) => event.type)).toContain("scheduler.conversation");
  });

  it("keeps an async conversation turn visible until the member actually handles the message", async () => {
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "async conversation" }).team;
    const author = teams.addMember({ teamId: team.id, name: "Author" });
    const reviewer = teams.addMember({ teamId: team.id, name: "Reviewer" });
    const backend = new WaitingConversationBackend();
    await new RuntimeService(state, backend).start({ teamId: team.id, maxParallel: 2 });
    const message = new MailboxService(state).sendMessage({
      teamId: team.id,
      fromMemberId: author.id,
      toMemberId: reviewer.id,
      type: "question",
      subject: "Review request",
      body: "Please respond when ready."
    });

    const firstTick = await new RuntimeScheduler(state, backend).tick({ teamId: team.id });
    const session = state.agentSessions[firstTick.assignments[0]!.sessionId]!;

    expect(firstTick.assignments).toEqual([expect.objectContaining({ messageId: message.id, memberId: reviewer.id })]);
    expect(session).toMatchObject({
      status: "waiting",
      currentMessageId: message.id
    });
    expect(state.events.map((event) => event.type)).toContain("scheduler.conversation_waiting");

    new MailboxService(state).sendMessage({
      teamId: team.id,
      fromMemberId: reviewer.id,
      type: "opinion",
      body: "I have handled the request.",
      replyToMessageId: message.id
    });

    const secondTick = await new RuntimeScheduler(state, backend).tick({ teamId: team.id });

    expect(secondTick.assignments).toEqual([]);
    expect(session).toMatchObject({
      status: "idle",
      currentMessageId: undefined
    });
    expect(state.events.map((event) => event.type)).toContain("scheduler.conversation_resolved");
  });

  it("prompts the current-round follow-up question rather than the original root discussion prompt", async () => {
    const setup = await setupRuntime({ memberNames: ["Author", "Reviewer"] });
    const mailbox = new MailboxService(setup.state);
    const root = mailbox.sendMessage({
      teamId: setup.team.id,
      type: "question",
      subject: "Direction",
      body: "Share one opinion each.",
      participantMemberIds: setup.members.map((member) => member.id)
    });
    mailbox.consumeMessages({ teamId: setup.team.id, memberId: setup.members[0]!.id, messageIds: [root.id] });
    mailbox.consumeMessages({ teamId: setup.team.id, memberId: setup.members[1]!.id, messageIds: [root.id] });
    const followUp = mailbox.sendMessage({
      teamId: setup.team.id,
      fromMemberId: setup.members[0]!.id,
      toMemberId: setup.members[1]!.id,
      type: "question",
      subject: "Can you narrow the field list?",
      body: "Reply with the smallest host-facing thread fields.",
      replyToMessageId: root.id
    });

    const result = await new RuntimeScheduler(setup.state, setup.backend).tick({ teamId: setup.team.id });

    expect(result.assignments).toEqual([expect.objectContaining({
      messageId: followUp.id,
      memberId: setup.members[1]!.id
    })]);
    expect(setup.backend.prompts[0]?.prompt).toContain(`messageId=${followUp.id}`);
    expect(setup.backend.prompts[0]?.prompt).toContain("Round: Current round started with a member question and is waiting for 1 member response.");
    expect(setup.backend.prompts[0]?.prompt).not.toContain(`messageId=${root.id}`);
  });

  it("prompts the host decision notification as the current round anchor for every pending member", async () => {
    const setup = await setupRuntime({ memberNames: ["Author", "Reviewer"] });
    const mailbox = new MailboxService(setup.state);
    const root = mailbox.sendMessage({
      teamId: setup.team.id,
      type: "question",
      subject: "Direction",
      body: "Share one opinion each.",
      participantMemberIds: setup.members.map((member) => member.id)
    });
    mailbox.consumeMessages({ teamId: setup.team.id, memberId: setup.members[0]!.id, messageIds: [root.id] });
    mailbox.consumeMessages({ teamId: setup.team.id, memberId: setup.members[1]!.id, messageIds: [root.id] });
    mailbox.sendMessage({
      teamId: setup.team.id,
      fromMemberId: setup.members[0]!.id,
      type: "opinion",
      body: "Keep the runtime contract small.",
      replyToMessageId: root.id
    });
    mailbox.sendMessage({
      teamId: setup.team.id,
      fromMemberId: setup.members[1]!.id,
      type: "opinion",
      body: "Make host views compact first.",
      replyToMessageId: root.id
    });
    const hostDecision = mailbox.sendMessage({
      teamId: setup.team.id,
      type: "notification",
      subject: "Direction",
      body: "Host decision: use the derived thread state and continue.",
      replyToMessageId: root.id,
      participantMemberIds: setup.members.map((member) => member.id)
    });

    const result = await new RuntimeScheduler(setup.state, setup.backend).tick({ teamId: setup.team.id });

    expect(result.assignments).toHaveLength(2);
    expect(result.assignments.map((assignment) => assignment.messageId)).toEqual([hostDecision.id, hostDecision.id]);
    for (const prompt of setup.backend.prompts.map((entry) => entry.prompt)) {
      expect(prompt).toContain(`messageId=${hostDecision.id}`);
      expect(prompt).toContain("Round: Current round started with the host notification and is waiting for 2 member responses.");
    }
  });

  it("does not reprompt messages consumed by an earlier conversation turn", async () => {
    const setup = await setupRuntime({ memberNames: ["Receiver"] });
    const tasks = new TaskService(setup.state);
    const first = tasks.createTask({ teamId: setup.team.id, title: "First", preferredMemberId: setup.members[0]!.id });
    const second = tasks.createTask({ teamId: setup.team.id, title: "Second", preferredMemberId: setup.members[0]!.id });
    const message = new MailboxService(setup.state).sendMessage({
      teamId: setup.team.id,
      toMemberId: setup.members[0]!.id,
      taskId: first.id,
      body: "Only for first task."
    });

    const firstTick = await new RuntimeScheduler(setup.state, setup.backend).tick({ teamId: setup.team.id });
    const session = setup.state.agentSessions[firstTick.assignments[0]!.sessionId]!;
    tasks.cancelTask({ teamId: setup.team.id, taskId: first.id, memberId: setup.members[0]!.id, reason: "move on" });
    await new RuntimeScheduler(setup.state, setup.backend).tick({ teamId: setup.team.id });

    expect(session.currentTaskId).toBe(second.id);
    expect(setup.backend.prompts[0]?.prompt).toContain(message.id);
    expect(setup.backend.prompts[1]?.prompt).not.toContain(message.id);
    expect(setup.backend.prompts[1]?.prompt).not.toContain("Messages:");
  });

  it("injects path lock policy and active locks into task prompts", async () => {
    const setup = await setupRuntime({ memberNames: ["Owner", "Worker"] });
    const tasks = new TaskService(setup.state);
    const lockedTask = tasks.createTask({ teamId: setup.team.id, title: "Locked work", preferredMemberId: setup.members[0]!.id });
    const task = tasks.createTask({ teamId: setup.team.id, title: "Edit service", preferredMemberId: setup.members[1]!.id });
    const lock = new PathLockService(setup.state).lockPaths({
      teamId: setup.team.id,
      ownerMemberId: setup.members[0]!.id,
      taskId: lockedTask.id,
      paths: ["src/services/taskService.ts"]
    }).lock;

    await new RuntimeScheduler(setup.state, setup.backend).tick({ teamId: setup.team.id });

    const workerPrompt = setup.backend.prompts.find((prompt) => prompt.prompt.includes("Goal: Edit service"))?.prompt;
    expect(workerPrompt).toContain("Edits: lock_paths before edits; unlock_paths when done.");
    expect(workerPrompt).toContain("Active locks:");
    expect(workerPrompt).toContain(`src/services/taskService.ts by ${setup.members[0]!.id}`);
    expect(workerPrompt).toContain(`for ${lockedTask.id}`);
    expect(workerPrompt).not.toContain(lock.id);
  });

  it("expires stale locks at tick start before prompt injection", async () => {
    const setup = await setupRuntime({ memberNames: ["Owner", "Worker"] });
    const tasks = new TaskService(setup.state);
    tasks.createTask({ teamId: setup.team.id, title: "Edit service", preferredMemberId: setup.members[1]!.id });
    const expiredLock = new PathLockService(setup.state).lockPaths({
      teamId: setup.team.id,
      ownerMemberId: setup.members[0]!.id,
      paths: ["src/expired.ts"],
      expiresAt: "2000-01-01T00:00:00.000Z"
    }).lock;

    await new RuntimeScheduler(setup.state, setup.backend).tick({ teamId: setup.team.id });

    expect(setup.state.pathLocks[expiredLock.id]).toBeUndefined();
    expect(setup.backend.prompts[0]?.prompt).toContain("Edits: lock_paths before edits; unlock_paths when done.");
    expect(setup.backend.prompts[0]?.prompt).not.toContain("Active locks:");
    expect(setup.backend.prompts[0]?.prompt).not.toContain(expiredLock.id);
    expect(setup.state.events.map((event) => event.type)).toContain("path_lock.expired");
  });

  it("records a paused decision without assignments", async () => {
    const setup = await setupRuntime();
    new TaskService(setup.state).createTask({ teamId: setup.team.id, title: "Wait" });
    new RuntimeService(setup.state, setup.backend).pause({ teamId: setup.team.id });

    const result = await new RuntimeScheduler(setup.state, setup.backend).tick({ teamId: setup.team.id });

    expect(result.assignments).toEqual([]);
    expect(result.decision).toBe("Scheduler is paused");
    expect(setup.backend.prompts).toHaveLength(0);
    expect(setup.state.schedulerStates[setup.team.id]?.lastDecision).toBe("Scheduler is paused");
  });

  it("marks claimed task and session as failed when backend prompt fails", async () => {
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "prompt failure" }).team;
    const member = teams.addMember({ teamId: team.id, name: "Worker" });
    const backend = new FailingPromptBackend();
    const task = new TaskService(state).createTask({ teamId: team.id, title: "Trigger prompt failure" });
    await new RuntimeService(state, backend).start({ teamId: team.id });

    await expect(new RuntimeScheduler(state, backend).tick({ teamId: team.id })).rejects.toThrow("prompt failed");

    const session = Object.values(state.agentSessions)[0]!;
    expect(state.tasks[task.id]).toMatchObject({
      status: "failed",
      assignedMemberId: member.id,
      failureSummary: "Prompt failed: prompt failed"
    });
    expect(session).toMatchObject({ status: "error", currentTaskId: undefined, errorMessage: "prompt failed" });
    expect(state.events.map((event) => event.type)).toEqual(expect.arrayContaining(["task.failed", "scheduler.prompt_error"]));
  });

  it("runs bounded scheduler ticks until idle", async () => {
    const setup = await setupRuntime({ memberNames: ["One", "Two"] });
    new TaskService(setup.state).createTask({ teamId: setup.team.id, title: "Only task" });
    const runner = new RuntimeSchedulerRunner((input) => new RuntimeScheduler(setup.state, setup.backend).tick(input));

    const result = await runner.run({ teamId: setup.team.id, maxTicks: 5 });

    expect(result).toMatchObject({ ticksRun: 2, totalAssignments: 1, stoppedReason: "idle" });
    expect(result.decisions.map((decision) => decision.decision)).toEqual(["Assigned 1 task(s)", "No runnable assignments"]);
    expect(Object.values(setup.state.agentSessions)).toHaveLength(2);
  });

  it("stops a bounded run when the scheduler is paused", async () => {
    const setup = await setupRuntime();
    new TaskService(setup.state).createTask({ teamId: setup.team.id, title: "Wait" });
    new RuntimeService(setup.state, setup.backend).pause({ teamId: setup.team.id });
    const runner = new RuntimeSchedulerRunner((input) => new RuntimeScheduler(setup.state, setup.backend).tick(input));

    const result = await runner.run({ teamId: setup.team.id, maxTicks: 5 });

    expect(result).toMatchObject({ ticksRun: 1, totalAssignments: 0, stoppedReason: "paused" });
    expect(result.decisions[0]?.decision).toBe("Scheduler is paused");
    expect(setup.backend.prompts).toHaveLength(0);
  });

  it("stops a bounded run at maxTicks", async () => {
    const setup = await setupRuntime({ memberNames: ["One", "Two"] });
    const tasks = new TaskService(setup.state);
    tasks.createTask({ teamId: setup.team.id, title: "First", preferredMemberId: setup.members[0]!.id });
    tasks.createTask({ teamId: setup.team.id, title: "Second", preferredMemberId: setup.members[1]!.id });
    const runner = new RuntimeSchedulerRunner((input) => new RuntimeScheduler(setup.state, setup.backend).tick(input));

    const result = await runner.run({ teamId: setup.team.id, maxTicks: 1 });

    expect(result).toMatchObject({ ticksRun: 1, totalAssignments: 2, stoppedReason: "max_ticks" });
    expect(result.decisions[0]?.assignments).toHaveLength(2);
  });

  it("stops a bounded run when the timeout budget is exhausted", async () => {
    const setup = await setupRuntime();
    new TaskService(setup.state).createTask({ teamId: setup.team.id, title: "Timeout" });
    const runner = new RuntimeSchedulerRunner(async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new RuntimeScheduler(setup.state, setup.backend).tick(input);
    });

    const result = await runner.run({ teamId: setup.team.id, maxTicks: 5, timeoutMs: 1 });

    expect(result.stoppedReason).toBe("timeout");
    expect(result.ticksRun).toBe(1);
    expect(result.totalAssignments).toBe(1);
  });

  it("stops a bounded run when attention is required", async () => {
    const setup = await setupRuntime();
    new TaskService(setup.state).createTask({ teamId: setup.team.id, title: "Escalate" });
    const runner = new RuntimeSchedulerRunner((input) => new RuntimeScheduler(setup.state, setup.backend).tick(input));

    const result = await runner.run({
      teamId: setup.team.id,
      maxTicks: 5,
      shouldStopForAttention: () => "Host review needed."
    });

    expect(result).toMatchObject({
      ticksRun: 1,
      totalAssignments: 1,
      stoppedReason: "needs_attention",
      needsAttentionReason: "Host review needed."
    });
  });

  it("continues bounded polling across an idle tick when follow-up work may still arrive", async () => {
    const start = Date.now();
    let phase: "waiting" | "ready" = "waiting";
    let assigned = false;
    setTimeout(() => {
      phase = "ready";
    }, 20);
    const runner = new RuntimeSchedulerRunner(async () => {
      if (phase === "ready" && !assigned) {
        assigned = true;
        return {
          assignments: [{ taskId: "task_x", memberId: "member_x", sessionId: "session_x", backendSessionId: "backend_x" }],
          decision: "Assigned 1 task(s)"
        };
      }
      return { assignments: [], decision: "No runnable assignments" };
    });

    const result = await runner.run({
      teamId: "team_x",
      maxTicks: 3,
      timeoutMs: 200,
      idlePollMs: 25,
      shouldContinueWhenIdle: (decisions) => decisions.length === 1
    });

    expect(result).toMatchObject({ ticksRun: 3, totalAssignments: 1, stoppedReason: "idle" });
    expect(result.decisions.map((decision) => decision.decision)).toEqual([
      "No runnable assignments",
      "Assigned 1 task(s)",
      "No runnable assignments"
    ]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
  });

  it("returns structured bounded run errors by default", async () => {
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "runner prompt failure" }).team;
    teams.addMember({ teamId: team.id, name: "Worker" });
    const backend = new FailingPromptBackend();
    new TaskService(state).createTask({ teamId: team.id, title: "Trigger prompt failure" });
    await new RuntimeService(state, backend).start({ teamId: team.id });
    const runner = new RuntimeSchedulerRunner((input) => new RuntimeScheduler(state, backend).tick(input));

    const result = await runner.run({ teamId: team.id, maxTicks: 3 });

    expect(result).toMatchObject({ ticksRun: 0, totalAssignments: 0, stoppedReason: "error", error: { message: "prompt failed" } });
    expect(state.events.map((event) => event.type)).toEqual(expect.arrayContaining(["task.failed", "scheduler.prompt_error"]));
  });

  it("can rethrow bounded run errors when requested", async () => {
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "runner rethrow" }).team;
    teams.addMember({ teamId: team.id, name: "Worker" });
    const backend = new FailingPromptBackend();
    new TaskService(state).createTask({ teamId: team.id, title: "Trigger prompt failure" });
    await new RuntimeService(state, backend).start({ teamId: team.id });
    const runner = new RuntimeSchedulerRunner((input) => new RuntimeScheduler(state, backend).tick(input));

    await expect(runner.run({ teamId: team.id, maxTicks: 3, rethrowOnError: true })).rejects.toThrow("prompt failed");
  });
});

interface RuntimeSetup {
  state: ReturnType<typeof emptyState>;
  team: Team;
  members: Member[];
  backend: FakeAgentBackend;
}

async function setupRuntime(options: { memberNames?: string[] } = {}): Promise<RuntimeSetup> {
  const state = emptyState();
  const teams = new TeamService(state);
  const team = teams.createTeam({ name: "scheduler" }).team;
  const members = (options.memberNames ?? ["Worker"]).map((name) => teams.addMember({ teamId: team.id, name }));
  const backend = new FakeAgentBackend();
  await new RuntimeService(state, backend).start({ teamId: team.id, maxParallel: members.length });
  return { state, team, members, backend };
}

function idleAllSessions(state: ReturnType<typeof emptyState>, teamId: string): void {
  for (const session of Object.values(state.agentSessions)) {
    if (session.teamId === teamId) {
      session.status = "idle";
      session.currentTaskId = undefined;
    }
  }
}

class FailingPromptBackend implements AgentBackend {
  readonly name = "opencode" as const;
  private started = false;

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async spawnSession(input: SpawnSessionInput): Promise<SpawnSessionResult> {
    if (!this.started) {
      throw new Error("backend is not started");
    }
    return { backendSessionId: `failing_${input.memberId}`, status: "idle" };
  }

  async promptSession(_input: PromptSessionInput): Promise<PromptSessionResult> {
    throw new Error("prompt failed");
  }

  async abortSession(_sessionId: string): Promise<void> {}
}

class WaitingConversationBackend implements AgentBackend {
  readonly name = "opencode" as const;
  private started = false;

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async spawnSession(input: SpawnSessionInput): Promise<SpawnSessionResult> {
    if (!this.started) {
      throw new Error("backend is not started");
    }
    return { backendSessionId: `waiting_${input.memberId}`, status: "idle" };
  }

  async promptSession(input: PromptSessionInput): Promise<PromptSessionResult> {
    if (!this.started) {
      throw new Error("backend is not started");
    }
    return input.prompt.includes("Conversation turn")
      ? { summary: `Prompted ${input.backendSessionId}`, conversationState: "waiting" }
      : { summary: `Prompted ${input.backendSessionId}` };
  }

  async abortSession(_sessionId: string): Promise<void> {}
}
