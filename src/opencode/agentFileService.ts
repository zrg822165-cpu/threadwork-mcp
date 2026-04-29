import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TeamMemberDraft } from "../domain/types.js";
import { ConflictError } from "../errors.js";
import { slugifyAgentId } from "../utils/slug.js";

export { slugifyAgentId };

export interface WriteAgentFileInput {
  rootDir: string;
  draft: TeamMemberDraft;
  force?: boolean;
}

export async function writeAgentFile(input: WriteAgentFileInput): Promise<string> {
  const agentPath = join(input.rootDir, ".opencode", "agents", `${input.draft.agentId}.md`);
  if ((await fileExists(agentPath)) && !input.force) {
    throw new ConflictError(`OpenCode agent file already exists: ${agentPath}`, { agentPath });
  }
  await mkdir(join(input.rootDir, ".opencode", "agents"), { recursive: true });
  await writeFile(agentPath, memberAgentMarkdown(input.draft), "utf8");
  return agentPath;
}

export function memberAgentMarkdown(draft: TeamMemberDraft): string {
  return `---\ndescription: ${escapeFrontmatter(draft.name)} - user-authored team member\nmode: subagent\nmodel: ${escapeFrontmatter(draft.model)}\n---\n\n# ${draft.name}\n\n${draft.polishedPrompt}\n\n## Call When\n\n${listOrNone(draft.callWhen)}\n\n## Boundaries\n\n${listOrNone(draft.doNot)}\n\n## Permissions\n\n${listOrNone(draft.permissions)}\n\n## Reporting\n\n- Report once after team finalization.\n- Stay focused on your own role.\n- Do not start work unless the user or host explicitly asks you to.\n`;
}

export async function removeAgentFile(rootDir: string, agentId?: string): Promise<string | undefined> {
  if (!agentId) {
    return undefined;
  }
  const agentPath = join(rootDir, ".opencode", "agents", `${agentId}.md`);
  try {
    await unlink(agentPath);
    return agentPath;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
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

function escapeFrontmatter(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function listOrNone(values: string[]): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : "- Not specified by the user.";
}
