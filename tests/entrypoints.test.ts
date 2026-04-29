import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { assertLegacyOpenCodeInterfaceEnabled, LEGACY_OPENCODE_FLAG } from "../src/cli/legacyInterfaceGuards.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("legacy entrypoint guards", () => {
  it("does not gate the default runtime MCP startup", async () => {
    const indexSource = await readFile("src/index.ts", "utf8");
    const startupImports = indexSource.slice(0, indexSource.indexOf("const command"));
    const runMcpServer = indexSource.slice(
      indexSource.indexOf("async function runMcpServer"),
      indexSource.indexOf("async function runInitOpenCode")
    );

    expect(startupImports).not.toContain("./cli/initOpencode");
    expect(startupImports).not.toContain("./cli/opencodeTools");
    expect(startupImports).not.toContain("./opencode/dogfoodService");
    expect(startupImports).not.toContain("./cli/legacyInterfaceGuards");
    expect(runMcpServer).toContain("registerTools(server, store)");
    expect(runMcpServer).not.toContain("assertLegacy");
  });

  it("keeps scaffold-era modules out of the default runtime registration path", async () => {
    const indexSource = await readFile("src/index.ts", "utf8");
    const indexDefaultPath = [
      indexSource.slice(0, indexSource.indexOf("const command")),
      indexSource.slice(indexSource.indexOf("async function runMcpServer"), indexSource.indexOf("async function runInitOpenCode"))
    ].join("\n");
    const sources = {
      indexDefaultPath,
      registerTools: await readFile("src/tools/registerTools.ts", "utf8"),
      publicBuilder: await readFile("src/tools/publicTeamBuilderTools.ts", "utf8"),
      runtimeTools: await readFile("src/tools/runtimeTools.ts", "utf8"),
      runtimeBuilder: await readFile("src/builder/teamBuilderService.ts", "utf8")
    };
    const forbiddenLegacyImports = [
      "opencodeTools",
      "scaffoldService",
      "legacyCollaborationService",
      "opencode/teamBuilderService",
      "opencode/agentFileService",
      "opencode/argHelpers"
    ];

    for (const [name, source] of Object.entries(sources)) {
      for (const forbidden of forbiddenLegacyImports) {
        expect(source, `${name} should not import ${forbidden}`).not.toContain(forbidden);
      }
    }

    expect(indexSource).toContain('await import("./cli/opencodeTools.js")');
    expect(indexSource).toContain('await import("./opencode/dogfoodService.js")');
  });

  it("disables legacy OpenCode commands by default", async () => {
    expect(() => assertLegacyOpenCodeInterfaceEnabled({ [LEGACY_OPENCODE_FLAG]: "" })).toThrow(
      /legacy OpenCode integration is disabled during the runtime redesign/
    );
  });

  it("allows legacy OpenCode commands only with explicit opt-in", () => {
    expect(() => assertLegacyOpenCodeInterfaceEnabled({ [LEGACY_OPENCODE_FLAG]: "1" })).not.toThrow();
  });

  it("exposes the runtime-first MCP tool surface from built stdio entrypoint", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "team-mcpv2-entrypoint-tools-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEAM_MCP_HOME: join(homeDir, ".team-mcp")
      },
      stderr: "pipe"
    });
    const client = new Client({ name: "entrypoint-smoke", version: "0.0.0" }, { capabilities: {} });

    try {
      await client.connect(transport);
      const serverVersion = client.getServerVersion();
      const tools = await client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name).sort();

      expect(serverVersion).toMatchObject({ name: "team-mcpv2", version: "0.1.0" });
      expect(toolNames).toEqual(expect.arrayContaining(["team_models", "team_results", "team_status", "team_work"]));
      expect(toolNames).not.toEqual(expect.arrayContaining(["team_start", "team_draft", "team_confirm", "team_finish", "team_run", "team_task_create"]));
    } finally {
      await transport.close();
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 120000);

  it("exposes advanced builder and runtime tools only with explicit opt-in", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "team-mcpv2-entrypoint-advanced-tools-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEAM_MCP_HOME: join(homeDir, ".team-mcp"),
        TEAM_MCP_ENABLE_ADVANCED_TOOLS: "1"
      },
      stderr: "pipe"
    });
    const client = new Client({ name: "entrypoint-advanced", version: "0.0.0" }, { capabilities: {} });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name).sort();

      expect(toolNames).toEqual(expect.arrayContaining([
        "team_start",
        "team_draft",
        "team_confirm",
        "team_finish",
        "team_run",
        "team_task_create"
      ]));
    } finally {
      await transport.close();
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 120000);

  it("runs a minimal first-run workflow through the built stdio entrypoint", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "team-mcpv2-entrypoint-workflow-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEAM_MCP_HOME: join(homeDir, ".team-mcp")
      },
      stderr: "pipe"
    });
    const client = new Client({ name: "entrypoint-workflow", version: "0.0.0" }, { capabilities: {} });

    try {
      await client.connect(transport);
      const started = await client.callTool({
        name: "team_work",
        arguments: {
          team: { teamName: "entrypoint first run" },
          request: "Create a focused first-run teammate."
        }
      });
      const startedResult = parseToolResult<{
        result: {
          mode: string;
          team: { id: string };
          question: string;
          choices: Array<{ label: string }>;
          nextPrompt: string;
          recommendedInput: { teamId: string; builder: { draftMember: { name: string } } };
        };
      }>(started);
      const teamId = startedResult.result.team.id;

      const drafted = await client.callTool({
        name: "team_work",
        arguments: {
          teamId,
          builder: {
            draftMember: {
              name: "First Runner",
              model: "test/model",
              rawResponsibility: "Handle first-run work.",
              polishedPrompt: "Handle first-run work clearly and complete assigned runtime tasks."
            }
          }
        }
      });
      const confirmed = await client.callTool({ name: "team_work", arguments: { teamId, builder: { confirmMember: true } } });
      await client.callTool({ name: "team_work", arguments: { teamId, builder: { finishTeam: true } } });

      const worked = await client.callTool({
        name: "team_work",
        arguments: {
          teamId,
          work: {
            goal: "Verify first-run entrypoint workflow",
            autoRun: false
          }
        }
      });
      const status = await client.callTool({
        name: "team_status",
        arguments: { teamId }
      });

      const draftedResult = parseToolResult<{
        result: {
          mode: string;
          currentDraft: { name: string };
          choices: Array<{ label: string }>;
          recommendedInput: { teamId: string; builder: { confirmMember: boolean } };
        };
      }>(drafted);
      const confirmedResult = parseToolResult<{
        result: {
          mode: string;
          members: Array<{ name: string }>;
          choices: Array<{ label: string }>;
          recommendedInput: { teamId: string; builder: { finishTeam: boolean } };
        };
      }>(confirmed);

      const workResult = parseToolResult<{
        result: {
          mode: string;
          task: { id: string; title: string; status: string };
          runtime: { teamId: string; status: string };
          nextPrompt: string;
          recommendedInput: { teamId: string; work: { taskId: string } };
        };
      }>(worked);
      const statusResult = parseToolResult<{
        result: {
          team: { id: string };
          runtime: { status: string };
        };
      }>(status);

      expect(startedResult.result.mode).toBe("builder_guidance");
      expect(startedResult.result.question).toContain("Draft the first teammate");
      expect(startedResult.result.question).toContain("name, model, and role you want");
      expect(startedResult.result.choices[0]?.label).toBe("Draft first member");
      expect(startedResult.result.recommendedInput).toMatchObject({ teamId, builder: { draftMember: { name: "Your Teammate Name" } } });
      expect(startedResult.result.nextPrompt).not.toContain("Choices:");
      expect(draftedResult.result.currentDraft.name).toBe("First Runner");
      expect(draftedResult.result.recommendedInput).toMatchObject({ teamId, builder: { confirmMember: true } });
      expect(confirmedResult.result.members).toEqual([expect.objectContaining({ name: "First Runner" })]);
      expect(confirmedResult.result.choices.map((choice) => choice.label)).toEqual(["Add member", "Finish team"]);
      expect(confirmedResult.result.recommendedInput).toMatchObject({ teamId, builder: { finishTeam: true } });

      expect(workResult.result.task).toMatchObject({
        title: "Verify first-run entrypoint workflow",
        status: "pending"
      });
      expect(workResult.result.mode).toBe("task_flow");
      expect(workResult.result.runtime).toMatchObject({ teamId, status: "ready" });
      expect(workResult.result.nextPrompt).toContain("Continue team_work for");
      expect(workResult.result.recommendedInput).toMatchObject({ teamId, work: { taskId: workResult.result.task.id } });
      expect(statusResult.result.team.id).toBe(teamId);
      expect(statusResult.result.runtime.status).toBe("ready");
    } finally {
      await transport.close();
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 120000);
});

function parseToolResult<T>(result: { content?: Array<{ text?: string }> }): T {
  const text = result.content?.find((item) => typeof item.text === "string")?.text;
  if (!text) {
    throw new Error("Tool result did not include text content");
  }
  return JSON.parse(text) as T;
}
