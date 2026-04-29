import type { EventInput } from "../services/events.js";

export type RuntimeEventHandler = (event: EventInput) => Promise<void> | void;

export class RuntimeEventBus {
  private readonly handlers = new Map<string, Set<RuntimeEventHandler>>();

  emit(event: EventInput): void {
    for (const handler of this.handlers.get(event.type) ?? []) {
      void handler(event);
    }
  }

  on(type: string, handler: RuntimeEventHandler): () => void {
    const handlers = this.handlers.get(type) ?? new Set<RuntimeEventHandler>();
    handlers.add(handler);
    this.handlers.set(type, handlers);
    return () => handlers.delete(handler);
  }
}
