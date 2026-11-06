import { automationInputSchema } from "@orcus/core";
import { z } from "zod";

export const automationProposalSchema = automationInputSchema.transform(value => value.kind === "trade"
  ? { ...value, kind: "trade" as const, request: value.request! }
  : { ...value, kind: "alert" as const, condition: value.condition! });
export type AutomationProposal = z.infer<typeof automationProposalSchema>;
