import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke0G } from "./transport";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("0G response evidence", () => {
  it("records billing but refuses a different returned model without retrying",async()=>{
    const fetcher=vi.fn(async()=>Response.json({model:"different-model",choices:[{message:{content:'{"type":"final","message":"Wrong model"}'}}],x_0g_trace:{request_id:"mismatch"}}));vi.stubGlobal("fetch",fetcher);
    const afterCall=vi.fn(async()=>{});
    await expect(invoke0G({url:"https://router-api.0g.ai/v1/chat/completions",apiKey:"fixture-key",model:"qwen3.5-plus",messages:[],callId:"run:model:0",maxTokens:100,timeoutMs:1000,context:{modelBudget:{maxCostUsd:"0.01",beforeCall:async()=>{},afterCall}}})).rejects.toMatchObject({code:"MODEL_RESPONSE_MISMATCH"});
    expect(afterCall).toHaveBeenCalledWith(expect.objectContaining({outcome:"completed",model:"qwen3.5-plus"}));expect(fetcher).toHaveBeenCalledOnce();
  });
  it("records Router request IDs and exact billing separately from provider response IDs", async () => {
    const billing = { currency: "0g", input_cost: "10", output_cost: "20", total_cost: "30", total_cost_usd_micro: "2" };
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ id: "provider-response", choices: [{ message: { content: '{"type":"final","message":"Done"}' } }], usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 }, x_0g_trace: { request_id: "router-request", provider: `0x${"1".repeat(40)}`, billing } }));
    vi.stubGlobal("fetch", fetch);
    const afterCall = vi.fn(async () => {});
    const result = await invoke0G({ url: "https://inference.unit.test/v1/chat/completions", apiKey: "unit-test-credential", model: "0gm-1.0-35b-a3b", messages: [{ role: "user", content: "Explain spot" }], callId: "run:model:0", maxTokens: 100, timeoutMs: 1000, context: { modelBudget: { beforeCall: async () => {}, afterCall } } });
    expect(result.evidence).toMatchObject({ requestId: "router-request", responseId: "provider-response", usage: { total_tokens: 22 }, billing });
    expect(afterCall).toHaveBeenCalledWith(expect.objectContaining({ requestId: "router-request", billing, outcome: "completed" }));
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
  });
  it("preserves bounded Router error identity and its original account binding without retrying", async () => {
    vi.stubEnv("ZEROG_COMPUTE_API_KEY_ID", "configured-public-key-id");
    const fetch = vi.fn(async () => Response.json({ request_id: "error-request", error: { message: "private upstream detail" } }, { status: 502 }));
    vi.stubGlobal("fetch", fetch);
    const afterCall = vi.fn(async () => {});
    await expect(invoke0G({ url: "https://router-api.0g.ai/v1/chat/completions", apiKey: "unit-test-credential", model: "0gm-1.0-35b-a3b", messages: [], callId: "run:model:0", maxTokens: 100, timeoutMs: 1000, context: { modelBudget: { beforeCall: async () => {}, afterCall } } })).rejects.toMatchObject({ code: "INFERENCE_REJECTED", message: "0G returned HTTP 502. The agent did not authorize a trade." });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(afterCall).toHaveBeenCalledWith({ callId: "run:model:0", outcome: "unknown", requestId: "error-request", billing: undefined, billingOrigin: "https://router-api.0g.ai", billingApiKeyId: "configured-public-key-id", model: "0gm-1.0-35b-a3b" });
    expect(JSON.stringify(afterCall.mock.calls)).not.toContain("private upstream detail");
    expect(JSON.stringify(afterCall.mock.calls)).not.toContain("unit-test-credential");
  });
  it("rejects oversized error identities and does not treat custom gateways as official billing origins", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ x_0g_trace: { request_id: "x".repeat(201) } }, { status: 502, headers: { "x-request-id": "bounded-header-id" } })));
    const afterCall = vi.fn(async () => {});
    await expect(invoke0G({ url: "https://custom-gateway.unit.test/v1/chat/completions", apiKey: "unit-test-credential", model: "fixture", messages: [], callId: "call", maxTokens: 100, timeoutMs: 1000, context: { modelBudget: { beforeCall: async () => {}, afterCall } } })).rejects.toMatchObject({ code: "INFERENCE_REJECTED" });
    expect(afterCall).toHaveBeenCalledWith(expect.objectContaining({ requestId: "bounded-header-id", billingOrigin: undefined }));
  });
  it.each(["sk-accidentally-pasted-secret", "mk-accidentally-pasted-secret", "unit-test-credential"])("does not persist a credential mistakenly configured as a public key ID: %s", async keyId => {
    vi.stubEnv("ZEROG_COMPUTE_API_KEY_ID", keyId);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ request_id: "error-request" }, { status: 502 })));
    const afterCall = vi.fn(async () => {});
    await expect(invoke0G({ url: "https://router-api.0g.ai/v1/chat/completions", apiKey: "unit-test-credential", model: "fixture", messages: [], callId: "call", maxTokens: 100, timeoutMs: 1000, context: { modelBudget: { beforeCall: async () => {}, afterCall } } })).rejects.toMatchObject({ code: "INFERENCE_REJECTED" });
    expect(afterCall).toHaveBeenCalledWith(expect.objectContaining({ billingApiKeyId: undefined }));
    expect(JSON.stringify(afterCall.mock.calls)).not.toContain(keyId);
  });
});
