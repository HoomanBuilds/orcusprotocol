import { automationInputSchema } from "@orcus/core";
import { z } from "zod";

export const automationProposalSchema = automationInputSchema;
export type AutomationProposal = z.infer<typeof automationProposalSchema>;
