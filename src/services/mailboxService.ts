import type { Message, MessageDelivery, MessageType, TeamState } from "../domain/types.js";
import { NotFoundError } from "../errors.js";
import { newId, nowIso } from "../utils/id.js";
import { addEvent } from "./events.js";
import { requireActiveMember, requireActiveTeam, requireTeamTask } from "./guards.js";

export interface SendMessageInput {
  teamId: string;
  fromMemberId?: string;
  toMemberId?: string;
  taskId?: string;
  type?: MessageType;
  subject?: string;
  body: string;
  replyToMessageId?: string;
  participantMemberIds?: string[];
}

export interface InboxInput {
  teamId: string;
  memberId?: string;
  taskId?: string;
  includeAcknowledged?: boolean;
  includeConsumed?: boolean;
}

export interface AckMessageInput {
  teamId: string;
  messageId: string;
  memberId?: string;
}

export interface ConsumeMessagesInput {
  teamId: string;
  memberId: string;
  messageIds: string[];
}

export class MailboxService {
  constructor(private readonly state: TeamState) {}

  sendMessage(input: SendMessageInput): Message {
    requireActiveTeam(this.state, input.teamId);
    if (input.fromMemberId) {
      requireActiveMember(this.state, input.teamId, input.fromMemberId);
    }
    if (input.toMemberId) {
      requireActiveMember(this.state, input.teamId, input.toMemberId);
    }
    if (input.taskId) {
      requireTeamTask(this.state, input.teamId, input.taskId);
    }
    if (input.replyToMessageId) {
      const parent = this.state.messages[input.replyToMessageId];
      if (!parent || parent.teamId !== input.teamId) {
        throw new NotFoundError(`Message not found: ${input.replyToMessageId}`);
      }
    }
    for (const memberId of input.participantMemberIds ?? []) {
      requireActiveMember(this.state, input.teamId, memberId);
    }

    const parent = input.replyToMessageId ? this.state.messages[input.replyToMessageId] : undefined;
    const messageId = newId("msg");
    const message: Message = {
      id: messageId,
      teamId: input.teamId,
      threadId: parent?.threadId ?? parent?.id ?? messageId,
      fromMemberId: input.fromMemberId,
      toMemberId: input.toMemberId,
      taskId: input.taskId,
      type: input.type ?? "notification",
      subject: input.subject,
      body: input.body,
      replyToMessageId: input.replyToMessageId,
      createdAt: nowIso()
    };
    this.state.messages[message.id] = message;
    for (const memberId of this.deliveryTargets(input)) {
      this.createDelivery(message, memberId);
    }
    addEvent(this.state, {
      teamId: input.teamId,
      actorMemberId: input.fromMemberId,
      entityType: "message",
      entityId: message.id,
      type: "message.sent",
      message: input.subject ? `Sent message: ${input.subject}` : "Sent message"
    });
    return message;
  }

  inbox(input: InboxInput): Message[] {
    requireActiveTeam(this.state, input.teamId);
    if (input.memberId) {
      requireActiveMember(this.state, input.teamId, input.memberId);
    }
    if (input.taskId) {
      requireTeamTask(this.state, input.teamId, input.taskId);
    }

    const messages = Object.values(this.state.messages)
      .filter((message) => message.teamId === input.teamId);
    for (const message of messages) {
      this.ensureLegacyDelivery(message);
    }

    return messages
      .filter((message) => !input.memberId || this.messageDeliveriesForMember(message.id, input.memberId).length > 0)
      .filter((message) => !input.taskId || message.taskId === input.taskId)
      .filter((message) => {
        if (!input.memberId) {
          return input.includeAcknowledged || !message.acknowledgedAt;
        }
        return input.includeAcknowledged || this.messageDeliveriesForMember(message.id, input.memberId).some((delivery) => !delivery.acknowledgedAt);
      })
      .filter((message) => {
        if (!input.memberId) {
          return input.includeConsumed || !message.consumedAt;
        }
        return input.includeConsumed || this.messageDeliveriesForMember(message.id, input.memberId).some((delivery) => !delivery.consumedAt);
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  consumeMessages(input: ConsumeMessagesInput): Message[] {
    requireActiveTeam(this.state, input.teamId);
    requireActiveMember(this.state, input.teamId, input.memberId);

    const now = nowIso();
    return input.messageIds.map((messageId) => {
      const message = this.state.messages[messageId];
      if (!message || message.teamId !== input.teamId) {
        throw new NotFoundError(`Message not found: ${messageId}`);
      }
      if (message.toMemberId && message.toMemberId !== input.memberId) {
        throw new NotFoundError(`Message not found: ${messageId}`);
      }
      this.ensureLegacyDelivery(message);
      const deliveries = this.messageDeliveriesForMember(message.id, input.memberId);
      if (deliveries.length === 0) {
        throw new NotFoundError(`Message not found: ${messageId}`);
      }
      for (const delivery of deliveries) {
        if (!delivery.consumedAt) {
          delivery.consumedAt = now;
          delivery.updatedAt = now;
        }
      }
      if (!message.consumedAt) {
        message.consumedAt = now;
        addEvent(this.state, {
          teamId: input.teamId,
          actorMemberId: input.memberId,
          entityType: "message",
          entityId: message.id,
          type: "message.consumed",
          message: `Consumed message ${message.id}`
        });
      }
      return message;
    });
  }

  ackMessage(input: AckMessageInput): Message {
    requireActiveTeam(this.state, input.teamId);
    if (input.memberId) {
      requireActiveMember(this.state, input.teamId, input.memberId);
    }

    const message = this.state.messages[input.messageId];
    if (!message || message.teamId !== input.teamId) {
      throw new NotFoundError(`Message not found: ${input.messageId}`);
    }
    this.ensureLegacyDelivery(message);
    const deliveries = input.memberId
      ? this.messageDeliveriesForMember(message.id, input.memberId)
      : this.messageDeliveries(message.id);
    if (input.memberId && deliveries.length === 0) {
      throw new NotFoundError(`Message not found: ${input.messageId}`);
    }
    const now = nowIso();
    for (const delivery of deliveries) {
      if (!delivery.acknowledgedAt) {
        delivery.acknowledgedAt = now;
        delivery.updatedAt = now;
      }
    }
    if (message.acknowledgedAt) {
      return message;
    }
    message.acknowledgedAt = now;
    addEvent(this.state, {
      teamId: input.teamId,
      actorMemberId: input.memberId,
      entityType: "message",
      entityId: message.id,
      type: "message.acknowledged",
      message: `Acknowledged message ${message.id}`
    });
    return message;
  }

  private deliveryTargets(input: SendMessageInput): string[] {
    if (input.participantMemberIds?.length) {
      return [...new Set(input.participantMemberIds.filter((memberId) => memberId !== input.fromMemberId))];
    }
    if (input.toMemberId) {
      return [input.toMemberId];
    }
    if (!messageTypeCreatesImplicitBroadcastDelivery(input.type)) {
      return [];
    }
    return Object.values(this.state.members)
      .filter((member) => member.teamId === input.teamId && member.status === "active")
      .map((member) => member.id)
      .filter((memberId) => memberId !== input.fromMemberId);
  }

  private createDelivery(message: Message, memberId: string): MessageDelivery {
    const existing = this.messageDeliveriesForMember(message.id, memberId)[0];
    if (existing) {
      return existing;
    }
    const delivery: MessageDelivery = {
      id: newId("delivery"),
      teamId: message.teamId,
      messageId: message.id,
      memberId,
      createdAt: message.createdAt,
      updatedAt: message.createdAt
    };
    this.state.messageDeliveries[delivery.id] = delivery;
    return delivery;
  }

  private ensureLegacyDelivery(message: Message): void {
    if (!message.toMemberId || this.messageDeliveries(message.id).length > 0) {
      return;
    }
    const delivery = this.createDelivery(message, message.toMemberId);
    delivery.acknowledgedAt = message.acknowledgedAt;
    delivery.consumedAt = message.consumedAt;
    delivery.updatedAt = message.acknowledgedAt ?? message.consumedAt ?? message.createdAt;
  }

  private messageDeliveries(messageId: string): MessageDelivery[] {
    return Object.values(this.state.messageDeliveries).filter((delivery) => delivery.messageId === messageId);
  }

  private messageDeliveriesForMember(messageId: string, memberId: string): MessageDelivery[] {
    return Object.values(this.state.messageDeliveries)
      .filter((delivery) => delivery.messageId === messageId && delivery.memberId === memberId);
  }
}

function messageTypeCreatesImplicitBroadcastDelivery(type: MessageType | undefined): boolean {
  switch (type ?? "notification") {
    case "question":
    case "handoff":
    case "notification":
    case "escalation":
      return true;
    case "opinion":
    case "result":
      return false;
  }
}
