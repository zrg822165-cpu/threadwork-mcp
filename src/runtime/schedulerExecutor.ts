import type { AgentBackend } from "./agentBackend.js";
import { RuntimeScheduler, type SchedulerTickInput, type SchedulerTickResult } from "./scheduler.js";
import type { JsonStore } from "../store/jsonStore.js";

export async function runSchedulerTickWithSplitStore(
  store: JsonStore,
  backend: AgentBackend,
  input: SchedulerTickInput
): Promise<SchedulerTickResult> {
  const prepared = await store.transaction((state) => new RuntimeScheduler(state, backend).prepareTick(input));
  if (prepared.assignments.length === 0) {
    return prepared;
  }

  for (const assignment of prepared.assignments) {
    try {
      const result = await backend.promptSession({ backendSessionId: assignment.backendSessionId, prompt: assignment.prompt });
      await store.transaction((state) => new RuntimeScheduler(state, backend).finalizePromptSuccess(input.teamId, assignment, result));
    } catch (error) {
      await store.transaction((state) => new RuntimeScheduler(state, backend).finalizePromptFailure(input.teamId, assignment, error));
      throw error;
    }
  }

  return store.transaction((state) => new RuntimeScheduler(state, backend).recordDecision(input.teamId, prepared.assignments, prepared.decision));
}
