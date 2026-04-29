import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  COMMANDS,
  TEAM_BUILDER_AGENT,
  agentMarkdown,
  commandMarkdown,
  opencodePackageJson,
  pluginTemplate,
  teamInstructions,
  toolTemplate
} from "./templates.js";
import type { Member } from "../domain/types.js";

// Legacy scaffold writer kept for OpenCode migration compatibility only.
// New runtime work should use runtime modules and registered MCP tools instead of generating .opencode files.
export interface InitOpenCodeOptions {
  rootDir?: string;
  serverCommand?: string[];
  force?: boolean;
}

export interface InitOpenCodeResult {
  rootDir: string;
  created: string[];
  skipped: string[];
  updated: string[];
  opencodeConfigPath: string;
}

export interface ScaffoldCheckItem {
  id: string;
  ok: boolean;
  path: string;
  message: string;
  details?: unknown;
}

export interface ScaffoldCheckResult {
  rootDir: string;
  ok: boolean;
  items: ScaffoldCheckItem[];
  summary: string;
  opencodeVersion?: string;
}

export interface CheckOpenCodeScaffoldOptions {
  includeOpenCodeRuntime?: boolean;
}

interface OpenCodeConfig {
  $schema?: string;
  mcp?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  default_agent?: string;
  instructions?: string[];
  tools?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function initOpenCode(options: InitOpenCodeOptions = {}): Promise<InitOpenCodeResult> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const result: InitOpenCodeResult = {
    rootDir,
    created: [],
    skipped: [],
    updated: [],
    opencodeConfigPath: join(rootDir, "opencode.json")
  };

  const serverCommand = options.serverCommand ?? defaultServerCommand(rootDir);
  await mkdir(join(rootDir, ".opencode", "agents"), { recursive: true });
  await mkdir(join(rootDir, ".opencode", "commands"), { recursive: true });
  await mkdir(join(rootDir, ".opencode", "plugins"), { recursive: true });
  await mkdir(join(rootDir, ".opencode", "tools"), { recursive: true });

  await writeScaffoldFile(join(rootDir, ".opencode", "agents", `${TEAM_BUILDER_AGENT.name}.md`), agentMarkdown(TEAM_BUILDER_AGENT), options.force, result);

  for (const command of COMMANDS) {
    await writeScaffoldFile(join(rootDir, ".opencode", "commands", `${command.name}.md`), commandMarkdown(command), options.force, result);
  }

  await writeScaffoldFile(join(rootDir, ".opencode", "plugins", "team-mcpv2.ts"), pluginTemplate(), options.force, result);
  await writeScaffoldFile(join(rootDir, ".opencode", "tools", "team.ts"), toolTemplate(serverCommand), options.force, result);
  await writeScaffoldFile(join(rootDir, ".opencode", "package.json"), opencodePackageJson(), options.force, result);
  await mergeOpenCodeConfig(rootDir, serverCommand, result);

  return result;
}

export async function checkOpenCodeScaffold(rootDir = process.cwd(), options: CheckOpenCodeScaffoldOptions = {}): Promise<ScaffoldCheckResult> {
  const resolvedRoot = resolve(rootDir);
  const opencodeConfigPath = join(resolvedRoot, "opencode.json");
  const teamBuilderPath = join(resolvedRoot, ".opencode", "agents", `${TEAM_BUILDER_AGENT.name}.md`);
  const teamToolsPath = join(resolvedRoot, ".opencode", "tools", "team.ts");
  const pluginPath = join(resolvedRoot, ".opencode", "plugins", "team-mcpv2.ts");
  const packagePath = join(resolvedRoot, ".opencode", "package.json");
  const teamInstructionsPath = join(resolvedRoot, ".opencode", "TEAM.md");
  const config = await readJsonIfExists(opencodeConfigPath);
  const mcpCommand = mcpServerCommand(config);
  const commandChecks = COMMANDS.map((command) => {
    const commandPath = join(resolvedRoot, ".opencode", "commands", `${command.name}.md`);
    return {
      id: `command_${command.name}`,
      path: commandPath,
      promise: fileExists(commandPath)
    };
  });
  const commandResults = await Promise.all(commandChecks.map(async (check) => ({ ...check, ok: await check.promise })));
  let opencodeVersion: string | undefined;
  const items: ScaffoldCheckItem[] = [
    {
      id: "opencode_config",
      ok: Boolean(config),
      path: opencodeConfigPath,
      message: config ? "opencode.json exists." : "Missing opencode.json. Run `team-mcpv2 init-opencode`."
    },
    {
      id: "mcp_config",
      ok: Boolean(config?.mcp && "team_mcpv2" in config.mcp),
      path: opencodeConfigPath,
      message: config?.mcp && "team_mcpv2" in config.mcp ? "team_mcpv2 MCP server is configured." : "Missing mcp.team_mcpv2 in opencode.json."
    },
    {
      id: "mcp_command",
      ok: Boolean(mcpCommand),
      path: opencodeConfigPath,
      message: mcpCommand ? "mcp.team_mcpv2.command is configured." : "Missing mcp.team_mcpv2.command array.",
      details: mcpCommand
    },
    {
      id: "mcp_entrypoint",
      ok: await mcpEntrypointLooksRunnable(resolvedRoot, mcpCommand),
      path: opencodeConfigPath,
      message: (await mcpEntrypointLooksRunnable(resolvedRoot, mcpCommand))
        ? "MCP command entrypoint looks runnable from this project."
        : "MCP command entrypoint may not be runnable from this project.",
      details: mcpCommand
    },
    {
      id: "team_builder_agent",
      ok: await fileExists(teamBuilderPath),
      path: teamBuilderPath,
      message: (await fileExists(teamBuilderPath)) ? "team-builder agent exists." : "Missing .opencode/agents/team-builder.md."
    },
    {
      id: "team_tools",
      ok: await fileExists(teamToolsPath),
      path: teamToolsPath,
      message: (await fileExists(teamToolsPath)) ? "team custom tools exist." : "Missing .opencode/tools/team.ts."
    },
    {
      id: "team_plugin",
      ok: await fileExists(pluginPath),
      path: pluginPath,
      message: (await fileExists(pluginPath)) ? "team plugin exists." : "Missing .opencode/plugins/team-mcpv2.ts."
    },
    {
      id: "opencode_package",
      ok: await fileExists(packagePath),
      path: packagePath,
      message: (await fileExists(packagePath)) ? ".opencode/package.json exists." : "Missing .opencode/package.json."
    },
    {
      id: "team_instructions",
      ok: await fileExists(teamInstructionsPath),
      path: teamInstructionsPath,
      message: (await fileExists(teamInstructionsPath)) ? ".opencode/TEAM.md exists." : "Missing .opencode/TEAM.md."
    }
  ];

  for (const command of commandResults) {
    items.push({
      id: command.id,
      ok: command.ok,
      path: command.path,
      message: command.ok ? `${basename(command.path)} exists.` : `Missing ${relative(resolvedRoot, command.path).replaceAll("\\", "/")}.`
    });
  }

  if (options.includeOpenCodeRuntime ?? true) {
    const version = await runOpenCode(["--version"], resolvedRoot);
    opencodeVersion = version.ok ? version.stdout.trim() : undefined;
    items.push({
      id: "opencode_cli",
      ok: version.ok,
      path: "opencode",
      message: version.ok ? `OpenCode CLI is available (${version.stdout.trim()}).` : "OpenCode CLI is not available on PATH.",
      details: version.ok ? undefined : version.stderr || version.stdout
    });

    const agentList = await runOpenCode(["agent", "list"], resolvedRoot);
    items.push({
      id: "opencode_agent_list",
      ok: agentList.ok && agentList.stdout.includes(TEAM_BUILDER_AGENT.name),
      path: "opencode agent list",
      message:
        agentList.ok && agentList.stdout.includes(TEAM_BUILDER_AGENT.name)
          ? "OpenCode can see the team-builder agent."
          : "OpenCode agent list does not show team-builder. Restart/refresh OpenCode after scaffold changes.",
      details: agentList.ok ? summarizeAgentList(agentList.stdout) : agentList.stderr || agentList.stdout
    });
  }

  const ok = items.every((item) => item.ok);
  return {
    rootDir: resolvedRoot,
    ok,
    items,
    summary: ok ? "OpenCode Team Mode scaffold looks ready." : "OpenCode Team Mode scaffold is incomplete.",
    opencodeVersion
  };
}

function defaultServerCommand(rootDir: string): string[] {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const entrypoint = resolve(packageRoot, "dist", "index.js");
  if (basename(entrypoint).startsWith("team-mcpv2")) {
    return ["team-mcpv2"];
  }
  return ["node", toConfigPath(rootDir, entrypoint)];
}

async function writeScaffoldFile(path: string, content: string, force: boolean | undefined, result: InitOpenCodeResult): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const exists = await fileExists(path);
  if (exists && !force) {
    result.skipped.push(path);
    return;
  }
  await writeFile(path, content, "utf8");
  result[exists ? "updated" : "created"].push(path);
}

async function mergeOpenCodeConfig(rootDir: string, serverCommand: string[], result: InitOpenCodeResult): Promise<void> {
  const path = join(rootDir, "opencode.json");
  const existing = await readJsonIfExists(path);
  const config: OpenCodeConfig = existing ?? {};
  config.$schema ??= "https://opencode.ai/config.json";
  config.mcp = {
    ...(config.mcp ?? {}),
    team_mcpv2: {
      type: "local",
      command: serverCommand,
      enabled: true,
      timeout: 10000
    }
  };
  config.tools = {
    ...(config.tools ?? {}),
    "team_mcpv2_*": true
  };
  config.agent = {
    ...(config.agent ?? {}),
    [TEAM_BUILDER_AGENT.name]: {
      mode: TEAM_BUILDER_AGENT.mode,
      description: TEAM_BUILDER_AGENT.description,
      prompt: `{file:.opencode/agents/${TEAM_BUILDER_AGENT.name}.md}`,
      tools: TEAM_BUILDER_AGENT.tools
    }
  };
  config.default_agent ??= TEAM_BUILDER_AGENT.name;
  const instructions = new Set(config.instructions ?? []);
  instructions.add(".opencode/TEAM.md");
  config.instructions = [...instructions];

  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  result[existing ? "updated" : "created"].push(path);
  await writeScaffoldFile(join(rootDir, ".opencode", "TEAM.md"), teamInstructions(), false, result);
}

export async function registerGeneratedAgent(rootDir: string, member: Member): Promise<void> {
  if (!member.agentId) {
    return;
  }
  const path = join(rootDir, "opencode.json");
  const existing = await readJsonIfExists(path);
  const config: OpenCodeConfig = existing ?? {};
  config.$schema ??= "https://opencode.ai/config.json";
  config.agent = {
    ...(config.agent ?? {}),
    [member.agentId]: {
      mode: "subagent",
      description: `${member.name} - generated team member`,
      prompt: `{file:.opencode/agents/${member.agentId}.md}`,
      model: member.model,
      tools: false,
      write: false,
      edit: false,
      bash: false
    }
  };
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function unregisterGeneratedAgent(rootDir: string, agentId?: string): Promise<void> {
  if (!agentId) {
    return;
  }
  const path = join(rootDir, "opencode.json");
  const existing = await readJsonIfExists(path);
  if (!existing?.agent || !(agentId in existing.agent)) {
    return;
  }
  delete existing.agent[agentId];
  await writeFile(path, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}

async function readJsonIfExists(path: string): Promise<OpenCodeConfig | undefined> {
  if (!(await fileExists(path))) {
    return undefined;
  }
  const raw = await readFile(path, "utf8");
  return JSON.parse(stripJsonComments(raw)) as OpenCodeConfig;
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

function stripJsonComments(raw: string): string {
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function toConfigPath(rootDir: string, path: string): string {
  if (!isAbsolute(path)) {
    return path.replaceAll("\\", "/");
  }
  const rel = relative(rootDir, path);
  if (!rel.startsWith("..") && !isAbsolute(rel)) {
    return `./${rel.replaceAll("\\", "/")}`;
  }
  return path.replaceAll("\\", "/");
}

function mcpServerCommand(config: OpenCodeConfig | undefined): string[] | undefined {
  const server = config?.mcp?.team_mcpv2 as { command?: unknown } | undefined;
  return Array.isArray(server?.command) && server.command.every((part) => typeof part === "string") ? server.command : undefined;
}

function summarizeAgentList(stdout: string): { agents: string[]; outputBytes: number } {
  const agents = stdout
    .split(/\r?\n/)
    .map((line) => line.match(/^([a-z0-9][a-z0-9-]*)\s+\(/i)?.[1])
    .filter((name): name is string => Boolean(name));
  return {
    agents,
    outputBytes: stdout.length
  };
}

async function mcpEntrypointLooksRunnable(rootDir: string, command: string[] | undefined): Promise<boolean> {
  if (!command || command.length === 0) {
    return false;
  }
  if (command[0] === "node") {
    const entrypoint = command[1];
    return Boolean(entrypoint && (await fileExists(resolve(rootDir, entrypoint))));
  }
  return true;
}

async function runOpenCode(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return runCommand("opencode", args, cwd);
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
