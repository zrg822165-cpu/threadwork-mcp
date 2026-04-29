import { z } from "zod";

export const memberRoleSchema = z.enum(["lead", "teammate", "observer"]);

export function draftSchema() {
  return {
    teamId: z.string().optional(),
    name: z.string().min(1),
    agentId: z.string().optional(),
    model: z.string().min(1),
    rawResponsibility: z.string().min(1),
    polishedPrompt: z.string().min(1),
    permissions: z.array(z.string()).optional(),
    callWhen: z.array(z.string()).optional(),
    doNot: z.array(z.string()).optional()
  };
}
