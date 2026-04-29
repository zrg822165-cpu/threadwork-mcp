#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TeamMcpError } from "./errors.js";
import { registerTools } from "./tools/registerTools.js";
import { JsonStore } from "./store/jsonStore.js";

const command = process.argv[2];
if (command === "init-opencode") {
  await runInitOpenCode();
} else if (command === "dogfood-opencode") {
  await runDogfoodOpenCode();
} else if (command === "opencode-tool") {
  await runOpenCodeToolCommand();
} else {
  await runMcpServer();
}

async function runMcpServer(): Promise<void> {
  const server = new McpServer({
    name: "team-mcpv2",
    version: "0.1.0"
  });

  const store = new JsonStore();
  registerTools(server, store);

  await server.connect(new StdioServerTransport());
}

async function runInitOpenCode(): Promise<void> {
  const { assertLegacyOpenCodeInterfaceEnabled } = await import("./cli/legacyInterfaceGuards.js");
  const { checkOpenCodeScaffold, initOpenCode } = await import("./cli/initOpencode.js");
  assertLegacyOpenCodeInterfaceEnabled();
  if (process.argv.includes("--check")) {
    const result = await checkOpenCodeScaffold();
    process.stdout.write(`${JSON.stringify({ ok: result.ok, result }, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  const force = process.argv.includes("--force");
  const result = await initOpenCode({ force });
  process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
}

async function runDogfoodOpenCode(): Promise<void> {
  const { assertLegacyOpenCodeInterfaceEnabled } = await import("./cli/legacyInterfaceGuards.js");
  const { runLegacyOpenCodeDogfoodSmoke } = await import("./opencode/dogfoodService.js");
  assertLegacyOpenCodeInterfaceEnabled();
  const rootIndex = process.argv.indexOf("--root");
  const rootDir = rootIndex >= 0 ? process.argv[rootIndex + 1] : undefined;
  const result = await runLegacyOpenCodeDogfoodSmoke({ rootDir });
  process.stdout.write(`${JSON.stringify({ ok: result.ok, result }, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

async function runOpenCodeToolCommand(): Promise<void> {
  const { assertLegacyOpenCodeInterfaceEnabled } = await import("./cli/legacyInterfaceGuards.js");
  const { runLegacyOpenCodeTool } = await import("./cli/opencodeTools.js");
  assertLegacyOpenCodeInterfaceEnabled();
  const toolName = process.argv[3];
  if (!toolName) {
    throw new Error("Missing opencode tool name");
  }
  const args = process.argv[4] ? (JSON.parse(process.argv[4]) as Record<string, unknown>) : {};
  const rootIndex = process.argv.indexOf("--root");
  const rootDir = rootIndex >= 0 ? process.argv[rootIndex + 1] : undefined;
  try {
    const result = await runLegacyOpenCodeTool(new JsonStore({ rootDir }), toolName, args);
    process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
  } catch (error) {
    const payload =
      error instanceof TeamMcpError
        ? { ok: false, error: { code: error.code, message: error.message, details: error.details } }
        : { ok: false, error: { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) } };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 1;
  }
}
