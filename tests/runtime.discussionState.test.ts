import { describe, expect, it } from "vitest";
import { emptyState } from "../src/domain/types.js";
import { compactResultsView, compactStatusView } from "../src/runtime/compactViews.js";
import { runtimeControlPlane } from "../src/runtime/controlPlane.js";
import { discussionThreads } from "../src/runtime/discussionState.js";
import { explainRuntimeResults, explainRuntimeStatus } from "../src/runtime/explainability.js";
import { FakeAgentBackend } from "../src/runtime/fakeAgentBackend.js";
import { RuntimeService } from "../src/runtime/runtimeService.js";
import { runtimeResults } from "../src/runtime/timeline.js";
import { MailboxService } from "../src/services/mailboxService.js";
import { TaskService } from "../src/services/taskService.js";
import { TeamService } from "../src/services/teamService.js";

describe("discussion thread state", () => {
  it("tracks expected responders, pending members, and latest opinions in a broadcast thread", async () => {
    const { state, team, members } = await setupDiscussionTeam();
    const mailbox = new MailboxService(state);
    const root = mailbox.sendMessage({
      teamId: team.id,
      type: "question",
      subject: "Design direction",
      body: "Share one opinion each.",
      participantMemberIds: members.map((member) => member.id)
    });

    let thread = discussionThreads(state, team.id)[0]!;
    expect(thread).toMatchObject({
      threadId: root.id,
      subject: "Design direction",
      state: "waiting_for_members",
      lifecycleState: "open",
      resolutionState: "not_started",
      actionabilityState: "none",
      suggestedActionSummary: "The discussion is still collecting or confirming member replies.",
      actionSourceMessageIds: [root.id],
      turnTakingState: "waiting_required",
      nextResponsibleMemberIds: expect.arrayContaining(members.map((member) => member.id)),
      nextResponsibleMemberNames: ["Author", "Reviewer"],
      nextTurnSummary: "Waiting on Author and Reviewer to reply in the current round.",
      disagreementState: "possible",
      disagreementSummary: "1 question is still unresolved in the current round.",
      proposedNextAction: {
        kind: "wait_for_members",
        summary: "Wait for Author and Reviewer to respond before settling the round.",
        memberIds: expect.arrayContaining(members.map((member) => member.id))
      },
      currentRoundMessageCount: 1,
      currentRoundSummary: "Current round started with the host question and is waiting for 2 member responses.",
      expectedMemberIds: expect.arrayContaining(members.map((member) => member.id)),
      respondedMemberIds: [],
      respondedMemberNames: [],
      pendingMemberIds: expect.arrayContaining(members.map((member) => member.id)),
      owedMemberIds: expect.arrayContaining(members.map((member) => member.id)),
      owedMemberNames: ["Author", "Reviewer"],
      invitedMemberIds: [],
      invitedMemberNames: [],
      participationSummary: "Waiting for Author and Reviewer to respond.",
      turnSummary: "Waiting on Author and Reviewer to reply in the current round.",
      synthesis: {
        resolutionState: "not_started",
        summary: "Author and Reviewer still owe a reply.",
        memberSummaries: expect.arrayContaining([
          expect.objectContaining({ memberId: members[0]!.id, memberName: "Author", status: "owed" }),
          expect.objectContaining({ memberId: members[1]!.id, memberName: "Reviewer", status: "owed" })
        ])
      },
      unresolvedQuestionCount: 1,
      needsHostDecision: false
    });
    expect(thread.turnObligations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        memberId: members[0]!.id,
        kind: "participant_reply",
        trigger: "participant_obligation",
        required: true,
        priorityScore: 300
      }),
      expect.objectContaining({
        memberId: members[1]!.id,
        kind: "participant_reply",
        trigger: "participant_obligation",
        required: true,
        priorityScore: 300
      })
    ]));
    expect(thread.currentRoundTurns).toEqual([
      expect.objectContaining({
        messageId: root.id,
        type: "question",
        subject: "Design direction",
        bodyPreview: "Share one opinion each.",
        isCurrentAnchor: true,
        awaiting: "member_response"
      })
    ]);

    mailbox.sendMessage({
      teamId: team.id,
      fromMemberId: members[0]!.id,
      type: "opinion",
      body: "Option A looks cleaner.",
      replyToMessageId: root.id
    });
    mailbox.consumeMessages({ teamId: team.id, memberId: members[0]!.id, messageIds: [root.id] });

    thread = discussionThreads(state, team.id)[0]!;
    expect(thread).toMatchObject({
      state: "waiting_for_members",
      lifecycleState: "collecting",
      resolutionState: "forming",
      actionabilityState: "none",
      suggestedActionSummary: "The discussion is still collecting or confirming member replies.",
      turnTakingState: "waiting_required",
      nextResponsibleMemberIds: [members[1]!.id],
      nextResponsibleMemberNames: ["Reviewer"],
      nextTurnSummary: "Waiting on Reviewer to reply in the current round.",
      disagreementState: "none",
      proposedNextAction: {
        kind: "prompt_member",
        summary: "Prompt Reviewer to respond to the current round.",
        memberIds: [members[1]!.id]
      },
      currentRoundSummary: "Current round started with the host question and is waiting for 1 member response.",
      respondedMemberIds: [members[0]!.id],
      respondedMemberNames: ["Author"],
      pendingMemberIds: [members[1]!.id],
      owedMemberIds: [members[1]!.id],
      owedMemberNames: ["Reviewer"],
      participationSummary: "Author has responded; Reviewer still owes a reply.",
      synthesis: {
        resolutionState: "forming",
        memberSummaries: expect.arrayContaining([
          expect.objectContaining({ memberId: members[0]!.id, memberName: "Author", status: "responded", latestBodyPreview: "Option A looks cleaner." }),
          expect.objectContaining({ memberId: members[1]!.id, memberName: "Reviewer", status: "owed" })
        ])
      },
      unresolvedQuestionCount: 0,
      needsHostDecision: false
    });
    expect(thread.latestOpinions.map((message) => message.fromMemberId)).toEqual([members[0]!.id]);
    expect(thread.currentRoundTurns).toEqual([
      expect.objectContaining({
        messageId: root.id,
        type: "question",
        isCurrentAnchor: true,
        awaiting: "member_response"
      }),
      expect.objectContaining({
        type: "opinion",
        fromMemberId: members[0]!.id,
        bodyPreview: "Option A looks cleaner.",
        isCurrentAnchor: false
      })
    ]);

    mailbox.sendMessage({
      teamId: team.id,
      fromMemberId: members[1]!.id,
      type: "opinion",
      body: "Option B is safer to ship.",
      replyToMessageId: root.id
    });
    mailbox.consumeMessages({ teamId: team.id, memberId: members[1]!.id, messageIds: [root.id] });

    thread = discussionThreads(state, team.id)[0]!;
    expect(thread).toMatchObject({
      state: "settled",
      lifecycleState: "settled",
      resolutionState: "resolved",
      actionabilityState: "waiting_host_commit",
      suggestedActionSummary: "The discussion is settled; decide whether to create follow-up task work or continue the thread.",
      suggestedTaskTitle: "Follow up on Design direction",
      actionSourceMessageIds: [thread.currentRoundTurns[2]!.messageId],
      turnTakingState: "settled",
      nextResponsibleMemberIds: [],
      nextResponsibleMemberNames: [],
      disagreementState: "none",
      proposedNextAction: {
        kind: "summarize_conclusion",
        summary: "Author and Reviewer have responded; the round is now settled."
      },
      conclusionSummary: "Author and Reviewer have responded; the round is now settled.",
      synthesis: {
        resolutionState: "resolved",
        summary: "Author and Reviewer have responded; the round is now settled."
      },
      currentRoundSummary: "Current round is settled with 2 member responses.",
      respondedMemberIds: expect.arrayContaining(members.map((member) => member.id)),
      respondedMemberNames: ["Author", "Reviewer"],
      pendingMemberIds: [],
      owedMemberIds: [],
      owedMemberNames: [],
      invitedMemberIds: [],
      invitedMemberNames: [],
      participationSummary: "Author and Reviewer have responded; the round is settled.",
      unresolvedQuestionCount: 0,
      needsHostDecision: false
    });
    expect(thread.latestOpinions.map((message) => message.fromMemberId).sort()).toEqual(members.map((member) => member.id).sort());
    expect(thread.currentRoundTurns.map((turn) => turn.messageId)).toEqual([
      root.id,
      thread.currentRoundTurns[1]!.messageId,
      thread.currentRoundTurns[2]!.messageId
    ]);
    expect(thread.currentRoundTurns[0]).toMatchObject({
      messageId: root.id,
      isCurrentAnchor: true,
      awaiting: undefined
    });
    expect(thread.currentRoundTurns.slice(1)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "opinion",
        fromMemberId: members[0]!.id,
        bodyPreview: "Option A looks cleaner."
      }),
      expect.objectContaining({
        type: "opinion",
        fromMemberId: members[1]!.id,
        bodyPreview: "Option B is safer to ship."
      })
    ]));
  });

  it("marks a settled discussion as already committed after the host creates follow-up task work", async () => {
    const { state, team, members } = await setupDiscussionTeam();
    const mailbox = new MailboxService(state);
    const root = mailbox.sendMessage({
      teamId: team.id,
      type: "question",
      subject: "Execution plan",
      body: "Share one execution opinion each.",
      participantMemberIds: members.map((member) => member.id)
    });
    mailbox.sendMessage({
      teamId: team.id,
      fromMemberId: members[0]!.id,
      type: "opinion",
      body: "Split the runtime change into one bounded task.",
      replyToMessageId: root.id
    });
    mailbox.sendMessage({
      teamId: team.id,
      fromMemberId: members[1]!.id,
      type: "opinion",
      body: "Keep the first task focused on host commit plumbing.",
      replyToMessageId: root.id
    });

    const task = new TaskService(state).createTask({
      teamId: team.id,
      title: "Execution plan",
      description: "Host committed the next runtime task."
    });
    const commitMessage = mailbox.sendMessage({
      teamId: team.id,
      taskId: task.id,
      type: "notification",
      subject: "Execution plan",
      body: `Host committed task: ${task.title}\nTask id: ${task.id}\nTask summary: ${task.description}`,
      replyToMessageId: root.id
    });

    const thread = discussionThreads(state, team.id)[0]!;
    expect(thread).toMatchObject({
      threadId: root.id,
      taskId: task.id,
      committedTaskId: task.id,
      committedTaskTitle: "Execution plan",
      commitMessageId: commitMessage.id,
      closureReason: "committed_to_task",
      closedAtMessageId: commitMessage.id,
      closedTaskId: task.id,
      state: "closed",
      lifecycleState: "closed",
      resolutionState: "resolved",
      actionabilityState: "none",
      suggestedActionSummary: `This discussion has already produced follow-up task ${task.id}.`,
      actionSourceMessageIds: [commitMessage.id],
      proposedNextAction: {
        kind: "none",
        summary: `This discussion is closed and has moved to task ${task.id}.`
      },
      currentRoundSummary: `Discussion is closed and handed off to task ${task.id}.`,
      turnObligations: [],
      nextTurns: [],
      pendingMemberIds: [],
      needsHostDecision: false,
      unresolvedQuestionCount: 0,
      latestMessage: {
        id: commitMessage.id,
        type: "notification"
      }
    });
  });

  it("keeps a directed follow-up question pending for the addressed teammate until they reply", async () => {
    const { state, team, members } = await setupDiscussionTeam();
    const mailbox = new MailboxService(state);
    const root = mailbox.sendMessage({
      teamId: team.id,
      type: "question",
      subject: "API review",
      body: "Share one opinion each.",
      participantMemberIds: members.map((member) => member.id)
    });
    mailbox.sendMessage({
      teamId: team.id,
      fromMemberId: members[0]!.id,
      type: "opinion",
      body: "The response should stay compact.",
      replyToMessageId: root.id
    });
    mailbox.consumeMessages({ teamId: team.id, memberId: members[0]!.id, messageIds: [root.id] });
    mailbox.sendMessage({
      teamId: team.id,
      fromMemberId: members[1]!.id,
      type: "opinion",
      body: "The response should include status state.",
      replyToMessageId: root.id
    });
    mailbox.consumeMessages({ teamId: team.id, memberId: members[1]!.id, messageIds: [root.id] });

    const followUp = mailbox.sendMessage({
      teamId: team.id,
      fromMemberId: members[0]!.id,
      toMemberId: members[1]!.id,
      type: "question",
      subject: "Can you refine the field list?",
      body: "Please narrow the thread summary fields.",
      replyToMessageId: root.id
    });

    let thread = discussionThreads(state, team.id)[0]!;
    expect(thread).toMatchObject({
      state: "waiting_for_members",
      lifecycleState: "collecting",
      resolutionState: "forming",
      actionabilityState: "follow_up_discussion",
      suggestedActionSummary: "Continue the current discussion before turning it into task work.",
      actionSourceMessageIds: [followUp.id],
      turnTakingState: "waiting_follow_up",
      nextResponsibleMemberIds: [members[1]!.id],
      nextResponsibleMemberNames: ["Reviewer"],
      nextTurnSummary: "Waiting on Reviewer to answer a follow-up message.",
      disagreementState: "needs_resolution",
      disagreementSummary: "2 member opinions are recorded and 1 question is still unresolved.",
      proposedNextAction: {
        kind: "prompt_member",
        summary: "Prompt Reviewer to respond to the current round.",
        memberIds: [members[1]!.id]
      },
      currentRoundSummary: "Current round started with a member question and is waiting for 1 member response.",
      pendingMemberIds: [members[1]!.id],
      owedMemberIds: [members[1]!.id],
      owedMemberNames: ["Reviewer"],
      participationSummary: "Author and Reviewer have responded; Reviewer still owes a reply.",
      unresolvedQuestionCount: 1,
      needsHostDecision: false
    });
    expect(thread.turnObligations).toEqual(expect.arrayContaining([
      expect.objectContaining({
      memberId: members[1]!.id,
      kind: "follow_up_reply",
      trigger: "unresolved_question_follow_up",
      priorityScore: 450,
      messageId: followUp.id,
      required: true
      })
    ]));
    expect(thread.latestMessage?.id).toBe(followUp.id);
    expect(thread.currentRoundTurns).toEqual([
      expect.objectContaining({
        messageId: root.id,
        type: "question",
        isCurrentAnchor: false
      }),
      expect.objectContaining({
        type: "opinion",
        fromMemberId: members[0]!.id,
        bodyPreview: "The response should stay compact."
      }),
      expect.objectContaining({
        type: "opinion",
        fromMemberId: members[1]!.id,
        bodyPreview: "The response should include status state."
      }),
      expect.objectContaining({
        messageId: followUp.id,
        type: "question",
        subject: "Can you refine the field list?",
        bodyPreview: "Please narrow the thread summary fields.",
        isCurrentAnchor: true,
        awaiting: "member_response"
      })
    ]);

    mailbox.consumeMessages({ teamId: team.id, memberId: members[1]!.id, messageIds: [followUp.id] });
    thread = discussionThreads(state, team.id)[0]!;
    expect(thread).toMatchObject({
      pendingMemberIds: [members[1]!.id],
      owedMemberIds: [members[1]!.id]
    });
    expect(thread.turnObligations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        memberId: members[1]!.id,
        kind: "follow_up_reply",
        trigger: "unresolved_question_follow_up",
        priorityScore: 450,
        source: "thread_state",
        required: true
      })
    ]));

    mailbox.sendMessage({
      teamId: team.id,
      fromMemberId: members[1]!.id,
      type: "opinion",
      body: "Use expected/responded/pending/latestOpinions.",
      replyToMessageId: followUp.id
    });
    mailbox.consumeMessages({ teamId: team.id, memberId: members[1]!.id, messageIds: [followUp.id] });

    thread = discussionThreads(state, team.id)[0]!;
    expect(thread).toMatchObject({
      state: "settled",
      lifecycleState: "settled",
      disagreementState: "none",
      proposedNextAction: {
        kind: "summarize_conclusion",
        summary: "Author and Reviewer have responded; the round is now settled."
      },
      pendingMemberIds: [],
      unresolvedQuestionCount: 0,
      needsHostDecision: false
    });
    expect(thread.currentRoundTurns.at(-2)).toMatchObject({
      messageId: followUp.id,
      isCurrentAnchor: true,
      awaiting: undefined
    });
    expect(thread.currentRoundTurns.at(-1)).toMatchObject({
      type: "opinion",
      fromMemberId: members[1]!.id,
      bodyPreview: "Use expected/responded/pending/latestOpinions."
    });
  });

  it("derives highest-priority ownership for a direct host message", async () => {
    const { state, team, members } = await setupDiscussionTeam();
    const mailbox = new MailboxService(state);
    const direct = mailbox.sendMessage({
      teamId: team.id,
      toMemberId: members[1]!.id,
      type: "question",
      subject: "Direct review",
      body: "Please answer this direct review question."
    });

    const thread = discussionThreads(state, team.id)[0]!;
    expect(thread).toMatchObject({
      threadId: direct.id,
      lifecycleState: "open",
      actionabilityState: "none",
      suggestedActionSummary: "The discussion is still collecting or confirming member replies.",
      actionSourceMessageIds: [direct.id],
      turnTakingState: "waiting_follow_up",
      nextResponsibleMemberIds: [members[1]!.id],
      nextResponsibleMemberNames: ["Reviewer"],
      nextTurnSummary: "Waiting on Reviewer to answer a direct message.",
      proposedNextAction: {
        kind: "prompt_member",
        memberIds: [members[1]!.id]
      },
      owedMemberIds: [members[1]!.id]
    });
    expect(thread.turnObligations).toEqual([
      expect.objectContaining({
        memberId: members[1]!.id,
        kind: "direct_reply",
        trigger: "direct_message",
        priorityScore: 500,
        required: true
      })
    ]);
  });

  it("surfaces host decision needs in status and keeps discussion separate from task results", async () => {
    const { state, team, members, runtime } = await setupDiscussionTeam();
    const mailbox = new MailboxService(state);
    const root = mailbox.sendMessage({
      teamId: team.id,
      type: "question",
      subject: "Architecture choice",
      body: "Each member should share one opinion.",
      participantMemberIds: members.map((member) => member.id)
    });
    mailbox.sendMessage({
      teamId: team.id,
      fromMemberId: members[0]!.id,
      type: "opinion",
      body: "Keep the helper in runtime/discussionState.ts.",
      replyToMessageId: root.id
    });
    mailbox.consumeMessages({ teamId: team.id, memberId: members[0]!.id, messageIds: [root.id] });
    mailbox.sendMessage({
      teamId: team.id,
      fromMemberId: members[1]!.id,
      type: "opinion",
      body: "Expose the derived state through team_status first.",
      replyToMessageId: root.id
    });
    mailbox.consumeMessages({ teamId: team.id, memberId: members[1]!.id, messageIds: [root.id] });
    mailbox.sendMessage({
      teamId: team.id,
      fromMemberId: members[0]!.id,
      type: "question",
      body: "Which thread fields should the host see first?",
      replyToMessageId: root.id
    });
    mailbox.consumeMessages({
      teamId: team.id,
      memberId: members[1]!.id,
      messageIds: Object.values(state.messages)
        .filter((message) => message.replyToMessageId === root.id && message.type === "question")
        .map((message) => message.id)
    });

    const sessions = Object.values(state.agentSessions).filter((session) => session.teamId === team.id);
    const controlPlane = runtimeControlPlane(state, team.id, sessions);
    const explain = explainRuntimeStatus(state, undefined, runtime, controlPlane);
    const compactStatus = compactStatusView(state, team.id, undefined, runtime, sessions, controlPlane, explain);
    const results = runtimeResults(state, team.id, 10);
    const explainResults = explainRuntimeResults(state, runtime, controlPlane, results);
    const compactResults = compactResultsView(state, team.id, results, explainResults);

    expect(controlPlane.inbox.activeThreads[0]).toMatchObject({
      state: "ready_for_host",
      lifecycleState: "contested",
      resolutionState: "blocked",
      actionabilityState: "follow_up_discussion",
      suggestedActionSummary: "2 member opinions are recorded and 1 question is still unresolved.",
      actionSourceMessageIds: [expect.any(String)],
      turnTakingState: "blocked_by_host",
      nextResponsibleMemberIds: [],
      nextResponsibleMemberNames: [],
      nextTurnSummary: "Waiting for the host decision before member turns continue.",
      disagreementState: "needs_resolution",
      disagreementSummary: "2 member opinions are recorded and 1 question is still unresolved.",
      proposedNextAction: {
        kind: "host_decision",
        summary: "2 member opinions are recorded and 1 question is still unresolved."
      },
      pendingMemberIds: [],
      participationSummary: "Author and Reviewer have responded in the current round.",
      unresolvedQuestionCount: 1,
      needsHostDecision: true,
      respondedMemberIds: expect.arrayContaining(members.map((member) => member.id))
    });
    expect(explain).toMatchObject({
      phase: "attention",
      headline: 'Discussion "Architecture choice" is ready for a host decision.',
      blockingReason: "2 member opinions are recorded and 1 question is still unresolved.",
      recommendedNextAction: "Review the active discussion thread and decide how the team should proceed."
    });
    expect(compactStatus).toMatchObject({
      headline: 'Discussion "Architecture choice" is ready for a host decision.',
      supportingLine: "2 member opinions are recorded and 1 question is still unresolved.",
      discussion: {
        state: "ready_for_host",
        lifecycleState: "contested",
        resolutionState: "blocked",
        progressSummary: "2 member opinions are recorded and 1 question is still unresolved.",
        synthesis: {
          resolutionState: "blocked",
          summary: "Author and Reviewer have responded. 2 member opinions are recorded and 1 question is still unresolved.",
          openIssueSummary: "2 member opinions are recorded and 1 question is still unresolved."
        },
        participationSummary: "Author and Reviewer have responded in the current round.",
        hostAttentionSummary: "2 member opinions are recorded and 1 question is still unresolved.",
        disagreementSummary: "2 member opinions are recorded and 1 question is still unresolved.",
        proposedNextAction: {
          kind: "host_decision",
          summary: "2 member opinions are recorded and 1 question is still unresolved."
        }
      },
      nextAction: "Review the active discussion thread and decide how the team should proceed."
    });
    expect(compactStatus.discussion?.currentRoundTurns).toEqual([
      expect.objectContaining({
        type: "question",
        subject: "Architecture choice"
      }),
      expect.objectContaining({
        type: "opinion",
        fromMemberId: members[0]!.id
      }),
      expect.objectContaining({
        type: "opinion",
        fromMemberId: members[1]!.id
      }),
      expect.objectContaining({
        type: "question",
        fromMemberId: members[0]!.id,
        bodyPreview: "Which thread fields should the host see first?",
        isCurrentAnchor: true,
        awaiting: "host_decision"
      })
    ]);
    expect(results.completedTasks).toHaveLength(0);
    expect(results.failedTasks).toHaveLength(0);
    expect(compactResults.latestDiscussion).toMatchObject({
      subject: "Architecture choice",
      state: "ready_for_host",
      lifecycleState: "contested",
      resolutionState: "blocked",
      currentRoundSummary: "Current round reached a host decision point after 2 member responses.",
      synthesis: {
        resolutionState: "blocked",
        openIssueSummary: "2 member opinions are recorded and 1 question is still unresolved."
      },
      participationSummary: "Author and Reviewer have responded in the current round.",
      hostAttentionSummary: "2 member opinions are recorded and 1 question is still unresolved.",
      disagreementSummary: "2 member opinions are recorded and 1 question is still unresolved.",
      proposedNextAction: {
        kind: "host_decision",
        summary: "2 member opinions are recorded and 1 question is still unresolved."
      },
      needsHostDecision: true,
      unresolvedQuestionCount: 1
    });
    expect(compactResults.latestDiscussion?.currentRoundTurns.at(-1)).toMatchObject({
      type: "question",
      fromMemberId: members[0]!.id,
      awaiting: "host_decision"
    });
    expect(compactResults.supportingLine).toBe("2 member opinions are recorded and 1 question is still unresolved.");
  });

  it("resets the active discussion round after a host decision message", async () => {
    const { state, team, members } = await setupDiscussionTeam();
    const mailbox = new MailboxService(state);
    const root = mailbox.sendMessage({
      teamId: team.id,
      type: "question",
      subject: "Direction call",
      body: "Each member should share one opinion.",
      participantMemberIds: members.map((member) => member.id)
    });
    mailbox.sendMessage({
      teamId: team.id,
      fromMemberId: members[0]!.id,
      type: "opinion",
      body: "Keep the state derivation shared.",
      replyToMessageId: root.id
    });
    mailbox.consumeMessages({ teamId: team.id, memberId: members[0]!.id, messageIds: [root.id] });
    mailbox.sendMessage({
      teamId: team.id,
      fromMemberId: members[1]!.id,
      type: "opinion",
      body: "Surface the thread state before adding more tools.",
      replyToMessageId: root.id
    });
    mailbox.consumeMessages({ teamId: team.id, memberId: members[1]!.id, messageIds: [root.id] });
    const escalation = mailbox.sendMessage({
      teamId: team.id,
      fromMemberId: members[1]!.id,
      type: "escalation",
      subject: "Need host review",
      body: "A host call is needed before the next turn.",
      replyToMessageId: root.id
    });
    mailbox.consumeMessages({ teamId: team.id, memberId: members[1]!.id, messageIds: [root.id] });
    mailbox.ackMessage({ teamId: team.id, messageId: escalation.id, memberId: members[0]!.id });

    let thread = discussionThreads(state, team.id)[0]!;
    expect(thread).toMatchObject({
      state: "ready_for_host",
      lifecycleState: "contested",
      disagreementState: "needs_resolution",
      disagreementSummary: "A host escalation is holding the current round for judgment.",
      proposedNextAction: {
        kind: "host_decision",
        summary: "A host escalation is holding the current round for judgment."
      },
      currentRoundSummary: "Current round reached a host decision point after 2 member responses.",
      needsHostDecision: true
    });

    const hostDecision = mailbox.sendMessage({
      teamId: team.id,
      type: "notification",
      subject: "Direction call",
      body: "Host decision: keep the next round mailbox-driven.",
      replyToMessageId: thread.latestMessage!.id,
      participantMemberIds: members.map((member) => member.id)
    });

    thread = discussionThreads(state, team.id)[0]!;
    expect(thread).toMatchObject({
      state: "waiting_for_members",
      lifecycleState: "open",
      resolutionState: "not_started",
      actionabilityState: "none",
      suggestedActionSummary: "The discussion is still collecting or confirming member replies.",
      actionSourceMessageIds: [hostDecision.id],
      turnTakingState: "waiting_required",
      nextResponsibleMemberIds: expect.arrayContaining(members.map((member) => member.id)),
      nextResponsibleMemberNames: ["Author", "Reviewer"],
      nextTurnSummary: "Waiting on Author and Reviewer to acknowledge the host decision.",
      disagreementState: "none",
      proposedNextAction: {
        kind: "wait_for_members",
        summary: "Wait for Author and Reviewer to respond before settling the round.",
        memberIds: expect.arrayContaining(members.map((member) => member.id))
      },
      currentRoundSummary: "Current round started with the host notification and is waiting for 2 member responses.",
      participationSummary: "Waiting for Author and Reviewer to respond.",
      needsHostDecision: false,
      pendingMemberIds: expect.arrayContaining(members.map((member) => member.id)),
      respondedMemberIds: [],
      unresolvedQuestionCount: 0
    });
    expect(thread.turnObligations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        memberId: members[0]!.id,
        kind: "participant_reply",
        trigger: "host_decision_follow_through",
        priorityScore: 400
      }),
      expect.objectContaining({
        memberId: members[1]!.id,
        kind: "participant_reply",
        trigger: "host_decision_follow_through",
        priorityScore: 400
      })
    ]));
    expect(thread.latestOpinions).toHaveLength(0);
    expect(thread.currentRoundTurns).toEqual([
      expect.objectContaining({
        messageId: hostDecision.id,
        type: "notification",
        bodyPreview: "Host decision: keep the next round mailbox-driven.",
        isCurrentAnchor: true,
        awaiting: "member_response"
      })
    ]);

    mailbox.sendMessage({
      teamId: team.id,
      fromMemberId: members[0]!.id,
      type: "opinion",
      body: "Acknowledged. I will follow the host direction.",
      replyToMessageId: hostDecision.id
    });
    mailbox.consumeMessages({ teamId: team.id, memberId: members[0]!.id, messageIds: [hostDecision.id] });

    thread = discussionThreads(state, team.id)[0]!;
    expect(thread).toMatchObject({
      state: "waiting_for_members",
      lifecycleState: "collecting",
      resolutionState: "forming",
      actionabilityState: "none",
      suggestedActionSummary: "The discussion is still collecting or confirming member replies.",
      turnTakingState: "waiting_required",
      nextResponsibleMemberIds: [members[1]!.id],
      nextResponsibleMemberNames: ["Reviewer"],
      nextTurnSummary: "Waiting on Reviewer to acknowledge the host decision.",
      disagreementState: "none",
      proposedNextAction: {
        kind: "prompt_member",
        summary: "Prompt Reviewer to respond to the current round.",
        memberIds: [members[1]!.id]
      },
      currentRoundSummary: "Current round started with the host notification and is waiting for 1 member response.",
      participationSummary: "Author has responded; Reviewer still owes a reply.",
      needsHostDecision: false,
      pendingMemberIds: [members[1]!.id],
      respondedMemberIds: [members[0]!.id]
    });
    expect(thread.currentRoundTurns).toEqual([
      expect.objectContaining({
        messageId: hostDecision.id,
        type: "notification",
        awaiting: "member_response"
      }),
      expect.objectContaining({
        type: "opinion",
        fromMemberId: members[0]!.id,
        bodyPreview: "Acknowledged. I will follow the host direction."
      })
    ]);
  });

  it("invites a relevant non-participant into an active discussion when callWhen matches", async () => {
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "discussion-invite" }).team;
    const members = [
      teams.addMember({ teamId: team.id, name: "Author" }),
      teams.addMember({ teamId: team.id, name: "Reviewer" }),
      teams.addMember({ teamId: team.id, name: "Planner", callWhen: ["field list", "thread summary"] })
    ];
    const backend = new FakeAgentBackend();
    const runtimeService = new RuntimeService(state, backend);
    await runtimeService.start({ teamId: team.id, maxParallel: members.length });

    const mailbox = new MailboxService(state);
    const root = mailbox.sendMessage({
      teamId: team.id,
      type: "question",
      subject: "Field list discussion",
      body: "Review the thread summary field list.",
      participantMemberIds: [members[0]!.id, members[1]!.id]
    });
    mailbox.sendMessage({
      teamId: team.id,
      fromMemberId: members[0]!.id,
      type: "opinion",
      body: "Keep the field list compact.",
      replyToMessageId: root.id
    });
    mailbox.consumeMessages({ teamId: team.id, memberId: members[0]!.id, messageIds: [root.id] });

    const thread = discussionThreads(state, team.id)[0]!;
    expect(thread).toMatchObject({
      lifecycleState: "collecting",
      actionabilityState: "none",
      pendingMemberIds: [members[1]!.id],
      owedMemberIds: [members[1]!.id],
      invitedMemberIds: [members[2]!.id],
      owedMemberNames: ["Reviewer"],
      invitedMemberNames: ["Planner"],
      participationSummary: "Author has responded; Reviewer still owes a reply; Planner is invited to weigh in.",
      turnSummary: "Waiting on Reviewer to reply while inviting Planner to weigh in.",
      turnTakingState: "waiting_required",
      nextResponsibleMemberIds: [members[1]!.id],
      nextResponsibleMemberNames: ["Reviewer"],
      nextTurnSummary: "Waiting on Reviewer to reply in the current round."
    });
    expect(thread.turnObligations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        memberId: members[1]!.id,
        kind: "participant_reply",
        trigger: "participant_obligation",
        required: true,
        priorityScore: 300
      }),
      expect.objectContaining({
        memberId: members[2]!.id,
        kind: "invited_opinion",
        trigger: "callWhen_match",
        source: "callWhen_match",
        required: false,
        priorityScore: 100
      })
    ]));
    expect(thread.nextTurns).toEqual(expect.arrayContaining([
      expect.objectContaining({
        memberId: members[1]!.id,
        memberName: "Reviewer",
        kind: "participant_reply",
        trigger: "participant_obligation",
        reason: expect.any(String),
        required: true,
        priorityScore: 300,
        expectedContribution: "reply"
      }),
      expect.objectContaining({
        memberId: members[2]!.id,
        memberName: "Planner",
        kind: "invited_opinion",
        trigger: "callWhen_match",
        reason: expect.stringContaining("callWhen"),
        required: false,
        priorityScore: 100,
        expectedContribution: "opinion"
      })
    ]));
  });

  it("does not invite non-participants too early while several required participant replies are still missing", async () => {
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "discussion-invite-gating" }).team;
    const members = [
      teams.addMember({ teamId: team.id, name: "Author" }),
      teams.addMember({ teamId: team.id, name: "Reviewer" }),
      teams.addMember({ teamId: team.id, name: "Tester" }),
      teams.addMember({ teamId: team.id, name: "Planner", callWhen: ["field list", "thread summary"] })
    ];
    const backend = new FakeAgentBackend();
    const runtimeService = new RuntimeService(state, backend);
    await runtimeService.start({ teamId: team.id, maxParallel: members.length });

    const mailbox = new MailboxService(state);
    const root = mailbox.sendMessage({
      teamId: team.id,
      type: "question",
      subject: "Field list discussion",
      body: "Review the thread summary field list.",
      participantMemberIds: [members[0]!.id, members[1]!.id, members[2]!.id]
    });
    mailbox.sendMessage({
      teamId: team.id,
      fromMemberId: members[0]!.id,
      type: "opinion",
      body: "Keep the field list compact.",
      replyToMessageId: root.id
    });
    mailbox.consumeMessages({ teamId: team.id, memberId: members[0]!.id, messageIds: [root.id] });

    const thread = discussionThreads(state, team.id)[0]!;
    expect(thread).toMatchObject({
      lifecycleState: "collecting",
      respondedMemberNames: ["Author"],
      pendingMemberIds: expect.arrayContaining([members[1]!.id, members[2]!.id]),
      owedMemberNames: ["Reviewer", "Tester"],
      invitedMemberIds: [],
      invitedMemberNames: [],
      participationSummary: "Author has responded; Reviewer and Tester still owe a reply."
    });
    expect(thread.turnObligations.every((obligation) => obligation.kind !== "invited_opinion")).toBe(true);
  });
});

async function setupDiscussionTeam() {
  const state = emptyState();
  const teams = new TeamService(state);
  const team = teams.createTeam({ name: "discussion-state" }).team;
  const members = [
    teams.addMember({ teamId: team.id, name: "Author" }),
    teams.addMember({ teamId: team.id, name: "Reviewer" })
  ];
  const backend = new FakeAgentBackend();
  const runtimeService = new RuntimeService(state, backend);
  const started = await runtimeService.start({ teamId: team.id, maxParallel: members.length });
  return {
    state,
    team,
    members,
    runtime: started.runtime
  };
}
