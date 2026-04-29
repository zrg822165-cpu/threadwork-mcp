# Runtime Implementation Plan

## Purpose

This document turns the RFC into an executable implementation sequence.

The emphasis is on smallest-correct architectural steps rather than a giant rewrite in one patch.

## Implementation Rules

1. Do not add more product depth to the legacy OpenCode scaffold path.
2. Prefer moving logic into new runtime modules over stretching `opencode/*` further.
3. Keep the builder UX recognizable while replacing its backend semantics.
4. Ship verifiable phases with tests after each phase.
5. Treat runtime-owned execution as the main objective, not documentation-only parity.

## Current Baseline

The current baseline has shifted from host-led recovery polish to message-driven team runtime.

Keep `team_work` as the default build-and-work surface, but treat member-to-member mailbox threads as the core path toward real team behavior. The next implementation slice should derive discussion state from existing messages and `messageDeliveries`: expected participants, responded participants, pending members, latest opinions, unresolved questions, and whether host judgment is needed.

This should remain bounded and low-noise. Do not add an always-on listener, a new default `team_discuss` tool, broad task-planning orchestration, or heavy isolation work as the next step.

Current Stage 14B baseline:

- discussion state is now derived in one shared runtime layer and reused by status, timeline, results, and compact views
- active thread summaries expose expected members, responded members, pending members, latest per-member opinions, unresolved questions, and host-decision needs
- `team_status` wording now summarizes discussion progress in team terms instead of raw unread counts alone
- `team_work` now consumes the same discussion state for bounded-stop reasons, continuation guidance, and `recommendedInput` thread continuation

Next small step:

- tighten the scheduler and host-view contract around derived thread state instead of generic unread-message counts
- decide whether host judgment should stay as a generic continuation step or become a more explicit default `team_work` payload shape
- keep turn-taking bounded and low-noise; do not expand into always-on listening or a larger default tool surface

## Phase 0: OpenCode Backend Proof

### Goal

Prove that one Node.js process can create and manage multiple OpenCode sessions programmatically.

### Deliverables

- `src/runtime/openCodeBackend.poctest.ts` or equivalent test harness under `.ai-tmp/`
- result notes added to a committed doc section or follow-up run log

### Prototype Tasks

1. Add `@opencode-ai/sdk` dependency.
2. Write a minimal backend experiment that:
   - starts or attaches to an OpenCode server
   - creates one session
   - sends one prompt
   - receives one response
3. Expand the experiment to two concurrent sessions.
4. Record:
   - startup latency
   - concurrency behavior
   - permission behavior
   - failure modes on Windows

### Acceptance

- Two sessions can exist at once.
- Both sessions can receive prompts and produce results.
- Session IDs are stable enough to track in runtime state.

### If SDK Fails

Fallback plan:

- prototype `opencode run` with one-shot subprocess execution
- treat that as degraded backend mode
- do not continue into scheduler work until the control path is good enough

## Phase 1: Runtime Module Skeleton

### New Files

- `src/runtime/types.ts`
- `src/runtime/agentBackend.ts`
- `src/runtime/openCodeBackend.ts`
- `src/runtime/agentSpawner.ts`
- `src/runtime/runtimeService.ts`
- `src/runtime/eventBus.ts`

### Responsibilities

#### `runtime/types.ts`

Define runtime-only types so they stop leaking through OpenCode-specific files.

#### `agentBackend.ts`

Define backend interface:

```ts
export interface AgentBackend {
  readonly name: "opencode";
  start(): Promise<void>;
  stop(): Promise<void>;
  spawnSession(input: SpawnSessionInput): Promise<SpawnSessionResult>;
  promptSession(input: PromptSessionInput): Promise<PromptSessionResult>;
  abortSession(sessionId: string): Promise<void>;
}
```

#### `openCodeBackend.ts`

Wrap SDK specifics and isolate all OpenCode API coupling here.

#### `agentSpawner.ts`

Map members to runtime session records and expose lifecycle helpers.

#### `runtimeService.ts`

Own top-level runtime lifecycle:

- start runtime
- pause runtime
- resume runtime
- stop runtime
- read runtime status

#### `eventBus.ts`

Provide in-process publish/subscribe for scheduler-driven behavior.

### Acceptance

- Code compiles.
- A runtime can start with zero tasks.
- Session creation works through a single service seam.

## Phase 2: State Migration

### Files To Change

- `src/domain/types.ts`
- `src/store/jsonStore.ts`
- `src/services/taskService.ts`
- `src/services/mailboxService.ts`
- `src/services/pathLockService.ts`
- `src/services/events.ts`

### Required State Additions

1. `runtime` section in `TeamState`
2. `teamRuntimes` records
3. `agentSessions` records
4. `schedulerState` records

### Required Task Changes

Add:

- `failed`
- `cancelled`
- `priority`
- `preferredMemberId`
- `failureSummary`

### Required Mailbox Changes

Add:

- `type`
- `replyToMessageId`
- `consumedAt`

### Required Lock Changes

Add:

- stale lock cleanup policy
- heartbeat or expiration checks on read/write paths

### Acceptance

- Old state can migrate into the new schema without data loss.
- New state reads and writes still work through `JsonStore`.

## Phase 3: Scheduler

### New File

- `src/runtime/scheduler.ts`

### Scheduler Loop Responsibilities

One tick should do the following in order:

1. Read current runtime state.
2. Refresh session health.
3. Consume new messages or task completions.
4. Identify runnable tasks:
   - status is `pending`
   - dependencies are satisfied
   - task is not cancelled
5. Match runnable tasks to available members.
6. Trigger prompts into selected sessions.
7. Record `scheduler.assignment` events.

### First Matching Strategy

Keep it simple in v1:

- prefer `preferredMemberId` if set
- otherwise score members by exact match against `callWhen`, responsibility text, and current idleness
- do not overbuild a planner before basic runtime loops work

### Member Prompt Contract

The scheduler should give each activated member a structured prompt block that includes:

- member identity
- active task
- relevant unread inbox messages
- required path-lock policy
- completion instructions
- escalation instructions

### Acceptance

- One pending task gets claimed and completed by a live session.
- Two independent tasks can be worked in parallel by two sessions.
- Completing task A unblocks dependent task B.

## Phase 4: Unified Tool Surface

### Files To Change

- `src/tools/registerTools.ts`
- old builder tool modules
- old experimental coordination tool modules
- any CLI wrappers that assume scaffold generation is the product

### Plan

1. Create a new runtime-oriented tool registration module.
2. Keep builder-style names where they help UX.
3. Compose task, message, runtime control, and recovery behavior behind the primary default surface instead of exposing every low-level primitive as a normal user workflow.
4. Remove the old experimental split while keeping low-level manual/debug tools behind the explicit advanced gate.

### Acceptance

- No env flag is needed to use task or messaging features.
- `team_status` reflects real runtime state.
- The old experimental split is gone.

### Current Status

Implemented for the default registration path. The default host-facing surface is now intentionally lean: `team_work`, `team_status`, `team_results`, and optional `team_models`. Low-level lifecycle, scheduler, task CRUD, mailbox, path-lock, timeline, recovery, and agent-facing runtime tools remain implemented for manual control, recovery, debugging, tests, and runtime-owned member use, but the host-facing manual controls are exposed only with `TEAM_MCP_ENABLE_ADVANCED_TOOLS=1`. The old `TEAM_MCP_EXPERIMENTAL_TOOLS` flag no longer expands the default surface.

Scheduler prompt failures now preserve inspectable runtime state: when a backend prompt fails after a task is claimed, the task is marked `failed`, the session is marked `error`, and `scheduler.prompt_error` is recorded before the error is returned to the caller. This prevents tasks from being stranded in `claimed` with sessions stuck in `working`.

The bounded scheduler runner is implemented as a thin orchestration layer over deterministic ticks. `team_scheduler_run` repeatedly invokes scheduler ticks until idle, paused, error, or `maxTicks`; it does not create sessions and does not act as an always-on daemon. Store-backed scheduler tools use split execution: `prepareTick(...)` claims work in a short transaction, OpenCode prompting happens outside the `JsonStore` lock, and prompt success/failure plus the final scheduler decision are recorded in follow-up transactions. This avoids holding the store lock while an agent-facing MCP tool call is expected to mutate runtime state.

## Phase 5: Builder Backend Rewrite

### Files Likely To Change Heavily

- `src/opencode/teamBuilderService.ts`
- `src/opencode/templates.ts`
- `src/opencode/agentFileService.ts`
- `src/opencode/scaffoldService.ts`
- `src/cli/initOpencode.ts`
- `src/cli/opencodeTools.ts`

### Goal

Stop treating OpenCode scaffold generation as the center of the product.

### Concrete Direction

- keep only the minimum code needed for migration and backend experiments
- move builder logic out of OpenCode-specific phrasing where possible
- replace generated agent markdown assumptions with runtime member/session assumptions
- keep scaffold-writing builder functions only behind explicit legacy compatibility entrypoints

### Current Status

Started. Default MCP `team_confirm` and `team_remove_member` now update team/member state only and do not generate or remove OpenCode agent files. Legacy `runOpenCodeTool` still uses the scaffold-writing path so existing migration tests and manual compatibility workflows remain available while backend parity work continues.

The default builder tools now use a generic runtime-first builder service instead of the OpenCode scaffold builder service. Default `team_finish` returns runtime activation guidance instead of `@member` report prompts, and default `team_status` no longer checks or reports OpenCode scaffold diagnostics. Scaffold-writing builder behavior remains in the legacy OpenCode compatibility path.

### Possible End State

The legacy scaffold code may end up archived or deleted if runtime-owned execution makes it unnecessary.

## Test Plan

### Unit Tests

Add tests for:

- runtime state migration
- session record lifecycle
- scheduler assignment rules
- task dependency unblocking
- failure and retry handling
- mailbox routing
- stale path-lock cleanup

### Integration Tests

Add an integration suite that uses a fake backend first.

Why:

- scheduler logic should be testable without real OpenCode sessions
- backend-specific failures should be isolated

Suggested files:

- `tests/runtime.scheduler.test.ts`
- `tests/runtime.service.test.ts`
- `tests/runtime.backend.fake.test.ts`

### Real Backend Smoke

After fake-backend confidence exists, add an OpenCode-backed smoke that verifies:

1. spawn two sessions
2. assign two tasks
3. both sessions produce results
4. one session can send a runtime message to another

Current smoke coverage starts with real session ownership and is gated behind an explicit environment variable so normal tests do not require OpenCode credentials or live model access:

```bash
TEAM_MCP_REAL_OPENCODE_SMOKE=1 npm test -- tests/runtime.opencode.smoke.test.ts
```

The smoke verifies that `OpenCodeBackend` can start two runtime-owned sessions, persist stable backend session IDs, prompt sessions concurrently for real model replies, drive scheduler assignment, let a runtime-owned session call this MCP server's agent-facing tools, complete a task through `complete_task` so the next scheduler tick can unblock dependent work, coordinate across two runtime-owned sessions through task-scoped mailbox messages without host relay, complete a scheduler-assigned task from inside the scheduler prompt without a store-lock deadlock, and explicitly recover a broken `team_work` assignment through `team_recover_sessions` before retrying and completing it with a replacement session.

The cross-session mailbox smoke asserts that one session sends a question, the recipient reads it through `inbox`, replies with `replyToMessageId`, acknowledges the original through `ack_message`, and the initiator completes the task from the reply. Persisted messages, mailbox events, task completion, and result messages remain inspectable through runtime state.

Real OpenCode smoke config explicitly sets `model` and `small_model` to `hugusir/gpt-5.4` in the project-local backend config. The global OpenCode config is not modified.

Real smoke backends now also inject an explicit `hostname` and an independently reserved local `port` into each `OpenCodeBackend`. This avoids collisions on the OpenCode SDK default server port `4096`, so separate live smoke commands can run concurrently without one backend failing to start its local server.

The current real recovery/retry smoke intentionally simulates the broken session at runtime-state level instead of trying to force an uncontrolled OpenCode crash. This keeps the contract under test stable: `team_work` must point the host toward explicit recovery, `team_recover_sessions` must release and optionally replace the affected session, and a retried `team_work` path must be able to re-claim and finish the same task while leaving `team_status`, `team_results`, and runtime events explainable.

The current Stage 6 coverage combines deterministic policy tests with real backend smoke: offline service/tool tests verify that a read-only member's `lock_paths` call is rejected by runtime policy and persisted as `policy.blocked`, while the real OpenCode smoke verifies that an edit-capable member can acquire a path lock and complete its own claimed task. This proves policy failures are visible in runtime state rather than being prompt-only instructions or silent stalls, without depending on model recovery from deliberate tool-denial errors.

### Current Stage 10A Status And Baseline

The runtime-first daily workflow now centers on `team_work` as the default build-and-work surface, and the immediate implementation focus is making that single host-facing entrypoint lighter, lower-noise, and easier to discover.

- Stage 8A added `team_work` as the primary task-first host entrypoint.
- Stage 8B compacted scheduler-assigned member prompts into task cards instead of copying a runtime manual into every assignment.
- Stage 8C updated tool descriptions and docs so `team_work` is clearly the default workflow and low-level tools are framed as inspect/debug/manual control.
- Stage 8D added env-gated real OpenCode dogfood coverage for the `team_work` path.
- Stage 8E hardened that path instead of expanding architecture: real smoke validates behavior rather than brittle exact model wording, offline tests cover compact-vs-detailed `team_work` output, and docs present `team_work` before low-level controls.
- Stage 8F made the package stdio entrypoint start the runtime-first MCP server by default while keeping old OpenCode scaffold CLI commands gated.
- Stage 8G strengthened `team_work` continuation guidance across claimed, failed, paused, error, stale, blocked, and message-driven states, with offline fake-backend coverage.
- Stage 8H isolates the legacy OpenCode scaffold CLI boundary: the default runtime entrypoint should not import scaffold-era modules, and old `init-opencode`, `opencode-tool`, and `dogfood-opencode` behavior remains migration-only behind `TEAM_MCP_ENABLE_LEGACY_OPENCODE=1`.
- Stage 9A proved first-run readiness for the default stdio MCP product path.
- Stage 9B adds an env-gated real OpenCode recovery/retry smoke that proves `team_work` guidance, explicit `team_recover_sessions`, replacement-session retry, and final results inspection.
- Stage 9B.1 removes a practical live-test infrastructure blocker by allowing each `OpenCodeBackend` to inject its own local server port; the real smoke suite no longer has to serialize runs purely to avoid the SDK default `4096` port conflict.
- Stage 9C moved persisted default state fully onto `teamBuilds` while keeping historical `openCode.builds` migration reads.
- Stage 10A folds default team building into `team_work`: when a team does not exist or is unfinished, the tool returns builder guidance with compact `question`, `choices`, and `nextPrompt` fields instead of pushing the host into a multi-tool builder chain.
- Stage 10A also hides low-level builder/runtime host tools from the default MCP registration path and keeps them available only behind `TEAM_MCP_ENABLE_ADVANCED_TOOLS=1` for manual control, recovery, and tests.
- Stage 10C hardens failure explanation and recovery guidance without expanding the default host-facing tool surface: `team_status`, `team_results`, and `team_work` now expose compact explainability fields, `team_results` attributes outcomes with `memberContributions`, and env-gated real OpenCode smoke covers happy-path work, dependency-blocked continuation, explicit failure reporting, and broken-session recovery/retry.
- Stage 11A adds TUI-first compact host views without creating a new tool surface: `team_status.compactStatus` and `team_results.compactResults` now carry a stable headline plus supporting-line contract for first-screen cards, while runtime docs explicitly treat OpenCode TUI as the primary host consumer and keep richer payloads for drill-down.
- The follow-on **Default UX Contract Stabilization** pass is now the baseline for new runtime work: grouped `team` / `builder` / `work` inputs are the recommended path, flat top-level fields remain compatibility-only, `recommendedInput` is the minimal next-call template, `explain` is the shared recovery/inspection layer, and `compactStatus` / `compactResults` are the intentionally small host-card contract.
- Stage 11B is now checked in on top of that baseline: bounded progress is persisted per team, bounded runs stop with explicit product-facing reasons, and `team_work` / `team_status` / `team_results` expose the latest bounded-run state without adding a new default public tool.

Stage 10A keeps the release-hardening discipline from Stage 9D while simplifying the default product surface:

- `npm run build`
- `npm run typecheck`
- `npm test`
- optional live backend verification with `TEAM_MCP_REAL_OPENCODE_SMOKE=1 npm test -- tests/runtime.opencode.smoke.test.ts`
- optional package inspection with `npm pack --dry-run`

The testing split remains intentional:

- default tests must remain offline, deterministic, and free of OpenCode credential requirements
- built stdio entrypoint smoke covers the shipped MCP product surface from `dist/index.js`
- real OpenCode smoke is env-gated live-backend dogfood and should not be re-described as a default CI requirement

The default-contract stabilization passes were intentionally not daemon/sandbox/worktree phases. Their goal was to make the task-first runtime reliable, repeatable, continuous, and easier to use in normal OpenCode conversations.

That host contract is now stable enough to act as baseline product behavior. The next implementation pass should extend existing runtime state and continuation surfaces only where the current lean recovery contract still feels ambiguous in live use, while continuing to avoid a jump to a permanent daemon, heavyweight sandbox, worktree, checkpoint, or native pane UI phase.

Stage 10A non-goals:

- no always-on daemon scheduler
- no shell/network sandbox layer
- no worktree or checkpoint isolation
- no native pane UI or teammate-switching UI

### Runtime Policy Layer

The first policy implementation is deliberately small and runtime-first:

- `Member.permissions` is enforced by code for agent-facing tools.
- `read-only` members may read, message, escalate, and report task failure, but cannot acquire edit locks.
- `read` + `edit` members may acquire path locks and complete their own claimed tasks.
- members cannot unlock another member's path locks through the agent-facing `unlock_paths` tool.
- members cannot complete or fail a task claimed by a different member.
- policy denials are recorded as `policy.blocked`; suspicious but allowed lock requests, such as locking outside task path hints, are recorded as `policy.warning`.

This does not attempt to sandbox shell or network access because no runtime shell/network tool exists yet. Those permissions remain explicit future policy terms rather than fake enforcement.

That limitation is now central to the next stage definition. Stage 12 should begin by making boundaries and safety signals explicit in runtime state and host explanations before claiming stronger enforcement than the backend/runtime seam can really provide.

## Suggested Work Order In One Fresh Session

1. Add runtime types and backend interface.
2. Run the OpenCode SDK PoC.
3. Add runtime state and schema migration.
4. Implement a fake backend for tests.
5. Implement scheduler logic against the fake backend.
6. Swap in the real OpenCode backend.
7. Unify the public tool surface.
8. Remove scaffold-first assumptions.

## Runtime Entrypoint And Legacy CLI Boundary

The runtime rewrite now has a credible default MCP surface, so the package entrypoint should start the runtime-first MCP server directly.

- the default stdio MCP server path is runtime-first and enabled by default
- the legacy OpenCode CLI integration path is disabled by default
- legacy OpenCode CLI compatibility can be temporarily re-enabled only through `TEAM_MCP_ENABLE_LEGACY_OPENCODE=1` for migration work

That boundary keeps normal users on `team_work` and the runtime tool surface while preserving explicit migration access to old scaffold-writing behavior.

Stage 8H tightens this from a guard-only rule into an import boundary: the package startup path and default tool registration should not import scaffold-era modules such as the legacy OpenCode CLI dispatcher, scaffold writer, scaffold dogfood smoke, or legacy coordination wrappers. Runtime OpenCode backend support, such as model discovery and runtime-owned sessions, is not legacy by itself.
