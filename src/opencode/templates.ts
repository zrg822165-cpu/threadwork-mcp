export const TEAM_BUILDER_AGENT = {
  name: "team-builder",
  mode: "primary",
  description: "Host for user-authored OpenCode team creation.",
  tools: { "team_mcpv2_*": true, read: true, grep: true, glob: true, write: false, edit: false, bash: false },
  prompt: `Use team_mcpv2 to build one user-authored OpenCode team.

Use the tools this way:
- team_start starts or resumes the build.
- team_models lists available provider/model ids when the user has not chosen one.
- team_draft saves exactly one member draft from the user's details.
- team_confirm creates the current drafted member.
- team_remove_member removes one confirmed member.
- team_finish finalizes the build and returns report prompts.
- team_status shows the current build state.

Required member details:
- name
- model
- responsibility
- boundaries

Flow:
- Ask only for missing required details.
- If a required detail is missing, ask for it.
- If the user asks you to fill in missing boundaries from their stated constraints, draft a reasonable boundaries proposal and ask for confirmation.
- After team_draft, show one checklist and ask for confirmation.
- Do not call team_confirm until the user confirms the checklist.
- After team_confirm, ask whether to create another member.
- Use team_remove_member when the user wants to delete a confirmed member.
- Do not call team_finish until the user declines another member.
- After team_finish, send the returned @member prompts in order.
- If @member cannot be resolved, stop, show the unresolved member id, ask the user to restart or refresh OpenCode, then retry the same returned prompts.`
} as const;

export const COMMANDS = [
  {
    name: "team-start",
    description: "Start a user-authored OpenCode team build",
    agent: "team-builder",
    body: "Use team_start, then ask for the first member."
  },
  {
    name: "team-draft-member",
    description: "Draft exactly one team member from user-provided details",
    agent: "team-builder",
    body: "Use team_draft for one member after lightly polishing my wording. If I ask you to complete missing boundaries from constraints I already gave, propose them in the checklist and ask me to confirm, revise, or discard. Do not create the agent yet."
  },
  {
    name: "team-confirm-member",
    description: "Confirm and create the current drafted member",
    agent: "team-builder",
    body: "Use team_confirm for the current draft. After it succeeds, briefly confirm creation and ask whether I want another member. Do not start reporting yet."
  },
  {
    name: "team-remove-member",
    description: "Remove one confirmed member from the team",
    agent: "team-builder",
    body: "Use team_remove_member for a confirmed member when I ask to delete them. Then briefly confirm the removal and ask whether I want to add someone else or finish again."
  },
  {
    name: "team-finalize",
    description: "Finalize the team and make all members report once",
    agent: "team-builder",
    body: "Use team_finish. Then send each returned @member prompt in order. If a member cannot be resolved, stop, show me the exact unresolved id, ask me to restart or refresh OpenCode, then retry the same returned prompts. Do not start task work."
  },
  {
    name: "team-build-status",
    description: "Show current team building status",
    agent: "team-builder",
    body: "Use team_status. Summarize the current build briefly and tell me the next decision I need to make."
  },
  {
    name: "team-models",
    description: "List OpenCode models available for team members",
    agent: "team-builder",
    body: "Use team_models and show the available provider/model options. Do not choose for me unless I ask."
  }
] as const;

export function agentMarkdown(agent: typeof TEAM_BUILDER_AGENT): string {
  return `---\ndescription: ${agent.description}\nmode: ${agent.mode}\n---\n\n${agent.prompt}\n`;
}

export function commandMarkdown(command: (typeof COMMANDS)[number]): string {
  return `---\ndescription: ${command.description}\nagent: ${command.agent}\n---\n\n${command.body}\n`;
}

export function opencodePackageJson(): string {
  return `${JSON.stringify({ private: true, dependencies: { "@opencode-ai/plugin": "latest" } }, null, 2)}\n`;
}

export function teamInstructions(): string {
  return `# OpenCode Team Mode

This project uses team-mcpv2 as the shared coordination layer for user-authored OpenCode teams.

Use the builder flow:
- start or resume with team_start
- use team_models when the user has not picked a model
- draft one member with team_draft
- create that member with team_confirm only after confirmation
- remove a confirmed member with team_remove_member when the user asks
- finalize with team_finish only after the user declines another member
- use team_status to inspect the current build
`;
}

export function pluginTemplate(): string {
  return `import type { Plugin } from "@opencode-ai/plugin"
import { mkdir, appendFile } from "node:fs/promises"
import { join } from "node:path"

export const TeamMcpV2Plugin: Plugin = async ({ client, directory, worktree }) => {
  const root = worktree || directory
  const eventLog = join(root, ".team-mcp", "opencode-events.ndjson")

  async function record(event: unknown) {
    await mkdir(join(root, ".team-mcp"), { recursive: true })
    await appendFile(eventLog, JSON.stringify({ at: new Date().toISOString(), event }) + "\\n", "utf8")
  }

  return {
    event: async ({ event }) => {
      if (
        event.type === "session.created" ||
        event.type === "session.updated" ||
        event.type === "session.idle" ||
        event.type === "message.updated" ||
        event.type === "tool.execute.after" ||
        event.type === "todo.updated"
      ) {
        await record(event)
      }

      if (event.type === "session.idle") {
        await client.tui.toast({
          body: {
            message: "Team Builder: use /team-build-status to continue or finalize the user-authored team.",
          },
        }).catch(() => {})
      }
    },
  }
}
`;
}

export function toolTemplate(serverCommand: string[]): string {
  const commandJson = JSON.stringify(serverCommand);
  return `import { tool } from "@opencode-ai/plugin"
import { dirname, resolve } from "node:path"

const serverCommand = ${commandJson}

function projectRootFromToolFile() {
  const toolFile = typeof import.meta.path === "string" ? import.meta.path : undefined
  return toolFile ? resolve(dirname(toolFile), "..", "..") : undefined
}

async function runTeamTool(name: string, args: Record<string, unknown>, context: { worktree?: string; directory: string }) {
  const [command, ...baseArgs] = serverCommand
  const rootDir = projectRootFromToolFile() || context.worktree || context.directory
  const proc = Bun.spawn({
    cmd: [command, ...baseArgs, "opencode-tool", name, JSON.stringify(args), "--root", rootDir],
    cwd: rootDir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(stderr || stdout || \`team-mcpv2 tool failed: \${name}\`)
  }
  return stdout.trim()
}

export const start = tool({
  description: "Start a user-authored OpenCode team build without creating members.",
  args: {
    teamName: tool.schema.string().optional(),
    description: tool.schema.string().optional(),
    hostName: tool.schema.string().optional(),
    hostModel: tool.schema.string().optional(),
    hostResponsibility: tool.schema.string().optional(),
    hostNotes: tool.schema.string().optional(),
  },
  execute: (args, context) => runTeamTool("team_start", args, context),
})

export const listModels = tool({
  description: "List OpenCode models available for user selection.",
  args: { provider: tool.schema.string().optional() },
  execute: (args, context) => runTeamTool("team_models", args, context),
})

export const draftMember = tool({
  description: "Draft one user-authored member. This does not create an agent file.",
  args: {
    teamId: tool.schema.string().optional(),
    name: tool.schema.string(),
    agentId: tool.schema.string().optional(),
    model: tool.schema.string(),
    rawResponsibility: tool.schema.string(),
    polishedPrompt: tool.schema.string(),
    permissions: tool.schema.array(tool.schema.string()).optional(),
    callWhen: tool.schema.array(tool.schema.string()).optional(),
    doNot: tool.schema.array(tool.schema.string()).optional(),
  },
  execute: (args, context) => runTeamTool("team_draft", args, context),
})

export const confirmMember = tool({
  description: "Confirm the current draft and create its OpenCode agent file.",
  args: { teamId: tool.schema.string().optional(), force: tool.schema.boolean().optional() },
  execute: (args, context) => runTeamTool("team_confirm", args, context),
})

export const removeMember = tool({
  description: "Remove one confirmed member and clean up its generated agent registration.",
  args: {
    teamId: tool.schema.string().optional(),
    memberId: tool.schema.string().optional(),
    agentId: tool.schema.string().optional(),
    name: tool.schema.string().optional(),
  },
  execute: (args, context) => runTeamTool("team_remove_member", args, context),
})

export const finalize = tool({
  description: "Finalize team building and return member report prompts.",
  args: { teamId: tool.schema.string().optional() },
  execute: (args, context) => runTeamTool("team_finish", args, context),
})

export const status = tool({
  description: "Show team builder status, confirmed members, current draft, diagnostics, and next step.",
  args: { teamId: tool.schema.string().optional() },
  execute: (args, context) => runTeamTool("team_status", args, context),
})
`;
}
