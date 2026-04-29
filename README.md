# Threadwork MCP

`Threadwork MCP` is the repository and product name. Internal package names and tool identifiers still use `team-mcpv2` for now while the runtime surface stabilizes.

`team-mcpv2` is a runtime-first, task-first MCP team runtime. It uses OpenCode as the first execution backend and treats a team as a task amplifier rather than a scaffold generator or a heavyweight team-management product.

The default user-facing goal is simple: use `team_work` as one lightweight conversational entrypoint to build a team, continue team setup, confirm members, finish the team, and then create or continue work. Low-level builder and runtime tools remain available only for inspect/debug/manual control when explicitly enabled.

## Current Direction

- runtime-first instead of scaffold-first
- task-first instead of team-administration-first
- tool-driven runtime state instead of prompt-only coordination
- compact teammate task cards instead of long runtime manuals
- one primary host-facing workflow through `team_work`

Start with these docs:

- [docs/runtime-rfc.md](docs/runtime-rfc.md): product direction and guardrails
- [docs/runtime-roadmap.md](docs/runtime-roadmap.md): next-stage roadmap and acceptance criteria
- [docs/runtime-api.md](docs/runtime-api.md): current tool surface and default workflow
- [docs/runtime-implementation.md](docs/runtime-implementation.md): implementation sequencing and current stage notes
- [docs/runtime-migration.md](docs/runtime-migration.md): compatibility and migration boundaries

## What Exists Today

The checked-in code already includes the main runtime spine:

- runtime lifecycle and session ownership
- shared task, mailbox, path-lock, event, and result state
- deterministic scheduler ticks plus bounded scheduler runs
- agent-facing MCP tools such as `complete_task`, `fail_task`, `send_message`, `inbox`, `lock_paths`, and `ask_lead`
- host-facing inspection tools such as `team_status` and `team_results`
- `team_work` as the primary build-and-work entrypoint
- offline fake-backend tests plus env-gated real OpenCode smoke coverage

This is no longer just a redesign document set. The repository contains a working runtime-first implementation, with legacy scaffold code kept only as compatibility material.

## Default Workflow

The intended path for normal work is:

1. Use `team_work` to build or resume a lightweight team.
2. Continue `team_work` to confirm members, finish the team, and create or continue a task.
3. Let the runtime start or reuse teammate sessions and run bounded scheduling when appropriate.
4. Inspect `team_status` or `team_results` only when more detail is needed.

If a change does not make this default path more natural, low-noise, and inspectable, it is probably not the right next investment.

## First-Run Quickstart

The default product entrypoint is the stdio MCP server in `dist/index.js`. You do not need any legacy env flag to use the runtime-first tool surface.

First-run and release readiness are intentionally separate concerns:

- first-run proves a new user can connect to the default MCP surface and use `team_work`
- release readiness proves the checked-in package still builds, typechecks, passes offline tests, and can optionally pass live smoke before publish

1. Install dependencies and build the package.
2. Point your MCP client at `node ./dist/index.js`.
3. Confirm the client can see `team_work`, `team_status`, `team_results`, and `team_models`.
4. Build a small team and start work through `team_work`.

```bash
npm install
npm run build
node dist/index.js
```

Example MCP stdio config:

```json
{
  "mcp": {
    "team_mcpv2": {
      "command": ["node", "./dist/index.js"]
    }
  }
}
```

Suggested first-run tool flow:

1. `team_models` if you want model discovery
2. `team_work` to start or resume team setup
3. `team_work` again to save a member draft, confirm a member, add another member, or finish the team
4. `team_work` again to create or continue task work
5. `team_status` or `team_results` when more detail is needed

If `team_work` reports that the team is still being built, follow its returned `question`, `choices`, and `nextPrompt` to continue the same tool flow. If it reports paused or errored runtime state, follow the returned guidance. Advanced/manual builder and runtime tools stay hidden by default and can be exposed with `TEAM_MCP_ENABLE_ADVANCED_TOOLS=1`.

OpenCode local config uses the same default stdio server path. A minimal local setup looks like:

```json
{
  "mcp": {
    "team_mcpv2": {
      "command": ["node", "./dist/index.js"]
    }
  }
}
```

The runtime-first path is isolated from the legacy scaffold CLI. You should not need `TEAM_MCP_ENABLE_LEGACY_OPENCODE=1` unless you are doing explicit migration-only work with `init-opencode`, `opencode-tool`, or `dogfood-opencode`.

Runtime state now persists team-builder progress under the team-native `teamBuilds` key. Older state files that still contain `openCode.builds` are migrated on read, but new writes do not recreate that legacy key.

## Verification

Stage 10A keeps release readiness and smoke discipline in place while simplifying the default runtime surface.

Recommended release readiness order:

```bash
npm run build
npm run typecheck
npm test
```

Optional package dry-run before publish:

```bash
npm pack --dry-run
```

Test layering is intentional:

- `npm test` must stay offline, deterministic, and free of OpenCode credential requirements
- built stdio entrypoint smoke covers the default MCP product surface shipped from `dist/index.js`
- real OpenCode smoke only validates the live backend and dogfood path; it does not belong in default CI

Real OpenCode smoke stays explicitly gated so normal tests remain offline and deterministic:

```bash
TEAM_MCP_REAL_OPENCODE_SMOKE=1 npm test -- tests/runtime.opencode.smoke.test.ts
```

The real smoke suite now injects an independent local port into each `OpenCodeBackend` instance, so concurrent live smoke commands do not collide on the OpenCode SDK default server port `4096`.

## Legacy Compatibility

The default package entrypoint starts the runtime-first MCP server and does not load the legacy scaffold CLI path. Legacy builder-era OpenCode scaffold CLI entrypoints are intentionally not the default product surface and can still be reopened temporarily for migration-only work with an explicit env flag:

- `TEAM_MCP_ENABLE_LEGACY_OPENCODE=1`

The gated legacy commands are `init-opencode`, `opencode-tool`, and `dogfood-opencode`. They are kept for migration compatibility, not as the path for new runtime product work.

If a file or behavior only preserves the old scaffold-first product shape and does not help the runtime-first system or migration boundary, it should be removed rather than treated as current product guidance.
