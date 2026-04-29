import type { AgentSessionRecord, AgentSessionStatus, RuntimeBackendName, RuntimeStatus, TeamRuntime } from "../domain/types.js";

export interface RuntimeStartInput {
  teamId: string;
  backend?: RuntimeBackendName;
  workdir?: string;
  maxParallel?: number;
  autoAssign?: boolean;
}

export interface RuntimeStopInput {
  teamId: string;
  memberIds?: string[];
  reason?: string;
}

export interface RuntimePauseInput {
  teamId: string;
}

export interface RuntimeResumeInput {
  teamId: string;
}

export interface RuntimeReadyInput {
  teamId: string;
  backend?: RuntimeBackendName;
  workdir?: string;
  maxParallel?: number;
  autoAssign?: boolean;
}

export interface RuntimeStatusView {
  runtime: TeamRuntime;
  sessions: AgentSessionRecord[];
  status: RuntimeStatus;
}

export interface SpawnSessionInput {
  teamId: string;
  memberId: string;
  memberName: string;
  agentId?: string;
  model?: string;
  prompt?: string;
  workdir?: string;
}

export interface SpawnSessionResult {
  backendSessionId: string;
  status?: AgentSessionStatus;
}

export interface PromptSessionInput {
  backendSessionId: string;
  prompt: string;
}

export interface PromptSessionResult {
  summary?: string;
  conversationState?: "handled" | "waiting";
  raw?: unknown;
}
