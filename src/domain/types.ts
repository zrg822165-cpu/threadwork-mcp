export const SCHEMA_VERSION = 8;

export type TeamStatus = "active" | "closed";
export type MemberRole = "lead" | "teammate" | "observer";
export type MemberStatus = "active" | "inactive";
export type TaskStatus = "pending" | "claimed" | "completed" | "failed" | "cancelled";
export type PathLockMode = "exclusive";
export type RuntimeStatus = "not_started" | "ready" | "running" | "paused" | "stopped" | "error";
export type AgentSessionStatus = "starting" | "idle" | "working" | "waiting" | "completed" | "error" | "stopped";
export type RuntimeBackendName = "opencode";
export type TaskPriority = "low" | "medium" | "high";
export type MessageType = "question" | "handoff" | "result" | "notification" | "escalation" | "opinion";
export type TaskBoundaryScopeSource = "path_hints" | "none";
export type SafetySignalKind = "scope_missing" | "scope_warning" | "policy_blocked";
export type SafetySignalLevel = "warning" | "needs_review" | "blocked";
export type SafetySignalStatus = "open" | "acknowledged" | "resolved";

export type BoundedRunStoppedReason = "idle" | "paused" | "max_ticks" | "timeout" | "error" | "needs_attention";
export type BackgroundProgressStatus = "active" | "idle" | "stopped" | "needs_attention" | "error";

export interface Team {
  id: string;
  name: string;
  description?: string;
  status: TeamStatus;
  leadMemberId?: string;
  memberIds: string[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface Member {
  id: string;
  teamId: string;
  name: string;
  role: MemberRole;
  status: MemberStatus;
  capabilities: string[];
  agentId?: string;
  model?: string;
  rawResponsibility?: string;
  polishedPrompt?: string;
  permissions?: string[];
  callWhen?: string[];
  doNot?: string[];
  createdOrder?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  teamId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  dependencyTaskIds: string[];
  pathHints: string[];
  priority?: TaskPriority;
  createdByMemberId?: string;
  preferredMemberId?: string;
  assignedMemberId?: string;
  completionSummary?: string;
  failureSummary?: string;
  resultArtifacts?: string[];
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  completedAt?: string;
  failedAt?: string;
  cancelledAt?: string;
}

export interface TaskBoundary {
  taskId: string;
  teamId: string;
  scopePaths: string[];
  scopeSource: TaskBoundaryScopeSource;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface SafetySignal {
  id: string;
  teamId: string;
  taskId?: string;
  memberId?: string;
  kind: SafetySignalKind;
  level: SafetySignalLevel;
  summary: string;
  status: SafetySignalStatus;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface Message {
  id: string;
  teamId: string;
  threadId?: string;
  fromMemberId?: string;
  toMemberId?: string;
  taskId?: string;
  type?: MessageType;
  subject?: string;
  body: string;
  replyToMessageId?: string;
  createdAt: string;
  acknowledgedAt?: string;
  consumedAt?: string;
}

export interface MessageDelivery {
  id: string;
  teamId: string;
  messageId: string;
  memberId: string;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt?: string;
  consumedAt?: string;
}

export interface PathLock {
  id: string;
  teamId: string;
  ownerMemberId: string;
  taskId?: string;
  paths: string[];
  mode: PathLockMode;
  createdAt: string;
  expiresAt?: string;
}

export interface Event {
  id: string;
  teamId?: string;
  actorMemberId?: string;
  entityType?: "team" | "member" | "task" | "message" | "pathLock";
  entityId?: string;
  type: string;
  message: string;
  createdAt: string;
}

export interface TeamBuildHost {
  name?: string;
  model?: string;
  responsibility?: string;
  notes?: string;
}

export interface TeamMemberDraft {
  id: string;
  teamId: string;
  name: string;
  agentId: string;
  model: string;
  rawResponsibility: string;
  polishedPrompt: string;
  permissions: string[];
  callWhen: string[];
  doNot: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TeamBuild {
  teamId: string;
  host: TeamBuildHost;
  status: "building" | "finalized";
  confirmedMemberIds: string[];
  currentDraft?: TeamMemberDraft;
  createdAt: string;
  updatedAt: string;
  finalizedAt?: string;
}

export interface TeamRuntime {
  teamId: string;
  status: RuntimeStatus;
  backend: RuntimeBackendName;
  workdir?: string;
  maxParallel: number;
  autoAssign: boolean;
  startedAt?: string;
  stoppedAt?: string;
  updatedAt: string;
}

export interface AgentSessionRecord {
  id: string;
  teamId: string;
  memberId: string;
  backend: RuntimeBackendName;
  backendSessionId?: string;
  status: AgentSessionStatus;
  currentTaskId?: string;
  currentMessageId?: string;
  lastHeartbeatAt?: string;
  lastResultSummary?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SchedulerState {
  teamId: string;
  paused: boolean;
  lastTickAt?: string;
  lastDecision?: string;
  background?: BackgroundProgressState;
  updatedAt: string;
}

export interface BackgroundProgressState {
  runId: string;
  status: BackgroundProgressStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  requestedMaxTicks: number;
  timeoutMs?: number;
  ticksRun: number;
  totalAssignments: number;
  stoppedReason?: BoundedRunStoppedReason;
  lastDecision?: string;
  lastErrorMessage?: string;
  needsAttentionReason?: string;
}

export interface TeamState {
  schemaVersion: number;
  teams: Record<string, Team>;
  members: Record<string, Member>;
  tasks: Record<string, Task>;
  taskBoundaries: Record<string, TaskBoundary>;
  safetySignals: Record<string, SafetySignal>;
  messages: Record<string, Message>;
  messageDeliveries: Record<string, MessageDelivery>;
  pathLocks: Record<string, PathLock>;
  events: Event[];
  teamBuilds: Record<string, TeamBuild>;
  teamRuntimes: Record<string, TeamRuntime>;
  agentSessions: Record<string, AgentSessionRecord>;
  schedulerStates: Record<string, SchedulerState>;
}

export function emptyState(): TeamState {
  return {
    schemaVersion: SCHEMA_VERSION,
    teams: {},
    members: {},
    tasks: {},
    taskBoundaries: {},
    safetySignals: {},
    messages: {},
    messageDeliveries: {},
    pathLocks: {},
    events: [],
    teamBuilds: {},
    teamRuntimes: {},
    agentSessions: {},
    schedulerStates: {}
  };
}
