import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const row = (id = "qwen3.5-plus") => ({ id, name: "Qwen3.5-Plus", type: "chatbot", supported_formats: ["openai"], supported_parameters: ["tools", "response_format"], provider_count: 1, pricing_usd: { prompt: "0.000000116667", completion: "0.0000007" } });
beforeEach(() => { vi.resetModules(); vi.stubEnv("ZEROG_COMPUTE_MODEL", "0gm-1.0-35b-a3b"); vi.stubEnv("ZEROG_COMPUTE_CHAT_URL", "https://router-api.0g.ai/v1/chat/completions"); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("bounded model choices", () => {
  it("keeps only the explicit operator default usable when the catalog is unavailable", async () => {
    const fetcher = vi.fn(async () => { throw new Error("offline"); }); vi.stubGlobal("fetch", fetcher);
    const { getAgentModels, validateAgentModel } = await import("./models");
    const result = await getAgentModels();
    expect(result).toMatchObject({ defaultModelId: "0gm-1.0-35b-a3b", selectedModelId: "0gm-1.0-35b-a3b", catalogAvailable: false });
    expect(result.models.filter(model => model.available).map(model => model.id)).toEqual(["0gm-1.0-35b-a3b"]);
    expect(result.models.every(model => !model.pricing)).toBe(true);
    await expect(validateAgentModel("qwen3.5-plus")).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
    const calls=fetcher.mock.calls.length; await expect(validateAgentModel()).resolves.toBe("0gm-1.0-35b-a3b"); expect(fetcher).toHaveBeenCalledTimes(calls);
  });
  it("uses current catalog capabilities and prices, never claims verified privacy", async () => {
    const fetcher=vi.fn(async (_input: string|URL|Request) => Response.json({ data: [row(), { ...row("glm-5.3"), verifiability: "TeeML" }] })); vi.stubGlobal("fetch", fetcher);
    const { getAgentModels, validateAgentModel }=await import("./models");
    const result=await getAgentModels("qwen3.5-plus");
    expect(result.models.find(model=>model.id==="qwen3.5-plus")).toMatchObject({available:true,compatibility:"catalog",privacy:"unverified",pricing:{promptPerMillionUsd:"0.116667",completionPerMillionUsd:"0.7"}});
    expect(result.models.find(model=>model.id==="glm-5.3")?.privacy).toBe("catalog-tee");
    await expect(validateAgentModel("qwen3.5-plus")).resolves.toBe("qwen3.5-plus");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0][0])).toBe("https://router-api.0g.ai/v1/models");
  });
  it.each([{provider_count:0},{type:"embedding"},{supported_formats:["anthropic"]},{supported_parameters:["tools"]}])("does not offer incompatible/unavailable alternatives %j",async change=>{
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json({data:[{...row(),...change}]})));
    const {validateAgentModel}=await import("./models");
    await expect(validateAgentModel("qwen3.5-plus")).rejects.toMatchObject({code:"MODEL_UNAVAILABLE"});
  });
  it("never follows a supplied model URL or offers arbitrary catalog entries",async()=>{
    const fetcher=vi.fn(async()=>Response.json({data:[row("unreviewed-model")]}));vi.stubGlobal("fetch",fetcher);
    const {validateAgentModel,getAgentModels}=await import("./models");
    await expect(validateAgentModel("unreviewed-model")).rejects.toMatchObject({code:"MODEL_NOT_ALLOWED"});
    await expect(validateAgentModel("https://127.0.0.1/secret")).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect((await getAgentModels()).models.some(model=>model.id==="unreviewed-model")).toBe(false);
  });
  it("expires cached metadata instead of using stale availability",async()=>{
    vi.useFakeTimers();const fetcher=vi.fn().mockResolvedValueOnce(Response.json({data:[row()]})).mockRejectedValueOnce(new Error("offline"));vi.stubGlobal("fetch",fetcher);
    const {getAgentModels}=await import("./models");
    expect((await getAgentModels()).models.find(model=>model.id==="qwen3.5-plus")?.available).toBe(true);
    vi.advanceTimersByTime(30_001);
    expect((await getAgentModels()).models.find(model=>model.id==="qwen3.5-plus")?.available).toBe(false);
  });
  it("uses only documented per-model JSON request options",async()=>{
    const {modelRequestOptions}=await import("./models");
    expect(modelRequestOptions("qwen3.5-plus")).toEqual({response_format:{type:"json_object"}});
    expect(modelRequestOptions("glm-5.3")).toMatchObject({chat_template_kwargs:{enable_thinking:false},response_format:{type:"json_object"}});
    expect(modelRequestOptions("custom-operator-model")).not.toHaveProperty("chat_template_kwargs");
  });
});
