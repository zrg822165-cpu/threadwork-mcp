import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message, PathLock, Task, TeamState } from "../domain/types.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { MailboxService } from "../services/mailboxService.js";
import { PathLockService } from "../services/pathLockService.js";
import { TaskService } from "../services/taskService.js";
import { requiredString, stringArg, stringArrayArg, booleanArg } from "./argHelpers.js";
import { openCodeBuilds, selectTeam } from "./teamStateHelpers.js";

export interface LegacyTeamStatusOptions {
  rootDir?: string;
  scaffold?: unknown;
}

export async function teamStatus(state: TeamState, requestedTeamId?: string, options: LegacyTeamStatusOptions = {}): Promise<unknown> {
  const team = selectTeam(state, requestedTeamId);
  const members = Object.values(state.members).filter((member) => member.teamId === team.id);
  const tasks = Object.values(state.tasks).filter((task) => task.teamId === team.id);
  const locks = Object.values(state.pathLocks).filter((lock) => lock.teamId === team.id);
  const unreadMessages = Object.values(state.messages).filter((message) => message.teamId === team.id && !message.acknowledgedAt);
  const build = openCodeBuilds(state)[team.id];
  const reportPrompts = build?.status === "finalized" ? createReportPrompts(state, team.id) : [];
  const agentFiles = await Promise.all(
    members
      .filter((member) => member.agentId)
      .map(async (member) => {
        const path = options.rootDir ? join(options.rootDir, ".opencode", "agents", `${member.agentId}.md`) : undefined;
        return {
          memberId: member.id,
          agentId: member.agentId,
          path,
          exists: path ? await fileExists(path) : false
        };
      })
  );

  return {
    team,
    build,
    finalized: build?.status === "finalized",
    members,
    diagnostics: {
      rootDir: options.rootDir,
      scaffold: options.scaffold,
      agentFiles,
      restartMayBeRequired: agentFiles.length > 0,
      restartHint:
        agentFiles.length > 0
          ? "If a newly created @member is not available, restart or refresh OpenCode so .opencode/agents is reloaded."
          : "No generated members yet."
    },
    reportPrompts,
    membersToMention: reportPrompts.map((prompt) => prompt.agentId ?? prompt.memberId),
    tasks: {
      pending: tasks.filter((task) => task.status === "pending"),
      claimed: tasks.filter((task) => task.status === "claimed"),
      completed: tasks.filter((task) => task.status === "completed")
    },
    locks,
    unreadMessages,
    recommendedNextActions: nextActions(tasks, locks, unreadMessages)
  };
}

function createReportPrompts(state: TeamState, teamId: string): Array<{ memberId: string; agentId?: string; prompt: string }> {
  const build = openCodeBuilds(state)[teamId];
  if (!build) {
    return [];
  }
  return build.confirmedMemberIds
    .map((memberId) => state.members[memberId])
    .filter(Boolean)
    .map((member) => ({
      memberId: member.id,
      agentId: member.agentId,
      prompt: `@${member.agentId ?? member.name} Briefly report once: name, model (${member.model ?? "unspecified"}), role, call-when, and boundaries. Do not start task work.`
    }));
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

export function teamAsk(state: TeamState, args: Record<string, unknown>): Message {
  const team = selectTeam(state, stringArg(args.teamId));
  const toMemberId = resolveMemberId(state, team.id, stringArg(args.toMemberId), stringArg(args.toMemberName));
  return new MailboxService(state).sendMessage({
    teamId: team.id,
    fromMemberId: stringArg(args.fromMemberId),
    toMemberId,
    taskId: stringArg(args.taskId),
    subject: `Direct ask to ${state.members[toMemberId]?.name ?? toMemberId}`,
    body: requiredString(args.message, "message")
  });
}

export function teamHandoff(state: TeamState, args: Record<string, unknown>): Message {
  const team = selectTeam(state, stringArg(args.teamId));
  const toMemberId = resolveMemberId(state, team.id, stringArg(args.toMemberId), stringArg(args.toMemberName));
  const body = [requiredString(args.summary, "summary"), stringArg(args.requestedAction) ? `Requested action: ${stringArg(args.requestedAction)}` : undefined]
    .filter(Boolean)
    .join("\n\n");
  return new MailboxService(state).sendMessage({
    teamId: team.id,
    fromMemberId: stringArg(args.fromMemberId),
    toMemberId,
    taskId: stringArg(args.taskId),
    subject: `Handoff to ${state.members[toMemberId]?.name ?? toMemberId}`,
    body
  });
}

export function teamClaim(state: TeamState, args: Record<string, unknown>): { task: Task; lock?: PathLock } {
  const team = selectTeam(state, stringArg(args.teamId));
  const task = new TaskService(state).claimTask({
    teamId: team.id,
    taskId: requiredString(args.taskId, "taskId"),
    memberId: requiredString(args.memberId, "memberId")
  });
  const paths = stringArrayArg(args.paths);
  if (!paths || paths.length === 0) {
    return { task };
  }
  const { lock } = new PathLockService(state).lockPaths({
    teamId: team.id,
    ownerMemberId: requiredString(args.memberId, "memberId"),
    taskId: task.id,
    paths
  });
  return { task, lock };
}

export function teamInbox(state: TeamState, args: Record<string, unknown>): Message[] {
  const team = selectTeam(state, stringArg(args.teamId));
  return new MailboxService(state).inbox({
    teamId: team.id,
    memberId: stringArg(args.memberId),
    includeAcknowledged: booleanArg(args.includeAcknowledged)
  });
}

export function teamTimeline(state: TeamState, requestedTeamId?: string, limit = 20): unknown {
  const team = selectTeam(state, requestedTeamId);
  const events = state.events.filter((event) => event.teamId === team.id).slice(-limit);
  const messages = Object.values(state.messages)
    .filter((message) => message.teamId === team.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-limit);
  return { teamId: team.id, events, messages };
}

function resolveMemberId(state: TeamState, teamId: string, memberId?: string, memberName?: string): string {
  if (memberId) {
    const member = state.members[memberId];
    if (!member || member.teamId !== teamId) {
      throw new NotFoundError(`Member not found in team: ${memberId}`);
    }
    return memberId;
  }
  if (!memberName) {
    throw new NotFoundError("Provide toMemberId or toMemberName.");
  }
  const matches = Object.values(state.members).filter((member) => member.teamId === teamId && member.name.toLowerCase() === memberName.toLowerCase());
  if (matches.length === 1) {
    return matches[0].id;
  }
  if (matches.length === 0) {
    throw new NotFoundError(`Member not found by name: ${memberName}`);
  }
  throw new ConflictError(`Multiple members match name: ${memberName}`, { memberIds: matches.map((member) => member.id) });
}

function nextActions(tasks: Task[], locks: PathLock[], unreadMessages: Message[]): string[] {
  const actions: string[] = [];
  if (unreadMessages.length > 0) {
    actions.push("Read or route unread mailbox messages.");
  }
  if (tasks.some((task) => task.status === "pending")) {
    actions.push("Claim the next dependency-ready pending task.");
  }
  if (tasks.some((task) => task.status === "claimed")) {
    actions.push("Ask claimed task owners for progress or handoff.");
  }
  if (locks.length > 0) {
    actions.push("Review active path locks before assigning overlapping work.");
  }
  if (actions.length === 0) {
    actions.push("Create a task, continue team building, or close the team if the work is done.");
  }
  return actions;
}
