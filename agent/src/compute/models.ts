import { agentModelCandidates, agentModelIdSchema, type AgentModelCatalog, type AgentModelChoice } from "@orcus/core";
import { engineConfig } from "../config";
import { EngineError } from "../errors";
import { boundedResearchJson } from "./research";

export const defaultAgentModel = () => agentModelIdSchema.parse(engineConfig().compute.model ?? "0gm-1.0-35b-a3b");
export function permittedAgentModel(value?: string) {
  const configured = defaultAgentModel(), model = agentModelIdSchema.parse(value ?? configured);
  if (model !== configured && !agentModelCandidates.some(candidate => candidate === model)) throw new EngineError("MODEL_NOT_ALLOWED", "Choose a supported agent model from the model selector.", 400);
  return model;
}

type CatalogRow = { id?: unknown; name?: unknown; type?: unknown; supported_formats?: unknown; supported_parameters?: unknown; provider_count?: unknown; verifiability?: unknown; pricing_usd?: { prompt?: unknown; completion?: unknown } };
let cache: { origin: string; checkedAt: number; rows: CatalogRow[] } | undefined;
export async function getAgentModels(selectedId?: string): Promise<AgentModelCatalog> {
  const defaultModelId = defaultAgentModel(), selectedModelId = permittedAgentModel(selectedId);
  const origin = new URL(engineConfig().compute.url ?? "https://router-api.0g.ai/v1/chat/completions").origin;
  let catalogAvailable = false, checkedAt: number | undefined, rows: CatalogRow[] = [];
  try {
    if (!["https://router-api.0g.ai", "https://router-api-testnet.integratenetwork.work"].includes(origin)) throw new Error("Unsupported catalog origin");
    if (cache?.origin === origin && Date.now() - cache.checkedAt < 30_000) ({ rows, checkedAt } = cache);
    else {
      const raw = await boundedResearchJson(await fetch(new URL("/v1/models", origin), { signal: AbortSignal.timeout(5_000), redirect: "error" }), 1_000_000) as { data?: unknown };
      if (!Array.isArray(raw?.data) || raw.data.length > 1000) throw new Error("Invalid model catalog");
      rows = raw.data.filter((row): row is CatalogRow => !!row && typeof row === "object");
      checkedAt = Date.now(); cache = { origin, rows, checkedAt };
    }
    catalogAvailable = true;
  } catch { cache = undefined; }
  const models = [...new Set([defaultModelId, ...agentModelCandidates])].map(id => {
    const row = rows.find(item => item.id === id);
    const compatible = row?.type === "chatbot" && Array.isArray(row.supported_formats) && row.supported_formats.includes("openai") && Array.isArray(row.supported_parameters) && row.supported_parameters.includes("tools") && row.supported_parameters.includes("response_format") && typeof row.provider_count === "number" && row.provider_count > 0;
    const configured = id === defaultModelId;
    const choice: AgentModelChoice = { id, name: typeof row?.name === "string" ? row.name.slice(0, 100) : id, available: configured || compatible, compatibility: configured ? "configured" : "catalog", privacy: row?.verifiability === "TeeML" ? "catalog-tee" : "unverified" };
    const price = (value: unknown) => typeof value === "string" && /^\d+(?:\.\d{1,18})?$/.test(value) && Number.isFinite(Number(value)) && Number(value) <= 1 ? String(Number((Number(value) * 1_000_000).toFixed(6))) : undefined;
    const prompt = price(row?.pricing_usd?.prompt), completion = price(row?.pricing_usd?.completion);
    if (prompt !== undefined && completion !== undefined) choice.pricing = { promptPerMillionUsd: prompt, completionPerMillionUsd: completion };
    if (!choice.available) choice.reason = catalogAvailable ? "This model is unavailable or lacks required text-tool/JSON capabilities." : "The live catalog is unavailable; alternatives cannot be verified.";
    return choice;
  });
  return { defaultModelId, selectedModelId, catalogAvailable, checkedAt, models, warning: catalogAvailable ? "Catalog compatibility is not a quality benchmark. Catalog TEE status is not request verification. Existing spending limits still apply." : "Live model metadata is unavailable. The operator-configured default remains usable; no alternative will be substituted." };
}

export async function validateAgentModel(value?: string) {
  const model = permittedAgentModel(value);
  if (model !== defaultAgentModel() && !(await getAgentModels(model)).models.some(choice => choice.id === model && choice.available)) throw new EngineError("MODEL_UNAVAILABLE", "The selected model is not currently verified as available. Choose the configured default or try later; no fallback was made.", 503);
  return model;
}

export function modelRequestOptions(model: string) {
  if (model === "0gm-1.0-35b-a3b" || model === "glm-5.3") return { temperature: 0.2, response_format: { type: "json_object" }, chat_template_kwargs: { enable_thinking: false } };
  if (model === "qwen3.5-plus") return { response_format: { type: "json_object" } };
  return { temperature: 0.2 };
}
