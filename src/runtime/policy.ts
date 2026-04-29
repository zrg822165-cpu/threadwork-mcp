import type { Member, Task, TeamState } from "../domain/types.js";
import { PolicyBlockedError } from "../errors.js";
import { recordPolicyBlockedSignal, recordScopeWarningSignal } from "./safety.js";
import { addEvent } from "../services/events.js";
import { requireActiveMember, requireActiveTeam, requireTeamTask } from "../services/guards.js";
import { normalizeTeamPath, pathsConflict } from "../services/pathMatch.js";

export type RuntimePermission = "read" | "message" | "complete_task" | "lock_paths" | "edit" | "shell" | "network" | "approval_required";

export interface PolicyCheckInput {
  teamId: string;
  memberId: string;
  action: RuntimePermission;
  taskId?: string;
  detail?: string;
}

export interface LockPolicyInput {
  teamId: string;
  memberId: string;
  paths: string[];
  taskId?: string;
}

export class RuntimePolicyService {
  constructor(private readonly state: TeamState) {}

  requirePermission(input: PolicyCheckInput): void {
    requireActiveTeam(this.state, input.teamId);
    const member = requireActiveMember(this.state, input.teamId, input.memberId);
    if (this.allowedPermissions(member).has(input.action)) {
      return;
    }
    this.block(input, `Member ${member.name} is not allowed to ${input.action}`);
  }

  requireTaskOwner(input: { teamId: string; memberId: string; taskId: string; action: RuntimePermission }): Task {
    this.requirePermission(input);
    const task = requireTeamTask(this.state, input.teamId, input.taskId);
    if (task.assignedMemberId && task.assignedMemberId !== input.memberId) {
      this.block(input, `Task is assigned to a different member: ${task.assignedMemberId}`);
    }
    return task;
  }

  requireCanLockPaths(input: LockPolicyInput): void {
    this.requirePermission({ ...input, action: "lock_paths" });
    const paths = input.paths.map(normalizeTeamPath).filter(Boolean);
    if (paths.length === 0) {
      this.block({ ...input, action: "lock_paths" }, "At least one non-empty path is required");
    }
    if (!input.taskId) {
      this.warn({ ...input, action: "lock_paths", detail: "Lock requested without a taskId" });
      return;
    }

    const task = this.requireTaskOwner({ ...input, taskId: input.taskId, action: "lock_paths" });
    if (task.pathHints.length === 0) {
      return;
    }
    const withinHints = paths.some((path) => task.pathHints.some((hint) => pathsConflict(path, hint)));
    if (!withinHints) {
      recordScopeWarningSignal(this.state, {
        teamId: input.teamId,
        taskId: task.id,
        memberId: input.memberId,
        summary: `Requested paths are outside task pathHints: ${task.pathHints.join(", ")}`
      });
      this.warn({
        ...input,
        action: "lock_paths",
        detail: `Requested paths are outside task pathHints: ${task.pathHints.join(", ")}`
      });
    }
  }

  requireCanUnlock(input: { teamId: string; memberId: string; lockId?: string; paths?: string[] }): void {
    this.requirePermission({ teamId: input.teamId, memberId: input.memberId, action: "lock_paths" });
    const paths = input.paths?.map(normalizeTeamPath).filter(Boolean);
    const matchingLocks = Object.values(this.state.pathLocks).filter((lock) => {
      if (lock.teamId !== input.teamId) {
        return false;
      }
      if (input.lockId && lock.id !== input.lockId) {
        return false;
      }
      if (paths && paths.length > 0) {
        return paths.some((path) => lock.paths.some((lockedPath) => pathsConflict(path, lockedPath)));
      }
      return true;
    });
    const foreignLock = matchingLocks.find((lock) => lock.ownerMemberId !== input.memberId);
    if (foreignLock) {
      this.block({ teamId: input.teamId, memberId: input.memberId, action: "lock_paths" }, `Cannot unlock another member's path lock: ${foreignLock.id}`);
    }
  }

  policySummary(member: Member): { permissions: string[]; allowed: RuntimePermission[]; denied: RuntimePermission[] } {
    const allowed = [...this.allowedPermissions(member)].sort();
    const all: RuntimePermission[] = ["read", "message", "complete_task", "lock_paths", "edit", "shell", "network", "approval_required"];
    return {
      permissions: member.permissions ?? [],
      allowed,
      denied: all.filter((permission) => !allowed.includes(permission))
    };
  }

  private allowedPermissions(member: Member): Set<RuntimePermission> {
    const raw = new Set((member.permissions ?? []).map((permission) => permission.toLowerCase()));
    const allowed = new Set<RuntimePermission>(["read", "message", "complete_task"]);
    if (raw.has("read-only")) {
      return new Set(["read", "message", "complete_task"]);
    }
    if (raw.has("read")) {
      allowed.add("read");
    }
    if (raw.has("message")) {
      allowed.add("message");
    }
    if (raw.has("complete_task") || raw.has("complete-task")) {
      allowed.add("complete_task");
    }
    if (raw.has("edit") || raw.has("write")) {
      allowed.add("lock_paths");
      allowed.add("edit");
      allowed.add("complete_task");
    }
    if (raw.has("lock_paths") || raw.has("lock-paths")) {
      allowed.add("lock_paths");
    }
    if (raw.has("shell")) {
      allowed.add("shell");
    }
    if (raw.has("network")) {
      allowed.add("network");
    }
    if (raw.has("approval_required") || raw.has("approval-required")) {
      allowed.delete("shell");
      allowed.delete("network");
    }
    return allowed;
  }

  private block(input: PolicyCheckInput, reason: string): never {
    recordPolicyBlockedSignal(this.state, {
      teamId: input.teamId,
      taskId: input.taskId,
      memberId: input.memberId,
      summary: `${reason}${input.detail ? ` (${input.detail})` : ""}`
    });
    addEvent(this.state, {
      teamId: input.teamId,
      actorMemberId: input.memberId,
      entityType: input.taskId ? "task" : "member",
      entityId: input.taskId ?? input.memberId,
      type: "policy.blocked",
      message: `${reason}${input.detail ? ` (${input.detail})` : ""}`
    });
    throw new PolicyBlockedError(reason, { ...input, reason });
  }

  private warn(input: PolicyCheckInput): void {
    addEvent(this.state, {
      teamId: input.teamId,
      actorMemberId: input.memberId,
      entityType: input.taskId ? "task" : "member",
      entityId: input.taskId ?? input.memberId,
      type: "policy.warning",
      message: input.detail ?? `Policy warning for ${input.action}`
    });
  }
}
