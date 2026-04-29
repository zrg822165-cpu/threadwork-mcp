import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { MailboxService } from "../src/services/mailboxService.js";
import { TaskService } from "../src/services/taskService.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { registerTools } from "../src/tools/registerTools.js";
import type { RegisterToolsOptions } from "../src/tools/registerTools.js";
import type { AgentBackend } from "../src/runtime/agentBackend.js";
import type { PromptSessionInput, PromptSessionResult, SpawnSessionInput, SpawnSessionResult } from "../src/runtime/types.js";

describe("team_work discussion flow", () => {
  it("stops bounded discussion progress when the thread reaches a host decision point", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new DiscussionDecisionBackend(store);
    const server = registeredServer(store, { backendFactory: () => backend });

    const started = await callRegisteredTool(server, "team_start", { teamName: "discussion stop" }) as { result: { team: { id: string } } };
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Author",
      model: "test/model",
      rawResponsibility: "Offer one implementation opinion.",
      polishedPrompt: "Offer one implementation opinion."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Reviewer",
      model: "test/model",
      rawResponsibility: "Offer one review opinion, then escalate if the host should decide.",
      polishedPrompt: "Offer one review opinion, then escalate if the host should decide."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });

    const worked = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      work: {
        discussion: {
          subject: "Architecture choice",
          body: "Each member should share one opinion and stop if host judgment is needed.",
          autoRun: true,
          maxTurns: 4
        }
      }
    }) as {
      result: {
        schedulerRun: { stoppedReason: string; ticksRun: number; totalAssignments: number; needsAttentionReason?: string };
        explain: { phase: string; headline: string; recommendedNextAction: string };
        nextPrompt: string;
        recommendedInput: {
          teamId: string;
          work: {
            autoRun: boolean;
            discussion: { subject: string; body: string; replyToMessageId: string };
          };
        };
        view: { summary: string };
      };
    };

    const status = await callRegisteredTool(server, "team_status", { teamId: started.result.team.id }) as {
      result: {
        explain: { headline: string; blockingReason?: string; recommendedNextAction: string };
        controlPlane: {
          inbox: {
            activeThreads: Array<{
              threadId: string;
              state: string;
              lifecycleState: string;
              currentRoundSummary: string;
              needsHostDecision: boolean;
              proposedNextAction: { kind: string; summary: string };
              unresolvedQuestionCount: number;
              latestMessage?: { id: string; type?: string; subject?: string };
            }>;
          };
        };
      };
    };

    expect(worked.result.schedulerRun).toMatchObject({
      stoppedReason: "needs_attention",
      ticksRun: 1,
      totalAssignments: 2,
      needsAttentionReason: 'Discussion "Architecture choice": A host escalation is holding the current round for judgment.'
    });
    expect(worked.result.explain).toMatchObject({
      phase: "attention",
      headline: 'Discussion "Architecture choice" is ready for a host decision.',
      recommendedNextAction: "Review the active discussion thread and decide how the team should proceed."
    });
    expect(worked.result.nextPrompt).toContain('discussion "Architecture choice"');
    expect(worked.result.view.summary).toContain("Current round reached a host decision point after 2 member responses.");
    expect(worked.result.view.summary).toContain("Attention: A host escalation is holding the current round for judgment.");
    expect(backend.prompts.join("\n")).toContain("Trigger: participant_obligation");
    expect(backend.prompts.join("\n")).toContain("Expected contribution: reply");
    expect(backend.prompts.join("\n")).toContain("Lifecycle: open");
    expect(backend.prompts.join("\n")).toContain("Required: yes");
    expect(worked.result.recommendedInput).toMatchObject({
      teamId: started.result.team.id,
      work: {
        autoRun: false,
        discussion: {
          subject: "Architecture choice",
          body: "Share the host decision and continue this team discussion."
        }
      }
    });
    expect(status.result.controlPlane.inbox.activeThreads[0]).toMatchObject({
      state: "ready_for_host",
      lifecycleState: "contested",
      currentRoundSummary: "Current round reached a host decision point after 2 member responses.",
      needsHostDecision: true,
      proposedNextAction: {
        kind: "host_decision",
        summary: "A host escalation is holding the current round for judgment."
      },
      unresolvedQuestionCount: 0,
      latestMessage: {
        type: "escalation",
        subject: "Need host review"
      }
    });
    expect(worked.result.recommendedInput.work.discussion.replyToMessageId).toBe(status.result.controlPlane.inbox.activeThreads[0]!.latestMessage!.id);
    expect(status.result.explain).toMatchObject({
      headline: 'Discussion "Architecture choice" is ready for a host decision.',
      recommendedNextAction: "Review the active discussion thread and decide how the team should proceed."
    });
  });

  it("lets the host post a structured decision into the same thread and resume member turns", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new DiscussionDecisionBackend(store);
    const server = registeredServer(store, { backendFactory: () => backend });

    const started = await callRegisteredTool(server, "team_start", { teamName: "discussion resume" }) as { result: { team: { id: string } } };
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Author",
      model: "test/model",
      rawResponsibility: "Offer one implementation opinion.",
      polishedPrompt: "Offer one implementation opinion."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Reviewer",
      model: "test/model",
      rawResponsibility: "Offer one review opinion, then escalate if the host should decide.",
      polishedPrompt: "Offer one review opinion, then escalate if the host should decide."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });

    const firstPass = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      work: {
        discussion: {
          subject: "Architecture choice",
          body: "Each member should share one opinion and stop if host judgment is needed.",
          autoRun: true,
          maxTurns: 4
        }
      }
    }) as {
      result: {
        recommendedInput: {
          teamId: string;
          work: {
            autoRun: boolean;
            discussion: {
              subject: string;
              replyToMessageId: string;
              hostDecision?: { decision: string; note?: string };
            };
          };
        };
      };
    };

    const resumed = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      work: {
        autoRun: true,
        discussion: {
          subject: firstPass.result.recommendedInput.work.discussion.subject,
          replyToMessageId: firstPass.result.recommendedInput.work.discussion.replyToMessageId,
          hostDecision: {
            decision: "Use the shared derived thread state and keep the thread moving in mailbox turns.",
            note: "Each member should briefly acknowledge the chosen direction."
          },
          maxTurns: 4
        }
      }
    }) as {
      result: {
        discussion: { id: string; threadId: string; body: string; type?: string };
        schedulerRun: { stoppedReason: string; ticksRun: number; totalAssignments: number };
        explain: { phase: string; headline: string; recommendedNextAction: string };
        view: { summary: string };
        recommendedInput: {
          work: {
            discussion: {
              subject: string;
              replyToMessageId: string;
              commitToTask: {
                title: string;
                description?: string;
              };
            };
            autoRun: boolean;
          };
        };
      };
    };

    const status = await callRegisteredTool(server, "team_status", { teamId: started.result.team.id }) as {
      result: {
        controlPlane: {
          inbox: {
            activeThreads: Array<{
              threadId: string;
              state: string;
              lifecycleState: string;
              actionabilityState: string;
              suggestedActionSummary: string;
              suggestedTaskTitle?: string;
              currentRoundSummary: string;
              needsHostDecision: boolean;
              proposedNextAction: { kind: string; summary: string };
              pendingMemberIds: string[];
              unresolvedQuestionCount: number;
              latestMessage?: { id: string; type?: string; subject?: string; body?: string };
              latestOpinions: Array<{ subject?: string; body: string }>;
            }>;
          };
        };
      };
    };

    expect(resumed.result.discussion).toMatchObject({
      type: "notification"
    });
    expect(resumed.result.discussion.body).toContain("Host decision:");
    expect(resumed.result.schedulerRun).toMatchObject({
      stoppedReason: "idle",
      totalAssignments: 2
    });
    expect(resumed.result.schedulerRun.ticksRun).toBeGreaterThanOrEqual(1);
    expect(resumed.result.explain).toMatchObject({
      phase: "running",
      headline: "0 active tasks; 0 runnable next."
    });
    expect(resumed.result.view.summary).toContain("Current round is settled with 2 member responses.");
    expect(backend.prompts.join("\n")).toContain("Trigger: host_decision_follow_through");
    expect(backend.prompts.join("\n")).toContain("Expected contribution: acknowledge_or_opinion");
    expect(backend.prompts.join("\n")).toContain("Required: yes");
    expect(status.result.controlPlane.inbox.activeThreads[0]).toMatchObject({
      threadId: resumed.result.discussion.threadId,
      state: "settled",
      lifecycleState: "settled",
      actionabilityState: "ready_for_task",
      suggestedActionSummary: "The discussion is settled and the latest host decision can be turned into task work.",
      suggestedTaskTitle: "Architecture choice",
      currentRoundSummary: "Current round is settled with 2 member responses.",
      needsHostDecision: false,
      proposedNextAction: {
        kind: "summarize_conclusion",
        summary: expect.stringContaining("Host decision:")
      },
      pendingMemberIds: [],
      unresolvedQuestionCount: 0,
      latestMessage: {
        type: "opinion"
      }
    });
    expect(status.result.controlPlane.inbox.activeThreads[0]!.latestOpinions).toHaveLength(2);
    expect(resumed.result.recommendedInput.work).toMatchObject({
      discussion: {
        subject: "Architecture choice",
        commitToTask: {
          title: "Architecture choice"
        }
      },
      autoRun: false
    });
  });

  it("lets the host explicitly commit a settled discussion into task work through team_work", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new DiscussionDecisionBackend(store);
    const server = registeredServer(store, { backendFactory: () => backend });

    const started = await callRegisteredTool(server, "team_start", { teamName: "discussion commit" }) as { result: { team: { id: string } } };
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Author",
      model: "test/model",
      rawResponsibility: "Offer one implementation opinion.",
      polishedPrompt: "Offer one implementation opinion."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Reviewer",
      model: "test/model",
      rawResponsibility: "Offer one review opinion, then escalate if the host should decide.",
      polishedPrompt: "Offer one review opinion, then escalate if the host should decide."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });

    const firstPass = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      work: {
        discussion: {
          subject: "Architecture choice",
          body: "Each member should share one opinion and stop if host judgment is needed.",
          autoRun: true,
          maxTurns: 4
        }
      }
    }) as {
      result: {
        recommendedInput: {
          work: {
            discussion: {
              subject: string;
              replyToMessageId: string;
            };
          };
        };
      };
    };

    const settled = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      work: {
        autoRun: true,
        discussion: {
          subject: firstPass.result.recommendedInput.work.discussion.subject,
          replyToMessageId: firstPass.result.recommendedInput.work.discussion.replyToMessageId,
          hostDecision: {
            decision: "Use the shared derived thread state and keep the thread moving in mailbox turns.",
            note: "Each member should briefly acknowledge the chosen direction."
          },
          maxTurns: 4
        }
      }
    }) as {
      result: {
        recommendedInput: {
          teamId: string;
          work: {
            autoRun: boolean;
            discussion: {
              subject: string;
              replyToMessageId: string;
              commitToTask: {
                title: string;
                description?: string;
              };
            };
          };
        };
      };
    };

    const committed = await callRegisteredTool(server, "team_work", settled.result.recommendedInput) as {
      result: {
        task: { id: string; title: string; description?: string; status: string };
        discussion: { id: string; threadId: string; type?: string; body: string; taskId?: string };
        nextPrompt: string;
        recommendedInput: {
          work: {
            taskId: string;
            autoRun: boolean;
          };
        };
      };
    };

    const status = await callRegisteredTool(server, "team_status", { teamId: started.result.team.id }) as {
      result: {
        compactStatus: {
          discussion?: {
            committedTaskId?: string;
            committedTaskTitle?: string;
            closureReason?: string;
            closedTaskId?: string;
            lifecycleState?: string;
            actionabilityState: string;
            nextTurns?: unknown[];
          };
          supportingLine: string;
          nextAction: string;
        };
        controlPlane: {
          taskBuckets: {
            pending: Array<{ id: string; title: string }>;
          };
          inbox: {
            activeThreads: Array<{
              threadId: string;
              taskId?: string;
              committedTaskId?: string;
              committedTaskTitle?: string;
              commitMessageId?: string;
              closureReason?: string;
              closedTaskId?: string;
              state: string;
              lifecycleState: string;
              proposedNextAction: { kind: string; summary?: string };
              nextTurns: unknown[];
              actionabilityState: string;
              suggestedActionSummary: string;
              latestMessage?: { id: string; type?: string; body?: string };
            }>;
          };
        };
      };
    };
    const results = await callRegisteredTool(server, "team_results", { teamId: started.result.team.id }) as {
      result: {
        compactResults: {
          latestDiscussion?: {
            committedTaskId?: string;
            committedTaskTitle?: string;
            closureReason?: string;
            closedTaskId?: string;
            lifecycleState?: string;
            actionabilityState: string;
            nextTurns?: unknown[];
          };
          supportingLine: string;
        };
        discussionThreads: Array<{
          committedTaskId?: string;
          committedTaskTitle?: string;
          closureReason?: string;
          closedTaskId?: string;
          lifecycleState: string;
          state: string;
          actionabilityState: string;
          suggestedActionSummary: string;
          proposedNextAction: { kind: string };
          nextTurns: unknown[];
        }>;
      };
    };
    const timeline = await callRegisteredTool(server, "team_timeline", { teamId: started.result.team.id }) as {
      result: {
        discussionThreads: Array<{
          committedTaskId?: string;
          committedTaskTitle?: string;
          closureReason?: string;
          closedTaskId?: string;
          lifecycleState: string;
          state: string;
          actionabilityState: string;
        }>;
      };
    };

    expect(committed.result.task).toMatchObject({
      title: "Architecture choice",
      status: "pending"
    });
    expect(committed.result.discussion).toMatchObject({
      type: "notification",
      taskId: committed.result.task.id
    });
    expect(committed.result.discussion.body).toContain("Host committed task:");
    expect(committed.result.nextPrompt).toContain(`task ${committed.result.task.id}`);
    expect(committed.result.recommendedInput.work).toMatchObject({
      taskId: committed.result.task.id,
      autoRun: false
    });
    expect(committed.result.recommendedInput.work).not.toHaveProperty("discussion");
    expect(status.result.controlPlane.taskBuckets.pending).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: committed.result.task.id,
        title: "Architecture choice"
      })
    ]));
    expect(status.result.controlPlane.inbox.activeThreads[0]).toMatchObject({
      threadId: committed.result.discussion.threadId,
      taskId: committed.result.task.id,
      committedTaskId: committed.result.task.id,
      committedTaskTitle: "Architecture choice",
      commitMessageId: committed.result.discussion.id,
      closureReason: "committed_to_task",
      closedTaskId: committed.result.task.id,
      state: "closed",
      lifecycleState: "closed",
      proposedNextAction: {
        kind: "none"
      },
      nextTurns: [],
      actionabilityState: "none",
      suggestedActionSummary: `This discussion has already produced follow-up task ${committed.result.task.id}.`,
      latestMessage: {
        id: committed.result.discussion.id,
        type: "notification",
        body: expect.stringContaining("Host committed task:")
      }
    });
    expect(status.result.compactStatus.discussion).toMatchObject({
      committedTaskId: committed.result.task.id,
      committedTaskTitle: "Architecture choice",
      closureReason: "committed_to_task",
      closedTaskId: committed.result.task.id,
      lifecycleState: "closed",
      actionabilityState: "none"
    });
    expect(status.result.compactStatus.supportingLine).toBe(`This discussion has already produced follow-up task ${committed.result.task.id}.`);
    expect(status.result.compactStatus.nextAction).toContain(`task ${committed.result.task.id}`);
    expect(results.result.discussionThreads[0]).toMatchObject({
      committedTaskId: committed.result.task.id,
      committedTaskTitle: "Architecture choice",
      closureReason: "committed_to_task",
      closedTaskId: committed.result.task.id,
      lifecycleState: "closed",
      actionabilityState: "none",
      proposedNextAction: {
        kind: "none"
      },
      nextTurns: [],
      suggestedActionSummary: `This discussion has already produced follow-up task ${committed.result.task.id}.`
    });
    expect(results.result.compactResults.latestDiscussion).toMatchObject({
      committedTaskId: committed.result.task.id,
      committedTaskTitle: "Architecture choice",
      closureReason: "committed_to_task",
      closedTaskId: committed.result.task.id,
      lifecycleState: "closed",
      actionabilityState: "none"
    });
    expect(results.result.compactResults.supportingLine).toEqual(expect.any(String));
    expect(timeline.result.discussionThreads[0]).toMatchObject({
      committedTaskId: committed.result.task.id,
      committedTaskTitle: "Architecture choice",
      closureReason: "committed_to_task",
      closedTaskId: committed.result.task.id,
      lifecycleState: "closed",
      state: "closed",
      actionabilityState: "none"
    });
  });

  it("inherits task-scoped commit defaults when work fields are omitted", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new DiscussionDecisionBackend(store);
    const server = registeredServer(store, { backendFactory: () => backend });

    const started = await callRegisteredTool(server, "team_start", { teamName: "commit defaults" }) as { result: { team: { id: string } } };
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Author",
      model: "test/model",
      rawResponsibility: "Offer one implementation opinion.",
      polishedPrompt: "Offer one implementation opinion."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Reviewer",
      model: "test/model",
      rawResponsibility: "Offer one review opinion, then escalate if the host should decide.",
      polishedPrompt: "Offer one review opinion, then escalate if the host should decide."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });

    const members = Object.values((await store.read()).members).filter((member) => member.teamId === started.result.team.id);
    const author = members.find((member) => member.name === "Author")!;
    const source = await callRegisteredTool(server, "team_task_create", {
      teamId: started.result.team.id,
      title: "Source scoped task",
      pathHints: ["src/runtime/source.ts"],
      preferredMemberId: author.id,
      priority: "medium"
    }) as { result: { id: string } };

    const firstPass = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      work: {
        discussion: {
          taskId: source.result.id,
          subject: "Scoped handoff",
          body: "Each member should share one opinion and stop if host judgment is needed.",
          autoRun: true,
          maxTurns: 4
        }
      }
    }) as {
      result: {
        recommendedInput: {
          work: {
            discussion: {
              subject: string;
              replyToMessageId: string;
            };
          };
        };
      };
    };
    const inheritedSettled = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      work: {
        autoRun: true,
        discussion: {
          subject: firstPass.result.recommendedInput.work.discussion.subject,
          replyToMessageId: firstPass.result.recommendedInput.work.discussion.replyToMessageId,
          hostDecision: {
            decision: "Carry the scoped execution context into the follow-up task.",
            note: "This should be a natural handoff from discussion to work."
          },
          maxTurns: 4
        }
      }
    }) as {
      result: {
        recommendedInput: {
          teamId: string;
          work: {
            autoRun: boolean;
            discussion: {
              subject: string;
              replyToMessageId: string;
              commitToTask: {
                title: string;
                description?: string;
              };
            };
          };
        };
      };
    };
    const inherited = await callRegisteredTool(server, "team_work", inheritedSettled.result.recommendedInput) as {
      result: {
        task: { id: string; pathHints: string[]; preferredMemberId?: string; priority?: string };
        recommendedInput: { work: { taskId: string; autoRun: boolean; discussion?: unknown } };
      };
    };

    expect(inherited.result.task).toMatchObject({
      pathHints: ["src/runtime/source.ts"],
      preferredMemberId: author.id,
      priority: "medium"
    });
    expect(inherited.result.recommendedInput.work).toMatchObject({
      taskId: inherited.result.task.id,
      autoRun: false
    });
    expect(inherited.result.recommendedInput.work.discussion).toBeUndefined();
  });

  it("uses explicit work defaults before inherited task-scoped commit defaults", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new DiscussionDecisionBackend(store);
    const server = registeredServer(store, { backendFactory: () => backend });

    const started = await callRegisteredTool(server, "team_start", { teamName: "commit override defaults" }) as { result: { team: { id: string } } };
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Author",
      model: "test/model",
      rawResponsibility: "Offer one implementation opinion.",
      polishedPrompt: "Offer one implementation opinion."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Reviewer",
      model: "test/model",
      rawResponsibility: "Offer one review opinion.",
      polishedPrompt: "Offer one review opinion."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });

    const members = Object.values((await store.read()).members).filter((member) => member.teamId === started.result.team.id);
    const author = members.find((member) => member.name === "Author")!;
    const reviewer = members.find((member) => member.name === "Reviewer")!;
    const source = await callRegisteredTool(server, "team_task_create", {
      teamId: started.result.team.id,
      title: "Override source task",
      pathHints: ["src/runtime/inherited.ts"],
      preferredMemberId: author.id,
      priority: "low"
    }) as { result: { id: string } };

    const thread = await store.transaction((state) => {
      const mailbox = new MailboxService(state);
      const root = mailbox.sendMessage({
        teamId: started.result.team.id,
        taskId: source.result.id,
        type: "question",
        subject: "Override scoped handoff",
        body: "Share a final opinion before committing follow-up work.",
        participantMemberIds: [author.id, reviewer.id]
      });
      const authorOpinion = mailbox.sendMessage({
        teamId: started.result.team.id,
        fromMemberId: author.id,
        type: "opinion",
        subject: "Author settled",
        body: "The follow-up can be implemented now.",
        replyToMessageId: root.id
      });
      const reviewerOpinion = mailbox.sendMessage({
        teamId: started.result.team.id,
        fromMemberId: reviewer.id,
        type: "opinion",
        subject: "Reviewer settled",
        body: "Use the explicit handoff fields.",
        replyToMessageId: authorOpinion.id
      });
      mailbox.ackMessage({ teamId: started.result.team.id, messageId: root.id, memberId: author.id });
      mailbox.ackMessage({ teamId: started.result.team.id, messageId: root.id, memberId: reviewer.id });
      return { replyToMessageId: reviewerOpinion.id };
    });

    const committed = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      work: {
        pathHints: [],
        preferredMemberId: reviewer.id,
        priority: "high",
        discussion: {
          subject: "Override scoped handoff",
          replyToMessageId: thread.replyToMessageId,
          commitToTask: {
            title: "Explicit override follow-up",
            description: "Use the explicitly supplied execution defaults."
          }
        }
      }
    }) as {
      result: {
        task: { id: string; title: string; pathHints: string[]; preferredMemberId?: string; priority?: string };
        recommendedInput: { work: { taskId: string; autoRun: boolean; discussion?: unknown } };
      };
    };

    expect(committed.result.task).toMatchObject({
      title: "Explicit override follow-up",
      pathHints: [],
      preferredMemberId: reviewer.id,
      priority: "high"
    });
    expect(committed.result.recommendedInput.work.autoRun).toBe(false);
    expect(committed.result.recommendedInput.work.discussion).toBeUndefined();
  });

  it("guides the host to start runtime sessions when a waiting discussion round exists but autoRun is off", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new DiscussionDecisionBackend(store);
    const server = registeredServer(store, { backendFactory: () => backend });

    const started = await callRegisteredTool(server, "team_start", { teamName: "discussion waiting" }) as { result: { team: { id: string } } };
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Author",
      model: "test/model",
      rawResponsibility: "Offer one implementation opinion.",
      polishedPrompt: "Offer one implementation opinion."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Reviewer",
      model: "test/model",
      rawResponsibility: "Offer one review opinion.",
      polishedPrompt: "Offer one review opinion."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });

    const worked = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      work: {
        discussion: {
          subject: "Architecture choice",
          body: "Each member should share one opinion.",
          autoRun: false,
          maxTurns: 4
        }
      }
    }) as {
      result: {
        schedulerRun?: unknown;
        explain: { phase: string; headline: string; recommendedNextAction: string };
        nextActions: string[];
        nextPrompt: string;
        view: { summary: string };
        recommendedInput: { work: { autoRun: boolean } };
      };
    };

    expect(worked.result.schedulerRun).toBeUndefined();
    expect(worked.result.explain).toMatchObject({
      phase: "ready",
      headline: "Runtime is ready, but work is not running yet.",
      recommendedNextAction: "Continue with team_work to start runtime-managed teammate sessions and collect pending member responses."
    });
    expect(worked.result.nextActions[0]).toBe("Continue with team_work to start runtime-managed teammate sessions and collect pending member responses.");
    expect(worked.result.nextPrompt).toContain("start runtime-managed teammate sessions and collect pending member responses");
    expect(worked.result.view.summary).toContain("Current round started with the host question and is waiting for 2 member responses.");
    expect(worked.result.recommendedInput.work.autoRun).toBe(false);
  });

  it("keeps bounded discussion progress alive long enough to absorb in-flight member replies", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new DelayedDiscussionBackend(store);
    const server = registeredServer(store, { backendFactory: () => backend });

    const started = await callRegisteredTool(server, "team_start", { teamName: "discussion delayed" }) as { result: { team: { id: string } } };
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Author",
      model: "test/model",
      rawResponsibility: "Reply quickly.",
      polishedPrompt: "Reply quickly."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Reviewer",
      model: "test/model",
      rawResponsibility: "Reply after a short delay.",
      polishedPrompt: "Reply after a short delay."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });

    const worked = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      work: {
        background: { timeoutMs: 200 },
        discussion: {
          subject: "Architecture choice",
          body: "Each member should share one opinion.",
          autoRun: true,
          maxTurns: 6
        }
      }
    }) as {
      result: {
        schedulerRun: { stoppedReason: string; ticksRun: number; totalAssignments: number };
        view: { summary: string };
      };
    };

    const status = await callRegisteredTool(server, "team_status", { teamId: started.result.team.id }) as {
      result: {
        controlPlane: {
          inbox: {
            activeThreads: Array<{
              state: string;
              lifecycleState: string;
              currentRoundSummary: string;
              pendingMemberIds: string[];
            }>;
          };
        };
      };
    };

    expect(worked.result.schedulerRun).toMatchObject({
      stoppedReason: "idle",
      totalAssignments: 2
    });
    expect(worked.result.schedulerRun.ticksRun).toBeGreaterThan(2);
    expect(worked.result.view.summary).toContain("Current round is settled with 2 member responses.");
    expect(status.result.controlPlane.inbox.activeThreads[0]).toMatchObject({
      state: "settled",
      lifecycleState: "settled",
      currentRoundSummary: "Current round is settled with 2 member responses.",
      pendingMemberIds: []
    });
  });

  it("shows active async conversation turns in team_status while a member is still handling a discussion message", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new WaitingReviewerDiscussionBackend(store);
    const server = registeredServer(store, { backendFactory: () => backend });

    const started = await callRegisteredTool(server, "team_start", { teamName: "discussion visible waiting" }) as { result: { team: { id: string } } };
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Author",
      model: "test/model",
      rawResponsibility: "Reply quickly.",
      polishedPrompt: "Reply quickly."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Reviewer",
      model: "test/model",
      rawResponsibility: "Reply after extra thinking time.",
      polishedPrompt: "Reply after extra thinking time."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_run", {
      teamId: started.result.team.id,
      maxParallel: 2
    });

    await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      work: {
        discussion: {
          subject: "Architecture choice",
          body: "Each member should share one opinion.",
          autoRun: true,
          maxTurns: 1
        }
      }
    });

    const status = await callRegisteredTool(server, "team_status", { teamId: started.result.team.id }) as {
      result: {
        explain: { headline: string };
        controlPlane: {
          inbox: {
            activeConversationTurns: Array<{
              memberId: string;
              memberName?: string;
              messageId: string;
              threadId: string;
              trigger?: string;
              priorityScore?: number;
            }>;
            activeThreads: Array<{
              state: string;
              lifecycleState: string;
              pendingMemberIds: string[];
            }>;
          };
        };
      };
    };

    expect(status.result.explain.headline).toBe('Discussion "Architecture choice" is waiting for 1 member response.');
    expect(status.result.controlPlane.inbox.activeConversationTurns).toEqual([
      expect.objectContaining({
        memberName: "Reviewer",
        trigger: "participant_obligation",
        priorityScore: 300
      })
    ]);
    expect(status.result.controlPlane.inbox.activeThreads[0]).toMatchObject({
      state: "waiting_for_members",
      lifecycleState: "collecting",
      pendingMemberIds: expect.arrayContaining([expect.any(String)])
    });
  });

  it("can invite a relevant non-participant into an active discussion thread", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new InvitedPlannerDiscussionBackend(store);
    const server = registeredServer(store, { backendFactory: () => backend });

    const started = await callRegisteredTool(server, "team_start", { teamName: "discussion invite" }) as { result: { team: { id: string } } };
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Author",
      model: "test/model",
      rawResponsibility: "Reply quickly.",
      polishedPrompt: "Reply quickly."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Reviewer",
      model: "test/model",
      rawResponsibility: "Reply after extra thinking time.",
      polishedPrompt: "Reply after extra thinking time."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Planner",
      model: "test/model",
      rawResponsibility: "Join field-list discussion when relevant.",
      polishedPrompt: "Join field-list discussion when relevant.",
      callWhen: ["field list", "thread summary"]
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_run", {
      teamId: started.result.team.id,
      maxParallel: 3
    });
    const memberState = await store.read();
    const authorId = Object.values(memberState.members).find((member) => member.teamId === started.result.team.id && member.name === "Author")!.id;
    const reviewerId = Object.values(memberState.members).find((member) => member.teamId === started.result.team.id && member.name === "Reviewer")!.id;

    const worked = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      work: {
        discussion: {
          subject: "Field list discussion",
          body: "Review the thread summary field list.",
          participantMemberIds: [authorId, reviewerId],
          autoRun: true,
          maxTurns: 3
        }
      }
    }) as {
      result: {
        schedulerRun: { stoppedReason: string; ticksRun: number; totalAssignments: number };
      };
    };

    const status = await callRegisteredTool(server, "team_status", { teamId: started.result.team.id }) as {
      result: {
        controlPlane: {
          inbox: {
            activeConversationTurns: Array<{
              memberName?: string;
              kind?: string;
              priorityScore?: number;
            }>;
            activeThreads: Array<{
              lifecycleState: string;
              pendingMemberIds: string[];
              owedMemberIds: string[];
              invitedMemberIds: string[];
              turnTakingState: string;
              nextResponsibleMemberNames: string[];
              turnObligations: Array<{
                memberId: string;
                kind: string;
                trigger?: string;
                required: boolean;
                priorityScore: number;
              }>;
              nextTurns: Array<{
                kind: string;
                trigger: string;
                required: boolean;
                priorityScore: number;
                expectedContribution: string;
              }>;
              latestOpinions: Array<{ body: string }>;
            }>;
          };
        };
      };
    };

    expect(worked.result.schedulerRun.totalAssignments).toBeGreaterThanOrEqual(3);
    expect(status.result.controlPlane.inbox.activeConversationTurns).toEqual(expect.arrayContaining([
      expect.objectContaining({
        memberName: "Reviewer",
        kind: "participant_reply",
        priorityScore: 300
      })
    ]));
    expect(status.result.controlPlane.inbox.activeThreads[0]).toMatchObject({
      lifecycleState: "collecting",
      turnTakingState: "waiting_required",
      nextResponsibleMemberNames: ["Reviewer"],
      pendingMemberIds: expect.arrayContaining([expect.any(String)]),
      owedMemberIds: expect.arrayContaining([expect.any(String)])
    });
    expect(status.result.controlPlane.inbox.activeThreads[0]!.turnObligations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "participant_reply",
        trigger: "participant_obligation",
        required: true,
        priorityScore: 300
      })
    ]));
    expect(status.result.controlPlane.inbox.activeThreads[0]!.nextTurns).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "participant_reply",
        trigger: "participant_obligation",
        required: true,
        priorityScore: 300,
        expectedContribution: "reply"
      })
    ]));
    expect(status.result.controlPlane.inbox.activeThreads[0]!.latestOpinions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        body: "Planner note: the thread summary should stay compact."
      })
    ]));
  });

  it("keeps one next step across the full discussion-to-review dogfood loop", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new TaskReviewBackend(store);
    const server = registeredServer(store, { backendFactory: () => backend });

    const started = await callRegisteredTool(server, "team_start", { teamName: "full dogfood loop" }) as { result: { team: { id: string } } };
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Author",
      model: "test/model",
      rawResponsibility: "Implement scoped runtime changes.",
      polishedPrompt: "Implement scoped runtime changes."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Reviewer",
      model: "test/model",
      rawResponsibility: "Review quality, test coverage, and follow-up risk.",
      polishedPrompt: "Review quality, test coverage, and follow-up risk."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });

    const settled = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      work: {
        discussion: {
          subject: "Dogfood handoff",
          body: "Discuss the next implementation slice, then settle into executable work.",
          autoRun: true,
          maxTurns: 4
        },
        includeDetails: true
      }
    }) as {
      result: {
        recommendedInput: {
          teamId: string;
          work: {
            autoRun: boolean;
            discussion: {
              subject: string;
              replyToMessageId: string;
              commitToTask: { title: string; description?: string };
            };
          };
        };
      };
    };

    expectSingleRecommendedWorkStep(settled.result.recommendedInput.work, "discussion");
    expect(settled.result.recommendedInput.work.discussion.commitToTask).toBeDefined();

    const committed = await callRegisteredTool(server, "team_work", settled.result.recommendedInput) as {
      result: {
        task: { id: string; title: string };
        recommendedInput: { work: { taskId: string; autoRun: boolean; discussion?: unknown } };
      };
    };

    expectSingleRecommendedWorkStep(committed.result.recommendedInput.work, "taskId");
    expect(committed.result.recommendedInput.work).toMatchObject({
      taskId: committed.result.task.id,
      autoRun: false
    });
    expect(committed.result.recommendedInput.work.discussion).toBeUndefined();

    const completed = await store.transaction((state) => {
      const author = Object.values(state.members).find((member) => member.teamId === started.result.team.id && member.name === "Author")!;
      const tasks = new TaskService(state);
      tasks.claimTask({ teamId: started.result.team.id, taskId: committed.result.task.id, memberId: author.id });
      tasks.completeTask({
        teamId: started.result.team.id,
        taskId: committed.result.task.id,
        memberId: author.id,
        completionSummary: "Implemented the dogfood handoff slice.",
        resultArtifacts: ["src/runtime/teamWork.ts"]
      });
      return { authorId: author.id };
    });

    const reviewRecommended = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      work: {
        taskId: committed.result.task.id,
        autoRun: false,
        includeDetails: true
      }
    }) as {
      result: {
        details: {
          results: {
            taskResults: Array<{
              task: { id: string };
              review: { reviewState: string; reviewerMemberIds: string[]; reviewActionSummary?: string };
            }>;
          };
        };
        recommendedInput: {
          work: {
            taskId?: string;
            autoRun?: boolean;
            includeDetails?: boolean;
            discussion?: {
              subject: string;
              taskId: string;
              participantMemberIds: string[];
              autoRun: boolean;
            };
          };
        };
      };
    };

    const sourceReview = reviewRecommended.result.details.results.taskResults.find((result) => result.task.id === committed.result.task.id)?.review;
    expect(sourceReview).toMatchObject({
      reviewState: "review_recommended",
      reviewActionSummary: expect.stringContaining("Reviewer")
    });
    expect(sourceReview!.reviewerMemberIds).not.toContain(completed.authorId);
    expectSingleRecommendedWorkStep(reviewRecommended.result.recommendedInput.work, "discussion");
    expect(reviewRecommended.result.recommendedInput.work).toMatchObject({
      discussion: {
        subject: `Task review: ${committed.result.task.id}`,
        taskId: committed.result.task.id,
        autoRun: true
      }
    });

    const reviewed = await callRegisteredTool(server, "team_work", reviewRecommended.result.recommendedInput) as {
      result: {
        nextActions: string[];
        recommendedInput: {
          work: {
            taskId?: string;
            autoRun: boolean;
            includeDetails?: boolean;
            discussion?: {
              subject: string;
              replyToMessageId: string;
              commitToTask: { title: string; description?: string };
            };
          };
        };
        details: {
          results: {
            taskResults: Array<{
              task: { id: string };
              review: { reviewState: string; reviewThreadId?: string; reviewActionSummary?: string };
            }>;
          };
        };
      };
    };

    expect(backend.prompts.join("\n")).toContain(`Subject: Task review: ${committed.result.task.id}`);
    expect(backend.prompts.join("\n")).toContain("Reason:");
    expect(backend.prompts.join("\n")).toContain("Expected contribution: reply");
    expect(reviewed.result.details.results.taskResults.find((result) => result.task.id === committed.result.task.id)?.review).toMatchObject({
      reviewState: "review_settled",
      reviewActionSummary: expect.stringContaining("follow-up")
    });
    expect(reviewed.result.nextActions[0]).toContain("commit follow-up task work");
    expectSingleRecommendedWorkStep(reviewed.result.recommendedInput.work, "discussion");
    expect(reviewed.result.recommendedInput.work.discussion).toMatchObject({
      subject: `Task review: ${committed.result.task.id}`,
      commitToTask: {
        title: `Follow up on Task review: ${committed.result.task.id}`
      }
    });

    const followUp = await callRegisteredTool(server, "team_work", reviewed.result.recommendedInput) as {
      result: {
        task: { id: string };
        recommendedInput: { work: { taskId: string; autoRun: boolean; discussion?: unknown } };
        details: {
          results: {
            taskResults: Array<{
              task: { id: string };
              review: { reviewState: string; followUpTaskId?: string };
            }>;
          };
          timeline: {
            taskThreads: Array<{
              task: { id: string };
              review?: { reviewState: string; followUpTaskId?: string };
            }>;
          };
        };
      };
    };

    expectSingleRecommendedWorkStep(followUp.result.recommendedInput.work, "taskId");
    expect(followUp.result.recommendedInput.work).toMatchObject({
      taskId: followUp.result.task.id,
      autoRun: false
    });
    expect(followUp.result.recommendedInput.work.discussion).toBeUndefined();
    expect(followUp.result.details.results.taskResults.find((result) => result.task.id === committed.result.task.id)?.review).toMatchObject({
      reviewState: "follow_up_created",
      followUpTaskId: followUp.result.task.id
    });
    expect(followUp.result.details.timeline.taskThreads.find((thread) => thread.task.id === committed.result.task.id)?.review).toMatchObject({
      reviewState: "follow_up_created",
      followUpTaskId: followUp.result.task.id
    });
  });

  it("recommends a review discussion for a completed task and carries review follow-up through commit", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new TaskReviewBackend(store);
    const server = registeredServer(store, { backendFactory: () => backend });

    const started = await callRegisteredTool(server, "team_start", { teamName: "task review loop" }) as { result: { team: { id: string } } };
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Implementer",
      model: "test/model",
      rawResponsibility: "Implement scoped runtime changes.",
      polishedPrompt: "Implement scoped runtime changes."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Reviewer",
      model: "test/model",
      rawResponsibility: "Review completed changes for quality, risk, validation, and follow-up needs.",
      polishedPrompt: "Review completed changes for quality, risk, validation, and follow-up needs."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });

    const setup = await store.transaction((state) => {
      const implementer = Object.values(state.members).find((member) => member.teamId === started.result.team.id && member.name === "Implementer")!;
      const reviewer = Object.values(state.members).find((member) => member.teamId === started.result.team.id && member.name === "Reviewer")!;
      const tasks = new TaskService(state);
      const task = tasks.createTask({
        teamId: started.result.team.id,
        title: "Implement task review loop",
        description: "Wire completed task review into team_work.",
        pathHints: ["src/runtime/teamWork.ts"],
        preferredMemberId: implementer.id
      });
      tasks.claimTask({ teamId: started.result.team.id, taskId: task.id, memberId: implementer.id });
      tasks.completeTask({
        teamId: started.result.team.id,
        taskId: task.id,
        memberId: implementer.id,
        completionSummary: "Implemented the handoff surface.",
        resultArtifacts: ["src/runtime/teamWork.ts"]
      });
      return { taskId: task.id, reviewerId: reviewer.id };
    });

    const recommended = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      work: {
        taskId: setup.taskId,
        autoRun: false,
        includeDetails: true
      }
    }) as {
      result: {
        details: {
          results: {
            taskResults: Array<{
              task: { id: string };
              review: { reviewState: string; reviewerMemberIds: string[]; reviewActionSummary?: string };
            }>;
          };
          timeline: {
            taskThreads: Array<{
              task: { id: string };
              review?: { reviewState: string; reviewerMemberIds: string[] };
            }>;
          };
        };
        recommendedInput: {
          teamId: string;
          work: {
            autoRun?: boolean;
            discussion?: {
              subject: string;
              body: string;
              taskId: string;
              participantMemberIds: string[];
              autoRun: boolean;
            };
          };
        };
      };
    };

    expect(recommended.result.details.results.taskResults.find((result) => result.task.id === setup.taskId)?.review).toMatchObject({
      reviewState: "review_recommended",
      reviewerMemberIds: [setup.reviewerId],
      reviewActionSummary: expect.stringContaining("Reviewer")
    });
    expect(recommended.result.details.timeline.taskThreads.find((thread) => thread.task.id === setup.taskId)?.review).toMatchObject({
      reviewState: "review_recommended",
      reviewerMemberIds: [setup.reviewerId]
    });
    expect(recommended.result.recommendedInput.work).toMatchObject({
      discussion: {
        subject: `Task review: ${setup.taskId}`,
        taskId: setup.taskId,
        participantMemberIds: [setup.reviewerId],
        autoRun: true
      }
    });
    expect(recommended.result.recommendedInput.work.discussion!.body).toContain("accept, concern, question, or follow-up recommendation");
    expect(recommended.result.recommendedInput.work).not.toHaveProperty("goal");

    const reviewed = await callRegisteredTool(server, "team_work", recommended.result.recommendedInput) as {
      result: {
        details: {
          results: {
            taskResults: Array<{
              task: { id: string };
              review: { reviewState: string; reviewThreadId?: string };
            }>;
          };
        };
        recommendedInput: {
          teamId: string;
          work: {
            autoRun: boolean;
            discussion: {
              subject: string;
              replyToMessageId: string;
              commitToTask: { title: string; description?: string };
            };
          };
        };
      };
    };

    expect(backend.prompts.join("\n")).toContain(`Subject: Task review: ${setup.taskId}`);
    expect(backend.prompts.join("\n")).toContain(`taskId=${setup.taskId}`);
    expect(backend.prompts.join("\n")).toContain("Trigger: participant_obligation");
    expect(backend.prompts.join("\n")).toContain("Expected contribution: reply");
    expect(reviewed.result.details.results.taskResults.find((result) => result.task.id === setup.taskId)?.review).toMatchObject({
      reviewState: "review_settled",
      reviewThreadId: expect.any(String)
    });
    expect(reviewed.result.recommendedInput.work).toMatchObject({
      autoRun: false,
      discussion: {
        subject: `Task review: ${setup.taskId}`,
        commitToTask: {
          title: `Follow up on Task review: ${setup.taskId}`
        }
      }
    });

    const committed = await callRegisteredTool(server, "team_work", reviewed.result.recommendedInput) as {
      result: {
        task: { id: string; title: string };
        recommendedInput: { work: { taskId: string; autoRun: boolean } };
        details: {
          results: {
            taskResults: Array<{
              task: { id: string };
              review: { reviewState: string; followUpTaskId?: string };
            }>;
          };
        };
      };
    };

    expect(committed.result.recommendedInput.work).toMatchObject({
      taskId: committed.result.task.id,
      autoRun: false
    });
    expect(committed.result.details.results.taskResults.find((result) => result.task.id === setup.taskId)?.review).toMatchObject({
      reviewState: "follow_up_created",
      followUpTaskId: committed.result.task.id
    });
  });

  it("does not recommend a follow-up commit after an accept-only task review settles", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new TaskReviewBackend(store, "Accept: the completed task result looks good.");
    const server = registeredServer(store, { backendFactory: () => backend });

    const started = await callRegisteredTool(server, "team_start", { teamName: "accepted task review" }) as { result: { team: { id: string } } };
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Implementer",
      model: "test/model",
      rawResponsibility: "Implement scoped runtime changes.",
      polishedPrompt: "Implement scoped runtime changes."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Reviewer",
      model: "test/model",
      rawResponsibility: "Review quality and validation results.",
      polishedPrompt: "Review quality and validation results."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });

    const setup = await store.transaction((state) => {
      const implementer = Object.values(state.members).find((member) => member.teamId === started.result.team.id && member.name === "Implementer")!;
      const tasks = new TaskService(state);
      const task = tasks.createTask({
        teamId: started.result.team.id,
        title: "Implement accepted review path",
        description: "Finish a task that should pass review without follow-up.",
        pathHints: ["src/runtime/taskReview.ts"],
        preferredMemberId: implementer.id
      });
      tasks.claimTask({ teamId: started.result.team.id, taskId: task.id, memberId: implementer.id });
      tasks.completeTask({ teamId: started.result.team.id, taskId: task.id, memberId: implementer.id, completionSummary: "Done." });
      return { taskId: task.id };
    });

    const recommended = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      work: {
        taskId: setup.taskId,
        autoRun: false,
        includeDetails: true
      }
    }) as {
      result: {
        recommendedInput: {
          teamId: string;
          work: {
            discussion: {
              subject: string;
              taskId: string;
              autoRun: boolean;
            };
          };
        };
      };
    };

    expectSingleRecommendedWorkStep(recommended.result.recommendedInput.work, "discussion");

    const reviewed = await callRegisteredTool(server, "team_work", recommended.result.recommendedInput) as {
      result: {
        nextActions: string[];
        recommendedInput: { work: { taskId?: string; autoRun: boolean; discussion?: unknown; goal?: string; review?: unknown } };
        details: {
          results: {
            taskResults: Array<{
              task: { id: string };
              review: { reviewState: string; reviewActionSummary?: string };
            }>;
          };
        };
      };
    };

    expect(reviewed.result.details.results.taskResults.find((result) => result.task.id === setup.taskId)?.review).toMatchObject({
      reviewState: "review_settled",
      reviewActionSummary: expect.stringContaining("no follow-up task recommendation")
    });
    expect(reviewed.result.nextActions[0]).toContain("no follow-up task recommendation");
    expectSingleRecommendedWorkStep(reviewed.result.recommendedInput.work, "taskId");
    expect(reviewed.result.recommendedInput.work).toMatchObject({
      taskId: setup.taskId,
      autoRun: false
    });
    expect(reviewed.result.recommendedInput.work.discussion).toBeUndefined();
    expect(reviewed.result.recommendedInput.work.goal).toBeUndefined();
    expect(reviewed.result.recommendedInput.work.review).toBeUndefined();
  });

  it("does not recommend task review when no eligible reviewer exists", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });
    const backend = new TaskReviewBackend(store);
    const server = registeredServer(store, { backendFactory: () => backend });

    const started = await callRegisteredTool(server, "team_start", { teamName: "no task reviewer" }) as { result: { team: { id: string } } };
    await callRegisteredTool(server, "team_draft", {
      teamId: started.result.team.id,
      name: "Implementer",
      model: "test/model",
      rawResponsibility: "Implement scoped runtime changes.",
      polishedPrompt: "Implement scoped runtime changes."
    });
    await callRegisteredTool(server, "team_confirm", { teamId: started.result.team.id });
    await callRegisteredTool(server, "team_finish", { teamId: started.result.team.id });

    const setup = await store.transaction((state) => {
      const implementer = Object.values(state.members).find((member) => member.teamId === started.result.team.id && member.name === "Implementer")!;
      const tasks = new TaskService(state);
      const task = tasks.createTask({
        teamId: started.result.team.id,
        title: "Implement without reviewer",
        pathHints: ["src/runtime/teamWork.ts"],
        preferredMemberId: implementer.id
      });
      tasks.claimTask({ teamId: started.result.team.id, taskId: task.id, memberId: implementer.id });
      tasks.completeTask({ teamId: started.result.team.id, taskId: task.id, memberId: implementer.id, completionSummary: "Done." });
      return { taskId: task.id };
    });

    const worked = await callRegisteredTool(server, "team_work", {
      teamId: started.result.team.id,
      work: {
        taskId: setup.taskId,
        autoRun: false,
        includeDetails: true
      }
    }) as {
      result: {
        details: {
          results: {
            taskResults: Array<{
              task: { id: string };
              review: { reviewState: string; reviewerMemberIds: string[] };
            }>;
          };
        };
        recommendedInput: { work: { taskId?: string; discussion?: unknown } };
      };
    };

    expect(worked.result.details.results.taskResults.find((result) => result.task.id === setup.taskId)?.review).toEqual({
      reviewState: "not_applicable",
      reviewerMemberIds: [],
      reviewerMemberNames: []
    });
    expect(worked.result.recommendedInput.work).not.toHaveProperty("discussion");
    expect(worked.result.recommendedInput.work.taskId).toBe(setup.taskId);
  });
});

function registeredServer(store: JsonStore, options: RegisterToolsOptions = {}): McpServer {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server, store, { advancedTools: true, ...options });
  return server;
}

async function callRegisteredTool(server: McpServer, name: string, input: Record<string, unknown>): Promise<unknown> {
  const toolRegistry = server as unknown as {
    _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }>;
  };
  const response = await toolRegistry._registeredTools[name]!.handler(input);
  const parsed = JSON.parse(response.content[0]!.text) as { ok?: boolean; error?: unknown };
  if (parsed.ok === false) {
    throw new Error(JSON.stringify(parsed.error ?? parsed));
  }
  return parsed as unknown;
}

async function tempRoot(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return mkdtemp(join(tmpdir(), "team-mcpv2-"));
}

function expectSingleRecommendedWorkStep(work: Record<string, unknown>, expectedStep: "goal" | "taskId" | "discussion" | "review"): void {
  const steps = ["goal", "taskId", "discussion", "review"].filter((key) => work[key] !== undefined);
  expect(steps).toEqual([expectedStep]);
}

class DiscussionDecisionBackend implements AgentBackend {
  readonly name = "opencode" as const;
  readonly prompts: string[] = [];
  private started = false;
  private nextSession = 1;

  constructor(private readonly store: JsonStore) {}

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async spawnSession(input: SpawnSessionInput): Promise<SpawnSessionResult> {
    this.requireStarted();
    return {
      backendSessionId: `discussion_${input.memberId}_${this.nextSession++}`,
      status: "idle"
    };
  }

  async promptSession(input: PromptSessionInput): Promise<PromptSessionResult> {
    this.requireStarted();
    this.prompts.push(input.prompt);
    const teamId = matchPromptValue(input.prompt, "teamId");
    const memberId = matchPromptValue(input.prompt, "memberId");
    const messageId = matchPromptValue(input.prompt, "messageId");

    await this.store.transaction((state) => {
      const mailbox = new MailboxService(state);
      const member = state.members[memberId]!;
      const promptMessage = state.messages[messageId]!;
      const isHostDecision = !promptMessage.fromMemberId && promptMessage.type === "notification" && promptMessage.body.startsWith("Host decision:");

      mailbox.sendMessage({
        teamId,
        fromMemberId: memberId,
        type: "opinion",
        subject: isHostDecision
          ? member.name === "Author" ? "Author follow-up" : "Reviewer follow-up"
          : member.name === "Author" ? "Author opinion" : "Reviewer opinion",
        body: isHostDecision
          ? member.name === "Author"
            ? "I can work within the host decision and keep the state centralized."
            : "I agree with the host decision and will keep the next turn mailbox-driven."
          : member.name === "Author"
            ? "Keep the derived thread state centralized."
            : "Let host status drive the next turn.",
        replyToMessageId: messageId
      });
      if (member.name === "Reviewer" && !isHostDecision) {
        const escalation = mailbox.sendMessage({
          teamId,
          fromMemberId: memberId,
          type: "escalation",
          subject: "Need host review",
          body: "The team needs a host decision before continuing.",
          replyToMessageId: messageId
        });
        for (const teammate of Object.values(state.members).filter((candidate) => candidate.teamId === teamId && candidate.id !== memberId)) {
          mailbox.ackMessage({ teamId, messageId: escalation.id, memberId: teammate.id });
        }
      }
      mailbox.ackMessage({ teamId, messageId, memberId });
    });

    return { summary: `Prompted ${input.backendSessionId}` };
  }

  async abortSession(_sessionId: string): Promise<void> {
    this.requireStarted();
  }

  private requireStarted(): void {
    if (!this.started) {
      throw new Error("DiscussionDecisionBackend is not started");
    }
  }
}

class DelayedDiscussionBackend implements AgentBackend {
  readonly name = "opencode" as const;
  private started = false;
  private nextSession = 1;

  constructor(private readonly store: JsonStore) {}

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async spawnSession(input: SpawnSessionInput): Promise<SpawnSessionResult> {
    this.requireStarted();
    return {
      backendSessionId: `delayed_${input.memberId}_${this.nextSession++}`,
      status: "idle"
    };
  }

  async promptSession(input: PromptSessionInput): Promise<PromptSessionResult> {
    this.requireStarted();
    const teamId = matchPromptValue(input.prompt, "teamId");
    const memberId = matchPromptValue(input.prompt, "memberId");
    const messageId = matchPromptValue(input.prompt, "messageId");

    const memberName = await this.store.transaction((state) => state.members[memberId]!.name);
    if (memberName === "Reviewer") {
      setTimeout(() => {
        void this.store.transaction((state) => {
          new MailboxService(state).sendMessage({
            teamId,
            fromMemberId: memberId,
            type: "opinion",
            subject: "Reviewer opinion",
            body: "I agree after the short delay.",
            replyToMessageId: messageId
          });
        });
      }, 30);
      return { summary: `Prompted ${input.backendSessionId}`, conversationState: "waiting" };
    }

    await this.store.transaction((state) => {
      new MailboxService(state).sendMessage({
        teamId,
        fromMemberId: memberId,
        type: "opinion",
        subject: "Author opinion",
        body: "I can reply immediately.",
        replyToMessageId: messageId
      });
    });

    return { summary: `Prompted ${input.backendSessionId}` };
  }

  async abortSession(_sessionId: string): Promise<void> {
    this.requireStarted();
  }

  private requireStarted(): void {
    if (!this.started) {
      throw new Error("DelayedDiscussionBackend is not started");
    }
  }
}

class WaitingReviewerDiscussionBackend implements AgentBackend {
  readonly name = "opencode" as const;
  private started = false;
  private nextSession = 1;

  constructor(private readonly store: JsonStore) {}

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async spawnSession(input: SpawnSessionInput): Promise<SpawnSessionResult> {
    this.requireStarted();
    return {
      backendSessionId: `waiting_reviewer_${input.memberId}_${this.nextSession++}`,
      status: "idle"
    };
  }

  async promptSession(input: PromptSessionInput): Promise<PromptSessionResult> {
    this.requireStarted();
    const teamId = matchPromptValue(input.prompt, "teamId");
    const memberId = matchPromptValue(input.prompt, "memberId");
    const messageId = matchPromptValue(input.prompt, "messageId");
    const memberName = await this.store.transaction((state) => state.members[memberId]!.name);

    if (memberName === "Reviewer") {
      return { summary: `Prompted ${input.backendSessionId}`, conversationState: "waiting" };
    }

    await this.store.transaction((state) => {
      new MailboxService(state).sendMessage({
        teamId,
        fromMemberId: memberId,
        type: "opinion",
        subject: "Author opinion",
        body: "I can move quickly on this direction.",
        replyToMessageId: messageId
      });
    });

    return { summary: `Prompted ${input.backendSessionId}` };
  }

  async abortSession(_sessionId: string): Promise<void> {
    this.requireStarted();
  }

  private requireStarted(): void {
    if (!this.started) {
      throw new Error("WaitingReviewerDiscussionBackend is not started");
    }
  }
}

class InvitedPlannerDiscussionBackend implements AgentBackend {
  readonly name = "opencode" as const;
  private started = false;
  private nextSession = 1;

  constructor(private readonly store: JsonStore) {}

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async spawnSession(input: SpawnSessionInput): Promise<SpawnSessionResult> {
    this.requireStarted();
    return {
      backendSessionId: `invited_planner_${input.memberId}_${this.nextSession++}`,
      status: "idle"
    };
  }

  async promptSession(input: PromptSessionInput): Promise<PromptSessionResult> {
    this.requireStarted();
    const teamId = matchPromptValue(input.prompt, "teamId");
    const memberId = matchPromptValue(input.prompt, "memberId");
    const messageId = matchPromptValue(input.prompt, "messageId");
    const memberName = await this.store.transaction((state) => state.members[memberId]!.name);

    if (memberName === "Reviewer") {
      return { summary: `Prompted ${input.backendSessionId}`, conversationState: "waiting" };
    }

    await this.store.transaction((state) => {
      const mailbox = new MailboxService(state);
      mailbox.sendMessage({
        teamId,
        fromMemberId: memberId,
        type: "opinion",
        subject: `${memberName} opinion`,
        body: memberName === "Planner"
          ? "Planner note: the thread summary should stay compact."
          : "Author note: keep the field list focused.",
        replyToMessageId: messageId
      });
    });

    return { summary: `Prompted ${input.backendSessionId}` };
  }

  async abortSession(_sessionId: string): Promise<void> {
    this.requireStarted();
  }

  private requireStarted(): void {
    if (!this.started) {
      throw new Error("InvitedPlannerDiscussionBackend is not started");
    }
  }
}

class TaskReviewBackend implements AgentBackend {
  readonly name = "opencode" as const;
  readonly prompts: string[] = [];
  private started = false;
  private nextSession = 1;

  constructor(
    private readonly store: JsonStore,
    private readonly responseBody = "Concern: add one follow-up check before accepting the task result."
  ) {}

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async spawnSession(input: SpawnSessionInput): Promise<SpawnSessionResult> {
    this.requireStarted();
    return {
      backendSessionId: `task_review_${input.memberId}_${this.nextSession++}`,
      status: "idle"
    };
  }

  async promptSession(input: PromptSessionInput): Promise<PromptSessionResult> {
    this.requireStarted();
    this.prompts.push(input.prompt);
    const teamId = matchPromptValue(input.prompt, "teamId");
    const memberId = matchPromptValue(input.prompt, "memberId");
    const messageId = matchPromptValue(input.prompt, "messageId");

    await this.store.transaction((state) => {
      const mailbox = new MailboxService(state);
      mailbox.sendMessage({
        teamId,
        fromMemberId: memberId,
        type: "opinion",
        subject: "Review opinion",
        body: this.responseBody,
        replyToMessageId: messageId
      });
      mailbox.ackMessage({ teamId, messageId, memberId });
    });

    return { summary: `Prompted ${input.backendSessionId}` };
  }

  async abortSession(_sessionId: string): Promise<void> {
    this.requireStarted();
  }

  private requireStarted(): void {
    if (!this.started) {
      throw new Error("TaskReviewBackend is not started");
    }
  }
}

function matchPromptValue(prompt: string, key: string): string {
  const match = prompt.match(new RegExp(`^${key}=(.+)$`, "m"));
  if (!match) {
    throw new Error(`Prompt missing ${key}`);
  }
  return match[1]!;
}
