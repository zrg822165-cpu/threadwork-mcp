import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function listOpenCodeModels(rootDir: string, provider?: string): Promise<unknown> {
  const args = provider ? ["models", provider] : ["models"];
  try {
    const { stdout } = await execFileAsync("opencode", args, { cwd: rootDir, timeout: 15000 });
    return { models: parseOpenCodeModels(stdout), raw: stdout.trim() };
  } catch (error) {
    return {
      models: [],
      error: {
        code: "OPENCODE_MODELS_UNAVAILABLE",
        message: error instanceof Error ? error.message : String(error),
        hint: "Run `opencode models` in this project or provide a model manually as provider/model."
      }
    };
  }
}

export function parseOpenCodeModels(output: string): string[] {
  const seen = new Set<string>();
  for (const token of output.split(/\s+/)) {
    const cleaned = token.replace(/[,"'`()[\]{}]/g, "").trim();
    if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:/@+-]+$/.test(cleaned)) {
      seen.add(cleaned);
    }
  }
  return [...seen].sort();
}
