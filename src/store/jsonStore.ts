import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { emptyState, SCHEMA_VERSION, type TeamBuild, type TeamState } from "../domain/types.js";
import { LockBusyError } from "../errors.js";

const DEFAULT_DIR = ".team-mcp";
const STATE_FILE = "state.json";
const LOCK_DIR = "state.lock";

export interface JsonStoreOptions {
  rootDir?: string;
  lockTimeoutMs?: number;
  lockPollMs?: number;
}

export class JsonStore {
  private readonly rootDir: string;
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly lockPollMs: number;

  constructor(options: JsonStoreOptions = {}) {
    this.rootDir = options.rootDir ?? process.cwd();
    const dataDir = process.env.TEAM_MCP_HOME ?? join(this.rootDir, DEFAULT_DIR);
    this.statePath = join(dataDir, STATE_FILE);
    this.lockPath = join(dataDir, LOCK_DIR);
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
    this.lockPollMs = options.lockPollMs ?? 25;
  }

  get projectRootDir(): string {
    return this.rootDir;
  }

  async read(): Promise<TeamState> {
    await this.ensureInitialized();
    const raw = await readFile(this.statePath, "utf8");
    return this.migrate(JSON.parse(raw) as TeamState);
  }

  async transaction<T>(fn: (state: TeamState) => Promise<T> | T): Promise<T> {
    await this.acquireLock();
    try {
      const state = await this.read();
      const result = await fn(state);
      await this.write(state);
      return result;
    } finally {
      await rm(this.lockPath, { recursive: true, force: true });
    }
  }

  private async ensureInitialized(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    try {
      await readFile(this.statePath, "utf8");
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
      await this.write(emptyState());
    }
  }

  private async write(state: TeamState): Promise<void> {
    state.schemaVersion = SCHEMA_VERSION;
    await mkdir(dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tempPath, this.statePath);
  }

  private migrate(state: unknown): TeamState {
    if (!state || typeof state !== "object") {
      return emptyState();
    }
    const raw = state as Partial<TeamState> & LegacyOpenCodeBuildState;
    const migratedBuilds = raw.teamBuilds ?? raw.openCode?.builds ?? {};
    return {
      ...emptyState(),
      schemaVersion: SCHEMA_VERSION,
      teams: raw.teams ?? {},
      members: raw.members ?? {},
      tasks: raw.tasks ?? {},
      taskBoundaries: raw.taskBoundaries ?? {},
      safetySignals: raw.safetySignals ?? {},
      messages: raw.messages ?? {},
      messageDeliveries: raw.messageDeliveries ?? migrateMessageDeliveries(raw),
      pathLocks: raw.pathLocks ?? {},
      events: raw.events ?? [],
      teamBuilds: migratedBuilds,
      teamRuntimes: raw.teamRuntimes ?? {},
      agentSessions: raw.agentSessions ?? {},
      schedulerStates: raw.schedulerStates ?? {}
    };
  }

  private async acquireLock(): Promise<void> {
    const startedAt = Date.now();
    await mkdir(dirname(this.lockPath), { recursive: true });
    while (true) {
      try {
        await mkdir(this.lockPath);
        return;
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) {
          throw error;
        }
        if (Date.now() - startedAt > this.lockTimeoutMs) {
          throw new LockBusyError("State lock is busy", { lockPath: this.lockPath });
        }
        await sleep(this.lockPollMs);
      }
    }
  }
}

interface LegacyOpenCodeBuildState {
  openCode?: {
    builds?: Record<string, TeamBuild>;
  };
}

function migrateMessageDeliveries(raw: Partial<TeamState>): TeamState["messageDeliveries"] {
  const deliveries: TeamState["messageDeliveries"] = {};
  for (const message of Object.values(raw.messages ?? {})) {
    if (message.toMemberId) {
      const id = `delivery_${message.id}_${message.toMemberId}`;
      deliveries[id] = {
        id,
        teamId: message.teamId,
        messageId: message.id,
        memberId: message.toMemberId,
        createdAt: message.createdAt,
        updatedAt: message.acknowledgedAt ?? message.consumedAt ?? message.createdAt,
        acknowledgedAt: message.acknowledgedAt,
        consumedAt: message.consumedAt
      };
    }
  }
  return deliveries;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
