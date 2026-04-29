import type { PromptSessionInput, PromptSessionResult, SpawnSessionInput, SpawnSessionResult } from "./types.js";

export interface AgentBackend {
  readonly name: "opencode";
  start(): Promise<void>;
  stop(): Promise<void>;
  spawnSession(input: SpawnSessionInput): Promise<SpawnSessionResult>;
  promptSession(input: PromptSessionInput): Promise<PromptSessionResult>;
  abortSession(sessionId: string): Promise<void>;
}
