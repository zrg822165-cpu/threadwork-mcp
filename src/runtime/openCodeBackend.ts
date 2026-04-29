import { createOpencode } from "@opencode-ai/sdk/v2";
import type { Config, OpencodeClient } from "@opencode-ai/sdk/v2";
import type { Part, SessionPromptResponse } from "@opencode-ai/sdk/v2";
import type { AgentBackend } from "./agentBackend.js";
import type { PromptSessionInput, PromptSessionResult, SpawnSessionInput, SpawnSessionResult } from "./types.js";

type OpenCodeServer = Awaited<ReturnType<typeof createOpencode>>["server"];

export interface OpenCodeBackendOptions {
  startupTimeoutMs?: number;
  promptTimeoutMs?: number;
  noReply?: boolean;
  hostname?: string;
  port?: number;
  config?: Config;
}

export class OpenCodeBackend implements AgentBackend {
  readonly name = "opencode" as const;
  private client?: OpencodeClient;
  private server?: OpenCodeServer;

  constructor(private readonly options: OpenCodeBackendOptions = {}) {}

  async start(): Promise<void> {
    if (this.client) return;
    const opencode = await createOpencode({
      timeout: this.options.startupTimeoutMs ?? 15000,
      hostname: this.options.hostname,
      port: this.options.port,
      config: this.options.config
    });
    this.client = opencode.client;
    this.server = opencode.server;
  }

  async stop(): Promise<void> {
    this.server?.close();
    this.server = undefined;
    this.client = undefined;
  }

  async spawnSession(input: SpawnSessionInput): Promise<SpawnSessionResult> {
    const client = this.requireClient();
    const result = await client.session.create({
      directory: input.workdir,
      title: `${input.memberName} (${input.memberId})`
    });
    if (result.error) {
      throw new Error(`Failed to create OpenCode session: ${JSON.stringify(result.error)}`);
    }
    return {
      backendSessionId: result.data.id,
      status: "idle"
    };
  }

  async promptSession(input: PromptSessionInput): Promise<PromptSessionResult> {
    const client = this.requireClient();
    const parts = [{ type: "text" as const, text: input.prompt }];
    if (this.options.noReply) {
      const result = await this.withPromptTimeout(input.backendSessionId, client.session.promptAsync({
          sessionID: input.backendSessionId,
          noReply: true,
          parts
        }), "async prompt");
      if (result.error) {
        throw new Error(`Failed to prompt OpenCode session: ${JSON.stringify(result.error)}`);
      }
      return { raw: result.data };
    }

    const result = await this.withPromptTimeout(input.backendSessionId, client.session.prompt({
        sessionID: input.backendSessionId,
        parts
      }), "prompt");
    if (result.error) {
      throw new Error(`Failed to prompt OpenCode session: ${JSON.stringify(result.error)}`);
    }
    return {
      summary: summarizePromptResponse(result.data),
      raw: result.data
    };
  }

  async abortSession(sessionId: string): Promise<void> {
    const client = this.requireClient();
    const result = await client.session.abort({ sessionID: sessionId });
    if (result.error) {
      throw new Error(`Failed to abort OpenCode session: ${JSON.stringify(result.error)}`);
    }
  }

  private requireClient(): OpencodeClient {
    if (!this.client) {
      throw new Error("OpenCode backend is not started");
    }
    return this.client;
  }

  private async withPromptTimeout<T>(sessionId: string, operation: Promise<T>, label: string): Promise<T> {
    const timeoutMs = this.options.promptTimeoutMs;
    if (!timeoutMs) {
      return operation;
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            void this.abortSession(sessionId).catch(() => undefined);
            reject(new Error(`OpenCode ${label} timed out after ${timeoutMs}ms for session ${sessionId}`));
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}

function summarizePromptResponse(response: SessionPromptResponse): string | undefined {
  return response.parts
    .filter(isTextPart)
    .map((part) => part.text.trim())
    .filter((text) => text.length > 0)
    .join("\n") || undefined;
}

function isTextPart(part: Part): part is Extract<Part, { type: "text" }> {
  return part.type === "text";
}
