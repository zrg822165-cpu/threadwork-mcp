import type { AgentBackend } from "./agentBackend.js";
import type { PromptSessionInput, PromptSessionResult, SpawnSessionInput, SpawnSessionResult } from "./types.js";

export class FakeAgentBackend implements AgentBackend {
  readonly name = "opencode" as const;
  private started = false;
  private nextSession = 1;
  readonly prompts: PromptSessionInput[] = [];

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async spawnSession(input: SpawnSessionInput): Promise<SpawnSessionResult> {
    this.requireStarted();
    return {
      backendSessionId: `fake_${input.memberId}_${this.nextSession++}`,
      status: "idle"
    };
  }

  async promptSession(input: PromptSessionInput): Promise<PromptSessionResult> {
    this.requireStarted();
    this.prompts.push(input);
    return { summary: `Prompted ${input.backendSessionId}` };
  }

  async abortSession(_sessionId: string): Promise<void> {
    this.requireStarted();
  }

  private requireStarted(): void {
    if (!this.started) {
      throw new Error("Fake backend is not started");
    }
  }
}
