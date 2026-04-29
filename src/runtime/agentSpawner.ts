import type { AgentSessionRecord, Member, TeamState } from "../domain/types.js";
import { addEvent } from "../services/events.js";
import { requireActiveMember } from "../services/guards.js";
import { newId, nowIso } from "../utils/id.js";
import type { AgentBackend } from "./agentBackend.js";

export class AgentSpawner {
  constructor(
    private readonly state: TeamState,
    private readonly backend: AgentBackend
  ) {}

  async ensureSession(teamId: string, memberId: string, workdir?: string): Promise<AgentSessionRecord> {
    const existing = Object.values(this.state.agentSessions).find(
      (session) => session.teamId === teamId && session.memberId === memberId && session.status !== "stopped"
    );
    if (existing) {
      return existing;
    }

    const member = requireActiveMember(this.state, teamId, memberId);
    return this.spawnForMember(member, workdir);
  }

  private async spawnForMember(member: Member, workdir?: string): Promise<AgentSessionRecord> {
    const now = nowIso();
    const session: AgentSessionRecord = {
      id: newId("session"),
      teamId: member.teamId,
      memberId: member.id,
      backend: this.backend.name,
      status: "starting",
      createdAt: now,
      updatedAt: now
    };
    this.state.agentSessions[session.id] = session;
    addEvent(this.state, {
      teamId: member.teamId,
      actorMemberId: member.id,
      entityType: "member",
      entityId: member.id,
      type: "session.starting",
      message: `Starting session for ${member.name}`
    });

    try {
      const result = await this.backend.spawnSession({
        teamId: member.teamId,
        memberId: member.id,
        memberName: member.name,
        agentId: member.agentId,
        model: member.model,
        prompt: member.polishedPrompt,
        workdir
      });
      session.backendSessionId = result.backendSessionId;
      session.status = result.status ?? "idle";
      session.updatedAt = nowIso();
      addEvent(this.state, {
        teamId: member.teamId,
        actorMemberId: member.id,
        entityType: "member",
        entityId: member.id,
        type: "session.started",
        message: `Started session for ${member.name}`
      });
      return session;
    } catch (error) {
      session.status = "error";
      session.errorMessage = error instanceof Error ? error.message : String(error);
      session.updatedAt = nowIso();
      addEvent(this.state, {
        teamId: member.teamId,
        actorMemberId: member.id,
        entityType: "member",
        entityId: member.id,
        type: "session.error",
        message: `Session failed for ${member.name}: ${session.errorMessage}`
      });
      throw error;
    }
  }
}
