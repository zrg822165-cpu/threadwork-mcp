export type TeamMcpErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_STATE"
  | "LOCK_BUSY"
  | "POLICY_BLOCKED"
  | "VALIDATION";

export class TeamMcpError extends Error {
  constructor(
    public readonly code: TeamMcpErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "TeamMcpError";
  }
}

export class NotFoundError extends TeamMcpError {
  constructor(message: string, details?: unknown) {
    super("NOT_FOUND", message, details);
  }
}

export class ConflictError extends TeamMcpError {
  constructor(message: string, details?: unknown) {
    super("CONFLICT", message, details);
  }
}

export class InvalidStateError extends TeamMcpError {
  constructor(message: string, details?: unknown) {
    super("INVALID_STATE", message, details);
  }
}

export class LockBusyError extends TeamMcpError {
  constructor(message: string, details?: unknown) {
    super("LOCK_BUSY", message, details);
  }
}

export class PolicyBlockedError extends TeamMcpError {
  constructor(message: string, details?: unknown) {
    super("POLICY_BLOCKED", message, details);
  }
}
