# Runtime API Design

## Purpose

This document defines the target public API and target internal state model for the runtime rewrite described in [runtime-rfc.md](runtime-rfc.md).

It intentionally describes the destination interface, not the current builder-only interface.

## API Principles

1. One product surface, not a builder API plus a hidden runtime API.
2. User-authored member creation stays conversational.
3. Runtime actions are explicit and inspectable.
4. Task, message, and lock state are first-class public runtime concepts.
5. Teammate sessions talk to the runtime through MCP tools, not through ad hoc prompt conventions.

## Team Semantics

Stage 14 adds a stricter product meaning for "team":

- Members have independent runtime sessions and should not depend on the host to relay every turn.
- Discussion is carried by mailbox threads, not by a new default tool and not by pretending discussion is task completion.
- The host starts or continues discussion through `team_work`, then observes thread state through `team_status`, `team_results`, or timeline.
- Scheduler conversation turns may wake idle members for pending direct or broadcast messages before assigning ordinary runnable tasks.
- Autonomy stays bounded: members respond inside scoped threads or explicit runtime prompts; there is no always-on global listening loop.

## Unified Tool Surface

## Quick Start

Start normal work with `team_work`, even before the team is finished.

Typical flow:

1. Start or resume team setup with `team_work`.
2. Continue `team_work` to save a member draft, confirm the current member, remove a member, or finish the team.
3. Continue `team_work` again to create or continue work.
4. Inspect progress with `team_status` or `team_results` only when you need more detail.
5. Reach for scheduler/runtime/task CRUD tools only for debugging, explicit manual control, recovery, or tests, and only when `TEAM_MCP_ENABLE_ADVANCED_TOOLS=1` is enabled.

Example:

```json
{
  "teamId": "team_x",
  "work": {
    "goal": "Implement the focused change",
    "pathHints": ["src/runtime/**"],
    "maxTicks": 3
  }
}
```

`team_work` is the preferred daily workflow surface. Lower-level builder/runtime tools remain available for debugging, explicit control, recovery, and tests behind `TEAM_MCP_ENABLE_ADVANCED_TOOLS=1`.

For the normal path, prefer the grouped `team`, `builder`, and `work` shape even when only one section is needed. Natural-language `request` can stay lightweight; structured fields are mainly for commit points and task/runtime continuation.

### Builder And Team Definition

The default product surface no longer makes the builder chain the first-run path. `team_work` now owns the conversational build loop and only uses minimal structured fields for commit points such as draft save, member confirmation, member removal, and team completion.

#### `team_start`

Starts or resumes a team definition session.

Input:

```json
{
  "teamName": "string",
  "hostName": "string?",
  "hostModel": "string?",
  "hostResponsibility": "string?",
  "notes": "string?"
}
```

Output:

```json
{
  "team": { "id": "team_x", "name": "example" },
  "build": { "status": "building", "confirmedMemberIds": [] },
  "runtime": { "status": "not_started" }
}
```

#### `team_draft`

Stores exactly one pending member draft.

Input:

```json
{
  "teamId": "team_x",
  "name": "Scope Keeper",
  "model": "openai/gpt-5.4",
  "rawResponsibility": "Keep scope clear.",
  "polishedPrompt": "Keep scope clear and challenge ambiguous expansion.",
  "permissions": ["read-only"],
  "callWhen": ["requirements are vague"],
  "doNot": ["edit files without explicit instruction"]
}
```

Output:

```json
{
  "draft": {
    "id": "draft_x",
    "agentId": "scope-keeper"
  },
  "checklist": {
    "name": "Scope Keeper",
    "model": "openai/gpt-5.4"
  }
}
```

#### `team_confirm`

Confirms the current draft and creates a runtime member definition.

Input:

```json
{
  "teamId": "team_x"
}
```

Output:

```json
{
  "member": {
    "id": "member_x",
    "agentId": "scope-keeper",
    "name": "Scope Keeper"
  },
  "build": {
    "confirmedMemberIds": ["member_x"]
  }
}
```

#### `team_remove_member`

Removes one confirmed member from the team definition or runtime, depending on current state.

Input:

```json
{
  "teamId": "team_x",
  "memberId": "member_x?",
  "agentId": "scope-keeper?",
  "name": "Scope Keeper?"
}
```

Output:

```json
{
  "member": {
    "id": "member_x",
    "name": "Scope Keeper"
  },
  "runtimeImpact": {
    "sessionStopped": true,
    "tasksReleased": ["task_x"]
  }
}
```

#### `team_finish`

Completes the builder phase and marks the team ready for runtime activation.

Input:

```json
{
  "teamId": "team_x"
}
```

Output:

```json
{
  "build": { "status": "finished" },
  "runtime": { "status": "ready" },
  "members": ["scope-keeper", "patch-builder"]
}
// Note: the current legacy code uses "finalized" for the build status.
// The runtime target renames this to "finished" for clarity.
```

### Runtime Control

#### `team_work`

Primary build-and-work entrypoint for normal OpenCode use. It can create or resume a team build, return builder guidance while the team is incomplete, and create or continue runtime tasks after the team is finished without making the user manually choose between builder steps, task creation, runtime start, scheduler run, status, and results tools.

Recommended input shape:

```json
{
  "teamId": "team_x?",
  "request": "Create a reviewer and patch builder for small code changes?",
  "team": {
    "teamName": "Focused Change Team",
    "hostName": "Lead"
  },
  "builder": {
    "draftMember": {
      "name": "Patch Builder",
      "model": "openai/gpt-5.4",
      "rawResponsibility": "Implement the patch.",
      "polishedPrompt": "Implement the patch and report changed files."
    }
  },
  "work": {
    "goal": "Implement the focused change",
    "pathHints": ["src/runtime/**"],
    "review": {
      "taskId": "task_x",
      "decision": "approve_scope_exception"
    },
    "priority": "high",
    "autoRun": true,
    "maxTicks": 3,
    "discussion": {
      "subject": "Architecture direction",
      "body": "Each member should share one concise opinion.",
      "taskId": "task_x?",
      "participantMemberIds": ["member_a", "member_b"],
      "maxTurns": 4,
      "autoRun": true,
      "replyToMessageId": "msg_x?",
      "hostDecision": {
        "decision": "Use the shared discussion-state helper and continue in the same thread.",
        "note": "Ask each member for one short acknowledgment."
      }
    },
    "includeDetails": false
  }
}
```

Backward-compatible legacy top-level fields such as `teamName`, `draftMember`, `confirmMember`, `finishTeam`, `goal`, and `taskId` are still accepted, but new callers should prefer the grouped `team`, `builder`, and `work` shape.

Contract note:

- the grouped `team` / `builder` / `work` shape is the default UX contract for docs, examples, first-run smoke, and entrypoint tests
- flat top-level fields remain accepted only as a compatibility boundary for older callers and stored examples
- `recommendedInput` should prefer the grouped shape even when the incoming call used flat compatibility fields

Semantics:

- omit `teamId` to let `team_work` create or resume the active team build
- use `request` for lightweight natural-language intent during team setup
- use `team` for team/build metadata, `builder` for explicit builder commits, and `work` for task/runtime continuation
- use `builder.draftMember`, `builder.confirmMember`, `builder.removeMember`, and `builder.finishTeam` as the minimal structured commit fields for builder actions
- when the team is incomplete or not yet created, `team_work` enters builder guidance mode and returns a compact `question`, `choices`, `nextPrompt`, and `recommendedInput`
- pass `work.goal` to create a new runtime task
- pass `work.taskId` to continue one existing task
- pass `work.review` to submit a host safety decision for an open signal without leaving the default `team_work` path
- pass `work.discussion` to start or continue a task-scoped or team-scoped mailbox discussion without leaving the default `team_work` path
- pass `work.discussion.hostDecision` to record a structured host judgment in the current thread and let the next bounded run continue from that same thread
- pass `work.discussion.commitToTask` to explicitly turn one settled discussion thread into task work from that same thread state; this is host-authored continuation, not silent auto-creation
- `work.discussion.commitToTask` keeps minimal input: title/description only. Execution defaults are chosen conservatively from existing `work.*` fields first, then the task-scoped source task when one is provable.
- after a task is completed, `recommendedInput` may propose a task-scoped review discussion with subject `Task review: <taskId>` when an eligible reviewer member can be derived from role text or `callWhen`; this is recommendation-first and never created by read-only status/results calls
- a completed task that came from a now-closed discussion should be evaluated as completed task work; the closed source discussion should not block review recommendation or pull host continuation back into the old thread
- review discussion follow-up uses the same settled-thread `work.discussion.commitToTask` contract when the review carries an explicit follow-up cue; accepting a settled review without follow-up remains a host interpretation, not a new public tool
- `recommendedInput` should point to one primary next step at a time: discussion commit, task continuation, review discussion, review continuation, or follow-up task continuation. Context fields inside that step are fine, but host guidance should not make the caller choose between task and discussion paths.
- pass neither `work.goal` nor `work.taskId` to continue existing runnable team work
- `work.autoRun` defaults to `true`; ready or stopped runtimes are started, running runtimes get a bounded scheduler run
- `work.discussion.autoRun` defaults to `work.autoRun`; `work.discussion.maxTurns` is the default bounded turn limit for that discussion call
- when `work.review` is present, that call records the review decision and returns updated guidance without running the scheduler in the same call
- paused or errored runtimes return focused task-flow guidance instead of hiding the state transition; a paused runtime resumes only when the host makes an explicit `team_work` call with `work.autoRun = true`
- `recommendedInput` may explicitly set `work.autoRun` to `false` when the current state suggests manual recovery or inspection before rerunning work
- `work.includeDetails` defaults to `false`; compact task/status output is the default, full control-plane/results/timeline details are opt-in
- `task_flow.explain` adds one compact runtime interpretation layer with `phase`, `headline`, `blockingReason?`, `recommendedNextAction`, `recoveryHint?`, and `lastMeaningfulEvent?` so callers can understand why work is stalled, active, or ready without parsing the full control plane

Default contract priority for host callers:

1. use `recommendedInput` as the next-call template when continuing builder or task-flow guidance
2. use `explain` as the shared recovery and inspection layer
3. use `compactStatus` / `compactResults` for first-screen cards when rendering host UI
4. fall back to richer raw fields only for drill-down, debugging, or specialized views

OpenCode TUI safety rendering contract:

- keep the default surface unchanged; safety stays additive through `controlPlane.safety`, `explain.safety?`, `compactStatus.safety?`, and `compactResults.safety?`
- `safety.headline` should state the boundary or action that triggered the signal
- `safety.recommendedAction` should be the exact host follow-up to take next, typically a `team_work.work.review` decision
- warning-level safety should stay visible, but it should not override stronger blocked or recovery guidance in `headline`, `blockingReason`, `supportingLine`, `nextAction`, or `recommendedNextAction`
- `recommendedInput.work.autoRun = false` remains reserved for blocked safety, needs-review safety, failed work, paused or errored runtime state, broken claimed sessions, unread host-attention states, or other explicit recovery stops
- the safety baseline is judged by real OpenCode TUI readability plus env-gated live safety smoke, not by offline state correctness alone

Host safety review loop:

- `work.review.decision = "revise_scope"` updates a pending task's `pathHints` and closes the related `scope_missing` warning
- `work.review.decision = "approve_scope_exception"` resolves one open `scope_warning` without rewriting the task boundary
- `work.review.decision = "acknowledge"` closes the current signal for manual follow-up; acknowledging a `policy_blocked` signal does not change member permissions and leaves a persistent manual-follow-up safety state until the task is updated or reaches a terminal status
- `work.review.decision = "cancel_task"` cancels the task and closes task-scoped safety state
- `task_flow.reviewResult?` reports which signal was reviewed, which signals were resolved, and the immediate next action

After a `policy_blocked` acknowledge:

- default host views should keep `recommendedInput.work.autoRun = false`
- `recommendedInput` should stop suggesting another review payload for the same acknowledged signal
- the next host action should be manual continuation or a permission/task adjustment, not another automatic rerun

Recovery note:

- `explain.continuation?` and the matching compact `continuation?` field are additive host hints for the next recovery direction
- current continuation kinds are `resume_same_task`, `recover_session_then_retry`, `review_before_continue`, and `create_followup_task`
- `recommendedInput` should align with that continuation kind instead of only echoing the latest blocker text

Discussion note:

- discussions are mailbox threads, not tasks
- new messages carry `threadId`; replies keep the same thread through `replyToMessageId`
- delivery state is per member through `messageDeliveries`, so broadcast discussion remains unread for each member until that member consumes or acknowledges it
- implicit delivery is action-oriented: broadcast `question`, `handoff`, `notification`, and `escalation` messages create per-member deliveries by default, while ordinary broadcast `opinion` and `result` messages remain visible in the thread without automatically creating inbox work
- scheduler conversation turns prompt idle members to respond through mailbox tools before ordinary runnable task assignment
- `team_status`, `team_results`, and `team_timeline` expose active threads and opinions for inspection
- active thread state is derived from mailbox threads rather than stored in a separate entity:
  - the derived state is current-round aware: the latest host-authored actionable thread message starts the active round, so old escalations or opinions do not keep the thread stuck after a host decision
  - `expectedMemberIds` comes from per-member deliveries, falling back to current active team members only when no delivery exists yet
  - `respondedMemberIds` comes from member-authored thread messages such as `opinion`, `question`, `handoff`, `result`, and `notification`
  - `turnObligations` is the stronger turn-taking layer: each entry records which member owes or is invited to a turn, that member's readable name when available, why, which message anchors that turn, whether it is required, and whether it comes from delivery state, thread state, or conservative `callWhen` matching
  - `turnObligations[].trigger` explains why this member is being woken: `direct_message | participant_obligation | callWhen_match | host_decision_follow_through | unresolved_question_follow_up`
  - `turnObligations[].priorityScore` is derived from the trigger and is the main scheduler ordering input: direct message `500`, unresolved teammate follow-up `450`, host-decision follow-through `400`, required participant reply `300`, optional `callWhen` invitation `100`
  - `nextTurns` is the compact host-facing version of `turnObligations`; each entry includes member id/name, kind, trigger, reason, required flag, priority score, and `expectedContribution: reply | opinion | acknowledge_or_opinion`
  - `turnTakingState` is the compact current-round scheduling posture: `blocked_by_host | waiting_follow_up | waiting_required | inviting_optional | settled | none`
  - `nextResponsibleMemberIds`, `nextResponsibleMemberNames`, and `nextTurnSummary?` describe the highest-priority current obligations only; optional invited opinions should not hide required participant or follow-up turns
  - `actionabilityState` is the settled-thread handoff posture: `none | follow_up_discussion | ready_for_task | waiting_host_commit`
  - `suggestedActionSummary` is the low-noise host-facing closure line derived from thread facts
  - `suggestedTaskTitle?` and `suggestedTaskDescriptionPreview?` are conservative execution cues; they are previews for host continuation, not created tasks
  - `actionSourceMessageIds` records which thread messages justified the current actionability state
  - a later host-authored `Host committed task: ...` notification should close the discussion so the thread can show that follow-up work already exists
  - `committedTaskId?`, `committedTaskTitle?`, and `commitMessageId?` are derived from that host commit notification and the created task; they are lightweight linkage, not a stored Discussion entity
  - `closureReason?`, `closedAtMessageId?`, and `closedTaskId?` are also derived from the same commit notification; initial closure support means `closureReason = committed_to_task`
  - `respondedMemberNames` is the host-readable counterpart of `respondedMemberIds`
  - `owedMemberIds` is the unique set of required turn obligations
  - `owedMemberNames` is the host-readable counterpart of `owedMemberIds`
  - `invitedMemberIds` is the unique set of lightweight invited-opinion turns
  - `invitedMemberNames` is the host-readable counterpart of `invitedMemberIds`
  - `participationSummary?` is the fact-based named round-progress line: who has responded, who still owes a reply, and whether another member is only invited to weigh in
  - `pendingMemberIds` remains the compatibility summary for required replies; scheduler and inbox summaries should prefer `turnObligations` / `owedMemberIds`
  - invited turns are promptable runtime turns, not just labels in status: a member with an `invited_opinion` obligation may receive a mailbox-style conversation prompt even while required participant replies are still pending
  - invited turns stay constrained during `collecting`: the runtime should not invite extra members while several required participant replies are still missing and the round has not yet developed beyond a single early response
  - `latestOpinions` keeps one latest `opinion` per member
  - `currentRoundTurns` is the structured active-round message chain, with per-turn `bodyPreview`, readable `fromMemberName?` / `toMemberName?`, anchor marking, and whether that anchor is currently waiting on member response or host decision
  - `unresolvedQuestionCount` means a thread question still lacks a later thread reply from the expected responder
  - `needsHostDecision` means the thread has escalated to the host, still has an unresolved unaddressed question after member replies, or has multiple member opinions plus an unresolved question
  - `lifecycleState` is `open | collecting | contested | settled | closed`; `closed` currently means the discussion has been committed into task work
  - `disagreementState` is `none | possible | needs_resolution`
  - `disagreementSummary?` stays conservative and fact-based; it should describe only provable signals such as unresolved questions, multi-member opinions, or host escalation
  - `proposedNextAction` is the shared continuation contract for status, results, scheduler, and `team_work`: `wait_for_members | prompt_member | continue_discussion | host_decision | summarize_conclusion | none`
  - `conclusionSummary?` is only derived for settled rounds; it prefers the latest host decision body preview, otherwise a conservative counted summary
  - `resolutionState` is `not_started | forming | blocked | resolved`, derived from the same mailbox-thread facts
  - `synthesis` is the host-facing fact summary for the current round: `headline`, `summary`, `resolutionState`, `memberSummaries`, `openIssueSummary?`, and `nextActionSummary`
  - `synthesis.memberSummaries` includes current relevant members with `memberId`, `memberName`, `status: responded | owed | invited`, and latest current-round message preview when available
  - `synthesis` is not semantic stance analysis, LLM summarization, or a persisted discussion entity; it is recomputed from thread facts
- `team_work` continuation uses the same derived state:
  - bounded progress may stop with `needs_attention` when the active discussion is ready for host judgment
  - bounded progress may continue through contested-but-not-host-decision rounds so members can resolve the thread inside mailbox turns
  - bounded progress may also keep polling across short idle gaps when the active round is still waiting for member replies and this run already prompted discussion turns, so in-flight mailbox replies can settle the round without an extra host rerun
  - async mailbox turns can remain visible as waiting session state until the member replies or acknowledges the prompted message
  - a host decision message can move the same thread back to `waiting_for_members` or `settled` instead of leaving the old escalation as the active state
  - `recommendedInput.work.discussion.replyToMessageId` should follow the latest message in the thread
  - when `actionabilityState = ready_for_task` or `waiting_host_commit` and there is no stronger task continuation in flight, `recommendedInput` may stay inside `work.discussion` and prefill `commitToTask`
  - commit inheritance order is: explicit `work.pathHints` / `work.preferredMemberId` / `work.priority`; then `work.discussion.taskId`; then the thread's task id; then top-level `work.taskId`; then no inherited execution default. Explicit `pathHints: []` means do not inherit source paths, and inherited preferred members must still be active.
  - after commit, `recommendedInput` should point to `work.taskId = committedTaskId` with `work.autoRun = false` and should not recommend another `work.discussion.commitToTask`
  - closed discussions should not create new discussion turns or invitations; continuation moves through the created task
  - `work.discussion.commitToTask` should keep `work.autoRun = false` by default unless the host explicitly chooses to keep moving after the commit
  - discussion conclusions remain discussion state; task delivery remains owned by task completion/failure/result state
  - when `needsHostDecision` is true, `recommendedInput.work.autoRun` should be `false`
  - scheduler conversation turns should prefer current-round actionable messages plus `proposedNextAction`, rather than every unread opinion delivery in the thread
  - scheduler conversation prompts include member role, lifecycle, turn state, trigger, reason, expected contribution, and whether the turn is required; this is the runtime's constrained speaking window, not free-form autonomous chatter

Output:

When `request` includes a clear role word such as `reviewer`, `tester`, or `writer`, the placeholder draft may lightly adapt while still staying user-authored and editable.

```json
{
  "mode": "builder_guidance",
  "team": { "id": "team_x", "name": "example" },
  "build": { "status": "building", "confirmedMemberIds": [] },
  "question": "Draft the first teammate for: Create a reviewer teammate for small patches. Fill in the name, model, and role you want.",
  "choices": [
    { "label": "Draft first member", "value": "draftMember" }
  ],
  "nextPrompt": "Continue team_work for team team_x. Draft the first teammate for: Create a reviewer teammate for small patches. Fill in the name, model, and role you want.",
  "recommendedInput": {
    "teamId": "team_x",
    "builder": {
      "draftMember": {
        "name": "Your Reviewer Name",
        "model": "your/model",
        "rawResponsibility": "Describe how you want this teammate to review changes.",
        "polishedPrompt": "Write the review prompt you want this teammate to follow."
      }
    }
  },
  "statusSummary": "Team team_x is building with 0 confirmed members.",
  "members": []
}
```

```json
{
  "mode": "task_flow",
  "task": { "id": "task_x", "status": "claimed" },
  "runtime": { "status": "running" },
  "schedulerRun": { "ticksRun": 1, "totalAssignments": 1, "stoppedReason": "idle" },
  "view": {
    "summary": "Task task_x is claimed; runtime is running; scheduler assignments: 1.",
    "taskStatus": "claimed",
    "runnableCount": 0,
    "activeCount": 1,
    "completedCount": 0,
    "failedCount": 0,
    "blockedCount": 0,
    "unreadMessageCount": 0
  },
  "explain": {
    "phase": "running",
    "headline": "1 active task; 0 runnable next.",
    "recommendedNextAction": "No action needed.",
    "lastMeaningfulEvent": {
      "type": "scheduler.tick",
      "message": "Assigned 1 task(s)",
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  },
  "nextActions": ["No immediate host action detected from runtime state."],
  "nextPrompt": "Continue team_work for task task_x. No immediate host action detected from runtime state.",
  "recommendedInput": {
    "teamId": "team_x",
    "work": {
      "taskId": "task_x"
    }
  }
}
```

Advanced/manual note:

```bash
TEAM_MCP_ENABLE_ADVANCED_TOOLS=1
```

With that env flag, the legacy default builder/runtime controls such as `team_start`, `team_draft`, `team_confirm`, `team_finish`, `team_run`, scheduler controls, task CRUD, mailbox controls, and recovery/debug tools remain registered for manual workflows, recovery, and tests.

Scheduler-assigned member prompts are intentionally compact. They are task cards, not runtime manuals: member/task ids, goal/details, path hints, task-scoped messages, relevant active locks, a short allowed/denied tool summary, and finish/fail/help instructions. The full runtime tool surface remains documented here and available through MCP, but should not be copied into every task prompt.

OpenCode workflow guidance: host-facing tools such as scheduler controls, task CRUD, mailbox, locks, timeline, results, status, and recovery remain available for inspection, debugging, explicit manual control, and tests. Agent-facing tools such as `complete_task`, `fail_task`, `send_message`, `lock_paths`, and `ask_lead` are for runtime-owned teammate sessions, not the default human-facing workflow.

Real OpenCode dogfood for this path lives in the env-gated smoke suite. Run it only when live OpenCode/model access is intended:

```bash
TEAM_MCP_REAL_OPENCODE_SMOKE=1 npm test -- tests/runtime.opencode.smoke.test.ts
```

Current stable expectation for that live suite is intentionally concrete:

- `team_work` can drive team creation end to end instead of relying on the advanced builder tools as the primary host path
- the default main model remains the host-facing operator, not an automatically created runtime `leadMember`
- confirmed teammates become runtime-owned OpenCode members with independent backend sessions rather than local subagents
- `ask_lead` remains valid even without an explicit runtime lead member; in that default case, the escalation is host-facing rather than routed to a teammate session
- cross-session mailbox/message flows are proven against live OpenCode behavior, not only against fake backends

Host-versus-lead contract:

- `host` metadata describes the main model or operator coordinating the team
- the default `team_work` / `team_start` path records that host metadata but does not create a runtime-owned member for it
- `leadMemberId` is only set when a real team member is explicitly created with role `lead`
- when a lead member does exist, that member may have its own runtime session like any other teammate
- host-facing status/result surfaces should therefore distinguish `host_only` routing from `explicit_lead_member` routing instead of implying they are the same thing

#### `team_run`

Advanced/manual control: starts runtime-managed teammate sessions.

Input:

```json
{
  "teamId": "team_x",
  "backend": "opencode",
  "workdir": "C:/repo",
  "maxParallel": 3,
  "autoAssign": true
}
```

Output:

```json
{
  "runtime": {
    "status": "running",
    "backend": "opencode",
    "sessionCount": 2
  },
  "sessions": [
    { "memberId": "member_a", "status": "idle" },
    { "memberId": "member_b", "status": "idle" }
  ]
}
```

#### `team_stop`

Stops all or selected runtime sessions.

Input:

```json
{
  "teamId": "team_x",
  "memberIds": ["member_a"],
  "reason": "manual stop"
}
```

#### `team_pause`

Pauses scheduling without destroying sessions.

#### `team_resume`

Resumes scheduling after pause.

#### `team_scheduler_tick`

Advanced/manual control: runs one deterministic scheduler tick.

For store-backed MCP use, the tick is executed in split phases: preparation claims runnable tasks in a short transaction, backend prompting runs outside the store lock, and prompt finalization records assignment/error state in follow-up transactions. This lets a scheduler-assigned teammate call mutating runtime MCP tools such as `complete_task` during the prompt.

#### `team_scheduler_run`

Advanced/manual control: runs bounded deterministic scheduler ticks until the team is idle, paused, an error is returned, attention is required, a timeout is reached, or `maxTicks` is reached.

Input:

```json
{
  "teamId": "team_x",
  "maxTicks": 5,
  "timeoutMs": 5000,
  "rethrowOnError": false
}
```

Output:

```json
{
  "ticksRun": 2,
  "totalAssignments": 1,
  "stoppedReason": "idle",
  "decisions": [
    { "assignments": [{ "taskId": "task_x" }], "decision": "Assigned 1 task(s)" },
    { "assignments": [], "decision": "No runnable assignments" }
  ]
}
```

`stoppedReason` may be `idle`, `paused`, `max_ticks`, `timeout`, `error`, or `needs_attention`.

When `rethrowOnError` is omitted or `false`, scheduler/backend failures are returned as structured bounded-run results. When `rethrowOnError` is `true`, the tool rethrows the underlying error instead.

This is not an always-on daemon. It is a bounded host-invoked runner over the same split scheduler execution path used by `team_scheduler_tick`.

#### `team_recover_sessions`

Releases or clears work held by error, stopped, or stale teammate sessions.

Input:

```json
{
  "teamId": "team_x",
  "sessionIds": ["session_x"],
  "staleAfterMs": 900000,
  "releaseClaimedTasks": true,
  "replaceSessions": true,
  "reason": "backend session disappeared"
}
```

Output:

```json
{
  "recoveredSessions": [{ "id": "session_x", "status": "stopped" }],
  "replacedSessions": [{ "id": "session_y", "status": "idle" }],
  "releasedTasks": [{ "id": "task_x", "status": "pending" }],
  "actions": [
    {
      "sessionId": "session_x",
      "taskId": "task_x",
      "action": "released_claimed_task",
      "reason": "Task was claimed by an error, stopped, or stale session."
    },
    {
      "sessionId": "session_y",
      "action": "replaced_session",
      "reason": "Created a replacement session for the recovered member."
    }
  ]
}
```

This is the Stage 7C recovery primitive. It does not pretend to checkpoint or rewind model state. It makes runtime state recoverable by marking stale working/waiting sessions as errored, releasing claimed tasks back to `pending`, releasing task-scoped path locks owned by the affected session member, and recording `session.stale` / `session.recovered` events for timeline inspection.

When `replaceSessions` is true, recovery also starts the configured backend if needed and creates a fresh idle session for each recovered member. Replacement is explicit because it talks to the backend; state-only recovery remains available when the host only wants to release stranded work. Replacement records `session.started` through the normal spawner path and an additional `session.replaced` event so the timeline can explain why the new session exists.

### Task Runtime Tools

#### `team_task_create`

Creates a runtime task.

Input:

```json
{
  "teamId": "team_x",
  "title": "Implement runtime status view",
  "description": "...",
  "dependencyTaskIds": ["task_a"],
  "pathHints": ["src/runtime/**"],
  "preferredMemberId": "member_x?",
  "priority": "high"
}
```

#### `team_task_update`

Edits title, description, dependency graph, or preferred assignee.

#### `team_task_cancel`

Cancels a task.

#### `team_assign`

Explicitly assigns or reassigns a task.

#### `team_tasks`

Lists tasks by state.

### Messaging Tools

#### `team_message`

Sends a message into the runtime mailbox.

Input:

```json
{
  "teamId": "team_x",
  "fromMemberId": "member_a?",
  "toMemberId": "member_b?",
  "taskId": "task_x?",
  "type": "question",
  "subject": "Need API shape",
  "body": "Please confirm the response schema."
}
```

#### `team_inbox`

Lists inbox entries for a member.

#### `team_ack`

Acknowledges a message.

#### `team_timeline`

Shows recent events, messages, scheduler decisions, and task-scoped collaboration threads.

Stage 7B makes this an explanatory timeline, not just an event list. The legacy top-level `events`, `messages`, and `scheduler` fields remain, and the tool also returns:

- `entries`: recent events and messages merged into one chronological stream
- `taskThreads`: recent tasks with task-scoped events, messages, locks, sessions, and a short `statusReason`
- `policy`: recent `policy.blocked` and `policy.warning` events
- `sessionEvents`: recent session lifecycle/error events

Use this tool to answer how the team reached the current state: which task was claimed, what messages were exchanged, what policy or session events occurred, and why a task is completed, failed, blocked, claimed, or runnable.

### Runtime Inspection Tools

#### `team_status`

Becomes a full runtime status view rather than a builder-only status view.

The default host-facing status output preserves builder-era fields while adding the runtime control plane. This keeps the conversational builder UX usable, but the canonical runtime inspection shape is the `controlPlane` object.

Expected top-level sections:

- team metadata
- build state
- runtime state
- session list
- task buckets
- unread messages by member
- active path locks
- recent events
- `controlPlane`

`controlPlane` is the Stage 7A team runtime status view. It is also returned by `team_runtime_status` so the runtime API and builder-compatible status API do not drift.

`team_status` also returns a compact `explain` object so callers can read one short interpretation before diving into `controlPlane` details. It uses the same fields as `team_work.task_flow.explain`:

- `phase`: one of `building`, `ready`, `running`, `attention`, or `idle`
- `headline`: the most important current state summary
- `blockingReason`: the first concrete blocker when one exists, such as a failed task, blocked dependency, or unread message
- `recommendedNextAction`: the top next host action derived from the control plane
- `recoveryHint`: a short recovery-oriented hint for paused, errored, failed, blocked, or unread-message states
- `lastMeaningfulEvent`: the latest relevant event for quick inspection

For host UIs such as OpenCode TUI, `team_status` also returns `compactStatus`: an additive render-friendly summary derived from the existing team identity, `explain`, and `controlPlane` fields. It is meant for first-screen cards and collapsed sections, not as a replacement for the richer raw status payload.

Expected `controlPlane` sections:

- `sessionBuckets`: sessions grouped by `starting`, `idle`, `working`, `waiting`, `completed`, `error`, and `stopped`
- `taskBuckets`: tasks grouped by `pending`, `runnable`, `blockedByDependency`, `claimed`, `completed`, `failed`, and `cancelled`
- `activeWork`: working or waiting sessions with their current task when known
- `inbox`: unread message counts per member plus recent message threads needing attention
- `locks`: active path locks annotated with `isExpired`
- `policy`: recent `policy.blocked` and `policy.warning` events
- `scheduler`: scheduler pause and last-decision state
- `nextActions`: suggested host/lead actions derived from runtime state

Pending tasks appear in `taskBuckets.pending`; they are also classified into either `taskBuckets.runnable` or `taskBuckets.blockedByDependency`. Blocked tasks include `blockReasons` such as incomplete or missing dependencies.

Discussion thread summaries inside `controlPlane.inbox.activeThreads` should expose:

- `threadId`
- `subject?`
- `taskId?`
- `state`: `waiting_for_members | in_discussion | ready_for_host | settled | closed`
- `lifecycleState`: `open | collecting | contested | settled | closed`
- `disagreementState`: `none | possible | needs_resolution`
- `resolutionState`: `not_started | forming | blocked | resolved`
- `disagreementSummary?`
- `proposedNextAction`
- `conclusionSummary?`
- `synthesis`
- `currentRoundSummary`
- `currentRoundMessageCount`
- `currentRoundAnchor?`
- `currentRoundTurns`
- `expectedMemberIds`
- `respondedMemberIds`
- `pendingMemberIds`
- `turnObligations`
- `owedMemberIds`
- `owedMemberNames`
- `invitedMemberIds`
- `invitedMemberNames`
- `turnSummary?`
- `latestOpinions`
- `unresolvedQuestionCount`
- `needsHostDecision`
- `latestMessage?`
- `latestOpinion?`

`controlPlane.inbox` should also expose low-noise discussion rollups for the first host screen:

- `discussionProgressSummary?`: what the current discussion round is waiting on or has just achieved
- `discussionHostAttentionSummary?`: only present when the current discussion round now needs host judgment
- `activeConversationTurns`: waiting session-owned mailbox turns, including which member is still handling which message/thread and, when available, which turn-obligation kind and trigger caused that prompt
- active conversation turns should also expose the obligation `priorityScore` when the turn came from a discussion obligation

`team_work`, bounded-run stop reasons, and compact host guidance should prefer these rollups over rebuilding separate discussion wording from raw thread counters.

Scheduler conversation selection should also prefer each thread's `currentRoundAnchor` when prompting a pending member, and member-facing conversation prompts should include the current-round summary plus `Trigger: ...` and `Reason: ...` lines so replies stay grounded in the same discussion turn.

Bounded-run discussion policy should stay asymmetric:

- `ready_for_host` stops immediately and returns control to the host
- `waiting_for_members` may continue across brief idle polls when the runtime has already issued the relevant discussion prompts in the same bounded run
- `waiting_follow_up` and `waiting_required` may keep bounded progress alive briefly; `inviting_optional` alone should not force extra idle polling
- ordinary idle remains a valid stop once there is no host-decision blocker and no in-flight discussion turn worth waiting on

#### `team_runtime_status`

Returns runtime state and session records without builder metadata, plus the same `controlPlane` object used by `team_status`.

Use this when a caller wants the runtime control view directly and does not need team-builder fields. Do not add a separate runtime-status schema here; status semantics should stay shared with `team_status.controlPlane`.

#### `team_results`

Returns completed task outputs, failed task outputs, result messages, and member summaries.

Stage 7B adds task-linked result explanations while preserving the existing top-level fields:

- `completedTasks`: recently completed tasks
- `failedTasks`: recently failed tasks
- `resultMessages`: recent mailbox messages with type `result`
- `sessionSummaries`: sessions with a `lastResultSummary`
- `taskResults`: completed and failed tasks linked to task-scoped result messages, task events, assigned session, summary, and artifacts
- `taskResults[].review`: derived task review state for completed tasks, with `reviewState`, reviewer ids/names, optional `reviewThreadId`, optional `reviewActionSummary`, and optional `followUpTaskId`; review state is derived from task-scoped discussion messages and tasks, not persisted as a Review entity
- `failuresNeedingAttention`: failed task result summaries that should be reviewed before retry or reassignment
- `memberContributions`: compact per-member attribution including contributed session ids, completed task ids, failed task ids, result message ids, and an optional latest contribution summary; when a member only contributes through runtime result messages, their runtime session ids should still be included when available
- `explain`: the same compact status interpretation used by `team_status`, plus `resultSummary` and optional `failureSummary` so the latest outcome is readable without traversing the full results payload; when the latest completed or failed task can be attributed, `headline` and `resultSummary` include the contributing member name

For host UIs such as OpenCode TUI, `team_results` also returns `compactResults`: an additive render-friendly summary derived from `explain`, recent task results, and `memberContributions`. It is intended to make a useful first-screen result card easy to render without removing the richer task/result details.

When discussion is present, compact host views should stay concise:

- `compactStatus.discussion.currentRoundTurns` and `compactResults.latestDiscussion.currentRoundTurns` are previews of the active round chain rather than full-thread transcripts
- `compactResults.latestTask.review` is the render-friendly version of the derived task review state; it should be shown as review guidance or linkage, not as a replacement for the task result summary
- `compactStatus.discussion` and `compactResults.latestDiscussion` should surface `lifecycleState`, `disagreementSummary?`, and `proposedNextAction` directly
- `compactStatus.discussion` and `compactResults.latestDiscussion` should surface `resolutionState` and `synthesis` directly, so host UI can render team-readable state without rebuilding it from raw message counters
- `compactStatus.discussion` and `compactResults.latestDiscussion` should also surface `owedMemberIds`, `owedMemberNames`, `invitedMemberIds`, `invitedMemberNames`, and `turnSummary?` so host UI can explain who still owes a turn and when the runtime invited another member into the thread
- `compactStatus.discussion` and `compactResults.latestDiscussion` should also surface `turnTakingState`, `nextResponsibleMemberIds`, `nextResponsibleMemberNames`, and `nextTurnSummary?` so host UI can explain who is next and why without re-sorting obligations
- `compactStatus.discussion` and `compactResults.latestDiscussion` should also surface `respondedMemberNames` and `participationSummary?` so host UI can see who has already spoken in the current round without replaying the thread
- `compactStatus.discussion` and `compactResults.latestDiscussion` should also surface `actionabilityState`, `suggestedActionSummary`, `suggestedTaskTitle?`, and `suggestedTaskDescriptionPreview?` so host UI can show whether a settled discussion is merely closed or already ready to become work
- `compactResults.latestDiscussion.conclusionSummary?` should appear only when the latest discussion round is settled
- richer thread history remains in `controlPlane.inbox.activeThreads`, `team_results.discussionThreads`, and `team_timeline.discussionThreads`

Live validation note:

- env-gated OpenCode smoke should cover both ordinary participant replies and at least one invited-opinion turn inside a live `team_work` discussion thread
- env-gated OpenCode smoke should also cover a longer same-thread chain where invited participation is followed by a later required participant reply, a host decision message, and member follow-through in the next round

Use `team_results` when the host/lead needs to review deliverables or failures. Use `team_timeline` when the host/lead needs the collaboration path that produced those results.

#### OpenCode TUI UI Contract

OpenCode TUI is the primary host UI consumer for the compact host views. Treat `compactStatus` and `compactResults` as the first-choice card inputs for the default host display, while keeping `explain`, `controlPlane`, and full result payloads available for drill-down, debugging, and future richer panes.

This contract is not only a field map. It is also a product constraint: if a compact view is technically complete but still feels noisy, unclear, or high-friction in real OpenCode TUI use, that should be treated as a host-experience bug rather than as proof that the contract is already good enough.

These compact views also carry bounded-progress summaries. They remain the preferred place to add only the smallest safety/isolation signals the host needs for first-screen understanding.

Scope and intent:

- `compactStatus` and `compactResults` are additive convenience views, not new tools and not replacements for the richer raw payloads
- the TUI should prefer these compact views for summary cards, list rows, and collapsed sections
- when a compact field is missing, the TUI should fall back to the richer sibling payload instead of treating that as an error
- the TUI should not re-derive its own primary headline or next action when the compact view already provides one
- `supportingLine` is the preferred second line for a compact card; it should usually be rendered before raw counters or expanded details
- `emptyState`, when present, is the preferred neutral placeholder instead of synthesizing one from lower-level buckets
- the default view should optimize for low-noise task continuation, not for exposing every available runtime datum on first render
- if a host needs raw runtime buckets to understand the default state, the compact host layer is still underspecified

OpenCode TUI product expectations:

- the default first-screen view should make it obvious what the team is doing, why it stopped or is blocked, and what the host should do next
- bounded-progress, safety, and recovery signals should read clearly in the TUI without forcing the host to mentally reconstruct state from raw counters
- visual density should stay low enough that `headline`, `supportingLine`, and the primary next action remain scannable during normal task flow
- compact cards should be judged by real OpenCode TUI dogfood, not only by whether their fields are populated in tests

Recommended `team_status` card mapping:

- title: `compactStatus.team.name`
- phase badge: `compactStatus.phase`
- main headline: `compactStatus.headline`
- supporting line: `compactStatus.supportingLine`
- current task row: `compactStatus.currentTask.title` plus `compactStatus.currentTask.status` and optional `assignedMemberName`
- blocker list: `compactStatus.blockers`
- empty-state copy when there is no current task: `compactStatus.emptyState`
- activity counters: `compactStatus.recentActivity.activeTaskCount`, `unreadMessageCount`, `failedTaskCount`, and `blockedTaskCount`
- primary CTA / footer action: `compactStatus.nextAction`

Recommended `team_results` card mapping:

- title: `compactResults.team.name`
- phase badge: `compactResults.phase`
- main headline: `compactResults.headline`
- top result summary: `compactResults.topResult`
- supporting line: `compactResults.supportingLine`
- latest task row: `compactResults.latestTask.title`, `status`, optional `memberName`, and optional `summary`
- member summary list: `compactResults.memberInvolvement`
- empty-state copy when there is no latest task/result: `compactResults.emptyState`

Recommended visual priority for OpenCode TUI:

1. Render `headline` as the primary line.
2. Render `supportingLine` as the default second line.
3. Render `nextAction` or `topResult` as the strongest actionable/supporting footer line.
4. Render blockers or latest task details beneath that.
5. Keep raw `controlPlane`, `taskResults`, `memberContributions`, and `timeline` data behind an expanded detail view instead of the default collapsed card.

This priority order is intentional. The OpenCode TUI default should help the host continue or inspect work with minimal cognitive overhead, rather than behaving like a runtime debugger by default.

Recommended phase treatment:

- `building`: show setup-in-progress styling and keep the primary action focused on finishing team definition
- `ready`: show work-ready or blocked-ready styling; do not imply active execution unless a current task row proves it
- `running`: show active execution styling
- `attention`: use warning/error styling and visually promote blockers, failures, or recovery guidance
- `idle`: show neutral styling with the next action still visible

Fallback rules for OpenCode TUI:

- if `compactStatus` is absent, fall back to `explain.headline`, `explain.recommendedNextAction`, `controlPlane.activeWork[0]`, and the task bucket counts
- if `compactResults` is absent, fall back to `explain.headline`, `explain.failureSummary ?? explain.resultSummary`, `taskResults[0]`, and `memberContributions`
- if `compactStatus.blockers` is empty but `explain.blockingReason` exists, display that single blocking reason
- if `compactResults.latestTask` is absent, render only `headline` and `topResult`
- if `supportingLine` is absent in either compact view, fall back to `nextAction` for status or `topResult` for results

Validation standard for OpenCode TUI:

- env-gated real OpenCode smoke is useful for proving live backend behavior, including independent teammate backend sessions and mailbox/handoff round-trips, but it is not by itself enough to declare the host UI successful
- the host contract should also be exercised through real end-to-end OpenCode TUI task flows
- confusing wording, missing continuation guidance, and noisy default cards should be treated as product bugs even when the underlying runtime state is correct

Non-goals for this contract:

- do not add a teammate-switching pane requirement
- do not require OpenCode TUI to expose every raw runtime bucket by default
- do not make the TUI infer recovery policy from low-level runtime state when the compact view already expresses the host-facing action
- do not treat raw JSON completeness as a substitute for real TUI readability

#### `team_models`

Still returns available models, but is now a runtime support tool rather than an OpenCode scaffold helper.

## Agent-Facing Tool Surface

Teammate sessions need their own MCP tool contract.

These tools are called by runtime-owned agents, not primarily by the human host.

### `claim_task`

Claim one pending task.

### `complete_task`

Mark a claimed task complete and attach a result summary.

### `fail_task`

Report task failure with error details, allowing scheduler retry or escalation.

### `send_message`

Send a direct or broadcast message.

### `inbox`

Read mailbox messages.

### `ack_message`

Confirm message consumption.

### `lock_paths`

Acquire path locks before editing.

### `unlock_paths`

Release locks.

### `team_self_status`

Return the current member's runtime context:

- active task
- unread inbox count
- held path locks
- current session state

### `ask_lead`

Escalate to the human-facing host when a member needs clarification.

## Domain Model Changes

### Existing Entities To Keep

- `Team`
- `Member`
- `Task`
- `Message`
- `PathLock`
- `Event`

### Builder State Naming

The OpenCode-specific builder structures are no longer runtime domain types. Stage 9C completes this cleanup by keeping only team-native type names for the builder flow:

- `TeamBuildHost`
- `TeamMemberDraft`
- `TeamBuild`

New state persists builder progress only under `teamBuilds`. Historical files that contain `openCode.builds` are still accepted as migration input and are normalized into `teamBuilds` on read, but new writes do not persist `openCode`.

Runtime-first builder code and legacy scaffold compatibility code should both go through the team-native builder-state facade. The legacy `openCodeBuilds(...)` adapter remains only as a compatibility boundary name over `teamBuilds(state)`.

### New Core Types

```ts
export type RuntimeStatus =
  | "not_started"
  | "ready"
  | "running"
  | "paused"
  | "stopped"
  | "error";

export type AgentSessionStatus =
  | "starting"
  | "idle"
  | "working"
  | "waiting"
  | "completed"
  | "error"
  | "stopped";

export interface TeamRuntime {
  teamId: string;
  status: RuntimeStatus;
  backend: "opencode";
  workdir?: string;
  maxParallel: number;
  autoAssign: boolean;
  startedAt?: string;
  stoppedAt?: string;
  updatedAt: string;
}

export interface AgentSessionRecord {
  id: string;
  teamId: string;
  memberId: string;
  backend: "opencode";
  backendSessionId?: string;
  status: AgentSessionStatus;
  currentTaskId?: string;
  lastHeartbeatAt?: string;
  lastResultSummary?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SchedulerState {
  teamId: string;
  paused: boolean;
  lastTickAt?: string;
  lastDecision?: string;
  updatedAt: string;
}
```

### Task State Expansion

Target task states:

```ts
export type TaskStatus =
  | "pending"
  | "claimed"
  | "completed"
  | "failed"
  | "cancelled";
```

Add fields:

- `priority`
- `failureSummary`
- `preferredMemberId`
- `resultArtifacts`

### Message State Expansion

Add fields:

- `type: "question" | "handoff" | "result" | "notification" | "escalation" | "opinion"`
- `threadId`
- `replyToMessageId?`
- `consumedAt?`

Add a per-member delivery table:

- `messageDeliveries[deliveryId].messageId`
- `messageDeliveries[deliveryId].memberId`
- `messageDeliveries[deliveryId].consumedAt?`
- `messageDeliveries[deliveryId].acknowledgedAt?`

## Event Bus Contract

The current event list is append-only storage. The runtime needs an in-process event bus interface as well.

```ts
interface RuntimeEventBus {
  emit(event: RuntimeEvent): void;
  on(type: string, handler: (event: RuntimeEvent) => Promise<void> | void): () => void;
}
```

Required event families:

- `runtime.started`
- `runtime.paused`
- `runtime.stopped`
- `session.started`
- `session.idle`
- `session.working`
- `session.waiting`
- `session.error`
- `task.created`
- `task.claimed`
- `task.completed`
- `task.failed`
- `message.sent`
- `message.acknowledged`
- `path_lock.created`
- `path_lock.removed`
- `policy.blocked`
- `policy.warning`
- `scheduler.tick`
- `scheduler.assignment`

## Runtime Policy Behavior

The runtime policy layer currently gates agent-facing MCP tools. It is code/state enforcement, not just prompt guidance.

Current permission behavior:

- `read-only`: may read status/inbox, send messages, ask the lead, and report task completion/failure for its own claimed task; cannot acquire path locks.
- `read` + `edit`: may read, message, acquire path locks, and complete/fail its own claimed task.
- unconfigured members use a conservative default that allows read, message, and task terminal reporting, but not edit/path-lock actions.

Current ownership behavior:

- `complete_task` and `fail_task` require the member to own the claimed task.
- `unlock_paths` only releases locks owned by the calling member.
- `lock_paths` records `policy.warning` when a task has `pathHints` and the requested paths are outside those hints.

Policy denial responses use error code `POLICY_BLOCKED` and persist a `policy.blocked` event so `team_timeline` and `team_status` can explain what happened.

## API Compatibility Policy

Compatibility expectations during the rewrite:

1. Current builder tool names may stay temporarily to preserve UX.
2. Old OpenCode scaffold-specific side effects are not guaranteed to survive.
3. Experimental coordination tool names may be replaced by the unified runtime surface.
4. The runtime docs are the source of truth for the target API, not the current implementation.
