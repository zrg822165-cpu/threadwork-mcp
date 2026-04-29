import { InvalidStateError } from "../errors.js";
import type { SchedulerTickInput, SchedulerTickResult } from "./scheduler.js";
import type { BoundedRunStoppedReason } from "../domain/types.js";

export interface SchedulerRunInput {
  teamId: string;
  maxTicks?: number;
  timeoutMs?: number;
  rethrowOnError?: boolean;
  shouldStopForAttention?: (decisions: SchedulerTickResult[]) => Promise<string | undefined> | string | undefined;
  shouldContinueWhenIdle?: (decisions: SchedulerTickResult[]) => Promise<boolean> | boolean;
  idlePollMs?: number;
}

export type SchedulerRunStoppedReason = BoundedRunStoppedReason;

export interface SchedulerRunResult {
  ticksRun: number;
  totalAssignments: number;
  stoppedReason: SchedulerRunStoppedReason;
  decisions: SchedulerTickResult[];
  error?: {
    message: string;
  };
  needsAttentionReason?: string;
}

export type SchedulerTickExecutor = (input: SchedulerTickInput) => Promise<SchedulerTickResult>;

export class RuntimeSchedulerRunner {
  constructor(private readonly tick: SchedulerTickExecutor) {}

  async run(input: SchedulerRunInput): Promise<SchedulerRunResult> {
    const maxTicks = input.maxTicks ?? 10;
    if (!Number.isInteger(maxTicks) || maxTicks < 1) {
      throw new InvalidStateError("maxTicks must be a positive integer", { maxTicks });
    }
    const idlePollMs = input.idlePollMs ?? 25;
    if (!Number.isInteger(idlePollMs) || idlePollMs < 0) {
      throw new InvalidStateError("idlePollMs must be a non-negative integer", { idlePollMs });
    }

    const decisions: SchedulerTickResult[] = [];
    let totalAssignments = 0;
    const deadline = input.timeoutMs === undefined ? undefined : Date.now() + input.timeoutMs;

    if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1)) {
      throw new InvalidStateError("timeoutMs must be a positive integer", { timeoutMs: input.timeoutMs });
    }

    for (let index = 0; index < maxTicks; index++) {
      if (deadline !== undefined && Date.now() >= deadline) {
        return { ticksRun: decisions.length, totalAssignments, stoppedReason: "timeout", decisions };
      }

      let result: SchedulerTickResult;
      try {
        result = await this.tick({ teamId: input.teamId });
      } catch (error) {
        if (input.rethrowOnError) {
          throw error;
        }
        return {
          ticksRun: decisions.length,
          totalAssignments,
          stoppedReason: "error",
          decisions,
          error: { message: error instanceof Error ? error.message : String(error) }
        };
      }

      decisions.push(result);
      totalAssignments += result.assignments.length;

      const needsAttentionReason = await input.shouldStopForAttention?.(decisions);
      if (needsAttentionReason) {
        return { ticksRun: decisions.length, totalAssignments, stoppedReason: "needs_attention", decisions, needsAttentionReason };
      }

      if (result.decision === "Scheduler is paused") {
        return { ticksRun: decisions.length, totalAssignments, stoppedReason: "paused", decisions };
      }

      if (result.assignments.length === 0) {
        const shouldContinueWhenIdle = await input.shouldContinueWhenIdle?.(decisions);
        if (shouldContinueWhenIdle && index < maxTicks - 1) {
          if (deadline !== undefined && Date.now() >= deadline) {
            return { ticksRun: decisions.length, totalAssignments, stoppedReason: "timeout", decisions };
          }
          const remainingMs = deadline === undefined ? idlePollMs : Math.max(0, deadline - Date.now());
          if (remainingMs > 0) {
            await delay(Math.min(idlePollMs, remainingMs));
          }
          continue;
        }
        return { ticksRun: decisions.length, totalAssignments, stoppedReason: "idle", decisions };
      }
    }

    return { ticksRun: decisions.length, totalAssignments, stoppedReason: "max_ticks", decisions };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
