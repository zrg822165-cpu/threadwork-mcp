import type { Task, TaskPriority, TeamState } from "../domain/types.js";
import { ConflictError, InvalidStateError } from "../errors.js";
import {
  closeTaskBoundary,
  recordScopeMissingSignal,
  resolveTaskSignals,
  syncTaskBoundary
} from "../runtime/safety.js";
import { newId, nowIso } from "../utils/id.js";
import { addEvent } from "./events.js";
import { requireActiveMember, requireActiveTeam, requireTeamTask } from "./guards.js";
import { PathLockService } from "./pathLockService.js";

export interface CreateTaskInput {
  teamId: string;
  title: string;
  description?: string;
  dependencyTaskIds?: string[];
  pathHints?: string[];
  createdByMemberId?: string;
  preferredMemberId?: string;
  priority?: TaskPriority;
}

export interface ClaimTaskInput {
  teamId: string;
  taskId: string;
  memberId: string;
}

export interface UpdateTaskInput {
  teamId: string;
  taskId: string;
  title?: string;
  description?: string;
  dependencyTaskIds?: string[];
  pathHints?: string[];
  preferredMemberId?: string;
  priority?: TaskPriority;
}

export interface AssignTaskInput {
  teamId: string;
  taskId: string;
  memberId: string;
}

export interface CompleteTaskInput {
  teamId: string;
  taskId: string;
  memberId?: string;
  completionSummary?: string;
  resultArtifacts?: string[];
}

export interface FailTaskInput {
  teamId: string;
  taskId: string;
  memberId?: string;
  failureSummary?: string;
}

export interface CancelTaskInput {
  teamId: string;
  taskId: string;
  memberId?: string;
  reason?: string;
}

export class TaskService {
  constructor(private readonly state: TeamState) {}

  createTask(input: CreateTaskInput): Task {
    requireActiveTeam(this.state, input.teamId);
    if (input.createdByMemberId) {
      requireActiveMember(this.state, input.teamId, input.createdByMemberId);
    }
    if (input.preferredMemberId) {
      requireActiveMember(this.state, input.teamId, input.preferredMemberId);
    }

    for (const dependencyTaskId of input.dependencyTaskIds ?? []) {
      requireTeamTask(this.state, input.teamId, dependencyTaskId);
    }

    const now = nowIso();
    const task: Task = {
      id: newId("task"),
      teamId: input.teamId,
      title: input.title,
      description: input.description,
      status: "pending",
      dependencyTaskIds: input.dependencyTaskIds ?? [],
      pathHints: input.pathHints ?? [],
      createdByMemberId: input.createdByMemberId,
      preferredMemberId: input.preferredMemberId,
      priority: input.priority,
      createdAt: now,
      updatedAt: now
    };

    this.state.tasks[task.id] = task;
    syncTaskBoundary(this.state, task);
    if (task.pathHints.length === 0) {
      recordScopeMissingSignal(this.state, task);
    }
    addEvent(this.state, {
      teamId: input.teamId,
      actorMemberId: input.createdByMemberId,
      entityType: "task",
      entityId: task.id,
      type: "task.created",
      message: `Created task ${task.title}`
    });
    return task;
  }

  claimTask(input: ClaimTaskInput): Task {
    requireActiveTeam(this.state, input.teamId);
    requireActiveMember(this.state, input.teamId, input.memberId);
    const task = requireTeamTask(this.state, input.teamId, input.taskId);

    if (task.status !== "pending") {
      throw new ConflictError("Task is not claimable", { taskId: task.id, status: task.status, assignedMemberId: task.assignedMemberId });
    }

    const incompleteDependencies = task.dependencyTaskIds
      .map((dependencyTaskId) => requireTeamTask(this.state, input.teamId, dependencyTaskId))
      .filter((dependency) => dependency.status !== "completed")
      .map((dependency) => dependency.id);
    if (incompleteDependencies.length > 0) {
      throw new InvalidStateError("Task dependencies are not completed", { taskId: task.id, incompleteDependencies });
    }

    const now = nowIso();
    task.status = "claimed";
    task.assignedMemberId = input.memberId;
    task.claimedAt = now;
    task.updatedAt = now;
    addEvent(this.state, {
      teamId: input.teamId,
      actorMemberId: input.memberId,
      entityType: "task",
      entityId: task.id,
      type: "task.claimed",
      message: `Claimed task ${task.title}`
    });
    return task;
  }

  updateTask(input: UpdateTaskInput): Task {
    requireActiveTeam(this.state, input.teamId);
    const task = requireTeamTask(this.state, input.teamId, input.taskId);
    if (task.status !== "pending") {
      throw new InvalidStateError("Only pending tasks can be updated", { taskId: task.id, status: task.status });
    }
    if (input.preferredMemberId) {
      requireActiveMember(this.state, input.teamId, input.preferredMemberId);
    }
    for (const dependencyTaskId of input.dependencyTaskIds ?? []) {
      if (dependencyTaskId === task.id) {
        throw new InvalidStateError("Task cannot depend on itself", { taskId: task.id });
      }
      requireTeamTask(this.state, input.teamId, dependencyTaskId);
    }

    if (input.title !== undefined) {
      task.title = input.title;
    }
    if (input.description !== undefined) {
      task.description = input.description;
    }
    if (input.dependencyTaskIds !== undefined) {
      task.dependencyTaskIds = input.dependencyTaskIds;
    }
    if (input.pathHints !== undefined) {
      task.pathHints = input.pathHints;
      syncTaskBoundary(this.state, task);
      if (task.pathHints.length === 0) {
        recordScopeMissingSignal(this.state, task);
      } else {
        resolveTaskSignals(this.state, task.id, ["scope_missing"]);
      }
    }
    if (input.preferredMemberId !== undefined) {
      task.preferredMemberId = input.preferredMemberId;
    }
    if (input.priority !== undefined) {
      task.priority = input.priority;
    }
    task.updatedAt = nowIso();
    resolveTaskSignals(this.state, task.id, ["policy_blocked"]);
    addEvent(this.state, {
      teamId: input.teamId,
      entityType: "task",
      entityId: task.id,
      type: "task.updated",
      message: `Updated task ${task.title}`
    });
    return task;
  }

  assignTask(input: AssignTaskInput): Task {
    requireActiveTeam(this.state, input.teamId);
    requireActiveMember(this.state, input.teamId, input.memberId);
    const task = requireTeamTask(this.state, input.teamId, input.taskId);
    if (task.status !== "pending") {
      throw new InvalidStateError("Only pending tasks can be assigned", { taskId: task.id, status: task.status });
    }

    task.preferredMemberId = input.memberId;
    task.updatedAt = nowIso();
    addEvent(this.state, {
      teamId: input.teamId,
      actorMemberId: input.memberId,
      entityType: "task",
      entityId: task.id,
      type: "task.assigned",
      message: `Assigned task preference for ${task.title}`
    });
    return task;
  }

  completeTask(input: CompleteTaskInput): Task {
    requireActiveTeam(this.state, input.teamId);
    const task = requireTeamTask(this.state, input.teamId, input.taskId);
    if (input.memberId) {
      requireActiveMember(this.state, input.teamId, input.memberId);
    }
    if (task.status === "completed") {
      return task;
    }
    if (task.status !== "claimed") {
      throw new InvalidStateError("Only claimed tasks can be completed", { taskId: task.id, status: task.status });
    }
    if (input.memberId && task.assignedMemberId && task.assignedMemberId !== input.memberId) {
      throw new ConflictError("Task is assigned to a different member", { taskId: task.id, assignedMemberId: task.assignedMemberId });
    }

    const now = nowIso();
    task.status = "completed";
    task.completedAt = now;
    task.updatedAt = now;
    task.completionSummary = input.completionSummary;
    task.resultArtifacts = input.resultArtifacts;
    closeTaskBoundary(this.state, task.id);
    resolveTaskSignals(this.state, task.id);
    new PathLockService(this.state).releaseTaskLocks({ teamId: input.teamId, taskId: task.id, ownerMemberId: input.memberId });
    addEvent(this.state, {
      teamId: input.teamId,
      actorMemberId: input.memberId,
      entityType: "task",
      entityId: task.id,
      type: "task.completed",
      message: `Completed task ${task.title}`
    });
    return task;
  }

  failTask(input: FailTaskInput): Task {
    requireActiveTeam(this.state, input.teamId);
    const task = requireTeamTask(this.state, input.teamId, input.taskId);
    if (input.memberId) {
      requireActiveMember(this.state, input.teamId, input.memberId);
    }
    if (task.status === "failed") {
      return task;
    }
    if (task.status !== "claimed") {
      throw new InvalidStateError("Only claimed tasks can be failed", { taskId: task.id, status: task.status });
    }
    if (input.memberId && task.assignedMemberId && task.assignedMemberId !== input.memberId) {
      throw new ConflictError("Task is assigned to a different member", { taskId: task.id, assignedMemberId: task.assignedMemberId });
    }

    const now = nowIso();
    task.status = "failed";
    task.failedAt = now;
    task.updatedAt = now;
    task.failureSummary = input.failureSummary;
    closeTaskBoundary(this.state, task.id);
    resolveTaskSignals(this.state, task.id);
    new PathLockService(this.state).releaseTaskLocks({ teamId: input.teamId, taskId: task.id, ownerMemberId: input.memberId });
    addEvent(this.state, {
      teamId: input.teamId,
      actorMemberId: input.memberId,
      entityType: "task",
      entityId: task.id,
      type: "task.failed",
      message: `Failed task ${task.title}`
    });
    return task;
  }

  cancelTask(input: CancelTaskInput): Task {
    requireActiveTeam(this.state, input.teamId);
    const task = requireTeamTask(this.state, input.teamId, input.taskId);
    if (input.memberId) {
      requireActiveMember(this.state, input.teamId, input.memberId);
    }
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
      if (task.status === "cancelled") {
        return task;
      }
      throw new InvalidStateError("Completed or failed tasks cannot be cancelled", { taskId: task.id, status: task.status });
    }

    const now = nowIso();
    task.status = "cancelled";
    task.cancelledAt = now;
    task.updatedAt = now;
    task.failureSummary = input.reason;
    closeTaskBoundary(this.state, task.id);
    resolveTaskSignals(this.state, task.id);
    new PathLockService(this.state).releaseTaskLocks({ teamId: input.teamId, taskId: task.id, ownerMemberId: input.memberId });
    addEvent(this.state, {
      teamId: input.teamId,
      actorMemberId: input.memberId,
      entityType: "task",
      entityId: task.id,
      type: "task.cancelled",
      message: `Cancelled task ${task.title}`
    });
    return task;
  }
}
