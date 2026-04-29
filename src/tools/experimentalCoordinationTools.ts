import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MailboxService } from "../services/mailboxService.js";
import { PathLockService } from "../services/pathLockService.js";
import { TaskService } from "../services/taskService.js";
import { TeamService } from "../services/teamService.js";
import type { JsonStore } from "../store/jsonStore.js";
import { runTool } from "./response.js";
import { memberRoleSchema } from "./schemas.js";

export function registerExperimentalCoordinationTools(server: McpServer, store: JsonStore): void {
  server.registerTool(
    "create_team",
    {
      title: "Create Team",
      description: "Experimental: create a coordination team. This does not start or run any agent.",
      inputSchema: {
        name: z.string().min(1),
        description: z.string().optional(),
        leadName: z.string().optional()
      }
    },
    async (input) => runTool(() => store.transaction((state) => new TeamService(state).createTeam(input)))
  );

  server.registerTool(
    "get_team",
    {
      title: "Get Team",
      description: "Experimental: read a team and its current members.",
      inputSchema: { teamId: z.string().min(1) }
    },
    async (input) =>
      runTool(async () => {
        const state = await store.read();
        return new TeamService(state).getTeam(input.teamId);
      })
  );

  server.registerTool(
    "close_team",
    {
      title: "Close Team",
      description: "Experimental: close a team without deleting its history.",
      inputSchema: {
        teamId: z.string().min(1),
        actorMemberId: z.string().optional()
      }
    },
    async (input) => runTool(() => store.transaction((state) => new TeamService(state).closeTeam(input.teamId, input.actorMemberId)))
  );

  server.registerTool(
    "add_member",
    {
      title: "Add Member",
      description: "Experimental: register a teammate in an active team.",
      inputSchema: {
        teamId: z.string().min(1),
        name: z.string().min(1),
        role: memberRoleSchema.optional(),
        capabilities: z.array(z.string()).optional()
      }
    },
    async (input) => runTool(() => store.transaction((state) => new TeamService(state).addMember(input)))
  );

  server.registerTool(
    "create_task",
    {
      title: "Create Task",
      description: "Experimental: create a pending task on the shared task board.",
      inputSchema: {
        teamId: z.string().min(1),
        title: z.string().min(1),
        description: z.string().optional(),
        dependencyTaskIds: z.array(z.string()).optional(),
        pathHints: z.array(z.string()).optional(),
        createdByMemberId: z.string().optional()
      }
    },
    async (input) => runTool(() => store.transaction((state) => new TaskService(state).createTask(input)))
  );

  server.registerTool(
    "claim_task",
    {
      title: "Claim Task",
      description: "Experimental: claim a pending task after all dependencies are completed.",
      inputSchema: {
        teamId: z.string().min(1),
        taskId: z.string().min(1),
        memberId: z.string().min(1)
      }
    },
    async (input) => runTool(() => store.transaction((state) => new TaskService(state).claimTask(input)))
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete Task",
      description: "Experimental: mark a claimed task completed.",
      inputSchema: {
        teamId: z.string().min(1),
        taskId: z.string().min(1),
        memberId: z.string().optional(),
        completionSummary: z.string().optional()
      }
    },
    async (input) => runTool(() => store.transaction((state) => new TaskService(state).completeTask(input)))
  );

  server.registerTool(
    "send_message",
    {
      title: "Send Message",
      description: "Experimental: send a mailbox message.",
      inputSchema: {
        teamId: z.string().min(1),
        fromMemberId: z.string().optional(),
        toMemberId: z.string().optional(),
        taskId: z.string().optional(),
        subject: z.string().optional(),
        body: z.string().min(1)
      }
    },
    async (input) => runTool(() => store.transaction((state) => new MailboxService(state).sendMessage(input)))
  );

  server.registerTool(
    "inbox",
    {
      title: "Inbox",
      description: "Experimental: list mailbox messages.",
      inputSchema: {
        teamId: z.string().min(1),
        memberId: z.string().optional(),
        taskId: z.string().optional(),
        includeAcknowledged: z.boolean().optional()
      }
    },
    async (input) =>
      runTool(async () => {
        const state = await store.read();
        return new MailboxService(state).inbox(input);
      })
  );

  server.registerTool(
    "ack_message",
    {
      title: "Ack Message",
      description: "Experimental: acknowledge a mailbox message.",
      inputSchema: {
        teamId: z.string().min(1),
        messageId: z.string().min(1),
        memberId: z.string().optional()
      }
    },
    async (input) => runTool(() => store.transaction((state) => new MailboxService(state).ackMessage(input)))
  );

  server.registerTool(
    "lock_paths",
    {
      title: "Lock Paths",
      description: "Experimental: create an exclusive path lock.",
      inputSchema: {
        teamId: z.string().min(1),
        ownerMemberId: z.string().min(1),
        paths: z.array(z.string().min(1)).min(1),
        taskId: z.string().optional(),
        expiresAt: z.string().optional()
      }
    },
    async (input) => runTool(() => store.transaction((state) => new PathLockService(state).lockPaths(input)))
  );

  server.registerTool(
    "unlock_paths",
    {
      title: "Unlock Paths",
      description: "Experimental: remove path locks.",
      inputSchema: {
        teamId: z.string().min(1),
        ownerMemberId: z.string().optional(),
        lockId: z.string().optional(),
        paths: z.array(z.string().min(1)).optional()
      }
    },
    async (input) => runTool(() => store.transaction((state) => new PathLockService(state).unlockPaths(input)))
  );

  server.registerTool(
    "list_path_locks",
    {
      title: "List Path Locks",
      description: "Experimental: list active path locks.",
      inputSchema: { teamId: z.string().min(1) }
    },
    async (input) =>
      runTool(async () => {
        const state = await store.read();
        return new PathLockService(state).listPathLocks(input.teamId);
      })
  );

  server.registerTool(
    "check_path_conflicts",
    {
      title: "Check Path Conflicts",
      description: "Experimental: check whether paths conflict with active locks.",
      inputSchema: {
        teamId: z.string().min(1),
        paths: z.array(z.string().min(1)).min(1),
        ownerMemberId: z.string().optional()
      }
    },
    async (input) =>
      runTool(async () => {
        const state = await store.read();
        return new PathLockService(state).checkPathConflicts(input);
      })
  );
}
