import { positiveDecimalSchema, tradeRequestSchema } from "@orcus/core";
import { z } from "zod";

const conditionSchema = z.object({ symbol: z.string().min(1).max(50), operator: z.enum(["above", "below"]), price: positiveDecimalSchema }).strict();
const common = {
  accountId: z.string().min(1).max(100),
  name: z.string().min(1).max(80),
  instruction: z.string().min(1).max(2000).optional(),
  intervalSeconds: z.number().int().min(60).max(86_400).default(300),
  expiresAt: z.number().int().positive().optional(),
};

export const automationProposalSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("trade"), request: tradeRequestSchema, condition: conditionSchema.optional() }).strict(),
  z.object({ ...common, kind: z.literal("alert"), condition: conditionSchema }).strict(),
]);
export type AutomationProposal = z.infer<typeof automationProposalSchema>;
