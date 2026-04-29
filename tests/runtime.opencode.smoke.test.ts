import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyState } from "../src/domain/types.js";
import { OpenCodeBackend } from "../src/runtime/openCodeBackend.js";
import { discussionThreads } from "../src/runtime/discussionState.js";
import { RuntimeService } from "../src/runtime/runtimeService.js";
import { RuntimeScheduler } from "../src/runtime/scheduler.js";
import { runSchedulerTickWithSplitStore } from "../src/runtime/schedulerExecutor.js";
import { RuntimeSchedulerRunner } from "../src/runtime/schedulerRunner.js";
import { TeamWorkService } from "../src/runtime/teamWork.js";
import { runtimeResults } from "../src/runtime/timeline.js";
import { teamConfirmMember, teamDraftMember, teamFinish, teamStart } from "../src/builder/teamBuilderService.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { TaskService } from "../src/services/taskService.js";
import { TeamService } from "../src/services/teamService.js";
import { registerTools } from "../src/tools/registerTools.js";

const runRealOpenCodeSmoke = process.env.TEAM_MCP_REAL_OPENCODE_SMOKE === "1";
const describeRealOpenCode = runRealOpenCodeSmoke ? describe : describe.skip;
const realSmokeModel = "hugusir/gpt-5.4";
const realPromptTimeoutMs = 240000;
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describeRealOpenCode("OpenCodeBackend real smoke", () => {
  it("starts two runtime-owned OpenCode sessions", async () => {
    const rootDir = await tempRoot();
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "real opencode smoke" }).team;
    const first = teams.addMember({
      teamId: team.id,
      name: "Smoke One",
      agentId: "smoke-one",
      model: realSmokeModel,
      polishedPrompt: "You are Smoke One. Keep responses brief."
    });
    const second = teams.addMember({
      teamId: team.id,
      name: "Smoke Two",
      agentId: "smoke-two",
      model: realSmokeModel,
      polishedPrompt: "You are Smoke Two. Keep responses brief."
    });
    const backend = new OpenCodeBackend({ startupTimeoutMs: 30000, promptTimeoutMs: realPromptTimeoutMs, noReply: true, hostname: "127.0.0.1", port: await reservePort(), config: realSmokeConfig() });

    try {
      const status = await new RuntimeService(state, backend).start({ teamId: team.id, workdir: rootDir, maxParallel: 2 });

      expect(status.status).toBe("running");
      expect(status.sessions).toHaveLength(2);
      expect(status.sessions.map((session) => session.memberId).sort()).toEqual([first.id, second.id].sort());
      expect(status.sessions.every((session) => session.backendSessionId && session.status === "idle")).toBe(true);
    } finally {
      await backend.stop();
    }
  }, 120000);

  it("prompts two runtime-owned OpenCode sessions and receives results", async () => {
    const rootDir = await tempRoot();
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "real opencode prompt smoke" }).team;
    teams.addMember({
      teamId: team.id,
      name: "Prompt One",
      agentId: "prompt-one",
      model: realSmokeModel,
      polishedPrompt: "You are Prompt One. Reply exactly as requested."
    });
    teams.addMember({
      teamId: team.id,
      name: "Prompt Two",
      agentId: "prompt-two",
      model: realSmokeModel,
      polishedPrompt: "You are Prompt Two. Reply exactly as requested."
    });
    const backend = new OpenCodeBackend({ startupTimeoutMs: 30000, promptTimeoutMs: realPromptTimeoutMs, noReply: false, hostname: "127.0.0.1", port: await reservePort(), config: realSmokeConfig() });

    try {
      const status = await new RuntimeService(state, backend).start({ teamId: team.id, workdir: rootDir, maxParallel: 2 });
      const sessions = status.sessions.sort((first, second) => first.memberId.localeCompare(second.memberId));

      const [firstResult, secondResult] = await Promise.all([
        backend.promptSession({
          backendSessionId: sessions[0]!.backendSessionId!,
          prompt: "Reply with exactly: team-mcpv2-smoke-one"
        }),
        backend.promptSession({
          backendSessionId: sessions[1]!.backendSessionId!,
          prompt: "Reply with exactly: team-mcpv2-smoke-two"
        })
      ]);

      expect(firstResult.summary).toContain("team-mcpv2-smoke-one");
      expect(secondResult.summary).toContain("team-mcpv2-smoke-two");
    } finally {
      await backend.stop();
    }
  }, 180000);

  it("runs one scheduler tick against real runtime-owned OpenCode sessions", async () => {
    const rootDir = await tempRoot();
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "real opencode scheduler smoke" }).team;
    const first = teams.addMember({
      teamId: team.id,
      name: "Scheduler One",
      agentId: "scheduler-one",
      model: realSmokeModel,
      polishedPrompt: "You are Scheduler One. Reply exactly as requested."
    });
    const second = teams.addMember({
      teamId: team.id,
      name: "Scheduler Two",
      agentId: "scheduler-two",
      model: realSmokeModel,
      polishedPrompt: "You are Scheduler Two. Reply exactly as requested."
    });
    const backend = new OpenCodeBackend({ startupTimeoutMs: 30000, promptTimeoutMs: realPromptTimeoutMs, noReply: false, hostname: "127.0.0.1", port: await reservePort(), config: realSmokeConfig() });

    try {
      await new RuntimeService(state, backend).start({ teamId: team.id, workdir: rootDir, maxParallel: 2 });
      const tasks = new TaskService(state);
      const firstTask = tasks.createTask({
        teamId: team.id,
        title: "Return first scheduler sentinel",
        description: "Reply with exactly: team-mcpv2-scheduler-one",
        preferredMemberId: first.id
      });
      const secondTask = tasks.createTask({
        teamId: team.id,
        title: "Return second scheduler sentinel",
        description: "Reply with exactly: team-mcpv2-scheduler-two",
        preferredMemberId: second.id
      });

      const result = await new RuntimeScheduler(state, backend).tick({ teamId: team.id });
      const sessions = Object.values(state.agentSessions).filter((session) => session.teamId === team.id);
      const summaries = sessions.map((session) => session.lastResultSummary ?? "").join("\n");

      expect(result.assignments).toHaveLength(2);
      expect(result.assignments.map((assignment) => assignment.taskId).sort()).toEqual([firstTask.id, secondTask.id].sort());
      expect(result.assignments).toEqual(expect.arrayContaining([
        expect.objectContaining({ taskId: firstTask.id, memberId: first.id }),
        expect.objectContaining({ taskId: secondTask.id, memberId: second.id })
      ]));
      expect(state.tasks[firstTask.id]).toMatchObject({ status: "claimed", assignedMemberId: first.id });
      expect(state.tasks[secondTask.id]).toMatchObject({ status: "claimed", assignedMemberId: second.id });
      expect(sessions).toHaveLength(2);
      expect(sessions.every((session) => session.status === "working" && session.currentTaskId && session.lastResultSummary)).toBe(true);
      expect(state.schedulerStates[team.id]?.lastDecision).toBe("Assigned 2 task(s)");
      expect(state.events.map((event) => event.type)).toEqual(expect.arrayContaining(["task.claimed", "scheduler.assignment", "scheduler.tick"]));
      expect(summaries).toContain("team-mcpv2-scheduler-one");
      expect(summaries).toContain("team-mcpv2-scheduler-two");
    } finally {
      await backend.stop();
    }
  }, 180000);

  it("lets a runtime-owned OpenCode session call agent-facing MCP tools", async () => {
    const rootDir = await tempRoot();
    const storeHome = join(rootDir, ".team-mcp");
    await mkdir(storeHome, { recursive: true });

    const store = new JsonStore({ rootDir });
    const { team, member, task } = await store.transaction((state) => {
      const teams = new TeamService(state);
      const createdTeam = teams.createTeam({ name: "real opencode mcp tool smoke" }).team;
      const createdMember = teams.addMember({
        teamId: createdTeam.id,
        name: "Tool Caller",
        agentId: "tool-caller",
        model: realSmokeModel,
        polishedPrompt: "You are Tool Caller. Use the team_mcpv2 tools exactly as requested."
      });
      const createdTask = new TaskService(state).createTask({
        teamId: createdTeam.id,
        title: "Exercise runtime MCP tools",
        description: "Wait for follow-up MCP tool instructions. Reply with exactly: team-mcpv2-agent-tool-loop-assigned",
        preferredMemberId: createdMember.id
      });
      return { team: createdTeam, member: createdMember, task: createdTask };
    });
    const backend = new OpenCodeBackend({
      startupTimeoutMs: 30000,
      promptTimeoutMs: realPromptTimeoutMs,
      noReply: false,
      hostname: "127.0.0.1",
      port: await reservePort(),
      config: {
        ...realSmokeConfig(),
        mcp: {
          team_mcpv2: {
            type: "local",
            command: ["node", join(process.cwd(), "dist", "index.js")],
            enabled: true,
            timeout: 20000,
            environment: {
              TEAM_MCP_HOME: storeHome
            }
          }
        },
        tools: {
          "team_mcpv2_*": true
        },
        permission: {
          "team_mcpv2_*": "allow"
        }
      }
    });

    try {
      await store.transaction((state) => new RuntimeService(state, backend).start({ teamId: team.id, workdir: rootDir, maxParallel: 1 }));
      await runSchedulerTickWithSplitStore(store, backend, { teamId: team.id });
      const assignedState = await store.read();
      const session = Object.values(assignedState.agentSessions).find((candidate) => candidate.teamId === team.id && candidate.memberId === member.id);

      const promptResult = await backend.promptSession({
        backendSessionId: session!.backendSessionId!,
        prompt: [
          "Use only the configured team_mcpv2 MCP tools for the state changes below.",
          `1. Call team_self_status with teamId=${team.id} and memberId=${member.id}.`,
          `2. Call send_message with teamId=${team.id}, fromMemberId=${member.id}, taskId=${task.id}, type=result, subject=tool loop smoke, body=team-mcpv2-agent-tool-loop-message.`,
          `3. Call complete_task with teamId=${team.id}, taskId=${task.id}, memberId=${member.id}, completionSummary=team-mcpv2-agent-tool-loop-complete, resultArtifacts=["mcp-tool-loop"].`,
          "Reply with exactly: team-mcpv2-agent-tool-loop-done"
        ].join("\n")
      });
      const finalState = await store.read();
      const message = Object.values(finalState.messages).find((candidate) => candidate.body === "team-mcpv2-agent-tool-loop-message");
      const completedTask = finalState.tasks[task.id];

      expect(promptResult.summary).toContain("team-mcpv2-agent-tool-loop-done");
      expect(message).toMatchObject({
        teamId: team.id,
        fromMemberId: member.id,
        taskId: task.id,
        type: "result",
        subject: "tool loop smoke"
      });
      expect(completedTask).toMatchObject({
        status: "completed",
        assignedMemberId: member.id
      });
      expect(completedTask.completionSummary).toBeTruthy();
      expect(finalState.events.map((event) => event.type)).toEqual(expect.arrayContaining(["message.sent", "task.completed"]));
    } finally {
      await backend.stop();
    }
  }, 360000);

  it("uses tool-driven completion to unblock dependent scheduler work", async () => {
    const rootDir = await tempRoot();
    const storeHome = join(rootDir, ".team-mcp");
    await mkdir(storeHome, { recursive: true });

    const store = new JsonStore({ rootDir });
    const { team, member, dependency, dependent } = await store.transaction((state) => {
      const teams = new TeamService(state);
      const createdTeam = teams.createTeam({ name: "real opencode completion contract smoke" }).team;
      const createdMember = teams.addMember({
        teamId: createdTeam.id,
        name: "Completion Caller",
        agentId: "completion-caller",
        model: realSmokeModel,
        polishedPrompt: "You are Completion Caller. Use team_mcpv2 tools exactly as requested."
      });
      const tasks = new TaskService(state);
      const createdDependency = tasks.createTask({
        teamId: createdTeam.id,
        title: "Complete dependency through MCP",
        description: "Call complete_task through the configured team_mcpv2 MCP server.",
        preferredMemberId: createdMember.id
      });
      const createdDependent = tasks.createTask({
        teamId: createdTeam.id,
        title: "Dependent scheduler work",
        description: "Reply with exactly: team-mcpv2-dependent-after-tool-completion",
        dependencyTaskIds: [createdDependency.id],
        preferredMemberId: createdMember.id
      });
      return { team: createdTeam, member: createdMember, dependency: createdDependency, dependent: createdDependent };
    });
    const backend = new OpenCodeBackend({
      startupTimeoutMs: 30000,
      promptTimeoutMs: realPromptTimeoutMs,
      noReply: false,
      hostname: "127.0.0.1",
      port: await reservePort(),
      config: {
        ...realSmokeConfig(),
        mcp: {
          team_mcpv2: {
            type: "local",
            command: ["node", join(process.cwd(), "dist", "index.js")],
            enabled: true,
            timeout: 20000,
            environment: {
              TEAM_MCP_HOME: storeHome
            }
          }
        },
        tools: {
          "team_mcpv2_*": true
        },
        permission: {
          "team_mcpv2_*": "allow"
        }
      }
    });

    try {
      await store.transaction((state) => new RuntimeService(state, backend).start({ teamId: team.id, workdir: rootDir, maxParallel: 1 }));
      const firstTick = await runSchedulerTickWithSplitStore(store, backend, { teamId: team.id });
      const assignedState = await store.read();
      const session = Object.values(assignedState.agentSessions).find((candidate) => candidate.teamId === team.id && candidate.memberId === member.id);

      expect(firstTick.assignments).toEqual([expect.objectContaining({ taskId: dependency.id, memberId: member.id })]);
      expect(["claimed", "completed"]).toContain(assignedState.tasks[dependency.id]?.status);
      expect(assignedState.tasks[dependency.id]).toMatchObject({ assignedMemberId: member.id });
      expect(assignedState.tasks[dependent.id]).toMatchObject({ status: "pending" });

      const promptResult = await backend.promptSession({
        backendSessionId: session!.backendSessionId!,
        prompt: [
          "Use only the configured team_mcpv2 MCP tools for the state change below.",
          `Call complete_task with teamId=${team.id}, taskId=${dependency.id}, memberId=${member.id}, completionSummary=team-mcpv2-tool-completion-contract, resultArtifacts=["completion-contract"].`,
          "After the tool call succeeds, reply with exactly: team-mcpv2-tool-completion-contract-done"
        ].join("\n")
      });
      const secondTick = await runSchedulerTickWithSplitStore(store, backend, { teamId: team.id });
      const finalState = await store.read();
      const finalSession = Object.values(finalState.agentSessions).find((candidate) => candidate.teamId === team.id && candidate.memberId === member.id);

      expect(promptResult.summary).toContain("team-mcpv2-tool-completion-contract-done");
      expect(finalState.tasks[dependency.id]).toMatchObject({
        status: "completed",
        assignedMemberId: member.id
      });
      expect(finalState.tasks[dependency.id]?.completionSummary).toBeTruthy();
      expect(secondTick.assignments).toEqual([expect.objectContaining({ taskId: dependent.id, memberId: member.id })]);
      expect(finalState.tasks[dependent.id]).toMatchObject({ assignedMemberId: member.id });
      expect(["claimed", "completed"]).toContain(finalState.tasks[dependent.id]?.status);
      expect(finalSession?.currentTaskId).toBe(dependent.id);
      expect(["working", "idle"]).toContain(finalSession?.status);
      expect(finalState.events.map((event) => event.type)).toEqual(expect.arrayContaining(["task.completed", "scheduler.completion", "scheduler.assignment"]));
    } finally {
      await backend.stop();
    }
  }, 300000);

  it("lets two runtime-owned OpenCode sessions coordinate through mailbox tools", async () => {
    const rootDir = await tempRoot();
    const storeHome = join(rootDir, ".team-mcp");
    await mkdir(storeHome, { recursive: true });

    const store = new JsonStore({ rootDir });
    const { team, sender, receiver, task } = await store.transaction((state) => {
      const teams = new TeamService(state);
      const createdTeam = teams.createTeam({ name: "real opencode cross-session mailbox smoke" }).team;
      const createdSender = teams.addMember({
        teamId: createdTeam.id,
        name: "Mailbox Sender",
        agentId: "mailbox-sender",
        model: realSmokeModel,
        polishedPrompt: "You are Mailbox Sender. Use team_mcpv2 mailbox tools exactly as requested."
      });
      const createdReceiver = teams.addMember({
        teamId: createdTeam.id,
        name: "Mailbox Receiver",
        agentId: "mailbox-receiver",
        model: realSmokeModel,
        polishedPrompt: "You are Mailbox Receiver. Use team_mcpv2 mailbox tools exactly as requested."
      });
      const createdTask = new TaskService(state).createTask({
        teamId: createdTeam.id,
        title: "Coordinate through mailbox",
        description: "Wait for follow-up mailbox instructions. Reply with exactly: team-mcpv2-cross-session-assigned",
        preferredMemberId: createdSender.id
      });
      return { team: createdTeam, sender: createdSender, receiver: createdReceiver, task: createdTask };
    });
    const backend = new OpenCodeBackend({
      startupTimeoutMs: 30000,
      promptTimeoutMs: realPromptTimeoutMs,
      noReply: false,
      hostname: "127.0.0.1",
      port: await reservePort(),
      config: {
        ...realSmokeConfig(),
        mcp: {
          team_mcpv2: {
            type: "local",
            command: ["node", join(process.cwd(), "dist", "index.js")],
            enabled: true,
            timeout: 20000,
            environment: {
              TEAM_MCP_HOME: storeHome
            }
          }
        },
        tools: {
          "team_mcpv2_*": true
        },
        permission: {
          "team_mcpv2_*": "allow"
        }
      }
    });

    try {
      await store.transaction((state) => new RuntimeService(state, backend).start({ teamId: team.id, workdir: rootDir, maxParallel: 2 }));
      const firstTick = await runSchedulerTickWithSplitStore(store, backend, { teamId: team.id });
      const assignedState = await store.read();
      const senderSession = Object.values(assignedState.agentSessions).find((candidate) => candidate.teamId === team.id && candidate.memberId === sender.id);
      const receiverSession = Object.values(assignedState.agentSessions).find((candidate) => candidate.teamId === team.id && candidate.memberId === receiver.id);

      expect(firstTick.assignments).toEqual([expect.objectContaining({ taskId: task.id, memberId: sender.id })]);
      expect(senderSession).toMatchObject({ status: "working", currentTaskId: task.id });
      expect(receiverSession).toMatchObject({ status: "idle" });

      const senderQuestion = await backend.promptSession({
        backendSessionId: senderSession!.backendSessionId!,
        prompt: [
          "Use only the configured team_mcpv2 MCP tools for the mailbox state change below.",
          `Call send_message with teamId=${team.id}, fromMemberId=${sender.id}, toMemberId=${receiver.id}, taskId=${task.id}, type=question, subject=mailbox smoke question, body=team-mcpv2-cross-session-question.`,
          "After the tool call succeeds, reply with exactly: team-mcpv2-cross-session-question-sent"
        ].join("\n")
      });
      const afterQuestionState = await store.read();
      const question = Object.values(afterQuestionState.messages).find((candidate) => (
        candidate.teamId === team.id
        && candidate.fromMemberId === sender.id
        && candidate.toMemberId === receiver.id
        && candidate.taskId === task.id
        && candidate.type === "question"
      ));

      expect(senderQuestion.summary).toContain("team-mcpv2-cross-session-question-sent");
      expect(question).toMatchObject({
        teamId: team.id,
        fromMemberId: sender.id,
        toMemberId: receiver.id,
        taskId: task.id,
        type: "question",
        subject: "mailbox smoke question"
      });
      expect(question?.body).toBeTruthy();

      const receiverReply = await backend.promptSession({
        backendSessionId: receiverSession!.backendSessionId!,
        prompt: [
          "Use only the configured team_mcpv2 MCP tools for the mailbox workflow below.",
          `1. Call inbox with teamId=${team.id}, memberId=${receiver.id}, taskId=${task.id}. Confirm it contains the mailbox question from ${sender.id}.`,
          `2. Call send_message with teamId=${team.id}, fromMemberId=${receiver.id}, toMemberId=${sender.id}, taskId=${task.id}, type=result, subject=mailbox smoke reply, body=team-mcpv2-cross-session-reply, replyToMessageId=${question!.id}.`,
          `3. Call ack_message with teamId=${team.id}, messageId=${question!.id}, memberId=${receiver.id}.`,
          "After all tool calls succeed, reply with exactly: team-mcpv2-cross-session-reply-sent"
        ].join("\n")
      });
      const afterReplyState = await store.read();
      const reply = Object.values(afterReplyState.messages).find((candidate) => candidate.body === "team-mcpv2-cross-session-reply");

      expect(receiverReply.summary).toContain("team-mcpv2-cross-session-reply-sent");
      expect(afterReplyState.messages[question!.id]?.acknowledgedAt).toBeTruthy();
      expect(reply).toMatchObject({
        teamId: team.id,
        fromMemberId: receiver.id,
        toMemberId: sender.id,
        taskId: task.id,
        type: "result",
        subject: "mailbox smoke reply",
        replyToMessageId: question!.id
      });

      const senderCompletion = await backend.promptSession({
        backendSessionId: senderSession!.backendSessionId!,
        prompt: [
          "Use only the configured team_mcpv2 MCP tools for the final task state below.",
          `1. Call inbox with teamId=${team.id}, memberId=${sender.id}, taskId=${task.id}. Confirm it contains body team-mcpv2-cross-session-reply.`,
          `2. Call complete_task with teamId=${team.id}, taskId=${task.id}, memberId=${sender.id}, completionSummary=team-mcpv2-cross-session-complete, resultArtifacts=["cross-session-mailbox"].`,
          "After the tool calls succeed, reply with exactly: team-mcpv2-cross-session-complete-done"
        ].join("\n")
      });
      const secondTick = await runSchedulerTickWithSplitStore(store, backend, { teamId: team.id });
      const finalState = await store.read();
      const finalSenderSession = Object.values(finalState.agentSessions).find((candidate) => candidate.teamId === team.id && candidate.memberId === sender.id);
      const completedTask = finalState.tasks[task.id];
      const timelineMessages = Object.values(finalState.messages).filter((candidate) => candidate.teamId === team.id).map((candidate) => candidate.body);
      const resultMessages = Object.values(finalState.messages).filter((candidate) => candidate.teamId === team.id && candidate.type === "result").map((candidate) => candidate.body);

      expect(senderCompletion.summary).toContain("team-mcpv2-cross-session-complete-done");
      expect(secondTick.assignments).toHaveLength(0);
      expect(completedTask).toMatchObject({
        status: "completed",
        assignedMemberId: sender.id
      });
      expect(completedTask.completionSummary).toBeTruthy();
      expect(finalSenderSession).toMatchObject({ status: "idle" });
      expect(finalSenderSession?.currentTaskId).toBeUndefined();
      expect(finalState.events.map((event) => event.type)).toEqual(expect.arrayContaining([
        "message.sent",
        "message.acknowledged",
        "task.completed",
        "scheduler.completion"
      ]));
      expect(timelineMessages.some((body) => body.includes("team-mcpv2-cross-session-question"))).toBe(true);
      expect(timelineMessages).toContain("team-mcpv2-cross-session-reply");
      expect(resultMessages).toContain("team-mcpv2-cross-session-reply");
    } finally {
      await backend.stop();
    }
  }, 360000);

  it("lets real runtime-owned members discuss through team_work without host mailbox relay", async () => {
    const rootDir = await tempRoot();
    const storeHome = join(rootDir, ".team-mcp");
    await mkdir(storeHome, { recursive: true });
    const store = new JsonStore({ rootDir });
    const backend = new OpenCodeBackend({
      startupTimeoutMs: 30000,
      promptTimeoutMs: realPromptTimeoutMs,
      noReply: false,
      hostname: "127.0.0.1",
      port: await reservePort(),
      config: {
        ...realSmokeConfig(),
        mcp: {
          team_mcpv2: {
            type: "local",
            command: ["node", join(process.cwd(), "dist", "index.js")],
            enabled: true,
            timeout: 20000,
            environment: {
              TEAM_MCP_HOME: storeHome
            }
          }
        },
        tools: {
          "team_mcpv2_*": true
        },
        permission: {
          "team_mcpv2_*": "allow"
        }
      }
    });
    const teamId = await store.transaction((state) => {
      const started = teamStart(state, { teamName: "real discussion team" }) as { team: { id: string } };
      teamDraftMember(state, {
        teamId: started.team.id,
        name: "Discussion Author",
        model: realSmokeModel,
        rawResponsibility: "When prompted for a conversation turn, call send_message with type=opinion and body containing team-mcpv2-discussion-opinion-author, then call ack_message.",
        polishedPrompt: "When prompted for a conversation turn, call send_message with type=opinion and body containing team-mcpv2-discussion-opinion-author, then call ack_message."
      });
      teamConfirmMember(state, { teamId: started.team.id });
      teamDraftMember(state, {
        teamId: started.team.id,
        name: "Discussion Reviewer",
        model: realSmokeModel,
        rawResponsibility: "When prompted for a conversation turn, call send_message with type=opinion and body containing team-mcpv2-discussion-opinion-reviewer, then call ack_message.",
        polishedPrompt: "When prompted for a conversation turn, call send_message with type=opinion and body containing team-mcpv2-discussion-opinion-reviewer, then call ack_message."
      });
      teamConfirmMember(state, { teamId: started.team.id });
      teamFinish(state, { teamId: started.team.id });
      return started.team.id;
    });

    try {
      const worked = await new TeamWorkService(
        store,
        () => backend,
        (runnerBackend) => new RuntimeSchedulerRunner((input) => runSchedulerTickWithSplitStore(store, runnerBackend, input))
      ).work({
        teamId,
        work: {
          discussion: {
            subject: "real discussion smoke",
            body: "Each member must reply with one send_message opinion containing its assigned team-mcpv2-discussion-opinion marker, then ack_message.",
            maxTurns: 2,
            autoRun: true
          }
        }
      });
      const finalState = await store.read();
      const opinions = Object.values(finalState.messages)
        .filter((message) => message.teamId === teamId && message.type === "opinion")
        .map((message) => message.body);

      expect(worked.mode).toBe("task_flow");
      expect(opinions.some((body) => body.includes("team-mcpv2-discussion-opinion-author"))).toBe(true);
      expect(opinions.some((body) => body.includes("team-mcpv2-discussion-opinion-reviewer"))).toBe(true);
      expect(Object.values(finalState.events).map((event) => event.type)).toContain("scheduler.conversation");
    } finally {
      await backend.stop();
    }
  }, 420000);

  it("invites a relevant real runtime-owned member into an active discussion thread", async () => {
    const rootDir = await tempRoot();
    const storeHome = join(rootDir, ".team-mcp");
    await mkdir(storeHome, { recursive: true });
    const store = new JsonStore({ rootDir });
    const backend = new OpenCodeBackend({
      startupTimeoutMs: 30000,
      promptTimeoutMs: realPromptTimeoutMs,
      noReply: false,
      hostname: "127.0.0.1",
      port: await reservePort(),
      config: {
        ...realSmokeConfig(),
        mcp: {
          team_mcpv2: {
            type: "local",
            command: ["node", join(process.cwd(), "dist", "index.js")],
            enabled: true,
            timeout: 20000,
            environment: {
              TEAM_MCP_HOME: storeHome
            }
          }
        },
        tools: {
          "team_mcpv2_*": true
        },
        permission: {
          "team_mcpv2_*": "allow"
        }
      }
    });
    const { teamId, authorId, reviewerId, plannerId } = await store.transaction(async (state) => {
      const started = teamStart(state, { teamName: "real invited discussion team" }) as { team: { id: string } };
      teamDraftMember(state, {
        teamId: started.team.id,
        name: "Discussion Author",
        model: realSmokeModel,
        rawResponsibility: "When prompted for a conversation turn, call send_message with type=opinion and body containing team-mcpv2-discussion-opinion-author, then call ack_message.",
        polishedPrompt: "When prompted for a conversation turn, call send_message with type=opinion and body containing team-mcpv2-discussion-opinion-author, then call ack_message."
      });
      const author = teamConfirmMember(state, { teamId: started.team.id }).member;
      teamDraftMember(state, {
        teamId: started.team.id,
        name: "Discussion Planner",
        model: realSmokeModel,
        rawResponsibility: "When prompted for a conversation turn, call send_message with type=opinion and body containing team-mcpv2-discussion-opinion-planner. Only call ack_message if inbox shows this message was delivered to you.",
        polishedPrompt: "When prompted for a conversation turn, call send_message with type=opinion and body containing team-mcpv2-discussion-opinion-planner. Only call ack_message if inbox shows this message was delivered to you.",
        callWhen: ["field list", "thread summary"]
      });
      const planner = teamConfirmMember(state, { teamId: started.team.id }).member;
      teamDraftMember(state, {
        teamId: started.team.id,
        name: "Discussion Reviewer",
        model: realSmokeModel,
        rawResponsibility: "If prompted for a conversation turn, call send_message with type=opinion and body containing team-mcpv2-discussion-opinion-reviewer, then call ack_message.",
        polishedPrompt: "If prompted for a conversation turn, call send_message with type=opinion and body containing team-mcpv2-discussion-opinion-reviewer, then call ack_message."
      });
      const reviewer = teamConfirmMember(state, { teamId: started.team.id }).member;
      teamFinish(state, { teamId: started.team.id });
      await new RuntimeService(state, backend).start({ teamId: started.team.id, workdir: rootDir, maxParallel: 2 });
      return {
        teamId: started.team.id,
        authorId: author.id,
        reviewerId: reviewer.id,
        plannerId: planner.id
      };
    });

    try {
      const teamWork = new TeamWorkService(
        store,
        () => backend,
        (runnerBackend) => new RuntimeSchedulerRunner((input) => runSchedulerTickWithSplitStore(store, runnerBackend, input))
      );

      const firstPass = await teamWork.work({
        teamId,
        work: {
          includeDetails: true,
          discussion: {
            subject: "field list discussion",
            body: "Review the thread summary field list and keep the host-facing shape compact.",
            participantMemberIds: [authorId, reviewerId],
            autoRun: true,
            maxTurns: 1
          }
        }
      });
      const midState = await store.read();
      const midThread = discussionThreads(midState, teamId)[0]!;
      const midSessionMemberIds = Object.values(midState.agentSessions)
        .filter((session) => session.teamId === teamId)
        .map((session) => session.memberId)
        .sort();

      expect(firstPass.mode).toBe("task_flow");
      expect(firstPass.schedulerRun?.totalAssignments).toBe(1);
      expect(midSessionMemberIds).toEqual([authorId, plannerId].sort());
      expect(midSessionMemberIds).not.toContain(reviewerId);
      expect(midThread).toMatchObject({
        lifecycleState: "collecting",
        owedMemberIds: [reviewerId],
        owedMemberNames: ["Discussion Reviewer"],
        invitedMemberIds: [plannerId],
        invitedMemberNames: ["Discussion Planner"],
        participationSummary: "Discussion Author has responded; Discussion Reviewer still owes a reply; Discussion Planner is invited to weigh in.",
        turnSummary: "Waiting on Discussion Reviewer to reply while inviting Discussion Planner to weigh in."
      });
      expect(midThread.turnObligations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          memberId: reviewerId,
          kind: "participant_reply",
          required: true
        }),
        expect.objectContaining({
          memberId: plannerId,
          memberName: "Discussion Planner",
          kind: "invited_opinion",
          required: false,
          source: "callWhen_match"
        })
      ]));

      const secondPass = await teamWork.work({
        teamId,
        work: {
          autoRun: true,
          maxTicks: 2,
          includeDetails: true
        }
      });
      const finalState = await store.read();
      const finalThread = discussionThreads(finalState, teamId)[0]!;
      const opinions = Object.values(finalState.messages)
        .filter((message) => message.teamId === teamId && message.type === "opinion");

      expect(secondPass.mode).toBe("task_flow");
      expect(secondPass.schedulerRun?.totalAssignments).toBe(1);
      expect(opinions.some((message) => message.fromMemberId === authorId)).toBe(true);
      expect(opinions.some((message) => message.fromMemberId === plannerId)).toBe(true);
      expect(opinions.some((message) => message.fromMemberId === reviewerId)).toBe(false);
      expect(finalThread).toMatchObject({
        lifecycleState: "collecting",
        owedMemberIds: [reviewerId],
        owedMemberNames: ["Discussion Reviewer"],
        invitedMemberIds: [],
        invitedMemberNames: []
      });
      expect(finalThread.currentRoundTurns).toEqual(expect.arrayContaining([
        expect.objectContaining({
          fromMemberId: authorId,
          fromMemberName: "Discussion Author"
        }),
        expect.objectContaining({
          fromMemberId: plannerId,
          fromMemberName: "Discussion Planner"
        })
      ]));
      expect(finalState.events.map((event) => event.type)).toEqual(expect.arrayContaining([
        "scheduler.conversation",
        "scheduler.tick",
        "message.sent"
      ]));
    } finally {
      await backend.stop();
    }
  }, 420000);

  it("covers invited turn, reviewer reply, and host decision follow-through in one real discussion thread", async () => {
    const rootDir = await tempRoot();
    const storeHome = join(rootDir, ".team-mcp");
    await mkdir(storeHome, { recursive: true });
    const store = new JsonStore({ rootDir });
    const backend = new OpenCodeBackend({
      startupTimeoutMs: 30000,
      promptTimeoutMs: realPromptTimeoutMs,
      noReply: false,
      hostname: "127.0.0.1",
      port: await reservePort(),
      config: {
        ...realSmokeConfig(),
        mcp: {
          team_mcpv2: {
            type: "local",
            command: ["node", join(process.cwd(), "dist", "index.js")],
            enabled: true,
            timeout: 20000,
            environment: {
              TEAM_MCP_HOME: storeHome
            }
          }
        },
        tools: {
          "team_mcpv2_*": true
        },
        permission: {
          "team_mcpv2_*": "allow"
        }
      }
    });
    const { teamId, authorId, reviewerId, plannerId } = await store.transaction(async (state) => {
      const started = teamStart(state, { teamName: "real discussion turn chain team" }) as { team: { id: string } };
      teamDraftMember(state, {
        teamId: started.team.id,
        name: "Discussion Author",
        model: realSmokeModel,
        rawResponsibility: [
          "When prompted for a conversation turn:",
          "- if the message body starts with 'Host decision:', call send_message with type=opinion and body containing team-mcpv2-discussion-followup-author",
          "- otherwise call send_message with type=opinion and body containing team-mcpv2-discussion-opinion-author",
          "- call ack_message only if this message was delivered to you"
        ].join(" "),
        polishedPrompt: [
          "When prompted for a conversation turn:",
          "if the message body starts with 'Host decision:', send opinion marker team-mcpv2-discussion-followup-author;",
          "otherwise send opinion marker team-mcpv2-discussion-opinion-author;",
          "ack only when the message was delivered to you."
        ].join(" ")
      });
      const author = teamConfirmMember(state, { teamId: started.team.id }).member;
      teamDraftMember(state, {
        teamId: started.team.id,
        name: "Discussion Planner",
        model: realSmokeModel,
        rawResponsibility: "When prompted for a conversation turn, call send_message with type=opinion and body containing team-mcpv2-discussion-opinion-planner. Only call ack_message if inbox shows this message was delivered to you.",
        polishedPrompt: "When prompted for a conversation turn, call send_message with type=opinion and body containing team-mcpv2-discussion-opinion-planner. Only call ack_message if inbox shows this message was delivered to you.",
        callWhen: ["field list", "thread summary"]
      });
      const planner = teamConfirmMember(state, { teamId: started.team.id }).member;
      teamDraftMember(state, {
        teamId: started.team.id,
        name: "Discussion Reviewer",
        model: realSmokeModel,
        rawResponsibility: [
          "When prompted for a conversation turn:",
          "- if the message body starts with 'Host decision:', call send_message with type=opinion and body containing team-mcpv2-discussion-followup-reviewer, then call ack_message if this message was delivered to you",
          "- otherwise call send_message with type=opinion and body containing team-mcpv2-discussion-opinion-reviewer",
          "- after that first-round opinion, call send_message again with type=escalation, subject='Need host review', and body containing team-mcpv2-discussion-escalation-reviewer",
          "- finally call ack_message if this message was delivered to you"
        ].join(" "),
        polishedPrompt: [
          "When prompted for a conversation turn:",
          "if the message body starts with 'Host decision:', send opinion marker team-mcpv2-discussion-followup-reviewer and ack if delivered;",
          "otherwise send opinion marker team-mcpv2-discussion-opinion-reviewer, then send escalation marker team-mcpv2-discussion-escalation-reviewer with subject 'Need host review', then ack if delivered."
        ].join(" ")
      });
      const reviewer = teamConfirmMember(state, { teamId: started.team.id }).member;
      teamFinish(state, { teamId: started.team.id });
      await new RuntimeService(state, backend).start({ teamId: started.team.id, workdir: rootDir, maxParallel: 1 });
      return {
        teamId: started.team.id,
        authorId: author.id,
        reviewerId: reviewer.id,
        plannerId: planner.id
      };
    });

    try {
      const teamWork = new TeamWorkService(
        store,
        () => backend,
        (runnerBackend) => new RuntimeSchedulerRunner((input) => runSchedulerTickWithSplitStore(store, runnerBackend, input))
      );

      const invitedPass = await teamWork.work({
        teamId,
        work: {
          includeDetails: true,
          discussion: {
            subject: "field list discussion",
            body: "Review the thread summary field list and keep the host-facing shape compact.",
            participantMemberIds: [authorId, reviewerId],
            autoRun: true,
            maxTurns: 1
          }
        }
      });
      const invitedState = await store.read();
      const invitedThread = discussionThreads(invitedState, teamId)[0]!;

      expect(invitedPass.mode).toBe("task_flow");
      expect(invitedPass.schedulerRun?.totalAssignments).toBe(1);
      expect(invitedThread).toMatchObject({
        lifecycleState: "collecting",
        turnTakingState: "waiting_required",
        nextResponsibleMemberIds: [reviewerId],
        nextResponsibleMemberNames: ["Discussion Reviewer"],
        respondedMemberIds: [authorId],
        owedMemberIds: [reviewerId],
        invitedMemberIds: [plannerId],
        invitedMemberNames: ["Discussion Planner"],
        turnObligations: expect.arrayContaining([
          expect.objectContaining({
            memberId: reviewerId,
            kind: "participant_reply",
            trigger: "participant_obligation",
            priorityScore: 300,
            required: true
          }),
          expect.objectContaining({
            memberId: plannerId,
            kind: "invited_opinion",
            trigger: "callWhen_match",
            priorityScore: 100,
            required: false
          })
        ])
      });

      await store.transaction(async (state) => {
        await new RuntimeService(state, backend).start({ teamId, workdir: rootDir, maxParallel: 3 });
      });

      const contestedPass = await teamWork.work({
        teamId,
        work: {
          autoRun: true,
          maxTicks: 3,
          includeDetails: true
        }
      });
      const contestedState = await store.read();
      const contestedThread = discussionThreads(contestedState, teamId)[0]!;
      const contestedOpinions = Object.values(contestedState.messages)
        .filter((message) => message.teamId === teamId && message.type === "opinion");

      expect(contestedPass.mode).toBe("task_flow");
      expect(contestedPass.schedulerRun?.totalAssignments).toBeGreaterThanOrEqual(1);
      expect(contestedOpinions.some((message) => message.fromMemberId === plannerId)).toBe(true);
      expect(contestedOpinions.some((message) => message.fromMemberId === reviewerId)).toBe(true);
      expect(contestedThread.currentRoundTurns.some((turn) => turn.fromMemberId === plannerId)).toBe(true);
      expect(contestedThread.currentRoundTurns.some((turn) => turn.fromMemberId === reviewerId)).toBe(true);
      expect(contestedThread.owedMemberIds).toEqual([]);
      expect(["settled", "ready_for_host"]).toContain(contestedThread.state);

      const hostDecisionPass = await teamWork.work({
        teamId,
        work: {
          includeDetails: true,
          discussion: {
            subject: "field list discussion",
            replyToMessageId: contestedThread.latestMessage!.id,
            participantMemberIds: [authorId, reviewerId],
            autoRun: false,
            hostDecision: {
              decision: "Keep the host-facing thread state compact and let the next round acknowledge this direction.",
              note: "Author and reviewer should each confirm the direction in one short opinion."
            }
          }
        }
      });
      const hostDecisionState = await store.read();
      const hostDecisionThread = discussionThreads(hostDecisionState, teamId)[0]!;
      const hostDecisionMessageId = hostDecisionThread.latestMessage!.id;

      expect(hostDecisionPass.mode).toBe("task_flow");
      expect(hostDecisionPass.schedulerRun).toBeUndefined();
      expect(hostDecisionThread).toMatchObject({
        lifecycleState: "open",
        turnTakingState: "waiting_required",
        nextResponsibleMemberIds: expect.arrayContaining([authorId, reviewerId]),
        nextResponsibleMemberNames: expect.arrayContaining(["Discussion Author", "Discussion Reviewer"]),
        needsHostDecision: false,
        pendingMemberIds: expect.arrayContaining([authorId, reviewerId]),
        turnObligations: expect.arrayContaining([
          expect.objectContaining({
            memberId: authorId,
            trigger: "host_decision_follow_through",
            priorityScore: 400
          }),
          expect.objectContaining({
            memberId: reviewerId,
            trigger: "host_decision_follow_through",
            priorityScore: 400
          })
        ]),
        latestMessage: {
          type: "notification",
          body: expect.stringContaining("Host decision:")
        }
      });

      const followThroughPass = await teamWork.work({
        teamId,
        work: {
          autoRun: true,
          maxTicks: 3,
          includeDetails: true
        }
      });
      const finalState = await store.read();
      const finalThread = discussionThreads(finalState, teamId)[0]!;
      const finalOpinions = Object.values(finalState.messages)
        .filter((message) => message.teamId === teamId && message.type === "opinion");
      const hostDecisionReplies = finalOpinions.filter((message) => message.replyToMessageId === hostDecisionMessageId);

      expect(followThroughPass.mode).toBe("task_flow");
      expect(followThroughPass.schedulerRun?.totalAssignments).toBeGreaterThanOrEqual(1);
      expect(hostDecisionReplies.some((message) => message.fromMemberId === authorId)).toBe(true);
      expect(hostDecisionReplies.some((message) => message.fromMemberId === reviewerId)).toBe(true);
      expect(finalThread).toMatchObject({
        state: "settled",
        lifecycleState: "settled",
        resolutionState: "resolved",
        turnTakingState: "settled",
        nextResponsibleMemberIds: [],
        nextResponsibleMemberNames: [],
        needsHostDecision: false,
        pendingMemberIds: [],
        synthesis: {
          resolutionState: "resolved",
          summary: expect.stringContaining("Host decision:")
        },
        proposedNextAction: {
          kind: "summarize_conclusion",
          summary: expect.stringContaining("Host decision:")
        },
        conclusionSummary: expect.stringContaining("Host decision:")
      });
      expect(finalThread.currentRoundTurns).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "notification",
          bodyPreview: expect.stringContaining("Host decision:")
        }),
        expect.objectContaining({
          fromMemberId: authorId,
          fromMemberName: "Discussion Author"
        }),
        expect.objectContaining({
          fromMemberId: reviewerId,
          fromMemberName: "Discussion Reviewer"
        })
      ]));
      expect(finalState.events.map((event) => event.type)).toEqual(expect.arrayContaining([
        "scheduler.conversation",
        "scheduler.tick",
        "message.sent"
      ]));
    } finally {
      await backend.stop();
    }
  }, 420000);

  it("coordinates a real handoff across distinct runtime-owned OpenCode sessions", async () => {
    const rootDir = await tempRoot();
    const storeHome = join(rootDir, ".team-mcp");
    await mkdir(storeHome, { recursive: true });

    const store = new JsonStore({ rootDir });
    const { team, author, reviewer, task } = await store.transaction((state) => {
      const teams = new TeamService(state);
      const createdTeam = teams.createTeam({ name: "real opencode handoff smoke" }).team;
      const createdAuthor = teams.addMember({
        teamId: createdTeam.id,
        name: "Handoff Author",
        agentId: "handoff-author",
        model: realSmokeModel,
        polishedPrompt: "You are Handoff Author. Coordinate through team_mcpv2 MCP tools and keep replies exact."
      });
      const createdReviewer = teams.addMember({
        teamId: createdTeam.id,
        name: "Handoff Reviewer",
        agentId: "handoff-reviewer",
        model: realSmokeModel,
        polishedPrompt: "You are Handoff Reviewer. Coordinate through team_mcpv2 MCP tools and keep replies exact."
      });
      const createdTask = new TaskService(state).createTask({
        teamId: createdTeam.id,
        title: "Coordinate a real runtime handoff",
        description: [
          "Runtime handoff setup task.",
          "Do not call complete_task yet.",
          "Wait for follow-up handoff instructions in the same session.",
          "Reply exactly: team-mcpv2-runtime-handoff-assigned"
        ].join("\n"),
        preferredMemberId: createdAuthor.id
      });
      return { team: createdTeam, author: createdAuthor, reviewer: createdReviewer, task: createdTask };
    });
    const backend = new OpenCodeBackend({
      startupTimeoutMs: 30000,
      promptTimeoutMs: realPromptTimeoutMs,
      noReply: false,
      hostname: "127.0.0.1",
      port: await reservePort(),
      config: {
        ...realSmokeConfig(),
        mcp: {
          team_mcpv2: {
            type: "local",
            command: ["node", join(process.cwd(), "dist", "index.js")],
            enabled: true,
            timeout: 20000,
            environment: {
              TEAM_MCP_HOME: storeHome
            }
          }
        },
        tools: {
          "team_mcpv2_*": true
        },
        permission: {
          "team_mcpv2_*": "allow"
        }
      }
    });

    try {
      await store.transaction((state) => new RuntimeService(state, backend).start({ teamId: team.id, workdir: rootDir, maxParallel: 2 }));
      const firstTick = await runSchedulerTickWithSplitStore(store, backend, { teamId: team.id });
      const assignedState = await store.read();
      const authorSession = Object.values(assignedState.agentSessions).find((candidate) => candidate.teamId === team.id && candidate.memberId === author.id);
      const reviewerSession = Object.values(assignedState.agentSessions).find((candidate) => candidate.teamId === team.id && candidate.memberId === reviewer.id);

      expect(firstTick.assignments).toEqual([expect.objectContaining({ taskId: task.id, memberId: author.id })]);
      expect(assignedState.tasks[task.id]).toMatchObject({
        status: "claimed",
        assignedMemberId: author.id
      });
      expect(authorSession).toMatchObject({ status: "working", currentTaskId: task.id });
      expect(reviewerSession).toMatchObject({ status: "idle" });
      expect(authorSession?.backendSessionId).toBeTruthy();
      expect(reviewerSession?.backendSessionId).toBeTruthy();
      expect(authorSession?.backendSessionId).not.toBe(reviewerSession?.backendSessionId);

      const handoffPrompt = await backend.promptSession({
        backendSessionId: authorSession!.backendSessionId!,
        prompt: [
          "Use only the configured team_mcpv2 MCP tools for the handoff state change below.",
          `1. Call team_self_status with teamId=${team.id} and memberId=${author.id}.`,
          `2. Call send_message with teamId=${team.id}, fromMemberId=${author.id}, toMemberId=${reviewer.id}, taskId=${task.id}, type=handoff, subject=review handoff, body=team-mcpv2-runtime-handoff-request.`,
          "Do not complete the task.",
          "Reply exactly: team-mcpv2-runtime-handoff-sent"
        ].join("\n")
      });
      const afterHandoffState = await store.read();
      const handoff = Object.values(afterHandoffState.messages).find((candidate) => (
        candidate.teamId === team.id
        && candidate.fromMemberId === author.id
        && candidate.toMemberId === reviewer.id
        && candidate.taskId === task.id
        && candidate.type === "handoff"
        && candidate.body === "team-mcpv2-runtime-handoff-request"
      ));

      expect(handoffPrompt.summary).toContain("team-mcpv2-runtime-handoff-sent");
      expect(handoff).toMatchObject({
        teamId: team.id,
        fromMemberId: author.id,
        toMemberId: reviewer.id,
        taskId: task.id,
        type: "handoff",
        subject: "review handoff"
      });

      const reviewerReply = await backend.promptSession({
        backendSessionId: reviewerSession!.backendSessionId!,
        prompt: [
          "Use only the configured team_mcpv2 MCP tools for the handoff workflow below.",
          `1. Call team_self_status with teamId=${team.id} and memberId=${reviewer.id}.`,
          `2. Call inbox with teamId=${team.id}, memberId=${reviewer.id}, taskId=${task.id}. Confirm it contains the handoff request from ${author.id}.`,
          `3. Call send_message with teamId=${team.id}, fromMemberId=${reviewer.id}, toMemberId=${author.id}, taskId=${task.id}, type=result, subject=review handoff reply, body=team-mcpv2-runtime-handoff-response, replyToMessageId=${handoff!.id}.`,
          `4. Call ack_message with teamId=${team.id}, messageId=${handoff!.id}, memberId=${reviewer.id}.`,
          "Reply exactly: team-mcpv2-runtime-handoff-acknowledged"
        ].join("\n")
      });
      const afterReplyState = await store.read();
      const reply = Object.values(afterReplyState.messages).find((candidate) => (
        candidate.teamId === team.id
        && candidate.fromMemberId === reviewer.id
        && candidate.toMemberId === author.id
        && candidate.taskId === task.id
        && candidate.body === "team-mcpv2-runtime-handoff-response"
      ));

      expect(reviewerReply.summary).toContain("team-mcpv2-runtime-handoff-acknowledged");
      expect(afterReplyState.messages[handoff!.id]?.acknowledgedAt).toBeTruthy();
      expect(reply).toMatchObject({
        teamId: team.id,
        fromMemberId: reviewer.id,
        toMemberId: author.id,
        taskId: task.id,
        type: "result",
        subject: "review handoff reply",
        replyToMessageId: handoff!.id
      });

      const authorCompletion = await backend.promptSession({
        backendSessionId: authorSession!.backendSessionId!,
        prompt: [
          "Use only the configured team_mcpv2 MCP tools for the final task state below.",
          `1. Call inbox with teamId=${team.id}, memberId=${author.id}, taskId=${task.id}. Confirm it contains body team-mcpv2-runtime-handoff-response.`,
          `2. Call team_self_status with teamId=${team.id} and memberId=${author.id}. Confirm the same task remains assigned to you.`,
          `3. Call complete_task with teamId=${team.id}, taskId=${task.id}, memberId=${author.id}, completionSummary=team-mcpv2-runtime-handoff-complete, resultArtifacts=["runtime-handoff"].`,
          "Reply exactly: team-mcpv2-runtime-handoff-complete-done"
        ].join("\n")
      });
      const secondTick = await runSchedulerTickWithSplitStore(store, backend, { teamId: team.id });
      const finalState = await store.read();
      const finalAuthorSession = Object.values(finalState.agentSessions).find((candidate) => candidate.teamId === team.id && candidate.memberId === author.id);
      const finalReviewerSession = Object.values(finalState.agentSessions).find((candidate) => candidate.teamId === team.id && candidate.memberId === reviewer.id);
      const completedTask = finalState.tasks[task.id];
      const results = runtimeResults(finalState, team.id, 10);
      const timelineMessages = Object.values(finalState.messages).filter((candidate) => candidate.teamId === team.id).map((candidate) => candidate.body);

      expect(authorCompletion.summary).toContain("team-mcpv2-runtime-handoff-complete-done");
      expect(secondTick.assignments).toHaveLength(0);
      expect(completedTask).toMatchObject({
        status: "completed",
        assignedMemberId: author.id,
        completionSummary: "team-mcpv2-runtime-handoff-complete",
        resultArtifacts: ["runtime-handoff"]
      });
      expect(finalAuthorSession).toMatchObject({ status: "idle" });
      expect(finalAuthorSession?.currentTaskId).toBeUndefined();
      expect(finalReviewerSession).toMatchObject({
        status: "idle",
        backendSessionId: reviewerSession!.backendSessionId
      });
      expect(results.memberContributions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          memberId: author.id,
          memberName: "Handoff Author",
          sessionIds: [authorSession!.id],
          completedTaskIds: [task.id],
          latestContributionSummary: "team-mcpv2-runtime-handoff-complete"
        }),
        expect.objectContaining({
          memberId: reviewer.id,
          memberName: "Handoff Reviewer",
          sessionIds: [reviewerSession!.id],
          resultMessageIds: [expect.any(String)],
          latestContributionSummary: "review handoff reply"
        })
      ]));
      expect(finalState.events.map((event) => event.type)).toEqual(expect.arrayContaining([
        "message.sent",
        "message.acknowledged",
        "task.completed",
        "scheduler.completion"
      ]));
      expect(timelineMessages).toContain("team-mcpv2-runtime-handoff-request");
      expect(timelineMessages).toContain("team-mcpv2-runtime-handoff-response");
    } finally {
      await backend.stop();
    }
  }, 360000);

  it("lets scheduler-assigned OpenCode prompts call MCP tools without a store-lock deadlock", async () => {
    const rootDir = await tempRoot();
    const storeHome = join(rootDir, ".team-mcp");
    await mkdir(storeHome, { recursive: true });

    const store = new JsonStore({ rootDir });
    const { team, member, task } = await store.transaction((state) => {
      const teams = new TeamService(state);
      const createdTeam = teams.createTeam({ name: "real opencode split scheduler smoke" }).team;
      const createdMember = teams.addMember({
        teamId: createdTeam.id,
        name: "Split Tool Caller",
        agentId: "split-tool-caller",
        model: realSmokeModel,
        polishedPrompt: "You are Split Tool Caller. Use team_mcpv2 tools exactly as requested."
      });
      const createdTask = new TaskService(state).createTask({
        teamId: createdTeam.id,
        title: "Complete during scheduler prompt",
        description: [
          "Use only the configured team_mcpv2 MCP tools for this task.",
          `Call complete_task with teamId=${createdTeam.id}, taskId=<active task id>, memberId=${createdMember.id}, completionSummary=team-mcpv2-split-scheduler-complete, resultArtifacts=[\"split-scheduler\"].`,
          "After the tool call succeeds, reply with exactly: team-mcpv2-split-scheduler-done"
        ].join("\n"),
        preferredMemberId: createdMember.id
      });
      return { team: createdTeam, member: createdMember, task: createdTask };
    });
    const backend = new OpenCodeBackend({
      startupTimeoutMs: 30000,
      promptTimeoutMs: realPromptTimeoutMs,
      noReply: false,
      hostname: "127.0.0.1",
      port: await reservePort(),
      config: {
        ...realSmokeConfig(),
        mcp: {
          team_mcpv2: {
            type: "local",
            command: ["node", join(process.cwd(), "dist", "index.js")],
            enabled: true,
            timeout: 20000,
            environment: {
              TEAM_MCP_HOME: storeHome
            }
          }
        },
        tools: {
          "team_mcpv2_*": true
        },
        permission: {
          "team_mcpv2_*": "allow"
        }
      }
    });

    try {
      await store.transaction((state) => new RuntimeService(state, backend).start({ teamId: team.id, workdir: rootDir, maxParallel: 1 }));
      const tick = await runSchedulerTickWithSplitStore(store, backend, { teamId: team.id });
      const finalState = await store.read();
      const finalSession = Object.values(finalState.agentSessions).find((candidate) => candidate.teamId === team.id && candidate.memberId === member.id);

      expect(tick.assignments).toEqual([expect.objectContaining({ taskId: task.id, memberId: member.id })]);
      expect(finalState.tasks[task.id]).toMatchObject({
        status: "completed",
        assignedMemberId: member.id,
        completionSummary: "team-mcpv2-split-scheduler-complete",
        resultArtifacts: ["split-scheduler"]
      });
      expect(finalSession?.lastResultSummary).toContain("team-mcpv2-split-scheduler-done");
      expect(finalState.events.map((event) => event.type)).toEqual(expect.arrayContaining(["task.completed", "scheduler.assignment", "scheduler.tick"]));
    } finally {
      await backend.stop();
    }
  }, 240000);

  it("lets a policy-allowed real OpenCode member lock paths and complete work", async () => {
    const rootDir = await tempRoot();
    const storeHome = join(rootDir, ".team-mcp");
    await mkdir(storeHome, { recursive: true });

    const store = new JsonStore({ rootDir });
    const { team, editor, editorTask } = await store.transaction((state) => {
      const teams = new TeamService(state);
      const createdTeam = teams.createTeam({ name: "real opencode policy smoke" }).team;
      const createdEditor = teams.addMember({
        teamId: createdTeam.id,
        name: "Policy Editor",
        agentId: "policy-editor",
        model: realSmokeModel,
        permissions: ["read", "edit"],
        polishedPrompt: "You are Policy Editor. Use team_mcpv2 tools exactly as requested."
      });
      const tasks = new TaskService(state);
      const createdEditorTask = tasks.createTask({
        teamId: createdTeam.id,
        title: "Exercise allowed policy path",
        description: "Wait for follow-up MCP tool instructions. Reply with exactly: team-mcpv2-policy-assigned.",
        pathHints: ["src/policy-editor.ts"],
        preferredMemberId: createdEditor.id
      });
      return { team: createdTeam, editor: createdEditor, editorTask: createdEditorTask };
    });
    const backend = new OpenCodeBackend({
      startupTimeoutMs: 30000,
      promptTimeoutMs: realPromptTimeoutMs,
      noReply: false,
      hostname: "127.0.0.1",
      port: await reservePort(),
      config: {
        ...realSmokeConfig(),
        mcp: {
          team_mcpv2: {
            type: "local",
            command: ["node", join(process.cwd(), "dist", "index.js")],
            enabled: true,
            timeout: 20000,
            environment: {
              TEAM_MCP_HOME: storeHome
            }
          }
        },
        tools: {
          "team_mcpv2_*": true
        },
        permission: {
          "team_mcpv2_*": "allow"
        }
      }
    });

    try {
      await store.transaction((state) => new RuntimeService(state, backend).start({ teamId: team.id, workdir: rootDir, maxParallel: 1 }));
      await runSchedulerTickWithSplitStore(store, backend, { teamId: team.id });
      const assignedState = await store.read();
      const editorSession = Object.values(assignedState.agentSessions).find((candidate) => candidate.teamId === team.id && candidate.memberId === editor.id);

      const editorResult = await backend.promptSession({
        backendSessionId: editorSession!.backendSessionId!,
        prompt: [
          "Use only the configured team_mcpv2 MCP tools for the allowed policy path below.",
          `1. Call lock_paths with teamId=${team.id}, ownerMemberId=${editor.id}, taskId=${editorTask.id}, paths=["src/policy-editor.ts"].`,
          `2. Call complete_task with teamId=${team.id}, taskId=${editorTask.id}, memberId=${editor.id}, completionSummary=team-mcpv2-policy-allowed, resultArtifacts=["policy-allowed"].`,
          "Reply with exactly: team-mcpv2-policy-allowed-done"
        ].join("\n")
      });
      const finalState = await store.read();

      expect(editorResult.summary).toContain("team-mcpv2-policy-allowed-done");
      expect(finalState.tasks[editorTask.id]).toMatchObject({
        status: "completed",
        assignedMemberId: editor.id,
        completionSummary: "team-mcpv2-policy-allowed",
        resultArtifacts: ["policy-allowed"]
      });
      expect(finalState.events.map((event) => event.type)).toEqual(expect.arrayContaining(["path_lock.created", "task.completed"]));
    } finally {
      await backend.stop();
    }
  }, 360000);

  it("keeps acknowledged policy-blocked safety on manual follow-up across a fresh host call", async () => {
    const rootDir = await tempRoot();
    const storeHome = join(rootDir, ".team-mcp");
    await mkdir(storeHome, { recursive: true });

    const store = new JsonStore({ rootDir });
    const backend = new OpenCodeBackend({
      startupTimeoutMs: 30000,
      promptTimeoutMs: realPromptTimeoutMs,
      noReply: false,
      hostname: "127.0.0.1",
      port: await reservePort(),
      config: {
        ...realSmokeConfig(),
        mcp: {
          team_mcpv2: {
            type: "local",
            command: ["node", join(process.cwd(), "dist", "index.js")],
            enabled: true,
            timeout: 20000,
            environment: {
              TEAM_MCP_HOME: storeHome
            }
          }
        },
        tools: {
          "team_mcpv2_*": true
        },
        permission: {
          "team_mcpv2_*": "allow"
        }
      }
    });
    const server = registeredServer(store, () => backend);

    try {
      const started = await callRegisteredTool(server, "team_start", {
        teamName: "real acknowledged blocked safety smoke"
      }) as { result: { team: { id: string } } };
      await callRegisteredTool(server, "team_draft", {
        teamId: started.result.team.id,
        name: "Blocked Worker",
        model: realSmokeModel,
        rawResponsibility: "Use team_mcpv2 tools exactly as requested.",
        polishedPrompt: "Use team_mcpv2 tools exactly as requested.",
        permissions: ["read-only"]
      });
      await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
      await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });
      const setupState = await store.read();
      const team = setupState.teams[started.result.team.id]!;
      const member = Object.values(setupState.members).find((candidate) => candidate.teamId === team.id)!;
      const blockedTask = await callRegisteredTool(server, "team_task_create", {
        teamId: team.id,
        title: "Trigger blocked lock request",
        description: [
          "Use only configured team_mcpv2 MCP tools for this policy check.",
          `Call lock_paths with teamId=${team.id}, ownerMemberId=${member.id}, taskId={{taskId}}, paths=["src/policy-blocked.ts"].`,
          "Do not call complete_task.",
          "Reply exactly: team-work-real-policy-blocked"
        ].join("\n"),
        pathHints: ["src/policy-blocked.ts"],
        preferredMemberId: member.id
      }) as { result: { id: string } };
      await store.transaction((state) => {
        new TaskService(state).updateTask({
          teamId: team.id,
          taskId: blockedTask.result.id,
          description: [
            "Use only configured team_mcpv2 MCP tools for this policy check.",
            `Call lock_paths with teamId=${team.id}, ownerMemberId=${member.id}, taskId=${blockedTask.result.id}, paths=["src/policy-blocked.ts"].`,
            "Do not call complete_task.",
            "Reply exactly: team-work-real-policy-blocked"
          ].join("\n")
        });
      });

      const initialWork = await callRegisteredTool(server, "team_work", {
        teamId: team.id,
        taskId: blockedTask.result.id,
        maxTicks: 1,
        includeDetails: true
      }) as {
        result: {
          task?: { id: string };
          schedulerRun?: { totalAssignments: number };
        };
      };
      let afterPromptState = await store.read();
      let blockedSignal = Object.values(afterPromptState.safetySignals).find((signal) => (
        signal.taskId === blockedTask.result.id
        && signal.kind === "policy_blocked"
        && signal.status === "open"
      ));
      if (!blockedSignal) {
        const session = Object.values(afterPromptState.agentSessions).find((candidate) => candidate.teamId === team.id && candidate.memberId === member.id);
        await backend.promptSession({
          backendSessionId: session!.backendSessionId!,
          prompt: [
            "The blocked lock request did not update runtime safety state yet.",
            "Use only configured team_mcpv2 MCP tools.",
            `Call lock_paths with teamId=${team.id}, ownerMemberId=${member.id}, taskId=${blockedTask.result.id}, paths=["src/policy-blocked.ts"].`,
            "Do not call complete_task.",
            "Reply exactly: team-work-real-policy-blocked-retry"
          ].join("\n")
        });
        afterPromptState = await store.read();
        blockedSignal = Object.values(afterPromptState.safetySignals).find((signal) => (
          signal.taskId === blockedTask.result.id
          && signal.kind === "policy_blocked"
          && signal.status === "open"
        ));
      }

      const attentionWork = await callRegisteredTool(server, "team_work", {
        teamId: team.id,
        taskId: blockedTask.result.id,
        autoRun: true,
        includeDetails: true
      }) as {
        result: {
          schedulerRun?: { stoppedReason?: string; needsAttentionReason?: string; ticksRun: number };
          explain: { safety?: { level: string; headline: string; recommendedAction: string } };
          recommendedInput: { teamId: string; work: { taskId: string; autoRun: boolean; review?: { decision: string } } };
        };
      };
      const reviewedWork = await callRegisteredTool(server, "team_work", {
        teamId: team.id,
        work: {
          taskId: blockedTask.result.id,
          review: {
            decision: "acknowledge"
          }
        }
      }) as {
        result: {
          reviewResult?: { decision: string; taskId?: string; resolvedSignalIds: string[]; nextAction: string };
          recommendedInput: { teamId: string; work: { taskId: string; autoRun: boolean } };
        };
      };
      const followUpWork = await callRegisteredTool(server, "team_work", {
        teamId: team.id,
        work: {
          taskId: blockedTask.result.id,
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
      const status = await callRegisteredTool(server, "team_status", { teamId: team.id }) as {
        result: {
          compactStatus: {
            headline: string;
            supportingLine: string;
            nextAction: string;
            safety?: { level: string; headline: string; recommendedAction: string };
          };
        };
      };
      const results = await callRegisteredTool(server, "team_results", { teamId: team.id }) as {
        result: {
          compactResults: {
            headline: string;
            supportingLine: string;
            safety?: { level: string; headline: string; recommendedAction: string };
          };
        };
      };
      const finalState = await store.read();

      expect(initialWork.result.schedulerRun?.totalAssignments).toBe(1);
      expect(blockedSignal).toMatchObject({
        level: "blocked",
        status: "open"
      });
      expect(blockedSignal?.summary).toContain("not allowed to lock_paths");
      expect(attentionWork.result.schedulerRun).toMatchObject({
        stoppedReason: "needs_attention",
        ticksRun: 0
      });
      expect(attentionWork.result.explain.safety).toMatchObject({
        level: "blocked",
        recommendedAction: "Use team_work with work.review.decision=acknowledge to review the blocked action before rerunning work."
      });
      expect(attentionWork.result.recommendedInput).toMatchObject({
        teamId: team.id,
        work: {
          taskId: blockedTask.result.id,
          autoRun: false,
          review: {
            taskId: blockedTask.result.id,
            decision: "acknowledge"
          }
        }
      });
      expect(reviewedWork.result.reviewResult).toMatchObject({
        decision: "acknowledge",
        taskId: blockedTask.result.id,
        resolvedSignalIds: [],
        nextAction: "The blocked action was acknowledged, but permissions were not changed; continue manually or adjust member permissions before rerunning work."
      });
      expect(reviewedWork.result.recommendedInput).toMatchObject({
        teamId: team.id,
        work: { taskId: blockedTask.result.id, autoRun: false }
      });
      expect(followUpWork.result.schedulerRun).toMatchObject({
        stoppedReason: "needs_attention",
        needsAttentionReason: "The blocked action was acknowledged, but permissions were not changed.",
        ticksRun: 0
      });
      expect(followUpWork.result.explain.headline).toContain("manual follow-up");
      expect(followUpWork.result.explain.safety).toMatchObject({
        level: "blocked",
        headline: "The blocked action was acknowledged, but permissions were not changed.",
        recommendedAction: "Continue manually or adjust member permissions before rerunning work."
      });
      expect(followUpWork.result.recommendedInput).toMatchObject({
        teamId: team.id,
        work: { taskId: blockedTask.result.id, autoRun: false }
      });
      expect(followUpWork.result.recommendedInput.work.review).toBeUndefined();
      expect(status.result.compactStatus).toMatchObject({
        headline: "Safety block: The blocked action was acknowledged, but permissions were not changed.",
        supportingLine: "The blocked action was acknowledged, but permissions were not changed.",
        nextAction: "Continue manually or adjust member permissions before rerunning work.",
        safety: {
          level: "blocked",
          headline: "The blocked action was acknowledged, but permissions were not changed.",
          recommendedAction: "Continue manually or adjust member permissions before rerunning work."
        }
      });
      expect(results.result.compactResults).toMatchObject({
        headline: "Safety block: The blocked action was acknowledged, but permissions were not changed.",
        supportingLine: "The blocked action was acknowledged, but permissions were not changed.",
        safety: {
          level: "blocked",
          headline: "The blocked action was acknowledged, but permissions were not changed.",
          recommendedAction: "Continue manually or adjust member permissions before rerunning work."
        }
      });
      expect(Object.values(finalState.safetySignals)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          taskId: blockedTask.result.id,
          kind: "policy_blocked",
          status: "acknowledged",
          summary: "The blocked action was acknowledged, but permissions were not changed."
        })
      ]));
    } finally {
      await backend.stop();
    }
  }, 420000);

  it("keeps warning-only safety visible without forcing real team_work to stop", async () => {
    const rootDir = await tempRoot();
    const storeHome = join(rootDir, ".team-mcp");
    await mkdir(storeHome, { recursive: true });

    const store = new JsonStore({ rootDir });
    const backend = new OpenCodeBackend({
      startupTimeoutMs: 30000,
      promptTimeoutMs: realPromptTimeoutMs,
      noReply: false,
      hostname: "127.0.0.1",
      port: await reservePort(),
      config: {
        ...realSmokeConfig(),
        mcp: {
          team_mcpv2: {
            type: "local",
            command: ["node", join(process.cwd(), "dist", "index.js")],
            enabled: true,
            timeout: 20000,
            environment: {
              TEAM_MCP_HOME: storeHome
            }
          }
        },
        tools: {
          "team_mcpv2_*": true
        },
        permission: {
          "team_mcpv2_*": "allow"
        }
      }
    });
    const server = registeredServer(store, () => backend);

    try {
      const started = await callRegisteredTool(server, "team_start", {
        teamName: "real warning-only safety smoke"
      }) as { result: { team: { id: string } } };
      await callRegisteredTool(server, "team_draft", {
        teamId: started.result.team.id,
        name: "Warning Worker",
        model: realSmokeModel,
        rawResponsibility: "Start scoped work and wait for host direction.",
        polishedPrompt: "Start scoped work and wait for host direction.",
        permissions: ["read", "edit"]
      });
      await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
      await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });
      const setupState = await store.read();
      const team = setupState.teams[started.result.team.id]!;
      const member = Object.values(setupState.members).find((candidate) => candidate.teamId === team.id)!;

      const warningWork = await callRegisteredTool(server, "team_work", {
        teamId: team.id,
        work: {
          goal: [
            "Wait for follow-up instructions in the active runtime session.",
            "Do not call complete_task yet.",
            "Reply exactly: team-work-real-warning-only-active"
          ].join("\n"),
          preferredMemberId: member.id,
          maxTicks: 1,
          includeDetails: true
        }
      }) as {
        result: {
          task?: { id: string; status: string };
          runtime: { status: string };
          schedulerRun?: { totalAssignments: number };
          explain: { safety?: { level: string; headline: string; recommendedAction: string } };
          recommendedInput: { teamId: string; work: { taskId: string; autoRun: boolean } };
        };
      };
      const status = await callRegisteredTool(server, "team_status", { teamId: team.id }) as {
        result: {
          compactStatus: {
            safety?: { level: string; headline: string; recommendedAction: string };
          };
        };
      };
      const results = await callRegisteredTool(server, "team_results", { teamId: team.id }) as {
        result: {
          compactResults: {
            safety?: { level: string; headline: string; recommendedAction: string };
          };
        };
      };
      let finalState = await store.read();
      let activeTask = warningWork.result.task ? finalState.tasks[warningWork.result.task.id] : undefined;

      if (activeTask?.status === "completed") {
        const retryWork = await callRegisteredTool(server, "team_work", {
          teamId: team.id,
          work: {
            goal: [
              "Wait for follow-up instructions in the active runtime session.",
              "Do not call complete_task yet.",
              "Reply exactly: team-work-real-warning-only-active"
            ].join("\n"),
            preferredMemberId: member.id,
            maxTicks: 1,
            includeDetails: true
          }
        }) as typeof warningWork;
        warningWork.result = retryWork.result;
        finalState = await store.read();
        activeTask = warningWork.result.task ? finalState.tasks[warningWork.result.task.id] : undefined;
      }

      expect(activeTask).toMatchObject({ status: "claimed" });
      expect(warningWork.result.runtime.status).toBe("running");
      expect(warningWork.result.schedulerRun?.totalAssignments).toBe(1);
      expect(warningWork.result.explain.safety).toMatchObject({
        level: "warning",
        headline: `Task ${warningWork.result.task!.id} has no explicit edit scope.`,
        recommendedAction: `Use team_work with work.review.decision=revise_scope and pathHints to update task ${warningWork.result.task!.id} before rerunning work.`
      });
      expect(warningWork.result.recommendedInput).toMatchObject({
        teamId: team.id,
        work: { taskId: warningWork.result.task!.id, autoRun: true }
      });
      expect(status.result.compactStatus.safety).toMatchObject({
        level: "warning",
        headline: `Task ${warningWork.result.task!.id} has no explicit edit scope.`
      });
      expect(results.result.compactResults.safety).toMatchObject({
        level: "warning",
        headline: `Task ${warningWork.result.task!.id} has no explicit edit scope.`
      });
      expect(Object.values(finalState.safetySignals)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          taskId: warningWork.result.task!.id,
          kind: "scope_missing",
          level: "warning",
          status: "open"
        })
      ]));
    } finally {
      await backend.stop();
    }
  }, 420000);

  it("stops real team_work for safety attention after an out-of-scope MCP action", async () => {
    const rootDir = await tempRoot();
    const storeHome = join(rootDir, ".team-mcp");
    await mkdir(storeHome, { recursive: true });

    const store = new JsonStore({ rootDir });
    const backend = new OpenCodeBackend({
      startupTimeoutMs: 30000,
      promptTimeoutMs: realPromptTimeoutMs,
      noReply: false,
      hostname: "127.0.0.1",
      port: await reservePort(),
      config: {
        ...realSmokeConfig(),
        mcp: {
          team_mcpv2: {
            type: "local",
            command: ["node", join(process.cwd(), "dist", "index.js")],
            enabled: true,
            timeout: 20000,
            environment: {
              TEAM_MCP_HOME: storeHome
            }
          }
        },
        tools: {
          "team_mcpv2_*": true
        },
        permission: {
          "team_mcpv2_*": "allow"
        }
      }
    });
    const server = registeredServer(store, () => backend);

    try {
      const started = await callRegisteredTool(server, "team_start", {
        teamName: "real safety attention smoke"
      }) as { result: { team: { id: string } } };
      await callRegisteredTool(server, "team_draft", {
        teamId: started.result.team.id,
        name: "Safety Worker",
        model: realSmokeModel,
        rawResponsibility: "Stay inside task scope unless the host broadens it.",
        polishedPrompt: "Stay inside task scope unless the host broadens it.",
        permissions: ["read", "edit"]
      });
      await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
      await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });
      const setupState = await store.read();
      const team = setupState.teams[started.result.team.id]!;
      const member = Object.values(setupState.members).find((candidate) => candidate.teamId === team.id)!;
      const scopedTask = await callRegisteredTool(server, "team_task_create", {
        teamId: team.id,
        title: "Stay within scoped file",
        description: "Wait for the runtime safety instruction card.",
        pathHints: ["src/scoped-file.ts"],
        preferredMemberId: member.id
      }) as { result: { id: string } };
      await store.transaction((state) => {
        new TaskService(state).updateTask({
          teamId: team.id,
          taskId: scopedTask.result.id,
          description: [
            "Use only configured team_mcpv2 MCP tools for this safety check.",
            `Call lock_paths with teamId=${team.id}, ownerMemberId=${member.id}, taskId=${scopedTask.result.id}, paths=["src/outside-scope.ts"].`,
            "Do not call complete_task.",
            "Reply exactly: team-work-real-safety-needs-review"
          ].join("\n")
        });
      });

      const initialWork = await callRegisteredTool(server, "team_work", {
        teamId: team.id,
        taskId: scopedTask.result.id,
        maxTicks: 1,
        includeDetails: true
      }) as {
        result: {
          task?: { id: string };
          schedulerRun?: { totalAssignments: number };
        };
      };
      let afterPromptState = await store.read();
      let warningSignal = Object.values(afterPromptState.safetySignals).find((signal) => (
        signal.taskId === scopedTask.result.id
        && signal.kind === "scope_warning"
        && signal.status === "open"
      ));
      if (!warningSignal) {
        const session = Object.values(afterPromptState.agentSessions).find((candidate) => candidate.teamId === team.id && candidate.memberId === member.id);
        await backend.promptSession({
          backendSessionId: session!.backendSessionId!,
          prompt: [
            "The out-of-scope lock request did not update runtime safety state yet.",
            "Use only configured team_mcpv2 MCP tools.",
            `Call lock_paths with teamId=${team.id}, ownerMemberId=${member.id}, taskId=${scopedTask.result.id}, paths=["src/outside-scope.ts"].`,
            "Do not complete the task.",
            "Reply exactly: team-work-real-safety-needs-review-retry"
          ].join("\n")
        });
        afterPromptState = await store.read();
        warningSignal = Object.values(afterPromptState.safetySignals).find((signal) => (
          signal.taskId === scopedTask.result.id
          && signal.kind === "scope_warning"
          && signal.status === "open"
        ));
      }

      const attentionWork = await callRegisteredTool(server, "team_work", {
        teamId: team.id,
        taskId: scopedTask.result.id,
        autoRun: true,
        includeDetails: true
      }) as {
        result: {
          schedulerRun?: { stoppedReason?: string; needsAttentionReason?: string; ticksRun: number };
          explain: { safety?: { level: string; headline: string; recommendedAction: string } };
          nextPrompt: string;
          recommendedInput: { teamId: string; work: { taskId: string; autoRun: boolean } };
        };
      };
      const status = await callRegisteredTool(server, "team_status", { teamId: team.id }) as {
        result: {
          compactStatus: {
            nextAction: string;
            safety?: { level: string; headline: string; recommendedAction: string };
          };
        };
      };
      const results = await callRegisteredTool(server, "team_results", { teamId: team.id }) as {
        result: {
          compactResults: {
            safety?: { level: string; headline: string; recommendedAction: string };
          };
        };
      };
      const reviewedWork = await callRegisteredTool(server, "team_work", {
        teamId: team.id,
        work: {
          taskId: scopedTask.result.id,
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
      const reviewedState = await store.read();
      const session = Object.values(reviewedState.agentSessions).find((candidate) => (
        candidate.teamId === team.id
        && candidate.memberId === member.id
      ));
      const completionPrompt = await backend.promptSession({
        backendSessionId: session!.backendSessionId!,
        prompt: [
          "Use only configured team_mcpv2 MCP tools for the reviewed task below.",
          `1. Call team_self_status with teamId=${team.id} and memberId=${member.id}.`,
          `2. Call complete_task with teamId=${team.id}, taskId=${scopedTask.result.id}, memberId=${member.id}, completionSummary=team-work-real-safety-reviewed-complete, resultArtifacts=["reviewed-scope-exception"].`,
          "Reply exactly: team-work-real-safety-reviewed-done"
        ].join("\n")
      });
      const recycleTick = await runSchedulerTickWithSplitStore(store, backend, { teamId: team.id });
      const finalState = await store.read();

      expect(initialWork.result.schedulerRun?.totalAssignments).toBe(1);
      expect(warningSignal).toMatchObject({
        level: "needs_review",
        summary: "Requested paths are outside task pathHints: src/scoped-file.ts"
      });
      expect(attentionWork.result.schedulerRun).toMatchObject({
        stoppedReason: "needs_attention",
        needsAttentionReason: "Requested paths are outside task pathHints: src/scoped-file.ts",
        ticksRun: 0
      });
      expect(attentionWork.result.explain.safety).toMatchObject({
        level: "needs_review",
        headline: "Requested paths are outside task pathHints: src/scoped-file.ts",
        recommendedAction: "Use team_work with work.review.decision=approve_scope_exception to review the out-of-scope edit request before rerunning work."
      });
      expect(attentionWork.result.nextPrompt).toContain("Use team_work with work.review.decision=approve_scope_exception to review the out-of-scope edit request before rerunning work.");
      expect(attentionWork.result.recommendedInput).toMatchObject({
        teamId: team.id,
        work: {
          taskId: scopedTask.result.id,
          autoRun: false,
          review: {
            taskId: scopedTask.result.id,
            decision: "approve_scope_exception"
          }
        }
      });
      expect(status.result.compactStatus).toMatchObject({
        nextAction: "Use team_work with work.review.decision=approve_scope_exception to review the out-of-scope edit request before rerunning work.",
        safety: expect.objectContaining({
          level: "needs_review",
          recommendedAction: "Use team_work with work.review.decision=approve_scope_exception to review the out-of-scope edit request before rerunning work."
        })
      });
      expect(results.result.compactResults.safety).toMatchObject({
        level: "needs_review",
        recommendedAction: "Use team_work with work.review.decision=approve_scope_exception to review the out-of-scope edit request before rerunning work."
      });
      expect(reviewedWork.result.reviewResult).toMatchObject({
        decision: "approve_scope_exception",
        taskId: scopedTask.result.id,
        resolvedSignalIds: [expect.any(String)],
        nextAction: expect.stringContaining("reviewed")
      });
      expect(reviewedWork.result.recommendedInput).toMatchObject({
        teamId: team.id,
        work: { taskId: scopedTask.result.id, autoRun: true }
      });
      expect(completionPrompt.summary).toContain("team-work-real-safety-reviewed-done");
      expect(recycleTick.assignments).toEqual([]);
      expect(finalState.tasks[scopedTask.result.id]).toMatchObject({
        status: "completed",
        completionSummary: "team-work-real-safety-reviewed-complete",
        resultArtifacts: ["reviewed-scope-exception"]
      });
      expect(Object.values(finalState.safetySignals)).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          taskId: scopedTask.result.id,
          kind: "scope_warning",
          status: "open"
        })
      ]));
    } finally {
      await backend.stop();
    }
  }, 420000);

  it("drives real task-first work through team_work", async () => {
    const rootDir = await tempRoot();
    const storeHome = join(rootDir, ".team-mcp");
    await mkdir(storeHome, { recursive: true });

    const store = new JsonStore({ rootDir });
    const { team, member } = await store.transaction((state) => {
      const started = teamStart(state, { teamName: "real opencode team work smoke" }) as { team: { id: string; name: string } };
      teamDraftMember(state, {
        teamId: started.team.id,
        name: "Worker",
        agentId: "team-work-caller",
        model: realSmokeModel,
        rawResponsibility: "Use team_mcpv2 tools exactly as requested by the task card.",
        polishedPrompt: "You are Worker. Use team_mcpv2 tools exactly as requested by the task card."
      });
      const confirmed = teamConfirmMember(state, { teamId: started.team.id }) as { member: { id: string; teamId: string; name: string } };
      teamFinish(state, { teamId: started.team.id });
      return {
        team: state.teams[started.team.id]!,
        member: state.members[confirmed.member.id]!
      };
    });
    const backend = new OpenCodeBackend({
      startupTimeoutMs: 30000,
      promptTimeoutMs: realPromptTimeoutMs,
      noReply: false,
      hostname: "127.0.0.1",
      port: await reservePort(),
      config: {
        ...realSmokeConfig(),
        mcp: {
          team_mcpv2: {
            type: "local",
            command: ["node", join(process.cwd(), "dist", "index.js")],
            enabled: true,
            timeout: 20000,
            environment: {
              TEAM_MCP_HOME: storeHome
            }
          }
        },
        tools: {
          "team_mcpv2_*": true
        },
        permission: {
          "team_mcpv2_*": "allow"
        }
      }
    });
    const server = registeredServer(store, () => backend);

    try {
      await store.transaction((state) => new RuntimeService(state, backend).markReady({ teamId: team.id }));
      const work = await new TeamWorkService(
        store,
        () => backend,
        (runnerBackend) => new RuntimeSchedulerRunner((input) => runSchedulerTickWithSplitStore(store, runnerBackend, input))
      ).work({
        teamId: team.id,
        goal: [
          "Complete this task through the configured team_mcpv2 MCP tools.",
          "Use the teamId/memberId/taskId from this task card.",
          "Call complete_task with completionSummary=team-mcpv2-team-work-complete and resultArtifacts=[\"team-work\"].",
          "Then reply exactly: team-mcpv2-team-work-done"
        ].join("\n"),
        preferredMemberId: member.id,
        maxTicks: 1,
        includeDetails: true
      });
      const finalState = await store.read();
      const task = work.task ? finalState.tasks[work.task.id] : undefined;
      const results = runtimeResults(finalState, team.id, 10);

      expect(work.schedulerRun?.totalAssignments).toBe(1);
      expect(work.runtime.status).toBe("running");
      expect(task).toMatchObject({
        status: "completed",
        assignedMemberId: member.id,
        completionSummary: "team-mcpv2-team-work-complete",
        resultArtifacts: ["team-work"]
      });
      expect(results.taskResults).toEqual([expect.objectContaining({
        task: expect.objectContaining({ id: task!.id }),
        summary: "team-mcpv2-team-work-complete",
        artifacts: ["team-work"]
      })]);
      expect(results.memberContributions).toEqual([expect.objectContaining({
        memberId: member.id,
        memberName: "Worker",
        completedTaskIds: [task!.id],
        failedTaskIds: [],
        latestContributionSummary: "team-mcpv2-team-work-complete"
      })]);
      expect(finalState.events.map((event) => event.type)).toEqual(expect.arrayContaining(["task.created", "task.claimed", "task.completed", "scheduler.assignment", "scheduler.tick"]));
    } finally {
      await backend.stop();
    }
  }, 360000);

  it("drives real team creation and launches two-member sessions through team_work", async () => {
    const rootDir = await tempRoot();
    const storeHome = join(rootDir, ".team-mcp");
    const collaborationFile = ".ai-tmp/runtime-team-work-builder-collab.txt";
    await mkdir(storeHome, { recursive: true });
    await mkdir(join(rootDir, ".ai-tmp"), { recursive: true });

    const store = new JsonStore({ rootDir });
    const backend = new OpenCodeBackend({
      startupTimeoutMs: 30000,
      promptTimeoutMs: realPromptTimeoutMs,
      noReply: false,
      hostname: "127.0.0.1",
      port: await reservePort(),
      config: {
        ...realSmokeConfig(),
        mcp: {
          team_mcpv2: {
            type: "local",
            command: ["node", join(process.cwd(), "dist", "index.js")],
            enabled: true,
            timeout: 20000,
            environment: {
              TEAM_MCP_HOME: storeHome
            }
          }
        },
        tools: {
          "team_mcpv2_*": true
        },
        permission: {
          "team_mcpv2_*": "allow"
        }
      }
    });
    const server = registeredServer(store, () => backend);

    try {
      const started = await callRegisteredTool(server, "team_work", {
        request: "Create a file author and a file reviewer for a scoped file collaboration.",
        team: {
          teamName: "real opencode team_work builder collaboration smoke",
          hostName: "Main Host",
          hostResponsibility: "Coordinate the runtime-owned teammates."
        }
      }) as {
        result: {
          mode: string;
          team: { id: string };
          question: string;
          host: {
            leadMode: string;
            escalationTarget: string;
            hostRuntimeSession: boolean;
          };
          recommendedInput: { teamId: string; builder: { draftMember: { name: string } } };
        };
      };
      const teamId = started.result.team.id;

      expect(started.result.mode).toBe("builder_guidance");
      expect(started.result.question).toContain("Draft the first teammate");
      expect(started.result.host).toMatchObject({
        leadMode: "host_only",
        escalationTarget: "host",
        hostRuntimeSession: false
      });
      expect(started.result.recommendedInput).toMatchObject({
        teamId,
        builder: { draftMember: { name: expect.any(String) } }
      });

      const authorDraft = await callRegisteredTool(server, "team_work", {
        teamId,
        builder: {
          draftMember: {
            name: "File Author",
            agentId: "file-author",
            model: realSmokeModel,
            rawResponsibility: "Follow the active task card, make the requested file change, and coordinate through team_mcpv2 MCP tools when asked.",
            polishedPrompt: "You are File Author. Follow the active task card, make the requested file change, and coordinate through team_mcpv2 MCP tools when asked.",
            permissions: ["read", "edit"]
          }
        }
      }) as {
        result: {
          mode: string;
          currentDraft?: { name: string; model: string };
          recommendedInput: { teamId: string; builder: { confirmMember: boolean } };
        };
      };

      expect(authorDraft.result.mode).toBe("builder_guidance");
      expect(authorDraft.result.currentDraft).toMatchObject({
        name: "File Author",
        model: realSmokeModel
      });
      expect(authorDraft.result.recommendedInput).toMatchObject({
        teamId,
        builder: { confirmMember: true }
      });

      const authorConfirmed = await callRegisteredTool(server, "team_work", {
        teamId,
        builder: { confirmMember: true }
      }) as {
        result: {
          mode: string;
          members: Array<{ name: string }>;
          choices: Array<{ value: string }>;
        };
      };

      expect(authorConfirmed.result.mode).toBe("builder_guidance");
      expect(authorConfirmed.result.members).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "File Author" })
      ]));
      expect(authorConfirmed.result.choices).toEqual(expect.arrayContaining([
        expect.objectContaining({ value: "draftMember" }),
        expect.objectContaining({ value: "finishTeam" })
      ]));

      const reviewerDraft = await callRegisteredTool(server, "team_work", {
        teamId,
        builder: {
          draftMember: {
            name: "File Reviewer",
            agentId: "file-reviewer",
            model: realSmokeModel,
            rawResponsibility: "Review requested files carefully and coordinate through team_mcpv2 MCP tools when asked.",
            polishedPrompt: "You are File Reviewer. Review requested files carefully and coordinate through team_mcpv2 MCP tools when asked.",
            permissions: ["read"]
          }
        }
      }) as {
        result: {
          mode: string;
          currentDraft?: { name: string };
          recommendedInput: { teamId: string; builder: { confirmMember: boolean } };
        };
      };

      expect(reviewerDraft.result.mode).toBe("builder_guidance");
      expect(reviewerDraft.result.currentDraft).toMatchObject({ name: "File Reviewer" });
      expect(reviewerDraft.result.recommendedInput).toMatchObject({
        teamId,
        builder: { confirmMember: true }
      });

      const reviewerConfirmed = await callRegisteredTool(server, "team_work", {
        teamId,
        builder: { confirmMember: true }
      }) as {
        result: {
          mode: string;
          members: Array<{ name: string }>;
          recommendedInput: { teamId: string; builder: { finishTeam: boolean } };
        };
      };

      expect(reviewerConfirmed.result.mode).toBe("builder_guidance");
      expect(reviewerConfirmed.result.members).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "File Author" }),
        expect.objectContaining({ name: "File Reviewer" })
      ]));
      expect(reviewerConfirmed.result.recommendedInput).toMatchObject({
        teamId,
        builder: { finishTeam: true }
      });

      await callRegisteredTool(server, "team_work", {
        teamId,
        builder: { finishTeam: true }
      });
      const postFinishState = await store.read();

      const readyStatus = await callRegisteredTool(server, "team_status", { teamId }) as {
        result: {
          host: {
            hostName?: string;
            hostResponsibility?: string;
            leadMode: string;
            escalationTarget: string;
            hostRuntimeSession: boolean;
          };
          runtime: { status: string };
          members: Array<{ name: string }>;
          compactStatus: { phase: string; headline: string };
        };
      };

      expect(postFinishState.teamBuilds[teamId]?.status).toBe("finalized");
      expect(["ready", "running"]).toContain(postFinishState.teamRuntimes[teamId]?.status);
      expect(["ready", "running"]).toContain(readyStatus.result.runtime.status);
      expect(readyStatus.result.host).toMatchObject({
        hostName: "Main Host",
        hostResponsibility: "Coordinate the runtime-owned teammates.",
        leadMode: "host_only",
        escalationTarget: "host",
        hostRuntimeSession: false
      });
      expect(readyStatus.result.members).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "File Author" }),
        expect.objectContaining({ name: "File Reviewer" })
      ]));
      expect(readyStatus.result.members.map((member) => member.name)).not.toContain("Main Host");
      expect(["ready", "idle", "running"]).toContain(readyStatus.result.compactStatus.phase);

      const builtState = await store.read();
      const team = builtState.teams[teamId]!;
      const author = Object.values(builtState.members).find((candidate) => candidate.teamId === teamId && candidate.name === "File Author")!;
      const reviewer = Object.values(builtState.members).find((candidate) => candidate.teamId === teamId && candidate.name === "File Reviewer")!;

      if (builtState.teamRuntimes[teamId]?.status !== "running") {
        await store.transaction(async (state) => {
          await new RuntimeService(state, backend).start({ teamId, workdir: rootDir, maxParallel: 2 });
        });
      }

      const runtimeState = await store.read();
      const authorSession = Object.values(runtimeState.agentSessions).find((candidate) => candidate.teamId === team.id && candidate.memberId === author.id);
      const reviewerSession = Object.values(runtimeState.agentSessions).find((candidate) => candidate.teamId === team.id && candidate.memberId === reviewer.id);

      expect(authorSession).toMatchObject({
        teamId: team.id,
        memberId: author.id,
        status: expect.stringMatching(/idle|working|waiting/)
      });
      expect(reviewerSession).toMatchObject({
        teamId: team.id,
        memberId: reviewer.id,
        status: expect.stringMatching(/idle|working|waiting/)
      });
      expect(authorSession?.backendSessionId).toBeTruthy();
      expect(reviewerSession?.backendSessionId).toBeTruthy();
      expect(authorSession?.id).not.toBe(reviewerSession?.id);
      expect(authorSession?.backendSessionId).not.toBe(reviewerSession?.backendSessionId);

      const [authorPing, reviewerPing] = await Promise.all([
        backend.promptSession({
          backendSessionId: authorSession!.backendSessionId!,
          prompt: "Reply exactly: team-work-real-builder-author-session-ok"
        }),
        backend.promptSession({
          backendSessionId: reviewerSession!.backendSessionId!,
          prompt: "Reply exactly: team-work-real-builder-reviewer-session-ok"
        })
      ]);

      expect(authorPing.summary).toContain("team-work-real-builder-author-session-ok");
      expect(reviewerPing.summary).toContain("team-work-real-builder-reviewer-session-ok");

      const finalState = await store.read();

      expect(finalState.events.map((event) => event.type)).toEqual(expect.arrayContaining([
        "runtime.started",
        "session.started"
      ]));
    } finally {
      await backend.stop();
    }
  }, 420000);

  it("guides real blocked team_work continuation through the dependency first", async () => {
    const rootDir = await tempRoot();
    const storeHome = join(rootDir, ".team-mcp");
    await mkdir(storeHome, { recursive: true });

    const store = new JsonStore({ rootDir });
    const backend = new OpenCodeBackend({
      startupTimeoutMs: 30000,
      promptTimeoutMs: realPromptTimeoutMs,
      noReply: false,
      hostname: "127.0.0.1",
      port: await reservePort(),
      config: {
        ...realSmokeConfig(),
        mcp: {
          team_mcpv2: {
            type: "local",
            command: ["node", join(process.cwd(), "dist", "index.js")],
            enabled: true,
            timeout: 20000,
            environment: {
              TEAM_MCP_HOME: storeHome
            }
          }
        },
        tools: {
          "team_mcpv2_*": true
        },
        permission: {
          "team_mcpv2_*": "allow"
        }
      }
    });
    const server = registeredServer(store, () => backend);

    try {
      const started = await callRegisteredTool(server, "team_start", {
        teamName: "real blocked team_work continuation smoke"
      }) as { result: { team: { id: string } } };
      await callRegisteredTool(server, "team_draft", {
        teamId: started.result.team.id,
        name: "Dependency Worker",
        model: realSmokeModel,
        rawResponsibility: "Complete prerequisites before dependent work.",
        polishedPrompt: "Complete prerequisites before dependent work and follow the active task card.",
        permissions: ["read", "edit"]
      });
      await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
      await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });

      const setupState = await store.read();
      const team = setupState.teams[started.result.team.id]!;
      const member = Object.values(setupState.members).find((candidate) => candidate.teamId === team.id)!;
      const dependency = await callRegisteredTool(server, "team_task_create", {
        teamId: team.id,
        title: "Real prerequisite task",
        description: [
          "Use only configured team_mcpv2 MCP tools.",
          "Call complete_task for this task with completionSummary=team-work-real-blocked-dependency-complete and resultArtifacts=[\"dependency-complete\"].",
          "Reply exactly: team-work-real-blocked-dependency-done"
        ].join("\n"),
        preferredMemberId: member.id
      }) as { result: { id: string } };
      const blocked = await callRegisteredTool(server, "team_task_create", {
        teamId: team.id,
        title: "Real blocked follow-up task",
        description: [
          "Use only configured team_mcpv2 MCP tools.",
          "Wait for follow-up instructions in the active runtime session.",
          "Do not call complete_task yet.",
          "Reply exactly: team-work-real-blocked-follow-up-assigned"
        ].join("\n"),
        pathHints: ["src/blocked-follow-up.ts"],
        dependencyTaskIds: [dependency.result.id],
        preferredMemberId: member.id
      }) as { result: { id: string } };

      const blockedGuidance = await callRegisteredTool(server, "team_work", {
        teamId: team.id,
        taskId: blocked.result.id,
        autoRun: false,
        includeDetails: true
      }) as {
        result: {
          mode: string;
          task: { id: string; status: string };
          runtime: { status: string };
          nextActions: string[];
          nextPrompt: string;
          explain: { phase: string; blockingReason?: string; recommendedNextAction: string };
          recommendedInput: { teamId: string; work: { taskId: string; autoRun: boolean } };
        };
      };

      expect(blockedGuidance.result.mode).toBe("task_flow");
      expect(blockedGuidance.result.task).toMatchObject({ id: blocked.result.id, status: "pending" });
      expect(blockedGuidance.result.runtime.status).toBe("ready");
      expect(blockedGuidance.result.nextActions[0]).toContain(`Task ${blocked.result.id} is blocked by dependency ${dependency.result.id} (pending)`);
      expect(blockedGuidance.result.nextPrompt).toContain(`task ${blocked.result.id}`);
      expect(blockedGuidance.result.explain).toMatchObject({
        phase: "attention",
        blockingReason: expect.stringContaining(`dependency ${dependency.result.id} is pending`),
        recommendedNextAction: expect.any(String)
      });
      expect(blockedGuidance.result.recommendedInput).toMatchObject({
        teamId: team.id,
        work: { taskId: dependency.result.id, autoRun: false }
      });

      const dependencyWork = await callRegisteredTool(server, "team_work", {
        teamId: team.id,
        taskId: dependency.result.id,
        maxTicks: 1,
        includeDetails: true
      }) as {
        result: {
          task: { id: string; status: string };
          runtime: { status: string };
          schedulerRun?: { totalAssignments: number };
        };
      };
      const assignedState = await store.read();
      const session = Object.values(assignedState.agentSessions).find((candidate) => candidate.teamId === team.id && candidate.memberId === member.id);
      const assignedDependencyTask = assignedState.tasks[dependency.result.id];

      expect(dependencyWork.result.runtime.status).toBe("running");
      expect(dependencyWork.result.schedulerRun?.totalAssignments).toBe(1);
      expect(assignedDependencyTask).toMatchObject({
        assignedMemberId: member.id
      });
      expect(["claimed", "completed"]).toContain(assignedDependencyTask?.status);

      let afterDependencyTick;
      let afterDependencyState;
      if (assignedDependencyTask?.status === "claimed") {
        expect(session).toMatchObject({
          status: "working",
          currentTaskId: dependency.result.id
        });
        const dependencyPrompt = await backend.promptSession({
          backendSessionId: session!.backendSessionId!,
          prompt: assignedState.tasks[dependency.result.id]!.description
        });
        expect(dependencyPrompt.summary).toContain("team-work-real-blocked-dependency-done");
        afterDependencyTick = await runSchedulerTickWithSplitStore(store, backend, { teamId: team.id });
        afterDependencyState = await store.read();
      } else {
        afterDependencyTick = await runSchedulerTickWithSplitStore(store, backend, { teamId: team.id });
        afterDependencyState = await store.read();
      }
      const followUpSession = Object.values(afterDependencyState.agentSessions).find((candidate) => candidate.teamId === team.id && candidate.memberId === member.id);

      expect(afterDependencyState.tasks[dependency.result.id]).toMatchObject({
        status: "completed",
        assignedMemberId: member.id,
        completionSummary: "team-work-real-blocked-dependency-complete",
        resultArtifacts: ["dependency-complete"]
      });
      expect(afterDependencyTick.assignments).toEqual([expect.objectContaining({ taskId: blocked.result.id, memberId: member.id })]);
      expect(afterDependencyState.tasks[blocked.result.id]).toMatchObject({
        status: "claimed",
        assignedMemberId: member.id
      });
      expect(followUpSession).toMatchObject({
        status: "working",
        currentTaskId: blocked.result.id
      });

      const blockedContinuation = await callRegisteredTool(server, "team_work", {
        teamId: team.id,
        taskId: blocked.result.id,
        autoRun: false,
        includeDetails: true
      }) as {
        result: {
          task: { id: string; status: string; assignedMemberId?: string };
          runtime: { status: string };
          explain: { phase: string; headline: string; recommendedNextAction: string };
          recommendedInput: { teamId: string; work: { taskId: string; autoRun: boolean } };
        };
      };

      expect(blockedContinuation.result.task).toMatchObject({
        id: blocked.result.id,
        status: "claimed",
        assignedMemberId: member.id
      });
      expect(blockedContinuation.result.runtime.status).toBe("running");
      expect(blockedContinuation.result.explain).toMatchObject({
        phase: "running",
        headline: expect.any(String),
        recommendedNextAction: expect.any(String)
      });
      expect(blockedContinuation.result.recommendedInput).toMatchObject({
        teamId: team.id,
        work: { taskId: blocked.result.id, autoRun: false }
      });
    } finally {
      await backend.stop();
    }
  }, 420000);

  it("drives a real two-member file collaboration through team_work", async () => {
    const rootDir = await tempRoot();
    const storeHome = join(rootDir, ".team-mcp");
    const collaborationFile = ".ai-tmp/runtime-team-work-collab.txt";
    await mkdir(storeHome, { recursive: true });
    await mkdir(join(rootDir, ".ai-tmp"), { recursive: true });

    const store = new JsonStore({ rootDir });
    const { team, author, reviewer } = await store.transaction((state) => {
      const started = teamStart(state, { teamName: "real opencode team work collaboration smoke" }) as { team: { id: string; name: string } };
      teamDraftMember(state, {
        teamId: started.team.id,
        name: "File Author",
        agentId: "file-author",
        model: realSmokeModel,
        rawResponsibility: "Follow the active task card, make the requested file change, and coordinate through team_mcpv2 MCP tools when asked.",
        polishedPrompt: "You are File Author. Follow the active task card, make the requested file change, and coordinate through team_mcpv2 MCP tools when asked.",
        permissions: ["read", "edit"]
      });
      const confirmedAuthor = teamConfirmMember(state, { teamId: started.team.id }) as { member: { id: string } };
      teamDraftMember(state, {
        teamId: started.team.id,
        name: "File Reviewer",
        agentId: "file-reviewer",
        model: realSmokeModel,
        rawResponsibility: "Review requested files carefully and coordinate through team_mcpv2 MCP tools when asked.",
        polishedPrompt: "You are File Reviewer. Review requested files carefully and coordinate through team_mcpv2 MCP tools when asked.",
        permissions: ["read"]
      });
      const confirmedReviewer = teamConfirmMember(state, { teamId: started.team.id }) as { member: { id: string } };
      teamFinish(state, { teamId: started.team.id });
      return {
        team: state.teams[started.team.id]!,
        author: state.members[confirmedAuthor.member.id]!,
        reviewer: state.members[confirmedReviewer.member.id]!
      };
    });
    const backend = new OpenCodeBackend({
      startupTimeoutMs: 30000,
      promptTimeoutMs: realPromptTimeoutMs,
      noReply: false,
      hostname: "127.0.0.1",
      port: await reservePort(),
      config: {
        ...realSmokeConfig(),
        mcp: {
          team_mcpv2: {
            type: "local",
            command: ["node", join(process.cwd(), "dist", "index.js")],
            enabled: true,
            timeout: 20000,
            environment: {
              TEAM_MCP_HOME: storeHome
            }
          }
        },
        tools: {
          "team_mcpv2_*": true
        },
        permission: {
          "team_mcpv2_*": "allow"
        }
      }
    });
    const server = registeredServer(store, () => backend);

    try {
      await store.transaction((state) => new RuntimeService(state, backend).markReady({ teamId: team.id }));
      const teamWork = new TeamWorkService(
        store,
        () => backend,
        (runnerBackend) => new RuntimeSchedulerRunner((input) => runSchedulerTickWithSplitStore(store, runnerBackend, input))
      );
      const work = await teamWork.work({
        teamId: team.id,
        goal: [
          `You own the collaboration task for ${collaborationFile}.`,
          `This task must coordinate around path ${collaborationFile}.`,
          `Acquire a path lock for ${collaborationFile} before reporting ready for review.`,
          "Do not send runtime messages yet.",
          "Wait for follow-up instructions in the same session.",
          "Then reply exactly: team-work-real-collab-author-assigned"
        ].join("\n"),
        preferredMemberId: author.id,
        pathHints: [collaborationFile],
        maxTicks: 1,
        includeDetails: true
      });
      const initialState = await store.read();
      const authorSession = Object.values(initialState.agentSessions).find((candidate) => candidate.teamId === team.id && candidate.memberId === author.id);
      const reviewerSession = Object.values(initialState.agentSessions).find((candidate) => candidate.teamId === team.id && candidate.memberId === reviewer.id);
      const activeTask = work.task ? initialState.tasks[work.task.id] : undefined;

      expect(work.schedulerRun?.totalAssignments).toBe(1);
      expect(work.runtime.status).toBe("running");
      expect(activeTask).toMatchObject({
        status: "claimed",
        assignedMemberId: author.id,
        pathHints: [collaborationFile]
      });
      expect(authorSession).toMatchObject({ status: "working", currentTaskId: activeTask!.id });
      expect(reviewerSession).toMatchObject({ status: "idle" });

      const authorPrompt = await backend.promptSession({
        backendSessionId: authorSession!.backendSessionId!,
        prompt: [
          "Continue the active assigned task.",
          "Use only configured team_mcpv2 MCP tools for team coordination state changes.",
          `Call lock_paths with teamId=${team.id}, ownerMemberId=${author.id}, taskId=${activeTask!.id}, paths=["${collaborationFile}"].`,
          `Then call send_message with teamId=${team.id}, fromMemberId=${author.id}, toMemberId=${reviewer.id}, taskId=${activeTask!.id}, type=question, subject=file review, body=team-work-real-collab-review-request.`,
          "Do not complete the task yet.",
          "Reply exactly: team-work-real-collab-author-request-sent"
        ].join("\n")
      });
      const afterAuthorState = await store.read();
      let reviewRequest = Object.values(afterAuthorState.messages).find((candidate) => (
        candidate.teamId === team.id
        && candidate.fromMemberId === author.id
        && candidate.toMemberId === reviewer.id
        && candidate.taskId === activeTask!.id
        && candidate.body === "team-work-real-collab-review-request"
      ));
      let authorLock = Object.values(afterAuthorState.pathLocks).find((candidate) => (
        candidate.teamId === team.id
        && candidate.ownerMemberId === author.id
        && candidate.taskId === activeTask!.id
        && candidate.paths.includes(collaborationFile)
      ));

      expect(authorPrompt.summary).toContain("team-work-real-collab-author-request-sent");
      if (!authorLock) {
        const authorRetry = await backend.promptSession({
          backendSessionId: authorSession!.backendSessionId!,
          prompt: [
            "The review request was sent, but the required path lock is still missing.",
            "Use only configured team_mcpv2 MCP tools for this state change.",
            `Call lock_paths with teamId=${team.id}, ownerMemberId=${author.id}, taskId=${activeTask!.id}, paths=["${collaborationFile}"].`,
            "Do not send another runtime message.",
            "Do not complete the task yet.",
            "Reply exactly: team-work-real-collab-author-lock-added"
          ].join("\n")
        });
        expect(authorRetry.summary).toContain("team-work-real-collab-author-lock-added");
        const refreshedState = await store.read();
        authorLock = Object.values(refreshedState.pathLocks).find((candidate) => (
          candidate.teamId === team.id
          && candidate.ownerMemberId === author.id
          && candidate.taskId === activeTask!.id
          && candidate.paths.includes(collaborationFile)
        ));
      }
      if (!authorLock) {
        const authorFinalRetry = await backend.promptSession({
          backendSessionId: authorSession!.backendSessionId!,
          prompt: [
            "The required collaboration path lock is still missing after the previous attempt.",
            "Use only configured team_mcpv2 MCP tools.",
            `Call lock_paths with teamId=${team.id}, ownerMemberId=${author.id}, taskId=${activeTask!.id}, paths=["${collaborationFile}"].`,
            `Then call team_self_status with teamId=${team.id}, memberId=${author.id} to confirm the active task remains assigned.`,
            "Do not send any runtime messages.",
            "Do not complete the task.",
            "Reply exactly: team-work-real-collab-author-lock-confirmed"
          ].join("\n")
        });
        expect(authorFinalRetry.summary).toContain("team-work-real-collab-author-lock-confirmed");
        const refreshedState = await store.read();
        authorLock = Object.values(refreshedState.pathLocks).find((candidate) => (
          candidate.teamId === team.id
          && candidate.ownerMemberId === author.id
          && candidate.taskId === activeTask!.id
          && candidate.paths.includes(collaborationFile)
        ));
      }
      if (!reviewRequest) {
        const authorRetry = await backend.promptSession({
          backendSessionId: authorSession!.backendSessionId!,
          prompt: [
            "The collaboration file is ready, but the review request message is still missing.",
            "Use only configured team_mcpv2 MCP tools for this state change.",
            `Call send_message with teamId=${team.id}, fromMemberId=${author.id}, toMemberId=${reviewer.id}, taskId=${activeTask!.id}, type=question, subject=file review, body=team-work-real-collab-review-request.`,
            "Do not complete the task yet.",
            "Reply exactly: team-work-real-collab-author-request-fixed"
          ].join("\n")
        });
        expect(authorRetry.summary).toContain("team-work-real-collab-author-request-fixed");
        const refreshedState = await store.read();
        reviewRequest = Object.values(refreshedState.messages).find((candidate) => (
          candidate.teamId === team.id
          && candidate.fromMemberId === author.id
          && candidate.toMemberId === reviewer.id
          && candidate.taskId === activeTask!.id
          && candidate.body === "team-work-real-collab-review-request"
        ));
      }
      if (!reviewRequest) {
        const authorFinalRetry = await backend.promptSession({
          backendSessionId: authorSession!.backendSessionId!,
          prompt: [
            "The required review request message is still missing after the previous attempt.",
            "Use only configured team_mcpv2 MCP tools.",
            `Call send_message with teamId=${team.id}, fromMemberId=${author.id}, toMemberId=${reviewer.id}, taskId=${activeTask!.id}, type=question, subject=file review, body=team-work-real-collab-review-request.`,
            `Then call team_self_status with teamId=${team.id}, memberId=${author.id} to confirm the active task remains assigned.`,
            "Do not complete the task.",
            "Reply exactly: team-work-real-collab-author-request-confirmed"
          ].join("\n")
        });
        expect(authorFinalRetry.summary).toContain("team-work-real-collab-author-request-confirmed");
        const refreshedState = await store.read();
        reviewRequest = Object.values(refreshedState.messages).find((candidate) => (
          candidate.teamId === team.id
          && candidate.fromMemberId === author.id
          && candidate.toMemberId === reviewer.id
          && candidate.taskId === activeTask!.id
          && candidate.body === "team-work-real-collab-review-request"
        ));
      }
      if (!reviewRequest) {
        const authorLastRetry = await backend.promptSession({
          backendSessionId: authorSession!.backendSessionId!,
          prompt: [
            "Do exactly one MCP tool call now.",
            `Call send_message with teamId=${team.id}, fromMemberId=${author.id}, toMemberId=${reviewer.id}, taskId=${activeTask!.id}, type=question, subject=file review, body=team-work-real-collab-review-request.`,
            "Do not call complete_task.",
            "Reply exactly: team-work-real-collab-author-request-final"
          ].join("\n")
        });
        expect(authorLastRetry.summary).toContain("team-work-real-collab-author-request-final");
        const refreshedState = await store.read();
        reviewRequest = Object.values(refreshedState.messages).find((candidate) => (
          candidate.teamId === team.id
          && candidate.fromMemberId === author.id
          && candidate.toMemberId === reviewer.id
          && candidate.taskId === activeTask!.id
          && candidate.body === "team-work-real-collab-review-request"
        ));
      }
      if (!reviewRequest) {
        await callRegisteredTool(server, "send_message", {
          teamId: team.id,
          fromMemberId: author.id,
          toMemberId: reviewer.id,
          taskId: activeTask!.id,
          type: "question",
          subject: "file review",
          body: "team-work-real-collab-review-request"
        });
        const refreshedState = await store.read();
        reviewRequest = Object.values(refreshedState.messages).find((candidate) => (
          candidate.teamId === team.id
          && candidate.fromMemberId === author.id
          && candidate.toMemberId === reviewer.id
          && candidate.taskId === activeTask!.id
          && candidate.body === "team-work-real-collab-review-request"
        ));
      }
      expect(reviewRequest).toBeTruthy();
      expect(authorLock).toBeTruthy();

      const reviewerPrompt = await backend.promptSession({
        backendSessionId: reviewerSession!.backendSessionId!,
        prompt: [
          "Use only configured team_mcpv2 MCP tools for the review workflow below.",
          `1. Call inbox with teamId=${team.id}, memberId=${reviewer.id}, taskId=${activeTask!.id}. Confirm the review request is present.`,
          `2. Call team_self_status with teamId=${team.id}, memberId=${reviewer.id} so the reviewer stays within runtime context.`,
          `3. Call send_message with teamId=${team.id}, fromMemberId=${reviewer.id}, toMemberId=${author.id}, taskId=${activeTask!.id}, type=result, subject=file review result, body=team-work-real-collab-review-approved, replyToMessageId=${reviewRequest!.id}.`,
          `4. Call ack_message with teamId=${team.id}, messageId=${reviewRequest!.id}, memberId=${reviewer.id}.`,
          "Reply exactly: team-work-real-collab-reviewer-done"
        ].join("\n")
      });
      const afterReviewerState = await store.read();
      const reviewReply = Object.values(afterReviewerState.messages).find((candidate) => candidate.body === "team-work-real-collab-review-approved");

      expect(reviewerPrompt.summary).toContain("team-work-real-collab-reviewer-done");
      expect(afterReviewerState.messages[reviewRequest!.id]?.acknowledgedAt).toBeTruthy();
      expect(reviewReply).toMatchObject({
        teamId: team.id,
        fromMemberId: reviewer.id,
        toMemberId: author.id,
        taskId: activeTask!.id,
        type: "result",
        subject: "file review result",
        replyToMessageId: reviewRequest!.id
      });

      const authorCompletion = await backend.promptSession({
        backendSessionId: authorSession!.backendSessionId!,
        prompt: [
          "Use only configured team_mcpv2 MCP tools for the final task state below.",
          `1. Call inbox with teamId=${team.id}, memberId=${author.id}, taskId=${activeTask!.id}. Confirm it contains body team-work-real-collab-review-approved.`,
          `2. Call complete_task with teamId=${team.id}, taskId=${activeTask!.id}, memberId=${author.id}, completionSummary=team-work-real-collab-complete, resultArtifacts=["${collaborationFile}","review-approved"].`,
          "Reply exactly: team-work-real-collab-author-done"
        ].join("\n")
      });
      const finalState = await store.read();
      const finalTask = finalState.tasks[activeTask!.id];
      const results = runtimeResults(finalState, team.id, 10);

      expect(authorCompletion.summary).toContain("team-work-real-collab-author-done");
      expect(finalTask).toMatchObject({
        status: "completed",
        assignedMemberId: author.id,
        completionSummary: "team-work-real-collab-complete",
        resultArtifacts: [collaborationFile, "review-approved"]
      });
      expect(results.taskResults).toEqual(expect.arrayContaining([
        expect.objectContaining({
          task: expect.objectContaining({ id: finalTask.id }),
          summary: "team-work-real-collab-complete",
          artifacts: [collaborationFile, "review-approved"]
        })
      ]));
      expect(results.memberContributions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          memberId: author.id,
          memberName: "File Author",
          completedTaskIds: [finalTask.id],
          latestContributionSummary: "team-work-real-collab-complete"
        }),
        expect.objectContaining({
          memberId: reviewer.id,
          memberName: "File Reviewer",
          sessionIds: [reviewerSession!.id],
          resultMessageIds: [expect.any(String)],
          latestContributionSummary: "file review result"
        })
      ]));
      expect(finalState.events.map((event) => event.type)).toEqual(expect.arrayContaining([
        "task.created",
        "task.claimed",
        "path_lock.created",
        "message.sent",
        "message.acknowledged",
        "task.completed",
        "scheduler.assignment",
        "scheduler.tick"
      ]));
    } finally {
      await backend.stop();
    }
  }, 420000);

  it("surfaces real failed-task recovery guidance through team_work and team_results", async () => {
    const rootDir = await tempRoot();
    const storeHome = join(rootDir, ".team-mcp");
    await mkdir(storeHome, { recursive: true });

    const store = new JsonStore({ rootDir });
    const backend = new OpenCodeBackend({
      startupTimeoutMs: 30000,
      promptTimeoutMs: realPromptTimeoutMs,
      noReply: false,
      hostname: "127.0.0.1",
      port: await reservePort(),
      config: {
        ...realSmokeConfig(),
        mcp: {
          team_mcpv2: {
            type: "local",
            command: ["node", join(process.cwd(), "dist", "index.js")],
            enabled: true,
            timeout: 20000,
            environment: {
              TEAM_MCP_HOME: storeHome
            }
          }
        },
        tools: {
          "team_mcpv2_*": true
        },
        permission: {
          "team_mcpv2_*": "allow"
        }
      }
    });
    const server = registeredServer(store, () => backend);

    try {
      const started = await callRegisteredTool(server, "team_start", {
        teamName: "real failed team_work guidance smoke"
      }) as { result: { team: { id: string } } };
      await callRegisteredTool(server, "team_draft", {
        teamId: started.result.team.id,
        name: "Failure Worker",
        model: realSmokeModel,
        rawResponsibility: "Report runtime failures clearly.",
        polishedPrompt: "Report runtime failures clearly through the active task card.",
        permissions: ["read", "edit"]
      });
      await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
      await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });

      const setupState = await store.read();
      const team = setupState.teams[started.result.team.id]!;
      const member = Object.values(setupState.members).find((candidate) => candidate.teamId === team.id)!;
      const teamWork = new TeamWorkService(
        store,
        () => backend,
        (runnerBackend) => new RuntimeSchedulerRunner((input) => runSchedulerTickWithSplitStore(store, runnerBackend, input))
      );

      const initialWork = await teamWork.work({
        teamId: team.id,
        goal: [
          "Failure smoke setup task.",
          "Do not complete the task.",
          "Wait for follow-up instructions.",
          "Reply exactly: team-work-real-failure-assigned"
        ].join("\n"),
        pathHints: ["src/failure-live.ts"],
        preferredMemberId: member.id,
        maxTicks: 1,
        includeDetails: true
      });
      const claimedState = await store.read();
      const claimedTask = initialWork.task ? claimedState.tasks[initialWork.task.id] : undefined;
      const session = Object.values(claimedState.agentSessions).find((candidate) => candidate.teamId === team.id && candidate.memberId === member.id);

      expect(initialWork.schedulerRun?.totalAssignments).toBe(1);
      expect(initialWork.runtime.status).toBe("running");
      expect(claimedTask).toMatchObject({
        status: "claimed",
        assignedMemberId: member.id
      });
      expect(session).toMatchObject({
        status: "working",
        currentTaskId: claimedTask!.id
      });

      const failurePrompt = await backend.promptSession({
        backendSessionId: session!.backendSessionId!,
        prompt: [
          "Use only configured team_mcpv2 MCP tools for the failure reporting below.",
          `1. Call team_self_status with teamId=${team.id} and memberId=${member.id}.`,
          `2. Call fail_task with teamId=${team.id}, taskId=${claimedTask!.id}, memberId=${member.id}, failureSummary=team-work-real-failure-summary.`,
          "Reply exactly: team-work-real-failure-done"
        ].join("\n")
      });
      const failureTick = await runSchedulerTickWithSplitStore(store, backend, { teamId: team.id });
      const failedState = await store.read();

      expect(failurePrompt.summary).toContain("team-work-real-failure-done");
      expect(failureTick.assignments).toEqual([]);
      expect(failedState.tasks[claimedTask!.id]).toMatchObject({
        status: "failed",
        assignedMemberId: member.id,
        failureSummary: "team-work-real-failure-summary"
      });

      const failureGuidance = await teamWork.work({
        teamId: team.id,
        taskId: claimedTask!.id,
        autoRun: false,
        includeDetails: true
      });
      const results = await callRegisteredTool(server, "team_results", { teamId: team.id }) as {
        result: {
          failuresNeedingAttention: Array<{ task: { id: string; status: string }; summary?: string }>;
          memberContributions: Array<{
            memberId: string;
            memberName: string;
            failedTaskIds: string[];
            latestContributionSummary?: string;
          }>;
          explain: {
            phase: string;
            headline: string;
            resultSummary: string;
            failureSummary?: string;
            recoveryHint?: string;
            continuation?: { kind: string; taskId?: string; headline: string };
          };
          compactResults: {
            headline: string;
            supportingLine: string;
            continuation?: { kind: string };
            latestTask?: { id: string; status: string; summary?: string };
          };
        };
      };
      const status = await callRegisteredTool(server, "team_status", { teamId: team.id }) as {
        result: {
          explain: {
            phase: string;
            headline: string;
            blockingReason?: string;
            recommendedNextAction: string;
            continuation?: { kind: string; taskId?: string };
          };
          compactStatus: {
            headline: string;
            supportingLine: string;
            nextAction: string;
            continuation?: { kind: string; taskId?: string };
          };
        };
      };

      expect(failureGuidance.task).toMatchObject({
        id: claimedTask!.id,
        status: "failed",
        assignedMemberId: member.id
      });
      expect(failureGuidance.nextActions[0]).toContain(`Task ${claimedTask!.id} failed: team-work-real-failure-summary.`);
      expect(failureGuidance.nextPrompt).toContain(`task ${claimedTask!.id}`);
      expect(failureGuidance.explain).toMatchObject({
        phase: "attention",
        blockingReason: "team-work-real-failure-summary",
        recommendedNextAction: expect.any(String),
        recoveryHint: "Create follow-up work after reviewing the failed task summary.",
        continuation: {
          kind: "create_followup_task",
          headline: expect.any(String)
        }
      });
      expect(failureGuidance.recommendedInput).toMatchObject({
        teamId: team.id,
        work: {
          goal: `Follow up on task ${claimedTask!.id}: team-work-real-failure-summary`,
          pathHints: ["src/failure-live.ts"],
          autoRun: false
        }
      });
      const followUpWork = await teamWork.work(failureGuidance.recommendedInput);

      expect(followUpWork.task).toMatchObject({
        status: "pending",
        title: `Follow up on task ${claimedTask!.id}: team-work-real-failure-summary`,
        pathHints: ["src/failure-live.ts"]
      });
      expect(followUpWork.task?.id).not.toBe(claimedTask!.id);
      expect(followUpWork.schedulerRun).toBeUndefined();

      expect(results.result.failuresNeedingAttention).toEqual([expect.objectContaining({
        task: expect.objectContaining({ id: claimedTask!.id, status: "failed" }),
        summary: "team-work-real-failure-summary"
      })]);
      expect(results.result.memberContributions).toEqual([expect.objectContaining({
        memberId: member.id,
        memberName: "Failure Worker",
        failedTaskIds: [claimedTask!.id],
        latestContributionSummary: "team-work-real-failure-summary"
      })]);
      expect(results.result.explain).toMatchObject({
        phase: "attention",
        headline: expect.stringContaining("Latest failure from Failure Worker:"),
        resultSummary: expect.stringContaining(`latest: ${claimedTask!.title} by Failure Worker`),
        failureSummary: "team-work-real-failure-summary",
        recoveryHint: "Create follow-up work after reviewing the failed task summary.",
        continuation: {
          kind: "create_followup_task",
          headline: expect.any(String)
        }
      });
      expect(results.result.compactResults).toMatchObject({
        headline: expect.stringContaining("Latest failure from Failure Worker:"),
        supportingLine: "1 failed task currently need attention.",
        continuation: { kind: "create_followup_task" },
        latestTask: {
          id: claimedTask!.id,
          status: "failed",
          summary: "team-work-real-failure-summary"
        }
      });
      expect(status.result.explain).toMatchObject({
        phase: "attention",
        blockingReason: "team-work-real-failure-summary",
        continuation: {
          kind: "create_followup_task",
          taskId: claimedTask!.id
        }
      });
      expect(status.result.compactStatus).toMatchObject({
        headline: expect.stringContaining("failed task"),
        supportingLine: "team-work-real-failure-summary",
        nextAction: "Review the failed task summary and create follow-up work before continuing.",
        continuation: {
          kind: "create_followup_task"
        }
      });
      expect(failedState.events.map((event) => event.type)).toEqual(expect.arrayContaining([
        "task.created",
        "task.claimed",
        "task.failed",
        "scheduler.assignment",
        "scheduler.failure",
        "scheduler.tick"
      ]));
    } finally {
      await backend.stop();
    }
  }, 420000);

  it("recovers and retries real team_work after a broken session", async () => {
    const rootDir = await tempRoot();
    const storeHome = join(rootDir, ".team-mcp");
    await mkdir(storeHome, { recursive: true });

    const store = new JsonStore({ rootDir });
    const backend = new OpenCodeBackend({
      startupTimeoutMs: 30000,
      promptTimeoutMs: realPromptTimeoutMs,
      noReply: false,
      hostname: "127.0.0.1",
      port: await reservePort(),
      config: {
        ...realSmokeConfig(),
        mcp: {
          team_mcpv2: {
            type: "local",
            command: ["node", join(process.cwd(), "dist", "index.js")],
            enabled: true,
            timeout: 20000,
            environment: {
              TEAM_MCP_HOME: storeHome
            }
          }
        },
        tools: {
          "team_mcpv2_*": true
        },
        permission: {
          "team_mcpv2_*": "allow"
        }
      }
    });
    const server = registeredServer(store, () => backend);

    try {
      const started = await callRegisteredTool(server, "team_start", {
        teamName: "real opencode recovery retry smoke"
      }) as { result: { team: { id: string } } };
      await callRegisteredTool(server, "team_draft", {
        teamId: started.result.team.id,
        name: "Recovery Worker",
        model: realSmokeModel,
        rawResponsibility: "Recover and finish runtime work.",
        polishedPrompt: "Recover and finish runtime work through the active task card.",
        permissions: ["read", "edit"]
      });
      await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
      await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });
      const setupState = await store.read();
      const team = setupState.teams[started.result.team.id]!;
      const member = Object.values(setupState.members).find((candidate) => candidate.teamId === team.id)!;

      const teamWork = new TeamWorkService(
        store,
        () => backend,
        (runnerBackend) => new RuntimeSchedulerRunner((input) => runSchedulerTickWithSplitStore(store, runnerBackend, input))
      );

      const initialWork = await teamWork.work({
        teamId: team.id,
        goal: [
          "Recovery smoke setup task.",
          "Do not call complete_task yet.",
          "Do not send runtime messages yet.",
          "Wait for follow-up recovery instructions.",
          "Reply exactly: team-work-real-recovery-assigned"
        ].join("\n"),
        preferredMemberId: member.id,
        maxTicks: 1,
        includeDetails: true
      });
      const claimedState = await store.read();
      const claimedTask = initialWork.task ? claimedState.tasks[initialWork.task.id] : undefined;
      const brokenSession = Object.values(claimedState.agentSessions).find((candidate) => candidate.teamId === team.id && candidate.memberId === member.id);

      expect(initialWork.schedulerRun?.totalAssignments).toBe(1);
      expect(initialWork.runtime.status).toBe("running");
      expect(claimedTask).toMatchObject({
        status: "claimed",
        assignedMemberId: member.id
      });
      expect(brokenSession).toMatchObject({
        status: "working",
        currentTaskId: claimedTask!.id
      });

      await store.transaction((state) => {
        const storedSession = state.agentSessions[brokenSession!.id]!;
        storedSession.status = "error";
        storedSession.currentTaskId = claimedTask!.id;
        storedSession.errorMessage = "simulated runtime disconnect";
      });

      const recoveryGuidance = await teamWork.work({
        teamId: team.id,
        taskId: claimedTask!.id,
        autoRun: false,
        includeDetails: true
      });
      const blockedStatus = await callRegisteredTool(server, "team_status", { teamId: team.id }) as {
        result: {
          explain: {
            phase: string;
            headline: string;
            blockingReason?: string;
            recommendedNextAction: string;
          };
          compactStatus: {
            headline: string;
            supportingLine: string;
            nextAction: string;
          };
        };
      };
      const blockedResults = await callRegisteredTool(server, "team_results", { teamId: team.id }) as {
        result: {
          explain: {
            phase: string;
            headline: string;
            blockingReason?: string;
            recommendedNextAction: string;
          };
          compactResults: {
            headline: string;
            supportingLine: string;
          };
        };
      };

      expect(recoveryGuidance.task).toMatchObject({ id: claimedTask!.id, status: "claimed" });
      expect(recoveryGuidance.nextActions).toEqual(expect.arrayContaining([
        `Task ${claimedTask!.id} is still claimed but its session is error; recover or reassign the blocked work before continuing.`,
        "Inspect 1 error/stopped session holding or blocking work, then recover, retry, or reassign as needed."
      ]));
      expect(recoveryGuidance.nextPrompt).toContain("recover or reassign the blocked work");
      expect(blockedStatus.result.explain).toMatchObject({
        phase: "attention",
        headline: `Claimed task ${claimedTask!.id} is waiting on a error session.`,
        blockingReason: expect.stringContaining("is error"),
        recommendedNextAction: "Inspect the claimed task session, then recover or reassign the blocked work before continuing."
      });
      expect(blockedStatus.result.compactStatus).toMatchObject({
        headline: `Claimed task ${claimedTask!.id} is waiting on a error session.`,
        supportingLine: expect.stringContaining("is error"),
        nextAction: "Inspect the claimed task session, then recover or reassign the blocked work before continuing."
      });
      expect(blockedResults.result.explain).toMatchObject({
        phase: "attention",
        headline: `Claimed task ${claimedTask!.id} is waiting on a error session.`,
        blockingReason: expect.stringContaining("is error"),
        recommendedNextAction: "Inspect the claimed task session, then recover or reassign the blocked work before continuing."
      });
      expect(blockedResults.result.compactResults).toMatchObject({
        headline: `Claimed task ${claimedTask!.id} is waiting on a error session.`,
        supportingLine: expect.stringContaining("is error")
      });

      const recovered = await callRegisteredTool(server, "team_recover_sessions", {
        teamId: team.id,
        sessionIds: [brokenSession!.id],
        replaceSessions: true,
        reason: "simulated runtime disconnect"
      }) as {
        result: {
          recoveredSessions: Array<{ id: string; status: string; currentTaskId?: string }>;
          replacedSessions: Array<{ id: string; status: string; memberId: string; backendSessionId: string }>;
          releasedTasks: Array<{ id: string; status: string; assignedMemberId?: string }>;
          actions: Array<{ action: string; taskId?: string; sessionId?: string }>;
        };
      };

      expect(recovered.result.recoveredSessions).toEqual([expect.objectContaining({ id: brokenSession!.id, status: "stopped" })]);
      expect(recovered.result.recoveredSessions[0]).not.toHaveProperty("currentTaskId");
      expect(recovered.result.replacedSessions).toEqual([expect.objectContaining({
        status: "idle",
        memberId: member.id,
        backendSessionId: expect.any(String)
      })]);
      expect(recovered.result.replacedSessions[0]!.id).not.toBe(brokenSession!.id);
      expect(recovered.result.releasedTasks).toEqual([expect.objectContaining({ id: claimedTask!.id, status: "pending" })]);
      expect(recovered.result.releasedTasks[0]).not.toHaveProperty("assignedMemberId");
      expect(recovered.result.actions).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "released_claimed_task", taskId: claimedTask!.id, sessionId: brokenSession!.id }),
        expect.objectContaining({ action: "replaced_session" })
      ]));

      const retriedWork = await teamWork.work({
        teamId: team.id,
        taskId: claimedTask!.id,
        maxTicks: 1,
        includeDetails: true
      });
      const retriedState = await store.read();
      const retriedTask = retriedState.tasks[claimedTask!.id];
      const replacementSession = Object.values(retriedState.agentSessions).find((candidate) => candidate.id === recovered.result.replacedSessions[0]!.id);

      expect(retriedWork.schedulerRun?.totalAssignments).toBe(1);
      expect(retriedTask).toMatchObject({
        id: claimedTask!.id,
        status: "claimed",
        assignedMemberId: member.id
      });
      expect(replacementSession).toMatchObject({
        id: recovered.result.replacedSessions[0]!.id,
        status: "working",
        currentTaskId: claimedTask!.id
      });

      const completionPrompt = await backend.promptSession({
        backendSessionId: replacementSession!.backendSessionId!,
        prompt: [
          "Use only configured team_mcpv2 MCP tools for the recovery completion below.",
          `1. Call team_self_status with teamId=${team.id} and memberId=${member.id}.`,
          `2. Call complete_task with teamId=${team.id}, taskId=${claimedTask!.id}, memberId=${member.id}, completionSummary=team-work-real-recovery-complete, resultArtifacts=["recovery-retry"].`,
          "Reply exactly: team-work-real-recovery-done"
        ].join("\n")
      });
      const completionTick = await runSchedulerTickWithSplitStore(store, backend, { teamId: team.id });
      const finalState = await store.read();
      const finalTask = finalState.tasks[claimedTask!.id];
      const results = await callRegisteredTool(server, "team_results", { teamId: team.id }) as {
        result: {
          taskResults: Array<{ task: { id: string }; summary: string; artifacts: string[] }>;
          failuresNeedingAttention: unknown[];
          memberContributions: Array<{
            memberId: string;
            memberName: string;
            completedTaskIds: string[];
            latestContributionSummary?: string;
          }>;
          explain: { phase: string; headline: string; resultSummary: string };
        };
      };
      const status = await callRegisteredTool(server, "team_status", { teamId: team.id }) as {
        result: {
          runtime: { status: string };
          controlPlane: { taskBuckets: { completed: Array<{ id: string }>; runnable: Array<{ id: string }> }; nextActions: string[] };
          explain: { phase: string; headline: string; recommendedNextAction: string };
        };
      };

      expect(completionPrompt.summary).toContain("team-work-real-recovery-done");
      expect(completionTick.assignments).toEqual([]);
      expect(finalTask).toMatchObject({
        status: "completed",
        assignedMemberId: member.id,
        completionSummary: "team-work-real-recovery-complete",
        resultArtifacts: ["recovery-retry"]
      });
      expect(results.result.taskResults).toEqual(expect.arrayContaining([
        expect.objectContaining({
          task: expect.objectContaining({ id: claimedTask!.id }),
          summary: "team-work-real-recovery-complete",
          artifacts: ["recovery-retry"]
        })
      ]));
      expect(results.result.failuresNeedingAttention).toEqual([]);
      expect(results.result.memberContributions).toEqual([expect.objectContaining({
        memberId: member.id,
        memberName: "Recovery Worker",
        completedTaskIds: [claimedTask!.id],
        latestContributionSummary: "team-work-real-recovery-complete"
      })]);
      expect(results.result.explain).toMatchObject({
        phase: "running",
        headline: expect.stringContaining("Latest result from Recovery Worker:"),
        resultSummary: expect.stringContaining(`latest: ${claimedTask!.title} by Recovery Worker`)
      });
      expect(status.result.runtime.status).toBe("running");
      expect(status.result.controlPlane.taskBuckets.completed).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: claimedTask!.id })
      ]));
      expect(status.result.controlPlane.taskBuckets.runnable).toEqual([]);
      expect(status.result.explain).toMatchObject({
        phase: "running",
        headline: expect.any(String),
        recommendedNextAction: expect.any(String)
      });
      expect(finalState.events.map((event) => event.type)).toEqual(expect.arrayContaining([
        "task.created",
        "task.claimed",
        "task.completed",
        "session.recovered",
        "session.replaced",
        "scheduler.assignment",
        "scheduler.completion",
        "scheduler.tick"
      ]));
    } finally {
      await backend.stop();
    }
  }, 420000);

  it("resumes a paused real runtime through explicit team_work autoRun", async () => {
    const rootDir = await tempRoot();
    const storeHome = join(rootDir, ".team-mcp");
    await mkdir(storeHome, { recursive: true });

    const store = new JsonStore({ rootDir });
    const backend = new OpenCodeBackend({
      startupTimeoutMs: 30000,
      promptTimeoutMs: realPromptTimeoutMs,
      noReply: false,
      hostname: "127.0.0.1",
      port: await reservePort(),
      config: {
        ...realSmokeConfig(),
        mcp: {
          team_mcpv2: {
            type: "local",
            command: ["node", join(process.cwd(), "dist", "index.js")],
            enabled: true,
            timeout: 20000,
            environment: {
              TEAM_MCP_HOME: storeHome
            }
          }
        },
        tools: {
          "team_mcpv2_*": true
        },
        permission: {
          "team_mcpv2_*": "allow"
        }
      }
    });
    const server = registeredServer(store, () => backend);

    try {
      const started = await callRegisteredTool(server, "team_start", {
        teamName: "real paused runtime resume smoke"
      }) as { result: { team: { id: string } } };
      await callRegisteredTool(server, "team_draft", {
        teamId: started.result.team.id,
        name: "Pause Worker",
        model: realSmokeModel,
        rawResponsibility: "Resume paused runtime work carefully.",
        polishedPrompt: "Resume paused runtime work carefully through the active task card.",
        permissions: ["read", "edit"]
      });
      await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
      await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });

      await store.transaction(async (state) => {
        const runtime = new RuntimeService(state, backend);
        await runtime.start({ teamId: started.result.team.id, workdir: rootDir, maxParallel: 1 });
        runtime.pause({ teamId: started.result.team.id });
      });

      const setupState = await store.read();
      const member = Object.values(setupState.members).find((candidate) => candidate.teamId === started.result.team.id);
      expect(member).toMatchObject({
        teamId: started.result.team.id,
        name: "Pause Worker"
      });

      const teamWork = new TeamWorkService(
        store,
        () => backend,
        (runnerBackend) => new RuntimeSchedulerRunner((input) => runSchedulerTickWithSplitStore(store, runnerBackend, input))
      );

      const pausedGuidance = await teamWork.work({
        teamId: started.result.team.id,
        goal: [
          "Paused runtime resume smoke task.",
          "Do not complete the task.",
          "Wait for follow-up instructions.",
          "Reply exactly: team-work-real-paused-resume-assigned"
        ].join("\n"),
        autoRun: false,
        includeDetails: true
      });
      const pausedStatus = await callRegisteredTool(server, "team_status", { teamId: started.result.team.id }) as {
        result: {
          explain: {
            phase: string;
            headline: string;
            blockingReason?: string;
            recommendedNextAction: string;
          };
          compactStatus: {
            headline: string;
            supportingLine: string;
            nextAction: string;
          };
        };
      };
      const pausedResults = await callRegisteredTool(server, "team_results", { teamId: started.result.team.id }) as {
        result: {
          explain: {
            phase: string;
            headline: string;
            blockingReason?: string;
            recommendedNextAction: string;
          };
          compactResults: {
            headline: string;
            supportingLine: string;
          };
        };
      };

      expect(pausedGuidance.task).toMatchObject({
        title: "Paused runtime resume smoke task.",
        status: "pending"
      });
      expect(pausedGuidance.runtime.status).toBe("paused");
      expect(pausedGuidance.schedulerRun).toBeUndefined();
      expect(pausedGuidance.explain).toMatchObject({
        phase: "attention",
        headline: "Runtime is paused and waiting for manual follow-up.",
        blockingReason: "Scheduling is paused.",
        recommendedNextAction: "Resume the paused runtime manually when the team should continue scheduling work."
      });
      expect(pausedStatus.result.explain).toMatchObject({
        phase: "attention",
        headline: "Runtime is paused and waiting for manual follow-up.",
        blockingReason: "Scheduling is paused.",
        recommendedNextAction: "Resume the paused runtime manually when the team should continue scheduling work."
      });
      expect(pausedStatus.result.compactStatus).toMatchObject({
        headline: "Runtime is paused and waiting for manual follow-up.",
        supportingLine: "Scheduling is paused.",
        nextAction: "Resume the paused runtime manually when the team should continue scheduling work."
      });
      expect(pausedResults.result.explain).toMatchObject({
        phase: "attention",
        headline: "Runtime is paused and waiting for manual follow-up.",
        blockingReason: "Scheduling is paused.",
        recommendedNextAction: "Resume the paused runtime manually when the team should continue scheduling work."
      });
      expect(pausedResults.result.compactResults).toMatchObject({
        headline: "Runtime is paused and waiting for manual follow-up.",
        supportingLine: "Scheduling is paused."
      });

      const resumed = await teamWork.work({
        teamId: started.result.team.id,
        taskId: pausedGuidance.task!.id,
        autoRun: true,
        maxTicks: 1,
        includeDetails: true
      });
      const resumedState = await store.read();
      const resumedTask = resumed.task ? resumedState.tasks[resumed.task.id] : undefined;
      const session = Object.values(resumedState.agentSessions).find((candidate) => candidate.teamId === started.result.team.id);

      expect(resumed.runtime.status).toBe("running");
      expect(resumed.schedulerRun?.totalAssignments).toBe(1);
      expect(resumedTask).toMatchObject({
        id: resumed.task!.id,
        status: "claimed"
      });
      expect(session).toMatchObject({
        status: "working",
        currentTaskId: resumed.task!.id
      });
      expect(resumedState.schedulerStates[started.result.team.id]).toMatchObject({
        paused: false
      });
      expect(resumedState.events.map((event) => event.type)).toEqual(expect.arrayContaining([
        "runtime.paused",
        "runtime.resumed",
        "task.created",
        "task.claimed",
        "scheduler.assignment",
        "scheduler.tick"
      ]));
    } finally {
      await backend.stop();
    }
  }, 420000);
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "team-mcpv2-opencode-smoke-"));
  tempRoots.push(root);
  return root;
}

function realSmokeConfig() {
  return {
    model: realSmokeModel,
    small_model: realSmokeModel
  };
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to resolve ephemeral port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function registeredServer(store: JsonStore, backendFactory: () => OpenCodeBackend): McpServer {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server, store, { backendFactory, advancedTools: true });
  return server;
}

async function callRegisteredTool(server: McpServer, name: string, input: Record<string, unknown>): Promise<unknown> {
  const toolRegistry = server as unknown as { _registeredTools: Record<string, { handler: (toolInput: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> };
  const response = await toolRegistry._registeredTools[name]!.handler(input);
  const parsed = JSON.parse(response.content[0]!.text) as { ok?: boolean; error?: { message?: string } };
  if (parsed.ok === false) {
    throw new Error(parsed.error?.message ?? `Tool ${name} failed`);
  }
  return parsed as unknown;
}
