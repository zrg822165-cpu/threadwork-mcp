import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initOpenCode, checkOpenCodeScaffold, type ScaffoldCheckResult } from "./scaffoldService.js";
import { runLegacyOpenCodeTool } from "../cli/opencodeTools.js";
import { JsonStore } from "../store/jsonStore.js";

export interface LegacyOpenCodeDogfoodSmokeOptions {
  rootDir?: string;
  serverCommand?: string[];
  includeOpenCodeRuntime?: boolean;
}

export interface LegacyOpenCodeDogfoodSmokeResult {
  rootDir: string;
  opencodeVersion?: string;
  init: {
    created: string[];
    updated: string[];
    skipped: string[];
  };
  doctor: ScaffoldCheckResult;
  agentList: {
    ok: boolean;
    includesTeamBuilder: boolean;
    agents: string[];
    stdoutExcerpt: string;
    stderr: string;
  };
  flow: {
    teamId: string;
    membersToMention: string[];
    reportPromptCount: number;
    finalized: boolean;
    statusHasCoordinationFields: boolean;
    generatedAgents: string[];
    stateExists: boolean;
  };
  ok: boolean;
}

// Legacy scaffold smoke for migration compatibility. The current runtime dogfood path lives in runtime.opencode.smoke.test.ts.
export async function runLegacyOpenCodeDogfoodSmoke(
  options: LegacyOpenCodeDogfoodSmokeOptions = {}
): Promise<LegacyOpenCodeDogfoodSmokeResult> {
  const rootDir = resolve(options.rootDir ?? (await mkdtemp(join(tmpdir(), "team-mcpv2-dogfood-"))));
  await mkdir(rootDir, { recursive: true });

  const init = await initOpenCode({ rootDir, serverCommand: options.serverCommand });
  const includeOpenCodeRuntime = options.includeOpenCodeRuntime ?? true;
  const doctor = await checkOpenCodeScaffold(rootDir, { includeOpenCodeRuntime });
  const agentListResult = includeOpenCodeRuntime
    ? await runCommand("opencode", ["agent", "list"], rootDir)
    : { ok: true, stdout: "OpenCode runtime check skipped.\nteam-builder\n", stderr: "" };
  const store = new JsonStore({ rootDir });

  const started = (await runLegacyOpenCodeTool(store, "team_start", {
    teamName: "Dogfood Team",
    hostName: "team-builder",
    hostModel: "dogfood/host"
  })) as { team: { id: string } };

  await createDogfoodMember(store, started.team.id, {
    name: "Scope Keeper",
    model: "dogfood/scope",
    rawResponsibility: "Check requirement scope and call out vague acceptance criteria.",
    polishedPrompt: "You check requirement scope, identify vague acceptance criteria, and ask for concrete product decisions before implementation.",
    permissions: ["read-only"],
    callWhen: ["requirements are unclear"],
    doNot: ["edit files without explicit instruction"]
  });

  await createDogfoodMember(store, started.team.id, {
    name: "Patch Builder",
    model: "dogfood/builder",
    rawResponsibility: "Implement confirmed small code changes.",
    polishedPrompt: "You implement confirmed, bounded code changes and report exact files touched. Ask before broad refactors.",
    permissions: ["read", "edit"],
    callWhen: ["scope is confirmed and implementation is needed"],
    doNot: ["change product direction or create new roles"]
  });

  const finished = (await runLegacyOpenCodeTool(store, "team_finish", { teamId: started.team.id })) as {
    reportPrompts: unknown[];
    membersToMention: string[];
  };
  const status = (await runLegacyOpenCodeTool(store, "team_status", { teamId: started.team.id })) as {
    finalized: boolean;
    [key: string]: unknown;
  };
  const generatedAgents = await existingAgentFiles(rootDir, finished.membersToMention);
  const stateExists = await fileExists(join(rootDir, ".team-mcp", "state.json"));
  const statusHasCoordinationFields = ["tasks", "locks", "unreadMessages"].some((field) => Object.hasOwn(status, field));

  return {
    rootDir,
    opencodeVersion: doctor.opencodeVersion,
    init: {
      created: init.created,
      updated: init.updated,
      skipped: init.skipped
    },
    doctor,
    agentList: {
      ok: agentListResult.ok,
      includesTeamBuilder: agentListResult.stdout.includes("team-builder"),
      agents: summarizeAgentList(agentListResult.stdout),
      stdoutExcerpt: agentListResult.stdout.slice(0, 1200),
      stderr: agentListResult.stderr
    },
    flow: {
      teamId: started.team.id,
      membersToMention: finished.membersToMention,
      reportPromptCount: finished.reportPrompts.length,
      finalized: status.finalized,
      statusHasCoordinationFields,
      generatedAgents,
      stateExists
    },
    ok:
      doctor.ok &&
      agentListResult.ok &&
      agentListResult.stdout.includes("team-builder") &&
      finished.membersToMention.length === 2 &&
      finished.reportPrompts.length === 2 &&
      status.finalized === true &&
      !statusHasCoordinationFields &&
      generatedAgents.length === 2 &&
      stateExists
  };
}

export type OpenCodeDogfoodSmokeOptions = LegacyOpenCodeDogfoodSmokeOptions;
export type OpenCodeDogfoodSmokeResult = LegacyOpenCodeDogfoodSmokeResult;
export const runOpenCodeDogfoodSmoke = runLegacyOpenCodeDogfoodSmoke;

function summarizeAgentList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.match(/^([a-z0-9][a-z0-9-]*)\s+\(/i)?.[1])
    .filter((name): name is string => Boolean(name));
}

async function createDogfoodMember(store: JsonStore, teamId: string, member: Record<string, unknown>): Promise<void> {
  await runLegacyOpenCodeTool(store, "team_draft", { teamId, ...member });
  await runLegacyOpenCodeTool(store, "team_confirm", { teamId });
}

async function existingAgentFiles(rootDir: string, membersToMention: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const agentId of membersToMention) {
    const path = join(rootDir, ".opencode", "agents", `${agentId}.md`);
    if (await fileExists(path)) {
      found.push(path);
    }
  }
  return found;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function runCommand(command: string, args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    const child = spawnCommand(command, args, cwd);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolveResult({ ok: false, stdout, stderr: stderr || error.message });
    });
    child.on("close", (code) => {
      resolveResult({ ok: code === 0, stdout, stderr });
    });
  });
}

function spawnCommand(command: string, args: string[], cwd: string) {
  if (process.platform === "win32") {
    return spawn("cmd.exe", ["/d", "/s", "/c", command, ...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
  }
  return spawn(command, args, {
    cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
}
