import { agentModelCandidates, agentModelIdSchema } from "@orcus/core";
import { ApiError } from "./errors";

export function selectedAgentModel(value?: string) {
  const configured = agentModelIdSchema.parse(process.env.ZEROG_COMPUTE_MODEL?.trim() || process.env.ZG_MODEL?.trim() || "0gm-1.0-35b-a3b");
  const model = agentModelIdSchema.parse(value ?? configured);
  if (model !== configured && !agentModelCandidates.some(candidate => candidate === model)) throw new ApiError("MODEL_NOT_ALLOWED", "Choose a supported model from the model selector.", 400);
  return model;
}
