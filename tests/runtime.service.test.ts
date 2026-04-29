import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyState, SCHEMA_VERSION, type TeamBuild } from "../src/domain/types.js";
import type { AgentBackend } from "../src/runtime/agentBackend.js";
import { FakeAgentBackend } from "../src/runtime/fakeAgentBackend.js";
import { RuntimeService } from "../src/runtime/runtimeService.js";
import type { PromptSessionInput, PromptSessionResult, SpawnSessionInput, SpawnSessionResult } from "../src/runtime/types.js";
import { TeamService } from "../src/services/teamService.js";
import { JsonStore } from "../src/store/jsonStore.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runtime state migration", () => {
  it("migrates schema v2 state with runtime collections", async () => {
    const rootDir = await tempRoot();
    const dataDir = join(rootDir, ".team-mcp");
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, "state.json"),
      JSON.stringify({
        schemaVersion: 2,
        teams: {},
        members: {},
        tasks: {},
        messages: {},
        pathLocks: {},
        events: [],
        openCode: { builds: {} }
      }),
      "utf8"
    );

    const state = await new JsonStore({ rootDir }).read();

    expect(state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(state.teamRuntimes).toEqual({});
    expect(state.agentSessions).toEqual({});
    expect(state.schedulerStates).toEqual({});
    expect(state.taskBoundaries).toEqual({});
    expect(state.safetySignals).toEqual({});
    expect(state).not.toHaveProperty("openCode");
  });

  it("migrates legacy openCode builds into the team-native build key", async () => {
    const rootDir = await tempRoot();
    const legacyBuild = buildFixture("team_old", "legacy lead");

    await writeRawState(rootDir, {
      schemaVersion: 3,
      teams: {},
      members: {},
      tasks: {},
      messages: {},
      pathLocks: {},
      events: [],
      openCode: { builds: { team_old: legacyBuild } }
    });

    const state = await new JsonStore({ rootDir }).read();

    expect(state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(state.teamBuilds.team_old).toMatchObject({ teamId: "team_old", host: { name: "legacy lead" } });
    expect(state).not.toHaveProperty("openCode");
  });

  it("keeps team-native builds without backfilling the old OpenCode key", async () => {
    const rootDir = await tempRoot();
    const runtimeBuild = buildFixture("team_new", "runtime lead");

    await writeRawState(rootDir, {
      schemaVersion: 3,
      teams: {},
      members: {},
      tasks: {},
      messages: {},
      pathLocks: {},
      events: [],
      teamBuilds: { team_new: runtimeBuild },
      openCode: { builds: {} }
    });

    const state = await new JsonStore({ rootDir }).read();

    expect(state.teamBuilds.team_new).toMatchObject({ teamId: "team_new", host: { name: "runtime lead" } });
    expect(state).not.toHaveProperty("openCode");
  });

  it("prefers team-native builds when migration sees mixed build keys", async () => {
    const rootDir = await tempRoot();
    const legacyBuild = buildFixture("team_mixed", "legacy lead");
    const runtimeBuild = buildFixture("team_mixed", "runtime lead");

    await writeRawState(rootDir, {
      schemaVersion: 3,
      teams: {},
      members: {},
      tasks: {},
      messages: {},
      pathLocks: {},
      events: [],
      teamBuilds: { team_mixed: runtimeBuild },
      openCode: { builds: { team_mixed: legacyBuild } }
    });

    const state = await new JsonStore({ rootDir }).read();

    expect(state.teamBuilds.team_mixed?.host.name).toBe("runtime lead");
    expect(state).not.toHaveProperty("openCode");
  });

  it("persists only the team-native build key after schema v4 migration", async () => {
    const rootDir = await tempRoot();
    const store = new JsonStore({ rootDir });

    await store.transaction((state) => {
      state.teamBuilds.team_write = buildFixture("team_write", "writer");
    });

    const raw = JSON.parse(await readFile(join(rootDir, ".team-mcp", "state.json"), "utf8")) as {
      schemaVersion: number;
      teamBuilds: Record<string, TeamBuild>;
      openCode?: unknown;
    };

    expect(raw.schemaVersion).toBe(SCHEMA_VERSION);
    expect(raw.teamBuilds.team_write?.host.name).toBe("writer");
    expect(raw).not.toHaveProperty("openCode");
  });
});

describe("RuntimeService", () => {
  it("starts runtime sessions for active team members", async () => {
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "runtime" }).team;
    const first = teams.addMember({ teamId: team.id, name: "Patch Builder", agentId: "patch-builder", model: "test/model" });
    const second = teams.addMember({ teamId: team.id, name: "Scope Keeper", agentId: "scope-keeper" });
    const backend = new FakeAgentBackend();

    const status = await new RuntimeService(state, backend).start({ teamId: team.id, workdir: "C:/repo", maxParallel: 2 });

    expect(status.status).toBe("running");
    expect(status.runtime).toMatchObject({ teamId: team.id, backend: "opencode", workdir: "C:/repo", maxParallel: 2, autoAssign: true });
    expect(status.sessions).toHaveLength(2);
    expect(status.sessions.map((session) => session.memberId)).toEqual([first.id, second.id]);
    expect(status.sessions.every((session) => session.status === "idle" && session.backendSessionId)).toBe(true);
    expect(state.schedulerStates[team.id]).toMatchObject({ teamId: team.id, paused: false });
    expect(state.events.map((event) => event.type)).toContain("runtime.started");
    expect(state.events.map((event) => event.type)).toContain("session.started");
  });

  it("reports not_started before runtime activation", () => {
    const state = emptyState();
    const team = new TeamService(state).createTeam({ name: "idle" }).team;

    const status = new RuntimeService(state, new FakeAgentBackend()).status(team.id);

    expect(status.status).toBe("not_started");
    expect(status.sessions).toEqual([]);
  });

  it("marks a team runtime ready before activation", () => {
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "ready" }).team;
    teams.addMember({ teamId: team.id, name: "Worker" });

    const status = new RuntimeService(state, new FakeAgentBackend()).markReady({ teamId: team.id, workdir: "C:/repo", maxParallel: 1 });

    expect(status.status).toBe("ready");
    expect(status.runtime).toMatchObject({ teamId: team.id, status: "ready", workdir: "C:/repo", maxParallel: 1, autoAssign: true });
    expect(status.sessions).toEqual([]);
    expect(state.schedulerStates[team.id]).toMatchObject({ teamId: team.id, paused: true });
    expect(state.events.map((event) => event.type)).toContain("runtime.ready");
  });

  it("pauses, resumes, and stops runtime sessions", async () => {
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "lifecycle" }).team;
    teams.addMember({ teamId: team.id, name: "Worker" });
    const backend = new FakeAgentBackend();
    const runtime = new RuntimeService(state, backend);

    await runtime.start({ teamId: team.id });
    expect(runtime.pause({ teamId: team.id }).status).toBe("paused");
    expect(state.schedulerStates[team.id]?.paused).toBe(true);
    expect(runtime.resume({ teamId: team.id }).status).toBe("running");
    expect(state.schedulerStates[team.id]?.paused).toBe(false);

    const stopped = await runtime.stop({ teamId: team.id, reason: "test complete" });

    expect(stopped.status).toBe("stopped");
    expect(stopped.sessions).toHaveLength(1);
    expect(stopped.sessions[0]?.status).toBe("stopped");
    expect(state.events.map((event) => event.type)).toEqual(expect.arrayContaining(["runtime.paused", "runtime.resumed", "runtime.stopped"]));
  });

  it("marks runtime and session state as error when session spawn fails", async () => {
    const state = emptyState();
    const teams = new TeamService(state);
    const team = teams.createTeam({ name: "spawn failure" }).team;
    const member = teams.addMember({ teamId: team.id, name: "Worker" });
    const backend = new FailingSpawnBackend();

    await expect(new RuntimeService(state, backend).start({ teamId: team.id })).rejects.toThrow("spawn failed");

    expect(state.teamRuntimes[team.id]?.status).toBe("error");
    expect(Object.values(state.agentSessions)).toEqual([
      expect.objectContaining({ teamId: team.id, memberId: member.id, status: "error", errorMessage: "spawn failed" })
    ]);
    expect(state.events.map((event) => event.type)).toEqual(expect.arrayContaining(["session.error", "runtime.error"]));
  });
});

class FailingSpawnBackend implements AgentBackend {
  readonly name = "opencode" as const;

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async spawnSession(_input: SpawnSessionInput): Promise<SpawnSessionResult> {
    throw new Error("spawn failed");
  }

  async promptSession(_input: PromptSessionInput): Promise<PromptSessionResult> {
    throw new Error("prompt should not be called");
  }

  async abortSession(_sessionId: string): Promise<void> {}
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "team-mcpv2-runtime-"));
  tempRoots.push(root);
  return root;
}

async function writeRawState(rootDir: string, state: object): Promise<void> {
  const dataDir = join(rootDir, ".team-mcp");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "state.json"), JSON.stringify(state), "utf8");
}

function buildFixture(teamId: string, hostName: string): TeamBuild {
  return {
    teamId,
    host: { name: hostName },
    status: "building",
    confirmedMemberIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
