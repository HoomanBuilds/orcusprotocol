import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke0G } from "./transport";

afterEach(() => { vi.unstubAllGlobals(); });

describe("0G response evidence", () => {
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
});
