import type { PathLock, TeamState } from "../domain/types.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { newId, nowIso } from "../utils/id.js";
import { addEvent } from "./events.js";
import { requireActiveMember, requireActiveTeam, requireTeamTask } from "./guards.js";
import { normalizeTeamPath, pathsConflict } from "./pathMatch.js";

export interface LockPathsInput {
  teamId: string;
  ownerMemberId: string;
  paths: string[];
  taskId?: string;
  expiresAt?: string;
}

export interface UnlockPathsInput {
  teamId: string;
  ownerMemberId?: string;
  lockId?: string;
  paths?: string[];
}

export interface ReleaseTaskLocksInput {
  teamId: string;
  taskId: string;
  ownerMemberId?: string;
}

export interface ReleaseExpiredLocksInput {
  teamId: string;
  now?: string;
}

export interface CheckPathConflictsInput {
  teamId: string;
  paths: string[];
  ownerMemberId?: string;
}

export interface PathConflict {
  requestedPath: string;
  lock: PathLock;
  conflictingPath: string;
}

export class PathLockService {
  constructor(private readonly state: TeamState) {}

  lockPaths(input: LockPathsInput): { lock: PathLock; conflicts: PathConflict[] } {
    requireActiveTeam(this.state, input.teamId);
    requireActiveMember(this.state, input.teamId, input.ownerMemberId);
    if (input.taskId) {
      requireTeamTask(this.state, input.teamId, input.taskId);
    }

    const paths = input.paths.map(normalizeTeamPath).filter(Boolean);
    this.releaseExpiredLocks({ teamId: input.teamId });
    const conflicts = this.findConflicts(input.teamId, paths, input.ownerMemberId);
    if (conflicts.length > 0) {
      throw new ConflictError("Requested paths conflict with existing locks", { conflicts });
    }

    const lock: PathLock = {
      id: newId("lock"),
      teamId: input.teamId,
      ownerMemberId: input.ownerMemberId,
      taskId: input.taskId,
      paths,
      mode: "exclusive",
      createdAt: nowIso(),
      expiresAt: input.expiresAt
    };
    this.state.pathLocks[lock.id] = lock;
    addEvent(this.state, {
      teamId: input.teamId,
      actorMemberId: input.ownerMemberId,
      entityType: "pathLock",
      entityId: lock.id,
      type: "path_lock.created",
      message: `Locked ${paths.join(", ")}`
    });
    return { lock, conflicts: [] };
  }

  unlockPaths(input: UnlockPathsInput): { unlocked: PathLock[] } {
    requireActiveTeam(this.state, input.teamId);
    if (input.ownerMemberId) {
      requireActiveMember(this.state, input.teamId, input.ownerMemberId);
    }

    const normalizedPaths = input.paths?.map(normalizeTeamPath).filter(Boolean);
    const locks = Object.values(this.state.pathLocks).filter((lock) => {
      if (lock.teamId !== input.teamId) {
        return false;
      }
      if (input.lockId && lock.id !== input.lockId) {
        return false;
      }
      if (input.ownerMemberId && lock.ownerMemberId !== input.ownerMemberId) {
        return false;
      }
      if (normalizedPaths && normalizedPaths.length > 0) {
        return normalizedPaths.some((path) => lock.paths.some((lockedPath) => pathsConflict(path, lockedPath)));
      }
      return true;
    });

    if (input.lockId && locks.length === 0) {
      throw new NotFoundError(`Path lock not found: ${input.lockId}`);
    }

    for (const lock of locks) {
      delete this.state.pathLocks[lock.id];
      addEvent(this.state, {
        teamId: input.teamId,
        actorMemberId: input.ownerMemberId,
        entityType: "pathLock",
        entityId: lock.id,
        type: "path_lock.removed",
        message: `Unlocked ${lock.paths.join(", ")}`
      });
    }
    return { unlocked: locks };
  }

  releaseTaskLocks(input: ReleaseTaskLocksInput): { unlocked: PathLock[] } {
    requireActiveTeam(this.state, input.teamId);
    requireTeamTask(this.state, input.teamId, input.taskId);
    if (input.ownerMemberId) {
      requireActiveMember(this.state, input.teamId, input.ownerMemberId);
    }

    const locks = Object.values(this.state.pathLocks).filter((lock) => lock.teamId === input.teamId && lock.taskId === input.taskId);
    for (const lock of locks) {
      delete this.state.pathLocks[lock.id];
      addEvent(this.state, {
        teamId: input.teamId,
        actorMemberId: input.ownerMemberId,
        entityType: "pathLock",
        entityId: lock.id,
        type: "path_lock.removed",
        message: `Released task lock ${lock.paths.join(", ")}`
      });
    }
    return { unlocked: locks };
  }

  releaseExpiredLocks(input: ReleaseExpiredLocksInput): { unlocked: PathLock[] } {
    requireActiveTeam(this.state, input.teamId);
    const now = input.now ?? nowIso();
    const locks = Object.values(this.state.pathLocks).filter((lock) => lock.teamId === input.teamId && lock.expiresAt && lock.expiresAt <= now);

    for (const lock of locks) {
      delete this.state.pathLocks[lock.id];
      addEvent(this.state, {
        teamId: input.teamId,
        actorMemberId: lock.ownerMemberId,
        entityType: "pathLock",
        entityId: lock.id,
        type: "path_lock.expired",
        message: `Expired path lock ${lock.paths.join(", ")}`
      });
    }
    return { unlocked: locks };
  }

  listPathLocks(teamId: string): PathLock[] {
    requireActiveTeam(this.state, teamId);
    this.releaseExpiredLocks({ teamId });
    return Object.values(this.state.pathLocks)
      .filter((lock) => lock.teamId === teamId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  checkPathConflicts(input: CheckPathConflictsInput): { conflicts: PathConflict[] } {
    requireActiveTeam(this.state, input.teamId);
    if (input.ownerMemberId) {
      requireActiveMember(this.state, input.teamId, input.ownerMemberId);
    }
    const paths = input.paths.map(normalizeTeamPath).filter(Boolean);
    this.releaseExpiredLocks({ teamId: input.teamId });
    return { conflicts: this.findConflicts(input.teamId, paths, input.ownerMemberId) };
  }

  private findConflicts(teamId: string, paths: string[], ownerMemberId?: string): PathConflict[] {
    const conflicts: PathConflict[] = [];
    for (const lock of Object.values(this.state.pathLocks)) {
      if (lock.teamId !== teamId || lock.ownerMemberId === ownerMemberId) {
        continue;
      }
      for (const requestedPath of paths) {
        for (const conflictingPath of lock.paths) {
          if (pathsConflict(requestedPath, conflictingPath)) {
            conflicts.push({ requestedPath, lock, conflictingPath });
          }
        }
      }
    }
    return conflicts;
  }
}
