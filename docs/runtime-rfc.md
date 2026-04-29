# Runtime RFC

## Status

Accepted and still guiding implementation. The checked-in product shape now centers on a lean `team_work` default surface with bounded progress, explicit task boundaries, safety signals, and host review loops layered onto the same small tool surface.

This RFC is the source-of-truth product direction for `team-mcpv2`. It replaces the old OpenCode scaffold/subagent-builder direction with a runtime-first team system. Detailed API and implementation sequencing live in `runtime-api.md`, `runtime-implementation.md`, and `runtime-migration.md`.

## Direction

`team-mcpv2` should become an MCP-first, message-driven team runtime with lightweight LLM team support, using OpenCode as the first execution backend.

The product is not a bigger subagent wrapper, but it is also not a complex team-management platform. The team is a task amplifier: independent teammate sessions, shared tasks, direct member messaging, inspectable runtime state, and controlled parallel work exist to make user tasks easier to complete in OpenCode. Stage 14 closes the old recovery-polish phase and makes the core product bet explicit: coordination should move into member-to-member message threads instead of keeping the host as a subagent-style dispatcher.

A team should feel like a team because members can speak from their own context, respond to one another, create visible disagreement or consensus, and ask the host for judgment only when needed. The host remains the sponsor/reviewer/tie-breaker; it should not be the default relay for every member turn.

Current direction check:

- the product center is the task execution loop, not scaffold generation
- `team_work` is the default start/continue path for normal host-facing use, including lightweight team setup
- the default public host-facing surface is intentionally lean: `team_work`, `team_status`, `team_results`, and optional `team_models`
- low-level builder/runtime host tools remain available for inspect/debug/manual control, but only behind `TEAM_MCP_ENABLE_ADVANCED_TOOLS=1`
- teammate prompts should stay compact and task-scoped
- safety state should be explicit in runtime state and host views, not only implied by prompt guidance
- new work should harden the default workflow before adding more public runtime surface
- message-driven discussion is a core product direction: members should be able to receive, answer, and influence each other through runtime mailbox threads without the host relaying every turn
- discussion state should be a first-class runtime signal derived from mailbox threads, not a separate default tool surface
- host-facing status should summarize who has responded, who is still pending, the latest opinions, unresolved questions, and when a thread now needs host judgment
- host-facing continuation should use that same discussion state to decide when bounded work keeps running and when control should return to the host
- host-facing continuation should also use that same discussion state to decide when a settled thread is ready to become the next task instead of just another discussion turn
- host-facing continuation should keep that handoff explicit: the runtime may prefill the next task from thread facts, but the host should commit it through `team_work` rather than by silent task creation
- bounded discussion continuation should allow a short wait for in-flight member replies instead of forcing the host to rerun immediately after every idle gap
- host judgment itself should also return through the mailbox thread as a structured runtime action, so a thread can move from `ready_for_host` back into another member-response round without a new public tool
- scheduler turn-taking should stay thread-state-aware enough that old unread opinion chatter does not outrank the current actionable round
- ordinary opinions should default to thread context rather than inbox work, otherwise discussion noise will drown out actual turn-taking
- host-facing views should summarize the current discussion round directly, not force the host to infer the latest actionable turn from a long thread
- host-facing views should also expose the current round's actual turn chain, so the host can see who said what in the active round without expanding into full history
- host-facing views should also expose thread lifecycle, disagreement, next action, and a conservative settled-round conclusion summary without inventing a second discussion-state model
- host-facing views should also expose named participation progress, so the host can immediately tell who has already spoken, who still owes a reply, and who was only invited to weigh in
- host-facing views should also expose fact-based discussion synthesis, so the host can read what the current round is doing, who responded or still owes a turn, what issue is open, and what action is next without relying on semantic stance inference
- turn-taking should explain its own trigger, so scheduler prompts and status can say whether a member was woken by direct delivery, participant obligation, callWhen invitation, host-decision follow-through, or unresolved teammate follow-up
- turn-taking should also expose priority and ownership, so the runtime can explain who is next, why that member is next, and why optional invitations do not outrank required or follow-up replies
- settled discussion should expose conservative actionability and execution cues, so the host can tell the difference between "the thread ended" and "the team is ready for the next task"
- host-facing views should also separate team progress from host judgment: "what the round is doing" should not be collapsed into the same line as "the host must decide now"
- that same separation should carry through stop reasons and continuation guidance, so the runtime does not describe the same discussion differently in status, bounded-run stops, and next actions
- bounded runs should follow that same current-round model: waiting rounds may stay alive briefly for in-flight member replies, while host-decision rounds should return control to the host immediately
- waiting member turns should remain visible in runtime state while the member is still handling them; a mailbox turn should not disappear just because the backend prompt already returned
- scheduler turn-taking should follow the same current-round model, ideally prompting members from the current round anchor instead of treating every unread thread message as equally important
- thread state should explicitly say who owes a turn, why they owe it, and when a relevant non-participant was only invited rather than required to speak
- constrained invitation should stay conservative during collecting rounds: the runtime should not pull in extra voices too early while the primary participant round is still mostly unanswered
- lightweight invitation should stay scoped: role/callWhen relevance may open a discussion turn, but it should not create a global always-listening loop
- host-facing thread state should be readable without auxiliary lookup: when the runtime says who still owes a turn or shows the active turn chain, member names should travel with that state
- constrained invitation is part of the runtime behavior, not only status decoration: a relevant runtime-owned member may be prompted into an active collecting round before all required participants have finished replying
- constrained invitation must remain fair: direct/follow-up messages, host-decision follow-through, and required participant replies keep priority over optional invited opinions
- execution handoff must remain conservative: the runtime may suggest the next task from thread facts and let the host commit it from the same thread, but it should not silently create or semantically invent that task on its own
- completed task review should stay on the same conservative path: runtime may recommend a task-scoped review discussion and expose its state, but review threads are derived from messages and follow-up implementation still requires an explicit discussion-to-task commit
- stabilization now matters more than adding new team concepts: the discussion-to-task-to-review loop should prove, through dogfood, that the host sees one clear continuation at each boundary before the product grows another public surface

The product direction is our own agent team runtime, not a clone of any specific vendor UX. Claude Code Agent Teams are useful evidence that this is a real product category, but they are not the implementation target. We should learn from the same engineering problems: long-lived independent sessions, shared task state, member-to-member communication, policy, visibility, recovery, and controlled parallelism.

The center of the product is the task execution loop, supported by a small runtime state machine:

- lightweight team definitions and runtime lifecycle
- runtime-owned member sessions
- shared task list with claim, completion, failure, dependency, and cancellation state
- direct member mailbox
- path locks and conflict signals
- scheduler decisions and next actions
- policy blocks and warnings
- timeline and results that explain what happened

Team mechanics should not dominate member context. A member prompt should focus on the active task, relevant messages, required files/paths, and how to finish or ask for help. It should not carry long team operating manuals, safety frameworks, or backend explanations unless they are immediately needed for the task.

Message-driven mechanics should stay bounded. Members should respond when directly addressed, included in a discussion, or invited by a clear runtime rule. The product should avoid both extremes: silent subagents that only run host-assigned tasks, and noisy always-listening agents that interrupt without a scoped reason.

OpenCode is the first execution backend. It is not the product identity. Backend-specific details should stay behind runtime/backend seams unless there is a concrete reason to expose them.

## Non-Drift Principles

These principles are part of the RFC because context drift is a major implementation risk.

- Do not describe this project as a large subagent, subagent builder, or prompt-only delegation layer.
- Do not force alignment with Claude Code Agent Teams UX, file layout, tmux display mode, hook names, or subagent-definition mechanics.
- Treat Claude Code Agent Teams as a reference for the agent-team problem space, not as a compatibility target.
- Treat OpenCode as a backend implementation detail unless the current task is specifically backend integration.
- Keep MCP and runtime state as the coordination boundary; critical task, message, lock, policy, session, and result state must not live only in prompts.
- Keep the public tool surface small. Prefer improving a few high-leverage task tools over adding many narrow team-management tools.
- Keep member context task-centered. Team instructions should be brief and operational, not a large manual that competes with the task.
- Do not make the team abstraction the user's main job. The team exists to help complete tasks, not to require constant team administration.
- Do not expand the legacy OpenCode scaffold path except for explicit migration compatibility.
- Do not claim sandboxing, checkpointing, worktree isolation, or recovery semantics that are not implemented in code/state.
- Prefer small runtime-first increments that make task execution easier to start, continue, inspect, and finish.

## Relationship To Claude Code Agent Teams

Claude Code Agent Teams and `team-mcpv2` sit in the same broad problem space: multiple independent agent sessions collaborate as a team through shared tasks, messaging, and centralized management. This is different from subagents, where a parent session delegates focused work and receives a summarized result back into the caller's context.

The useful comparison points are:

- independent teammate sessions with their own context and lifecycle
- shared task list rather than sequential host-driven `@member` calls
- direct teammate communication through a mailbox-like mechanism
- a lead or host-facing control surface that can inspect and steer work
- team state that explains progress, blocks, failures, and results

The deliberate differences are:

- our public boundary is MCP-first rather than Claude-specific
- our first backend is OpenCode, isolated behind a backend seam
- our persisted state should be team/runtime-native, not `.claude/teams` compatible
- our display and control model should be driven by API/runtime state, not tmux parity
- our member definitions may borrow the idea of specialized teammates, but the team abstraction is not a subagent definition format

## Problem

The old product proved a builder workflow, not a runtime workflow.

Main gaps:

- no runtime-owned teammate sessions
- no direct member-to-member communication
- no real shared task claiming/completion loop
- no autonomous member lifecycle
- no true parallel collaboration loop
- generated OpenCode scaffold files were treated as the product artifact

Those gaps make the legacy path equivalent to scaffold generation plus manual host orchestration. It cannot deliver a living team runtime by itself.

## Target Architecture

```text
Host / MCP client
    -> team-mcpv2 MCP server
        -> runtime service
        -> scheduler
        -> agent spawner
            -> OpenCode sessions
        -> shared state store
            -> teams / members / tasks / messages / locks / events / sessions
```

Core responsibilities:

- spawn and track teammate sessions
- maintain shared team state
- assign and claim tasks
- route member messages through a mailbox
- maintain per-member message delivery and discussion threads
- enforce path-lock policy
- expose runtime lifecycle and inspection tools
- keep builder UX as team configuration, not scaffold generation

## Product Boundaries

First backend: OpenCode only.

Clean seam: keep `AgentBackend` so later backends are possible, but do not build multi-backend support before OpenCode runtime execution is proven.

Non-goals for the current rewrite:

- forking OpenCode
- expanding the legacy scaffold path
- replacing `JsonStore` before scale pressure is proven
- building a distributed multi-machine runtime
- starting with an always-on daemon scheduler
- using prompt-only JSON/text conventions as the primary completion protocol

## Current State

Already implemented or started:

- runtime state collections: `teamRuntimes`, `agentSessions`, `schedulerStates`
- runtime modules: backend interface, OpenCode backend, fake backend, spawner, runtime service, scheduler, event bus
- lean default MCP surface centered on `team_work`, `team_status`, `team_results`, and optional `team_models`
- low-level builder/runtime host tools kept in code for manual/debug/recovery usage behind `TEAM_MCP_ENABLE_ADVANCED_TOOLS=1`
- runtime-first builder service now used through `team_work` by default, with advanced/manual `team_confirm`, `team_remove_member`, and `team_finish` still available behind the advanced gate
- legacy scaffold-writing behavior kept only as compatibility support
- fake-backend scheduler tests
- env-gated real OpenCode smoke for spawning, concurrently prompting, scheduler-driven prompting, and direct agent-facing MCP tool calls from runtime-owned sessions
- tool-driven completion contract: scheduler leaves tasks claimed until `complete_task` or `fail_task` updates terminal state, then observes that state on the next tick
- bounded scheduler runner: `team_scheduler_run` composes deterministic ticks until idle, paused, error, or `maxTicks`
- cross-session mailbox smoke: two runtime-owned OpenCode sessions coordinate through `send_message`, `inbox`, and `ack_message` without host relay
- real OpenCode smoke now injects independent `OpenCodeBackend` ports so concurrent live backend runs do not contend on the SDK default port `4096`
- split scheduler execution for store-backed tools: task claiming/finalization happens in short transactions while OpenCode prompting happens outside the `JsonStore` lock, so scheduler-assigned prompts can call MCP tools
- minimal runtime policy layer for agent-facing tools: member permissions now gate task completion/failure, messaging, inbox reads, and path locking/unlocking with inspectable `policy.blocked` / `policy.warning` events
- Stage 12 safety foundations: task boundaries derived from `pathHints`, safety signals for missing scope, out-of-scope locks, and policy blocks, and host safety review through `team_work.work.review`
- OpenCode TUI compact safety contract: `compactStatus`, `compactResults`, `explain`, and `recommendedInput` agree on whether the host can continue, should review, or must stay manual
- Stage 16 task-result review loop: completed tasks derive `TaskReviewSummary`, `team_work` can recommend a task-scoped review discussion for eligible reviewers, and review follow-up uses the existing settled discussion commit path instead of a new public tool or persisted review entity
- Stage 16.5 stabilization: completed tasks are no longer pulled back to their closed source discussion before review, `recommendedInput` keeps one primary continuation step, and accept-only settled reviews do not recommend a follow-up commit without an explicit cue

Why the direction currently looks correct:

- the product center has moved from scaffold/builder behavior to runtime/task behavior
- the default workflow has converged around `team_work` instead of a large set of equally primary tools
- the default first-run story now keeps unfinished teams in builder guidance mode instead of creating runtime tasks too early
- real OpenCode behavior is exercised through env-gated smoke, not just fake-backend tests
- safety behavior is exercised through warning-only, needs-review, and acknowledged-blocked real OpenCode smoke paths
- runtime primitives and host workflow are now separated more clearly
- recent work has focused on hardening and simplification rather than surface-area sprawl

Known temporary debt:

- historical builder storage may still contain `openCode.builds`, but current schema migration reads it into the team-native `teamBuilds` key and new writes no longer persist `openCode`
- direct MCP agent-facing tool calls currently require explicit OpenCode local MCP config and permission wiring
- real OpenCode smoke tests explicitly set `model` and `small_model` to `hugusir/gpt-5.4`; this is project-local test/runtime config, not a global OpenCode config change

## Next Direction

Stage 12 is closed out. The runtime-first product shape has converged enough that the next investment should build on the stable safety boundary contract rather than inventing another broad public surface.

Recently completed foundations:

- Stage 7A: Team Runtime Control Plane
- Stage 7B: Team Timeline And Results Consolidation
- Stage 7C: Team Session Recovery
- Stage 7D: Runtime Naming Cleanup

Recently completed workflow hardening:

- Stage 8F: runtime-first public surface cleanup and default-path convergence
- Stage 8G: `team_work` continuation hardening for claimed/failed/blocked/message/recovery states
- Stage 8H: env-gated real OpenCode collaboration smoke with real two-member runtime coordination coverage, later narrowed away from brittle file-write assertions and stabilized with explicit path-lock/message contracts

Recently completed runtime reliability hardening:

- Stage 9A: Runtime MCP First-Run Readiness
- Stage 9B: env-gated real OpenCode recovery/retry smoke for broken-session guidance, explicit `team_recover_sessions`, replacement-session retry, and final result inspection
- Stage 9B.1: real OpenCode smoke backend port isolation so concurrent live smoke runs no longer collide on the SDK default local server port
- Stage 9C: team-native state migration and `openCode.builds` key removal from new writes while keeping historical reads

Current product focus:

- Stage 11B bounded background progress is complete through the lean `team_work` default surface.
- Stage 12 isolation and safety foundations are complete as a lightweight boundary contract, not as full sandboxing.
- Stage 13A default recovery guidance is complete: default host surfaces now use clearer recovery wording, paused runtimes can resume through explicit `team_work` continuation, and manual follow-up remains conservative after blocked safety, failed tasks, and broken sessions.
- Stage 13B live recovery coverage is in place: env-gated OpenCode smoke now covers the explicit paused-runtime resume path, keeps broken-session recovery assertions aligned with the lean default host wording, proves that failed-task follow-up creation can flow through `recommendedInput` without losing task scope hints, keeps failed-task compact cards aligned with the same recovery contract, locks acknowledged `policy_blocked` compact cards to the blocked/manual-follow-up host contract, proves that broken-session compact cards match the same recovery wording, and keeps paused-runtime manual attention cards aligned with the same resume contract.
- Stage 14 is the current direction shift: `team_work` can start discussion threads, scheduler turns can prompt idle members to respond to pending messages, and member opinions become visible in status/results/timeline without adding a default discussion tool.
- The stable contract is now: task boundaries are explicit, safety signals are inspectable, recovery is conservative, host review stays inside `team_work`, and team discussion moves through mailbox threads rather than host-relayed subagent calls.
- The current stable discussion baseline is thread-derived: expected participants, responded participants, pending members, latest opinions, unresolved questions, lifecycle state, disagreement state, proposed next action, and settled-round conclusion summary are all derived from the mailbox thread and reused by status, results, scheduler, and `team_work`.
- The current stable discussion baseline also includes explicit turn obligations and constrained invitations: direct replies, follow-up replies, participant replies, and invited opinions are all derived from the same mailbox thread state and reused by status, results, scheduler, and `team_work`.
- The current stable discussion baseline also includes host-facing fact synthesis and turn triggers: status/results/prompts can explain team progress and why a member is being woken without adding a separate `Discussion` entity or doing LLM stance summarization.
- The current stable discussion baseline also includes issue-driven closure and visible member reasons: explicit `commitToTask` inherits conservative execution defaults, committed threads derive `closed` lifecycle and point host continuation at the created task, and each speaking window exposes trigger, reason, and expected contribution without adding a persisted Discussion entity.
- Stage 16.5 dogfood stabilization is the current emphasis: harden wording, linkage, and tests for the existing loop before deciding whether to automate review creation or add any acceptance closure surface.
- The next capability slice should stay in the same direction: harden wording from real team-flow evidence without drifting into a separate heavyweight discussion system.
- Detailed stage closeout and next-stage sequencing live in `docs/runtime-roadmap.md` so this RFC can stay focused on product direction rather than execution checklist detail.

### Stage 10A: Lean Team Surface And Unified `team_work` Team Entry

This ordering remains intentional. Stages 7A-7D made the runtime explainable and recoverable enough to be useful. Stage 8 reduced the number of steps and concepts needed to use the team for a task, then hardened that path without expanding into a mature safety platform or complex team administration UX. Stage 9A verified that a new user can install, connect, start, build, run `team_work`, and inspect results without reading the RFC or enabling legacy behavior. Stage 9B then focused on live OpenCode reliability: explicit recovery/retry semantics and independent backend port injection for concurrent real smoke coverage. Stage 9C removed the last persisted OpenCode builder key from new state while preserving historical migration reads. Stage 10A kept the release-hardening discipline from Stage 9D while simplifying the default host-facing product story by folding normal team setup into `team_work` and moving manual builder/runtime controls behind an explicit advanced gate. That Stage 10A change is now checked in and verified with `npm run typecheck`, `npm test`, and `npm run build`.

Stage 10A should keep six things aligned:

- the default package entrypoint and built stdio smoke must represent the real MCP product surface
- current schema and team-native persisted state must remain the checked-in default rather than a migration footnote
- `team_work` must remain the obvious host-facing primary path for both lightweight team setup and task continuation
- unfinished teams must stay in builder guidance mode instead of creating runtime tasks
- advanced/manual builder and runtime tools must stay available only behind `TEAM_MCP_ENABLE_ADVANCED_TOOLS=1`
- real OpenCode smoke must stay env-gated, live-backend-only, and outside default CI while docs describe it accurately

Stage 10A is not a new capability phase. It is specifically not the point to add:

- an always-on daemon scheduler
- shell/network sandboxing
- worktree or checkpoint isolation
- a larger public default tool surface or a separate `team_design` tool

The Stage 10B / 10C / 11A closeout stabilized the default UX contract around grouped `team` / `builder` / `work` input, `recommendedInput`, `explain`, and compact host-card views. That closeout does not change the core product boundary: the team remains lightweight, task-first, and MCP-first.

Stage 11B bounded background progress is now part of the checked-in runtime contract. The user experience it established is:

```text
user asks the team to work for a bounded period
-> team_work starts or continues bounded progress
-> runtime/scheduler advances work within explicit limits
-> execution stops with a clear reason
-> team_status explains current state and next action
-> team_results summarizes completed, failed, or attention-worthy work
-> recommendedInput shows the smallest safe next team_work call
```

Stage 11B established five important constraints that should remain aligned:

- `team_work` remains the host-facing entrypoint for starting and continuing bounded progress
- bounded progress has explicit limits such as max ticks, max runtime, stop reason, and resumable state
- `team_status.compactStatus` and `team_results.compactResults` explain active, stopped, idle, failed, or needs-attention states without a new UI tool
- real OpenCode background smoke stays env-gated and outside default CI
- the runtime still does not introduce always-on daemon behavior, worktree/checkpoint isolation, shell/network sandboxing, or a larger default tool surface just to support bounded progress

Stage 12 is now the safety baseline. It makes teammate execution safer and easier to trust while preserving the lightweight task-first product shape. The intended user experience is:

```text
user asks the team to continue normal work
-> runtime applies explicit task/workspace/edit boundaries
-> teammates act within those boundaries or produce inspectable denial/escalation signals
-> team_status explains whether work is safe to continue and what boundary was hit
-> team_results summarizes meaningful output plus safety-relevant outcomes
-> recommendedInput shows the smallest safe next team_work call or recovery step
```

Stage 12 keeps five things aligned:

- `team_work` remains the host-facing entrypoint for normal continuation rather than adding a new default safety console
- safety boundaries are explicit enough to inspect and recover, but still lightweight enough to fit the existing runtime model
- `team_status.compactStatus` and `team_results.compactResults` remain the default host-card views for understanding safety-relevant runtime state
- real OpenCode safety smoke stays env-gated and outside default CI
- the stage does not overclaim full sandboxing, worktree isolation, checkpoint/rewind, or infrastructure-grade enforcement before code/state truly support it

Stage 12 planted two reality checks that should continue into Stage 13:

- the product should be validated by running real end-to-end task flows inside OpenCode TUI, not only by backend smoke or isolated runtime assertions
- host-facing status/results UX should be shaped for how OpenCode actually renders and feels in practice, not only by abstract compact-view contracts

The next major direction should mostly be judged by six questions:

- can the host continue, retry, reassign, or abandon work without understanding raw runtime state?
- do acknowledged blocked actions stay manual until a real task update or terminal state clears them?
- does recovery guidance stay inside `team_work`, `team_status`, and `team_results` rather than becoming a separate console?
- does OpenCode TUI read clearly when compact views include safety and recovery states?
- does the default surface stay lean while advanced/manual tools remain available behind explicit flags?
- does the next recovery layer avoid claiming checkpoint, worktree, daemon, or sandbox semantics before they exist in code/state?

The Stage 10A release readiness chain is:

```text
npm run build
-> npm run typecheck
-> npm test
-> optionally TEAM_MCP_REAL_OPENCODE_SMOKE=1 npm test -- tests/runtime.opencode.smoke.test.ts
-> optionally npm pack --dry-run
```

The testing discipline behind that chain is:

- default tests stay offline and deterministic
- built stdio entrypoint smoke proves the shipped MCP product surface
- real OpenCode smoke proves live backend behavior and dogfood value only when explicitly requested

The proven advanced/manual runtime chain is:

```text
TEAM_MCP_ENABLE_ADVANCED_TOOLS=1
-> team_finish
-> team_run
-> RuntimeService spawns real sessions
-> team_task_create
-> RuntimeScheduler.tick assigns tasks
-> OpenCode teammate receives task
-> teammate calls MCP tools
-> lock/message/complete_task update shared state
-> scheduler observes completion
-> team_status/team_results show result
```

The completed task-first chain is:

```text
user gives OpenCode a task
-> one primary team tool creates/updates the runtime task
-> runtime starts or reuses member sessions when needed
-> scheduler assigns focused work with compact task context
-> members coordinate only through task-scoped messages when useful
-> members complete/fail tasks through MCP tools
-> status/results summarize what happened and what to do next
```

The completed bounded-progress chain is:

```text
user asks team_work to run bounded progress
-> runtime starts or reuses member sessions within explicit limits
-> scheduler advances tasks until idle, limit, timeout, error, or needs-attention
-> bounded progress state records why it stopped
-> team_status compact view shows current state and next action
-> team_results compact view summarizes completed/failed work
-> recommendedInput provides the next safe continuation call
```

The next safety-boundary chain is:

```text
user asks team_work to continue a task
-> runtime applies explicit task/workspace/edit boundaries
-> teammate acts, is warned/denied, or escalates within that boundary
-> runtime records the safety-relevant state in team-native records
-> team_status explains what happened and whether host review is required
-> team_results summarizes meaningful output and safety-relevant outcomes
-> recommendedInput provides the next safe continuation or recovery call
```

The next host-validation chain is:

```text
developer runs the product through real OpenCode TUI
-> team_work / team_status / team_results are used as a normal host would use them
-> compactStatus / compactResults are judged by actual readability and interaction cost inside TUI
-> unclear guidance, missing safety context, and noisy UI are treated as product bugs
-> runtime and host UI contracts are refined against real usage rather than closed-loop assumptions
```

The next critical chain is first-run readiness:

```text
new user installs dependencies
-> builds `dist/index.js`
-> points an MCP client at the default stdio server
-> sees `team_work`, `team_status`, `team_results`, and `team_models` without legacy flags
-> uses `team_work` to start or resume a small team build
-> uses `team_work` again to draft, confirm, and finish the team
-> uses `team_work` again to start or continue task work
-> inspects `team_status` / `team_results`
-> understands how to recover or debug when needed
```

## Stage Plan

### Stage 1: Scheduler-Driven Real Backend Smoke

Goal: prove `RuntimeScheduler.tick(...)` can prompt real runtime-owned OpenCode sessions.

Tasks:

- add an env-gated smoke test under `TEAM_MCP_REAL_OPENCODE_SMOKE=1`
- create a team with two confirmed members
- mark the runtime ready and start it with `OpenCodeBackend({ startupTimeoutMs: 30000, noReply: false })`
- create two independent pending tasks with stable sentinel outputs
- run one scheduler tick with `maxParallel: 2`
- assert tasks are claimed, sessions are working, assignments are recorded, and real prompt results contain the sentinels

Acceptance:

- normal `npm test` remains offline and fake-backend only
- `npm run typecheck` passes
- env-gated OpenCode smoke proves scheduler-driven prompting, not only direct backend prompting

### Stage 2: Agent-Facing MCP Tool Loop PoC

Goal: determine whether runtime-owned OpenCode sessions can call this MCP server's agent-facing tools directly.

Tasks:

- test whether a spawned OpenCode session can connect to the MCP server
- verify calls to `team_self_status`, `send_message`, and `complete_task`
- confirm tool calls map to the correct team, member, session, and task
- document permission or session-configuration blockers

Acceptance:

- at least one runtime-owned OpenCode teammate can update runtime state through MCP tools
- if direct MCP calls are infeasible, the blocker is documented before designing a worker bridge

### Stage 3: Completion Contract

Goal: make task completion tool-driven instead of prompt-parsed.

Status: implemented for the deterministic scheduler path and covered by fake-backend tests plus env-gated real OpenCode smoke.

Contract:

- teammates complete work with `complete_task`
- teammates report failure with `fail_task`
- teammates coordinate with `send_message`, `inbox`, and `ack_message`
- teammates acquire and release edit scope with `lock_paths` and `unlock_paths`
- teammates escalate ambiguity with `ask_lead`

Acceptance:

- scheduler does not infer terminal task state from natural-language summaries
- mailbox, locks, events, and task results are driven by tool calls

### Stage 4: Bounded Scheduler Loop

Goal: add controlled multi-tick execution without jumping to an always-on daemon.

Status: implemented as a thin bounded runner over `RuntimeScheduler.tick(...)` and exposed through `team_scheduler_run`.

Tasks:

- keep deterministic `tick(...)` as the core primitive
- add a thin bounded runner such as run-until-idle or max-ticks execution
- support explicit stop/error handling and inspectable runtime state

Acceptance:

- dependent tasks can progress across multiple ticks
- tests remain deterministic
- no orphaned sessions are created

### Stage 5: Cross-Session Messaging Smoke

Goal: prove teammates can coordinate without host relay.

Status: implemented as an env-gated real OpenCode smoke. One runtime-owned session sends a task-scoped question, the recipient reads, replies, and acknowledges through mailbox tools, and the initiator completes the task from the reply.

Tasks:

- create two real sessions
- have one teammate send a task-scoped message to another
- have the recipient read, reply, and acknowledge through mailbox tools
- complete the initiating task based on the reply

Acceptance:

- messages are persisted in the runtime mailbox
- events and timeline show the communication path
- host inspection can explain what happened

### Stage 5.5: Scheduler Prompt Lock Safety

Goal: let scheduler-assigned OpenCode prompts call agent-facing MCP tools without deadlocking on the shared store lock.

Status: implemented for `team_scheduler_tick` and `team_scheduler_run` through split store execution. Scheduler preparation claims tasks inside a short transaction, OpenCode prompting runs outside the transaction, and prompt success/failure plus tick decisions are finalized in short follow-up transactions. Real smoke configs explicitly use `hugusir/gpt-5.4` for `model` and `small_model` because it is currently more stable and cheaper than the prior default path.

Tasks:

- split scheduler preparation, prompt execution, and finalization phases
- keep deterministic in-memory `RuntimeScheduler.tick(...)` for fake-backend tests
- wire store-backed scheduler tools through the split executor
- add fake lock-safety coverage and env-gated real OpenCode smoke where a scheduler-assigned prompt calls `complete_task`
- add prompt timeout handling so stalled real prompts fail clearly and attempt session abort cleanup

Acceptance:

- mutating runtime tools can run while a scheduler-assigned prompt is active
- task completion from a scheduler prompt is persisted before final scheduler decision recording
- timeouts are reported as explicit OpenCode prompt timeout errors

### Stage 6: Runtime Policy Layer

Goal: make autonomous execution safer and more predictable.

Status: implemented as a minimal runtime enforcement layer over the existing agent-facing MCP tools. This is intentionally not a shell/network sandbox yet. It makes `Member.permissions` affect runtime behavior in code/state, records policy failures as inspectable events, prevents read-only members from acquiring edit locks, prevents members from unlocking another member's locks, and prevents members from completing another member's claimed task.

Tasks:

- define member permission levels for read, edit, shell, network, and approval-required operations
- surface permission blocks as task/session/runtime events
- strengthen path-lock enforcement before edits
- keep risky action escalation explicit

Acceptance:

- permission failures are inspectable instead of silent prompt stalls
- runtime policy lives in code/state, not only in prompts
- read-only members can still report task failure through `fail_task`, but cannot acquire path locks or perform edit-scoped runtime actions

### Stage 7A: Team Runtime Control Plane

Goal: make a running team understandable and steerable from runtime state.

This is the next priority. The runtime already has lifecycle, tasks, mailbox, locks, scheduler decisions, real OpenCode session ownership, cross-session messaging, and policy events. The control plane should consolidate those facts into a status view that answers what the team is doing, what is blocked, and what the lead can do next.

Tasks:

- make `team_status` a full team runtime status view rather than a builder/runtime summary
- show runtime status, backend, workdir, max parallelism, and scheduler pause/error state
- show member sessions by status: starting, idle, working, waiting, error, stopped
- show active task per working session and current claimed owner per claimed task
- group tasks into pending, runnable, blocked by dependency, claimed, completed, failed, and cancelled buckets
- show unread inbox counts per member and task-scoped message threads that need attention
- show active path locks, lock owners, related task IDs, and stale-lock risk when detectable
- show recent policy blocks and warnings that explain denied or risky actions
- show last scheduler decision and suggested next host/lead actions

Acceptance:

- `team_status` can explain whether the team can continue making progress
- blocked tasks show the reason they are blocked
- policy failures are visible without reading raw event logs
- a host can decide whether to run the scheduler, message a member, retry work, or stop a session from the status output
- default tests stay deterministic and offline

### Stage 7B: Team Timeline And Results Consolidation

Goal: make completed and in-progress collaboration explainable after the fact.

Tasks:

- consolidate `team_timeline` around runtime events, mailbox messages, scheduler decisions, policy events, and session errors
- make task-scoped timelines easy to inspect
- make `team_results` return completed task outputs, failure summaries, related messages, and member result summaries
- preserve enough chronology to answer who did what, why a task changed state, and where a result came from
- avoid turning timeline/results into natural-language prompt parsing; use persisted runtime state and events

Acceptance:

- host can inspect a task and understand its claim, messages, locks, completion/failure, and result path
- scheduler and policy decisions are visible in chronological context
- results are linked to tasks and members, not just free-floating summaries

### Stage 7C: Team Session Recovery

Goal: prevent long-running teams from getting stuck when sessions or backend prompts fail.

Tasks:

- define stale session detection through heartbeat, updated timestamps, backend errors, or explicit stop state
- add recovery behavior for tasks claimed by stopped, stale, or error sessions
- support releasing a claimed task back to pending when safe
- support retrying or reassigning failed work through explicit runtime state transitions
- support restarting or replacing a member session without losing team history
- record recovery decisions as events so host inspection can explain them

Current status:

- `team_recover_sessions` releases tasks held by error, stopped, or stale sessions back to `pending`
- stale working/waiting sessions can be detected with `staleAfterMs` and recorded as `session.stale`
- task-scoped path locks owned by the affected member are released during recovery
- recovery decisions are recorded as `session.recovered` events and surfaced through timeline/status inspection
- `replaceSessions: true` explicitly creates a fresh idle backend session for each recovered member and records `session.replaced`
- fake-backend tests cover both explicit error-session recovery and stale working-session recovery
- env-gated real OpenCode smoke now covers explicit recovery and retry for a `team_work` task: broken session guidance, `team_recover_sessions`, replacement session creation, task re-claim, and final completion/results inspection
- this is state recovery, not checkpoint/rewind or backend-level session resurrection

Acceptance:

- a crashed or stale session does not permanently strand a claimed task
- recovery actions are explicit, inspectable, and test-covered with the fake backend
- real OpenCode recovery and retry behavior remains env-gated and is now covered by a dedicated smoke until broader stability confidence is earned

### Stage 7D: Runtime Naming Cleanup

Goal: remove scaffold-era ambiguity after runtime control and recovery have a clear path.

Tasks:

- rename generic builder state away from OpenCode-specific names such as `openCode.builds`, `OpenCodeMemberDraft`, and `OpenCodeTeamBuild`
- isolate or archive scaffold-writing services and tests behind explicit legacy compatibility surfaces
- update stale builder-era docs once they no longer aid migration
- keep OpenCode-specific naming only in backend integration modules and compatibility code

Current first increment:

- domain types now expose team-native aliases `TeamBuildHost`, `TeamMemberDraft`, and `TeamBuild`
- runtime-first builder code should import the team-native names
- OpenCode-prefixed builder aliases have been removed from runtime domain types

Current second increment:

- runtime-first builder code uses `src/builder/teamBuildState.ts` as a team-native facade for selecting teams and requiring build state
- runtime code no longer depends on `state.openCode`
- legacy scaffold code under `src/opencode/*` still uses OpenCode-specific helpers by design until it is isolated or archived

Current schema migration increment:

- `TeamState` now has a team-native persisted `teamBuilds` key
- `JsonStore.migrate(...)` supports old files with only `openCode.builds`, new files with `teamBuilds`, and mixed files with deterministic `teamBuilds` precedence
- new writes persist only `teamBuilds`; `openCode.builds` remains historical migration input only
- runtime-first code keeps using the `teamBuilds(...)` facade
- compatibility scaffold code now reads build state through `openCodeBuilds(...)`, an explicit adapter over the team-native `teamBuilds(...)` facade

Current naming convergence increment:

- default/runtime-first code and tests now use `TeamMemberDraft` instead of `OpenCodeMemberDraft`
- legacy scaffold file generation now accepts the team-native `TeamMemberDraft` type even though it still writes OpenCode agent files
- OpenCode-prefixed builder aliases should not be reintroduced into default runtime-first modules

Current closeout status:

- default runtime-first tool descriptions no longer describe the product as an OpenCode scaffold builder
- docs now treat OpenCode-specific builder names as backend details, legacy migration notes, or historical input keys
- the `openCode.builds` compatibility mirror has been removed from new state writes while historical state files remain readable

Acceptance:

- new users see runtime-first concepts by default
- persisted and public terminology no longer implies that scaffold generation is the product center
- scaffold generation remains only a compatibility path or is removed

### Stage 8: Task-First OpenCode Team Workflow

Goal: make the existing runtime feel like a convenient LLM team inside OpenCode, without turning team operation into a complex product surface.

The team is a derivative of the user's task. The primary UX should be "give the team useful work and continue it", not "manage a team runtime". Existing low-level tools may remain for debugging and advanced control, but the next product surface should reduce tool selection, reduce prompt noise, and keep member context focused on the active task.

Current Stage 8 shape:

- `team_work` is the default host-facing path for normal task progress
- the same tool also covers the common continue path; there is no second primary public continue tool
- scheduler-assigned teammate prompts are compact task cards rather than runtime manuals
- low-level runtime tools remain available for inspect/debug/manual control, but are intentionally not the main workflow
- real OpenCode dogfood remains env-gated so default tests stay offline and deterministic

Direction summary:

- prefer one primary host-facing task tool over many narrow control tools
- keep agent-facing tools stable and small; do not add new member tools unless a real task loop needs them
- keep member prompts compact: identity, active task, relevant task-scoped messages, path hints/locks, finish/fail/help instructions
- make OpenCode usage convenient through tool descriptions and workflow docs rather than a large set of new tools
- use real OpenCode dogfood scenarios to validate whether the team actually helps complete tasks
- keep safety at the current lightweight policy/lock level unless a concrete task workflow exposes a real need

Recommended increments:

#### Stage 8A: Minimal Primary Task Tool

Add or consolidate toward a single high-level host tool, tentatively `team_work`, that covers the normal path:

- accept a user goal, optional `teamId`, optional path hints, optional preferred member, priority, `autoRun`, and `maxTicks`
- create the runtime task
- start or reuse runtime sessions when the team is ready but not running
- optionally run the bounded scheduler
- return the created task, scheduler decisions, control-plane summary, recent results, and next actions

This should compose existing runtime services instead of adding a parallel orchestration model.

#### Stage 8B: Continue Through The Same Primary Tool

Keep the common "keep going" action inside the same primary tool unless a second public tool becomes clearly necessary:

- inspect current control-plane state
- run bounded scheduling when runnable work and idle sessions exist
- report completed/failed tasks and recent task-scoped messages
- explain blockers such as dependencies, no idle sessions, stale/error sessions, or policy blocks
- optionally call existing recovery only when explicitly requested by input; do not make recovery surprising

If `team_work` can cleanly cover continuation without a second public tool, prefer one tool over two.

Current status: `team_work` now covers creation, continuation, and bounded execution. Scheduler-assigned teammate prompts use a compact task card with `teamId`/`memberId`/`taskId`, goal/details, path hints, task-scoped messages, active locks only when present, a short allowed/denied tool summary, and finish/fail/help instructions. The old runtime-tool-contract and runtime-policy manual blocks are intentionally not sent to every member prompt.

#### Stage 8C: OpenCode Workflow Ergonomics

Make the OpenCode-facing path obvious:

- update tool descriptions so the model prefers the primary task tool for normal work
- document the short workflow: build/finish team once, then use the primary task tool and continue/results views
- keep low-level tools documented as advanced controls rather than the default path
- remove or rewrite wording that makes users think they must operate the team manually before doing task work

Current first increment: default tool descriptions now steer normal task progress to `team_work`. Low-level host-facing runtime tools are labeled as inspect/debug, manual, recovery, or advanced control. Agent-facing tools are labeled as runtime-owned-member tools so the host-facing model should not treat them as the normal user workflow.

#### Stage 8D: Real Team Dogfood

Add an env-gated OpenCode scenario that proves the team helps with a real task:

- two or more runtime-owned sessions work on a task with clear sentinel output or a small file change
- at least one task-scoped message is exchanged only if it helps the task
- completion is tool-driven through `complete_task` / `fail_task`
- `team_status` / `team_results` explain the outcome without requiring raw log reading

Current first increment: the env-gated real OpenCode smoke suite includes a `team_work` dogfood path. It marks a team ready, calls the primary task-first tool with a real runtime-owned OpenCode member, lets the scheduler deliver the compact task card, and expects the member to complete the task through `complete_task`. The default test suite still skips this unless `TEAM_MCP_REAL_OPENCODE_SMOKE=1` is set.

#### Stage 8E: Workflow Hardening

Harden the default `team_work` path before adding more public runtime surface:

- validate real OpenCode behavior through env-gated dogfood without overfitting tests to exact model wording
- keep offline tests focused on the daily host workflow, especially compact default output versus opt-in detailed output
- keep docs ordered so a normal reader encounters `team_work` before low-level scheduler/runtime/task controls
- prefer small prompt or test-contract corrections over adding new orchestration layers

Current status: the real OpenCode smoke suite now validates successful tool behavior and inspectable state transitions without depending on brittle exact completion wording. Offline service tests also cover the compact-by-default and details-on-demand `team_work` host experience.

Non-goals for Stage 8:

- do not add shell/network tools just because permissions exist
- do not build Docker, OS sandboxing, checkpoint/rewind, or git worktree isolation as the next mainline
- do not add a large approval framework before there is a concrete execution tool that needs it
- do not add many narrow team-management tools when one task-level tool can compose existing primitives
- do not make member prompts carry long team manuals or policy documents

Acceptance:

- a normal OpenCode user can give the team a task without knowing the scheduler/status/results tool sequence
- the primary path uses the smallest practical number of host-facing tools
- `team_work` is clearly the default start/continue path in docs, tool descriptions, and tests
- member context is mostly task content, not team operating instructions
- low-level runtime tools remain available for inspection/debugging but are not the main UX
- real or env-gated OpenCode dogfood demonstrates that multiple sessions can help complete a task
- docs and APIs describe the team as task amplification, not as a heavyweight management framework

## Acceptance Criteria

The rewrite is not complete until all of the following are true:

- a confirmed teammate corresponds to a real runtime session
- two or more teammates can work concurrently in separate OpenCode sessions
- scheduler-driven tasks reach terminal states through real teammate activity
- one teammate can message another without host relay
- task claiming, completion, dependency unblocking, and failures are inspectable
- path locks prevent or expose file conflict risk
- runtime status shows active members, waiting members, recent results, mailbox state, locks, and scheduler decisions
- runtime status explains runnable work, blocked work, stale/error sessions, policy blocks, and suggested host/lead actions
- timeline and results explain collaboration paths through tasks, messages, locks, scheduler decisions, policy events, and member outputs
- session recovery can release, retry, reassign, restart, or stop affected work without losing team history
- the normal OpenCode path is task-first and uses a small number of primary tools instead of requiring manual runtime administration
- teammate prompts stay compact and focused on active task context
- builder UX remains user-authored while backend semantics are runtime-first
- legacy scaffold naming no longer dominates public docs or persisted runtime concepts
- Claude Code remains a reference for the agent-team category, not a product compatibility target

## Risks

- OpenCode SDK or server behavior may not support stable long-lived multi-session control.
- OpenCode permission prompts may block autonomous execution without an explicit policy layer.
- MCP tool access from runtime-owned OpenCode sessions may require extra session configuration or a bridge.
- JSON-file storage may become a bottleneck once multiple sessions write frequently.
- Preserving too much legacy scaffold behavior may keep the architecture split.

## Working Rules

- new work targets runtime documents and runtime modules
- legacy scaffold paths are touched only for compatibility or safe migration
- real OpenCode tests stay env-gated
- default tests stay deterministic and offline
- do not claim the product is a completed team runtime until MCP-tool-based or equivalent real teammate completion exists
- use team-runtime language by default: team runtime, member session, runtime-owned teammate, task, mailbox, lock, policy, timeline, result
- describe Claude Code Agent Teams only as a comparison or reference, not as the product target
- describe OpenCode as the first backend unless the current section is explicitly about backend integration
- make new capabilities visible in runtime state, tools, or events before treating them as product behavior
- minimize public tool growth; prefer composing existing runtime primitives behind task-level tools
- keep safety and policy lightweight until a concrete task workflow requires stronger enforcement

## Related Documents

- `runtime-api.md`
- `runtime-implementation.md`
- `runtime-migration.md`
