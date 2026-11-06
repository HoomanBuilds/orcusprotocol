import type { AgentRequest } from "@orcus/core";
import { describe, expect, it, vi } from "vitest";
import { AgentRequestSession, type AgentRequestDraft } from "./agent-requests";

const draft: AgentRequestDraft = { message: "Analyze ETH", autonomous: false, accountId: "owned-account" };
function record(id = "saved-request", status: AgentRequest["status"] = "queued"): AgentRequest {
  const now = Date.now();
  return { id, requestId: id, runId: `run:${id}`, userMessageId: `run:${id}:user`, message: draft.message, autonomous: false, status, stage: status === "queued" ? "waiting-for-worker" : status, modelCalls: 0, toolCalls: 0, createdAt: now, updatedAt: now, expiresAt: now + 900_000 };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe("return-to-session agent requests", () => {
  it("discovers completed answers with read-only listing, never a replayed POST", async () => {
    const saved = { ...record("completed", "completed"), response: { id: "answer", role: "assistant" as const, content: "Persisted response", createdAt: Date.now() } };
    const list = vi.fn(async () => ({ requests: [saved] })), create = vi.fn(), refresh = vi.fn(async () => {}), state = vi.fn();
    const session = new AgentRequestSession("owner-a", state, refresh, { list, create });
    await session.load(); await session.load();
    expect(session.state.requests[0].response?.content).toBe("Persisted response");
    expect(refresh).toHaveBeenCalledTimes(1); expect(create).not.toHaveBeenCalled();
  });
  it("records queued acceptance without pretending the model is already running", async () => {
    const create = vi.fn(async (input: AgentRequestDraft & { requestId: string }) => ({ request: record(input.requestId) }));
    const session = new AgentRequestSession("owner-a", vi.fn(), vi.fn(async () => {}), { list: vi.fn(async () => ({ requests: [] })), create });
    expect(await session.submit(draft)).toBe(true);
    expect(session.state.requests[0]).toMatchObject({ status: "queued", stage: "waiting-for-worker", modelCalls: 0 });
    expect(session.pending).toBe(true); expect(session.state.submitting).toBe(false);
  });
  it("blocks rapid duplicate clicks before a React render can disable the button", async () => {
    const gate = deferred<{ request: AgentRequest }>();
    const create = vi.fn((_input: AgentRequestDraft & { requestId: string }) => gate.promise), session = new AgentRequestSession("owner-a", vi.fn(), vi.fn(async () => {}), { list: vi.fn(async () => ({ requests: [] })), create });
    const first = session.submit(draft); expect(await session.submit(draft)).toBe(false);
    const input = create.mock.calls[0][0] as AgentRequestDraft & { requestId: string };
    gate.resolve({ request: record(input.requestId) }); await first;
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("uses the same intake ID on an explicit retry after unconfirmed acceptance", async () => {
    let calls = 0;
    const create = vi.fn(async (input: AgentRequestDraft & { requestId: string }) => { if (++calls === 1) throw new Error("network disconnected"); return { request: record(input.requestId) }; });
    const session = new AgentRequestSession("owner-a", vi.fn(), vi.fn(async () => {}), { list: vi.fn(async () => ({ requests: [] })), create });
    expect(await session.submit(draft)).toBe(false); expect(session.state.error).toBeTruthy();
    expect(await session.submit(draft)).toBe(true);
    expect(create.mock.calls[0][0].requestId).toBe(create.mock.calls[1][0].requestId);
  });
  it("recovers a lost acceptance response by GET instead of automatically posting again", async () => {
    let accepted: AgentRequest | undefined;
    const create = vi.fn(async (input: AgentRequestDraft & { requestId: string }) => { accepted = record(input.requestId); throw new Error("response lost"); });
    const session = new AgentRequestSession("owner-a", vi.fn(), vi.fn(async () => {}), { list: vi.fn(async () => ({ requests: accepted ? [accepted] : [] })), create });
    expect(await session.submit(draft)).toBe(true);
    expect(session.state.requests[0].id).toBe(accepted!.id); expect(create).toHaveBeenCalledTimes(1);
  });
  it("does not reuse a failed instruction's ID for a changed account or execution mode", async () => {
    const create = vi.fn(async (_input: AgentRequestDraft & { requestId: string }): Promise<{ request: AgentRequest }> => { throw new Error("offline"); });
    const session = new AgentRequestSession("owner-a", vi.fn(), vi.fn(async () => {}), { list: vi.fn(async () => ({ requests: [] })), create });
    await session.submit(draft); await session.submit({ ...draft, accountId: "other-account" }); await session.submit({ ...draft, autonomous: true });
    expect(new Set(create.mock.calls.map(([input]) => input.requestId)).size).toBe(3);
  });
  it("binds the visible model to intake and treats changing it as a new instruction", async () => {
    const create = vi.fn(async (_input: AgentRequestDraft & { requestId: string }): Promise<{ request: AgentRequest }> => { throw new Error("offline"); });
    const session = new AgentRequestSession("owner-a", vi.fn(), async () => {}, { list: async () => ({ requests: [] }), create });
    await session.submit({ ...draft, modelId: "configured-model" });
    await session.submit({ ...draft, modelId: "catalog-model" });
    expect(create.mock.calls[0][0].modelId).toBe("configured-model");
    expect(create.mock.calls[1][0].modelId).toBe("catalog-model");
    expect(create.mock.calls[0][0].requestId).not.toBe(create.mock.calls[1][0].requestId);
  });
  it("ignores a late old-owner list response after switching wallets", async () => {
    const gate = deferred<{ requests: AgentRequest[] }>(), state = vi.fn(), refresh = vi.fn(async () => {}), create = vi.fn();
    const old = new AgentRequestSession("owner-a", state, refresh, { list: () => gate.promise, create });
    const pending = old.load(); old.dispose(); state.mockClear();
    const current = new AgentRequestSession("owner-b", state, refresh, { list: async () => ({ requests: [] }), create }); await current.load();
    gate.resolve({ requests: [record("owner-a-secret", "completed")] }); await pending;
    expect(current.state.requests).toEqual([]);
    expect(JSON.stringify(state.mock.calls)).not.toContain("owner-a-secret"); expect(refresh).not.toHaveBeenCalled();
  });
  it("does not mutate or refresh a new owner after late intake acceptance", async () => {
    const gate = deferred<{ request: AgentRequest }>(), state = vi.fn(), refresh = vi.fn(async () => {});
    const create = vi.fn((_input: AgentRequestDraft & { requestId: string }) => gate.promise), session = new AgentRequestSession("owner-a", state, refresh, { list: async () => ({ requests: [] }), create });
    const pending = session.submit(draft), id = create.mock.calls[0][0].requestId;
    session.dispose(); state.mockClear(); gate.resolve({ request: record(id) });
    expect(await pending).toBe(false); expect(state).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
  });
  it("does not clear a new owner's composer when an earlier workspace refresh finishes late", async () => {
    const gate = deferred<void>(), refresh = vi.fn(() => gate.promise);
    const create = vi.fn(async (input: AgentRequestDraft & { requestId: string }) => ({ request: record(input.requestId) }));
    const session = new AgentRequestSession("owner-a", vi.fn(), refresh, { list: async () => ({ requests: [] }), create });
    const pending = session.submit(draft); await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    session.dispose(); gate.resolve(); expect(await pending).toBe(false);
  });
  it("does not let an older GET erase a newly accepted request", async () => {
    const gate = deferred<{ requests: AgentRequest[] }>();
    const session = new AgentRequestSession("owner-a", vi.fn(), async () => {}, { list: () => gate.promise, create: async input => ({ request: record(input.requestId) }) });
    const loading = session.load(); await session.submit(draft); gate.resolve({ requests: [] }); await loading;
    expect(session.state.requests).toHaveLength(1); expect(session.state.requests[0].status).toBe("queued");
  });
  it("keeps known accepted work visible if conversation refresh fails", async () => {
    const create = vi.fn(async (input: AgentRequestDraft & { requestId: string }) => ({ request: record(input.requestId) }));
    const session = new AgentRequestSession("owner-a", vi.fn(), async () => { throw new Error("refresh failed"); }, { list: async () => ({ requests: [] }), create });
    expect(await session.submit(draft)).toBe(true);
    expect(session.state.requests).toHaveLength(1); expect(session.state.error).toMatch(/request was saved/i); expect(create).toHaveBeenCalledOnce();
  });
  it("rejects an intake response with a different request identity", async () => {
    const session = new AgentRequestSession("owner-a", vi.fn(), async () => {}, { list: async () => ({ requests: [] }), create: async () => ({ request: record("not-the-submitted-id") }) });
    expect(await session.submit(draft)).toBe(false); expect(session.state.requests).toEqual([]); expect(session.state.error).toBeTruthy();
  });
});
