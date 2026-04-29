# Runtime Migration Plan

## Purpose

This document maps the current builder-centric codebase to the target runtime-first architecture.

It exists to reduce confusion while both shapes temporarily coexist in source.

## Transition Summary

### Current Shape

- default MCP surface is runtime-first
- builder UX configures runtime teams rather than generating scaffold by default
- runtime-owned OpenCode sessions, scheduler execution, mailbox, locks, policy, timeline/results, and recovery tools are implemented
- legacy OpenCode scaffold behavior still exists only in explicit compatibility code such as the scaffold writer, old OpenCode CLI dispatcher, scaffold dogfood smoke, and legacy coordination wrappers
- OpenCode runtime backend support, such as model discovery, may remain outside that legacy scaffold boundary
- persisted builder-flow storage now uses the team-native key `teamBuilds`; historical `openCode.builds` files remain readable as migration input

### Target Shape

- runtime-first
- backend-owned agent execution
- unified default MCP surface
- no hidden core coordination layer
- builder UX as team configuration for the runtime

## Legacy To Target Mapping

| Current area | Current role | Target role |
|---|---|---|
| `src/builder/teamBuilderService.ts` | Runtime-first builder flow | Keep as default builder UX for runtime team configuration |
| `src/builder/teamBuildState.ts` | Team-native facade over builder-flow persistence | Keep as the only runtime-first access point for builder state until persistence migration |
| `src/opencode/teamBuilderService.ts` | Legacy scaffold-writing builder flow | Compatibility path only |
| `src/cli/opencodeTools.ts` | Legacy OpenCode scaffold CLI dispatcher | Keep explicit and gated; do not import from default runtime startup or tool registration |
| `src/opencode/scaffoldService.ts` | Generates OpenCode files and config | Temporary migration helper only |
| `src/opencode/agentFileService.ts` | Writes member markdown files | Temporary or removable after runtime-owned sessions land |
| `src/opencode/templates.ts` | Host prompt and slash-command content | Temporary migration-only prompt assets |
| `src/tools/publicTeamBuilderTools.ts` | Default runtime-first builder and status surface | Keep; it should not call scaffold-writing services |
| `src/services/taskService.ts` | Hidden coordination primitive | Promote to first-class runtime core |
| `src/services/mailboxService.ts` | Hidden coordination primitive | Promote to first-class runtime core |
| `src/services/pathLockService.ts` | Hidden coordination primitive | Promote to first-class runtime core |
| `src/store/jsonStore.ts` | Single-file persistence | Keep first, replace later only if needed |

## MCP Surface Migration

### Current Default Tools

- `team_work`
- `team_status`
- `team_results`
- `team_models`

### Advanced Or Agent-Facing Tools

- host-facing builder/runtime/task/debug tools remain implemented, but default registration now hides them behind `TEAM_MCP_ENABLE_ADVANCED_TOOLS=1`
- agent-facing runtime tools remain registered because runtime-owned sessions still need them to coordinate through MCP
- compatibility `team_*` coordination tools remain only in legacy OpenCode compatibility code

### Default Runtime Surface

The final unified surface is described in [runtime-api.md](runtime-api.md). Migration intent:

1. Keep the default host-facing product surface lean and centered on `team_work`.
2. Let `team_work` absorb normal team setup, confirmation, finish, and task continuation instead of making users chain builder tools.
3. Keep manual builder/runtime controls such as `team_run`, `team_pause`, `team_resume`, and `team_stop` available behind an explicit advanced gate.
4. Remove the idea of an experimental hidden runtime API while still distinguishing default tools from advanced/manual ones.

### Current Default Surface

The default MCP registration path now exposes a lean runtime-first surface directly. The normal host-facing path is `team_work` plus inspection tools. Advanced/manual host-facing builder, task, mailbox, lock, scheduler, lifecycle, and timeline tools no longer require `TEAM_MCP_EXPERIMENTAL_TOOLS`, but they do require `TEAM_MCP_ENABLE_ADVANCED_TOOLS=1`.

Default team setup now stays inside `team_work` through builder guidance mode. Advanced/manual builder tools still preserve direct control when explicitly enabled, and member confirmation/removal remains runtime-only: `team_confirm` and `team_remove_member` update team/member state without generating `.opencode/agents` files or registering OpenCode subagents. Scaffold-writing behavior remains available only through legacy compatibility entrypoints during migration.

`team_models` may still be backed by OpenCode model discovery because OpenCode is the first execution backend. That does not make the default product scaffold-first.

## State Migration Strategy

### Current Runtime-Relevant State

Already useful:

- `teams`
- `members`
- `tasks`
- `messages`
- `pathLocks`
- `events`

### Historical State To Migrate

- `openCode.builds`
- `OpenCodeMemberDraft`
- OpenCode-specific finalized builder status as the center of truth

### Strategy

1. Add new runtime state fields alongside current OpenCode state.
2. Migrate builder workflows to write into runtime-aware structures.
3. Stop adding product depth to `openCode.*` storage.
4. Remove or archive `openCode.*` once runtime parity is sufficient.

Current progress:

- default member confirmation/removal writes runtime team/member state only
- default builder tools use `src/builder/teamBuilderService.ts`, not the scaffold-writing OpenCode builder service
- runtime-first builder code uses team-native types: `TeamBuildHost`, `TeamMemberDraft`, and `TeamBuild`
- runtime-first builder code accesses persisted build state through `src/builder/teamBuildState.ts`
- `teamBuilds` is now the team-native persisted build key
- OpenCode-prefixed builder compatibility aliases have been removed from runtime domain types
- `openCode.builds` is no longer written to new state files; it remains only as historical migration input

Legacy scaffold entrypoints still compile through the `openCodeBuilds(...)` adapter, but that adapter now reads `teamBuilds(state)` rather than `state.openCode`.

### `openCode.builds` Migration Design

The storage key `openCode.builds` is legacy terminology. The value represented team build state, not OpenCode scaffold output. Stage 9C moves the persisted shape to `teamBuilds` only while keeping historical reads safe.

The schema v4 migration has the following guarantees:

- old files with only `openCode.builds` migrate into `teamBuilds`
- mixed files use deterministic `teamBuilds` precedence
- new writes persist only `teamBuilds`
- runtime-first code uses `teamBuilds(state)` and does not access `state.openCode`

The removal criteria for the compatibility mirror are now satisfied:

- default runtime-first builder code no longer imports legacy `src/opencode/*` helpers
- compatibility scaffold code reads build state through an explicit adapter instead of direct `state.openCode` access
- `JsonStore.migrate(...)` keeps tests for old files with only `openCode.builds`
- `JsonStore.migrate(...)` keeps tests for new files with the target team-native key
- mixed files with both keys keep a deterministic precedence rule
- removing the legacy mirror does not erase data needed by compatibility entrypoints because they read through `openCodeBuilds(...)`

Current target shape:

```ts
interface TeamState {
  teamBuilds: Record<string, TeamBuild>;
}
```

The migration path is now:

1. Add the team-native persisted key `teamBuilds`.
2. Keep legacy scaffold code behind compatibility entrypoints instead of letting default runtime code read `state.openCode` directly.
3. Route compatibility scaffold reads through `openCodeBuilds(...)`, an explicit adapter over the team-native facade.
4. Cover old-only, new-only, mixed, and write-through migration behavior with tests.
5. Stop writing `openCode.builds` while continuing to read it from historical files.

The rule is simple: runtime-first code may use the `teamBuilds(...)` facade, and historical `openCode.builds` appears only inside store migration and migration documentation.

## Test Migration Strategy

### Keep

- domain service tests for tasks, mailbox, path locks, and store concurrency

### Rewrite

- OpenCode scaffold-specific tests that assume generated files are the product center
- prompt-lock tests that overfit the builder-only host instructions

### Add

- scheduler tests
- session lifecycle tests
- backend abstraction tests
- runtime integration tests

## Documentation Migration Strategy

### New Source Of Truth

During the rewrite, these become the active planning documents:

- `docs/runtime-rfc.md`
- `docs/runtime-api.md`
- `docs/runtime-implementation.md`
- `docs/runtime-migration.md`

### Removal Rule

Builder-era product docs and run logs should be removed once they no longer help migration work.

The repository should not keep stale builder guidance in parallel with the runtime source-of-truth docs, because that creates implementation drift.

## Interface Shutdown Rules

As part of migration discipline:

- default MCP registration and package stdio startup are runtime-first
- default runtime startup and tool registration must not import scaffold-era legacy modules
- legacy scaffold-writing behavior must stay behind explicit compatibility entrypoints
- legacy OpenCode CLI integration may remain for migration and compatibility, but it must not be treated as the default product path
- new product work should target runtime modules, runtime tools, and runtime docs

This prevents more accidental investment in the builder-only path while runtime implementation is underway.
