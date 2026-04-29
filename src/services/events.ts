import type { Event, TeamState } from "../domain/types.js";
import { newId, nowIso } from "../utils/id.js";

export interface EventInput {
  teamId?: string;
  actorMemberId?: string;
  entityType?: Event["entityType"];
  entityId?: string;
  type: string;
  message: string;
}

export function addEvent(state: TeamState, input: EventInput): Event {
  const event: Event = {
    id: newId("evt"),
    createdAt: nowIso(),
    ...input
  };
  state.events.push(event);
  return event;
}
