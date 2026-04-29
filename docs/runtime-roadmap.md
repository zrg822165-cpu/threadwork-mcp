# Runtime Roadmap

## Status

Stage 14 marks a product direction shift.

The runtime is no longer being advanced mainly as a host-led task dispatcher with recovery polish. The next product center is a message-driven team runtime: members have independent sessions, receive their own message deliveries, respond through mailbox threads, and can influence each other without the host relaying every turn.

The stable default surface remains small: `team_work`, `team_status`, `team_results`, and optional `team_models`. Advanced/manual controls still stay behind `TEAM_MCP_ENABLE_ADVANCED_TOOLS=1`.

## Stable Baseline

The current baseline is:

- `team_work` is the default path for team setup, task creation, task continuation, bounded progress, safety review, and discussion.
- The grouped `team` / `builder` / `work` input shape is the recommended public shape; flat fields remain compatibility-only.
- `team_status` and `team_results` are the default inspection surfaces.
- `recommendedInput`, `explain`, `compactStatus`, and `compactResults` remain the host-facing continuation and first-screen contracts.
- Bounded progress is host-invoked and explicit; this is not an always-on daemon.
- Runtime safety remains lightweight: task boundaries, path-lock warnings, policy blocks, and host review are inspectable, but this is not OS sandboxing, worktree isolation, or checkpoint/rewind.
- Recovery remains conservative: failed work, broken sessions, paused/error runtime state, blocked safety, and host-facing unread attention stop automatic progress when needed.

## Team Direction

Stage 14 establishes the new product test:

> A team is not real just because multiple agents can be called. It becomes a team when members can speak from their own context, respond to each other, and create visible discussion state without the host acting as the message router.

The implemented baseline for that direction is:

- `team_work.work.discussion` starts or continues a team-scoped or task-scoped mailbox thread.
- `team_work.work.discussion.hostDecision` lets the host post a structured decision back into the same thread without leaving the default surface.
- `team_work.work.discussion.commitToTask` lets the host explicitly turn a settled thread into task work from that same thread state, without adding a new default tool.
- Messages carry `threadId`; replies stay in the same thread through `replyToMessageId`.
- `messageDeliveries` tracks unread, consumed, and acknowledged state per member.
- Delivery semantics are quieter by default: `question`, `handoff`, `notification`, and `escalation` create implicit broadcast deliveries, while ordinary broadcast `opinion` and `result` messages stay thread-visible without automatically becoming inbox work.
- Broadcast discussion can remain unread for one member after another member consumes it.
- Scheduler ticks prioritize pending direct or broadcast discussion messages before ordinary runnable tasks.
- Scheduler conversation turns are now stricter about what counts as a reply turn: they prefer current-round actionable thread messages and do not treat every unread opinion as a prompt-worthy host issue.
- Conversation turns do not claim tasks; they prompt an idle member to respond through `send_message`, `ack_message`, or `ask_lead`.
- `team_status`, `team_results`, and timeline expose active discussion threads and latest opinions without treating discussion as task completion.
- Discussion threads now derive visible team state: expected participants, responded participants, pending members, latest opinions, unresolved questions, lifecycle state, disagreement state, next action, and whether host judgment is needed.
- Discussion threads also derive a current-round summary plus a conservative conclusion summary, so host-facing views can say what the latest turn is waiting on or what just settled without replaying the whole thread.
- Discussion threads now also expose a structured current-round turn chain, so status/results/timeline can show the active message path without replaying the full thread history.
- Discussion threads now also derive explicit turn obligations: who still owes a reply, why they owe it, which message anchors that turn, and which relevant non-participants can be invited into the active thread through conservative `callWhen` matching.
- Host-facing discussion state now carries readable member names alongside ids, including named owed/invited member lists and named turn-chain entries, so active rounds can be inspected without resolving raw ids by hand.
- Host-facing discussion state now also carries named participation progress: who has already responded in the current round, who still owes a reply, and when another member is only invited to weigh in.
- Host-facing status now keeps two discussion lenses available at once: a progress summary for the current round and a narrower host-attention summary only when that round truly needs host judgment.
- Host-facing compact status/results now expose the same derived discussion fields directly, including lifecycle, disagreement summary, proposed next action, and settled-round conclusion summary.
- Host-facing discussion state now also derives a fact-based `synthesis`: headline, summary, resolution state, member response/owed/invited summaries, open issue summary, and next action summary. It is runtime fact synthesis, not LLM stance interpretation.
- Scheduler turn obligations now carry explicit triggers (`direct_message`, `participant_obligation`, `callWhen_match`, `host_decision_follow_through`, `unresolved_question_follow_up`), and conversation prompts/status can explain why a member is being woken.
- Scheduler turn obligations now also carry trigger-derived `priorityScore`; discussion threads derive `turnTakingState`, next responsible member ids/names, and a short next-turn summary from those same obligations.
- Discussion threads now also expose `nextTurns`, a compact host-visible explanation of each legal speaking window: member, trigger, reason, required/optional status, priority, and expected contribution.
- Turn-taking priority is now explicit and stable: direct messages outrank unresolved teammate follow-ups, host-decision follow-through, required participant replies, and optional `callWhen` invitations.
- Settled discussion threads now also derive conservative actionability: whether the thread still needs follow-up discussion, is merely settled and waiting on host commit, or is already ready to become the next task.
- Settled discussion threads now derive conservative execution cues and `team_work` recommends an explicit `work.discussion.commitToTask` continuation instead of silently turning that thread into `work.goal`.
- Explicit discussion-to-task commits now write a host notification back into the same thread, so the thread can show that follow-up work was already created instead of staying permanently stuck at `ready_for_task`.
- Explicit discussion-to-task commits now also carry conservative execution defaults into the created task: explicit `work.pathHints`, `work.preferredMemberId`, and `work.priority` win first, then task-scoped source task context is reused when provable.
- After a discussion is committed, host-facing continuation switches to the created task id and no longer recommends another `work.discussion.commitToTask`; status/results/timeline expose the derived thread-to-task linkage without turning discussion conclusions into task results.
- Committed discussions now derive `lifecycleState/state = closed` plus closure fields, making the host-facing boundary explicit: the issue is closed and the next work belongs to the task.
- Completed task results now derive a lightweight team review state. When an eligible reviewer exists, `team_work` recommends a task-scoped `work.discussion` review thread such as `Task review: task_x`; it does not create review messages from read-only status/results calls.
- Task review remains a discussion layer over the completed task result: reviewer opinions stay in the mailbox thread, task delivery stays in task results, and review follow-up still uses the existing `discussion.commitToTask` handoff.
- The current stabilization pass keeps that loop low-noise: once a source discussion is `closed`, a completed task can move into review recommendation instead of being pulled back to the old discussion; after a review settles, follow-up commit is recommended only when the review thread carries an explicit follow-up cue.
- The default host continuation contract is now intentionally single-step: recommend one of commit discussion, continue task, start review discussion, continue review discussion, or continue the created follow-up task rather than mixing task and discussion next steps.
- Async conversation turns now remain visible in runtime state while a member is still handling a mailbox prompt, instead of disappearing immediately after the prompt returns.
- Bounded progress stop reasons, next actions, and host guidance now reuse that same derived discussion state instead of rebuilding separate wording from lower-level counters.
- Scheduler conversation turns now prefer each thread's current-round anchor message, carry both round summary and proposed next action into member prompts, and avoid inventing a second discussion-state model.
- Scheduler conversation turns now select from the same obligation model: direct reply, follow-up reply, participant reply, and invited opinion no longer collapse into one `pendingMemberIds` bucket.
- Runtime invitations are now actionable during an active collecting round: a relevant non-participant can be prompted to add an `invited_opinion` while required participant replies are still pending.
- Runtime invitations are now also more conservative during collecting rounds: they do not fire while several required participant replies are still missing and the round has not yet developed enough signal to justify another voice.
- Env-gated real OpenCode smoke now covers a longer discussion turn-taking chain: invited opinion, later required participant reply, host decision posted into the same thread, and member follow-through in the next round.
- `team_status` and compact views now summarize discussion progress in team language such as waiting for members, unresolved questions, or ready for host decision.
- `team_work` now uses that same thread state for continuation: bounded runs stop immediately at host-decision points, can briefly keep polling across idle ticks while in-flight member replies are still expected, host decisions can reopen the same thread for another member round, and `recommendedInput.work.discussion.replyToMessageId` follows the latest thread message instead of staying pinned to the original root.

## Next Slice

Stage 16.5 is a stabilization slice over the completed discussion/task/review loop. It should pause broad capability growth and harden dogfood evidence that the host can follow one clear next step across discussion close, task completion, review, and optional follow-up.

Next work should stay in the same direction and keep the contract small:

- harden real-world wording from dogfood evidence without changing the small default surface
- decide whether review thread creation should ever become automatic only after more dogfood evidence
- decide whether review acceptance needs a derived closure marker, without adding a new accept tool by default
- keep low-noise bounded turns; do not add global always-on listening

Do not start the next slice with:

- new default tools such as `team_discuss`
- broad task-planning orchestration
- always-on daemon scheduling
- shell/network sandboxing
- worktree/checkpoint design
- a large approval console

## Reference Commands

Default verification:

```bash
npm run typecheck
npm test
npm run build
```

Env-gated live OpenCode verification:

```bash
TEAM_MCP_REAL_OPENCODE_SMOKE=1 npm test -- tests/runtime.opencode.smoke.test.ts
```

Targeted Stage 14 smoke path:

```bash
TEAM_MCP_REAL_OPENCODE_SMOKE=1 npx vitest run tests/runtime.opencode.smoke.test.ts -t "lets real runtime-owned members discuss through team_work without host mailbox relay"
```

```bash
TEAM_MCP_REAL_OPENCODE_SMOKE=1 npx vitest run tests/runtime.opencode.smoke.test.ts -t "invites a relevant real runtime-owned member into an active discussion thread"
```

```bash
TEAM_MCP_REAL_OPENCODE_SMOKE=1 npx vitest run tests/runtime.opencode.smoke.test.ts -t "covers invited turn, reviewer reply, and host decision follow-through in one real discussion thread"
```
